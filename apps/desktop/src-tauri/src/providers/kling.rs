//! Kling AI official API (docs/providers/kling.md), new design with API key:
//! `Bearer <api key>`, model-in-path routes, statuses submitted / processing /
//! succeeded / failed, `GET /tasks?task_ids=` polling. Image generation uses
//! the legacy `/v1/images/generations` route (statuses `succeed`). No cancel.
//! Output paths are resolved relative to the task (`data`) object.

use super::*;

pub const BASE: &str = "https://api-singapore.klingai.com";

pub struct Kling {
    net: Net,
    base: String,
}

impl Kling {
    pub fn new(net: Net) -> Self {
        Kling {
            net,
            base: BASE.into(),
        }
    }
    #[cfg(any(test, feature = "e2e-mock"))]
    pub fn with_base(net: Net, base: &str) -> Self {
        Kling {
            net,
            base: base.trim_end_matches('/').to_string(),
        }
    }
    fn auth(creds: &Creds) -> AppResult<String> {
        Ok(format!("Bearer {}", cred(creds, "api_key")?))
    }
    fn legacy(path: &str) -> bool {
        path.starts_with("v1/")
    }

    /// Maps the `{code, message}` envelope (HTTP status may be 200 with code != 0).
    fn envelope_error(status: StatusCode, body: &Value) -> Option<AppError> {
        let code = body.get("code").and_then(Value::as_i64).unwrap_or(0);
        if status.is_success() && code == 0 {
            return None;
        }
        let msg = body.get("message").and_then(Value::as_str).map(sanitize);
        let m = |d: &str| msg.clone().unwrap_or_else(|| d.to_string());
        Some(match code {
            1000..=1004 => AppError::new(
                ErrorCode::InvalidCredentials,
                "Kling AI rejected the API key.",
            ),
            1101 | 1102 => AppError::new(
                ErrorCode::InsufficientCredits,
                m("Your Kling resource pack is exhausted or expired."),
            ),
            1100 | 1103 => AppError::new(
                ErrorCode::InvalidCredentials,
                m("The account has no access to this API or model."),
            ),
            1200 | 1201 => {
                AppError::new(ErrorCode::InvalidInput, m("Kling rejected the parameters."))
            }
            1202 | 1203 => AppError::new(ErrorCode::NotFound, m("Model or resource not found.")),
            1300 | 1301 => AppError::new(
                ErrorCode::InvalidInput,
                m("Rejected by the content safety policy."),
            )
            .with_details(json!({"blocked": true})),
            1302..=1304 => AppError::new(
                ErrorCode::RateLimited,
                m("Rate or concurrency limit reached."),
            ),
            5000..=5002 => AppError::new(ErrorCode::ProviderError, m("Kling AI server error."))
                .with_details(json!({"ambiguous": true})),
            _ => map_http(
                if status.is_success() {
                    StatusCode::BAD_GATEWAY
                } else {
                    status
                },
                body,
                ProviderId::Kling,
            ),
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        auth: &str,
        body: Option<&Value>,
    ) -> AppResult<Value> {
        let url = format!("{}/{}", self.base, path.trim_start_matches('/'));
        let (status, resp) = api_json(&self.net, method, &url, auth, body, &[]).await?;
        if let Some(e) = Self::envelope_error(status, &resp) {
            return Err(e);
        }
        Ok(resp.get("data").cloned().unwrap_or(Value::Null))
    }

    fn task_list(data: &Value) -> Vec<Value> {
        match data {
            Value::Array(a) => a.clone(),
            Value::Object(o) => o
                .get("result")
                .or_else(|| o.get("tasks"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| vec![data.clone()]),
            _ => vec![],
        }
    }

    fn status_of(task: &Value) -> RemoteStatus {
        let st = task
            .get("status")
            .or_else(|| task.get("task_status"))
            .and_then(Value::as_str)
            .unwrap_or("");
        match st {
            "submitted" => RemoteStatus::Queued,
            "processing" => RemoteStatus::Running,
            "succeeded" | "succeed" => RemoteStatus::Completed {
                result: task.clone(),
                confirmed_usd: None,
            },
            "failed" => {
                let msg = task
                    .get("message")
                    .or_else(|| task.get("task_status_msg"))
                    .and_then(Value::as_str)
                    .map(sanitize)
                    .unwrap_or_else(|| "Generation failed.".into());
                if is_safety_message(&msg) || msg.to_ascii_lowercase().contains("risk") {
                    RemoteStatus::Blocked { message: msg }
                } else {
                    RemoteStatus::Failed {
                        code: "provider_error".into(),
                        message: msg,
                    }
                }
            }
            _ => RemoteStatus::Running,
        }
    }
}

#[async_trait]
impl Provider for Kling {
    fn id(&self) -> ProviderId {
        ProviderId::Kling
    }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            validate_credentials: true,
            model_discovery: false,
            estimate_cost: false,
            // No upload API: references are sent inline as base64 (see
            // references::store_inline / resolve_inline).
            upload_references: true,
            cancel: false,
            idempotent_submit: true,
        }
    }
    fn credential_fields(&self) -> Vec<CredentialField> {
        vec![CredentialField {
            key: "api_key".into(),
            label: "API key".into(),
            secret: true,
        }]
    }
    fn docs_url(&self) -> &'static str {
        "https://kling.ai/document-api/api/get-started/authentication.md"
    }

