//! Model registry (manifest format v2, described by
//! `packages/core/src/registry.ts`): parses and cross-checks manifests exactly
//! like `parseManifest`, validates generation values like
//! `validateGeneration` (params.ts + rules.ts), builds provider request bodies
//! and extracts output URLs with the `outputPath` mini-language.
//! Nothing in a manifest is ever executed.

use crate::error::{AppError, AppResult};
use crate::pricing::{self, Formula, Pricing, PricingStatus};
use crate::rules::{self, Constraint, Rule, RuleContext};
use crate::types::{ParamValues, ProviderId};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

pub const MANIFEST_FORMAT_VERSION: i64 = 2;

pub const WORKFLOWS: &[&str] = &[
    "text-to-video",
    "image-to-video",
    "reference-to-video",
    "video-to-video",
    "video-edit",
    "video-extend",
    "text-to-image",
    "image-to-image",
    "image-edit",
];
const MEDIA_WORKFLOWS: &[&str] = &[
    "image-to-video",
    "reference-to-video",
    "video-to-video",
    "video-edit",
    "video-extend",
    "image-to-image",
    "image-edit",
];
pub const PARAM_TYPES: &[&str] = &[
    "enum", "integer", "number", "boolean", "seed", "text", "media",
];
pub const MEDIA_KINDS: &[&str] = &["image", "video", "audio"];
pub const MEDIA_ROLES: &[&str] = &[
    "start_frame",
    "end_frame",
    "reference",
    "source_video",
    "audio",
    "mask",
];
pub const MEDIA_SHAPES: &[&str] = &["url", "url_array"];

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Localized {
    pub en: String,
    pub tr: String,
}

impl Localized {
    pub fn check(&self) -> Result<(), String> {
        if self.en.is_empty() || self.tr.is_empty() {
            return Err("localized text must not be empty".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ParamKind {
    #[serde(rename = "enum", rename_all = "camelCase")]
    Enum {
        values: Vec<Value>,
        default: Option<Value>,
        #[serde(default = "default_value_type")]
        value_type: String,
        value_labels: Option<BTreeMap<String, Localized>>,
        unit: Option<String>,
    },
    #[serde(rename = "integer", rename_all = "camelCase")]
    Integer {
        min: f64,
        max: f64,
        step: Option<f64>,
        default: Option<f64>,
        unit: Option<String>,
    },
    #[serde(rename = "number", rename_all = "camelCase")]
    Number {
        min: f64,
        max: f64,
        step: Option<f64>,
        default: Option<f64>,
        unit: Option<String>,
    },
    #[serde(rename = "boolean", rename_all = "camelCase")]
    Boolean {
        default: Option<bool>,
        encode: Option<(String, String)>,
    },
    #[serde(rename = "seed", rename_all = "camelCase")]
    Seed {
        #[serde(default)]
        min: i64,
        #[serde(default = "default_seed_max")]
        max: i64,
    },
    #[serde(rename = "text", rename_all = "camelCase")]
    Text {
        max_length: usize,
        #[serde(default)]
        multiline: bool,
    },
    #[serde(rename = "media", rename_all = "camelCase")]
    Media {
        media_kind: String,
        role: String,
        #[serde(default)]
        min_items: usize,
        #[serde(default = "one")]
        max_items: usize,
        #[serde(default = "default_shape")]
        shape: String,
        max_size_mb: Option<f64>,
        formats: Option<Vec<String>>,
        max_duration_sec: Option<f64>,
    },
}

fn default_value_type() -> String {
    "string".into()
}
fn default_seed_max() -> i64 {
    2_147_483_647
}
fn one() -> usize {
    1
}
fn default_shape() -> String {
    "url".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamSpec {
    pub key: String,
    pub api_field: String,
    pub label: Localized,
    pub help: Option<Localized>,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub advanced: bool,
    #[serde(flatten)]
    pub kind: ParamKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSpec {
    pub api_field: String,
    pub required: bool,
    pub max_length: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NegativePromptSpec {
    pub api_field: String,
    pub max_length: usize,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RequestSpec {
    pub path: Option<String>,
    #[serde(default)]
    pub fixed: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub max_duration_sec: Option<f64>,
    #[serde(default)]
    pub audio: bool,
    pub max_outputs: Option<i64>,
}

fn default_availability() -> String {
    "available".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDef {
    pub id: String,
    pub provider: ProviderId,
    pub provider_model_id: String,
    pub display_name: String,
    pub family: String,
    pub version: Option<String>,
    pub workflow: String,
    pub output: String,
    pub description: Option<Localized>,
    #[serde(default = "default_availability")]
    pub availability: String,
    pub prompt: PromptSpec,
    pub negative_prompt: Option<NegativePromptSpec>,
    pub params: Vec<ParamSpec>,
    #[serde(rename = "rules", default)]
    rules_raw: Vec<Value>,
    #[serde(skip)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default)]
    pub request: RequestSpec,
    pub output_path: String,
    #[serde(rename = "pricing")]
    pricing_raw: Value,
    #[serde(skip, default = "placeholder_pricing")]
    pub pricing: Pricing,
    pub docs_url: String,
    pub schema_version: Option<String>,
    pub last_verified: String,
    #[serde(default)]
    pub unverified: Vec<String>,
}

fn placeholder_pricing() -> Pricing {
    Pricing {
        status: PricingStatus::Unavailable,
        currency: "USD".into(),
        unit_name: None,
        formula: None,
        adjustments: vec![],
        from: false,
        source: None,
        pricing_page_url: None,
        verified_at: None,
        max_age_days: 120,
    }
}

impl ModelDef {
    pub fn param(&self, key: &str) -> Option<&ParamSpec> {
        self.params.iter().find(|p| p.key == key)
    }
    /// `defaultOf` in pricing.ts (enum/integer/number/boolean defaults).
    pub fn default_of(&self, key: &str) -> Option<Value> {
        self.param(key).and_then(default_of)
    }
}

/// A parsed model plus its original JSON (what `list_models` returns).
#[derive(Debug, Clone)]
pub struct Model {
    pub def: ModelDef,
    pub raw: Value,
}

impl Model {
    /// Endpoint path: `request.path` if set, else the provider model id.
    pub fn path(&self) -> &str {
        self.def
            .request
            .path
            .as_deref()
            .unwrap_or(&self.def.provider_model_id)
    }
}

/* ── Patterns ──────────────────────────────────────────────────────────── */

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("valid regex"))
}
fn param_key_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[a-z][a-z0-9_]{0,47}$")
}
fn api_field_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$")
}
fn output_path_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"(?i)^[a-z_][a-z0-9_]*(\[\])?(\.[a-z_][a-z0-9_]*(\[\])?)*$",
    )
}
fn path_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^[a-z0-9][a-z0-9._/-]*$")
}
fn model_id_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[a-z]+:[A-Za-z0-9._/#:-]{1,160}$")
}
fn manifest_version_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^\d{4}\.\d{2}\.\d{2}(\.\d+)?$")
}
fn format_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[a-z0-9]{2,5}$")
}
/// Opaque in-memory reference token (see references::store_inline).
fn inline_ref_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(
        &R,
        r"^vidra-ref:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    )
}
fn public_https_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?i)^https://[^\s/?#@]+\.[^\s/?#@]+(/[^\s]*)?$")
}

