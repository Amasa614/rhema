use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn dev_repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Directory containing `models/`, `embeddings/`, and the Bible DB (layout differs in dev vs install).
pub fn content_root(app: &AppHandle) -> PathBuf {
    // Dev: always use repo root so `models/whisper/` and `data/rhema.db` match `bun run setup:all`.
    // Tauri may copy bundled `rhema.db` into target/debug without Whisper, which would break STT.
    if cfg!(debug_assertions) {
        return dev_repo_root();
    }

    if let Ok(resource) = app.path().resource_dir() {
        if resource.join("rhema.db").exists() {
            return resource;
        }
    }
    dev_repo_root()
}

pub fn bible_db_path(app: &AppHandle) -> PathBuf {
    let root = content_root(app);
    let installed = root.join("rhema.db");
    if installed.exists() {
        return installed;
    }
    root.join("data/rhema.db")
}
