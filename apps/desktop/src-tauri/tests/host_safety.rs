//! Host-safety guard: the native backend must never contain code that
//! shuts down / restarts the machine, edits the registry, firewall or
//! Defender policy, formats disks, or spawns a shell. Vidra Studio also never
//! needs elevation (per-user NSIS install, no requireAdministrator manifest).

use std::path::{Path, PathBuf};

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

#[test]
fn no_forbidden_host_operations_in_src() {
    const FORBIDDEN: &[&str] = &[
        "shutdown",
        "restart-computer",
        "stop-computer",
        "reboot",
        "exitwindowsex",
        "initiatesystemshutdown",
        "initiateshutdown",
        "reg add",
        "reg delete",
        "regsetvalue",
        "regcreatekey",
        "netsh",
        "set-mppreference",
        "add-mppreference",
        "diskpart",
        "format-volume",
        "bcdedit",
        "runas",
        "command::new(\"cmd",
        "command::new(\"powershell",
        "command::new(\"pwsh",
        "shellexecute",
    ];
    // "format <drive>:" / "format /" (the disk-format command), not format!().
    let format_cmd = regex::Regex::new(r#"(?i)["'\s]format\s+([a-z]:|/[a-z])"#).unwrap();
    let mut files = Vec::new();
    rust_files(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut files,
    );
    assert!(files.len() > 10);
    let mut hits = Vec::new();
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap().to_ascii_lowercase();
        for bad in FORBIDDEN {
            if text.contains(bad) {
                hits.push(format!("{}: {bad}", f.display()));
            }
        }
        if format_cmd.is_match(&text) {
            hits.push(format!("{}: format command", f.display()));
        }
    }
    assert!(hits.is_empty(), "forbidden host operations: {hits:#?}");
}

#[test]
fn never_requires_elevation() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap())
            .unwrap();
    assert_eq!(
        conf["bundle"]["windows"]["nsis"]["installMode"],
        "currentUser"
    );
    for f in ["tauri.conf.json", "build.rs", "Cargo.toml"] {
        let t = std::fs::read_to_string(root.join(f)).unwrap();
        assert!(!t.contains("requireAdministrator"), "{f}");
        assert!(!t.contains("highestAvailable"), "{f}");
    }
}