pub fn check_param_key(k: &str) -> Result<(), String> {
    if param_key_re().is_match(k) {
        Ok(())
    } else {
        Err(format!("invalid param key {k}"))
    }
}

pub fn valid_manifest_version(v: &str) -> bool {
    manifest_version_re().is_match(v)
}

fn len_ok(s: &str, min: usize, max: usize) -> bool {
    let n = s.chars().count();
    n >= min && n <= max
}

fn is_scalar(v: &Value) -> bool {
    v.is_string() || v.is_boolean() || v.as_f64().is_some_and(f64::is_finite)
}

/* ── Executability (registry entries this build cannot run) ────────────── */

fn condition_ops_known(c: &Value, depth: usize) -> bool {
    if depth > 16 {
        return false;
    }
    let Some(o) = c.as_object() else {
        return true; // structural problem: reported by the full parse
    };
    for k in ["all", "any"] {
        if let Some(items) = o.get(k).and_then(Value::as_array) {
            return items.iter().all(|x| condition_ops_known(x, depth + 1));
        }
    }
    match o.get("op").and_then(Value::as_str) {
        Some(op) => rules::CONDITION_OPS.contains(&op),
        None => true,
    }
}

/// Returns a machine-readable reason when this build cannot execute the raw
/// model (unknown vocabulary or request shape); `None` when it can.
pub fn executability_problem(raw: &Value) -> Option<&'static str> {
    let provider = raw.get("provider").and_then(Value::as_str).unwrap_or("");
    if ProviderId::parse(provider).is_none() {
        return Some("provider_unsupported");
    }
    let workflow = raw.get("workflow").and_then(Value::as_str).unwrap_or("");
    if !WORKFLOWS.contains(&workflow) {
        return Some("unknown_workflow");
    }
    let mut fields: HashSet<String> = HashSet::new();
    if let Some(f) = raw.pointer("/prompt/apiField").and_then(Value::as_str) {
        fields.insert(f.to_string());
    }
    if let Some(f) = raw
        .pointer("/negativePrompt/apiField")
        .and_then(Value::as_str)
    {
        fields.insert(f.to_string());
    }
    if let Some(fixed) = raw.pointer("/request/fixed").and_then(Value::as_object) {
        for (k, v) in fixed {
            if !is_scalar(v) {
                return Some("invalid_fixed_value");
            }
            fields.insert(k.clone());
        }
    }
    for p in raw
        .get("params")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let ty = p.get("type").and_then(Value::as_str).unwrap_or("");
        if !PARAM_TYPES.contains(&ty) {
            return Some("unknown_param_type");
        }
        if ty == "media" {
            let known = |k: &str, set: &[&str], dflt: Option<&str>| {
                p.get(k)
                    .and_then(Value::as_str)
                    .or(dflt)
                    .is_some_and(|v| set.contains(&v))
            };
            if !known("mediaKind", MEDIA_KINDS, None)
                || !known("role", MEDIA_ROLES, None)
                || !known("shape", MEDIA_SHAPES, Some("url"))
            {
                return Some("unknown_media_spec");
            }
        }
        if let Some(f) = p.get("apiField").and_then(Value::as_str) {
            if !fields.insert(f.to_string()) {
                return Some("api_field_collision");
            }
        }
    }
    for r in raw
        .get("rules")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(w) = r.get("when") {
            if !condition_ops_known(w, 0) {
                return Some("unknown_rule_op");
            }
        }
        for k in r
            .get("then")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let op = k.get("op").and_then(Value::as_str).unwrap_or("");
            if !rules::CONSTRAINT_OPS.contains(&op) {
                return Some("unknown_rule_op");
            }
        }
    }
    if let Some(kind) = raw.pointer("/pricing/formula/kind") {
        if !kind
            .as_str()
            .is_some_and(|k| pricing::FORMULA_KINDS.contains(&k))
        {
            return Some("unknown_pricing_formula");
        }
    }
    let status = raw.pointer("/pricing/status").and_then(Value::as_str);
    if !matches!(
        status,
        Some("verified" | "provider_estimate" | "unavailable")
    ) {
        return Some("unknown_pricing_status");
    }
    let output_path = raw.get("outputPath").and_then(Value::as_str).unwrap_or("");
    if !output_path_re().is_match(output_path) {
        return Some("invalid_output_path");
    }
    if let Some(path) = raw.pointer("/request/path") {
        if !path
            .as_str()
            .is_some_and(|p| path_re().is_match(p) && !p.contains(".."))
        {
            return Some("invalid_request_path");
        }
    }
    None
}

