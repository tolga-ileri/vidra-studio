//! Higgsfield (docs/providers/higgsfield.md). Auth `Key <id>:<secret>`,
//! submit with `Idempotency-Key`, `/estimate/<path>`, signed-upload flow,
//! cancel only while queued.

use super::*;

pub const BASE: &str = "https://api.higgsfield.ai";

pub struct Higgsfield {
    net: Net,
    base: String,
}

impl Higgsfield {
    pub fn new(net: Net) -> Self {
        Higgsfield {
            net,
            base: BASE.to_string(),
        }
    }
    #[cfg(any(test, feature = "e2e-mock"))]
    pub fn with_base(net: Net, base: &str) -> Self {
        Higgsfield {
            net,
            base: base.trim_end_matches('/').to_string(),
        }
    }
    fn auth(creds: &Creds) -> AppResult<String> {
        let id = cred(creds, "key_id")?;
        let secret = cred(creds, "key_secret")?;
        Ok(format!("Key {id}:{secret}"))
    }
    fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base, path.trim_start_matches('/'))
    }
}

#[async_trait]
impl Provider for Higgsfield {
    fn id(&self) -> ProviderId {
        ProviderId::Higgsfield
    }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            validate_credentials: true,
            model_discovery: false,
            estimate_cost: true,
            upload_references: true,
            cancel: true,
            idempotent_submit: true,
        }
    }
    fn credential_fields(&self) -> Vec<CredentialField> {
        vec![
            CredentialField {
                key: "key_id".into(),
                label: "API key ID".into(),
                secret: false,
            },
            CredentialField {
                key: "key_secret".into(),
                label: "API key secret".into(),
                secret: true,
            },
        ]
    }
    fn docs_url(&self) -> &'static str {
        "https://docs.higgsfield.ai/docs/authentication.md"
    }

    async fn validate(&self, creds: &Creds) -> AppResult<()> {
        // A status lookup for a random id: 401 = bad key, 404 = key accepted.
        let auth = Self::auth(creds)?;
        let url = self.url(&format!("requests/{}/status", uuid::Uuid::new_v4()));
        let (status, body) = api_json(&self.net, Method::GET, &url, &auth, None, &[]).await?;
        match status.as_u16() {
            200..=299 | 404 => Ok(()),
            _ => Err(map_http(status, &body, self.id())),
        }
    }

    async fn estimate(
        &self,
        creds: &Creds,
        model: &Model,
        _values: &ParamValues,
        body: &Value,
    ) -> AppResult<Option<ProviderEstimate>> {
        let auth = Self::auth(creds)?;
        let url = self.url(&format!("estimate/{}", model.path()));
        let (status, resp) =
            api_json(&self.net, Method::POST, &url, &auth, Some(body), &[]).await?;
        if !status.is_success() {
            return Err(map_http(status, &resp, self.id()));
        }
        let usd = num_or_string(resp.get("usd"));
        let credits = num_or_string(resp.get("credits"));
        if usd.is_none() && credits.is_none() {
            return Ok(None);
        }
        Ok(Some(ProviderEstimate {
            usd,
            credits,
            source: "provider",
        }))
    }

    async fn upload_reference(
        &self,
        creds: &Creds,
        bytes: Vec<u8>,
        mime: &str,
        _name: &str,
    ) -> AppResult<String> {
        let auth = Self::auth(creds)?;
        let (status, resp) = api_json(
            &self.net,
            Method::POST,
            &self.url("files/generate-upload-url"),
            &auth,
            Some(&json!({ "content_type": mime })),
            &[],
        )
        .await?;
        if !status.is_success() {
            return Err(map_http(status, &resp, self.id()));
        }
        let upload_url = json_str(&resp, "upload_url")
            .ok_or_else(|| AppError::provider("Upload URL missing."))?;
        let public_url = json_str(&resp, "public_url")
            .ok_or_else(|| AppError::provider("Upload URL missing."))?;
        let mut headers: Vec<(String, String)> = resp
            .get("upload_headers")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .filter(|(k, _)| {
                        !k.eq_ignore_ascii_case("authorization") && !k.eq_ignore_ascii_case("host")
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        {
            headers.push(("Content-Type".into(), mime.to_string()));
        }
        put_presigned(&self.net, &upload_url, bytes, &headers).await?;
        Ok(public_url)
    }

    async fn submit(
        &self,
        creds: &Creds,
        model: &Model,
        body: &Value,
        key: &str,
    ) -> Result<Submitted, SubmitFailure> {
        let auth = Self::auth(creds)?;
        let url = self.url(model.path());
        let (status, resp) = api_json(
            &self.net,
            Method::POST,
            &url,
            &auth,
            Some(body),
            &[("Idempotency-Key", key)],
        )
        .await?;
        if !status.is_success() {
            return Err(map_http(status, &resp, self.id()).into());
        }
        let request_id = json_str(&resp, "request_id").ok_or_else(|| SubmitFailure {
            error: AppError::provider("The provider response had no request id."),
            ambiguous: true,
        })?;
        Ok(Submitted {
            poll_url: json_str(&resp, "status_url").and_then(|u| same_origin(&u, &self.base)),
            cancel_url: json_str(&resp, "cancel_url").and_then(|u| same_origin(&u, &self.base)),
            result_url: None,
            request_id,
        })
    }

    async fn status(&self, creds: &Creds, job: &JobRef) -> AppResult<RemoteStatus> {
        let auth = Self::auth(creds)?;
        let url = job
            .poll_url
            .as_deref()
            .and_then(|u| same_origin(u, &self.base))
            .unwrap_or_else(|| self.url(&format!("requests/{}/status", job.request_id)));
        let (status, resp) = api_json(&self.net, Method::GET, &url, &auth, None, &[]).await?;
        if !status.is_success() {
            return Err(map_http(status, &resp, self.id()));
        }
        Ok(
            match resp.get("status").and_then(Value::as_str).unwrap_or("") {
                "queued" => RemoteStatus::Queued,
                "in_progress" => RemoteStatus::Running,
                "completed" => RemoteStatus::Completed {
                    result: resp.clone(),
                    confirmed_usd: None,
                },
                "nsfw" => RemoteStatus::Blocked {
                    message: "The request was rejected by content moderation.".into(),
                },
                "canceled" | "cancelled" => RemoteStatus::Canceled,
                "failed" => RemoteStatus::Failed {
                    code: "provider_error".into(),
                    message: json_str(&resp, "error")
                        .map(|s| sanitize(&s))
                        .unwrap_or_else(|| "Generation failed.".into()),
                },
                _ => RemoteStatus::Running,
            },
        )
    }

    async fn cancel(&self, creds: &Creds, job: &JobRef) -> AppResult<()> {
        let auth = Self::auth(creds)?;
        let url = job
            .cancel_url
            .as_deref()
            .and_then(|u| same_origin(u, &self.base))
            .unwrap_or_else(|| self.url(&format!("requests/{}/cancel", job.request_id)));
        let (status, resp) = api_json(&self.net, Method::POST, &url, &auth, None, &[]).await?;
        match status.as_u16() {
            200..=299 => Ok(()),
            400 | 409 => Err(AppError::new(
                ErrorCode::CancelTooLate,
                "Processing already started; it can no longer be canceled.",
            )),
            _ => Err(map_http(status, &resp, self.id())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use wiremock::matchers::{body_json, header, method, path, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn hf(server: &MockServer) -> Higgsfield {
        Higgsfield::with_base(Net::for_tests(), &server.uri())
    }
    fn c() -> Creds {
        creds(&[("key_id", "kid"), ("key_secret", "ksecret")])
    }

    #[tokio::test]
    async fn submit_poll_complete_and_estimate() {
        let s = MockServer::start().await;
        let m = model(
            "higgsfield",
            "bytedance/seedance-2.0/text-to-video",
            None,
            "video.url",
        );
        Mock::given(method("POST"))
            .and(path("/bytedance/seedance-2.0/text-to-video"))
            .and(header("authorization", "Key kid:ksecret"))
            .and(header("idempotency-key", "idem-1"))
            .and(body_json(json!({"prompt": "x"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "queued", "request_id": "r1",
                "status_url": format!("{}/requests/r1/status", s.uri()),
                "cancel_url": "https://evil.example.com/cancel"
            })))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/estimate/bytedance/seedance-2.0/text-to-video"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"credits": "1.500", "usd": "0.094"})),
            )
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/requests/r1/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "completed", "request_id": "r1", "video": {"url": "https://cdn.example.com/v.mp4"}
            })))
            .mount(&s)
            .await;
        let p = hf(&s);
        let e = p
            .estimate(&c(), &m, &Default::default(), &json!({"prompt": "x"}))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(e.usd, Some(0.094));
        assert_eq!(e.credits, Some(1.5));
        let sub = p
            .submit(&c(), &m, &json!({"prompt": "x"}), "idem-1")
            .await
            .unwrap();
        assert_eq!(sub.request_id, "r1");
        assert!(sub.cancel_url.is_none(), "foreign-origin URLs are dropped");
        let jr = JobRef {
            request_id: "r1".into(),
            poll_url: sub.poll_url,
            ..Default::default()
        };
        match p.status(&c(), &jr).await.unwrap() {
            RemoteStatus::Completed { result, .. } => {
                assert_eq!(
                    p.outputs(&m, &result),
                    vec!["https://cdn.example.com/v.mp4"]
                )
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn failure_nsfw_cancel_and_credentials() {
        let s = MockServer::start().await;
        Mock::given(path("/requests/f/status"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"status": "failed", "error": "boom"})),
            )
            .mount(&s)
            .await;
        Mock::given(path("/requests/n/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "nsfw"})))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/requests/q/cancel"))
            .respond_with(ResponseTemplate::new(202))
            .mount(&s)
            .await;
        Mock::given(method("POST"))
            .and(path("/requests/p/cancel"))
            .respond_with(
                ResponseTemplate::new(400).set_body_json(json!({"detail": "already processing"})),
            )
            .mount(&s)
            .await;
        let p = hf(&s);
        let jr = |id: &str| JobRef {
            request_id: id.into(),
            ..Default::default()
        };
        assert!(
            matches!(p.status(&c(), &jr("f")).await.unwrap(), RemoteStatus::Failed { message, .. } if message == "boom")
        );
        assert!(matches!(
            p.status(&c(), &jr("n")).await.unwrap(),
            RemoteStatus::Blocked { .. }
        ));
        p.cancel(&c(), &jr("q")).await.unwrap();
        assert_eq!(
            p.cancel(&c(), &jr("p")).await.unwrap_err().code,
            ErrorCode::CancelTooLate
        );

        let s2 = MockServer::start().await;
        Mock::given(path_regex("^/requests/.*/status$"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({"detail": "Invalid credentials"})),
            )
            .mount(&s2)
            .await;
        assert_eq!(
            hf(&s2).validate(&c()).await.unwrap_err().code,
            ErrorCode::InvalidCredentials
        );
        assert_eq!(
            hf(&s2).validate(&creds(&[])).await.unwrap_err().code,
            ErrorCode::MissingCredentials
        );
        let s3 = MockServer::start().await;
        Mock::given(path_regex("^/requests/.*/status$"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&s3)
            .await;
        hf(&s3).validate(&c()).await.unwrap();
    }

    #[tokio::test]
    async fn upload_flow_does_not_leak_credentials() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/files/generate-upload-url"))
            .and(body_json(json!({"content_type": "image/png"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "upload_url": format!("{}/put/abc?sig=1", s.uri()),
                "public_url": "https://cdn.example.com/abc.png",
                "upload_headers": {"Content-Type": "image/png", "x-amz-tagging": "retention=temporary"}
            })))
            .mount(&s)
            .await;
        Mock::given(method("PUT"))
            .and(path("/put/abc"))
            .and(header("x-amz-tagging", "retention=temporary"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&s)
            .await;
        let url = hf(&s)
            .upload_reference(&c(), vec![1, 2, 3], "image/png", "a.png")
            .await
            .unwrap();
        assert_eq!(url, "https://cdn.example.com/abc.png");
        let reqs = s.received_requests().await.unwrap();
        let put = reqs.iter().find(|r| r.method.as_str() == "PUT").unwrap();
        assert!(put.headers.get("authorization").is_none());
    }
}
