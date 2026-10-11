use super::*;
use crate::core::testing::*;
use crate::error::ErrorCode;
use crate::providers::test_support::model;
use ed25519_dalek::{Signer, SigningKey};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const VECTORS: &str = include_str!("../../../../packages/core/test/vectors/capabilities.json");

fn key() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn vector_model(id_suffix: &str) -> Value {
    let mut m = serde_json::from_str::<Value>(VECTORS).unwrap()["model"].clone();
    m["id"] = json!(format!("replicate:vectors/{id_suffix}"));
    m["providerModelId"] = json!(format!("vectors/{id_suffix}"));
    m
}

fn doc(version: &str, min_app: &str, models: Vec<Value>) -> Value {
    json!({
        "format": "vidra.registry", "formatVersion": 1, "version": version,
        "generatedAt": "2026-10-11T00:00:00Z", "minAppVersion": min_app, "manifestFormatVersion": 2,
        "providers": {"replicate": {"format": "vidra.models", "formatVersion": 2, "provider": "replicate",
            "version": "2026.10.11", "source": "registry", "models": models}},
        "discontinued": []
    })
}

fn signed(d: &Value, k: &SigningKey) -> (Vec<u8>, String) {
    let body = serde_json::to_vec_pretty(d).unwrap();
    let sig = base64::engine::general_purpose::STANDARD.encode(k.sign(&body).to_bytes());
    (body, sig)
}

async fn serve(body: Vec<u8>, sig: String) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/catalog.json"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/catalog.json.sig"))
        .respond_with(ResponseTemplate::new(200).set_body_string(sig))
        .mount(&s)
        .await;
    s
}

fn env_for(s: &MockServer) -> TestEnv {
    let bundled = Registry::from_models(vec![model("replicate", "owner/t2v", None, "output")]);
    let e = env_with(None, bundled, None);
    set_source(&e.core, &s.uri(), key().verifying_key().to_bytes());
    e
}

async fn sync_with(d: &Value) -> (TestEnv, CatalogSyncResult, MockServer) {
    let (b, sig) = signed(d, &key());
    let s = serve(b, sig).await;
    let e = env_for(&s);
    let r = sync(&e.core).await;
    (e, r, s)
}

#[tokio::test]
async fn valid_signed_registry_adds_models_and_persists() {
    let (e, r, _s) = sync_with(&doc("2026.10.11.5", "0.1.0", vec![vector_model("a")])).await;
    assert_eq!(r.outcome, "updated", "{r:?}");
    assert_eq!(r.added, vec!["replicate:vectors/a"]);
    assert!(e.core.model("replicate:vectors/a").is_ok());
    assert_eq!(list_models(&e.core).len(), 2);
    let st = status(&e.core);
    assert_eq!(
        (st.source.as_str(), st.counts["new"], st.counts["bundled"]),
        ("registry", 1, 1)
    );
    assert!(st.last_success_at.is_some());
    // restart: the last-known-good registry is re-verified and applied
    let TestEnv { dir, core, .. } = e;
    let bundled = core.bundled.clone();
    drop(core);
    let db = crate::db::Db::open(&dir.path().join("vidra.sqlite3")).unwrap();
    let e2 = reopen(dir, db, None, Registry::from_models(bundled), None);
    set_source(
        &e2.core,
        "http://127.0.0.1:9",
        key().verifying_key().to_bytes(),
    );
    load_stored(&e2.core);
    assert!(e2.core.model("replicate:vectors/a").is_ok());
    // same version again → up_to_date; offline → failed, last-known-good kept
    let r = sync(&e2.core).await;
    assert_eq!(
        (r.outcome.as_str(), r.error.as_deref()),
        ("failed", Some("network"))
    );
    assert!(e2.core.model("replicate:vectors/a").is_ok());
    assert_eq!(status(&e2.core).last_error.as_deref(), Some("network"));
}

