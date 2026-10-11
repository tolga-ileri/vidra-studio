use super::*;
use crate::pricing::{estimate_price, PriceEstimate};

const VECTORS: &str = include_str!("../../../../packages/core/test/vectors/capabilities.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn vector_model(v: &Value) -> ModelDef {
    parse_model(&v["model"], ProviderId::Replicate).unwrap()
}

fn now_of(v: &Value) -> i64 {
    chrono::DateTime::parse_from_rfc3339(v["now"].as_str().unwrap())
        .unwrap()
        .timestamp_millis()
}

#[test]
fn validation_vectors_match_core() {
    let v = vectors();
    let m = vector_model(&v);
    for case in v["validation"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let params = case["params"].as_object().unwrap().clone();
        let neg = case.get("negativePrompt").and_then(Value::as_str);
        let res = validate_generation(&m, "", neg, &params);
        if case["ok"] == json!(true) {
            assert!(res.is_ok(), "{name}: {:?}", res.err());
            continue;
        }
        let err = res
            .err()
            .unwrap_or_else(|| panic!("{name}: expected error"));
        let d = err.details.clone().unwrap();
        assert_eq!(d["code"], case["code"], "{name}: {err:?}");
        if let Some(rule) = case.get("rule") {
            assert_eq!(&d["ruleId"], rule, "{name}");
        }
    }
}

#[test]
fn pricing_vectors_match_core() {
    let v = vectors();
    let now = now_of(&v);
    for case in v["pricing"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut raw = v["model"].clone();
        if let Some(o) = case.get("pricingOverride").and_then(Value::as_object) {
            for (k, x) in o {
                raw["pricing"][k] = x.clone();
            }
        }
        if let Some(extra) = case.get("extraParams").and_then(Value::as_array) {
            raw["params"]
                .as_array_mut()
                .unwrap()
                .extend(extra.iter().cloned());
        }
        let m = parse_model(&raw, ProviderId::Replicate).unwrap_or_else(|e| panic!("{name}: {e}"));
        let params = case["params"].as_object().unwrap().clone();
        let exp = &case["expect"];
        match estimate_price(&m, &params, now, None, None) {
            PriceEstimate::Estimated {
                amount, currency, ..
            } => {
                assert_eq!(exp["status"], "estimated", "{name}");
                assert!(
                    (amount - exp["amount"].as_f64().unwrap()).abs() < 1e-6,
                    "{name}: {amount}"
                );
                assert_eq!(exp["currency"], json!(currency), "{name}");
            }
            PriceEstimate::Unavailable { reason, .. } => {
                assert_eq!(exp["status"], "unavailable", "{name}");
                assert_eq!(exp["reason"], json!(reason), "{name}");
            }
        }
    }
}

#[test]
fn bundled_manifests_parse() {
    for (p, text) in crate::bundled::MANIFESTS {
        let models = parse_manifest(text, *p).unwrap_or_else(|e| panic!("{}: {e}", p.as_str()));
        assert!(!models.is_empty(), "{}", p.as_str());
    }
    assert!(Registry::bundled().models.len() >= 3);
}

fn fixture() -> ModelDef {
    let mut raw = vectors()["model"].clone();
    raw["params"].as_array_mut().unwrap().extend([
        json!({"key":"sound","apiField":"settings.sound","label":{"en":"Sound","tr":"Ses"},"type":"boolean","encode":["on","off"]}),
        json!({"key":"seed","apiField":"seed","label":{"en":"Seed","tr":"Seed"},"type":"seed"}),
    ]);
    raw["request"] = json!({"fixed": {"mode": "pro"}});
    parse_model(&raw, ProviderId::Replicate).unwrap()
}

#[test]
fn builds_body_with_conventions() {
    let m = fixture();
    let p = json!({"image": "https://cdn.example.com/a.png", "duration": "10", "sound": false, "seed": 4})
        .as_object()
        .unwrap()
        .clone();
    let g = validate_generation(&m, " hello ", Some("blurry"), &p).unwrap();
    let body = build_body(&m, &g.prompt, g.negative.as_deref(), &g.values, false);
    assert_eq!(
        body,
        json!({"prompt":"hello","negative_prompt":"blurry","duration":10,"settings":{"sound":"off"},
               "image":"https://cdn.example.com/a.png","seed":4,"mode":"pro"})
    );
    assert_eq!(requested_duration(&m, &g.values), Some(10.0));
}

#[test]
fn kling_contents() {
    let mut m = fixture();
    m.prompt.api_field = "contents.prompt".into();
    let i = m.params.iter().position(|p| p.key == "image").unwrap();
    m.params[i].api_field = "contents.first_frame".into();
    let p = json!({"image": "https://cdn.example.com/a.png"})
        .as_object()
        .unwrap()
        .clone();
    let v = validate_params(&m, &p).unwrap();
    let body = build_body(&m, "hi", None, &v, true);
    assert_eq!(
        body["contents"],
        json!([{"type":"prompt","text":"hi"},{"type":"first_frame","url":"https://cdn.example.com/a.png"}])
    );
}

#[test]
fn rejects_bad_manifests() {
    let base = vectors()["model"].clone();
    let bad = |f: &dyn Fn(&mut Value), needle: &str| {
        let mut raw = base.clone();
        f(&mut raw);
        let e = parse_model(&raw, ProviderId::Replicate).unwrap_err();
        assert!(e.contains(needle), "{e}");
    };
    bad(
        &|r| r["capabilities"]["maxDurationSec"] = json!(20),
        "maxDurationSec",
    );
    bad(
        &|r| r["rules"][0]["then"][0]["params"][0] = json!("nope"),
        "unknown param nope",
    );
    bad(&|r| r["pricing"]["extra"] = json!(1), "unknown key extra");
    bad(
        &|r| r["pricing"]["verifiedAt"] = Value::Null,
        "verified pricing needs",
    );
    bad(
        &|r| r["params"][1]["apiField"] = json!("duration"),
        "used twice",
    );
    bad(&|r| r["pricing"]["currency"] = json!("credits"), "unitName");
    // unknown vocabulary is an executability problem, not a parse error
    let mut raw = base.clone();
    raw["params"][0]["type"] = json!("color");
    assert_eq!(executability_problem(&raw), Some("unknown_param_type"));
    assert_eq!(executability_problem(&base), None);
}

#[test]
fn output_paths() {
    let r = json!({"video":{"url":"https://a/v.mp4"},"images":[{"url":"https://a/1"},{"url":"https://a/2"}],
                   "output":["https://a/x","https://a/y"],"outputs":[{"type":"video","url":"https://k/v"}]});
    assert_eq!(extract_outputs(&r, "video.url"), vec!["https://a/v.mp4"]);
    assert_eq!(
        extract_outputs(&r, "images[].url"),
        vec!["https://a/1", "https://a/2"]
    );
    assert_eq!(
        extract_outputs(&r, "output[]"),
        vec!["https://a/x", "https://a/y"]
    );
    assert_eq!(
        extract_outputs(&json!({"output":"https://s"}), "output"),
        vec!["https://s"]
    );
    assert_eq!(extract_outputs(&r, "outputs[].url"), vec!["https://k/v"]);
    assert!(extract_outputs(&r, "missing.url").is_empty());
}
