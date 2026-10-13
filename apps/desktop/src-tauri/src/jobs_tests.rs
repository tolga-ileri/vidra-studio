//! Integration-style tests for the generation lifecycle against mock servers.

use crate::core::testing::*;
use crate::error::ErrorCode;
use crate::manifest::Registry;
use crate::net::Net;
use crate::providers::test_support::model;
use crate::providers::{
    higgsfield::Higgsfield, kling::Kling, replicate::Replicate, Provider, Providers,
};
use crate::secrets::SecretStore;
use crate::types::*;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn providers(base: &str) -> Providers {
    let net = Net::for_tests();
    let mut m: HashMap<ProviderId, Arc<dyn Provider>> = HashMap::new();
    m.insert(
        ProviderId::Higgsfield,
        Arc::new(Higgsfield::with_base(net.clone(), base)),
    );
    m.insert(
        ProviderId::Replicate,
        Arc::new(Replicate::with_base(net.clone(), base)),
    );
    m.insert(ProviderId::Kling, Arc::new(Kling::with_base(net, base)));
    Providers::from_map(m)
}

fn registry() -> Registry {
    Registry::from_models(vec![
        model("higgsfield", "hf/t2v", None, "video.url"),
        model("replicate", "owner/t2v", None, "output"),
        model(
            "kling",
            "text-to-video/kling-3.0",
            Some("text-to-video/kling-3.0"),
            "outputs[].url",
        ),
    ])
}

fn setup(server: &MockServer) -> TestEnv {
    let e = env_with(Some(providers(&server.uri())), registry(), None);
    for (k, v) in [
        ("higgsfield:key_id", "kid"),
        ("higgsfield:key_secret", "TOPSECRET-HF"),
        ("replicate:api_token", "TOPSECRET-R8"),
        ("kling:api_key", "TOPSECRET-KL"),
    ] {
        e.secrets.set(k, v).unwrap();
    }
    e
}

fn input(model_id: &str) -> GenerationInput {
    GenerationInput {
        model_id: model_id.into(),
        prompt: "a red fox".into(),
        negative_prompt: None,
        params: Default::default(),
        references: Vec::new(),
        preserve_identity: false,
    }
}

fn opts(key: &str, confirmed: Option<f64>) -> SubmitOptions {
    SubmitOptions {
        idempotency_key: key.into(),
        confirmed_estimate_usd: confirmed,
        acknowledge_unknown_cost: false,
        prompt_id: None,
        project_id: None,
    }
}

fn opts_ack(key: &str) -> SubmitOptions {
    SubmitOptions {
        acknowledge_unknown_cost: true,
        ..opts(key, None)
    }
}

fn job_row(e: &TestEnv, key: &str) -> GenerationJob {
    let c = e.core.db.conn();
    c.query_row(
        &format!(
            "SELECT {} FROM generation_jobs WHERE idempotency_key=?1",
            crate::db::JOB_COLS
        ),
        [key],
        |r| crate::db::job_from_row(r, 0),
    )
    .unwrap()
}

