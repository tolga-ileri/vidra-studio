//! Credential storage. Values live only in the OS credential store
//! (service `dev.tolgaileri.vidra`, account `<provider>:<field>`). They are
//! never logged, never returned to the renderer and never written to SQLite.

use crate::error::{AppError, AppResult, ErrorCode};
use std::collections::HashMap;
use std::sync::Mutex;

pub const SERVICE: &str = "dev.tolgaileri.vidra";

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> AppResult<Option<String>>;
    fn set(&self, account: &str, value: &str) -> AppResult<()>;
    fn delete(&self, account: &str) -> AppResult<()>;
}

pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new() -> Self {
        KeyringStore {
            service: SERVICE.to_string(),
        }
    }
    pub fn with_service(service: &str) -> Self {
        KeyringStore {
            service: service.to_string(),
        }
    }
    fn entry(&self, account: &str) -> AppResult<keyring::Entry> {
        keyring::Entry::new(&self.service, account).map_err(|_| store_error())
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

fn store_error() -> AppError {
    // Never include the underlying error: some backends echo attributes.
    AppError::new(
        ErrorCode::Io,
        "The system credential store is not available.",
    )
}

impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        match self.entry(account)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(store_error()),
        }
    }
    fn set(&self, account: &str, value: &str) -> AppResult<()> {
        self.entry(account)?
            .set_password(value)
            .map_err(|_| store_error())
    }
    fn delete(&self, account: &str) -> AppResult<()> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(store_error()),
        }
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore {
    map: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> AppResult<Option<String>> {
        Ok(self
            .map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(account)
            .cloned())
    }
    fn set(&self, account: &str, value: &str) -> AppResult<()> {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> AppResult<()> {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(account);
        Ok(())
    }
}

/// A credential value wrapper whose Debug/Display never reveal the value.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(s: impl Into<String>) -> Self {
        Secret(s.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("***")
    }
}

pub fn account(provider: &str, field: &str) -> String {
    format!("{provider}:{field}")
}

/// Validates a credential value: printable ASCII, no whitespace, bounded.
pub fn validate_value(v: &str) -> AppResult<()> {
    if v.is_empty() || v.len() > 1024 || !v.chars().all(|c| c.is_ascii_graphic()) {
        return Err(AppError::invalid(
            "Credentials must be 1–1024 printable characters without spaces.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod identity_tests {
    /// Credentials and the default archive folder follow the app identity.
    /// The shipped identity must keep matching what existing installs use.
    #[test]
    fn shipped_identity_keeps_existing_credentials_and_archive() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], super::SERVICE);
        assert_eq!(conf["productName"], "Vidra Studio");
    }

    /// Settings shows the Cargo version while the updater compares the
    /// tauri.conf.json version; they must never drift apart.
    #[test]
    fn app_and_updater_versions_match() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["version"], env!("CARGO_PKG_VERSION"));
    }
}
