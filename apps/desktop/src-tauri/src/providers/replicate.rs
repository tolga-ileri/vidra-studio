//! Replicate HTTP API (docs/providers/replicate.md). `Bearer` auth, official
//! model predictions, `POST /files` uploads, no idempotent submit. Outputs are
//! deleted after ~1 h, so jobs always download immediately.

use super::*;

pub const BASE: &str = "https://api.replicate.com/v1";

pub struct Replicate {
    net: Net,
    base: String,
}

impl Replicate {
    pub fn new(net: Net) -> Self {
        Replicate {
            net,
            base: BASE.into(),
        }
    }
    #[cfg(any(test, feature = "e2e-mock"))]
    pub fn with_base(net: Net, base: &str) -> Self {
        Replicate {
            net,
            base: base.trim_end_matches('/').to_string(),
        }
    }
    fn auth(creds: &Creds) -> AppResult<String> {
        Ok(format!("Bearer {}", cred(creds, "api_token")?))
    }
    fn slug(path: &str) -> &str {
        path.split('#').next().unwrap_or(path)
    }

    /// Fetches the official model object (schema); used for sync.
    pub async fn model_info(&self, creds: &Creds, slug: &str) -> AppResult<Value> {
        let auth = Self::auth(creds)?;
        let (status, resp) = api_json(
            &self.net,
            Method::GET,
            &format!("{}/models/{}", self.base, Self::slug(slug)),
            &auth,
            None,
            &[],
        )
        .await?;
        if !status.is_success() {
            return Err(map_http(status, &resp, ProviderId::Replicate));
        }
        Ok(resp)
    }
}