#[tokio::test]
async fn confirmation_and_budget_rules() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/estimate/hf/t2v"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"usd": "0.5", "credits": "8"})),
        )
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/hf/t2v"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"request_id": "r1", "status": "queued"})),
        )
        .mount(&s)
        .await;
    let e = setup(&s);
    let est = crate::jobs::estimate(&e.core, &input("higgsfield:hf/t2v"))
        .await
        .unwrap();
    assert_eq!(est.usd, Some(0.5));
    assert_eq!(est.source.as_deref(), Some("provider"));
    let err = crate::jobs::submit(&e.core, input("higgsfield:hf/t2v"), opts("k1", None))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ConfirmationRequired);
    assert_eq!(err.details.unwrap()["estimateUsd"], json!(0.5));
    let err = crate::jobs::submit(&e.core, input("higgsfield:hf/t2v"), opts("k1", Some(0.4)))
        .await
        .unwrap_err();
    assert_eq!(
        err.code,
        ErrorCode::ConfirmationRequired,
        "lower confirmed estimate"
    );
    let job = crate::jobs::submit(&e.core, input("higgsfield:hf/t2v"), opts("k1", Some(0.5)))
        .await
        .unwrap();
    assert_eq!(job.status, JobStatus::Queued);
    assert_eq!(job.provider_request_id.as_deref(), Some("r1"));
    assert_eq!(job.estimated_cost_usd, Some(0.5));
    // same idempotency key → same job, no second submit
    let again = crate::jobs::submit(&e.core, input("higgsfield:hf/t2v"), opts("k1", Some(0.5)))
        .await
        .unwrap();
    assert_eq!(again.id, job.id);

    // budget: daily limit 1.0, already 0.5 counted; failed/canceled jobs are not counted
    crate::settings::update(
        &e.core,
        serde_json::from_value(json!({"budget": {"dailyLimitUsd": 0.9}})).unwrap(),
    )
    .unwrap();
    let mut failed = crate::budget::tests_support_job();
    failed.status = JobStatus::Failed;
    failed.estimated_cost_usd = Some(100.0);
    failed.created_at = now_ms();
    crate::jobs::insert_job(&e.core, &failed, "kf").unwrap();
    let est = crate::jobs::estimate(&e.core, &input("higgsfield:hf/t2v"))
        .await
        .unwrap();
    assert!(!est.budget.allowed);
    assert_eq!(est.budget.daily_spent_usd, 0.5);
    let err = crate::jobs::submit(&e.core, input("higgsfield:hf/t2v"), opts("k2", Some(0.5)))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::BudgetExceeded);
    crate::settings::update(
        &e.core,
        serde_json::from_value(json!({"budget": {"dailyLimitUsd": 1.1, "warnAtPercent": 80}}))
            .unwrap(),
    )
    .unwrap();
    let est = crate::jobs::estimate(&e.core, &input("higgsfield:hf/t2v"))
        .await
        .unwrap();
    assert!(est.budget.allowed);
    assert_eq!(est.budget.warnings, vec!["daily"]);
}

#[tokio::test]
async fn higgsfield_retries_once_with_same_key() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/estimate/hf/t2v"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/hf/t2v"))
        .respond_with(ResponseTemplate::new(502))
        .up_to_n_times(1)
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/hf/t2v"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"request_id": "r9"})))
        .mount(&s)
        .await;
    let e = setup(&s);
    // estimate API failed → unavailable; without acknowledgement no submit
    let err = crate::jobs::submit(
        &e.core,
        input("higgsfield:hf/t2v"),
        opts("idem-0", Some(0.5)),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::UnknownCostAckRequired);
    assert_eq!(err.details.unwrap()["reason"], "provider_error");
    let job = crate::jobs::submit(&e.core, input("higgsfield:hf/t2v"), opts_ack("idem-x"))
        .await
        .unwrap();
    assert_eq!(job.provider_request_id.as_deref(), Some("r9"));
    let posts: Vec<_> = s
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path() == "/hf/t2v")
        .collect();
    assert_eq!(posts.len(), 2);
    assert!(posts
        .iter()
        .all(|r| r.headers.get("idempotency-key").unwrap() == "idem-x"));
}

#[tokio::test]
async fn non_idempotent_providers_never_retry() {
    for (model_id, p) in [("replicate:owner/t2v", "/models/owner/t2v/predictions")] {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(p))
            .respond_with(ResponseTemplate::new(503))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&s)
            .await;
        let e = setup(&s);
        let err = crate::jobs::submit(&e.core, input(model_id), opts("u1", Some(0.5)))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::SubmitUncertain, "{model_id}");
        let posts = s
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.method.as_str() == "POST")
            .count();
        assert_eq!(posts, 1, "{model_id}");
        let j = job_row(&e, "u1");
        assert_eq!(j.status, JobStatus::Failed);
        assert_eq!(j.error_code.as_deref(), Some("submit_uncertain"));
    }
}

#[tokio::test]
async fn kling_looks_up_external_id_before_resubmitting() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/text-to-video/kling-3.0"))
        .respond_with(ResponseTemplate::new(504))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/tasks"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"code": 0, "data": [{"id": "kt1", "status": "submitted"}]})),
        )
        .mount(&s)
        .await;
    let e = setup(&s);
    let job = crate::jobs::submit(
        &e.core,
        input("kling:text-to-video/kling-3.0"),
        opts("ext-9", Some(1.0)),
    )
    .await
    .unwrap();
    assert_eq!(job.provider_request_id.as_deref(), Some("kt1"));
    let posts = s
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(posts, 1);
}