/* ── Parsing (parseManifest) ───────────────────────────────────────────── */

/// One model of a leniently parsed (registry) manifest.
#[derive(Debug, Clone)]
pub enum Parsed {
    Ok(Box<Model>),
    /// Known to the registry, but this build cannot execute it.
    UpdateRequired {
        id: String,
        raw: Value,
        reason: &'static str,
    },
}

pub struct ParsedManifest {
    /// Provider id as written (may be unsupported by this build).
    pub provider: String,
    pub version: String,
    pub models: Vec<Parsed>,
}

/// Parses a manifest; models this build cannot execute become
/// `UpdateRequired`, every other problem rejects the whole manifest.
pub fn parse_manifest_lenient(root: &Value) -> Result<ParsedManifest, String> {
    let o = root.as_object().ok_or("manifest must be an object")?;
    if o.get("format") != Some(&json!("vidra.models")) {
        return Err("format must be vidra.models".into());
    }
    if o.get("formatVersion").and_then(Value::as_i64) != Some(MANIFEST_FORMAT_VERSION) {
        return Err(format!("formatVersion must be {MANIFEST_FORMAT_VERSION}"));
    }
    let provider = o
        .get("provider")
        .and_then(Value::as_str)
        .ok_or("provider missing")?
        .to_string();
    let version = o
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| valid_manifest_version(v))
        .ok_or("invalid manifest version")?
        .to_string();
    if !matches!(
        o.get("source").and_then(Value::as_str),
        Some("manifest" | "registry" | "api")
    ) {
        return Err("invalid manifest source".into());
    }
    let models = o
        .get("models")
        .and_then(Value::as_array)
        .ok_or("models missing")?;
    let expected = ProviderId::parse(&provider);
    let mut out = Vec::new();
    let mut ids = HashSet::new();
    for raw in models {
        let id = raw
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        let problem = match expected {
            None => Some("provider_unsupported"),
            Some(_) => executability_problem(raw),
        };
        if !ids.insert(id.clone()) {
            return Err(format!("{id}: duplicate model id"));
        }
        if let Some(reason) = problem {
            out.push(Parsed::UpdateRequired {
                id,
                raw: raw.clone(),
                reason,
            });
            continue;
        }
        let def = parse_model(raw, expected.expect("supported provider"))?;
        out.push(Parsed::Ok(Box::new(Model {
            def,
            raw: raw.clone(),
        })));
    }
    Ok(ParsedManifest {
        provider,
        version,
        models: out,
    })
}

/// Strict parse (bundled manifests): every model must be executable.
pub fn parse_manifest(text: &str, expected: ProviderId) -> Result<Vec<Model>, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
    let parsed = parse_manifest_lenient(&root)?;
    if parsed.provider != expected.as_str() {
        return Err("provider mismatch".into());
    }
    parsed
        .models
        .into_iter()
        .map(|m| match m {
            Parsed::Ok(m) => Ok(*m),
            Parsed::UpdateRequired { id, reason, .. } => Err(format!("{id}: {reason}")),
        })
        .collect()
}

