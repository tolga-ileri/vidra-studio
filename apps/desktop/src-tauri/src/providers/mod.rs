//! Provider adapters. Base URLs are constants; tests inject mock endpoints
//! through `#[cfg(test)]` constructors only — release builds never read any
//! environment variable or setting to change them.

pub mod higgsfield;
pub mod kling;
pub mod replicate;

use crate::error::{AppError, AppResult, ErrorCode};
use crate::manifest::Model;
use crate::net::{read_json, Net};
use crate::secrets::Secret;
use crate::types::{CredentialField, ParamValues, ProviderCapabilities, ProviderId};
use async_trait::async_trait;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use url::Url;

pub type Creds = HashMap<String, Secret>;

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderEstimate {
    pub usd: Option<f64>,
    pub credits: Option<f64>,
    pub source: &'static str,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Submitted {
    pub request_id: String,
    pub poll_url: Option<String>,
    pub result_url: Option<String>,
    pub cancel_url: Option<String>,
}

/// What the poller needs to query a submitted job.
#[derive(Debug, Clone, Default)]
pub struct JobRef {
    pub request_id: String,
    pub poll_url: Option<String>,
    pub result_url: Option<String>,
    pub cancel_url: Option<String>,
    /// Endpoint path of the model (from the manifest).
    pub model_path: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RemoteStatus {
    Queued,
    Running,
    /// `result` is the JSON the model's `outputPath` is resolved against.
    Completed {
        result: Value,
        confirmed_usd: Option<f64>,
    },
    Failed {
        code: String,
        message: String,
    },
    Blocked {
        message: String,
    },
    Canceled,
}

#[derive(Debug, Clone)]
pub struct SubmitFailure {
    pub error: AppError,
    /// The request may have reached the provider (timeout, 5xx, broken connection).
    pub ambiguous: bool,
}

impl From<AppError> for SubmitFailure {
    fn from(error: AppError) -> Self {
        let ambiguous = error.code == ErrorCode::Network
            || error
                .details
                .as_ref()
                .and_then(|d| d.get("ambiguous"))
                .and_then(Value::as_bool)
                == Some(true);
        SubmitFailure { error, ambiguous }
    }
}

#[async_trait]
pub trait Provider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn capabilities(&self) -> ProviderCapabilities;
    fn credential_fields(&self) -> Vec<CredentialField>;
    fn docs_url(&self) -> &'static str;
    /// Checks credentials with the cheapest documented authenticated call.
    async fn validate(&self, creds: &Creds) -> AppResult<()>;
    /// Provider-side estimate; `Ok(None)` when the provider has none.
    async fn estimate(
        &self,
        creds: &Creds,
        model: &Model,
        values: &ParamValues,
        body: &Value,
    ) -> AppResult<Option<ProviderEstimate>>;
    /// Uploads a reference file and returns a URL usable as model input.
    async fn upload_reference(
        &self,
        creds: &Creds,
        bytes: Vec<u8>,
        mime: &str,
        name: &str,
    ) -> AppResult<String>;
    async fn submit(
        &self,
        creds: &Creds,
        model: &Model,
        body: &Value,
        idempotency_key: &str,
    ) -> Result<Submitted, SubmitFailure>;
    /// For providers with client tokens: find a job submitted with this key.
    async fn find_by_idempotency_key(
        &self,
        _creds: &Creds,
        _model: &Model,
        _key: &str,
    ) -> AppResult<Option<Submitted>> {
        Ok(None)
    }
    async fn status(&self, creds: &Creds, job: &JobRef) -> AppResult<RemoteStatus>;
    async fn cancel(&self, creds: &Creds, job: &JobRef) -> AppResult<()>;
    /// Official discovery: current upstream version id per model
    /// (`(model id, version)`); empty when the provider has no discovery API.
    async fn latest_versions(
        &self,
        _creds: &Creds,
        _models: &[Model],
    ) -> AppResult<Vec<(String, String)>> {
        Ok(vec![])
    }
    /// Output URLs from a completed result.
    fn outputs(&self, model: &Model, result: &Value) -> Vec<String> {
        crate::manifest::extract_outputs(result, &model.def.output_path)
    }
}

