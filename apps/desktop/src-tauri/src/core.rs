//! Application core shared by all commands (independent of Tauri so it can be
//! exercised by tests).

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::manifest::{Model, Registry};
use crate::net::Net;
use crate::providers::{Creds, Providers};
use crate::secrets::{account, Secret, SecretStore};
use crate::types::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

pub trait EventSink: Send + Sync {
    fn emit(&self, event: StoreEvent);
}

pub struct NoopSink;
impl EventSink for NoopSink {
    fn emit(&self, _: StoreEvent) {}
}

/// Collects events (tests).
#[derive(Default)]
pub struct VecSink(pub Mutex<Vec<StoreEvent>>);
impl EventSink for VecSink {
    fn emit(&self, e: StoreEvent) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).push(e);
    }
}

pub type FreeSpaceFn = Arc<dyn Fn(&Path) -> Option<u64> + Send + Sync>;

pub fn system_free_space(path: &Path) -> Option<u64> {
    let mut p = path.to_path_buf();
    loop {
        if p.exists() {
            return fs4::available_space(&p).ok();
        }
        if !p.pop() {
            return None;
        }
    }
}

pub struct Core {
    pub db: Db,
    pub secrets: Arc<dyn SecretStore>,
    pub net: Net,
    pub providers: Providers,
    pub registry: RwLock<Registry>,
    pub events: Arc<dyn EventSink>,
    pub data_dir: PathBuf,
    pub free_space: FreeSpaceFn,
    pub downloads: crate::downloads::DownloadState,
    pub drops: Mutex<HashMap<String, crate::references::DropEntry>>,
    pub imports: Mutex<HashMap<String, crate::backup::StagedImport>>,
    /// Reference files kept in memory for providers that take inline (base64)
    /// media instead of an upload API (Kling). Keyed by opaque token.
    pub inline_refs: Mutex<HashMap<String, crate::references::InlineRef>>,
    /// Default archive root (used when settings have none).
    pub default_root: PathBuf,
    /// Wakes the job poller (new submission, cancel).
    pub jobs_notify: tokio::sync::Notify,
    /// Models shipped with this build (embedded manifests).
    pub bundled: Vec<Model>,
    /// Merged catalog (bundled ∪ last-known-good signed registry).
    pub catalog: RwLock<crate::catalog::CatalogView>,
    /// Where the signed registry is fetched from and the key that verifies it.
    pub(crate) catalog_source: RwLock<crate::catalog::Source>,
    /// Serializes catalog syncs.
    pub catalog_sync: tokio::sync::Mutex<()>,
    /// Prepared / running archive moves keyed by token.
    pub moves: Mutex<HashMap<String, crate::storage::MoveState>>,
    /// True while an archive move copies files (downloads wait).
    pub moving: std::sync::atomic::AtomicBool,
    /// Video Editor: project media registries, FFmpeg, export queue.
    pub editor: crate::editor::EditorState,
}

pub struct CoreBuilder {
    pub db: Db,
    pub secrets: Arc<dyn SecretStore>,
    pub net: Net,
    pub providers: Option<Providers>,
    pub registry: Registry,
    pub events: Arc<dyn EventSink>,
    pub data_dir: PathBuf,
    pub default_root: PathBuf,
    pub free_space: FreeSpaceFn,
}

impl CoreBuilder {
    pub fn build(self) -> Arc<Core> {
        let providers = self
            .providers
            .unwrap_or_else(|| Providers::new(self.net.clone()));
        let bundled = self.registry.models.clone();
        let catalog = crate::catalog::bundled_view(&bundled);
        Arc::new(Core {
            bundled,
            catalog: RwLock::new(catalog),
            catalog_source: RwLock::new(crate::catalog::Source::default()),
            catalog_sync: tokio::sync::Mutex::new(()),
            moves: Mutex::new(HashMap::new()),
            moving: std::sync::atomic::AtomicBool::new(false),
            editor: crate::editor::EditorState::default(),
            db: self.db,
            secrets: self.secrets,
            net: self.net,
            providers,
            registry: RwLock::new(self.registry),
            events: self.events,
            data_dir: self.data_dir,
            free_space: self.free_space,
            downloads: Default::default(),
            drops: Mutex::new(HashMap::new()),
            imports: Mutex::new(HashMap::new()),
            inline_refs: Mutex::new(HashMap::new()),
            default_root: self.default_root,
            jobs_notify: tokio::sync::Notify::new(),
        })
    }
}