/// Parses and cross-checks one model definition.
pub fn parse_model(raw: &Value, expected: ProviderId) -> Result<ModelDef, String> {
    let hint = raw.get("id").and_then(Value::as_str).unwrap_or("?");
    let mut def: ModelDef =
        serde_json::from_value(raw.clone()).map_err(|e| format!("{hint}: invalid model: {e}"))?;
    let w = def.id.clone();
    if def.rules_raw.len() > 60 {
        return Err(format!("{w}: too many rules"));
    }
    def.rules = def
        .rules_raw
        .iter()
        .map(rules::parse_rule)
        .collect::<Result<_, _>>()
        .map_err(|e| format!("{w}: {e}"))?;
    def.pricing = pricing::parse_pricing(&def.pricing_raw).map_err(|e| format!("{w}: {e}"))?;
    check_model(&def, expected)?;
    Ok(def)
}

fn check_param(w: &str, p: &ParamSpec) -> Result<(), String> {
    check_param_key(&p.key).map_err(|e| format!("{w}: {e}"))?;
    if !api_field_re().is_match(&p.api_field) {
        return Err(format!("{w}: invalid apiField {}", p.api_field));
    }
    p.label
        .check()
        .map_err(|e| format!("{w}: {}: {e}", p.key))?;
    if let Some(h) = &p.help {
        h.check().map_err(|e| format!("{w}: {}: {e}", p.key))?;
    }
    let k = &p.key;
    let unit_ok = |u: &Option<String>| u.as_ref().map_or(true, |u| u.chars().count() <= 8);
    match &p.kind {
        ParamKind::Enum {
            values,
            default,
            value_type,
            value_labels,
            unit,
        } => {
            if values.is_empty() || values.len() > 200 {
                return Err(format!("{w}: {k} needs 1-200 values"));
            }
            for v in values {
                let ok = match v {
                    Value::String(s) => s.chars().count() <= 100,
                    Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
                    _ => false,
                };
                if !ok {
                    return Err(format!("{w}: {k} has an invalid value"));
                }
            }
            if let Some(d) = default {
                if !d.is_string() && !d.is_number() {
                    return Err(format!("{w}: {k} has an invalid default"));
                }
                let s = rules::js_string(d);
                if !values.iter().any(|v| rules::js_string(v) == s) {
                    return Err(format!("{w}: default for {k} not in values"));
                }
            }
            if value_type != "string" && value_type != "number" {
                return Err(format!("{w}: {k} has an invalid valueType"));
            }
            if let Some(labels) = value_labels {
                for l in labels.values() {
                    l.check().map_err(|e| format!("{w}: {k}: {e}"))?;
                }
            }
            if !unit_ok(unit) {
                return Err(format!("{w}: {k} unit is too long"));
            }
        }
        ParamKind::Integer {
            min,
            max,
            step,
            default,
            unit,
        }
        | ParamKind::Number {
            min,
            max,
            step,
            default,
            unit,
        } => {
            if step.is_some_and(|s| !(s.is_finite() && s > 0.0)) {
                return Err(format!("{w}: {k} step must be positive"));
            }
            if !unit_ok(unit) {
                return Err(format!("{w}: {k} unit is too long"));
            }
            if min > max {
                return Err(format!("{w}: {k} min > max"));
            }
            if default.is_some_and(|d| d < *min || d > *max) {
                return Err(format!("{w}: default for {k} out of range"));
            }
        }
        ParamKind::Boolean { .. } | ParamKind::Seed { .. } => {}
        ParamKind::Text { max_length, .. } => {
            if *max_length == 0 || *max_length > 20000 {
                return Err(format!("{w}: {k} maxLength must be 1-20000"));
            }
        }
        ParamKind::Media {
            media_kind,
            role,
            min_items,
            max_items,
            shape,
            max_size_mb,
            formats,
            max_duration_sec,
        } => {
            if !MEDIA_KINDS.contains(&media_kind.as_str())
                || !MEDIA_ROLES.contains(&role.as_str())
                || !MEDIA_SHAPES.contains(&shape.as_str())
            {
                return Err(format!("{w}: {k} has an invalid media spec"));
            }
            if *min_items > 50 || *max_items == 0 || *max_items > 50 {
                return Err(format!("{w}: {k} item limits out of range"));
            }
            if max_size_mb.is_some_and(|m| !(m > 0.0 && m <= 2048.0)) {
                return Err(format!("{w}: {k} maxSizeMb out of range"));
            }
            if let Some(f) = formats {
                if f.len() > 12 || f.iter().any(|x| !format_re().is_match(x)) {
                    return Err(format!("{w}: {k} has invalid formats"));
                }
            }
            if max_duration_sec.is_some_and(|d| !(d > 0.0 && d.is_finite())) {
                return Err(format!("{w}: {k} maxDurationSec must be positive"));
            }
            if min_items > max_items {
                return Err(format!("{w}: {k} minItems > maxItems"));
            }
        }
    }
    Ok(())
}