#[tokio::test]
async fn definite_failures_and_blocked() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/models/owner/t2v/predictions"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({"detail": "bad key"})))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&s)
        .await;
    let e = setup(&s);
    let err = crate::jobs::submit(&e.core, input("replicate:owner/t2v"), opts("d1", Some(1.0)))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidCredentials);
    assert_eq!(job_row(&e, "d1").status, JobStatus::Failed);
    // disabled provider / missing credentials
    crate::provider_admin::set_enabled(&e.core, ProviderId::Replicate, false).unwrap();
    let err = crate::jobs::submit(&e.core, input("replicate:owner/t2v"), opts("d2", Some(1.0)))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::ProviderDisabled);
    e.secrets.delete("kling:api_key").unwrap();
    let err = crate::jobs::submit(
        &e.core,
        input("kling:text-to-video/kling-3.0"),
        opts("d3", Some(1.0)),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::MissingCredentials);
    // unknown model / unknown params
    let err = crate::jobs::submit(&e.core, input("replicate:nope"), opts("d4", None))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    let mut bad = input("higgsfield:hf/t2v");
    bad.params.insert("evil".into(), json!(1));
    assert_eq!(
        crate::jobs::submit(&e.core, bad, opts("d5", None))
            .await
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}

#[tokio::test]
async fn poll_recovery_after_restart_and_download() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/models/owner/t2v/predictions"))
        .respond_with(
            ResponseTemplate::new(201).set_body_json(json!({"id": "pred1", "status": "starting"})),
        )
        .mount(&s)
        .await;
    let video_url = format!("{}/files/out.mp4", s.uri());
    Mock::given(method("GET"))
        .and(path("/predictions/pred1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"id": "pred1", "status": "succeeded", "output": video_url})),
        )
        .mount(&s)
        .await;
    let mut mp4 = b"\x00\x00\x00\x18ftypisom".to_vec();
    mp4.extend(vec![7u8; 4096]);
    Mock::given(method("GET"))
        .and(path("/files/out.mp4"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(mp4.clone(), "video/mp4"))
        .mount(&s)
        .await;

    let e = setup(&s);
    crate::settings::update(
        &e.core,
        serde_json::from_value(json!({"autoSave": false})).unwrap(),
    )
    .unwrap();
    let job = crate::jobs::submit(&e.core, input("replicate:owner/t2v"), opts("rk", Some(0.5)))
        .await
        .unwrap();
    assert_eq!(job.status, JobStatus::Queued);

    // "restart": a new core over the same database file
    let TestEnv { dir, core, .. } = e;
    drop(core);
    let db = crate::db::Db::open(&dir.path().join("vidra.sqlite3")).unwrap();
    let e2 = reopen(dir, db, Some(providers(&s.uri())), registry(), None);
    e2.secrets
        .set("replicate:api_token", "TOPSECRET-R8")
        .unwrap();
    crate::jobs::recover_submitting(&e2.core).await.unwrap();
    assert_eq!(crate::jobs::poll_once(&e2.core).await.unwrap(), 1);
    let j = crate::jobs::get_job(&e2.core, &job.id).unwrap().unwrap();
    assert_eq!(j.status, JobStatus::Completed);
    let entries = crate::archive::list(&e2.core, &ArchiveQuery::default()).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].state, "download_pending");
    let asset = entries[0].asset.clone().unwrap();
    // Replicate deletes outputs after ~1 h: a download task exists even with autoSave off.
    assert!(entries[0].task.is_some());
    assert_eq!(
        crate::downloads::run(&e2.core, &asset.id).await.unwrap(),
        crate::downloads::Outcome::Saved
    );
    let entries = crate::archive::list(&e2.core, &ArchiveQuery::default()).unwrap();
    assert_eq!(entries[0].state, "saved");
    // polling again does nothing (terminal)
    assert_eq!(crate::jobs::poll_once(&e2.core).await.unwrap(), 0);
}