pub struct Providers {
    map: HashMap<ProviderId, Arc<dyn Provider>>,
}

impl Providers {
    pub fn new(net: Net) -> Self {
        #[cfg(feature = "e2e-mock")]
        if let Some(base) = crate::e2e::mock_base() {
            let mut map: HashMap<ProviderId, Arc<dyn Provider>> = HashMap::new();
            map.insert(
                ProviderId::Higgsfield,
                Arc::new(higgsfield::Higgsfield::with_base(
                    net.clone(),
                    &format!("{base}/higgsfield"),
                )),
            );
            map.insert(
                ProviderId::Replicate,
                Arc::new(replicate::Replicate::with_base(
                    net.clone(),
                    &format!("{base}/replicate"),
                )),
            );
            map.insert(
                ProviderId::Kling,
                Arc::new(kling::Kling::with_base(net, &format!("{base}/kling"))),
            );
            return Providers { map };
        }
        let mut map: HashMap<ProviderId, Arc<dyn Provider>> = HashMap::new();
        map.insert(
            ProviderId::Higgsfield,
            Arc::new(higgsfield::Higgsfield::new(net.clone())),
        );
        map.insert(
            ProviderId::Replicate,
            Arc::new(replicate::Replicate::new(net.clone())),
        );
        map.insert(ProviderId::Kling, Arc::new(kling::Kling::new(net)));
        Providers { map }
    }
    pub fn from_map(map: HashMap<ProviderId, Arc<dyn Provider>>) -> Self {
        Providers { map }
    }
    pub fn get(&self, id: ProviderId) -> Arc<dyn Provider> {
        self.map
            .get(&id)
            .cloned()
            .expect("all providers registered")
    }
}

/* ── Shared helpers ────────────────────────────────────────────────────── */

pub fn cred<'a>(creds: &'a Creds, key: &str) -> AppResult<&'a str> {
    creds
        .get(key)
        .map(|s| s.expose())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::new(
                ErrorCode::MissingCredentials,
                "Add your API credentials in Settings first.",
            )
        })
}

/// Extracts a short, safe message from a provider error body.
pub fn provider_message(body: &Value) -> Option<String> {
    let candidates = [
        body.get("detail").and_then(Value::as_str),
        body.get("detail")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|d| d.get("msg"))
            .and_then(Value::as_str),
        body.get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str),
        body.get("error").and_then(Value::as_str),
        body.get("message").and_then(Value::as_str),
        body.get("title").and_then(Value::as_str),
    ];
    candidates.into_iter().flatten().next().map(sanitize)
}

pub fn sanitize(s: &str) -> String {
    let clean: String = s.chars().filter(|c| !c.is_control()).take(300).collect();
    clean.trim().to_string()
}

/// Normalizes an HTTP error into the shared ErrorCode set.
pub fn map_http(status: StatusCode, body: &Value, provider: ProviderId) -> AppError {
    let msg = provider_message(body);
    let with = |code: ErrorCode, default: &str| {
        AppError::new(code, msg.clone().unwrap_or_else(|| default.to_string()))
    };
    let name = provider.display_name();
    match status.as_u16() {
        401 => AppError::new(
            ErrorCode::InvalidCredentials,
            format!("{name} rejected the credentials."),
        ),
        402 => with(
            ErrorCode::InsufficientCredits,
            "Your account has insufficient credits.",
        ),
        403 if provider == ProviderId::Higgsfield => with(
            ErrorCode::InsufficientCredits,
            "Your account has insufficient credits.",
        ),
        403 => with(
            ErrorCode::InvalidCredentials,
            "Access denied by the provider.",
        ),
        404 => with(ErrorCode::NotFound, "Not found at the provider."),
        400 | 413 | 422 => with(
            ErrorCode::InvalidInput,
            "The provider rejected the request.",
        ),
        429 => with(
            ErrorCode::RateLimited,
            "Rate limited by the provider. Try again shortly.",
        ),
        s if s >= 500 => with(
            ErrorCode::ProviderError,
            &format!("{name} returned a server error ({s})."),
        )
        .with_details(json!({"ambiguous": true})),
        s => with(
            ErrorCode::ProviderError,
            &format!("{name} returned HTTP {s}."),
        ),
    }
}

