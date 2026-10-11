//! Signed model registry + merged model catalog.
//!
//! The registry (`registry/v1/catalog.json` + `.sig`, built by
//! `scripts/registry/build.mjs`) is DATA ONLY: provider manifests in format
//! v2. It is fetched from one fixed URL through the SSRF-safe client, size
//! capped, verified with the embedded Ed25519 public key, fully re-validated
//! by `manifest.rs`, and can never add hosts (adapter base URLs are
//! constants). Nothing in it is executed. The last verified registry is kept
//! in SQLite (last-known-good) and is never replaced by an older version.

use crate::core::Core;
use crate::manifest::{parse_manifest_lenient, Model, Parsed, Registry};
use crate::types::*;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use reqwest::Method;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

pub const REGISTRY_BASE: &str =
    "https://raw.githubusercontent.com/tolga-ileri/vidra-studio/main/registry/v1";
pub const MAX_REGISTRY_BYTES: usize = 5 * 1024 * 1024;
const PUBLIC_KEY_B64: &str = include_str!("../../../../registry/PUBLIC_KEY.txt");
pub const STATES: &[&str] = &[
    "bundled",
    "new",
    "updated",
    "deprecated",
    "discontinued",
    "update_required",
];

pub fn embedded_public_key() -> [u8; 32] {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(PUBLIC_KEY_B64.trim())
        .expect("embedded registry key is base64");
    bytes.try_into().expect("embedded registry key is 32 bytes")
}

/// Registry location and verifying key. Release builds always use the
/// constants; only tests (and the e2e-mock base URL) can change them.
#[derive(Clone)]
pub struct Source {
    pub(crate) base: String,
    pub(crate) key: [u8; 32],
}

