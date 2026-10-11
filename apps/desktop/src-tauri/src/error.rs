//! Error type returned by every command: `{ code, message, details }`.
//! Messages are always safe to show to the user (never contain secrets).
//! `message` is English; the UI localizes from the stable `code` and the
//! machine-readable `details` (e.g. `{"reason": ...}` or
//! `{"field": ..., "code": <ParamErrorCode>}`).

use serde::Serialize;
use serde_json::Value;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    MissingCredentials,
    InvalidCredentials,
    InsufficientCredits,
    InvalidInput,
    RateLimited,
    Network,
    ProviderError,
    CancelUnsupported,
    CancelTooLate,
    BudgetExceeded,
    ConfirmationRequired,
    SubmitUncertain,
    ProviderDisabled,
    NotFound,
    Io,
    DiskFull,
    UnknownCostAckRequired,
    StorageUnavailable,
    UpdateRequired,
    ModelUnavailable,
    Unknown,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::MissingCredentials => "missing_credentials",
            ErrorCode::InvalidCredentials => "invalid_credentials",
            ErrorCode::InsufficientCredits => "insufficient_credits",
            ErrorCode::InvalidInput => "invalid_input",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::Network => "network",
            ErrorCode::ProviderError => "provider_error",
            ErrorCode::CancelUnsupported => "cancel_unsupported",
            ErrorCode::CancelTooLate => "cancel_too_late",
            ErrorCode::BudgetExceeded => "budget_exceeded",
            ErrorCode::ConfirmationRequired => "confirmation_required",
            ErrorCode::SubmitUncertain => "submit_uncertain",
            ErrorCode::ProviderDisabled => "provider_disabled",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Io => "io",
            ErrorCode::DiskFull => "disk_full",
            ErrorCode::UnknownCostAckRequired => "unknown_cost_ack_required",
            ErrorCode::StorageUnavailable => "storage_unavailable",
            ErrorCode::UpdateRequired => "update_required",
            ErrorCode::ModelUnavailable => "model_unavailable",
            ErrorCode::Unknown => "unknown",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<Value>,
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        AppError {
            code,
            message: message.into(),
            details: None,
        }
    }
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
    /// Adds a machine-readable `reason` (merged into existing details).
    pub fn with_reason(mut self, reason: &str) -> Self {
        let mut map = match self.details.take() {
            Some(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        map.insert("reason".into(), Value::String(reason.to_string()));
        self.details = Some(Value::Object(map));
        self
    }
    /// Parameter validation error with a `ParamErrorCode` (params.ts).
    pub fn param(field: &str, code: &str, message: impl Into<String>, extra: Value) -> Self {
        let mut map = serde_json::Map::new();
        map.insert("field".into(), Value::String(field.to_string()));
        map.insert("code".into(), Value::String(code.to_string()));
        if let Value::Object(e) = extra {
            map.extend(e);
        }
        Self::new(ErrorCode::InvalidInput, message).with_details(Value::Object(map))
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Network, message)
    }
    pub fn provider(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ProviderError, message)
    }
    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unknown, message)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        log::error!("database error: {e}");
        AppError::io("A database error occurred.").with_reason("database")
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        log::warn!("io error: {e}");
        if is_disk_full(&e) {
            return AppError::new(ErrorCode::DiskFull, "The disk is full.");
        }
        let reason = match e.kind() {
            std::io::ErrorKind::PermissionDenied => "permission_denied",
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::AlreadyExists => "already_exists",
            _ => "io",
        };
        AppError::io("A file operation failed.").with_reason(reason)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        log::warn!("json error: {e}");
        AppError::invalid("Invalid data.").with_reason("invalid_json")
    }
}

pub fn is_disk_full(e: &std::io::Error) -> bool {
    // ERROR_DISK_FULL (112) / ERROR_HANDLE_DISK_FULL (39) on Windows, ENOSPC (28) on Unix.
    matches!(e.raw_os_error(), Some(112) | Some(39)) || (cfg!(unix) && e.raw_os_error() == Some(28))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn errors_serialize_with_stable_codes_and_details() {
        let e = AppError::new(ErrorCode::UnknownCostAckRequired, "Pricing unavailable.")
            .with_reason("no_price");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "unknown_cost_ack_required");
        assert_eq!(v["details"]["reason"], "no_price");
        let p = AppError::param(
            "fps",
            "bad_step",
            "Frame rate: must be in steps of 12",
            json!({"step": 12}),
        );
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["code"], "invalid_input");
        assert_eq!(
            v["details"],
            json!({"field": "fps", "code": "bad_step", "step": 12})
        );
        for (code, s) in [
            (ErrorCode::StorageUnavailable, "storage_unavailable"),
            (ErrorCode::UpdateRequired, "update_required"),
            (ErrorCode::ModelUnavailable, "model_unavailable"),
        ] {
            assert_eq!(serde_json::to_value(code).unwrap(), json!(s));
            assert_eq!(code.as_str(), s);
        }
    }

    #[test]
    fn io_errors_carry_a_reason() {
        let e: AppError = std::io::Error::from(std::io::ErrorKind::PermissionDenied).into();
        assert_eq!(e.code, ErrorCode::Io);
        assert_eq!(e.details.unwrap()["reason"], "permission_denied");
        let e: AppError = serde_json::from_str::<u8>("x").unwrap_err().into();
        assert_eq!(e.details.unwrap()["reason"], "invalid_json");
    }
}
