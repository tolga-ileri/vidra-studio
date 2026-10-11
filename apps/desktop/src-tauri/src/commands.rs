//! Tauri commands — names and arguments match `apps/desktop/src/lib/ipc.ts`.

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::types::*;
use crate::{
    archive, backup, catalog, db, downloads, jobs, prompts, provider_admin, references, settings,
    storage,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;

type S<'a> = State<'a, Arc<Core>>;

fn provider(id: &str) -> AppResult<ProviderId> {
    ProviderId::parse(id).ok_or_else(|| AppError::invalid("Unknown provider."))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| AppError::unknown("The operation failed."))
}

/* ── App ───────────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn app_info(core: S<'_>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: core.data_dir.to_string_lossy().into_owned(),
        platform: std::env::consts::OS.into(),
    }
}

#[tauri::command]
pub fn get_settings(core: S<'_>) -> AppSettings {
    settings::get(&core)
}

#[tauri::command]
pub fn update_settings(core: S<'_>, patch: settings::SettingsPatch) -> AppResult<AppSettings> {
    settings::update(&core, patch)
}

/// Lets the webview load media from `root`. Never creates the folder: a
/// missing custom root means an unplugged drive and must stay visible as
/// such (the default root is created on demand by `storage::root_available`).
pub fn allow_root<R: Runtime>(app: &AppHandle<R>, root: &std::path::Path) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(root, true) {
        log::warn!("asset scope update failed: {e}");
    }
}

fn pick_folder<R: Runtime>(app: &AppHandle<R>, title: &str) -> Option<PathBuf> {
    crate::e2e::dialog_override(crate::e2e::DialogKind::Folder, None).or_else(|| {
        app.dialog()
            .file()
            .set_title(title)
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
    })
}

/// Save dialog that starts in the configured export folder.
fn save_dialog<R: Runtime>(
    app: &AppHandle<R>,
    core: &Core,
    name: &str,
    filter: (&str, &[&str]),
) -> Option<PathBuf> {
    crate::e2e::dialog_override(crate::e2e::DialogKind::Save, Some(name)).or_else(|| {
        let mut d = app
            .dialog()
            .file()
            .set_file_name(name)
            .add_filter(filter.0, filter.1);
        if let Some(dir) = storage::export_dir(core) {
            d = d.set_directory(dir);
        }
        d.blocking_save_file().and_then(|p| p.into_path().ok())
    })
}

/* ── Storage ───────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn storage_status(core: S<'_>) -> AppResult<StorageStatus> {
    let core = core.inner().clone();
    blocking(move || storage::status(&core)).await?
}

#[tauri::command]
pub async fn plan_archive_move<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
) -> AppResult<Option<ArchiveMovePlan>> {
    let Some(path) = pick_folder(&app, "Choose the new archive folder") else {
        return Ok(None);
    };
    let core = core.inner().clone();
    blocking(move || storage::plan_move(&core, &path))
        .await?
        .map(Some)
}

#[tauri::command]
pub async fn start_archive_move(core: S<'_>, token: String) -> AppResult<ArchiveMoveResult> {
    let core = core.inner().clone();
    blocking(move || storage::start_move(&core, &token)).await?
}

#[tauri::command]
pub async fn finalize_archive_move<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
    token: String,
    remove_old_copies: bool,
) -> AppResult<AppSettings> {
    let core = core.inner().clone();
    let (s, old, new) =
        blocking(move || storage::finalize_move(&core, &token, remove_old_copies)).await??;
    let _ = app.asset_protocol_scope().forbid_directory(&old, true);
    allow_root(&app, &new);
    Ok(s)
}

#[tauri::command]
pub fn cancel_archive_move(core: S<'_>, token: String) -> AppResult<()> {
    storage::cancel_move(&core, &token)
}

#[tauri::command]
pub async fn reconnect_archive_root<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
) -> AppResult<Option<StorageStatus>> {
    let Some(path) = pick_folder(&app, "Locate your Vidra archive folder") else {
        return Ok(None);
    };
    let core = core.inner().clone();
    let (status, root) = blocking(move || storage::reconnect(&core, &path)).await??;
    allow_root(&app, &root);
    Ok(Some(status))
}

#[tauri::command]
pub async fn choose_export_dir<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
) -> AppResult<Option<AppSettings>> {
    let Some(path) = pick_folder(&app, "Choose the export folder") else {
        return Ok(None);
    };
    let core = core.inner().clone();
    blocking(move || storage::set_export_dir(&core, &path))
        .await?
        .map(Some)
}

#[tauri::command]
pub async fn check_for_updates<R: Runtime>(app: AppHandle<R>) -> AppResult<Option<UpdateInfo>> {
    Ok(crate::updates::check(&app).await)
}

#[tauri::command]
pub async fn install_update<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
    acknowledge_active: bool,
) -> AppResult<()> {
    let core = core.inner().clone();
    let (jobs, downloads) = blocking(move || crate::updates::active_work(&core)).await??;
    crate::updates::require_ack(jobs, downloads, acknowledge_active)?;
    crate::updates::install(&app).await
}

/* ── Providers / models ────────────────────────────────────────────────── */

