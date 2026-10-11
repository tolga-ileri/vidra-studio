//! Conditional capability rules — mirrors `packages/core/src/rules.ts`
//! exactly (checked by the shared vectors in
//! `packages/core/test/vectors/capabilities.json`).
//!
//! Value lookup: `values[param]`; the pseudo-params "prompt" and
//! "negative_prompt" come from the text fields. A value is PRESENT when it is
//! a non-empty string, a non-empty array, a finite number or a boolean.
//! Numbers compare numerically when both sides are numeric, otherwise as
//! strings; booleans compare by identity. `max`/`min` ignore absent and
//! non-numeric values (e.g. "auto"); media arrays use their item count.

use crate::manifest::{check_param_key, Localized};
use crate::types::ParamValues;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq)]
pub enum Condition {
    All(Vec<Condition>),
    Any(Vec<Condition>),
    Eq(String, Value),
    Neq(String, Value),
    In(String, Vec<Value>),
    NotIn(String, Vec<Value>),
    Present(String),
    Absent(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Constraint {
    Required(String),
    Forbidden(String),
    In(String, Vec<Value>),
    Max(String, f64),
    Min(String, f64),
    AnyOf(Vec<String>),
    MaxTotalItems(Vec<String>, f64),
    MaxProduct(Vec<String>, f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub id: String,
    pub when: Option<Condition>,
    pub then: Vec<Constraint>,
    pub message: Localized,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuleViolation {
    pub rule_id: String,
    pub params: Vec<String>,
    pub message: Localized,
}

pub struct RuleContext<'a> {
    pub values: &'a ParamValues,
    pub prompt: Option<&'a str>,
    pub negative_prompt: Option<&'a str>,
}

/* ── Parsing (strict, like the zod schemas) ────────────────────────────── */

fn rule_id_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[a-z0-9_-]{1,48}$").expect("regex"))
}

fn obj<'a>(v: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    v.as_object()
        .ok_or_else(|| format!("{what} must be an object"))
}

fn only_keys(o: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    match o.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(k) => Err(format!("{what}: unknown key {k}")),
        None => Ok(()),
    }
}

fn str_field(o: &Map<String, Value>, k: &str, what: &str) -> Result<String, String> {
    o.get(k)
        .and_then(Value::as_str)
        .map(String::from)
        .ok_or_else(|| format!("{what}: {k} must be a string"))
}

fn param_field(o: &Map<String, Value>, k: &str, what: &str) -> Result<String, String> {
    let p = str_field(o, k, what)?;
    check_param_key(&p).map_err(|_| format!("{what}: invalid param {p}"))?;
    Ok(p)
}

fn finite_num(v: Option<&Value>, what: &str) -> Result<f64, String> {
    v.and_then(Value::as_f64)
        .filter(|f| f.is_finite())
        .ok_or_else(|| format!("{what}: value must be a finite number"))
}

/// Condition/constraint `values`: strings or finite numbers, at least one.
fn value_list(v: Option<&Value>, what: &str) -> Result<Vec<Value>, String> {
    let a = v
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{what}: values must be an array"))?;
    if a.is_empty() {
        return Err(format!("{what}: values must not be empty"));
    }
    for x in a {
        let ok = x.is_string() || x.as_f64().is_some_and(f64::is_finite);
        if !ok {
            return Err(format!("{what}: values must be strings or numbers"));
        }
    }
    Ok(a.clone())
}

fn scalar(v: Option<&Value>, what: &str) -> Result<Value, String> {
    match v {
        Some(Value::String(s)) if s.chars().count() <= 200 => Ok(Value::String(s.clone())),
        Some(Value::Bool(b)) => Ok(Value::Bool(*b)),
        Some(n @ Value::Number(_)) if n.as_f64().is_some_and(f64::is_finite) => Ok(n.clone()),
        _ => Err(format!("{what}: value must be a scalar")),
    }
}