#[async_trait]
impl Provider for Replicate {
    fn id(&self) -> ProviderId {
        ProviderId::Replicate
    }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            validate_credentials: true,
            model_discovery: true,
            estimate_cost: true,
            upload_references: true,
            cancel: true,
            idempotent_submit: false,
        }
    }
    fn credential_fields(&self) -> Vec<CredentialField> {
        vec![CredentialField {
            key: "api_token".into(),
            label: "API token".into(),
            secret: true,
        }]
    }
    fn docs_url(&self) -> &'static str {
        "https://replicate.com/docs/reference/http"
    }

    async fn validate(&self, creds: &Creds) -> AppResult<()> {
        let auth = Self::auth(creds)?;
        let (status, resp) = api_json(
            &self.net,
            Method::GET,
            &format!("{}/account", self.base),
            &auth,
            None,
            &[],
        )
        .await?;
        if status.is_success() {
            Ok(())
        } else {
            Err(map_http(status, &resp, self.id()))
        }
    }

    async fn estimate(
        &self,
        _: &Creds,
        _: &Model,
        _: &ParamValues,
        _: &Value,
    ) -> AppResult<Option<ProviderEstimate>> {
        Ok(None) // no pricing API; the manifest's published rate is used
    }

    async fn upload_reference(
        &self,
        creds: &Creds,
        bytes: Vec<u8>,
        mime: &str,
        name: &str,
    ) -> AppResult<String> {
        let auth = Self::auth(creds)?;
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(name.to_string())
            .mime_str(mime)
            .map_err(|_| AppError::invalid("Unsupported file type."))?;
        let form = reqwest::multipart::Form::new()
            .part("content", part)
            .text("type", mime.to_string());
        let resp = self
            .net
            .api
            .post(format!("{}/files", self.base))
            .header("Authorization", auth)
            .multipart(form)
            .send()
            .await
            .map_err(crate::net::map_reqwest)?;
        let (status, body) = read_json(resp).await?;
        if !status.is_success() {
            return Err(map_http(status, &body, self.id()));
        }
        body.get("urls")
            .and_then(|u| u.get("get"))
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| AppError::provider("Upload URL missing."))
    }

    async fn submit(
        &self,
        creds: &Creds,
        model: &Model,
        body: &Value,
        _key: &str,
    ) -> Result<Submitted, SubmitFailure> {
        let auth = Self::auth(creds)?;
        let url = format!(
            "{}/models/{}/predictions",
            self.base,
            Self::slug(model.path())
        );
        let (status, resp) = api_json(
            &self.net,
            Method::POST,
            &url,
            &auth,
            Some(&json!({ "input": body })),
            &[],
        )
        .await?;
        if !status.is_success() {
            return Err(map_http(status, &resp, self.id()).into());
        }
        let id = json_str(&resp, "id").ok_or_else(|| SubmitFailure {
            error: AppError::provider("The provider response had no prediction id."),
            ambiguous: true,
        })?;
        Ok(Submitted {
            request_id: id,
            ..Default::default()
        })
    }

    async fn status(&self, creds: &Creds, job: &JobRef) -> AppResult<RemoteStatus> {
        let auth = Self::auth(creds)?;
        let url = format!("{}/predictions/{}", self.base, urlencode(&job.request_id));
        let (status, resp) = api_json(&self.net, Method::GET, &url, &auth, None, &[]).await?;
        if !status.is_success() {
            return Err(map_http(status, &resp, self.id()));
        }
        Ok(
            match resp.get("status").and_then(Value::as_str).unwrap_or("") {
                "starting" => RemoteStatus::Queued,
                "processing" => RemoteStatus::Running,
                "succeeded" => {
                    if resp.get("data_removed").and_then(Value::as_bool) == Some(true) {
                        RemoteStatus::Failed {
                            code: "expired".into(),
                            message: "The provider already deleted the outputs.".into(),
                        }
                    } else {
                        RemoteStatus::Completed {
                            result: resp.clone(),
                            confirmed_usd: None,
                        }
                    }
                }
                "failed" => {
                    let msg = resp
                        .get("error")
                        .and_then(Value::as_str)
                        .map(sanitize)
                        .unwrap_or_else(|| "Prediction failed.".into());
                    if is_safety_message(&msg) {
                        RemoteStatus::Blocked { message: msg }
                    } else {
                        RemoteStatus::Failed {
                            code: "provider_error".into(),
                            message: msg,
                        }
                    }
                }
                "canceled" | "aborted" => RemoteStatus::Canceled,
                _ => RemoteStatus::Running,
            },
        )
    }

    async fn latest_versions(
        &self,
        creds: &Creds,
        models: &[Model],
    ) -> AppResult<Vec<(String, String)>> {
        let mut out = Vec::new();
        for m in models {
            let slug = Self::slug(m.path()).to_string();
            match self.model_info(creds, &slug).await {
                Ok(info) => {
                    if let Some(v) = info
                        .get("latest_version")
                        .and_then(|v| v.get("id"))
                        .and_then(Value::as_str)
                    {
                        out.push((m.def.id.clone(), v.to_string()));
                    }
                }
                Err(e) if e.code == ErrorCode::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    async fn cancel(&self, creds: &Creds, job: &JobRef) -> AppResult<()> {
        let auth = Self::auth(creds)?;
        let url = format!(
            "{}/predictions/{}/cancel",
            self.base,
            urlencode(&job.request_id)
        );
        let (status, resp) = api_json(&self.net, Method::POST, &url, &auth, None, &[]).await?;
        if !status.is_success() {
            return Err(map_http(status, &resp, self.id()));
        }
        match resp.get("status").and_then(Value::as_str) {
            Some("succeeded") | Some("failed") => Err(AppError::new(
                ErrorCode::CancelTooLate,
                "The prediction already finished.",
            )),
            _ => Ok(()),
        }
    }
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn c() -> Creds {
        creds(&[("api_token", "r8_tok")])
    }

    #[tokio::test]
    async fn lifecycle() {
        let s = MockServer::start().await;
        let m = model(
            "replicate",
            "google/veo-3#image-to-video",
            Some("google/veo-3"),
            "output",
        );
        Mock::given(method("POST"))
            .and(path("/models/google/veo-3/predictions"))
            .and(header("authorization", "Bearer r8_tok"))
            .and(body_json(json!({"input": {"prompt": "x"}})))
            .respond_with(
                ResponseTemplate::new(201).set_body_json(json!({"id": "p1", "status": "starting"})),
            )
            .mount(&s)
            .await;
        Mock::given(path("/predictions/p1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"status": "succeeded", "output": "https://replicate.delivery/o.mp4"}),
            ))
            .mount(&s)
            .await;
        Mock::given(path("/predictions/p2"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"status": "failed", "error": "CUDA error"})),
            )
            .mount(&s)
            .await;
        Mock::given(path("/predictions/p3"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"status": "failed", "error": "NSFW content detected"})),
            )
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/predictions/p1/cancel"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "succeeded"})))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/predictions/p4/cancel"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "canceled"})))
            .mount(&s)
            .await;
        Mock::given(path("/account"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&s)
            .await;
        let p = Replicate::with_base(Net::for_tests(), &s.uri());
        let sub = p
            .submit(&c(), &m, &json!({"prompt": "x"}), "k")
            .await
            .unwrap();
        assert_eq!(sub.request_id, "p1");
        let jr = |id: &str| JobRef {
            request_id: id.into(),
            ..Default::default()
        };
        match p.status(&c(), &jr("p1")).await.unwrap() {
            RemoteStatus::Completed { result, .. } => assert_eq!(
                p.outputs(&m, &result),
                vec!["https://replicate.delivery/o.mp4"]
            ),
            o => panic!("{o:?}"),
        }
        assert!(matches!(
            p.status(&c(), &jr("p2")).await.unwrap(),
            RemoteStatus::Failed { .. }
        ));
        assert!(matches!(
            p.status(&c(), &jr("p3")).await.unwrap(),
            RemoteStatus::Blocked { .. }
        ));
        assert_eq!(
            p.cancel(&c(), &jr("p1")).await.unwrap_err().code,
            ErrorCode::CancelTooLate
        );
        p.cancel(&c(), &jr("p4")).await.unwrap();
        assert_eq!(
            p.validate(&c()).await.unwrap_err().code,
            ErrorCode::InvalidCredentials
        );
    }

    #[tokio::test]
    async fn upload_multipart() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/files"))
            .respond_with(ResponseTemplate::new(201).set_body_json(
                json!({"id": "f", "urls": {"get": "https://api.replicate.com/v1/files/f"}}),
            ))
            .mount(&s)
            .await;
        let p = Replicate::with_base(Net::for_tests(), &s.uri());
        let u = p
            .upload_reference(&c(), vec![0x89, b'P'], "image/png", "a.png")
            .await
            .unwrap();
        assert_eq!(u, "https://api.replicate.com/v1/files/f");
    }
}
