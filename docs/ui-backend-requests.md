# UI → backend contract notes

Open points the renderer works around today. `apps/desktop/src/lib/ipc.ts` is still the authoritative contract.

1. **Storage status events.** No `storage-changed` StoreEvent exists. The UI reloads `storageStatus()` on `settings-changed` and `archive-changed`. When the archive drive is unplugged or reconnected, please emit one of these, or add a dedicated event, so the banner shows up without waiting for some other change.
2. **`finalize_archive_move` refusal.** The UI disables "Remove old copies" whenever `result.failed > 0`. The exact ErrorCode that comes with `details.reason = "move_incomplete"` is not documented. The mock uses `io`. If the backend uses another code, please say which one so the UI can show a specific localized message.
3. **`ArchiveMovePlan.warnings` and `CatalogSyncResult.error` codes.** The UI localizes `network_folder | removable_drive | low_space | not_empty` and `network | signature | schema | compatibility | downgrade`. Any other code is shown as "Warning: <code>" or as the generic failure text. Please keep these lists in sync.
4. **`CatalogEntry.reason`.** This is free text or a code (the mock uses `app_version`). The UI does not display it. It shows a localized explanation based on `state`. If a reason should be shown, please define a list of codes.
5. **Provider verification `lastError`.** This is English backend text. The UI now shows the localized "The provider rejected these credentials." instead. A machine-readable `lastErrorCode` on `ProviderStatus` would allow more specific messages.
6. **`DownloadTask.lastError` and the Archive detail view.** These still fall back to the backend message when `lastErrorCode` is not one of the codes the UI knows.
7. **Parameter labels in `invalid_input` errors.** The UI localizes `details.code`, looking up `details.field` (or `key`) in the loaded models. Please include `details.modelId` so the label lookup is unambiguous.