#[tokio::test]
async fn interrupted_submitting_jobs_are_recovered() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/hf/t2v"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"request_id": "replayed"})))
        .mount(&s)
        .await;
    let e = setup(&s);
    for (prov, model_id, key) in [
        ("higgsfield", "higgsfield:hf/t2v", "s1"),
        ("replicate", "replicate:owner/t2v", "s2"),
    ] {
        let mut j = crate::budget::tests_support_job();
        j.provider = ProviderId::parse(prov).unwrap();
        j.model_id = model_id.into();
        j.status = JobStatus::Submitting;
        crate::jobs::insert_job(&e.core, &j, key).unwrap();
    }
    crate::jobs::recover_submitting(&e.core).await.unwrap();
    let hf = job_row(&e, "s1");
    assert_eq!(hf.status, JobStatus::Queued);
    assert_eq!(hf.provider_request_id.as_deref(), Some("replayed"));
    let r8 = job_row(&e, "s2");
    assert_eq!(r8.error_code.as_deref(), Some("submit_uncertain"));
}

#[tokio::test]
async fn cancel_rules() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/hf/t2v"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"request_id": "c1"})))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/requests/c1/cancel"))
        .respond_with(ResponseTemplate::new(400))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/text-to-video/kling-3.0"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"id": "k1"}})),
        )
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&s)
        .await;
    let e = setup(&s);
    let hf = crate::jobs::submit(&e.core, input("higgsfield:hf/t2v"), opts_ack("c-hf"))
        .await
        .unwrap();
    assert_eq!(
        crate::jobs::cancel(&e.core, &hf.id).await.unwrap_err().code,
        ErrorCode::CancelTooLate
    );
    let kl = crate::jobs::submit(
        &e.core,
        input("kling:text-to-video/kling-3.0"),
        opts("c-kl", Some(9.0)),
    )
    .await
    .unwrap();
    assert_eq!(
        crate::jobs::cancel(&e.core, &kl.id).await.unwrap_err().code,
        ErrorCode::CancelUnsupported
    );
}

/* ── Secrets never reach logs ──────────────────────────────────────────── */

struct Capture(Mutex<Vec<String>>);
impl log::Log for Capture {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, r: &log::Record) {
        self.0.lock().unwrap().push(format!("{}", r.args()));
    }
    fn flush(&self) {}
}

#[tokio::test]
async fn secrets_never_logged_or_stored() {
    static CAP: std::sync::OnceLock<&'static Capture> = std::sync::OnceLock::new();
    let cap: &'static Capture =
        CAP.get_or_init(|| Box::leak(Box::new(Capture(Mutex::new(vec![])))));
    let _ = log::set_logger(cap);
    log::set_max_level(log::LevelFilter::Trace);
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(401).set_body_json(json!({"detail": "Invalid credentials"})),
        )
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&s)
        .await;
    let e = setup(&s);
    for p in ProviderId::ALL {
        let _ = crate::provider_admin::verify(&e.core, p).await;
    }
    let _ = crate::jobs::estimate(&e.core, &input("higgsfield:hf/t2v")).await;
    let _ = crate::jobs::submit(&e.core, input("replicate:owner/t2v"), opts("ls", Some(9.0))).await;
    let _ = crate::jobs::poll_once(&e.core).await;
    let statuses = serde_json::to_string(&crate::provider_admin::list(&e.core).unwrap()).unwrap();
    let logs = cap.0.lock().unwrap().join("\n");
    e.core
        .db
        .conn()
        .execute_batch("PRAGMA wal_checkpoint(FULL);")
        .unwrap();
    let mut db_bytes = Vec::new();
    for f in std::fs::read_dir(e.dir.path()).unwrap() {
        let p = f.unwrap().path();
        if p.is_file() {
            db_bytes.extend(std::fs::read(p).unwrap());
        }
    }
    let backup = e.dir.path().join("b.vidra");
    crate::backup::export(&e.core, &backup).unwrap();
    let backup_bytes = std::fs::read(&backup).unwrap();
    for secret in ["TOPSECRET-HF", "TOPSECRET-R8", "TOPSECRET-KL"] {
        assert!(!logs.contains(secret), "log leak {secret}");
        assert!(!statuses.contains(secret));
        assert!(
            !db_bytes
                .windows(secret.len())
                .any(|w| w == secret.as_bytes()),
            "db leak {secret}"
        );
        assert!(
            !backup_bytes
                .windows(secret.len())
                .any(|w| w == secret.as_bytes()),
            "backup leak {secret}"
        );
    }
    let st = crate::provider_admin::status(&e.core, ProviderId::Replicate).unwrap();
    assert_eq!(st.verification, "failed");
}