impl Default for Source {
    fn default() -> Self {
        #[allow(unused_mut)]
        let mut base = REGISTRY_BASE.to_string();
        #[cfg(feature = "e2e-mock")]
        if let Some(b) = crate::e2e::mock_base() {
            base = format!("{}/registry", b.trim_end_matches('/'));
        }
        Source {
            base,
            key: embedded_public_key(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub id: String,
    pub model: Option<Model>,
    pub raw: Value,
    pub state: String,
    pub executable: bool,
    pub reason: Option<String>,
    pub registry_version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CatalogView {
    pub version: String,
    /// "bundled" | "registry"
    pub source: String,
    pub entries: Vec<Entry>,
}

fn bundled_version() -> String {
    crate::bundled::MANIFESTS
        .iter()
        .filter_map(|(_, t)| {
            serde_json::from_str::<Value>(t)
                .ok()?
                .get("version")?
                .as_str()
                .map(String::from)
        })
        .max()
        .unwrap_or_else(|| "bundled".into())
}

pub fn bundled_view(bundled: &[Model]) -> CatalogView {
    let entries = bundled
        .iter()
        .map(|m| {
            let mut e = Entry {
                id: m.def.id.clone(),
                model: Some(m.clone()),
                raw: m.raw.clone(),
                state: "bundled".into(),
                executable: true,
                reason: None,
                registry_version: None,
            };
            apply_availability(&mut e, &[]);
            e
        })
        .collect();
    CatalogView {
        version: bundled_version(),
        source: "bundled".into(),
        entries,
    }
}

fn apply_availability(e: &mut Entry, discontinued: &[String]) {
    let availability = e
        .raw
        .get("availability")
        .and_then(Value::as_str)
        .unwrap_or("available");
    if availability == "discontinued" || discontinued.contains(&e.id) {
        e.state = "discontinued".into();
        e.executable = false;
    } else if availability == "deprecated" && e.executable {
        e.state = "deprecated".into();
    }
}

/* ── Registry document ─────────────────────────────────────────────────── */

pub struct RegistryDoc {
    pub version: String,
    pub min_app_version: String,
    pub providers: Map<String, Value>,
    pub discontinued: Vec<String>,
}

/// (machine reason, detail)
type Fail = (&'static str, String);

pub fn verify_signature(body: &[u8], sig_text: &str, key: &[u8; 32]) -> Result<(), Fail> {
    let fail = |m: &str| ("signature", m.to_string());
    let sig = base64::engine::general_purpose::STANDARD
        .decode(sig_text.trim())
        .map_err(|_| fail("signature is not base64"))?;
    let sig = Signature::from_slice(&sig).map_err(|_| fail("malformed signature"))?;
    let vk = VerifyingKey::from_bytes(key).map_err(|_| fail("invalid public key"))?;
    vk.verify_strict(body, &sig)
        .map_err(|_| fail("signature does not match"))
}

fn version_parts(v: &str) -> Option<Vec<u64>> {
    if v.is_empty() || v.len() > 64 {
        return None;
    }
    v.split('.').map(|p| p.parse::<u64>().ok()).collect()
}

pub fn compare_versions(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    Some(version_parts(a)?.cmp(&version_parts(b)?))
}

pub fn parse_registry(body: &[u8]) -> Result<RegistryDoc, Fail> {
    let root: Value =
        serde_json::from_slice(body).map_err(|e| ("schema", format!("invalid JSON: {e}")))?;
    let o = root
        .as_object()
        .ok_or(("schema", "registry must be an object".to_string()))?;
    if o.get("format") != Some(&json!("vidra.registry")) {
        return Err(("schema", "format must be vidra.registry".into()));
    }
    if o.get("formatVersion").and_then(Value::as_i64) != Some(1) {
        return Err(("compatibility", "unsupported registry formatVersion".into()));
    }
    if o.get("manifestFormatVersion").and_then(Value::as_i64)
        != Some(crate::manifest::MANIFEST_FORMAT_VERSION)
    {
        return Err(("compatibility", "unsupported manifestFormatVersion".into()));
    }
    let version = o
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| version_parts(v).is_some())
        .ok_or(("schema", "invalid registry version".to_string()))?
        .to_string();
    let min_app_version = o
        .get("minAppVersion")
        .and_then(Value::as_str)
        .filter(|v| crate::updates::parse_version(v).is_some())
        .ok_or(("schema", "invalid minAppVersion".to_string()))?
        .to_string();
    let providers = o
        .get("providers")
        .and_then(Value::as_object)
        .ok_or(("schema", "providers missing".to_string()))?
        .clone();
    let discontinued = match o.get("discontinued") {
        None => vec![],
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| x.as_str().map(String::from))
            .collect::<Option<Vec<_>>>()
            .ok_or(("schema", "discontinued must list ids".to_string()))?,
        Some(_) => return Err(("schema", "discontinued must be an array".into())),
    };
    Ok(RegistryDoc {
        version,
        min_app_version,
        providers,
        discontinued,
    })
}

/// Merges bundled models with a verified registry. Any invalid manifest
/// rejects the whole registry; models this build cannot run (unknown
/// vocabulary or too-new minAppVersion) become `update_required`.
pub fn build_view(
    bundled: &[Model],
    doc: &RegistryDoc,
    app_version: &str,
) -> Result<CatalogView, Fail> {
    let too_new = match (
        crate::updates::parse_version(app_version),
        crate::updates::parse_version(&doc.min_app_version),
    ) {
        (Some(app), Some(min)) => app < min,
        _ => true,
    };
    let mut entries: Vec<Entry> = bundled_view(bundled).entries;
    let index = |entries: &Vec<Entry>, id: &str| entries.iter().position(|e| e.id == id);
    let rv = Some(doc.version.clone());
    for (key, manifest) in &doc.providers {
        let parsed =
            parse_manifest_lenient(manifest).map_err(|e| ("schema", format!("{key}: {e}")))?;
        if &parsed.provider != key {
            return Err(("schema", format!("{key}: provider mismatch")));
        }
        for m in parsed.models {
            let (id, model, raw, problem) = match m {
                Parsed::Ok(m) => {
                    let p = too_new.then_some("min_app_version");
                    (m.def.id.clone(), Some(*m.clone()), m.raw.clone(), p)
                }
                Parsed::UpdateRequired { id, raw, reason } => (id, None, raw, Some(reason)),
            };
            match (index(&entries, &id), problem) {
                (Some(i), Some(reason)) => {
                    // Keep the bundled definition executable.
                    entries[i].reason = Some(format!("registry_{reason}"));
                }
                (None, Some(reason)) => entries.push(Entry {
                    id,
                    model: None,
                    raw,
                    state: "update_required".into(),
                    executable: false,
                    reason: Some(reason.into()),
                    registry_version: rv.clone(),
                }),
                (Some(i), None) => {
                    let changed = entries[i].raw != raw;
                    entries[i] = Entry {
                        id,
                        model,
                        raw,
                        state: if changed { "updated" } else { "bundled" }.into(),
                        executable: true,
                        reason: None,
                        registry_version: if changed { rv.clone() } else { None },
                    };
                }
                (None, None) => entries.push(Entry {
                    id,
                    model,
                    raw,
                    state: "new".into(),
                    executable: true,
                    reason: None,
                    registry_version: rv.clone(),
                }),
            }
        }
    }
    for e in &mut entries {
        apply_availability(e, &doc.discontinued);
    }
    Ok(CatalogView {
        version: doc.version.clone(),
        source: "registry".into(),
        entries,
    })
}

/* ── Persistence ───────────────────────────────────────────────────────── */

fn meta(core: &Core) -> Map<String, Value> {
    crate::db::get_setting(&core.db.conn(), "catalog:meta")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn set_meta(core: &Core, f: impl FnOnce(&mut Map<String, Value>)) {
    let mut m = meta(core);
    f(&mut m);
    if let Err(e) = crate::db::set_setting(
        &core.db.conn(),
        "catalog:meta",
        &Value::Object(m).to_string(),
    ) {
        log::warn!("catalog meta not saved: {}", e.code);
    }
}

/// Upstream discovery notes: {"versions": {modelId: ver}, "changed": [modelId]}.
fn upstream(core: &Core) -> Map<String, Value> {
    crate::db::get_setting(&core.db.conn(), "catalog:upstream")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn stored(core: &Core) -> Option<(String, String, String)> {
    core.db
        .conn()
        .query_row(
            "SELECT version, body, sig FROM catalog WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .ok()
        .flatten()
}

pub fn apply_view(core: &Core, mut view: CatalogView) {
    let changed: Vec<String> = upstream(core)
        .get("changed")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    for e in &mut view.entries {
        if e.reason.is_none() && changed.contains(&e.id) {
            e.reason = Some("upstream_schema_changed".into());
        }
    }
    let models = view
        .entries
        .iter()
        .filter(|e| e.executable)
        .filter_map(|e| e.model.clone())
        .collect();
    *core.registry.write().unwrap_or_else(|p| p.into_inner()) = Registry::from_models(models);
    *core.catalog.write().unwrap_or_else(|p| p.into_inner()) = view;
}

fn source(core: &Core) -> Source {
    core.catalog_source
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
}

#[cfg(test)]
pub(crate) fn set_source(core: &Core, base: &str, key: [u8; 32]) {
    *core.catalog_source.write().unwrap() = Source {
        base: base.trim_end_matches('/').to_string(),
        key,
    };
}

/// Startup: re-verifies and applies the last-known-good registry, if any.
pub fn load_stored(core: &Core) {
    let Some((_, body, sig)) = stored(core) else {
        apply_view(core, bundled_view(&core.bundled));
        return;
    };
    let src = source(core);
    let res = verify_signature(body.as_bytes(), &sig, &src.key)
        .and_then(|_| parse_registry(body.as_bytes()))
        .and_then(|doc| build_view(&core.bundled, &doc, env!("CARGO_PKG_VERSION")));
    match res {
        Ok(view) => apply_view(core, view),
        Err((code, msg)) => {
            log::warn!("stored registry rejected ({code}): {msg}");
            apply_view(core, bundled_view(&core.bundled));
        }
    }
}

/* ── Sync ──────────────────────────────────────────────────────────────── */

fn active_jobs(core: &Core) -> bool {
    core.db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM generation_jobs WHERE status IN ('submitting','queued','generating')",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(true)
}

async fn fetch(core: &Core, url: &str) -> Result<Vec<u8>, Fail> {
    let resp = core
        .net
        .external(Method::GET, url, |r| r.timeout(Duration::from_secs(30)))
        .await
        .map_err(|e| ("network", e.message))?;
    if !resp.status().is_success() {
        return Err(("network", format!("HTTP {}", resp.status().as_u16())));
    }
    crate::net::read_limited(resp, MAX_REGISTRY_BYTES)
        .await
        .map_err(|e| ("network", e.message))
}

fn result_for(view: &CatalogView, checked_at: i64, outcome: &str) -> CatalogSyncResult {
    let ids = |s: &str| {
        view.entries
            .iter()
            .filter(|e| e.state == s)
            .map(|e| e.id.clone())
            .collect::<Vec<_>>()
    };
    CatalogSyncResult {
        checked_at,
        outcome: outcome.into(),
        added: ids("new"),
        updated: ids("updated"),
        deprecated: ids("deprecated"),
        discontinued: ids("discontinued"),
        update_required: ids("update_required"),
        error: None,
    }
}

/// Official discovery for bundled Replicate models: marks entries whose
/// upstream `latest_version` changed. Never changes parameters.
async fn refresh_upstream(core: &Core) {
    let provider = core.providers.get(ProviderId::Replicate);
    let Ok(creds) = core.creds(ProviderId::Replicate) else {
        return;
    };
    if creds.is_empty() {
        return;
    }
    let models: Vec<Model> = core
        .bundled
        .iter()
        .filter(|m| m.def.provider == ProviderId::Replicate)
        .cloned()
        .collect();
    let latest = match provider.latest_versions(&creds, &models).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("replicate discovery failed: {}", e.code);
            return;
        }
    };
    let mut up = upstream(core);
    let mut versions = up
        .get("versions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut changed: Vec<String> = up
        .get("changed")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    for (id, ver) in latest {
        let pinned = models
            .iter()
            .find(|m| m.def.id == id)
            .and_then(|m| m.def.schema_version.clone());
        let previous = versions.get(&id).and_then(Value::as_str).map(String::from);
        let differs = match (&pinned, &previous) {
            (Some(p), _) => p != &ver,
            (None, Some(prev)) => prev != &ver,
            (None, None) => false,
        };
        if differs && !changed.contains(&id) {
            changed.push(id.clone());
        }
        versions.insert(id, Value::String(ver));
    }
    up.insert("versions".into(), Value::Object(versions));
    up.insert("changed".into(), json!(changed));
    let _ = crate::db::set_setting(
        &core.db.conn(),
        "catalog:upstream",
        &Value::Object(up).to_string(),
    );
    let view = core
        .catalog
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    apply_view(core, view);
}

pub async fn sync(core: &Arc<Core>) -> CatalogSyncResult {
    let _guard = core.catalog_sync.lock().await;
    let checked_at = now_ms();
    set_meta(core, |m| {
        m.insert("lastCheckedAt".into(), json!(checked_at));
    });
    let fail = |code: &'static str, msg: String| {
        log::warn!("catalog sync failed ({code}): {msg}");
        set_meta(core, |m| {
            m.insert("lastError".into(), json!(code));
        });
        CatalogSyncResult {
            checked_at,
            outcome: "failed".into(),
            error: Some(code.into()),
            ..Default::default()
        }
    };
    if active_jobs(core) {
        return CatalogSyncResult {
            checked_at,
            outcome: "skipped_active_jobs".into(),
            ..Default::default()
        };
    }
    let src = source(core);
    let body = match fetch(core, &format!("{}/catalog.json", src.base)).await {
        Ok(b) => b,
        Err((c, m)) => return fail(c, m),
    };
    let sig = match fetch(core, &format!("{}/catalog.json.sig", src.base)).await {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err((c, m)) => return fail(c, m),
    };
    if let Err((c, m)) = verify_signature(&body, &sig, &src.key) {
        return fail(c, m);
    }
    let doc = match parse_registry(&body) {
        Ok(d) => d,
        Err((c, m)) => return fail(c, m),
    };
    if let Some((applied, _, _)) = stored(core) {
        match compare_versions(&doc.version, &applied) {
            Some(std::cmp::Ordering::Greater) => {}
            Some(std::cmp::Ordering::Equal) => {
                refresh_upstream(core).await;
                set_meta(core, |m| {
                    m.insert("lastSuccessAt".into(), json!(checked_at));
                    m.insert("lastError".into(), Value::Null);
                });
                let view = core
                    .catalog
                    .read()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone();
                return result_for(&view, checked_at, "up_to_date");
            }
            _ => {
                return fail(
                    "downgrade",
                    format!("{} is not newer than {applied}", doc.version),
                )
            }
        }
    }
    let view = match build_view(&core.bundled, &doc, env!("CARGO_PKG_VERSION")) {
        Ok(v) => v,
        Err((c, m)) => return fail(c, m),
    };
    if active_jobs(core) {
        return CatalogSyncResult {
            checked_at,
            outcome: "skipped_active_jobs".into(),
            ..Default::default()
        };
    }
    let body_text = match String::from_utf8(body) {
        Ok(t) => t,
        Err(_) => return fail("schema", "registry is not UTF-8".into()),
    };
    let saved = core.db.conn().execute(
        "INSERT INTO catalog (id, version, body, sig, applied_at) VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET version=excluded.version, body=excluded.body, sig=excluded.sig, applied_at=excluded.applied_at",
        params![doc.version, body_text, sig.trim(), checked_at],
    );
    if let Err(e) = saved {
        return fail("schema", format!("could not store registry: {e}"));
    }
    let result = result_for(&view, checked_at, "updated");
    apply_view(core, view);
    refresh_upstream(core).await;
    set_meta(core, |m| {
        m.insert("lastSuccessAt".into(), json!(checked_at));
        m.insert("lastError".into(), Value::Null);
    });
    core.emit(StoreEvent::CatalogChanged);
    result
}

/// Sync on launch (after 10 s) and every 6 h while `catalogAutoSync` is on.
pub fn spawn_periodic(core: Arc<Core>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            if crate::settings::get(&core).catalog_auto_sync {
                let r = sync(&core).await;
                log::info!("catalog sync: {}", r.outcome);
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

/* ── Queries ───────────────────────────────────────────────────────────── */

pub fn status(core: &Core) -> CatalogStatus {
    let view = core.catalog.read().unwrap_or_else(|p| p.into_inner());
    let mut counts: BTreeMap<String, usize> = STATES.iter().map(|s| (s.to_string(), 0)).collect();
    for e in &view.entries {
        *counts.entry(e.state.clone()).or_default() += 1;
    }
    let m = meta(core);
    CatalogStatus {
        version: view.version.clone(),
        source: view.source.clone(),
        last_checked_at: m.get("lastCheckedAt").and_then(Value::as_i64),
        last_success_at: m.get("lastSuccessAt").and_then(Value::as_i64),
        last_error: m.get("lastError").and_then(Value::as_str).map(String::from),
        auto_sync: crate::settings::get(core).catalog_auto_sync,
        counts,
    }
}

pub fn list(core: &Core) -> Vec<CatalogEntry> {
    core.catalog
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .entries
        .iter()
        .map(|e| CatalogEntry {
            model: e.raw.clone(),
            state: e.state.clone(),
            executable: e.executable,
            reason: e.reason.clone(),
            registry_version: e.registry_version.clone(),
        })
        .collect()
}

/// Executable models only (what the generation form offers).
pub fn list_models(core: &Core) -> Vec<Value> {
    core.registry
        .read()
        .unwrap_or_else(|p| p.into_inner())
        .models
        .iter()
        .map(|m| m.raw.clone())
        .collect()
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