    async fn validate(&self, creds: &Creds) -> AppResult<()> {
        let auth = Self::auth(creds)?;
        let end = crate::types::now_ms();
        let start = end - 24 * 3600 * 1000;
        self.call(
            Method::GET,
            &format!("account/costs?start_time={start}&end_time={end}"),
            &auth,
            None,
        )
        .await
        .map(|_| ())
    }

    async fn estimate(
        &self,
        _: &Creds,
        _: &Model,
        _: &ParamValues,
        _: &Value,
    ) -> AppResult<Option<ProviderEstimate>> {
        Ok(None)
    }

    async fn upload_reference(&self, _: &Creds, _: Vec<u8>, _: &str, _: &str) -> AppResult<String> {
        Err(AppError::invalid(
            "Kling AI has no file upload API; use a public https image URL.",
        ))
    }

    async fn submit(
        &self,
        creds: &Creds,
        model: &Model,
        body: &Value,
        key: &str,
    ) -> Result<Submitted, SubmitFailure> {
        let auth = Self::auth(creds)?;
        let mut body = body.clone();
        let path = model.path().to_string();
        if let Some(obj) = body.as_object_mut() {
            if Self::legacy(&path) {
                obj.insert("external_task_id".into(), json!(key));
            } else {
                let opts = obj.entry("options").or_insert_with(|| json!({}));
                if let Some(o) = opts.as_object_mut() {
                    o.insert("external_task_id".into(), json!(key));
                }
            }
        }
        let data = self.call(Method::POST, &path, &auth, Some(&body)).await?;
        let id = data
            .get("id")
            .or_else(|| data.get("task_id"))
            .and_then(|v| {
                v.as_str()
                    .map(String::from)
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            })
            .ok_or_else(|| SubmitFailure {
                error: AppError::provider("The provider response had no task id."),
                ambiguous: true,
            })?;
        Ok(Submitted {
            request_id: id,
            ..Default::default()
        })
    }

    async fn find_by_idempotency_key(
        &self,
        creds: &Creds,
        model: &Model,
        key: &str,
    ) -> AppResult<Option<Submitted>> {
        if Self::legacy(model.path()) {
            return Ok(None); // the legacy image API has no documented lookup by external id
        }
        let auth = Self::auth(creds)?;
        let data = self
            .call(
                Method::GET,
                &format!("tasks?external_task_ids={}", urlenc(key)),
                &auth,
                None,
            )
            .await?;
        Ok(Self::task_list(&data).into_iter().find_map(|t| {
            t.get("id").and_then(Value::as_str).map(|id| Submitted {
                request_id: id.into(),
                ..Default::default()
            })
        }))
    }

    async fn status(&self, creds: &Creds, job: &JobRef) -> AppResult<RemoteStatus> {
        let auth = Self::auth(creds)?;
        if Self::legacy(&job.model_path) {
            let path = format!(
                "{}/{}",
                job.model_path.trim_end_matches('/'),
                urlenc(&job.request_id)
            );
            let data = self.call(Method::GET, &path, &auth, None).await?;
            return Ok(Self::status_of(&data));
        }
        let data = self
            .call(
                Method::GET,
                &format!("tasks?task_ids={}", urlenc(&job.request_id)),
                &auth,
                None,
            )
            .await?;
        let task = Self::task_list(&data)
            .into_iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(job.request_id.as_str()))
            .ok_or_else(|| AppError::not_found("Task not found at Kling AI."))?;
        Ok(Self::status_of(&task))
    }

    async fn cancel(&self, _: &Creds, _: &JobRef) -> AppResult<()> {
        Err(AppError::new(
            ErrorCode::CancelUnsupported,
            "Kling AI does not support canceling a task.",
        ))
    }
}