/// Checks that a provider-returned URL has the same origin as the base.
pub fn same_origin(url: &str, base: &str) -> Option<String> {
    let u = Url::parse(url).ok()?;
    let b = Url::parse(base).ok()?;
    (u.scheme() == b.scheme()
        && u.host() == b.host()
        && u.port_or_known_default() == b.port_or_known_default()
        && u.username().is_empty())
    .then(|| u.to_string())
}

pub fn num_or_string(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|f: &f64| f.is_finite() && *f >= 0.0)
}

/// Sends a JSON API request, returning (status, body).
pub async fn api_json(
    net: &Net,
    method: Method,
    url: &str,
    auth: &str,
    body: Option<&Value>,
    extra: &[(&str, &str)],
) -> AppResult<(StatusCode, Value)> {
    let mut req = net
        .api
        .request(method, url)
        .header("Authorization", auth)
        .header("Accept", "application/json");
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req.send().await.map_err(crate::net::map_reqwest)?;
    if resp.status().is_redirection() {
        return Err(AppError::provider("Unexpected redirect from the provider."));
    }
    read_json(resp).await
}

/// PUT bytes to a provider-issued presigned URL (no provider credentials).
pub async fn put_presigned(
    net: &Net,
    url: &str,
    bytes: Vec<u8>,
    headers: &[(String, String)],
) -> AppResult<()> {
    let body = bytes;
    let resp = net
        .external(Method::PUT, url, |mut r| {
            for (k, v) in headers {
                r = r.header(k.as_str(), v.as_str());
            }
            r.body(body.clone())
        })
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::provider(format!(
            "Upload failed (HTTP {}).",
            resp.status().as_u16()
        )));
    }
    Ok(())
}

pub fn json_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

pub fn is_safety_message(m: &str) -> bool {
    let m = m.to_ascii_lowercase();
    [
        "nsfw",
        "content policy",
        "content_policy",
        "safety",
        "sensitive",
        "moderation",
        "flagged",
    ]
    .iter()
    .any(|k| m.contains(k))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    pub fn creds(pairs: &[(&str, &str)]) -> Creds {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), Secret::new(*v)))
            .collect()
    }
    pub fn model(
        provider: &str,
        provider_model_id: &str,
        path: Option<&str>,
        output_path: &str,
    ) -> Model {
        // Fresh verified rate ($0.10/s); Higgsfield uses its estimate API.
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let pricing = if provider == "higgsfield" {
            json!({"status": "provider_estimate", "currency": "USD", "source": null, "pricingPageUrl": null, "verifiedAt": null})
        } else {
            json!({"status": "verified", "currency": "USD", "formula": {"kind": "per_second", "rate": 0.1},
                   "source": "https://example.com/pricing", "pricingPageUrl": null, "verifiedAt": today})
        };
        let raw = json!({
            "id": format!("{provider}:{provider_model_id}"), "provider": provider, "providerModelId": provider_model_id,
            "displayName": "Test", "family": "t", "workflow": "text-to-video", "output": "video",
            "prompt": {"apiField": "prompt", "required": true, "maxLength": 1000},
            "params": [{"key":"duration","apiField":"duration","label":{"en":"Duration","tr":"Süre"},"type":"integer","min":1,"max":20,"default":5}],
            "request": {"path": path, "fixed": {}},
            "outputPath": output_path,
            "pricing": pricing,
            "docsUrl": "https://example.com", "lastVerified": "2026-10-11"
        });
        let mut raw = raw;
        if path.is_none() {
            raw["request"] = json!({"fixed": {}});
        }
        Model {
            def: crate::manifest::parse_model(&raw, ProviderId::parse(provider).unwrap()).unwrap(),
            raw,
        }
    }
    /// Re-parses a model after its `raw` JSON was edited in a test.
    pub fn reparse(m: Model) -> Model {
        let def = crate::manifest::parse_model(&m.raw, m.def.provider).unwrap();
        Model { def, raw: m.raw }
    }
}