pub fn parse_condition(v: &Value, depth: usize) -> Result<Condition, String> {
    const W: &str = "condition";
    if depth > 16 {
        return Err("condition is nested too deeply".into());
    }
    let o = obj(v, W)?;
    for (k, ctor) in [("all", true), ("any", false)] {
        if o.contains_key(k) {
            only_keys(o, &[k], W)?;
            let items = o[k]
                .as_array()
                .ok_or_else(|| format!("{W}: {k} must be an array"))?;
            if items.is_empty() || items.len() > 10 {
                return Err(format!("{W}: {k} needs 1-10 items"));
            }
            let parsed = items
                .iter()
                .map(|c| parse_condition(c, depth + 1))
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(if ctor {
                Condition::All(parsed)
            } else {
                Condition::Any(parsed)
            });
        }
    }
    let op = str_field(o, "op", W)?;
    let param = param_field(o, "param", W)?;
    match op.as_str() {
        "eq" | "neq" => {
            only_keys(o, &["param", "op", "value"], W)?;
            let value = scalar(o.get("value"), W)?;
            Ok(if op == "eq" {
                Condition::Eq(param, value)
            } else {
                Condition::Neq(param, value)
            })
        }
        "in" | "notIn" => {
            only_keys(o, &["param", "op", "values"], W)?;
            let values = value_list(o.get("values"), W)?;
            Ok(if op == "in" {
                Condition::In(param, values)
            } else {
                Condition::NotIn(param, values)
            })
        }
        "present" | "absent" => {
            only_keys(o, &["param", "op"], W)?;
            Ok(if op == "present" {
                Condition::Present(param)
            } else {
                Condition::Absent(param)
            })
        }
        other => Err(format!("unknown condition op {other}")),
    }
}

/// Condition ops / constraint ops this build understands (catalog checks).
pub const CONDITION_OPS: &[&str] = &["eq", "neq", "in", "notIn", "present", "absent"];
pub const CONSTRAINT_OPS: &[&str] = &[
    "required",
    "forbidden",
    "in",
    "max",
    "min",
    "anyOf",
    "maxTotalItems",
    "maxProduct",
];

pub fn parse_constraint(v: &Value) -> Result<Constraint, String> {
    const W: &str = "constraint";
    let o = obj(v, W)?;
    let op = str_field(o, "op", W)?;
    let params =
        |o: &Map<String, Value>, keys_must_be_params: bool| -> Result<Vec<String>, String> {
            let a = o
                .get("params")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{W}: params must be an array"))?;
            if a.len() < 2 {
                return Err(format!("{W}: params needs at least 2 entries"));
            }
            a.iter()
                .map(|p| {
                    let s = p
                        .as_str()
                        .ok_or_else(|| format!("{W}: params must be strings"))?;
                    if keys_must_be_params {
                        check_param_key(s).map_err(|_| format!("{W}: invalid param {s}"))?;
                    }
                    Ok(s.to_string())
                })
                .collect()
        };
    match op.as_str() {
        "required" | "forbidden" => {
            only_keys(o, &["op", "param"], W)?;
            let p = param_field(o, "param", W)?;
            Ok(if op == "required" {
                Constraint::Required(p)
            } else {
                Constraint::Forbidden(p)
            })
        }
        "in" => {
            only_keys(o, &["op", "param", "values"], W)?;
            Ok(Constraint::In(
                param_field(o, "param", W)?,
                value_list(o.get("values"), W)?,
            ))
        }
        "max" | "min" => {
            only_keys(o, &["op", "param", "value"], W)?;
            let p = param_field(o, "param", W)?;
            let n = finite_num(o.get("value"), W)?;
            Ok(if op == "max" {
                Constraint::Max(p, n)
            } else {
                Constraint::Min(p, n)
            })
        }
        "anyOf" => {
            only_keys(o, &["op", "params"], W)?;
            Ok(Constraint::AnyOf(params(o, false)?))
        }
        "maxTotalItems" => {
            only_keys(o, &["op", "params", "value"], W)?;
            let n = finite_num(o.get("value"), W)?;
            if n <= 0.0 || n.fract() != 0.0 {
                return Err(format!(
                    "{W}: maxTotalItems value must be a positive integer"
                ));
            }
            Ok(Constraint::MaxTotalItems(params(o, true)?, n))
        }
        "maxProduct" => {
            only_keys(o, &["op", "params", "value"], W)?;
            let n = finite_num(o.get("value"), W)?;
            if n <= 0.0 {
                return Err(format!("{W}: maxProduct value must be positive"));
            }
            Ok(Constraint::MaxProduct(params(o, true)?, n))
        }
        other => Err(format!("unknown constraint op {other}")),
    }
}