fn urlenc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn c() -> Creds {
        creds(&[("api_key", "kk")])
    }

    #[tokio::test]
    async fn new_api_lifecycle() {
        let s = MockServer::start().await;
        let m = model(
            "kling",
            "text-to-video/kling-3.0",
            Some("text-to-video/kling-3.0"),
            "outputs[].url",
        );
        Mock::given(method("POST"))
            .and(path("/text-to-video/kling-3.0"))
            .and(header("authorization", "Bearer kk"))
            .and(body_partial_json(
                json!({"options": {"external_task_id": "ext-1"}}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"code": 0, "message": "ok", "data": {"id": "t1", "status": "submitted"}}),
            ))
            .mount(&s)
            .await;
        Mock::given(path("/tasks"))
            .and(query_param("task_ids", "t1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": [{"id": "t1", "status": "succeeded", "outputs": [{"type": "video", "url": "https://cdn.klingai.com/v.mp4"}]}]})))
            .mount(&s)
            .await;
        Mock::given(path("/tasks"))
            .and(query_param("task_ids", "t2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": [{"id": "t2", "status": "failed", "message": "internal"}]})))
            .mount(&s)
            .await;
        Mock::given(path("/tasks"))
            .and(query_param("external_task_ids", "ext-1"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    json!({"code": 0, "data": [{"id": "t1", "status": "processing"}]}),
                ),
            )
            .mount(&s)
            .await;
        Mock::given(path("/account/costs"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(json!({"code": 1002, "message": "invalid"})),
            )
            .mount(&s)
            .await;
        let p = Kling::with_base(Net::for_tests(), &s.uri());
        let sub = p
            .submit(&c(), &m, &json!({"prompt": "x"}), "ext-1")
            .await
            .unwrap();
        assert_eq!(sub.request_id, "t1");
        let jr = |id: &str| JobRef {
            request_id: id.into(),
            model_path: "text-to-video/kling-3.0".into(),
            ..Default::default()
        };
        match p.status(&c(), &jr("t1")).await.unwrap() {
            RemoteStatus::Completed { result, .. } => assert_eq!(
                p.outputs(&m, &result),
                vec!["https://cdn.klingai.com/v.mp4"]
            ),
            o => panic!("{o:?}"),
        }
        assert!(matches!(
            p.status(&c(), &jr("t2")).await.unwrap(),
            RemoteStatus::Failed { .. }
        ));
        assert_eq!(
            p.find_by_idempotency_key(&c(), &m, "ext-1")
                .await
                .unwrap()
                .unwrap()
                .request_id,
            "t1"
        );
        assert_eq!(
            p.cancel(&c(), &jr("t1")).await.unwrap_err().code,
            ErrorCode::CancelUnsupported
        );
        assert_eq!(
            p.validate(&c()).await.unwrap_err().code,
            ErrorCode::InvalidCredentials
        );
    }

    #[tokio::test]
    async fn legacy_image_route_and_errors() {
        let s = MockServer::start().await;
        let m = model(
            "kling",
            "kling-v3",
            Some("v1/images/generations"),
            "task_result.images[].url",
        );
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .and(body_partial_json(json!({"external_task_id": "e2"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"code": 0, "data": {"task_id": "i1", "task_status": "submitted"}}),
            ))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/images/generations/i1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"task_id": "i1", "task_status": "succeed", "task_result": {"images": [{"url": "https://cdn.klingai.com/1.png"}]}}})))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/images/generations/i2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"code": 0, "data": {"task_id": "i2", "task_status": "failed", "task_status_msg": "Failure to pass the risk control system"}})))
            .mount(&s)
            .await;
        let p = Kling::with_base(Net::for_tests(), &s.uri());
        assert_eq!(
            p.submit(&c(), &m, &json!({"prompt": "x"}), "e2")
                .await
                .unwrap()
                .request_id,
            "i1"
        );
        let jr = |id: &str| JobRef {
            request_id: id.into(),
            model_path: "v1/images/generations".into(),
            ..Default::default()
        };
        match p.status(&c(), &jr("i1")).await.unwrap() {
            RemoteStatus::Completed { result, .. } => assert_eq!(
                p.outputs(&m, &result),
                vec!["https://cdn.klingai.com/1.png"]
            ),
            o => panic!("{o:?}"),
        }
        assert!(matches!(
            p.status(&c(), &jr("i2")).await.unwrap(),
            RemoteStatus::Blocked { .. }
        ));

        let s2 = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(429)
                    .set_body_json(json!({"code": 1102, "message": "pack exhausted"})),
            )
            .mount(&s2)
            .await;
        let p2 = Kling::with_base(Net::for_tests(), &s2.uri());
        let e = p2.submit(&c(), &m, &json!({}), "x").await.unwrap_err();
        assert_eq!(e.error.code, ErrorCode::InsufficientCredits);
        assert!(!e.ambiguous);
    }
}
