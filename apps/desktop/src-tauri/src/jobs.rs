//! Generation lifecycle (architecture §5): estimate, submit, poll, cancel.

use crate::budget::{check_budget, start_of_local_month};
use crate::core::Core;
use crate::db::{self, JOB_COLS};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::manifest::{self, Model};
use crate::providers::{JobRef, RemoteStatus, Submitted};
use crate::types::*;
use rusqlite::params;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub struct Prepared {
    pub model: Model,
    pub prompt: String,
    pub negative: Option<String>,
    pub values: ParamValues,
    pub body: Value,
}

pub fn prepare(core: &Core, input: &GenerationInput) -> AppResult<Prepared> {
    let model = core.model(&input.model_id)?;
    let manifest::ValidGeneration {
        prompt,
        negative,
        values,
    } = manifest::validate_generation(
        &model.def,
        &input.prompt,
        input.negative_prompt.as_deref(),
        &input.params,
    )?;
    let body = manifest::build_body(
        &model.def,
        &prompt,
        negative.as_deref(),
        &values,
        model.def.provider == ProviderId::Kling,
    );
    Ok(Prepared {
        model,
        prompt,
        negative,
        values,
        body,
    })
}

/// Jobs created since the start of the current month (budget windows).
fn recent_jobs(core: &Core) -> AppResult<Vec<GenerationJob>> {
    let since = start_of_local_month(now_ms()).min(crate::budget::start_of_local_day(now_ms()));
    list_jobs(core, Some(since), None)
}

/// Price information for one prepared generation (before budgets).
#[derive(Debug, Clone, PartialEq)]
pub struct PriceInfo {
    pub status: &'static str,
    pub amount: Option<f64>,
    pub currency: Option<String>,
    pub unit_name: Option<String>,
    pub credits: Option<f64>,
    pub source: Option<&'static str>,
    pub lower_bound: bool,
    pub reason: Option<String>,
    pub verified_at: Option<String>,
    pub pricing_page_url: Option<String>,
}

impl PriceInfo {
    /// Amount when the currency is USD (budgets use USD only).
    pub fn usd(&self) -> Option<f64> {
        if self.currency.as_deref() == Some("USD") {
            self.amount
        } else {
            None
        }
    }
    fn unavailable(reason: &str, url: Option<String>) -> Self {
        PriceInfo {
            status: "unavailable",
            amount: None,
            currency: None,
            unit_name: None,
            credits: None,
            source: None,
            lower_bound: false,
            reason: Some(reason.to_string()),
            verified_at: None,
            pricing_page_url: url,
        }
    }
}

/// Estimate order: the provider's estimate API (pricing status
/// `provider_estimate`, credentials present) → published rate (pricing.rs)
/// → unavailable with a reason. Never invents a number.
pub async fn estimate_prepared(core: &Core, p: &Prepared) -> PriceInfo {
    let def = &p.model.def;
    let pricing = &def.pricing;
    let page = pricing.pricing_page_url.clone();
    if pricing.status == crate::pricing::PricingStatus::ProviderEstimate {
        let provider = core.providers.get(def.provider);
        let creds = core.creds(def.provider).unwrap_or_default();
        let complete = !creds.is_empty()
            && provider
                .credential_fields()
                .iter()
                .all(|f| creds.contains_key(&f.key));
        if provider.capabilities().estimate_cost && complete {
            return match provider
                .estimate(&creds, &p.model, &p.values, &p.body)
                .await
            {
                Ok(Some(e)) if e.usd.is_some() || e.credits.is_some() => {
                    let (amount, currency, unit) = match e.usd {
                        Some(usd) => (usd, "USD".to_string(), None),
                        None => (
                            e.credits.unwrap_or_default(),
                            "credits".to_string(),
                            Some(
                                pricing
                                    .unit_name
                                    .clone()
                                    .unwrap_or_else(|| "credits".into()),
                            ),
                        ),
                    };
                    PriceInfo {
                        status: "estimated",
                        amount: Some(amount),
                        currency: Some(currency),
                        unit_name: unit,
                        credits: e.credits,
                        source: Some("provider"),
                        lower_bound: false,
                        reason: None,
                        verified_at: None,
                        pricing_page_url: page,
                    }
                }
                Ok(_) => PriceInfo::unavailable("provider_error", page),
                Err(e) => {
                    log::warn!("estimate failed for {}: {}", def.id, e.code);
                    PriceInfo::unavailable("provider_error", page)
                }
            };
        }
    }
    match crate::pricing::estimate_price(
        def,
        &p.values,
        now_ms(),
        Some(&p.prompt),
        p.negative.as_deref(),
    ) {
        crate::pricing::PriceEstimate::Estimated {
            amount,
            currency,
            unit_name,
            lower_bound,
            verified_at,
            ..
        } => PriceInfo {
            status: "estimated",
            amount: Some(amount),
            credits: (currency == "credits").then_some(amount),
            currency: Some(currency),
            unit_name,
            source: Some("published_rate"),
            lower_bound,
            reason: None,
            verified_at,
            pricing_page_url: page,
        },
        crate::pricing::PriceEstimate::Unavailable {
            reason,
            pricing_page_url,
        } => PriceInfo::unavailable(reason, pricing_page_url),
    }
}

