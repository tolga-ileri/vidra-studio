//! Provider settings: status, credentials, verification, enable/disable,
//! (model listing and discovery live in catalog.rs).

use crate::core::Core;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::secrets::{account, validate_value};
use crate::types::*;
use rusqlite::params;
use std::collections::HashMap;

pub fn status(core: &Core, id: ProviderId) -> AppResult<ProviderStatus> {
    let p = core.providers.get(id);
    let row: (i64, String, Option<i64>, Option<String>) = core.db.conn().query_row(
        "SELECT enabled, verification, last_verified_at, last_error FROM providers WHERE id=?1",
        [id.as_str()],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let fields = p.credential_fields();
    let mut configured = true;
    for f in &fields {
        if core.secrets.get(&account(id.as_str(), &f.key))?.is_none() {
            configured = false;
        }
    }
    Ok(ProviderStatus {
        id,
        display_name: id.display_name().into(),
        enabled: row.0 != 0,
        configured,
        verification: row.1,
        last_verified_at: row.2,
        last_error: row.3,
        capabilities: p.capabilities(),
        credential_fields: fields,
        docs_url: p.docs_url().into(),
        integration: "integrated".into(),
    })
}

pub fn list(core: &Core) -> AppResult<Vec<ProviderStatus>> {
    ProviderId::ALL.iter().map(|p| status(core, *p)).collect()
}

pub fn set_credentials(
    core: &Core,
    id: ProviderId,
    mut values: HashMap<String, String>,
) -> AppResult<()> {
    split_combined_key(id, &mut values);
    let p = core.providers.get(id);
    let fields = p.credential_fields();
    for k in values.keys() {
        if !fields.iter().any(|f| &f.key == k) {
            return Err(AppError::invalid("Unknown credential field."));
        }
    }
    for f in &fields {
        let v = values.get(&f.key).map(|s| s.trim()).unwrap_or("");
        if let Err(e) = validate_value(v) {
            // Field + reason let the UI say exactly what is wrong, e.g. a key
            // *name* ("My key") typed where the key ID belongs.
            let reason = if v.is_empty() {
                "empty"
            } else if v.chars().any(char::is_whitespace) {
                "whitespace"
            } else if v.len() > 1024 {
                "too_long"
            } else {
                "invalid_chars"
            };
            return Err(e.with_details(serde_json::json!({
                "code": "credential", "field": f.key, "reason": reason
            })));
        }
    }
    for f in &fields {
        core.secrets
            .set(&account(id.as_str(), &f.key), values[&f.key].trim())?;
    }
    core.db.conn().execute(
        "UPDATE providers SET verification='unknown', last_error=NULL WHERE id=?1",
        [id.as_str()],
    )?;
    core.emit(StoreEvent::ProvidersChanged);
    Ok(())
}

/// Higgsfield shows its key as one "KEY_ID:KEY_SECRET" string. Accept it pasted
/// into either field (the other left empty) by splitting it into both.
fn split_combined_key(id: ProviderId, values: &mut HashMap<String, String>) {
    if id != ProviderId::Higgsfield {
        return;
    }
    let get = |v: &HashMap<String, String>, k: &str| {
        v.get(k).map(|s| s.trim().to_string()).unwrap_or_default()
    };
    let (kid, secret) = (get(values, "key_id"), get(values, "key_secret"));
    // A Higgsfield secret never contains ':', so a colon there always means the
    // whole "KEY_ID:KEY_SECRET" string was pasted, and it wins over whatever is
    // in the ID field (often the key's display name).
    let combined = if secret.contains(':') {
        secret
    } else if kid.contains(':') && (secret.is_empty() || secret == kid) {
        kid
    } else {
        return;
    };
    if let Some((a, b)) = combined.split_once(':') {
        let (a, b) = (a.trim(), b.trim());
        if !a.is_empty() && !b.is_empty() {
            values.insert("key_id".into(), a.into());
            values.insert("key_secret".into(), b.into());
        }
    }
}

pub fn remove_credentials(core: &Core, id: ProviderId) -> AppResult<()> {
    for f in core.providers.get(id).credential_fields() {
        core.secrets.delete(&account(id.as_str(), &f.key))?;
    }
    core.db.conn().execute(
        "UPDATE providers SET verification='unknown', last_verified_at=NULL, last_error=NULL WHERE id=?1",
        [id.as_str()],
    )?;
    core.emit(StoreEvent::ProvidersChanged);
    Ok(())
}

pub async fn verify(core: &Core, id: ProviderId) -> AppResult<ProviderStatus> {
    let creds = core.creds(id)?;
    let p = core.providers.get(id);
    if creds.len() < p.credential_fields().len() {
        return Err(AppError::new(
            ErrorCode::MissingCredentials,
            "Add your API credentials first.",
        ));
    }
    let res = p.validate(&creds).await;
    let now = now_ms();
    match &res {
        Ok(()) => {
            core.db.conn().execute(
                "UPDATE providers SET verification='ok', last_verified_at=?2, last_error=NULL WHERE id=?1",
                params![id.as_str(), now],
            )?;
        }
        Err(e)
            if matches!(
                e.code,
                ErrorCode::InvalidCredentials | ErrorCode::InsufficientCredits
            ) =>
        {
            core.db.conn().execute(
                "UPDATE providers SET verification='failed', last_verified_at=?2, last_error=?3 WHERE id=?1",
                params![id.as_str(), now, e.message],
            )?;
        }
        Err(e) => {
            // Network/server problems do not say anything about the key.
            core.db.conn().execute(
                "UPDATE providers SET last_error=?2 WHERE id=?1",
                params![id.as_str(), e.message],
            )?;
        }
    }
    core.emit(StoreEvent::ProvidersChanged);
    status(core, id)
}

pub fn set_enabled(core: &Core, id: ProviderId, enabled: bool) -> AppResult<()> {
    core.db.conn().execute(
        "UPDATE providers SET enabled=?2 WHERE id=?1",
        params![id.as_str(), enabled as i64],
    )?;
    core.emit(StoreEvent::ProvidersChanged);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::env;

    #[test]
    fn credentials_roundtrip_never_in_db() {
        let e = env();
        let mut v = HashMap::new();
        v.insert("key_id".to_string(), "ID-AAAA".to_string());
        v.insert("key_secret".to_string(), "SECRET-ZZZZ-9999".to_string());
        set_credentials(&e.core, ProviderId::Higgsfield, v).unwrap();
        let s = status(&e.core, ProviderId::Higgsfield).unwrap();
        assert!(s.configured);
        assert_eq!(s.integration, "integrated");
        let json = serde_json::to_string(&list(&e.core).unwrap()).unwrap();
        assert!(!json.contains("SECRET-ZZZZ"));
        // the database file never contains the secret
        e.core
            .db
            .conn()
            .execute_batch("PRAGMA wal_checkpoint(FULL);")
            .unwrap();
        for f in std::fs::read_dir(e.dir.path()).unwrap() {
            let p = f.unwrap().path();
            if p.is_file() {
                let b = std::fs::read(&p).unwrap();
                assert!(!b.windows(16).any(|w| w == b"SECRET-ZZZZ-9999"), "{p:?}");
            }
        }
        let mut bad = HashMap::new();
        bad.insert("api_token".to_string(), "with space".to_string());
        assert!(set_credentials(&e.core, ProviderId::Replicate, bad).is_err());
        let mut unknown = HashMap::new();
        unknown.insert("evil".to_string(), "x".to_string());
        assert!(set_credentials(&e.core, ProviderId::Replicate, unknown).is_err());
        remove_credentials(&e.core, ProviderId::Higgsfield).unwrap();
        assert!(!status(&e.core, ProviderId::Higgsfield).unwrap().configured);
    }
}

#[cfg(test)]
mod split_tests {
    use super::*;

    fn run(kid: &str, secret: &str) -> (String, String) {
        let mut v = HashMap::from([
            ("key_id".to_string(), kid.to_string()),
            ("key_secret".to_string(), secret.to_string()),
        ]);
        split_combined_key(ProviderId::Higgsfield, &mut v);
        (v["key_id"].clone(), v["key_secret"].clone())
    }

    #[test]
    fn splits_a_combined_higgsfield_key_from_either_field() {
        let want = ("id-1".to_string(), "sec-2".to_string());
        assert_eq!(run(" id-1:sec-2 ", ""), want);
        assert_eq!(run("", "id-1:sec-2"), want);
        assert_eq!(run("id-1:sec-2", "id-1:sec-2"), want);
        assert_eq!(run("id-1", "sec-2"), want);
        // Key name in the ID field + full string in the secret field.
        assert_eq!(run("Tolga deneme", "id-1:sec-2"), want);
        assert_eq!(run("Tolgadeneme", " id-1:sec-2 "), want);
    }

    #[test]
    fn a_key_name_in_the_id_field_names_the_field_and_reason() {
        let env = crate::core::testing::env();
        let values = HashMap::from([
            ("key_id".to_string(), "Tolga deneme".to_string()),
            ("key_secret".to_string(), "abc123".to_string()),
        ]);
        let e = set_credentials(&env.core, ProviderId::Higgsfield, values).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidInput);
        let d = e.details.unwrap();
        assert_eq!(d["code"], "credential");
        assert_eq!(d["field"], "key_id");
        assert_eq!(d["reason"], "whitespace");
    }

    #[test]
    fn leaves_other_providers_untouched() {
        let mut v = HashMap::from([("api_token".to_string(), "a:b".to_string())]);
        split_combined_key(ProviderId::Replicate, &mut v);
        assert_eq!(v["api_token"], "a:b");
    }
}