#[tokio::test]
async fn bad_signature_and_tampered_body_are_rejected() {
    let d = doc("2026.10.11.5", "0.1.0", vec![vector_model("a")]);
    let (body, _) = signed(&d, &key());
    let (_, other_sig) = signed(&d, &SigningKey::from_bytes(&[9u8; 32]));
    let s = serve(body.clone(), other_sig).await;
    let e = env_for(&s);
    let r = sync(&e.core).await;
    assert_eq!(r.error.as_deref(), Some("signature"));
    assert!(e.core.model("replicate:vectors/a").is_err());

    let (_, sig) = signed(&d, &key());
    let mut tampered = body;
    let pos = tampered.iter().position(|b| *b == b'0').unwrap();
    tampered[pos] = b'9';
    let s = serve(tampered, sig).await;
    let e = env_for(&s);
    assert_eq!(sync(&e.core).await.error.as_deref(), Some("signature"));
}

#[tokio::test]
async fn wrong_format_and_invalid_manifest_reject_everything() {
    let mut d = doc("2026.10.11.5", "0.1.0", vec![vector_model("a")]);
    d["manifestFormatVersion"] = json!(3);
    let (_, r, _s) = sync_with(&d).await;
    assert_eq!(r.error.as_deref(), Some("compatibility"));
    let mut d = doc("2026.10.11.5", "0.1.0", vec![vector_model("a")]);
    d["format"] = json!("other");
    assert_eq!(sync_with(&d).await.1.error.as_deref(), Some("schema"));
    let mut bad = vector_model("b");
    bad["capabilities"]["maxDurationSec"] = json!(99);
    let (e, r, _s) = sync_with(&doc("2026.10.11.5", "0.1.0", vec![vector_model("a"), bad])).await;
    assert_eq!(r.error.as_deref(), Some("schema"));
    assert!(
        e.core.model("replicate:vectors/a").is_err(),
        "whole registry rejected"
    );
}

#[tokio::test]
async fn downgrade_and_replay_are_refused() {
    let (e, r, _s) = sync_with(&doc("2026.10.11.5", "0.1.0", vec![vector_model("a")])).await;
    assert_eq!(r.outcome, "updated");
    for (v, outcome, err) in [
        ("2026.10.11.5", "up_to_date", None),
        ("2026.10.11.4", "failed", Some("downgrade")),
    ] {
        let (b, sig) = signed(&doc(v, "0.1.0", vec![]), &key());
        let s = serve(b, sig).await;
        set_source(&e.core, &s.uri(), key().verifying_key().to_bytes());
        let r = sync(&e.core).await;
        assert_eq!(
            (r.outcome.as_str(), r.error.as_deref()),
            (outcome, err),
            "{v}"
        );
        assert!(e.core.model("replicate:vectors/a").is_ok());
    }
}

#[tokio::test]
async fn too_new_or_unknown_vocabulary_means_update_required() {
    let (e, r, _s) = sync_with(&doc("2026.10.11.5", "99.0.0", vec![vector_model("a")])).await;
    assert_eq!(r.outcome, "updated");
    assert_eq!(r.update_required, vec!["replicate:vectors/a"]);
    let err = e.core.model("replicate:vectors/a").unwrap_err();
    assert_eq!(err.code, ErrorCode::UpdateRequired);
    assert_eq!(
        list_models(&e.core).len(),
        1,
        "bundled model stays executable"
    );

    let mut unknown = vector_model("u");
    unknown["params"][0]["type"] = json!("color_picker");
    let (e, r, _s) = sync_with(&doc(
        "2026.10.11.5",
        "0.1.0",
        vec![vector_model("a"), unknown],
    ))
    .await;
    assert_eq!(r.outcome, "updated");
    assert_eq!(r.update_required, vec!["replicate:vectors/u"]);
    let entry = list(&e.core)
        .into_iter()
        .find(|x| x.state == "update_required")
        .unwrap();
    assert_eq!(entry.reason.as_deref(), Some("unknown_param_type"));
    assert!(!entry.executable);
    assert!(e.core.model("replicate:vectors/a").is_ok());
}