pub async fn estimate(core: &Core, input: &GenerationInput) -> AppResult<EstimateResult> {
    let p = prepare(core, input)?;
    let info = estimate_prepared(core, &p).await;
    let settings = crate::settings::get(core);
    let check = check_budget(&recent_jobs(core)?, info.usd(), &settings.budget, now_ms());
    Ok(EstimateResult {
        status: info.status.into(),
        amount: info.amount,
        currency: info.currency.clone(),
        unit_name: info.unit_name.clone(),
        usd: info.usd(),
        credits: info.credits,
        source: info.source.map(String::from),
        lower_bound: info.lower_bound,
        reason: info.reason.clone(),
        verified_at: info.verified_at.clone(),
        pricing_page_url: info.pricing_page_url.clone(),
        budget: check.to_estimate_budget(),
    })
}

fn validate_idempotency_key(k: &str) -> AppResult<()> {
    if k.is_empty() || k.len() > 255 || !k.chars().all(|c| c.is_ascii_graphic()) {
        return Err(AppError::invalid("Invalid idempotency key."));
    }
    Ok(())
}

fn job_by_key(core: &Core, key: &str) -> AppResult<Option<GenerationJob>> {
    let c = core.db.conn();
    Ok(rusqlite::OptionalExtension::optional(c.query_row(
        &format!("SELECT {JOB_COLS} FROM generation_jobs WHERE idempotency_key = ?1"),
        [key],
        |r| db::job_from_row(r, 0),
    ))?)
}