#[tauri::command]
pub fn list_providers(core: S<'_>) -> AppResult<Vec<ProviderStatus>> {
    provider_admin::list(&core)
}

#[tauri::command]
pub fn set_provider_credentials(
    core: S<'_>,
    provider: String,
    values: HashMap<String, String>,
) -> AppResult<()> {
    provider_admin::set_credentials(&core, self::provider(&provider)?, values)
}

#[tauri::command]
pub fn remove_provider_credentials(core: S<'_>, provider: String) -> AppResult<()> {
    provider_admin::remove_credentials(&core, self::provider(&provider)?)
}

#[tauri::command]
pub async fn verify_provider(core: S<'_>, provider: String) -> AppResult<ProviderStatus> {
    provider_admin::verify(&core, self::provider(&provider)?).await
}

#[tauri::command]
pub fn set_provider_enabled(core: S<'_>, provider: String, enabled: bool) -> AppResult<()> {
    provider_admin::set_enabled(&core, self::provider(&provider)?, enabled)
}

/* ── Catalog ───────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn catalog_status(core: S<'_>) -> CatalogStatus {
    catalog::status(&core)
}

#[tauri::command]
pub fn list_catalog(core: S<'_>) -> Vec<CatalogEntry> {
    catalog::list(&core)
}

#[tauri::command]
pub async fn sync_catalog(core: S<'_>) -> AppResult<CatalogSyncResult> {
    Ok(catalog::sync(core.inner()).await)
}

/// Executable models only.
#[tauri::command]
pub fn list_models(core: S<'_>) -> Vec<Value> {
    catalog::list_models(&core)
}

/* ── References ────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn pick_reference<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
    provider: String,
    kind: String,
) -> AppResult<Option<UploadedReference>> {
    let provider = self::provider(&provider)?;
    if !["image", "video", "audio"].contains(&kind.as_str()) {
        return Err(AppError::invalid("Invalid file kind."));
    }
    let picked = crate::e2e::dialog_override(crate::e2e::DialogKind::Open, None).or_else(|| {
        app.dialog()
            .file()
            .add_filter(kind.clone(), references::dialog_extensions(&kind))
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
    });
    let Some(path) = picked else {
        return Ok(None);
    };
    references::upload(&core, provider, &path, Some(&kind))
        .await
        .map(Some)
}

#[tauri::command]
pub async fn upload_dropped_reference(
    core: S<'_>,
    provider: String,
    drop_token: String,
) -> AppResult<UploadedReference> {
    let provider = self::provider(&provider)?;
    let path = references::take_drop(&core, &drop_token)?;
    references::upload(&core, provider, &path, None).await
}

/* ── Generation ────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn estimate_generation(core: S<'_>, input: GenerationInput) -> AppResult<EstimateResult> {
    jobs::estimate(&core, &input).await
}

#[tauri::command]
pub async fn submit_generation(
    core: S<'_>,
    input: GenerationInput,
    options: SubmitOptions,
) -> AppResult<GenerationJob> {
    jobs::submit(core.inner(), input, options).await
}

#[tauri::command]
pub async fn cancel_generation(core: S<'_>, job_id: String) -> AppResult<()> {
    jobs::cancel(&core, &job_id).await
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobFilter {
    pub from: Option<i64>,
    pub to: Option<i64>,
}

#[tauri::command]
pub fn list_jobs(core: S<'_>, filter: Option<JobFilter>) -> AppResult<Vec<GenerationJob>> {
    let f = filter.unwrap_or_default();
    jobs::list_jobs(&core, f.from, f.to)
}

#[tauri::command]
pub fn get_job(core: S<'_>, id: String) -> AppResult<Option<GenerationJob>> {
    jobs::get_job(&core, &id)
}

#[tauri::command]
pub fn delete_job(core: S<'_>, id: String) -> AppResult<()> {
    jobs::delete_job(&core, &id)
}

/* ── Archive ───────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn list_archive(core: S<'_>, query: ArchiveQuery) -> AppResult<Vec<ArchiveEntry>> {
    archive::list(&core, &query)
}

#[tauri::command]
pub fn rename_item(core: S<'_>, item_id: String, title: Option<String>) -> AppResult<()> {
    archive::rename_item(&core, &item_id, title)
}

#[tauri::command]
pub fn set_favorite(core: S<'_>, item_ids: Vec<String>, favorite: bool) -> AppResult<()> {
    archive::set_favorite(&core, &item_ids, favorite)
}

#[tauri::command]
pub fn set_tags(core: S<'_>, item_id: String, tags: Vec<String>) -> AppResult<()> {
    archive::set_tags(&core, &item_id, &tags)
}

#[tauri::command]
pub fn move_to_project(
    core: S<'_>,
    item_ids: Vec<String>,
    project_id: Option<String>,
) -> AppResult<()> {
    archive::move_to_project(&core, &item_ids, project_id)
}

#[tauri::command]
pub fn trash_items(core: S<'_>, item_ids: Vec<String>) -> AppResult<()> {
    archive::trash(&core, &item_ids)
}

#[tauri::command]
pub fn restore_items(core: S<'_>, item_ids: Vec<String>) -> AppResult<()> {
    archive::restore(&core, &item_ids)
}

#[tauri::command]
pub async fn delete_permanently(core: S<'_>, item_ids: Vec<String>) -> AppResult<()> {
    let core = core.inner().clone();
    blocking(move || archive::delete_permanently(&core, &item_ids)).await?
}

#[tauri::command]
pub async fn verify_files(core: S<'_>) -> AppResult<i64> {
    let core = core.inner().clone();
    blocking(move || archive::verify_files(&core)).await?
}

#[tauri::command]
pub fn storage_stats(core: S<'_>) -> AppResult<StorageStats> {
    archive::storage_stats(&core)
}

#[tauri::command]
pub fn media_path(core: S<'_>, asset_id: String) -> AppResult<Option<String>> {
    archive::media_path(&core, &asset_id)
}

#[tauri::command]
pub fn thumbnail_path(core: S<'_>, asset_id: String) -> AppResult<Option<String>> {
    archive::thumbnail_path(&core, &asset_id)
}

#[tauri::command]
pub async fn save_thumbnail(
    core: S<'_>,
    asset_id: String,
    image_base64: String,
    duration_sec: Option<f64>,
    width: Option<i64>,
    height: Option<i64>,
) -> AppResult<()> {
    let core = core.inner().clone();
    blocking(move || {
        archive::save_thumbnail(&core, &asset_id, &image_base64, duration_sec, width, height)
    })
    .await?
}

#[tauri::command]
pub async fn export_media<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
    asset_id: String,
    suggested_name: String,
) -> AppResult<bool> {
    let src = archive::saved_file(&core, &asset_id)?;
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let name = archive::safe_file_name(&suggested_name, &ext);
    let picked = save_dialog(&app, &core, &name, (ext.as_str(), &[ext.as_str()]));
    let Some(dest) = picked else {
        return Ok(false);
    };
    let core = core.inner().clone();
    blocking(move || archive::export_media(&core, &asset_id, &dest)).await??;
    Ok(true)
}

#[tauri::command]
pub fn open_file_location(core: S<'_>, asset_id: String) -> AppResult<()> {
    let path = archive::saved_file(&core, &asset_id)?;
    tauri_plugin_opener::reveal_item_in_dir(PathBuf::from(archive::display_path(&path)))
        .map_err(|_| AppError::io("Could not open the file location."))
}

/// Opens an official documentation / project page in the user's browser.
/// Only https URLs on an allowlist of provider and project hosts are
/// accepted, so the renderer cannot launch arbitrary URLs or programs.
#[tauri::command]
pub fn open_external_url(url: String) -> AppResult<()> {
    let safe = external_url_allowed(&url)
        .ok_or_else(|| AppError::invalid("This link cannot be opened."))?;
    tauri_plugin_opener::open_url(safe, None::<&str>)
        .map_err(|_| AppError::io("Could not open the browser."))
}

pub fn external_url_allowed(raw: &str) -> Option<String> {
    const HOSTS: &[&str] = &[
        "higgsfield.ai",
        "docs.higgsfield.ai",
        "open.higgsfield.ai",
        "replicate.com",
        "kling.ai",
        "app.klingai.com",
    ];
    if raw.len() > 2048 {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let ok = HOSTS.contains(&host.as_str())
        || (host == "github.com" && url.path().starts_with("/tolga-ileri/vidra-studio"));
    ok.then(|| url.to_string())
}

/// Saves renderer-generated text (CSV / JSON exports) through a native save
/// dialog. Content and extension are bounded; the user picks the location.
#[tauri::command]
pub async fn save_text_file<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
    suggested_name: String,
    contents: String,
    extension: String,
) -> AppResult<bool> {
    const MAX: usize = 20 * 1024 * 1024;
    let ext = extension.to_ascii_lowercase();
    if !matches!(ext.as_str(), "csv" | "json" | "txt") {
        return Err(AppError::invalid("Unsupported file type."));
    }
    if contents.len() > MAX {
        return Err(AppError::invalid("The file is too large to save."));
    }
    let name = archive::safe_file_name(&suggested_name, &ext);
    let picked = save_dialog(&app, &core, &name, (ext.as_str(), &[ext.as_str()]));
    let Some(dest) = picked else {
        return Ok(false);
    };
    blocking(move || std::fs::write(&dest, contents.as_bytes()))
        .await?
        .map_err(|_| AppError::io("Could not write the file."))?;
    Ok(true)
}

/* ── Projects ──────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn list_projects(core: S<'_>) -> AppResult<Vec<Project>> {
    db::list_projects(&core.db.conn())
}

#[tauri::command]
pub fn create_project(core: S<'_>, name: String) -> AppResult<Project> {
    let p = db::create_project(&core.db.conn(), &name)?;
    core.emit(StoreEvent::ArchiveChanged);
    Ok(p)
}

#[tauri::command]
pub fn rename_project(core: S<'_>, id: String, name: String) -> AppResult<()> {
    db::rename_project(&core.db.conn(), &id, &name)?;
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

#[tauri::command]
pub fn delete_project(core: S<'_>, id: String) -> AppResult<()> {
    db::delete_project(&core.db.conn(), &id)?;
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

/* ── Downloads ─────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn list_downloads(core: S<'_>) -> AppResult<Vec<DownloadListEntry>> {
    downloads::list(&core)
}

#[tauri::command]
pub fn retry_download(core: S<'_>, asset_id: String) -> AppResult<()> {
    downloads::retry(&core, &asset_id)
}

#[tauri::command]
pub fn pause_download(core: S<'_>, asset_id: String) -> AppResult<()> {
    downloads::pause(&core, &asset_id)
}

#[tauri::command]
pub fn resume_download(core: S<'_>, asset_id: String) -> AppResult<()> {
    downloads::resume(&core, &asset_id)
}

/* ── Prompts ───────────────────────────────────────────────────────────── */