#[tokio::test]
async fn discontinued_models_are_not_executable() {
    let mut d = doc("2026.10.11.5", "0.1.0", vec![vector_model("a")]);
    d["discontinued"] = json!(["replicate:owner/t2v"]);
    let (e, r, _s) = sync_with(&d).await;
    assert_eq!(r.discontinued, vec!["replicate:owner/t2v"]);
    assert_eq!(
        e.core.model("replicate:owner/t2v").unwrap_err().code,
        ErrorCode::ModelUnavailable
    );
    assert!(e.core.model_for_job("replicate:owner/t2v").is_some());
}

#[tokio::test]
async fn sync_is_skipped_while_jobs_are_active() {
    let (b, sig) = signed(
        &doc("2026.10.11.5", "0.1.0", vec![vector_model("a")]),
        &key(),
    );
    let s = serve(b, sig).await;
    let e = env_for(&s);
    let mut j = crate::budget::tests_support_job();
    j.status = JobStatus::Generating;
    crate::jobs::insert_job(&e.core, &j, "active").unwrap();
    let r = sync(&e.core).await;
    assert_eq!(r.outcome, "skipped_active_jobs");
    assert!(e.core.model("replicate:vectors/a").is_err());
    assert!(
        s.received_requests().await.unwrap().is_empty(),
        "nothing fetched"
    );
}

#[tokio::test]
async fn replicate_upstream_change_is_flagged_not_applied() {
    let s = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/models/owner/t2v"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"latest_version": {"id": "v2"}})),
        )
        .mount(&s)
        .await;
    let mut m = model("replicate", "owner/t2v", None, "output");
    m.raw["schemaVersion"] = json!("v1");
    let m = crate::providers::test_support::reparse(m);
    let mut map: std::collections::HashMap<
        ProviderId,
        std::sync::Arc<dyn crate::providers::Provider>,
    > = Default::default();
    map.insert(
        ProviderId::Replicate,
        std::sync::Arc::new(crate::providers::replicate::Replicate::with_base(
            crate::net::Net::for_tests(),
            &s.uri(),
        )),
    );
    let e = env_with(
        Some(crate::providers::Providers::from_map(map)),
        Registry::from_models(vec![m]),
        None,
    );
    use crate::secrets::SecretStore;
    e.secrets.set("replicate:api_token", "tok").unwrap();
    refresh_upstream(&e.core).await;
    let entry = list(&e.core).pop().unwrap();
    assert_eq!(entry.reason.as_deref(), Some("upstream_schema_changed"));
    assert!(
        entry.executable,
        "parameters are never changed automatically"
    );
}

/// The committed registry verifies with the embedded key and every model in
/// it is executable by this build.
#[test]
fn committed_registry_is_signed_and_executable() {
    let body = include_bytes!("../../../../registry/v1/catalog.json");
    let sig = include_str!("../../../../registry/v1/catalog.json.sig");
    verify_signature(body, sig, &embedded_public_key()).expect("committed registry signature");
    let doc = parse_registry(body).unwrap_or_else(|(c, m)| panic!("{c}: {m}"));
    let bundled = Registry::bundled().models;
    let view = build_view(&bundled, &doc, env!("CARGO_PKG_VERSION"))
        .unwrap_or_else(|(c, m)| panic!("{c}: {m}"));
    let blocked: Vec<_> = view
        .entries
        .iter()
        .filter(|e| !e.executable || e.reason.is_some())
        .map(|e| format!("{}: {} {:?}", e.id, e.state, e.reason))
        .collect();
    assert!(blocked.is_empty(), "{blocked:#?}");
    let total: usize = doc
        .providers
        .values()
        .map(|p| p["models"].as_array().unwrap().len())
        .sum();
    assert_eq!(view.entries.len(), total.max(bundled.len()));
}
