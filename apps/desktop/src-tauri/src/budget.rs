//! Application-level spending guard — mirrors `packages/core/src/budget.ts`.

use crate::types::{BudgetSettings, EstimateBudget, GenerationJob, JobStatus};
use chrono::{Datelike, Local, TimeZone};

#[derive(Debug, Clone, PartialEq)]
pub struct WindowUsage {
    pub estimated_usd: f64,
    pub unknown_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BudgetCheck {
    pub allowed: bool,
    pub exceeded: Vec<String>,
    pub warnings: Vec<String>,
    pub daily: WindowUsage,
    pub monthly: WindowUsage,
    pub incomplete: bool,
}

impl BudgetCheck {
    pub fn to_estimate_budget(&self) -> EstimateBudget {
        EstimateBudget {
            allowed: self.allowed,
            exceeded: self.exceeded.clone(),
            warnings: self.warnings.clone(),
            daily_spent_usd: self.daily.estimated_usd,
            monthly_spent_usd: self.monthly.estimated_usd,
            incomplete: self.incomplete,
        }
    }
}

fn counts(job: &GenerationJob) -> bool {
    !matches!(
        job.status,
        JobStatus::Failed | JobStatus::Canceled | JobStatus::Blocked
    )
}

pub fn start_of_local_day(now_ms: i64) -> i64 {
    let now = Local
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(Local::now);
    Local
        .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
        .earliest()
        .map(|d| d.timestamp_millis())
        .unwrap_or(now_ms)
}

pub fn start_of_local_month(now_ms: i64) -> i64 {
    let now = Local
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(Local::now);
    Local
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .earliest()
        .map(|d| d.timestamp_millis())
        .unwrap_or(now_ms)
}

fn round6(n: f64) -> f64 {
    (n * 1e6).round() / 1e6
}

pub fn usage_since(jobs: &[GenerationJob], since: i64) -> WindowUsage {
    let mut usd = 0.0;
    let mut unknown = 0;
    for job in jobs {
        if job.created_at < since || !counts(job) {
            continue;
        }
        match job.confirmed_cost_usd.or(job.estimated_cost_usd) {
            Some(c) => usd += c,
            None => unknown += 1,
        }
    }
    WindowUsage {
        estimated_usd: round6(usd),
        unknown_count: unknown,
    }
}

pub fn check_budget(
    jobs: &[GenerationJob],
    request_usd: Option<f64>,
    budget: &BudgetSettings,
    now_ms: i64,
) -> BudgetCheck {
    let daily = usage_since(jobs, start_of_local_day(now_ms));
    let monthly = usage_since(jobs, start_of_local_month(now_ms));
    let add = request_usd.unwrap_or(0.0);
    let mut exceeded = Vec::new();
    let mut warnings = Vec::new();
    let mut evaluate = |name: &str, used: f64, limit: Option<f64>| {
        let Some(limit) = limit else { return };
        let projected = used + add;
        if projected > limit + 1e-9 {
            exceeded.push(name.to_string());
        } else if projected >= limit * budget.warn_at_percent / 100.0 {
            warnings.push(name.to_string());
        }
    };
    evaluate("daily", daily.estimated_usd, budget.daily_limit_usd);
    evaluate("monthly", monthly.estimated_usd, budget.monthly_limit_usd);
    let incomplete = request_usd.is_none() || daily.unknown_count > 0 || monthly.unknown_count > 0;
    BudgetCheck {
        allowed: exceeded.is_empty(),
        exceeded,
        warnings,
        daily,
        monthly,
        incomplete,
    }
}

#[cfg(test)]
pub fn tests_support_job() -> GenerationJob {
    tests::job(JobStatus::Completed, None, None, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;

    pub fn job(
        status: JobStatus,
        est: Option<f64>,
        confirmed: Option<f64>,
        created_at: i64,
    ) -> GenerationJob {
        GenerationJob {
            id: new_id(),
            provider: ProviderId::Replicate,
            model_id: "replicate:x".into(),
            model_name: "X".into(),
            workflow: "text-to-video".into(),
            output: "video".into(),
            provider_request_id: None,
            status,
            prompt: "p".into(),
            negative_prompt: None,
            params: Default::default(),
            requested_duration_sec: None,
            estimated_cost_usd: est,
            estimate_source: None,
            confirmed_cost_usd: confirmed,
            error_code: None,
            error_message: None,
            prompt_id: None,
            project_id: None,
            created_at,
            updated_at: created_at,
            completed_at: None,
        }
    }

    #[test]
    fn budget_rules_match_core() {
        let now = now_ms();
        let budget = BudgetSettings {
            daily_limit_usd: Some(10.0),
            monthly_limit_usd: Some(100.0),
            warn_at_percent: 80.0,
            confirm_before_generate: true,
        };
        let jobs = vec![
            job(JobStatus::Completed, Some(5.0), None, now - 1000),
            job(JobStatus::Completed, Some(9.0), Some(2.0), now - 1000), // confirmed wins
            job(JobStatus::Failed, Some(50.0), None, now - 1000),        // not counted
            job(JobStatus::Canceled, Some(50.0), None, now - 1000),      // not counted
            job(JobStatus::Blocked, None, None, now - 1000),             // not counted (no unknown)
            job(JobStatus::Queued, Some(0.5), None, now - 1000),
        ];
        let c = check_budget(&jobs, Some(1.0), &budget, now);
        assert_eq!(c.daily.estimated_usd, 7.5);
        assert!(c.allowed);
        assert_eq!(c.warnings, vec!["daily"]); // 8.5 >= 8
        assert!(!c.incomplete);
        let c = check_budget(&jobs, Some(3.0), &budget, now);
        assert!(!c.allowed);
        assert_eq!(c.exceeded, vec!["daily"]);
        let c = check_budget(&jobs, Some(2.5), &budget, now); // exactly at limit → allowed
        assert!(c.allowed);
        let c = check_budget(&jobs, None, &budget, now);
        assert!(c.incomplete && c.allowed);
        let mut j2 = jobs.clone();
        j2.push(job(JobStatus::Generating, None, None, now - 10));
        let c = check_budget(&j2, Some(0.1), &budget, now);
        assert!(c.incomplete);
        assert_eq!(c.daily.unknown_count, 1);
        let none = BudgetSettings::default();
        let c = check_budget(&jobs, Some(1000.0), &none, now);
        assert!(c.allowed && c.warnings.is_empty());
        // old jobs outside the month do not count
        let old = vec![job(
            JobStatus::Completed,
            Some(500.0),
            None,
            start_of_local_month(now) - 1,
        )];
        assert_eq!(
            check_budget(&old, Some(1.0), &budget, now)
                .monthly
                .estimated_usd,
            0.0
        );
    }
}