#[tauri::command]
pub fn list_prompts(core: S<'_>, query: Option<prompts::PromptQuery>) -> AppResult<Vec<Prompt>> {
    prompts::list(&core, &query.unwrap_or_default())
}

#[tauri::command]
pub fn get_prompt(core: S<'_>, id: String) -> AppResult<Option<Prompt>> {
    validate_id(&id)?;
    prompts::get(&core.db.conn(), &id)
}

#[tauri::command]
pub fn create_prompt(core: S<'_>, input: PromptInput) -> AppResult<Prompt> {
    prompts::create(&core, input)
}

#[tauri::command]
pub fn update_prompt(core: S<'_>, id: String, input: PromptInput) -> AppResult<Prompt> {
    prompts::update(&core, &id, input)
}

#[tauri::command]
pub fn duplicate_prompt(core: S<'_>, id: String) -> AppResult<Prompt> {
    prompts::duplicate(&core, &id)
}

#[tauri::command]
pub fn delete_prompt(core: S<'_>, id: String) -> AppResult<()> {
    prompts::delete(&core, &id)
}

#[tauri::command]
pub fn set_prompt_favorite(core: S<'_>, id: String, favorite: bool) -> AppResult<()> {
    prompts::set_favorite(&core, &id, favorite)
}

#[tauri::command]
pub fn list_prompt_versions(core: S<'_>, prompt_id: String) -> AppResult<Vec<PromptVersion>> {
    prompts::versions(&core, &prompt_id)
}