#[test]
fn commands_match_ipc_contract() {
    let ipc = include_str!("../../src/lib/ipc.ts");
    let re = regex::Regex::new(r#"call<[\s\S]*?>\(\s*"([a-z_]+)""#).unwrap();
    let mut from_ts: Vec<&str> = re
        .captures_iter(ipc)
        .map(|c| c.get(1).unwrap().as_str())
        .collect();
    from_ts.sort();
    from_ts.dedup();
    let mut ours: Vec<&str> = crate::commands::COMMANDS.to_vec();
    ours.sort();
    assert_eq!(from_ts, ours);
    let caps = include_str!("../capabilities/default.json");
    for c in crate::commands::COMMANDS {
        assert!(
            caps.contains(&format!("\"allow-{}\"", c.replace('_', "-"))),
            "{c}"
        );
    }
    assert!(
        !caps.contains("opener:"),
        "opener must not be exposed to the renderer"
    );
}

#[tokio::test]
async fn unknown_cost_requires_acknowledgement() {
    let s = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/models/owner/free/predictions"))
        .respond_with(
            ResponseTemplate::new(201).set_body_json(json!({"id": "p9", "status": "starting"})),
        )
        .mount(&s)
        .await;
    let mut m = model("replicate", "owner/free", None, "output");
    m.raw["pricing"] = json!({"status": "unavailable", "currency": "USD", "source": null,
        "pricingPageUrl": "https://replicate.com/pricing", "verifiedAt": null});
    let mut credits = model("replicate", "owner/credits", None, "output");
    credits.raw["pricing"]["currency"] = json!("credits");
    credits.raw["pricing"]["unitName"] = json!("units");
    let reg = Registry::from_models(vec![
        crate::providers::test_support::reparse(m),
        crate::providers::test_support::reparse(credits),
    ]);
    let e = env_with(Some(providers(&s.uri())), reg, None);
    e.secrets.set("replicate:api_token", "t").unwrap();
    let est = crate::jobs::estimate(&e.core, &input("replicate:owner/free"))
        .await
        .unwrap();
    assert_eq!(est.status, "unavailable");
    assert_eq!(est.reason.as_deref(), Some("no_price"));
    assert_eq!(
        est.pricing_page_url.as_deref(),
        Some("https://replicate.com/pricing")
    );
    assert!(est.budget.incomplete);
    let err = crate::jobs::submit(&e.core, input("replicate:owner/free"), opts("a1", None))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::UnknownCostAckRequired);
    assert_eq!(err.details.unwrap()["reason"], "no_price");
    let job = crate::jobs::submit(&e.core, input("replicate:owner/free"), opts_ack("a1"))
        .await
        .unwrap();
    assert_eq!(job.estimated_cost_usd, None);
    // credits are never money: estimate is shown, but acknowledgement is required
    let est = crate::jobs::estimate(&e.core, &input("replicate:owner/credits"))
        .await
        .unwrap();
    assert_eq!(
        (est.status.as_str(), est.currency.as_deref(), est.usd),
        ("estimated", Some("credits"), None)
    );
    assert_eq!(est.amount, Some(0.5));
    assert_eq!(est.credits, Some(0.5));
    let err = crate::jobs::submit(
        &e.core,
        input("replicate:owner/credits"),
        opts("a2", Some(0.5)),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::UnknownCostAckRequired);
    assert_eq!(err.details.unwrap()["reason"], "credits");
}

#[tokio::test]
async fn rule_violations_carry_param_codes() {
    let e = env_with(None, registry(), None);
    let mut i = input("replicate:owner/t2v");
    i.params.insert("duration".into(), json!(99));
    let err = crate::jobs::estimate(&e.core, &i).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(
        err.details.unwrap(),
        json!({"field": "duration", "code": "out_of_range", "min": 1.0, "max": 20.0})
    );
}