fn check_model(m: &ModelDef, expected: ProviderId) -> Result<(), String> {
    let w = m.id.as_str();
    if !model_id_re().is_match(w) {
        return Err(format!("{w}: invalid id"));
    }
    if m.provider != expected {
        return Err(format!("{w}: provider does not match manifest"));
    }
    if !w.starts_with(&format!("{}:", m.provider.as_str())) {
        return Err(format!(
            "{w}: id must start with \"{}:\"",
            m.provider.as_str()
        ));
    }
    if !len_ok(&m.provider_model_id, 1, 160) || m.provider_model_id.contains("..") {
        return Err(format!("{w}: invalid providerModelId"));
    }
    if !len_ok(&m.display_name, 1, 80) || !len_ok(&m.family, 1, 60) {
        return Err(format!("{w}: invalid displayName or family"));
    }
    if m.version.as_ref().is_some_and(|v| v.chars().count() > 40) {
        return Err(format!("{w}: version is too long"));
    }
    if !WORKFLOWS.contains(&m.workflow.as_str()) {
        return Err(format!("{w}: invalid workflow"));
    }
    if m.output != "video" && m.output != "image" {
        return Err(format!("{w}: invalid output"));
    }
    if let Some(d) = &m.description {
        d.check().map_err(|e| format!("{w}: {e}"))?;
    }
    if !["available", "deprecated", "discontinued"].contains(&m.availability.as_str()) {
        return Err(format!("{w}: invalid availability"));
    }
    if !api_field_re().is_match(&m.prompt.api_field)
        || m.prompt.max_length == 0
        || m.prompt.max_length > 20000
    {
        return Err(format!("{w}: invalid prompt spec"));
    }
    if let Some(n) = &m.negative_prompt {
        if !api_field_re().is_match(&n.api_field) || n.max_length == 0 {
            return Err(format!("{w}: invalid negativePrompt spec"));
        }
    }
    let c = &m.capabilities;
    if c.max_duration_sec.is_some_and(|d| d.is_nan() || d <= 0.0)
        || c.max_outputs.is_some_and(|n| n <= 0)
    {
        return Err(format!("{w}: invalid capabilities"));
    }
    if let Some(p) = &m.request.path {
        if !path_re().is_match(p) || p.contains("..") {
            return Err(format!("{w}: invalid request path"));
        }
    }
    if m.request.fixed.values().any(|v| !is_scalar(v)) {
        return Err(format!("{w}: request.fixed values must be scalars"));
    }
    if !output_path_re().is_match(&m.output_path) {
        return Err(format!("{w}: invalid outputPath"));
    }
    if !pricing::is_url(&m.docs_url) {
        return Err(format!("{w}: invalid docsUrl"));
    }
    if m.schema_version
        .as_ref()
        .is_some_and(|v| v.chars().count() > 80)
    {
        return Err(format!("{w}: schemaVersion is too long"));
    }
    if !pricing::is_date(&m.last_verified) {
        return Err(format!("{w}: invalid lastVerified"));
    }
    if m.unverified.len() > 30 || m.unverified.iter().any(|u| u.chars().count() > 200) {
        return Err(format!("{w}: invalid unverified list"));
    }

    // parseManifest cross-checks.
    let mut keys: HashSet<&str> = HashSet::new();
    let mut fields: HashSet<&str> = HashSet::new();
    fields.insert(&m.prompt.api_field);
    if let Some(n) = &m.negative_prompt {
        fields.insert(&n.api_field);
    }
    for f in m.request.fixed.keys() {
        fields.insert(f);
    }
    for p in &m.params {
        check_param(w, p)?;
        if !keys.insert(&p.key) {
            return Err(format!("{w}: duplicate param {}", p.key));
        }
        if !fields.insert(&p.api_field) {
            return Err(format!("{w}: apiField {} used twice", p.api_field));
        }
    }
    let mut known = keys.clone();
    known.insert("prompt");
    known.insert("negative_prompt");
    for rule in &m.rules {
        let mut used = Vec::new();
        if let Some(c) = &rule.when {
            rules::condition_params(c, &mut used);
        }
        for k in &rule.then {
            used.extend(rules::constraint_params(k));
        }
        if let Some(u) = used.iter().find(|u| !known.contains(u.as_str())) {
            return Err(format!(
                "{w}: rule {} references unknown param {u}",
                rule.id
            ));
        }
    }
    if MEDIA_WORKFLOWS.contains(&m.workflow.as_str()) {
        let media: Vec<&ParamSpec> = m
            .params
            .iter()
            .filter(|p| matches!(p.kind, ParamKind::Media { .. }))
            .collect();
        let any_of = m
            .rules
            .iter()
            .any(|r| r.when.is_none() && r.then.iter().any(|c| matches!(c, Constraint::AnyOf(_))));
        if !media.iter().any(|p| p.required) && !(!media.is_empty() && any_of) {
            return Err(format!(
                "{w}: {} requires a required media parameter or an anyOf rule",
                m.workflow
            ));
        }
    }
    if let Some(cap) = m.capabilities.max_duration_sec {
        let max = match m.param("duration").map(|p| &p.kind) {
            Some(ParamKind::Enum { values, .. }) => {
                let nums: Vec<f64> = values.iter().filter_map(js_number).collect();
                Some(nums.into_iter().fold(f64::NEG_INFINITY, f64::max))
            }
            Some(ParamKind::Integer { max, .. }) | Some(ParamKind::Number { max, .. }) => {
                Some(*max)
            }
            _ => None,
        };
        #[allow(clippy::float_cmp)]
        if max != Some(cap) {
            let shown = max.map_or("null".to_string(), |x| rules::js_string(&json!(x)));
            return Err(format!(
                "{w}: capabilities.maxDurationSec ({}) != duration param max ({shown})",
                rules::js_string(&json!(cap))
            ));
        }
    }
    let p = &m.pricing;
    if p.status == PricingStatus::Verified
        && (p.formula.is_none() || p.source.is_none() || p.verified_at.is_none())
    {
        return Err(format!(
            "{w}: verified pricing needs formula, source and verifiedAt"
        ));
    }
    match &p.formula {
        Some(Formula::PerSecond {
            duration_param,
            fixed_seconds: None,
            ..
        }) if !keys.contains(duration_param.as_deref().unwrap_or("duration")) => {
            return Err(format!(
                "{w}: per_second pricing needs a duration parameter or fixedSeconds"
            ));
        }
        Some(Formula::PerMegapixel {
            width_param,
            height_param,
            ..
        }) if !keys.contains(width_param.as_str()) || !keys.contains(height_param.as_str()) => {
            return Err(format!(
                "{w}: per_megapixel pricing references unknown dimension params"
            ));
        }
        _ => {}
    }
    if p.currency == "credits" && p.unit_name.is_none() {
        return Err(format!("{w}: credit pricing needs unitName"));
    }
    Ok(())
}

