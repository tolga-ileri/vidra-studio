//! Pre-submit cost estimate from a model's documented pricing — mirrors
//! `packages/core/src/pricing.ts` exactly (shared vectors in
//! `packages/core/test/vectors/capabilities.json`).
//!
//! Never invents a number: anything not covered by a verified, fresh formula
//! is "unavailable" with a reason. Credits are never converted to money.

use crate::manifest::{check_param_key, ModelDef};
use crate::rules::{evaluate, parse_condition, Condition, RuleContext};
use crate::types::ParamValues;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PricingStatus {
    Verified,
    ProviderEstimate,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Formula {
    PerSecond {
        rate: f64,
        duration_param: Option<String>,
        fixed_seconds: Option<f64>,
    },
    PerOutput {
        rate: f64,
        count_param: Option<String>,
    },
    PerMegapixel {
        rate: f64,
        width_param: String,
        height_param: String,
        count_param: Option<String>,
    },
    PerRequest {
        rate: f64,
    },
    ComputeTime,
}

pub const FORMULA_KINDS: &[&str] = &[
    "per_second",
    "per_output",
    "per_megapixel",
    "per_request",
    "compute_time",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Adjustment {
    pub when: Condition,
    pub rate: Option<f64>,
    pub multiplier: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Pricing {
    pub status: PricingStatus,
    /// "USD" | "credits"
    pub currency: String,
    pub unit_name: Option<String>,
    pub formula: Option<Formula>,
    pub adjustments: Vec<Adjustment>,
    pub from: bool,
    pub source: Option<String>,
    pub pricing_page_url: Option<String>,
    pub verified_at: Option<String>,
    pub max_age_days: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PriceEstimate {
    Estimated {
        amount: f64,
        currency: String,
        unit_name: Option<String>,
        lower_bound: bool,
        source: Option<String>,
        verified_at: Option<String>,
    },
    Unavailable {
        /// no_price | outdated | compute_time | missing_input | provider_estimate
        reason: &'static str,
        pricing_page_url: Option<String>,
    },
}

/* ── Parsing (strict, like pricingSchema) ──────────────────────────────── */

fn date_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").expect("regex"))
}

pub fn is_date(s: &str) -> bool {
    date_re().is_match(s)
}

pub fn is_url(s: &str) -> bool {
    url::Url::parse(s).is_ok()
}

fn only_keys(o: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    match o.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(format!("{what}: unknown key {k}")),
        None => Ok(()),
    }
}

fn nonneg(o: &Map<String, Value>, k: &str, what: &str) -> Result<f64, String> {
    o.get(k)
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite() && *f >= 0.0)
        .ok_or_else(|| format!("{what}: {k} must be a number ≥ 0"))
}

fn opt_key(o: &Map<String, Value>, k: &str, what: &str) -> Result<Option<String>, String> {
    match o.get(k) {
        None => Ok(None),
        Some(Value::String(s)) if check_param_key(s).is_ok() => Ok(Some(s.clone())),
        Some(_) => Err(format!("{what}: invalid {k}")),
    }
}

fn req_key(o: &Map<String, Value>, k: &str, what: &str) -> Result<String, String> {
    opt_key(o, k, what)?.ok_or_else(|| format!("{what}: {k} is required"))
}

pub fn parse_formula(v: &Value) -> Result<Formula, String> {
    const W: &str = "pricing.formula";
    let o = v.as_object().ok_or(format!("{W} must be an object"))?;
    let kind = o
        .get("kind")
        .and_then(Value::as_str)
        .ok_or(format!("{W}: kind missing"))?;
    match kind {
        "per_second" => {
            only_keys(o, &["kind", "rate", "durationParam", "fixedSeconds"], W)?;
            let fixed = match o.get("fixedSeconds") {
                None => None,
                Some(x) => Some(
                    x.as_f64()
                        .filter(|f| f.is_finite() && *f > 0.0)
                        .ok_or(format!("{W}: fixedSeconds must be positive"))?,
                ),
            };
            Ok(Formula::PerSecond {
                rate: nonneg(o, "rate", W)?,
                duration_param: opt_key(o, "durationParam", W)?,
                fixed_seconds: fixed,
            })
        }
        "per_output" => {
            only_keys(o, &["kind", "rate", "countParam"], W)?;
            Ok(Formula::PerOutput {
                rate: nonneg(o, "rate", W)?,
                count_param: opt_key(o, "countParam", W)?,
            })
        }
        "per_megapixel" => {
            only_keys(
                o,
                &["kind", "rate", "widthParam", "heightParam", "countParam"],
                W,
            )?;
            Ok(Formula::PerMegapixel {
                rate: nonneg(o, "rate", W)?,
                width_param: req_key(o, "widthParam", W)?,
                height_param: req_key(o, "heightParam", W)?,
                count_param: opt_key(o, "countParam", W)?,
            })
        }
        "per_request" => {
            only_keys(o, &["kind", "rate"], W)?;
            Ok(Formula::PerRequest {
                rate: nonneg(o, "rate", W)?,
            })
        }
        "compute_time" => {
            only_keys(o, &["kind", "ratePerSecond", "hardware"], W)?;
            nonneg(o, "ratePerSecond", W)?;
            match o.get("hardware") {
                Some(Value::String(h)) if h.chars().count() <= 60 => Ok(Formula::ComputeTime),
                _ => Err(format!("{W}: hardware must be a short string")),
            }
        }
        other => Err(format!("unknown pricing formula kind {other}")),
    }
}

fn nullable_string(
    o: &Map<String, Value>,
    k: &str,
    check: fn(&str) -> bool,
) -> Result<Option<String>, String> {
    match o.get(k) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if check(s) => Ok(Some(s.clone())),
        Some(_) => Err(format!("pricing: invalid {k}")),
        None => Err(format!("pricing: {k} is required (may be null)")),
    }
}

