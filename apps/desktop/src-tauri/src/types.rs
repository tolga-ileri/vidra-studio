//! Serde mirrors of `packages/core/src/types.ts` (camelCase on the wire).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub type ParamValues = Map<String, Value>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Higgsfield,
    Replicate,
    Kling,
}

impl ProviderId {
    /// Providers with a native adapter in this build. fal.ai is excluded
    /// (owner decision pending provider authorization).
    pub const ALL: [ProviderId; 3] = [
        ProviderId::Higgsfield,
        ProviderId::Replicate,
        ProviderId::Kling,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Higgsfield => "higgsfield",
            ProviderId::Replicate => "replicate",
            ProviderId::Kling => "kling",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == s)
    }
    pub fn display_name(self) -> &'static str {
        match self {
            ProviderId::Higgsfield => "Higgsfield",
            ProviderId::Replicate => "Replicate",
            ProviderId::Kling => "Kling AI",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub validate_credentials: bool,
    pub model_discovery: bool,
    pub estimate_cost: bool,
    pub upload_references: bool,
    pub cancel: bool,
    pub idempotent_submit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialField {
    pub key: String,
    pub label: String,
    pub secret: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: ProviderId,
    pub display_name: String,
    pub enabled: bool,
    pub configured: bool,
    pub verification: String,
    pub last_verified_at: Option<i64>,
    pub last_error: Option<String>,
    pub capabilities: ProviderCapabilities,
    pub credential_fields: Vec<CredentialField>,
    pub docs_url: String,
    pub integration: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Submitting,
    Queued,
    Generating,
    Completed,
    Failed,
    Canceled,
    Blocked,
}

impl JobStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            JobStatus::Submitting => "submitting",
            JobStatus::Queued => "queued",
            JobStatus::Generating => "generating",
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Canceled => "canceled",
            JobStatus::Blocked => "blocked",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "submitting" => JobStatus::Submitting,
            "queued" => JobStatus::Queued,
            "generating" => JobStatus::Generating,
            "completed" => JobStatus::Completed,
            "canceled" => JobStatus::Canceled,
            "blocked" => JobStatus::Blocked,
            _ => JobStatus::Failed,
        }
    }
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            JobStatus::Completed | JobStatus::Failed | JobStatus::Canceled | JobStatus::Blocked
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GenerationJob {
    pub id: String,
    pub provider: ProviderId,
    pub model_id: String,
    pub model_name: String,
    pub workflow: String,
    pub output: String,
    pub provider_request_id: Option<String>,
    pub status: JobStatus,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub params: ParamValues,
    pub requested_duration_sec: Option<f64>,
    pub estimated_cost_usd: Option<f64>,
    pub estimate_source: Option<String>,
    pub confirmed_cost_usd: Option<f64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub prompt_id: Option<String>,
    pub project_id: Option<String>,
    #[serde(default)]
    pub references: Vec<GenerationReference>,
    #[serde(default)]
    pub preserve_identity: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub job_id: String,
    pub output_index: i64,
    pub kind: String,
    pub original_url: String,
    pub local_path: Option<String>,
    pub filename: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub duration_sec: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub thumbnail_path: Option<String>,
    pub download_status: String,
    pub duplicate_of_asset_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveItem {
    pub id: String,
    pub asset_id: String,
    pub project_id: Option<String>,
    pub custom_title: Option<String>,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub asset_id: String,
    pub status: String,
    pub bytes_downloaded: i64,
    pub total_bytes: Option<i64>,
    pub retry_count: i64,
    pub next_attempt_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_error_code: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub job: GenerationJob,
    pub asset: Option<MediaAsset>,
    pub item: Option<ArchiveItem>,
    pub task: Option<DownloadTask>,
    pub state: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveQuery {
    pub search: Option<String>,
    pub provider: Option<ProviderId>,
    pub model_id: Option<String>,
    pub output: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub favorite: Option<bool>,
    /// `undefined` = any project, `null` = no project, string = that project.
    #[serde(default, deserialize_with = "double_option")]
    pub project_id: Option<Option<String>>,
    pub trashed: Option<bool>,
    pub states: Option<Vec<String>>,
    pub sort: Option<String>,
    pub direction: Option<String>,
}

fn double_option<'de, D>(d: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(d)?))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub used_bytes: i64,
    pub saved_count: i64,
    pub trashed_count: i64,
    pub missing_count: i64,
    pub free_bytes: Option<u64>,
    pub archive_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptCategory {
    pub id: String,
    pub name: String,
    pub built_in: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub body: String,
    pub category_id: Option<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub preferred_model_ids: Vec<String>,
    pub parameters: ParamValues,
    pub variable_defaults: BTreeMap<String, String>,
    pub version: i64,
    pub built_in: bool,
    pub source_job_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptVersion {
    pub id: String,
    pub prompt_id: String,
    pub version: i64,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub preferred_model_ids: Vec<String>,
    pub parameters: ParamValues,
    pub variable_defaults: BTreeMap<String, String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptInput {
    pub title: String,
    pub body: String,
    pub category_id: Option<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub preferred_model_ids: Vec<String>,
    pub parameters: ParamValues,
    pub variable_defaults: BTreeMap<String, String>,
    #[serde(default)]
    pub source_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSettings {
    pub daily_limit_usd: Option<f64>,
    pub monthly_limit_usd: Option<f64>,
    pub warn_at_percent: f64,
    pub confirm_before_generate: bool,
}

impl Default for BudgetSettings {
    fn default() -> Self {
        BudgetSettings {
            daily_limit_usd: None,
            monthly_limit_usd: None,
            warn_at_percent: 80.0,
            confirm_before_generate: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub language: String,
    pub onboarding_completed: bool,
    pub auto_save: bool,
    pub download_concurrency: u32,
    pub trash_retention_days: u32,
    pub budget: BudgetSettings,
    pub archive_root: String,
    /// Default folder offered by export dialogs (None = system default).
    #[serde(default)]
    pub export_dir: Option<String>,
    /// Check the signed model registry on launch and periodically.
    #[serde(default = "default_true")]
    pub catalog_auto_sync: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub token: String,
    pub format_version: u32,
    pub created_at: i64,
    pub job_count: usize,
    pub asset_count: usize,
    pub prompt_count: usize,
    pub total_bytes: u64,
    pub duplicate_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported_jobs: usize,
    pub imported_assets: usize,
    pub imported_prompts: usize,
    pub skipped_duplicates: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum StoreEvent {
    JobsChanged,
    ArchiveChanged,
    #[serde(rename_all = "camelCase")]
    DownloadProgress {
        asset_id: String,
        bytes_downloaded: i64,
        total_bytes: Option<i64>,
    },
    PromptsChanged,
    SettingsChanged,
    ProvidersChanged,
    CatalogChanged,
    ReferencesChanged,
    #[serde(rename_all = "camelCase")]
    EditorExport {
        export_id: String,
        /// queued | rendering | validating | completed | failed | canceled
        status: String,
        progress: f64,
        message: Option<String>,
        output_path: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ArchiveMoveProgress {
        token: String,
        processed: usize,
        total: usize,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationInput {
    pub model_id: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub params: ParamValues,
    /// Reference images included in `params`, with what they stand for.
    #[serde(default)]
    pub references: Vec<GenerationReference>,
    /// "Keep character consistency" was on (guidance is part of `prompt`).
    #[serde(default)]
    pub preserve_identity: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitOptions {
    pub idempotency_key: String,
    pub confirmed_estimate_usd: Option<f64>,
    /// Required when the estimate is unavailable or in provider credits:
    /// the user explicitly accepted an unknown monetary charge.
    #[serde(default)]
    pub acknowledge_unknown_cost: bool,
    pub prompt_id: Option<String>,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EstimateBudget {
    pub allowed: bool,
    pub exceeded: Vec<String>,
    pub warnings: Vec<String>,
    pub daily_spent_usd: f64,
    pub monthly_spent_usd: f64,
    pub incomplete: bool,
}

/// Mirrors `Estimate` in apps/desktop/src/lib/ipc.ts.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EstimateResult {
    /// "estimated" | "unavailable"
    pub status: String,
    pub amount: Option<f64>,
    /// "USD" | "credits"
    pub currency: Option<String>,
    pub unit_name: Option<String>,
    /// Amount when the currency is USD (budgets use this only).
    pub usd: Option<f64>,
    pub credits: Option<f64>,
    /// "provider" | "published_rate"
    pub source: Option<String>,
    pub lower_bound: bool,
    pub reason: Option<String>,
    pub verified_at: Option<String>,
    pub pricing_page_url: Option<String>,
    pub budget: EstimateBudget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedReference {
    pub url: String,
    pub kind: String,
    pub name: String,
    pub preview_data_url: Option<String>,
    /// Content hash; identifies the staged file for saving or re-uploading.
    pub sha256: String,
    pub mime: String,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// Set when the upload came from the reference library.
    pub saved_id: Option<String>,
}

/// A reference image attached to one generation, as sent to the provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationReference {
    pub param_key: String,
    pub url: String,
    pub name: String,
    pub ref_type: String,
    pub sha256: String,
    pub saved_id: Option<String>,
}

/// An image kept in the local reference library for reuse.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceAsset {
    pub id: String,
    pub name: String,
    pub ref_type: String,
    pub kind: String,
    pub mime: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub preview_data_url: Option<String>,
    pub use_count: i64,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub url: String,
    pub newer: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadListEntry {
    pub task: DownloadTask,
    pub asset: MediaAsset,
    pub job: GenerationJob,
}

/* ── Catalog / storage (mirrors packages/core/src/types.ts) ──────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub model: Value,
    /// bundled | new | updated | deprecated | discontinued | update_required
    pub state: String,
    pub executable: bool,
    pub reason: Option<String>,
    pub registry_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    pub version: String,
    /// "bundled" | "registry"
    pub source: String,
    pub last_checked_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub last_error: Option<String>,
    pub auto_sync: bool,
    pub counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSyncResult {
    pub checked_at: i64,
    /// updated | up_to_date | failed | skipped_active_jobs
    pub outcome: String,
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub deprecated: Vec<String>,
    pub discontinued: Vec<String>,
    pub update_required: Vec<String>,
    /// network | signature | schema | compatibility | downgrade
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub archive_root: String,
    pub available: bool,
    pub is_network: bool,
    pub is_removable: bool,
    pub free_bytes: Option<u64>,
    pub used_bytes: i64,
    pub export_dir: Option<String>,
    pub downloads_paused: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMovePlan {
    pub token: String,
    pub from: String,
    pub to: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub free_bytes: Option<u64>,
    pub is_network: bool,
    pub is_removable: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMoveResult {
    pub token: String,
    pub copied: usize,
    pub verified: usize,
    pub failed: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub token: String,
    pub name: String,
    pub kind: String,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok() && s.len() == 36
}

/// IDs are UUIDs, except built-in categories (`builtin-<slug>`).
pub fn validate_id(s: &str) -> crate::error::AppResult<()> {
    let ok = is_uuid(s)
        || (s.starts_with("builtin-")
            && s.len() <= 64
            && s[8..]
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    if ok {
        Ok(())
    } else {
        Err(crate::error::AppError::invalid("Invalid identifier."))
    }
}