#[tauri::command]
pub fn restore_prompt_version(core: S<'_>, prompt_id: String, version: i64) -> AppResult<Prompt> {
    prompts::restore_version(&core, &prompt_id, version)
}

#[tauri::command]
pub fn list_categories(core: S<'_>) -> AppResult<Vec<PromptCategory>> {
    prompts::categories(&core)
}

#[tauri::command]
pub fn create_category(core: S<'_>, name: String) -> AppResult<PromptCategory> {
    prompts::create_category(&core, &name)
}

#[tauri::command]
pub fn rename_category(core: S<'_>, id: String, name: String) -> AppResult<()> {
    prompts::rename_category(&core, &id, &name)
}

#[tauri::command]
pub fn delete_category(core: S<'_>, id: String) -> AppResult<()> {
    prompts::delete_category(&core, &id)
}

#[tauri::command]
pub async fn export_prompts<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
    ids: Option<Vec<String>>,
) -> AppResult<bool> {
    let json = prompts::export(&core, ids.as_deref())?;
    let picked = save_dialog(&app, &core, "vidra-prompts.json", ("JSON", &["json"]));
    let Some(dest) = picked else {
        return Ok(false);
    };
    std::fs::write(dest, json)?;
    Ok(true)
}

#[derive(serde::Serialize)]
pub struct PromptImportResult {
    imported: usize,
    skipped: usize,
}

