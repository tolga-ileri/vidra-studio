//! HTTP clients.
//!
//! * `api` — talks only to the fixed provider base URLs. Redirects are errors.
//! * `external` — for provider-returned URLs (output downloads, presigned
//!   uploads): https on port 443 only, no credentials in the URL, a public
//!   hostname (no IP literals or local names), DNS answers filtered to public
//!   IPs, and redirects followed manually (≤ 5), each hop re-validated.

use crate::error::{AppError, AppResult, ErrorCode};
use futures_util::StreamExt;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde_json::Value;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use url::{Host, Url};

pub const MAX_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_REDIRECTS: usize = 5;

/// True only for globally routable unicast addresses.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let s = v6.segments();
            if v6.is_unspecified() || v6.is_loopback() || v6.is_multicast() {
                return false;
            }
            // fc00::/7 unique local, fe80::/10 link local, fec0::/10 site local
            if (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xffc0) == 0xfec0 {
                return false;
            }
            // ::/96 IPv4-compatible, 64:ff9b::/96 NAT64, 2001:db8::/32 doc, 2001::/23 IETF, 2002::/16 6to4, 100::/64 discard
            if s[0..6] == [0, 0, 0, 0, 0, 0] {
                return false;
            }
            if s[0] == 0x64 && s[1] == 0xff9b {
                return false;
            }
            if s[0] == 0x2001 && (s[1] == 0x0db8 || s[1] < 0x0200) {
                return false;
            }
            if s[0] == 0x2002 || (s[0] == 0x0100 && s[1..4] == [0, 0, 0]) {
                return false;
            }
            true
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    !(o[0] == 0
        || o[0] == 10
        || (o[0] == 100 && (64..128).contains(&o[1]))
        || o[0] == 127
        || (o[0] == 169 && o[1] == 254)
        || (o[0] == 172 && (16..32).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || o[0] >= 224)
}

pub fn blocked(msg: &str) -> AppError {
    AppError::new(ErrorCode::InvalidInput, msg.to_string())
        .with_details(serde_json::json!({"reason": "blocked_url"}))
}

/// Network policy. The relaxed variant exists only in test builds so that
/// local mock servers can be used; release builds are always strict.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    Strict,
    #[cfg(any(test, feature = "e2e-mock"))]
    TestLoopback,
}

/// Validates an external URL (before every request and every redirect hop).
pub fn validate_external_url(url: &Url, policy: Policy) -> AppResult<()> {
    #[cfg(any(test, feature = "e2e-mock"))]
    if policy == Policy::TestLoopback && url.scheme() == "http" {
        if let Some(Host::Ipv4(ip)) = url.host() {
            if ip.is_loopback() {
                return Ok(());
            }
        }
    }
    let _ = policy;
    if url.scheme() != "https" {
        return Err(blocked("Only https URLs are allowed."));
    }
    if url.port().is_some_and(|p| p != 443) {
        return Err(blocked("Only the standard https port is allowed."));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(blocked("URLs with credentials are not allowed."));
    }
    match url.host() {
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            let local = d == "localhost"
                || !d.contains('.')
                || [
                    ".localhost",
                    ".local",
                    ".internal",
                    ".lan",
                    ".home",
                    ".arpa",
                    ".corp",
                    ".intranet",
                    ".test",
                    ".invalid",
                ]
                .iter()
                .any(|s| d.ends_with(s));
            // A domain consisting only of digits/dots/hex might be a numeric host.
            let numeric = d
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == 'x');
            if local || numeric {
                return Err(blocked("Local host names are not allowed."));
            }
            Ok(())
        }
        Some(_) => Err(blocked("IP address URLs are not allowed.")),
        None => Err(blocked("The URL has no host.")),
    }
}

/// Host lookup abstraction (overridable in tests).
pub trait Lookup: Send + Sync + 'static {
    fn lookup(
        &self,
        host: String,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>>;
}

pub struct SystemLookup;

impl Lookup for SystemLookup {
    fn lookup(
        &self,
        host: String,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((host.as_str(), 443)).await?;
            Ok(addrs.map(|a| a.ip()).collect())
        })
    }
}

/// reqwest resolver that only ever yields public IPs.
pub struct PublicResolver {
    inner: Arc<dyn Lookup>,
}

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let inner = self.inner.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let ips = inner
                .lookup(host)
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
            let public: Vec<SocketAddr> = ips
                .into_iter()
                .filter(|ip| is_public_ip(*ip))
                .map(|ip| SocketAddr::new(ip, 443))
                .collect();
            if public.is_empty() {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "host resolves only to non-public addresses",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            let addrs: Addrs = Box::new(public.into_iter());
            Ok(addrs)
        })
    }
}

#[derive(Clone)]
pub struct Net {
    pub api: Client,
    external: Client,
    pub policy: Policy,
}

const UA: &str = concat!("VidraStudio/", env!("CARGO_PKG_VERSION"));

impl Net {
    pub fn new() -> Self {
        Self::with_lookup(Arc::new(SystemLookup), Policy::Strict)
    }

