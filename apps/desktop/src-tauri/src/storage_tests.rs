use super::*;
use crate::core::testing::*;
use crate::manifest::Registry;

const ROOT_NAME: &str = "Vidra Arşiv Çalışma";

fn set_root(core: &Core, root: &Path) {
    let mut s = crate::settings::get(core);
    s.archive_root = root.to_string_lossy().into_owned();
    crate::settings::save(core, &s).unwrap();
}

/// Saves one asset (media + thumbnail) under the root; returns (asset id, rel).
fn seed_saved(core: &Core, root: &Path, n: u8) -> (String, String) {
    let job = new_id();
    let asset = new_id();
    let rel = format!("media/2026/10/{asset}.mp4");
    let thumb = format!("thumbs/{asset}.jpg");
    let bytes = vec![n; 4096];
    std::fs::create_dir_all(root.join("media/2026/10")).unwrap();
    std::fs::create_dir_all(root.join("thumbs")).unwrap();
    std::fs::write(root.join(&rel), &bytes).unwrap();
    std::fs::write(root.join(&thumb), [n, n, n]).unwrap();
    let sha = hex::encode(Sha256::digest(&bytes));
    let c = core.db.conn();
    c.execute("INSERT INTO generation_jobs (id,provider,model_id,model_name,workflow,output,status,prompt,params_json,idempotency_key,created_at,updated_at) VALUES (?1,'replicate','replicate:m','M','text-to-video','video','completed','p','{}',?1,1,1)", params![job]).unwrap();
    c.execute("INSERT INTO media_assets (id,job_id,output_index,kind,original_url,local_path,filename,size_bytes,sha256,thumbnail_path,download_status,created_at) VALUES (?1,?2,0,'video','https://cdn.example.com/a.mp4',?3,'a.mp4',4096,?4,?5,'saved',1)", params![asset, job, rel, sha, thumb]).unwrap();
    (asset, rel)
}

fn seed_pending_task(core: &Core) -> String {
    let job = new_id();
    let asset = new_id();
    let c = core.db.conn();
    c.execute("INSERT INTO generation_jobs (id,provider,model_id,model_name,workflow,output,status,prompt,params_json,idempotency_key,created_at,updated_at) VALUES (?1,'replicate','replicate:m','M','text-to-video','video','completed','p','{}',?1,1,1)", params![job]).unwrap();
    c.execute("INSERT INTO media_assets (id,job_id,output_index,kind,original_url,filename,download_status,created_at) VALUES (?1,?2,0,'video','https://cdn.example.com/b.mp4','b.mp4','pending',1)", params![asset, job]).unwrap();
    c.execute(
        "INSERT INTO download_tasks (id,asset_id,status,updated_at) VALUES (?1,?2,'pending',1)",
        params![new_id(), asset],
    )
    .unwrap();
    asset
}