/// JavaScript `Number(value)` for enum values (finite results only).
fn js_number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok()
            }
        }
        _ => None,
    }
    .filter(|f| f.is_finite())
}

/* ── Validation (params.ts) ────────────────────────────────────────────── */

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|f| f.is_finite())
}

fn num_value(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

fn shown(n: f64) -> String {
    rules::js_string(&json!(n))
}

/// Mirrors `coerce` in params.ts. Errors carry
/// `details: {field, code, ...}` with a ParamErrorCode.
pub fn coerce(spec: &ParamSpec, value: &Value) -> AppResult<Value> {
    let label = &spec.label.en;
    let err = |code: &str, msg: String, extra: Value| AppError::param(&spec.key, code, msg, extra);
    match &spec.kind {
        ParamKind::Enum { values, .. } => {
            if !matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
                return Err(err(
                    "unsupported_value",
                    format!("{label}: unsupported value"),
                    json!({}),
                ));
            }
            let s = rules::js_string(value);
            values
                .iter()
                .find(|a| rules::js_string(a) == s)
                .cloned()
                .ok_or_else(|| {
                    err(
                        "unsupported_value",
                        format!("{label}: unsupported value"),
                        json!({}),
                    )
                })
        }
        ParamKind::Integer { min, max, step, .. } | ParamKind::Number { min, max, step, .. } => {
            let n = finite(value).ok_or_else(|| {
                err(
                    "not_number",
                    format!("{label}: must be a number"),
                    json!({}),
                )
            })?;
            if matches!(spec.kind, ParamKind::Integer { .. }) && n.fract() != 0.0 {
                return Err(err(
                    "not_integer",
                    format!("{label}: must be a whole number"),
                    json!({}),
                ));
            }
            if let Some(step) = step {
                let steps = (n - min) / step;
                if (steps - steps.round()).abs() > 1e-9 {
                    return Err(err(
                        "bad_step",
                        format!("{label}: must be in steps of {}", shown(*step)),
                        json!({"step": step}),
                    ));
                }
            }
            if n < *min || n > *max {
                return Err(err(
                    "out_of_range",
                    format!(
                        "{label}: must be between {} and {}",
                        shown(*min),
                        shown(*max)
                    ),
                    json!({"min": min, "max": max}),
                ));
            }
            Ok(num_value(n))
        }
        ParamKind::Seed { min, max } => {
            let n = finite(value).filter(|n| n.fract() == 0.0);
            match n {
                Some(n) if n >= *min as f64 && n <= *max as f64 => Ok(json!(n as i64)),
                _ => Err(err(
                    "invalid_seed",
                    format!("{label}: invalid seed"),
                    json!({"min": min, "max": max}),
                )),
            }
        }
        ParamKind::Boolean { .. } => match value {
            Value::Bool(_) => Ok(value.clone()),
            _ => Err(err(
                "not_boolean",
                format!("{label}: must be on or off"),
                json!({}),
            )),
        },
        ParamKind::Text { max_length, .. } => match value {
            Value::String(s) if s.chars().count() <= *max_length => Ok(value.clone()),
            _ => Err(err(
                "too_long",
                format!("{label}: too long"),
                json!({"max": max_length}),
            )),
        },
        ParamKind::Media {
            min_items,
            max_items,
            ..
        } => {
            let urls: Vec<&Value> = match value {
                Value::Array(a) => a.iter().collect(),
                Value::String(_) => vec![value],
                _ => vec![],
            };
            if urls.is_empty() {
                return Err(err(
                    "missing_file",
                    format!("{label}: missing file"),
                    json!({}),
                ));
            }
            if urls.len() > *max_items {
                return Err(err(
                    "too_many_files",
                    format!("{label}: at most {max_items} files"),
                    json!({"max": max_items}),
                ));
            }
            let mut out = Vec::new();
            for u in urls {
                match u.as_str() {
                    Some(s)
                        if s.len() <= 4096
                            && (public_https_re().is_match(s) || inline_ref_re().is_match(s)) =>
                    {
                        out.push(Value::String(s.to_string()))
                    }
                    _ => {
                        return Err(err(
                            "invalid_file_url",
                            format!("{label}: invalid file URL"),
                            json!({}),
                        ))
                    }
                }
            }
            if out.len() < *min_items {
                return Err(err(
                    "too_few_files",
                    format!("{label}: at least {min_items} files"),
                    json!({"min": min_items}),
                ));
            }
            Ok(Value::Array(out))
        }
    }
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Mirrors `validateParams` in params.ts.
pub fn validate_params(model: &ModelDef, values: &ParamValues) -> AppResult<ParamValues> {
    if values.len() > 100 {
        return Err(AppError::invalid("Too many parameters.").with_reason("too_many_params"));
    }
    for key in values.keys() {
        if model.param(key).is_none() {
            let k = truncate(key, 64);
            return Err(AppError::param(
                &k,
                "unknown_param",
                format!("Unknown parameter \"{k}\" for {}", model.display_name),
                json!({}),
            ));
        }
    }
    let mut out = Map::new();
    for spec in &model.params {
        let raw = values.get(&spec.key);
        let missing = match raw {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s.is_empty(),
            Some(Value::Array(a)) => a.is_empty(),
            _ => false,
        };
        if missing {
            if spec.required {
                return Err(AppError::param(
                    &spec.key,
                    "required",
                    format!("{} is required", spec.label.en),
                    json!({}),
                ));
            }
            continue;
        }
        out.insert(spec.key.clone(), coerce(spec, raw.unwrap_or(&Value::Null))?);
    }
    Ok(out)
}

pub fn validate_prompt(model: &ModelDef, prompt: &str) -> AppResult<String> {
    let text = prompt.trim();
    if model.prompt.required && text.is_empty() {
        return Err(AppError::param(
            "prompt",
            "prompt_required",
            "A prompt is required",
            json!({}),
        ));
    }
    if text.chars().count() > model.prompt.max_length {
        return Err(AppError::param(
            "prompt",
            "prompt_too_long",
            format!(
                "Prompts are limited to {} characters",
                model.prompt.max_length
            ),
            json!({"max": model.prompt.max_length}),
        ));
    }
    Ok(text.to_string())
}

pub fn validate_negative(model: &ModelDef, neg: Option<&str>) -> AppResult<Option<String>> {
    let Some(raw) = neg.filter(|s| !s.trim().is_empty()) else {
        return Ok(None);
    };
    let Some(spec) = &model.negative_prompt else {
        return Err(AppError::param(
            "negative_prompt",
            "unknown_param",
            "This model has no negative prompt",
            json!({}),
        ));
    };
    if raw.chars().count() > spec.max_length {
        return Err(AppError::param(
            "negative_prompt",
            "too_long",
            "Negative prompt is too long",
            json!({"max": spec.max_length}),
        ));
    }
    Ok(Some(raw.trim().to_string()))
}

pub struct ValidGeneration {
    pub prompt: String,
    pub negative: Option<String>,
    pub values: ParamValues,
}

/// Mirrors `validateGeneration`: prompt, negative prompt, every parameter,
/// then every conditional rule (first violation is reported).
pub fn validate_generation(
    model: &ModelDef,
    prompt: &str,
    negative: Option<&str>,
    params: &ParamValues,
) -> AppResult<ValidGeneration> {
    let prompt = validate_prompt(model, prompt)?;
    let negative = validate_negative(model, negative)?;
    let values = validate_params(model, params)?;
    let ctx = RuleContext {
        values: &values,
        prompt: Some(&prompt),
        negative_prompt: negative.as_deref(),
    };
    if let Some(v) = rules::check_rules(&model.rules, &ctx).into_iter().next() {
        let field = v.params.first().cloned().unwrap_or_default();
        return Err(AppError::param(
            &field,
            "rule",
            v.message.en.clone(),
            json!({"ruleId": v.rule_id}),
        ));
    }
    Ok(ValidGeneration {
        prompt,
        negative,
        values,
    })
}

fn default_of(spec: &ParamSpec) -> Option<Value> {
    match &spec.kind {
        ParamKind::Enum { default, .. } => default.clone(),
        ParamKind::Integer { default, .. } | ParamKind::Number { default, .. } => {
            default.map(num_value)
        }
        ParamKind::Boolean { default, .. } => default.map(Value::Bool),
        _ => None,
    }
}

/// JavaScript-like `parseFloat` (leading numeric prefix, e.g. "8s" → 8).
fn parse_float_prefix(s: &str) -> Option<f64> {
    let s = s.trim_start();
    let mut end = 0;
    for (i, c) in s.char_indices() {
        if c.is_ascii_digit() || c == '.' || ((c == '-' || c == '+') && i == 0) {
            end = i + c.len_utf8();
        } else {
            break;
        }
    }
    s[..end].parse::<f64>().ok().filter(|f| f.is_finite())
}

/// Mirrors `requestedDuration`.
pub fn requested_duration(model: &ModelDef, values: &ParamValues) -> Option<f64> {
    let spec = model.param("duration")?;
    let v = values
        .get("duration")
        .cloned()
        .or_else(|| default_of(spec))?;
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_float_prefix(&s),
        _ => None,
    }
}