pub fn parse_rule(v: &Value) -> Result<Rule, String> {
    let o = obj(v, "rule")?;
    only_keys(o, &["id", "when", "then", "message"], "rule")?;
    let id = str_field(o, "id", "rule")?;
    if !rule_id_re().is_match(&id) {
        return Err(format!("invalid rule id {id}"));
    }
    let when = match o.get("when") {
        None => None,
        Some(c) => Some(parse_condition(c, 0).map_err(|e| format!("rule {id}: {e}"))?),
    };
    let then = o
        .get("then")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("rule {id}: then must be an array"))?;
    if then.is_empty() || then.len() > 10 {
        return Err(format!("rule {id}: then needs 1-10 constraints"));
    }
    let then = then
        .iter()
        .map(|c| parse_constraint(c).map_err(|e| format!("rule {id}: {e}")))
        .collect::<Result<Vec<_>, _>>()?;
    let message: Localized =
        serde_json::from_value(o.get("message").cloned().unwrap_or(Value::Null))
            .map_err(|_| format!("rule {id}: invalid message"))?;
    message.check().map_err(|e| format!("rule {id}: {e}"))?;
    Ok(Rule {
        id,
        when,
        then,
        message,
    })
}

/// Every param a condition references.
pub fn condition_params(c: &Condition, out: &mut Vec<String>) {
    match c {
        Condition::All(v) | Condition::Any(v) => v.iter().for_each(|x| condition_params(x, out)),
        Condition::Eq(p, _)
        | Condition::Neq(p, _)
        | Condition::In(p, _)
        | Condition::NotIn(p, _)
        | Condition::Present(p)
        | Condition::Absent(p) => out.push(p.clone()),
    }
}

pub fn constraint_params(k: &Constraint) -> Vec<String> {
    match k {
        Constraint::Required(p)
        | Constraint::Forbidden(p)
        | Constraint::In(p, _)
        | Constraint::Max(p, _)
        | Constraint::Min(p, _) => vec![p.clone()],
        Constraint::AnyOf(ps)
        | Constraint::MaxTotalItems(ps, _)
        | Constraint::MaxProduct(ps, _) => ps.clone(),
    }
}

/* ── Evaluation (rules.ts) ─────────────────────────────────────────────── */

fn lookup<'a>(ctx: &'a RuleContext<'a>, param: &str) -> Option<Value> {
    match param {
        "prompt" => ctx
            .prompt
            .filter(|p| !p.trim().is_empty())
            .map(|p| Value::String(p.to_string())),
        "negative_prompt" => ctx
            .negative_prompt
            .filter(|p| !p.trim().is_empty())
            .map(|p| Value::String(p.to_string())),
        _ => ctx.values.get(param).cloned(),
    }
}

pub fn is_present(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Object(_)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(f64::is_finite),
        Some(Value::Bool(_)) => true,
    }
}

fn numeric_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^-?\d+(\.\d+)?$").expect("regex"))
}

/// `numeric` in rules.ts.
pub fn numeric(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => {
            let t = s.trim();
            if numeric_re().is_match(t) {
                t.parse::<f64>().ok()
            } else {
                None
            }
        }
        _ => None,
    }
}

/// JavaScript `String(value)`.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.fract() == 0.0 && f.abs() < 1e21 {
                format!("{}", f as i64)
            } else {
                format!("{f}")
            }
        }
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

pub fn same_value(a: &Value, b: &Value) -> bool {
    if a.is_boolean() || b.is_boolean() {
        return a == b;
    }
    if let (Some(x), Some(y)) = (numeric(Some(a)), numeric(Some(b))) {
        #[allow(clippy::float_cmp)]
        return x == y;
    }
    js_string(a) == js_string(b)
}

fn magnitude(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Array(a)) => Some(a.len() as f64),
        other => numeric(other),
    }
}

pub fn evaluate(c: &Condition, ctx: &RuleContext) -> bool {
    let check = |p: &str, f: &dyn Fn(Option<&Value>) -> bool| {
        let v = lookup(ctx, p);
        f(v.as_ref())
    };
    match c {
        Condition::All(v) => v.iter().all(|x| evaluate(x, ctx)),
        Condition::Any(v) => v.iter().any(|x| evaluate(x, ctx)),
        Condition::Present(p) => check(p, &|v| is_present(v)),
        Condition::Absent(p) => check(p, &|v| !is_present(v)),
        Condition::Eq(p, val) => check(p, &|v| {
            is_present(v) && v.is_some_and(|v| same_value(v, val))
        }),
        Condition::Neq(p, val) => check(p, &|v| {
            !(is_present(v) && v.is_some_and(|v| same_value(v, val)))
        }),
        Condition::In(p, vals) => check(p, &|v| {
            is_present(v) && v.is_some_and(|v| vals.iter().any(|x| same_value(v, x)))
        }),
        Condition::NotIn(p, vals) => check(p, &|v| {
            !(is_present(v) && v.is_some_and(|v| vals.iter().any(|x| same_value(v, x))))
        }),
    }
}

