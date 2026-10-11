//! Vidra Studio native backend.

pub mod archive;
pub mod backup;
pub mod budget;
pub mod bundled;
pub mod catalog;
pub mod commands;
pub mod core;
pub mod db;
pub mod downloads;
pub mod e2e;
pub mod error;
pub mod jobs;
#[cfg(test)]
mod jobs_tests;
pub mod manifest;
pub mod net;
pub mod pricing;
pub mod prompts;
pub mod provider_admin;
pub mod providers;
pub mod references;
pub mod rules;
pub mod secrets;
pub mod settings;
pub mod storage;
pub mod types;
pub mod updates;

use crate::core::{system_free_space, CoreBuilder, EventSink};
use crate::types::StoreEvent;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

struct TauriSink<R: Runtime>(AppHandle<R>);

impl<R: Runtime> EventSink for TauriSink<R> {
    fn emit(&self, event: StoreEvent) {
        let _ = self.0.emit("vidra://store", event);
    }
}

fn default_root<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .video_dir()
        .or_else(|_| app.path().home_dir().map(|h| h.join("Videos")))
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("Vidra Studio")
}

/// `--smoke-test`: self-checks for packaged builds; prints JSON and exits.
pub fn smoke_test(archive_root: &Path) -> serde_json::Value {
    let mut checks = serde_json::Map::new();
    let mut ok = true;
    let mut record = |name: &str, r: Result<(), String>| {
        ok &= r.is_ok();
        checks.insert(
            name.into(),
            serde_json::json!(r.err().unwrap_or_else(|| "ok".into())),
        );
    };
    let tmp = std::env::temp_dir().join(format!("vidra-smoke-{}", uuid::Uuid::new_v4()));
    record(
        "database",
        (|| {
            std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
            let db = db::Db::open(&tmp.join("smoke.sqlite3")).map_err(|e| e.message)?;
            let v = db.user_version().map_err(|e| e.message)?;
            (v >= 1)
                .then_some(())
                .ok_or_else(|| "migration failed".to_string())
        })(),
    );
    let _ = std::fs::remove_dir_all(&tmp);
    record(
        "archive_root",
        (|| {
            let dir = archive_root.join(".tmp");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let f = dir.join(format!("smoke-{}.tmp", uuid::Uuid::new_v4()));
            std::fs::write(&f, b"vidra").map_err(|e| e.to_string())?;
            let back = std::fs::read(&f).map_err(|e| e.to_string())?;
            std::fs::remove_file(&f).map_err(|e| e.to_string())?;
            (back == b"vidra")
                .then_some(())
                .ok_or_else(|| "readback mismatch".into())
        })(),
    );
    record(
        "keyring",
        (|| {
            use secrets::SecretStore;
            let store = secrets::KeyringStore::new();
            let account = format!("smoke-test:{}", uuid::Uuid::new_v4());
            store.set(&account, "smoke-value").map_err(|e| e.message)?;
            let got = store.get(&account).map_err(|e| e.message)?;
            store.delete(&account).map_err(|e| e.message)?;
            (got.as_deref() == Some("smoke-value"))
                .then_some(())
                .ok_or_else(|| "roundtrip mismatch".into())
        })(),
    );
    let n = manifest::Registry::bundled().models.len();
    record(
        "manifests",
        (n > 0).then_some(()).ok_or_else(|| "no models".into()),
    );
    serde_json::json!({ "ok": ok, "version": env!("CARGO_PKG_VERSION"), "checks": checks })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let root_default = default_root(&handle);
            if std::env::args().any(|a| a == "--smoke-test") {
                let result = smoke_test(&std::env::temp_dir().join("vidra-smoke-root"));
                println!("{result}");
                std::process::exit(if result["ok"] == serde_json::json!(true) {
                    0
                } else {
                    1
                });
            }
            #[allow(unused_mut)]
            let mut data_dir = handle.path().app_data_dir()?;
            #[allow(unused_mut)]
            let mut root_default = root_default;
            #[allow(unused_mut)]
            let mut net = net::Net::new();
            // e2e builds use the real Windows Credential Manager in a
            // separate namespace so tests never touch real credentials.
            #[cfg(not(feature = "e2e-mock"))]
            let secret_store = secrets::KeyringStore::new();
            #[cfg(feature = "e2e-mock")]
            let secret_store = secrets::KeyringStore::with_service("dev.tolgaileri.vidra.e2e");
            #[cfg(feature = "e2e-mock")]
            {
                if let Some(d) = e2e::data_dir() {
                    root_default = d.join("archive-default");
                    data_dir = d;
                }
                if e2e::mock_base().is_some() {
                    net = net::Net::for_tests();
                }
            }
            std::fs::create_dir_all(&data_dir)?;
            let db = db::Db::open(&data_dir.join("vidra.sqlite3")).map_err(|e| e.message)?;
            let core = CoreBuilder {
                db,
                secrets: Arc::new(secret_store),
                net,
                providers: None,
                registry: manifest::Registry::bundled(),
                events: Arc::new(TauriSink(handle.clone())),
                data_dir,
                default_root: root_default,
                free_space: Arc::new(system_free_space),
            }
            .build();
            let root = core.archive_root();
            commands::allow_root(&handle, &root);
            if let Ok(c) = std::fs::canonicalize(&root) {
                commands::allow_root(&handle, &c);
            }
            if let Err(e) = archive::purge_trash(&core) {
                log::warn!("trash purge failed: {}", e.code);
            }
            catalog::load_stored(&core);
            catalog::spawn_periodic(core.clone());
            jobs::spawn_poller(core.clone());
            downloads::spawn_manager(core.clone());
            app.manage(core);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(core) = window.try_state::<Arc<core::Core>>() {
                    let files = references::issue_drop_tokens(&core, paths);
                    let _ = window.emit("vidra://dropped", files);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::get_settings,
            commands::update_settings,
            commands::storage_status,
            commands::plan_archive_move,
            commands::start_archive_move,
            commands::finalize_archive_move,
            commands::cancel_archive_move,
            commands::reconnect_archive_root,
            commands::choose_export_dir,
            commands::check_for_updates,
            commands::open_external_url,
            commands::save_text_file,
            commands::list_providers,
            commands::set_provider_credentials,
            commands::remove_provider_credentials,
            commands::verify_provider,
            commands::set_provider_enabled,
            commands::catalog_status,
            commands::list_catalog,
            commands::sync_catalog,
            commands::list_models,
            commands::pick_reference,
            commands::upload_dropped_reference,
            commands::estimate_generation,
            commands::submit_generation,
            commands::cancel_generation,
            commands::list_jobs,
            commands::get_job,
            commands::delete_job,
            commands::list_archive,
            commands::rename_item,
            commands::set_favorite,
            commands::set_tags,
            commands::move_to_project,
            commands::trash_items,
            commands::restore_items,
            commands::delete_permanently,
            commands::verify_files,
            commands::storage_stats,
            commands::media_path,
            commands::thumbnail_path,
            commands::save_thumbnail,
            commands::export_media,
            commands::open_file_location,
            commands::list_projects,
            commands::create_project,
            commands::rename_project,
            commands::delete_project,
            commands::list_downloads,
            commands::retry_download,
            commands::pause_download,
            commands::resume_download,
            commands::list_prompts,
            commands::get_prompt,
            commands::create_prompt,
            commands::update_prompt,
            commands::duplicate_prompt,
            commands::delete_prompt,
            commands::set_prompt_favorite,
            commands::list_prompt_versions,
            commands::restore_prompt_version,
            commands::list_categories,
            commands::create_category,
            commands::rename_category,
            commands::delete_category,
            commands::export_prompts,
            commands::import_prompts,
            commands::save_prompt_from_job,
            commands::export_archive,
            commands::preview_import,
            commands::confirm_import,
            commands::cancel_import,
        ]);
    if let Err(e) = builder.run(tauri::generate_context!()) {
        eprintln!("Vidra Studio failed to start: {e}");
        std::process::exit(1);
    }
}