/* ── Request body / outputs ────────────────────────────────────────────── */

fn set_dotted(obj: &mut Map<String, Value>, path: &str, value: Value) {
    let mut parts = path.split('.').peekable();
    let mut cur = obj;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            cur.insert(part.to_string(), value);
            return;
        }
        let entry = cur
            .entry(part.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        cur = entry.as_object_mut().expect("object");
    }
}

/// Builds the provider request body from validated values.
/// `contents_list` enables Kling's new-API convention: an apiField
/// `contents.<type>` appends `{type, url}` (or `{type:"prompt", text}`) to a
/// `contents` array instead of nesting.
pub fn build_body(
    model: &ModelDef,
    prompt: &str,
    negative: Option<&str>,
    values: &ParamValues,
    contents_list: bool,
) -> Value {
    let mut body = Map::new();
    let mut contents: Vec<Value> = Vec::new();
    let mut put = |body: &mut Map<String, Value>, field: &str, value: Value| {
        if contents_list {
            if let Some(kind) = field.strip_prefix("contents.") {
                let items = match &value {
                    Value::Array(a) => a.clone(),
                    v => vec![v.clone()],
                };
                for item in items {
                    if kind == "prompt" {
                        contents.push(json!({ "type": "prompt", "text": item }));
                    } else {
                        contents.push(json!({ "type": kind, "url": item }));
                    }
                }
                return;
            }
        }
        set_dotted(body, field, value);
    };
    if !prompt.is_empty() {
        put(
            &mut body,
            &model.prompt.api_field,
            Value::String(prompt.to_string()),
        );
    }
    if let (Some(spec), Some(neg)) = (&model.negative_prompt, negative) {
        put(&mut body, &spec.api_field, Value::String(neg.to_string()));
    }
    for spec in &model.params {
        let Some(v) = values.get(&spec.key) else {
            continue;
        };
        let encoded = match &spec.kind {
            ParamKind::Enum { value_type, .. } if value_type == "number" => match v {
                Value::String(s) => parse_float_prefix(s).map(num_value).unwrap_or(v.clone()),
                _ => v.clone(),
            },
            ParamKind::Boolean {
                encode: Some((on, off)),
                ..
            } => Value::String(if v.as_bool() == Some(true) {
                on.clone()
            } else {
                off.clone()
            }),
            ParamKind::Media { shape, .. } => {
                let arr = match v {
                    Value::Array(a) => a.clone(),
                    other => vec![other.clone()],
                };
                if shape == "url_array" {
                    Value::Array(arr)
                } else {
                    arr.into_iter().next().unwrap_or(Value::Null)
                }
            }
            _ => v.clone(),
        };
        put(&mut body, &spec.api_field, encoded);
    }
    for (k, v) in &model.request.fixed {
        put(&mut body, k, v.clone());
    }
    if !contents.is_empty() {
        body.insert("contents".into(), Value::Array(contents));
    }
    Value::Object(body)
}

