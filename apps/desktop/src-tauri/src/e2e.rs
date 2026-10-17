//! Test-only hooks for driving the real app end to end against a local mock
//! provider server. Everything here is compiled ONLY with the `e2e-mock`
//! Cargo feature, which release builds and the Windows installer never enable
//! (verified by scanning the release binary for the `VIDRA_E2E_` marker).

use std::path::PathBuf;

#[derive(Clone, Copy)]
pub enum DialogKind {
    Save,
    Open,
    OpenMany,
    Folder,
}

/// Replaces native dialogs during e2e runs: save dialogs write into
/// VIDRA_E2E_DIALOG_DIR, open dialogs return VIDRA_E2E_OPEN_FILE, folder
/// pickers return VIDRA_E2E_DIALOG_DIR/archive, or the folder named in
/// VIDRA_E2E_DIALOG_DIR/next-folder.txt when that file exists (lets a test
/// pick a second folder). Always None otherwise.
#[cfg(feature = "e2e-mock")]
pub fn dialog_override(kind: DialogKind, name: Option<&str>) -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var("VIDRA_E2E_DIALOG_DIR").ok()?);
    match kind {
        DialogKind::Save => Some(dir.join(name.unwrap_or("export.bin"))),
        DialogKind::Open | DialogKind::OpenMany => {
            match std::fs::read_to_string(dir.join("next-open.txt")) {
                // Lines of next-open.txt (consumed), else VIDRA_E2E_OPEN_FILE.
                Ok(list) if !list.trim().is_empty() => {
                    let _ = std::fs::remove_file(dir.join("next-open.txt"));
                    let first = list.lines().map(str::trim).find(|l| !l.is_empty())?;
                    if matches!(kind, DialogKind::OpenMany) {
                        let _ = std::fs::write(dir.join("open-many.txt"), &list);
                    }
                    Some(PathBuf::from(first))
                }
                _ => std::env::var("VIDRA_E2E_OPEN_FILE").ok().map(PathBuf::from),
            }
        }
        DialogKind::Folder => match std::fs::read_to_string(dir.join("next-folder.txt")) {
            Ok(p) if !p.trim().is_empty() => Some(PathBuf::from(p.trim())),
            _ => Some(dir.join("archive")),
        },
    }
}

#[cfg(not(feature = "e2e-mock"))]
#[inline(always)]
pub fn dialog_override(_kind: DialogKind, _name: Option<&str>) -> Option<PathBuf> {
    None
}

/// Base URL of the local mock provider server (e.g. http://127.0.0.1:4320).
#[cfg(feature = "e2e-mock")]
pub fn mock_base() -> Option<String> {
    std::env::var("VIDRA_E2E_MOCK_BASE").ok()
}

/// Isolated data directory for e2e runs (database, default archive).
#[cfg(feature = "e2e-mock")]
pub fn data_dir() -> Option<PathBuf> {
    std::env::var("VIDRA_E2E_DATA_DIR").ok().map(PathBuf::from)
}

/// Multi-file open dialog override: every line of `next-open.txt`.
#[cfg(feature = "e2e-mock")]
pub fn open_many_override() -> Option<Vec<PathBuf>> {
    dialog_override(DialogKind::OpenMany, None)?;
    let dir = PathBuf::from(std::env::var("VIDRA_E2E_DIALOG_DIR").ok()?);
    let list = std::fs::read_to_string(dir.join("open-many.txt")).ok()?;
    let _ = std::fs::remove_file(dir.join("open-many.txt"));
    Some(
        list.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(PathBuf::from)
            .collect(),
    )
}

#[cfg(not(feature = "e2e-mock"))]
#[inline(always)]
pub fn open_many_override() -> Option<Vec<PathBuf>> {
    None
}
