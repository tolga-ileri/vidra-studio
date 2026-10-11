//! Update check against GitHub releases. Any failure returns `None`.

use crate::net::{read_json, Net};
use crate::types::UpdateInfo;
use serde_json::Value;

pub const RELEASES_URL: &str =
    "https://api.github.com/repos/tolga-ileri/vidra-studio/releases/latest";

pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let core = s.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (
        it.next()??,
        it.next().unwrap_or(Some(0))?,
        it.next().unwrap_or(Some(0))?,
    );
    Some(v)
}

pub fn evaluate(current: &str, release: &Value) -> Option<UpdateInfo> {
    let tag = release.get("tag_name")?.as_str()?;
    let latest = parse_version(tag)?;
    let cur = parse_version(current)?;
    let url = release
        .get("html_url")
        .and_then(Value::as_str)
        .filter(|u| u.starts_with("https://github.com/tolga-ileri/vidra-studio/"))
        .unwrap_or("https://github.com/tolga-ileri/vidra-studio/releases")
        .to_string();
    Some(UpdateInfo {
        current_version: current.to_string(),
        latest_version: format!("{}.{}.{}", latest.0, latest.1, latest.2),
        url,
        newer: latest > cur,
    })
}

pub async fn check(net: &Net) -> Option<UpdateInfo> {
    let resp = net
        .api
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    let (status, body) = read_json(resp).await.ok()?;
    if !status.is_success() {
        return None;
    }
    evaluate(env!("CARGO_PKG_VERSION"), &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn semver_compare() {
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("v2.0.0-beta.1"), Some((2, 0, 0)));
        assert!(parse_version("latest").is_none());
        let r = json!({"tag_name": "v0.10.0", "html_url": "https://github.com/tolga-ileri/vidra-studio/releases/tag/v0.10.0"});
        assert!(evaluate("0.9.1", &r).unwrap().newer);
        assert!(!evaluate("0.10.0", &r).unwrap().newer);
        let evil = json!({"tag_name": "v9.0.0", "html_url": "https://evil.example.com/"});
        assert!(evaluate("0.1.0", &evil)
            .unwrap()
            .url
            .starts_with("https://github.com/tolga-ileri/"));
    }
}