fn task_state(core: &Core, asset: &str) -> (String, Option<String>) {
    core.db
        .conn()
        .query_row(
            "SELECT status, last_error_code FROM download_tasks WHERE asset_id=?1",
            [asset],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
}

fn setup() -> (TestEnv, PathBuf) {
    let e = env_with(None, Registry::from_models(vec![]), None);
    let root = e.dir.path().join(ROOT_NAME);
    std::fs::create_dir_all(&root).unwrap();
    set_root(&e.core, &root);
    (e, root)
}

#[test]
fn unicode_root_with_spaces_is_available() {
    let (e, root) = setup();
    seed_saved(&e.core, &root, 1);
    let st = status(&e.core).unwrap();
    assert!(st.available, "{st:?}");
    assert!(st.archive_root.contains(ROOT_NAME));
    assert_eq!(st.used_bytes, 4096);
    assert!(!st.downloads_paused);
    assert!(
        !root.join(".tmp").read_dir().unwrap().any(|_| true),
        "probe file removed"
    );
}

#[test]
fn move_copies_verifies_and_keeps_old_files_by_default() {
    let (e, root) = setup();
    let (_, rel) = seed_saved(&e.core, &root, 1);
    let target = e.dir.path().join("Hedef Klasör");
    std::fs::create_dir_all(&target).unwrap();
    let plan = plan_move(&e.core, &target).unwrap();
    assert_eq!(plan.file_count, 2);
    assert_eq!(plan.total_bytes, 4099);
    let r = start_move(&e.core, &plan.token).unwrap();
    assert_eq!((r.copied, r.verified, r.failed), (2, 2, 0));
    assert!(e.sink.0.lock().unwrap().iter().any(|ev| matches!(
        ev,
        StoreEvent::ArchiveMoveProgress {
            processed: 2,
            total: 2,
            ..
        }
    )));
    let (s, _, _) = finalize_move(&e.core, &plan.token, false).unwrap();
    assert!(s.archive_root.contains("Hedef Klasör"));
    assert!(root.join(&rel).is_file(), "old copy kept");
    assert!(target.join(&rel).is_file());
    assert!(crate::archive::verify_files(&e.core).unwrap() == 0);
}

#[test]
fn remove_old_copies_deletes_only_managed_files() {
    let (e, root) = setup();
    let (_, rel) = seed_saved(&e.core, &root, 2);
    std::fs::write(root.join("my notes.txt"), b"keep").unwrap();
    std::fs::write(root.join("media/2026/10/unrelated.mp4"), b"keep").unwrap();
    let target = e.dir.path().join("new");
    std::fs::create_dir_all(&target).unwrap();
    let plan = plan_move(&e.core, &target).unwrap();
    start_move(&e.core, &plan.token).unwrap();
    finalize_move(&e.core, &plan.token, true).unwrap();
    assert!(!root.join(&rel).exists());
    assert!(root.join("my notes.txt").is_file());
    assert!(root.join("media/2026/10/unrelated.mp4").is_file());
    assert!(target.join(&rel).is_file());
}

#[test]
fn destination_conflicts_are_kept_and_block_finalize() {
    let (e, root) = setup();
    let (_, rel) = seed_saved(&e.core, &root, 3);
    let target = e.dir.path().join("dest");
    std::fs::create_dir_all(target.join("media/2026/10")).unwrap();
    std::fs::write(target.join(&rel), b"someone else's file").unwrap();
    let plan = plan_move(&e.core, &target).unwrap();
    assert!(plan.warnings.contains(&"not_empty".to_string()));
    let r = start_move(&e.core, &plan.token).unwrap();
    assert_eq!((r.copied, r.failed), (1, 1));
    assert_eq!(r.failures, vec![rel.clone()]);
    assert_eq!(
        std::fs::read(target.join(&rel)).unwrap(),
        b"someone else's file"
    );
    let err = finalize_move(&e.core, &plan.token, true).unwrap_err();
    assert_eq!(err.details.unwrap()["reason"], "move_incomplete");
    assert!(root.join(&rel).is_file());
    cancel_move(&e.core, &plan.token).unwrap();
    assert_eq!(
        std::fs::read(target.join(&rel)).unwrap(),
        b"someone else's file",
        "not ours: kept"
    );
    assert!(
        !target.join("thumbs").read_dir().unwrap().any(|_| true),
        "our copy removed"
    );
}

#[test]
fn nested_targets_are_rejected() {
    let (e, root) = setup();
    let inner = root.join("sub");
    std::fs::create_dir_all(&inner).unwrap();
    let err = plan_move(&e.core, &inner).unwrap_err();
    assert_eq!(err.details.unwrap()["reason"], "nested_folder");
    let err = plan_move(&e.core, e.dir.path()).unwrap_err();
    assert_eq!(err.details.unwrap()["reason"], "nested_folder");
}

#[test]
fn unplugged_root_pauses_downloads_and_reconnect_validates_content() {
    let (e, root) = setup();
    seed_saved(&e.core, &root, 4);
    let asset = seed_pending_task(&e.core);
    let moved = e.dir.path().join("E-drive copy");
    std::fs::rename(&root, &moved).unwrap(); // "unplug"
    let st = status(&e.core).unwrap();
    assert!(!st.available);
    assert!(!root.exists(), "a missing custom root is never recreated");
    assert!(!reconcile_downloads(&e.core));
    assert_eq!(
        task_state(&e.core, &asset),
        ("paused".into(), Some("storage_unavailable".into()))
    );
    assert!(status(&e.core).unwrap().downloads_paused);
    // reconnecting to an unrelated folder is refused
    let empty = e.dir.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let err = reconnect(&e.core, &empty).unwrap_err();
    assert_eq!(err.details.unwrap()["reason"], "no_matching_files");
    // the real folder (new location) is accepted by content
    let (st, _) = reconnect(&e.core, &moved).unwrap();
    assert!(st.available && !st.downloads_paused);
    assert_eq!(task_state(&e.core, &asset).0, "pending");
    // plug back into the old location: downloads resume automatically
    set_root(&e.core, &root);
    assert!(!reconcile_downloads(&e.core));
    std::fs::rename(&moved, &root).unwrap();
    assert!(reconcile_downloads(&e.core));
    assert_eq!(task_state(&e.core, &asset), ("pending".into(), None));
}

#[test]
fn permission_failures_are_reported_without_panics() {
    let (e, root) = setup();
    let (_, rel) = seed_saved(&e.core, &root, 5);
    let target = e.dir.path().join("ro");
    std::fs::create_dir_all(target.join("media/2026/10")).unwrap();
    let mut part = target.join(&rel).into_os_string();
    part.push(".vidra-part");
    let part = PathBuf::from(part);
    std::fs::write(&part, b"x").unwrap();
    let mut perm = std::fs::metadata(&part).unwrap().permissions();
    perm.set_readonly(true);
    std::fs::set_permissions(&part, perm.clone()).unwrap();
    let plan = plan_move(&e.core, &target).unwrap();
    let r = start_move(&e.core, &plan.token).unwrap();
    assert_eq!(r.failed, 1);
    assert_eq!(r.failures, vec![rel.clone()]);
    assert!(!target.join(&rel).exists());
    // export folder: a read-only *file* is not a writable folder
    let err = set_export_dir(&e.core, &part).unwrap_err();
    assert_eq!(err.code, ErrorCode::Io);
    #[allow(clippy::permissions_set_readonly_false)]
    perm.set_readonly(false);
    std::fs::set_permissions(&part, perm).unwrap();
    // a writable folder is accepted
    let s = set_export_dir(&e.core, &target).unwrap();
    assert!(s.export_dir.unwrap().ends_with("ro"));
    assert_eq!(export_dir(&e.core).unwrap().file_name().unwrap(), "ro");
}