fn exists(core: &Core, table: &str, id: &str) -> AppResult<bool> {
    let c = core.db.conn();
    let n: i64 = c.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE id = ?1"),
        [id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub async fn submit(
    core: &Arc<Core>,
    input: GenerationInput,
    options: SubmitOptions,
) -> AppResult<GenerationJob> {
    validate_idempotency_key(&options.idempotency_key)?;
    if let Some(id) = &options.prompt_id {
        validate_id(id)?;
    }
    if let Some(id) = &options.project_id {
        validate_id(id)?;
    }
    if let Some(existing) = job_by_key(core, &options.idempotency_key)? {
        return Ok(existing); // duplicate click / renderer retry
    }
    // 1. validate
    let p = prepare(core, &input)?;
    crate::reference_library::check_generation_references(
        &input.references,
        &p.model.def,
        &p.values,
    )?;
    let provider_id = p.model.def.provider;
    if !core.provider_enabled(provider_id)? {
        return Err(AppError::new(
            ErrorCode::ProviderDisabled,
            format!("{} is disabled in Settings.", provider_id.display_name()),
        ));
    }
    let creds = core.creds(provider_id)?;
    let provider = core.providers.get(provider_id);
    for f in provider.credential_fields() {
        if !creds.contains_key(&f.key) {
            return Err(AppError::new(
                ErrorCode::MissingCredentials,
                "Add your API credentials in Settings first.",
            ));
        }
    }
    let prompt_id = match &options.prompt_id {
        Some(id) if exists(core, "prompts", id)? => Some(id.clone()),
        _ => None,
    };
    let project_id = match &options.project_id {
        Some(id) if exists(core, "projects", id)? => Some(id.clone()),
        Some(_) => return Err(AppError::not_found("Project not found.")),
        None => None,
    };
    // 2. re-estimate
    let info = estimate_prepared(core, &p).await;
    let usd = info.usd();
    let source = info.source.map(String::from);
    // 3. budget
    let settings = crate::settings::get(core);
    let check = check_budget(&recent_jobs(core)?, usd, &settings.budget, now_ms());
    if !check.allowed {
        return Err(AppError::new(
            ErrorCode::BudgetExceeded,
            "This generation would exceed your budget limit.",
        )
        .with_details(
            json!({"reason": "budget", "exceeded": check.exceeded, "estimateUsd": usd}),
        ));
    }
    // 4. unknown money figure (unavailable, or provider credits): explicit
    //    acknowledgement required, independent of confirmBeforeGenerate.
    if usd.is_none() && !options.acknowledge_unknown_cost {
        let reason = if info.status == "estimated" {
            "credits".to_string()
        } else {
            info.reason.clone().unwrap_or_else(|| "no_price".into())
        };
        return Err(AppError::new(
            ErrorCode::UnknownCostAckRequired,
            "The cost of this generation is unknown. Confirm that you accept a possible charge.",
        )
        .with_details(
            json!({"reason": reason, "amount": info.amount, "currency": info.currency}),
        ));
    }
    // 5. confirmation of a USD estimate
    if settings.budget.confirm_before_generate {
        if let Some(est) = usd {
            let ok = options
                .confirmed_estimate_usd
                .is_some_and(|c| c.is_finite() && c + 1e-9 >= est);
            if !ok {
                return Err(AppError::new(
                    ErrorCode::ConfirmationRequired,
                    "Please confirm the estimated cost.",
                )
                .with_details(json!({"reason": "confirm_estimate", "estimateUsd": est})));
            }
        }
    }
    // Inline references (Kling) become base64 only now, after all checks.
    let body = crate::references::resolve_inline(core, provider_id, &p.body)?;
    // 5. insert as submitting
    let now = now_ms();
    let job = GenerationJob {
        id: new_id(),
        provider: provider_id,
        model_id: p.model.def.id.clone(),
        model_name: p.model.def.display_name.clone(),
        workflow: p.model.def.workflow.clone(),
        output: p.model.def.output.clone(),
        provider_request_id: None,
        status: JobStatus::Submitting,
        prompt: p.prompt.clone(),
        negative_prompt: p.negative.clone(),
        params: p.values.clone(),
        requested_duration_sec: manifest::requested_duration(&p.model.def, &p.values),
        estimated_cost_usd: usd,
        estimate_source: source,
        confirmed_cost_usd: None,
        error_code: None,
        error_message: None,
        prompt_id,
        project_id,
        references: input.references.clone(),
        preserve_identity: input.preserve_identity,
        created_at: now,
        updated_at: now,
        completed_at: None,
    };
    insert_job(core, &job, &options.idempotency_key)?;
    core.emit(StoreEvent::JobsChanged);

    let result = submit_with_policy(core, &p.model, &body, &options.idempotency_key).await;
    match result {
        Ok(sub) => {
            mark_submitted(core, &job.id, &sub)?;
            core.jobs_notify.notify_one();
        }
        Err(err) => {
            let blocked = err
                .details
                .as_ref()
                .and_then(|d| d.get("blocked"))
                .and_then(Value::as_bool)
                == Some(true);
            let status = if blocked {
                JobStatus::Blocked
            } else {
                JobStatus::Failed
            };
            set_failed(core, &job.id, status, err.code.as_str(), &err.message)?;
            core.emit(StoreEvent::JobsChanged);
            return Err(err);
        }
    }
    core.emit(StoreEvent::JobsChanged);
    db::get_job(&core.db.conn(), &job.id)?.ok_or_else(|| AppError::not_found("Job not found."))
}

fn uncertain() -> AppError {
    AppError::new(
        ErrorCode::SubmitUncertain,
        "The connection failed while submitting, so it is unknown whether the provider accepted the request. \
         Check your provider dashboard before retrying to avoid paying twice.",
    )
}

/// Submit with the idempotency rules from architecture §4/§5.
async fn submit_with_policy(
    core: &Core,
    model: &Model,
    body: &Value,
    key: &str,
) -> AppResult<Submitted> {
    let provider = core.providers.get(model.def.provider);
    let creds = core.creds(model.def.provider)?;
    let first = provider.submit(&creds, model, body, key).await;
    let failure = match first {
        Ok(s) => return Ok(s),
        Err(f) => f,
    };
    if !failure.ambiguous {
        return Err(failure.error);
    }
    match model.def.provider {
        ProviderId::Higgsfield => {
            // Same Idempotency-Key: a replay returns the original request.
            tokio::time::sleep(Duration::from_millis(retry_delay_ms())).await;
            provider
                .submit(&creds, model, body, key)
                .await
                .map_err(|f| if f.ambiguous { uncertain() } else { f.error })
        }
        ProviderId::Kling => {
            tokio::time::sleep(Duration::from_millis(retry_delay_ms())).await;
            match provider.find_by_idempotency_key(&creds, model, key).await {
                Ok(Some(found)) => Ok(found),
                Ok(None) if !model.path().starts_with("v1/") => provider
                    .submit(&creds, model, body, key)
                    .await
                    .map_err(|f| if f.ambiguous { uncertain() } else { f.error }),
                _ => Err(uncertain()),
            }
        }
        // Replicate: no idempotency → never auto-retry.
        _ => Err(uncertain()),
    }
}

fn retry_delay_ms() -> u64 {
    if cfg!(test) {
        10
    } else {
        1500
    }
}

pub fn insert_job(core: &Core, j: &GenerationJob, key: &str) -> AppResult<()> {
    insert_job_tx(&core.db.conn(), j, key)
}

pub fn insert_job_tx(conn: &rusqlite::Connection, j: &GenerationJob, key: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO generation_jobs (id, provider, model_id, model_name, workflow, output, provider_request_id, status,
          prompt, negative_prompt, params_json, requested_duration_sec, estimated_cost_usd, estimate_source,
          confirmed_cost_usd, error_code, error_message, prompt_id, project_id, idempotency_key, created_at, updated_at, completed_at,
          references_json, preserve_identity)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)",
        params![
            j.id, j.provider.as_str(), j.model_id, j.model_name, j.workflow, j.output, j.provider_request_id,
            j.status.as_str(), j.prompt, j.negative_prompt, serde_json::to_string(&j.params)?,
            j.requested_duration_sec, j.estimated_cost_usd, j.estimate_source, j.confirmed_cost_usd,
            j.error_code, j.error_message, j.prompt_id, j.project_id, key, j.created_at, j.updated_at, j.completed_at,
            serde_json::to_string(&j.references)?, i64::from(j.preserve_identity)
        ],
    )?;
    Ok(())
}