impl Core {
    pub fn emit(&self, e: StoreEvent) {
        self.events.emit(e);
    }

    /// An executable model (submit/estimate). Catalog entries this build
    /// cannot run are reported as `update_required` / `model_unavailable`.
    pub fn model(&self, id: &str) -> AppResult<Model> {
        if id.len() > 200 {
            return Err(AppError::invalid("Unknown model.").with_reason("unknown_model"));
        }
        if let Some(m) = self
            .registry
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
        {
            return Ok(m.clone());
        }
        let state = self
            .catalog
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .entries
            .iter()
            .find(|e| e.id == id)
            .map(|e| (e.state.clone(), e.reason.clone()));
        match state {
            Some((s, reason)) if s == "update_required" => Err(AppError::new(
                crate::error::ErrorCode::UpdateRequired,
                "This model needs a newer version of Vidra Studio.",
            )
            .with_details(serde_json::json!({"modelId": id, "reason": reason}))),
            Some(_) => Err(AppError::new(
                crate::error::ErrorCode::ModelUnavailable,
                "This model is no longer available.",
            )
            .with_details(serde_json::json!({"modelId": id, "reason": "discontinued"}))),
            None => Err(AppError::invalid("Unknown model.").with_reason("unknown_model")),
        }
    }

    /// Any known definition of a model (for jobs already submitted, even if
    /// the model was discontinued since).
    pub fn model_for_job(&self, id: &str) -> Option<Model> {
        if let Ok(m) = self.model(id) {
            return Some(m);
        }
        let cat = self.catalog.read().unwrap_or_else(|p| p.into_inner());
        cat.entries
            .iter()
            .find(|e| e.id == id)
            .and_then(|e| e.model.clone())
            .or_else(|| self.bundled.iter().find(|m| m.def.id == id).cloned())
    }

    pub fn creds(&self, provider: ProviderId) -> AppResult<Creds> {
        let p = self.providers.get(provider);
        let mut out = HashMap::new();
        for f in p.credential_fields() {
            if let Some(v) = self.secrets.get(&account(provider.as_str(), &f.key))? {
                out.insert(f.key.clone(), Secret::new(v));
            }
        }
        Ok(out)
    }

    pub fn archive_root(&self) -> PathBuf {
        PathBuf::from(crate::settings::get(self).archive_root)
    }

    pub fn provider_enabled(&self, provider: ProviderId) -> AppResult<bool> {
        let c = self.db.conn();
        let v: Option<i64> = rusqlite::OptionalExtension::optional(c.query_row(
            "SELECT enabled FROM providers WHERE id = ?1",
            [provider.as_str()],
            |r| r.get(0),
        ))?;
        Ok(v.unwrap_or(1) != 0)
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;
    use crate::secrets::MemoryStore;

    /// Fields drop in declaration order: `core` (which holds the open SQLite
    /// file) must close before `dir` is deleted, or Windows keeps the file
    /// locked and the temp folder silently stays behind.
    pub struct TestEnv {
        pub core: Arc<Core>,
        pub sink: Arc<VecSink>,
        pub secrets: Arc<MemoryStore>,
        pub dir: tempfile::TempDir,
    }

    pub fn env_with(
        providers: Option<Providers>,
        registry: Registry,
        free: Option<FreeSpaceFn>,
    ) -> TestEnv {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("vidra.sqlite3")).unwrap();
        reopen(dir, db, providers, registry, free)
    }

    pub fn reopen(
        dir: tempfile::TempDir,
        db: Db,
        providers: Option<Providers>,
        registry: Registry,
        free: Option<FreeSpaceFn>,
    ) -> TestEnv {
        let sink = Arc::new(VecSink::default());
        let secrets = Arc::new(MemoryStore::default());
        let root = dir.path().join("archive");
        let core = CoreBuilder {
            db,
            secrets: secrets.clone(),
            net: Net::for_tests(),
            providers,
            registry,
            events: sink.clone(),
            data_dir: dir.path().to_path_buf(),
            default_root: root,
            free_space: free.unwrap_or_else(|| Arc::new(|_: &Path| Some(u64::MAX / 4))),
        }
        .build();
        TestEnv {
            dir,
            core,
            sink,
            secrets,
        }
    }

    pub fn env() -> TestEnv {
        env_with(None, Registry::from_models(vec![]), None)
    }
}