pub fn parse_pricing(v: &Value) -> Result<Pricing, String> {
    const W: &str = "pricing";
    let o = v.as_object().ok_or("pricing must be an object")?;
    only_keys(
        o,
        &[
            "status",
            "currency",
            "unitName",
            "formula",
            "adjustments",
            "from",
            "source",
            "pricingPageUrl",
            "verifiedAt",
            "maxAgeDays",
            "notes",
        ],
        W,
    )?;
    let status = match o.get("status").and_then(Value::as_str) {
        Some("verified") => PricingStatus::Verified,
        Some("provider_estimate") => PricingStatus::ProviderEstimate,
        Some("unavailable") => PricingStatus::Unavailable,
        _ => return Err("pricing: invalid status".into()),
    };
    let currency = match o.get("currency").and_then(Value::as_str) {
        Some(c @ ("USD" | "credits")) => c.to_string(),
        _ => return Err("pricing: currency must be USD or credits".into()),
    };
    let unit_name = match o.get("unitName") {
        None => None,
        Some(Value::String(s)) if s.chars().count() <= 40 => Some(s.clone()),
        Some(_) => return Err("pricing: invalid unitName".into()),
    };
    let formula = match o.get("formula") {
        None => None,
        Some(f) => Some(parse_formula(f)?),
    };
    let mut adjustments = Vec::new();
    if let Some(a) = o.get("adjustments") {
        let a = a
            .as_array()
            .ok_or("pricing: adjustments must be an array")?;
        if a.len() > 40 {
            return Err("pricing: too many adjustments".into());
        }
        for adj in a {
            let ao = adj
                .as_object()
                .ok_or("pricing: adjustment must be an object")?;
            only_keys(
                ao,
                &["when", "rate", "multiplier", "note"],
                "pricing.adjustment",
            )?;
            let when = parse_condition(
                ao.get("when")
                    .ok_or("pricing.adjustment: when is required")?,
                0,
            )?;
            let rate = match ao.get("rate") {
                None => None,
                Some(_) => Some(nonneg(ao, "rate", "pricing.adjustment")?),
            };
            let multiplier = match ao.get("multiplier") {
                None => None,
                Some(m) => Some(
                    m.as_f64()
                        .filter(|f| f.is_finite() && *f > 0.0)
                        .ok_or("pricing.adjustment: multiplier must be positive")?,
                ),
            };
            if let Some(n) = ao.get("note") {
                if !n.as_str().is_some_and(|s| s.chars().count() <= 200) {
                    return Err("pricing.adjustment: invalid note".into());
                }
            }
            adjustments.push(Adjustment {
                when,
                rate,
                multiplier,
            });
        }
    }
    let from = match o.get("from") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("pricing: from must be a boolean".into()),
    };
    let max_age_days = match o.get("maxAgeDays") {
        None => 120,
        Some(v) => v
            .as_i64()
            .filter(|d| (1..=365).contains(d))
            .ok_or("pricing: maxAgeDays must be 1-365")?,
    };
    if let Some(n) = o.get("notes") {
        if !n.as_str().is_some_and(|s| s.chars().count() <= 500) {
            return Err("pricing: invalid notes".into());
        }
    }
    Ok(Pricing {
        status,
        currency,
        unit_name,
        formula,
        adjustments,
        from,
        source: nullable_string(o, "source", is_url)?,
        pricing_page_url: nullable_string(o, "pricingPageUrl", is_url)?,
        verified_at: nullable_string(o, "verifiedAt", is_date)?,
        max_age_days,
    })
}