/// Extracts output URLs: "video.url", "images[].url", "output", "output[]".
pub fn extract_outputs(result: &Value, path: &str) -> Vec<String> {
    let mut current: Vec<&Value> = vec![result];
    for seg in path.split('.') {
        let (name, flatten) = match seg.strip_suffix("[]") {
            Some(n) => (n, true),
            None => (seg, false),
        };
        let mut next = Vec::new();
        for v in current {
            if let Some(child) = v.get(name) {
                if flatten {
                    if let Value::Array(a) = child {
                        next.extend(a.iter());
                    }
                } else {
                    next.push(child);
                }
            }
        }
        current = next;
    }
    let mut out = Vec::new();
    for v in current {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => out.extend(a.iter().filter_map(|x| x.as_str().map(String::from))),
            _ => {}
        }
    }
    out.retain(|s| !s.is_empty());
    out
}

/// Executable models (bundled manifests ∪ verified registry additions).
pub struct Registry {
    pub models: Vec<Model>,
}

impl Registry {
    /// Bundled manifests (embedded at compile time). Invalid manifests are
    /// logged and skipped (the smoke test reports zero models).
    pub fn bundled() -> Self {
        let mut models = Vec::new();
        for (p, text) in crate::bundled::MANIFESTS {
            match parse_manifest(text, *p) {
                Ok(m) => models.extend(m),
                Err(e) => log::error!("bundled manifest for {} is invalid: {e}", p.as_str()),
            }
        }
        Registry { models }
    }
    pub fn from_models(models: Vec<Model>) -> Self {
        Registry { models }
    }
    pub fn get(&self, id: &str) -> Option<&Model> {
        self.models.iter().find(|m| m.def.id == id)
    }
}

#[cfg(test)]
#[path = "manifest_tests.rs"]
mod tests;