#[tauri::command]
pub async fn import_prompts<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
) -> AppResult<Option<PromptImportResult>> {
    let picked = crate::e2e::dialog_override(crate::e2e::DialogKind::Open, None).or_else(|| {
        app.dialog()
            .file()
            .add_filter("JSON", &["json"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
    });
    let Some(path) = picked else {
        return Ok(None);
    };
    let meta = std::fs::metadata(&path)?;
    if meta.len() > prompts::MAX_IMPORT_BYTES as u64 {
        return Err(AppError::invalid("The file is too large (max 5 MB)."));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|_| AppError::invalid("The file is not valid UTF-8 JSON."))?;
    let (imported, skipped) = prompts::import(&core, &text)?;
    Ok(Some(PromptImportResult { imported, skipped }))
}

#[tauri::command]
pub fn save_prompt_from_job(core: S<'_>, job_id: String, title: String) -> AppResult<Prompt> {
    prompts::save_from_job(&core, &job_id, &title)
}

/* ── Backup ────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn export_archive<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
) -> AppResult<Option<String>> {
    let name = format!(
        "vidra-backup-{}.vidra",
        chrono::Local::now().format("%Y-%m-%d")
    );
    let picked = save_dialog(&app, &core, &name, ("Vidra backup", &["vidra"]));
    let Some(dest) = picked else {
        return Ok(None);
    };
    let core = core.inner().clone();
    let d = dest.clone();
    blocking(move || backup::export(&core, &d)).await??;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn preview_import<R: Runtime>(
    app: AppHandle<R>,
    core: S<'_>,
) -> AppResult<Option<ImportPreview>> {
    let picked = crate::e2e::dialog_override(crate::e2e::DialogKind::Open, None).or_else(|| {
        app.dialog()
            .file()
            .add_filter("Vidra backup", &["vidra"])
            .blocking_pick_file()
            .and_then(|p| p.into_path().ok())
    });
    let Some(path) = picked else {
        return Ok(None);
    };
    let core = core.inner().clone();
    blocking(move || backup::preview(&core, &path))
        .await?
        .map(Some)
}

fn check_token(token: &str) -> AppResult<()> {
    if token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::invalid("Invalid import token."))
    }
}

#[tauri::command]
pub async fn confirm_import(core: S<'_>, token: String) -> AppResult<ImportResult> {
    check_token(&token)?;
    let core = core.inner().clone();
    blocking(move || backup::confirm(&core, &token)).await?
}

#[tauri::command]
pub fn cancel_import(core: S<'_>, token: String) -> AppResult<()> {
    check_token(&token)?;
    backup::cancel(&core, &token)
}

/// Every command name, used by build.rs-generated permissions and tests.
pub const COMMANDS: &[&str] = &[
    "app_info",
    "get_settings",
    "update_settings",
    "storage_status",
    "plan_archive_move",
    "start_archive_move",
    "finalize_archive_move",
    "cancel_archive_move",
    "reconnect_archive_root",
    "choose_export_dir",
    "check_for_updates",
    "install_update",
    "open_external_url",
    "save_text_file",
    "list_providers",
    "set_provider_credentials",
    "remove_provider_credentials",
    "verify_provider",
    "set_provider_enabled",
    "catalog_status",
    "list_catalog",
    "sync_catalog",
    "list_models",
    "pick_reference",
    "upload_dropped_reference",
    "estimate_generation",
    "submit_generation",
    "cancel_generation",
    "list_jobs",
    "get_job",
    "delete_job",
    "list_archive",
    "rename_item",
    "set_favorite",
    "set_tags",
    "move_to_project",
    "trash_items",
    "restore_items",
    "delete_permanently",
    "verify_files",
    "storage_stats",
    "media_path",
    "thumbnail_path",
    "save_thumbnail",
    "export_media",
    "open_file_location",
    "list_projects",
    "create_project",
    "rename_project",
    "delete_project",
    "list_downloads",
    "retry_download",
    "pause_download",
    "resume_download",
    "list_prompts",
    "get_prompt",
    "create_prompt",
    "update_prompt",
    "duplicate_prompt",
    "delete_prompt",
    "set_prompt_favorite",
    "list_prompt_versions",
    "restore_prompt_version",
    "list_categories",
    "create_category",
    "rename_category",
    "delete_category",
    "export_prompts",
    "import_prompts",
    "save_prompt_from_job",
    "export_archive",
    "preview_import",
    "confirm_import",
    "cancel_import",
];

#[cfg(test)]
mod external_url_tests {
    use super::external_url_allowed as ok;

    #[test]
    fn only_allowlisted_https_hosts() {
        assert!(ok("https://replicate.com/docs").is_some());
        assert!(
            ok("https://docs.fal.ai/model-apis").is_none(),
            "fal.ai is excluded"
        );
        assert!(ok("https://kling.ai/document-api/llms.txt").is_some());
        assert!(ok("https://github.com/tolga-ileri/vidra-studio/releases").is_some());
        for bad in [
            "http://replicate.com/",
            "https://github.com/someone/else",
            "https://evil.example.com/",
            "https://replicate.com.evil.com/",
            "https://user:pw@replicate.com/",
            "https://replicate.com:8443/",
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "ms-settings:",
        ] {
            assert!(ok(bad).is_none(), "{bad}");
        }
    }
}