    pub fn with_lookup(lookup: Arc<dyn Lookup>, policy: Policy) -> Self {
        let api = Client::builder()
            .user_agent(UA)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .https_only(policy == Policy::Strict)
            .build()
            .expect("http client");
        let external = Client::builder()
            .user_agent(UA)
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(PublicResolver { inner: lookup }))
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .https_only(policy == Policy::Strict)
            .build()
            .expect("http client");
        Net {
            api,
            external,
            policy,
        }
    }

    #[cfg(any(test, feature = "e2e-mock"))]
    pub fn for_tests() -> Self {
        Self::with_lookup(Arc::new(SystemLookup), Policy::TestLoopback)
    }

    /// Sends a request to an external URL, following ≤ 5 validated redirects
    /// (only for GET/HEAD). `build` adds headers to each hop.
    pub async fn external(
        &self,
        method: Method,
        url: &str,
        build: impl Fn(RequestBuilder) -> RequestBuilder,
    ) -> AppResult<Response> {
        let mut current = Url::parse(url).map_err(|_| blocked("Invalid URL."))?;
        for _ in 0..=MAX_REDIRECTS {
            validate_external_url(&current, self.policy)?;
            let req = build(self.external.request(method.clone(), current.clone()));
            let resp = req.send().await.map_err(map_reqwest)?;
            if resp.status().is_redirection() && matches!(method, Method::GET | Method::HEAD) {
                let loc = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| AppError::network("Redirect without a location."))?;
                current = current
                    .join(loc)
                    .map_err(|_| blocked("Invalid redirect."))?;
                continue;
            }
            return Ok(resp);
        }
        Err(blocked("Too many redirects."))
    }
}

impl Default for Net {
    fn default() -> Self {
        Self::new()
    }
}

pub fn map_reqwest(e: reqwest::Error) -> AppError {
    // Do not include the URL (it may carry signed query strings).
    let e = e.without_url();
    let msg = e.to_string();
    if msg.contains("non-public") {
        return blocked("The address resolves to a private network.");
    }
    let mut src: Option<&dyn std::error::Error> = std::error::Error::source(&e);
    while let Some(s) = src {
        if s.to_string().contains("non-public") {
            return blocked("The address resolves to a private network.");
        }
        src = s.source();
    }
    if e.is_timeout() {
        AppError::network("The request timed out.")
    } else {
        AppError::network("Could not reach the server.")
    }
}

/// Reads a response body with a hard size cap.
pub async fn read_limited(resp: Response, limit: usize) -> AppResult<Vec<u8>> {
    if resp.content_length().is_some_and(|n| n as usize > limit) {
        return Err(AppError::provider("The response is too large."));
    }
    let mut out = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(map_reqwest)?;
        if out.len() + chunk.len() > limit {
            return Err(AppError::provider("The response is too large."));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Reads a JSON response (≤ 1 MB). Empty bodies become `Value::Null`.
pub async fn read_json(resp: Response) -> AppResult<(StatusCode, Value)> {
    let status = resp.status();
    let bytes = read_limited(resp, MAX_JSON_BYTES).await?;
    if bytes.is_empty() {
        return Ok((status, Value::Null));
    }
    let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Ok((status, v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeLookup(HashMap<String, Vec<IpAddr>>);
    impl Lookup for FakeLookup {
        fn lookup(
            &self,
            host: String,
        ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send>> {
            let r = self.0.get(&host).cloned().unwrap_or_default();
            Box::pin(async move { Ok(r) })
        }
    }

    #[test]
    fn ip_classification() {
        for s in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "64:ff9b::a00:1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(s.parse().unwrap()), "{s} should be private");
        }
        for s in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "100.128.0.1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public_ip(s.parse().unwrap()), "{s} should be public");
        }
    }

    #[test]
    fn url_validation() {
        let ok = |s: &str| validate_external_url(&Url::parse(s).unwrap(), Policy::Strict).is_ok();
        assert!(ok("https://cdn.example.com/a.mp4"));
        assert!(ok("https://cdn.example.com:443/a.mp4"));
        assert!(!ok("http://cdn.example.com/a.mp4"));
        assert!(!ok("https://cdn.example.com:8443/a.mp4"));
        assert!(!ok("https://user:pw@cdn.example.com/a.mp4"));
        assert!(!ok("https://127.0.0.1/a"));
        assert!(!ok("https://[::1]/a"));
        assert!(!ok("https://2130706433/a"));
        assert!(!ok("https://0x7f000001/a"));
        assert!(!ok("https://localhost/a"));
        assert!(!ok("https://foo.localhost/a"));
        assert!(!ok("https://printer.local/a"));
        assert!(!ok("https://intranet/a"));
        assert!(!ok("file:///c:/windows/win.ini"));
        // strict policy refuses loopback http even in tests
        assert!(!ok("http://127.0.0.1:8080/a"));
    }

    #[tokio::test]
    async fn private_dns_results_are_rejected() {
        let mut m = HashMap::new();
        m.insert(
            "evil.example.com".to_string(),
            vec!["10.0.0.5".parse().unwrap(), "127.0.0.1".parse().unwrap()],
        );
        m.insert(
            "v6evil.example.com".to_string(),
            vec!["::ffff:192.168.0.1".parse().unwrap()],
        );
        let net = Net::with_lookup(Arc::new(FakeLookup(m)), Policy::Strict);
        for host in ["evil.example.com", "v6evil.example.com"] {
            let err = net
                .external(Method::GET, &format!("https://{host}/x"), |r| r)
                .await
                .unwrap_err();
            assert_eq!(
                err.details.as_ref().unwrap()["reason"],
                "blocked_url",
                "{host}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn redirect_to_private_is_rejected() {
        use wiremock::matchers::path;
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(path("/r1"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("location", "https://127.0.0.1/secret"),
            )
            .mount(&server)
            .await;
        Mock::given(path("/r2"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", "http://169.254.169.254/latest"),
            )
            .mount(&server)
            .await;
        Mock::given(path("/loop"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/loop"))
            .mount(&server)
            .await;
        let net = Net::for_tests();
        for p in ["/r1", "/r2", "/loop"] {
            let err = net
                .external(Method::GET, &format!("{}{p}", server.uri()), |r| r)
                .await
                .unwrap_err();
            assert_eq!(
                err.details.as_ref().unwrap()["reason"],
                "blocked_url",
                "{p}"
            );
        }
    }
}
