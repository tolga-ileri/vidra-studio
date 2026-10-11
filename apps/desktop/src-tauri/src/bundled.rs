//! Data embedded from `packages/core` at compile time.

use crate::types::ProviderId;

pub const MANIFESTS: &[(ProviderId, &str)] = &[
    (
        ProviderId::Higgsfield,
        include_str!("../../../../packages/core/manifests/higgsfield.json"),
    ),
    (
        ProviderId::Replicate,
        include_str!("../../../../packages/core/manifests/replicate.json"),
    ),
    (
        ProviderId::Kling,
        include_str!("../../../../packages/core/manifests/kling.json"),
    ),
];

pub const SEED_PROMPTS: &str = include_str!("../../../../packages/core/seed/prompts.json");
