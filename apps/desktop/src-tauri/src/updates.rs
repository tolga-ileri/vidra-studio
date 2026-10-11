//! In-app updates through the Tauri updater: GitHub Releases publish a signed
//! `latest.json` (see .github/workflows/release.yml). The installer is only
//! run after its minisign signature verifies against the public key embedded
//! in tauri.conf.json, so a tampered download is refused.

use crate::core::Core;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::types::UpdateInfo;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

pub const RELEASES_PAGE: &str = "https://github.com/tolga-ileri/vidra-studio/releases";

fn update_error(e: impl std::fmt::Display) -> AppError {
    log::warn!("update failed: {e}");
    AppError::new(
        ErrorCode::Network,
        "The update could not be downloaded or verified.",
    )
}

/// Checks for a newer signed release. Any failure (offline, no release yet)
/// returns `None` so startup never blocks on it.
pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Option<UpdateInfo> {
    let current = app.package_info().version.to_string();
    match app.updater().ok()?.check().await {
        Ok(Some(u)) => Some(UpdateInfo {
            current_version: current,
            latest_version: u.version.clone(),
            url: RELEASES_PAGE.to_string(),
            newer: true,
        }),
        Ok(None) => Some(UpdateInfo {
            latest_version: current.clone(),
            current_version: current,
            url: RELEASES_PAGE.to_string(),
            newer: false,
        }),
        Err(e) => {
            log::warn!("update check failed: {e}");
            None
        }
    }
}

/// Generations still running at the provider and downloads not yet saved.
/// Installing restarts the app, so these are surfaced before any update.
pub fn active_work(core: &Core) -> AppResult<(i64, i64)> {
    let c = core.db.conn();
    let jobs = c.query_row(
        "SELECT COUNT(*) FROM generation_jobs WHERE status IN ('submitting','queued','generating')",
        [],
        |r| r.get(0),
    )?;
    let downloads = c.query_row(
        "SELECT COUNT(*) FROM download_tasks WHERE status IN ('pending','downloading')",
        [],
        |r| r.get(0),
    )?;
    Ok((jobs, downloads))
}

/// Never interrupts active work silently: the user must confirm again,
/// knowing how many generations and downloads are in progress.
pub fn require_ack(jobs: i64, downloads: i64, acknowledged: bool) -> AppResult<()> {
    if (jobs > 0 || downloads > 0) && !acknowledged {
        return Err(AppError::new(
            ErrorCode::ConfirmationRequired,
            "Generations or downloads are still in progress.",
        )
        .with_details(serde_json::json!({ "activeJobs": jobs, "activeDownloads": downloads })));
    }
    Ok(())
}

/// Downloads, verifies and installs the newest release, then restarts.
pub async fn install<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let update = app
        .updater()
        .map_err(update_error)?
        .check()
        .await
        .map_err(update_error)?
        .ok_or_else(|| AppError::new(ErrorCode::NotFound, "Vidra Studio is up to date."))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(update_error)?;
    app.restart()
}

/// Parses "v1.2.3", "1.2" or "2.0.0-beta.1" into (major, minor, patch).
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let core = s.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    Some((
        it.next()??,
        it.next().unwrap_or(Some(0))?,
        it.next().unwrap_or(Some(0))?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_work_needs_a_second_confirmation() {
        assert!(require_ack(0, 0, false).is_ok());
        let e = require_ack(1, 2, false).unwrap_err();
        assert_eq!(e.code, ErrorCode::ConfirmationRequired);
        assert_eq!(e.details.unwrap()["activeDownloads"], 2);
        assert!(require_ack(1, 2, true).is_ok());
    }

    #[test]
    fn semver_parse() {
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("v2.0.0-beta.1"), Some((2, 0, 0)));
        assert!(parse_version("latest").is_none());
        assert!(parse_version("v0.10.0") > parse_version("0.9.1"));
    }
}