fn mark_submitted(core: &Core, id: &str, s: &Submitted) -> AppResult<()> {
    core.db.conn().execute(
        "UPDATE generation_jobs SET provider_request_id=?2, poll_url=?3, result_url=?4, cancel_url=?5,
           status='queued', updated_at=?6 WHERE id=?1",
        params![id, s.request_id, s.poll_url, s.result_url, s.cancel_url, now_ms()],
    )?;
    Ok(())
}

fn set_failed(core: &Core, id: &str, status: JobStatus, code: &str, msg: &str) -> AppResult<()> {
    let now = now_ms();
    core.db.conn().execute(
        "UPDATE generation_jobs SET status=?2, error_code=?3, error_message=?4, updated_at=?5, completed_at=?5 WHERE id=?1",
        params![id, status.as_str(), code, msg, now],
    )?;
    Ok(())
}

fn set_status(core: &Core, id: &str, status: JobStatus) -> AppResult<bool> {
    let n = core.db.conn().execute(
        "UPDATE generation_jobs SET status=?2, updated_at=?3 WHERE id=?1 AND status != ?2",
        params![id, status.as_str(), now_ms()],
    )?;
    Ok(n > 0)
}

pub fn list_jobs(core: &Core, from: Option<i64>, to: Option<i64>) -> AppResult<Vec<GenerationJob>> {
    let c = core.db.conn();
    let mut st = c.prepare(&format!(
        "SELECT {JOB_COLS} FROM generation_jobs WHERE created_at >= ?1 AND created_at <= ?2 ORDER BY created_at DESC"
    ))?;
    let rows = st.query_map(
        params![from.unwrap_or(i64::MIN), to.unwrap_or(i64::MAX)],
        |r| db::job_from_row(r, 0),
    )?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get_job(core: &Core, id: &str) -> AppResult<Option<GenerationJob>> {
    validate_id(id)?;
    db::get_job(&core.db.conn(), id)
}

/// Deletes a finished job and its assets (files under the root, then rows).
/// Prompts are never deleted. Active jobs cannot be deleted (and are never canceled by deletion).
pub fn delete_job(core: &Core, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let job =
        db::get_job(&core.db.conn(), id)?.ok_or_else(|| AppError::not_found("Job not found."))?;
    if !job.status.is_terminal() {
        return Err(AppError::invalid(
            "This job is still running. Wait for it to finish before deleting it.",
        ));
    }
    let item_ids: Vec<String> = {
        let c = core.db.conn();
        let mut st = c.prepare("SELECT i.id FROM archive_items i JOIN media_assets a ON a.id=i.asset_id WHERE a.job_id=?1")?;
        let rows = st.query_map([id], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    crate::archive::delete_permanently(core, &item_ids)?;
    core.db
        .conn()
        .execute("DELETE FROM generation_jobs WHERE id=?1", [id])?;
    core.emit(StoreEvent::JobsChanged);
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

pub async fn cancel(core: &Core, job_id: &str) -> AppResult<()> {
    validate_id(job_id)?;
    let (job, jr) = job_ref(core, job_id)?.ok_or_else(|| AppError::not_found("Job not found."))?;
    if job.status.is_terminal() {
        return Err(AppError::new(
            ErrorCode::CancelTooLate,
            "This job has already finished.",
        ));
    }
    let provider = core.providers.get(job.provider);
    if !provider.capabilities().cancel {
        return Err(AppError::new(
            ErrorCode::CancelUnsupported,
            format!(
                "{} does not support canceling.",
                job.provider.display_name()
            ),
        ));
    }
    if jr.request_id.is_empty() {
        return Err(AppError::new(
            ErrorCode::CancelTooLate,
            "The job is still being submitted.",
        ));
    }
    let creds = core.creds(job.provider)?;
    match provider.cancel(&creds, &jr).await {
        Ok(()) => {
            set_failed(core, job_id, JobStatus::Canceled, "canceled", "Canceled by you.")?;
            core.emit(StoreEvent::JobsChanged);
            core.emit(StoreEvent::ArchiveChanged);
            Ok(())
        }
        Err(e) if e.code == ErrorCode::InvalidInput || e.code == ErrorCode::NotFound => {
            Err(AppError::new(ErrorCode::CancelTooLate, "The provider rejected the cancellation; the job may already be running or finished."))
        }
        Err(e) => Err(e),
    }
}

fn job_ref(core: &Core, id: &str) -> AppResult<Option<(GenerationJob, JobRef)>> {
    let c = core.db.conn();
    let row = rusqlite::OptionalExtension::optional(c.query_row(
        &format!("SELECT {JOB_COLS}, poll_url, result_url, cancel_url, idempotency_key FROM generation_jobs WHERE id=?1"),
        [id],
        |r| {
            let job = db::job_from_row(r, 0)?;
            let n = db::JOB_NCOLS;
            Ok((job, r.get::<_, Option<String>>(n)?, r.get::<_, Option<String>>(n + 1)?, r.get::<_, Option<String>>(n + 2)?, r.get::<_, String>(n + 3)?))
        },
    ))?;
    drop(c);
    Ok(row.map(|(job, poll, result, cancel, key)| {
        let model_path = core
            .model_for_job(&job.model_id)
            .map(|m| m.path().to_string())
            .unwrap_or_default();
        let jr = JobRef {
            request_id: job.provider_request_id.clone().unwrap_or_default(),
            poll_url: poll,
            result_url: result,
            cancel_url: cancel,
            model_path,
            idempotency_key: key,
        };
        (job, jr)
    }))
}

/* ── Poller ────────────────────────────────────────────────────────────── */

fn active_job_ids(core: &Core) -> AppResult<Vec<String>> {
    let c = core.db.conn();
    let mut st = c.prepare(
        "SELECT id FROM generation_jobs WHERE status IN ('queued','generating') AND provider_request_id IS NOT NULL AND provider IN ('higgsfield','replicate','kling') ORDER BY created_at",
    )?;
    let rows = st.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Startup recovery for jobs interrupted while `submitting`.
pub async fn recover_submitting(core: &Core) -> AppResult<()> {
    let ids: Vec<String> = {
        let c = core.db.conn();
        let mut st = c.prepare("SELECT id FROM generation_jobs WHERE status='submitting'")?;
        let rows = st.query_map([], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for id in ids {
        let Some((job, jr)) = job_ref(core, &id)? else {
            continue;
        };
        let Some(model) = core.model_for_job(&job.model_id) else {
            set_failed(
                core,
                &id,
                JobStatus::Failed,
                "submit_uncertain",
                &uncertain().message,
            )?;
            continue;
        };
        let creds = core.creds(job.provider)?;
        let provider = core.providers.get(job.provider);
        let found = match job.provider {
            ProviderId::Higgsfield => {
                // Replaying the same request with the same key is safe.
                let p = prepare(
                    core,
                    &GenerationInput {
                        model_id: job.model_id.clone(),
                        prompt: job.prompt.clone(),
                        negative_prompt: job.negative_prompt.clone(),
                        params: job.params.clone(),
                        references: job.references.clone(),
                        preserve_identity: job.preserve_identity,
                    },
                );
                match p {
                    Ok(p) => provider
                        .submit(&creds, &model, &p.body, &jr.idempotency_key)
                        .await
                        .ok(),
                    Err(_) => None,
                }
            }
            ProviderId::Kling => provider
                .find_by_idempotency_key(&creds, &model, &jr.idempotency_key)
                .await
                .ok()
                .flatten(),
            _ => None,
        };
        match found {
            Some(s) => mark_submitted(core, &id, &s)?,
            None => set_failed(
                core,
                &id,
                JobStatus::Failed,
                "submit_uncertain",
                &uncertain().message,
            )?,
        }
    }
    core.emit(StoreEvent::JobsChanged);
    Ok(())
}

/// Polls all active jobs once. Returns how many changed.
pub async fn poll_once(core: &Core) -> AppResult<usize> {
    let mut changed = 0;
    for id in active_job_ids(core)? {
        let Some((job, jr)) = job_ref(core, &id)? else {
            continue;
        };
        let creds = match core.creds(job.provider) {
            Ok(c) if !c.is_empty() => c,
            _ => continue,
        };
        let provider = core.providers.get(job.provider);
        let status = match provider.status(&creds, &jr).await {
            Ok(s) => s,
            Err(e) if e.code == ErrorCode::NotFound => {
                set_failed(
                    core,
                    &id,
                    JobStatus::Failed,
                    "not_found",
                    "The provider no longer knows this request.",
                )?;
                changed += 1;
                continue;
            }
            Err(e) => {
                log::warn!("poll {} failed: {}", id, e.code);
                continue;
            }
        };
        let did = match status {
            RemoteStatus::Queued => set_status(core, &id, JobStatus::Queued)?,
            RemoteStatus::Running => set_status(core, &id, JobStatus::Generating)?,
            RemoteStatus::Failed { code, message } => {
                set_failed(core, &id, JobStatus::Failed, &code, &message)?;
                true
            }
            RemoteStatus::Blocked { message } => {
                set_failed(core, &id, JobStatus::Blocked, "blocked", &message)?;
                true
            }
            RemoteStatus::Canceled => {
                set_failed(core, &id, JobStatus::Canceled, "canceled", "Canceled.")?;
                true
            }
            RemoteStatus::Completed {
                result,
                confirmed_usd,
            } => {
                let urls = match core.model_for_job(&job.model_id) {
                    Some(m) => provider.outputs(&m, &result),
                    None => vec![],
                };
                complete(core, &job, urls, confirmed_usd)?;
                true
            }
        };
        if did {
            changed += 1;
        }
    }
    if changed > 0 {
        core.emit(StoreEvent::JobsChanged);
        core.emit(StoreEvent::ArchiveChanged);
    }
    Ok(changed)
}

fn guess_ext(url: &str, kind: &str) -> &'static str {
    let path = url::Url::parse(url)
        .map(|u| u.path().to_ascii_lowercase())
        .unwrap_or_default();
    for (e, k) in [
        ("mp4", "video"),
        ("mov", "video"),
        ("webm", "video"),
        ("png", "image"),
        ("jpg", "image"),
        ("jpeg", "image"),
        ("webp", "image"),
    ] {
        if path.ends_with(&format!(".{e}")) && k == kind {
            return e;
        }
    }
    if kind == "video" {
        "mp4"
    } else {
        "png"
    }
}

/// Completion: assets + archive items + download tasks in one transaction.
pub fn complete(
    core: &Core,
    job: &GenerationJob,
    urls: Vec<String>,
    confirmed_usd: Option<f64>,
) -> AppResult<()> {
    if urls.is_empty() {
        return set_failed(
            core,
            &job.id,
            JobStatus::Failed,
            "no_output",
            "The provider reported success but returned no output.",
        );
    }
    let auto_save = crate::settings::get(core).auto_save || job.provider == ProviderId::Replicate;
    let now = now_ms();
    let mut conn = core.db.conn();
    let tx = conn.transaction()?;
    let updated = tx.execute(
        "UPDATE generation_jobs SET status='completed', confirmed_cost_usd=COALESCE(?2, confirmed_cost_usd),
           error_code=NULL, error_message=NULL, updated_at=?3, completed_at=?3 WHERE id=?1 AND status != 'completed'",
        params![job.id, confirmed_usd, now],
    )?;
    if updated == 0 {
        return Ok(());
    }
    for (i, url) in urls.iter().take(50).enumerate() {
        let asset_id = new_id();
        let ext = guess_ext(url, &job.output);
        let filename = format!("vidra-{}-{}.{}", &job.id[..8], i + 1, ext);
        tx.execute(
            "INSERT OR IGNORE INTO media_assets (id, job_id, output_index, kind, original_url, filename, download_status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
            params![asset_id, job.id, i as i64, job.output, url, filename, now],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO archive_items (id, asset_id, project_id, tags_json) VALUES (?1, ?2, ?3, '[]')",
            params![new_id(), asset_id, job.project_id],
        )?;
        if auto_save {
            tx.execute(
                "INSERT OR IGNORE INTO download_tasks (id, asset_id, status, updated_at) VALUES (?1, ?2, 'pending', ?3)",
                params![new_id(), asset_id, now],
            )?;
        }
    }
    tx.commit()?;
    drop(conn);
    core.downloads.notify();
    Ok(())
}

/// Background poller: every 4 s, backing off to 15 s while nothing changes.
pub fn spawn_poller(core: Arc<Core>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = recover_submitting(&core).await {
            log::error!("job recovery failed: {}", e.code);
        }
        let mut interval = 4.0f64;
        loop {
            let changed = poll_once(&core).await.unwrap_or(0);
            interval = if changed > 0 {
                4.0
            } else {
                (interval * 1.5).min(15.0)
            };
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs_f64(interval)) => {}
                _ = core.jobs_notify.notified() => { interval = 4.0; }
            }
        }
    });
}