fn satisfied(k: &Constraint, ctx: &RuleContext) -> bool {
    match k {
        Constraint::Required(p) => is_present(lookup(ctx, p).as_ref()),
        Constraint::Forbidden(p) => !is_present(lookup(ctx, p).as_ref()),
        Constraint::In(p, vals) => {
            let v = lookup(ctx, p);
            !is_present(v.as_ref()) || v.is_some_and(|v| vals.iter().any(|x| same_value(&v, x)))
        }
        Constraint::Max(p, n) | Constraint::Min(p, n) => {
            let v = lookup(ctx, p);
            if !is_present(v.as_ref()) {
                return true;
            }
            match magnitude(v.as_ref()) {
                None => true,
                Some(m) if matches!(k, Constraint::Max(..)) => m <= *n,
                Some(m) => m >= *n,
            }
        }
        Constraint::AnyOf(ps) => ps.iter().any(|p| is_present(lookup(ctx, p).as_ref())),
        Constraint::MaxTotalItems(ps, n) => {
            let mut total = 0.0;
            for p in ps {
                let v = lookup(ctx, p);
                total += match &v {
                    Some(Value::Array(a)) => a.len() as f64,
                    other if is_present(other.as_ref()) => 1.0,
                    _ => 0.0,
                };
            }
            total <= *n
        }
        Constraint::MaxProduct(ps, n) => {
            let mut product = 1.0;
            for p in ps {
                match numeric(lookup(ctx, p).as_ref()) {
                    None => return true,
                    Some(x) => product *= x,
                }
            }
            product <= *n
        }
    }
}

pub fn check_rules(rules: &[Rule], ctx: &RuleContext) -> Vec<RuleViolation> {
    let mut out = Vec::new();
    for rule in rules {
        if let Some(w) = &rule.when {
            if !evaluate(w, ctx) {
                continue;
            }
        }
        for k in &rule.then {
            if !satisfied(k, ctx) {
                out.push(RuleViolation {
                    rule_id: rule.id.clone(),
                    params: constraint_params(k),
                    message: rule.message.clone(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ctx_eval(c: Value, values: Value) -> bool {
        let c = parse_condition(&c, 0).unwrap();
        let values = values.as_object().unwrap().clone();
        evaluate(
            &c,
            &RuleContext {
                values: &values,
                prompt: Some("  "),
                negative_prompt: None,
            },
        )
    }

    #[test]
    fn condition_semantics() {
        assert!(ctx_eval(
            json!({"param": "d", "op": "eq", "value": 5}),
            json!({"d": "5"})
        ));
        assert!(ctx_eval(
            json!({"param": "d", "op": "neq", "value": 5}),
            json!({})
        ));
        assert!(!ctx_eval(
            json!({"param": "d", "op": "in", "values": [1]}),
            json!({})
        ));
        assert!(ctx_eval(
            json!({"param": "d", "op": "notIn", "values": [1]}),
            json!({})
        ));
        assert!(!ctx_eval(
            json!({"param": "a", "op": "eq", "value": true}),
            json!({"a": "true"})
        ));
        assert!(ctx_eval(
            json!({"param": "prompt", "op": "absent"}),
            json!({})
        ));
        assert!(ctx_eval(
            json!({"any": [{"param": "x", "op": "present"}, {"param": "y", "op": "present"}]}),
            json!({"y": [1]})
        ));
        assert!(
            parse_condition(&json!({"param": "d", "op": "eq", "value": 1, "x": 1}), 0).is_err()
        );
        assert!(parse_condition(&json!({"param": "d", "op": "regex"}), 0).is_err());
        assert!(parse_constraint(&json!({"op": "max", "param": "d", "value": "10"})).is_err());
    }

    #[test]
    fn max_ignores_non_numeric() {
        let r = parse_rule(
            &json!({"id": "r", "then": [{"op": "max", "param": "duration", "value": 10}],
            "message": {"en": "x", "tr": "y"}}),
        )
        .unwrap();
        let v = json!({"duration": "auto"}).as_object().unwrap().clone();
        let ctx = RuleContext {
            values: &v,
            prompt: None,
            negative_prompt: None,
        };
        assert!(check_rules(std::slice::from_ref(&r), &ctx).is_empty());
        let v = json!({"duration": 12}).as_object().unwrap().clone();
        let ctx = RuleContext {
            values: &v,
            prompt: None,
            negative_prompt: None,
        };
        assert_eq!(check_rules(&[r], &ctx)[0].rule_id, "r");
    }
}