/* ── Estimation (pricing.ts) ───────────────────────────────────────────── */

const DAY_MS: i64 = 86_400_000;

pub fn is_pricing_outdated(p: &Pricing, now_ms: i64) -> bool {
    let Some(v) = &p.verified_at else {
        return true;
    };
    let Ok(d) = chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d") else {
        return true;
    };
    let verified = d
        .and_hms_opt(0, 0, 0)
        .map(|t| t.and_utc().timestamp_millis());
    match verified {
        Some(ms) => now_ms - ms > p.max_age_days * DAY_MS,
        None => true,
    }
}

fn num_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(\d+(?:\.\d+)?)").expect("regex"))
}

/// `num` in pricing.ts (leading unsigned decimal of a string, e.g. "8s").
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => num_re()
            .captures(s.trim())
            .and_then(|c| c[1].parse::<f64>().ok()),
        _ => None,
    }
}

fn value_of(model: &ModelDef, values: &ParamValues, key: &str) -> Option<Value> {
    match values.get(key) {
        Some(v) if !v.is_null() => Some(v.clone()),
        _ => model.default_of(key),
    }
}

pub fn estimate_price(
    model: &ModelDef,
    values: &ParamValues,
    now_ms: i64,
    prompt: Option<&str>,
    negative_prompt: Option<&str>,
) -> PriceEstimate {
    let p = &model.pricing;
    let unavailable = |reason: &'static str| PriceEstimate::Unavailable {
        reason,
        pricing_page_url: p.pricing_page_url.clone(),
    };
    if p.status == PricingStatus::ProviderEstimate {
        return unavailable("provider_estimate");
    }
    let Some(f) = p
        .formula
        .as_ref()
        .filter(|_| p.status != PricingStatus::Unavailable)
    else {
        return unavailable("no_price");
    };
    if is_pricing_outdated(p, now_ms) {
        return unavailable("outdated");
    }
    let base_rate = match f {
        Formula::ComputeTime => return unavailable("compute_time"),
        Formula::PerSecond { rate, .. }
        | Formula::PerOutput { rate, .. }
        | Formula::PerMegapixel { rate, .. }
        | Formula::PerRequest { rate } => *rate,
    };
    let mut effective = values.clone();
    for spec in &model.params {
        if matches!(effective.get(&spec.key), None | Some(Value::Null)) {
            if let Some(d) = model.default_of(&spec.key) {
                effective.insert(spec.key.clone(), d);
            }
        }
    }
    let ctx = RuleContext {
        values: &effective,
        prompt,
        negative_prompt,
    };
    let mut rate = base_rate;
    let mut multiplier = 1.0;
    let mut overridden = false;
    for adj in &p.adjustments {
        if !evaluate(&adj.when, &ctx) {
            continue;
        }
        if let (Some(r), false) = (adj.rate, overridden) {
            rate = r;
            overridden = true;
        }
        if let Some(m) = adj.multiplier {
            multiplier *= m;
        }
    }
    let count = |param: &Option<String>| match param {
        Some(k) => num(value_of(model, values, k).as_ref()),
        None => Some(1.0),
    };
    let quantity = match f {
        Formula::PerSecond {
            duration_param,
            fixed_seconds,
            ..
        } => fixed_seconds.or_else(|| {
            num(value_of(
                model,
                values,
                duration_param.as_deref().unwrap_or("duration"),
            )
            .as_ref())
        }),
        Formula::PerOutput { count_param, .. } => count(count_param),
        Formula::PerMegapixel {
            width_param,
            height_param,
            count_param,
            ..
        } => {
            let w = num(value_of(model, values, width_param).as_ref());
            let h = num(value_of(model, values, height_param).as_ref());
            match (w, h, count(count_param)) {
                (Some(w), Some(h), Some(c)) => Some((w * h) / 1_000_000.0 * c),
                _ => None,
            }
        }
        Formula::PerRequest { .. } => Some(1.0),
        Formula::ComputeTime => None,
    };
    let Some(q) = quantity.filter(|q| *q > 0.0) else {
        return unavailable("missing_input");
    };
    let amount = (rate * multiplier * q * 1e6).round() / 1e6;
    PriceEstimate::Estimated {
        amount,
        currency: p.currency.clone(),
        unit_name: p.unit_name.clone(),
        lower_bound: p.from,
        source: p.source.clone(),
        verified_at: p.verified_at.clone(),
    }
}
