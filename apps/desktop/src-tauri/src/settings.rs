//! App settings stored as one JSON row in `settings` (`app`).

use crate::core::Core;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::types::{AppSettings, BudgetSettings, StoreEvent};
use serde::Deserialize;

const KEY: &str = "app";

pub fn defaults(core: &Core) -> AppSettings {
    AppSettings {
        language: "en".into(),
        onboarding_completed: false,
        auto_save: true,
        download_concurrency: 2,
        trash_retention_days: 30,
        budget: BudgetSettings::default(),
        archive_root: core.default_root.to_string_lossy().into_owned(),
        export_dir: None,
        catalog_auto_sync: true,
    }
}

pub fn get(core: &Core) -> AppSettings {
    let stored = db::get_setting(&core.db.conn(), KEY).ok().flatten();
    let mut s = stored
        .and_then(|j| serde_json::from_str::<AppSettings>(&j).ok())
        .unwrap_or_else(|| defaults(core));
    if s.archive_root.trim().is_empty() {
        s.archive_root = core.default_root.to_string_lossy().into_owned();
    }
    s
}

pub fn save(core: &Core, s: &AppSettings) -> AppResult<()> {
    db::set_setting(&core.db.conn(), KEY, &serde_json::to_string(s)?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub language: Option<String>,
    pub onboarding_completed: Option<bool>,
    pub auto_save: Option<bool>,
    pub download_concurrency: Option<u32>,
    pub trash_retention_days: Option<u32>,
    pub budget: Option<BudgetPatch>,
    /// Only accepted when unchanged; use the archive move flow to change it.
    pub archive_root: Option<String>,
    /// `null` clears it; any other value must be unchanged (use
    /// `choose_export_dir`, which checks the folder is writable).
    #[serde(default, deserialize_with = "opt_null_str")]
    pub export_dir: Option<Option<String>>,
    pub catalog_auto_sync: Option<bool>,
}

fn opt_null_str<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetPatch {
    #[serde(default, deserialize_with = "opt_null")]
    pub daily_limit_usd: Option<Option<f64>>,
    #[serde(default, deserialize_with = "opt_null")]
    pub monthly_limit_usd: Option<Option<f64>>,
    pub warn_at_percent: Option<f64>,
    pub confirm_before_generate: Option<bool>,
}

fn opt_null<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<f64>>, D::Error> {
    Ok(Some(Option::<f64>::deserialize(d)?))
}

pub fn update(core: &Core, patch: SettingsPatch) -> AppResult<AppSettings> {
    let mut s = get(core);
    if let Some(l) = patch.language {
        if l != "en" && l != "tr" {
            return Err(AppError::invalid("Unsupported language."));
        }
        s.language = l;
    }
    if let Some(v) = patch.onboarding_completed {
        s.onboarding_completed = v;
    }
    if let Some(v) = patch.auto_save {
        s.auto_save = v;
    }
    if let Some(v) = patch.download_concurrency {
        if !(1..=4).contains(&v) {
            return Err(AppError::invalid(
                "Download concurrency must be between 1 and 4.",
            ));
        }
        s.download_concurrency = v;
    }
    if let Some(v) = patch.trash_retention_days {
        if !(1..=365).contains(&v) {
            return Err(AppError::invalid(
                "Trash retention must be between 1 and 365 days.",
            ));
        }
        s.trash_retention_days = v;
    }
    if let Some(r) = patch.archive_root {
        if r != s.archive_root {
            return Err(
                AppError::invalid("Use “Move archive” to change the archive location.")
                    .with_reason("archive_root_readonly"),
            );
        }
    }
    if let Some(e) = patch.export_dir {
        match e {
            None => s.export_dir = None,
            Some(v) if Some(&v) == s.export_dir.as_ref() => {}
            Some(_) => {
                return Err(
                    AppError::invalid("Use “Choose folder” to set the export folder.")
                        .with_reason("export_dir_readonly"),
                )
            }
        }
    }
    if let Some(v) = patch.catalog_auto_sync {
        s.catalog_auto_sync = v;
    }
    if let Some(b) = patch.budget {
        let limit = |v: Option<f64>| -> AppResult<Option<f64>> {
            match v {
                Some(x) if !x.is_finite() || x < 0.0 || x > 1e9 => {
                    Err(AppError::invalid("Budget limits must be zero or more."))
                }
                other => Ok(other),
            }
        };
        if let Some(d) = b.daily_limit_usd {
            s.budget.daily_limit_usd = limit(d)?;
        }
        if let Some(m) = b.monthly_limit_usd {
            s.budget.monthly_limit_usd = limit(m)?;
        }
        if let Some(w) = b.warn_at_percent {
            if !w.is_finite() || !(1.0..=100.0).contains(&w) {
                return Err(AppError::invalid(
                    "The warning threshold must be between 1 and 100%.",
                ));
            }
            s.budget.warn_at_percent = w;
        }
        if let Some(c) = b.confirm_before_generate {
            s.budget.confirm_before_generate = c;
        }
    }
    save(core, &s)?;
    core.downloads.notify();
    core.emit(StoreEvent::SettingsChanged);
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::env;

    fn patch(v: serde_json::Value) -> SettingsPatch {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn validates_ranges() {
        let e = env();
        let c = &e.core;
        assert_eq!(get(c).download_concurrency, 2);
        assert!(update(c, patch(serde_json::json!({"downloadConcurrency": 5}))).is_err());
        assert!(update(c, patch(serde_json::json!({"downloadConcurrency": 0}))).is_err());
        assert!(update(c, patch(serde_json::json!({"trashRetentionDays": 366}))).is_err());
        assert!(update(
            c,
            patch(serde_json::json!({"budget": {"warnAtPercent": 0}}))
        )
        .is_err());
        assert!(update(
            c,
            patch(serde_json::json!({"budget": {"dailyLimitUsd": -1}}))
        )
        .is_err());
        assert!(update(c, patch(serde_json::json!({"archiveRoot": "C:\\Windows"}))).is_err());
        assert!(serde_json::from_value::<SettingsPatch>(serde_json::json!({"evil": 1})).is_err());
        let s = update(c, patch(serde_json::json!({"downloadConcurrency": 4, "language": "tr", "budget": {"dailyLimitUsd": 5, "monthlyLimitUsd": null}}))).unwrap();
        assert_eq!(s.download_concurrency, 4);
        assert_eq!(s.budget.daily_limit_usd, Some(5.0));
        let s = update(
            c,
            patch(serde_json::json!({"budget": {"dailyLimitUsd": null}})),
        )
        .unwrap();
        assert_eq!(s.budget.daily_limit_usd, None);
        assert_eq!(get(c).language, "tr");
    }
}
