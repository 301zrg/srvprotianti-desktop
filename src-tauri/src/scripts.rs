use crate::settings::{self, atomic_write};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha1::{Digest as Sha1Digest, Sha1};
use sha2::Sha256;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const REPOSITORY: &str = "https://api.github.com/repos/301zrg/specials";
const MAX_FILES: usize = 4096;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 100 * 1024 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptState {
    commit: Option<String>,
    tree: Option<String>,
    files: BTreeMap<String, ManagedFile>,
    last_transaction: Option<String>,
    #[serde(default)]
    updated_at: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFile {
    blob_sha: String,
    installed_sha256: String,
    original_backup: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TouchedFile {
    path: String,
    before_backup: Option<String>,
    before_sha256: Option<String>,
    after_sha256: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Transaction {
    id: String,
    previous: ScriptState,
    touched: Vec<TouchedFile>,
}

#[derive(Deserialize)]
struct CommitResponse {
    sha: String,
    commit: CommitTree,
}
#[derive(Deserialize)]
struct CommitTree {
    tree: ShaField,
}
#[derive(Deserialize)]
struct ShaField {
    sha: String,
}
#[derive(Deserialize)]
struct GitTree {
    truncated: bool,
    tree: Vec<GitEntry>,
}
#[derive(Clone, Deserialize)]
struct GitEntry {
    path: String,
    mode: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
    size: Option<usize>,
}
struct PlannedFile {
    path: String,
    after: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    pub commit: Option<String>,
    pub can_restore: bool,
    pub updated_at: Option<u64>,
}
#[derive(Serialize)]
pub struct UpdateResult {
    pub status: &'static str,
    pub files: Vec<String>,
}
#[derive(Serialize, Clone)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub message: String,
}

fn state_path(root: &Path) -> PathBuf {
    settings::data_dir(root).join("script-state.json")
}
fn pending_path(root: &Path) -> PathBuf {
    settings::data_dir(root).join("script-pending.json")
}

pub fn has_pending(root: &Path) -> bool {
    pending_path(root).exists()
}
fn backup_root(root: &Path) -> PathBuf {
    settings::data_dir(root).join("backups")
}
fn transaction_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if Uuid::parse_str(id).is_err() {
        return Err("Invalid transaction identifier".into());
    }
    Ok(backup_root(root).join("transactions").join(id))
}
fn script_root(root: &Path) -> Result<PathBuf, String> {
    let expansions = root.join("expansions");
    let base = expansions.join("script");
    fs::create_dir_all(&expansions).map_err(|error| error.to_string())?;
    let expansion_metadata =
        fs::symlink_metadata(&expansions).map_err(|error| error.to_string())?;
    if settings::is_link_or_reparse(&expansion_metadata) || !expansion_metadata.is_dir() {
        return Err("Expansion directory must not be a link".into());
    }
    fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    let script_metadata = fs::symlink_metadata(&base).map_err(|error| error.to_string())?;
    if settings::is_link_or_reparse(&script_metadata) || !script_metadata.is_dir() {
        return Err("Expansion script directory must not be a link".into());
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_base = base.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_base.starts_with(&canonical_root) || canonical_base == canonical_root {
        return Err("Expansion script directory escapes the game root".into());
    }
    Ok(canonical_base)
}
fn safe_path(relative: &str) -> bool {
    if relative.is_empty()
        || relative.len() > 240
        || !relative.to_ascii_lowercase().ends_with(".lua")
    {
        return false;
    }
    relative.split('/').all(|component| {
        let stem = component
            .split('.')
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        !component.is_empty()
            && component != "."
            && component != ".."
            && component.len() <= 100
            && !component.ends_with([' ', '.'])
            && !matches!(
                stem.as_str(),
                "CON"
                    | "PRN"
                    | "AUX"
                    | "NUL"
                    | "COM1"
                    | "COM2"
                    | "COM3"
                    | "COM4"
                    | "COM5"
                    | "COM6"
                    | "COM7"
                    | "COM8"
                    | "COM9"
                    | "LPT1"
                    | "LPT2"
                    | "LPT3"
                    | "LPT4"
                    | "LPT5"
                    | "LPT6"
                    | "LPT7"
                    | "LPT8"
                    | "LPT9"
            )
            && component
                .chars()
                .all(|character| !character.is_control() && !"< >:\\|?*".contains(character))
    })
}
fn target_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if !safe_path(relative) {
        return Err("Unsafe script filename".into());
    }
    let script_dir = script_root(root)?;
    let target = script_dir.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    let parent = target.parent().ok_or("Missing script parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let canonical_parent = parent.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_parent.starts_with(&script_dir) {
        return Err("Script path escapes the expansion directory".into());
    }
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if settings::is_link_or_reparse(&metadata) || !metadata.is_file() {
            return Err("Script target is not a regular file".into());
        }
    }
    Ok(target)
}
fn read_state(root: &Path) -> Result<ScriptState, String> {
    let file = state_path(root);
    if !file.exists() {
        return Ok(ScriptState::default());
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "Script installation record is damaged".into())
}
fn write_state(root: &Path, state: &ScriptState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    atomic_write(&state_path(root), &bytes)
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn git_blob_sha(bytes: &[u8]) -> String {
    let mut hash = Sha1::new();
    hash.update(format!("blob {}\0", bytes.len()).as_bytes());
    hash.update(bytes);
    format!("{:x}", hash.finalize())
}
fn file_hash(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(sha256(
        &fs::read(path).map_err(|error| error.to_string())?,
    )))
}

fn changed_paths(
    root: &Path,
    observed: &BTreeMap<String, Option<String>>,
) -> Result<Vec<String>, String> {
    let mut changed = Vec::new();
    for (path, initial_hash) in observed {
        let target = target_path(root, path)?;
        if &file_hash(&target)? != initial_hash {
            changed.push(path.clone());
        }
    }
    Ok(changed)
}
fn get_json<T: for<'de> Deserialize<'de>>(client: &Client, address: &str) -> Result<T, String> {
    let mut response = client
        .get(address)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|error| format!("GitHub request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub returned HTTP {}", response.status()));
    }
    let mut bytes = Vec::new();
    response
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("GitHub tree response is too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "GitHub response was invalid".into())
}
fn valid_sha(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn latest_entries(client: &Client) -> Result<(String, String, Vec<GitEntry>), String> {
    let commit: CommitResponse = get_json(client, &format!("{REPOSITORY}/commits/master"))?;
    if !valid_sha(&commit.sha) || !valid_sha(&commit.commit.tree.sha) {
        return Err("GitHub supplied an invalid commit".into());
    }
    let root: GitTree = get_json(
        client,
        &format!("{REPOSITORY}/git/trees/{}", commit.commit.tree.sha),
    )?;
    if root.truncated {
        return Err("GitHub root tree was truncated".into());
    }
    let folder = root
        .tree
        .into_iter()
        .find(|entry| entry.path == "706" && entry.kind == "tree")
        .ok_or("The 706 directory is missing from the selected commit")?;
    if !valid_sha(&folder.sha) {
        return Err("Invalid 706 tree identifier".into());
    }
    let children: GitTree = get_json(
        client,
        &format!("{REPOSITORY}/git/trees/{}?recursive=1", folder.sha),
    )?;
    if children.truncated {
        return Err("GitHub 706 tree was truncated".into());
    }
    let mut entries = Vec::new();
    let mut names = HashSet::new();
    let mut total = 0usize;
    for entry in children.tree {
        if entry.kind == "tree" {
            continue;
        }
        if entry.kind != "blob"
            || !matches!(entry.mode.as_str(), "100644" | "100755")
            || !safe_path(&entry.path)
            || !valid_sha(&entry.sha)
        {
            return Err("GitHub 706 contains an unsupported path or file type".into());
        }
        let casefold = entry.path.to_lowercase();
        if !names.insert(casefold) {
            return Err("GitHub 706 contains case-colliding filenames".into());
        }
        let length = entry.size.ok_or("GitHub did not provide script size")?;
        if length > MAX_FILE_BYTES {
            return Err("A script exceeds the size limit".into());
        }
        total = total.checked_add(length).ok_or("Script size overflow")?;
        if total > MAX_TOTAL_BYTES {
            return Err("Script set exceeds the size limit".into());
        }
        entries.push(entry);
    }
    if entries.is_empty() || entries.len() > MAX_FILES {
        return Err("GitHub 706 file list is empty or too large".into());
    }
    Ok((commit.sha, folder.sha, entries))
}
fn raw_url(commit: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse("https://raw.githubusercontent.com/301zrg/specials/")
        .map_err(|error| error.to_string())?;
    {
        let mut parts = url.path_segments_mut().map_err(|_| "Invalid script URL")?;
        parts.pop_if_empty().push(commit).push("706");
        for component in path.split('/') {
            parts.push(component);
        }
    }
    Ok(url)
}
fn download_script(client: &Client, commit: &str, entry: &GitEntry) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(raw_url(commit, &entry.path)?)
        .send()
        .map_err(|error| format!("Failed to download {}: {error}", entry.path))?;
    if !response.status().is_success() {
        return Err(format!(
            "Downloading {} returned HTTP {}",
            entry.path,
            response.status()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read {}: {error}", entry.path))?;
    if bytes.len() > MAX_FILE_BYTES
        || Some(bytes.len()) != entry.size
        || git_blob_sha(&bytes) != entry.sha
    {
        return Err(format!(
            "Script {} did not match its GitHub blob",
            entry.path
        ));
    }
    Ok(bytes)
}
fn read_original(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    if !relative.starts_with("backups/original/")
        || relative["backups/original/".len()..].contains('/')
        || relative.contains("..")
    {
        return Err("Invalid original backup reference".into());
    }
    fs::read(settings::data_dir(root).join(relative))
        .map_err(|error| format!("Missing original script backup: {error}"))
}
fn game_running(root: &Path, game_executable: &str) -> bool {
    let target = root.join(game_executable);
    let target = target.canonicalize().unwrap_or(target);
    let mut system = System::new_all();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .processes()
        .values()
        .any(|process| match process.exe() {
            Some(path) if !path.as_os_str().is_empty() => {
                path.canonicalize().unwrap_or_else(|_| path.to_path_buf()) == target
            }
            _ => process
                .name()
                .to_string_lossy()
                .eq_ignore_ascii_case(game_executable),
        })
}
fn ensure_game_stopped(root: &Path) -> Result<(), String> {
    let config = settings::load(root)?;
    if game_running(root, &config.game.executable) {
        return Err("Close this game executable before applying or restoring scripts".into());
    }
    Ok(())
}
fn tx_journal(root: &Path, id: &str) -> Result<Transaction, String> {
    let bytes = fs::read(transaction_path(root, id)?.join("journal.json"))
        .map_err(|error| format!("Script recovery journal is missing: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|_| "Script recovery journal is invalid".into())
}
fn preflight_transaction(root: &Path, transaction: &Transaction) -> Result<(), String> {
    // Check every file before changing any file; never erase a player's later edits.
    for touched in &transaction.touched {
        let target = target_path(root, &touched.path)?;
        let current = file_hash(&target)?;
        if current != touched.before_sha256 && current != touched.after_sha256 {
            return Err(format!(
                "Script {} changed after the update; recovery needs manual attention",
                touched.path
            ));
        }
    }
    Ok(())
}
fn rollback(root: &Path, transaction: &Transaction) -> Result<(), String> {
    preflight_transaction(root, transaction)?;
    let directory = transaction_path(root, &transaction.id)?;
    for touched in transaction.touched.iter().rev() {
        let target = target_path(root, &touched.path)?;
        if let Some(backup) = &touched.before_backup {
            let source = directory.join(backup);
            let bytes = fs::read(source).map_err(|error| error.to_string())?;
            atomic_write(&target, &bytes)?;
        } else if target.exists() {
            fs::remove_file(&target).map_err(|error| error.to_string())?;
        }
    }
    let mut restored = transaction.previous.clone();
    restored.last_transaction = None;
    write_state(root, &restored)?;
    let pending = pending_path(root);
    if pending.exists() {
        fs::remove_file(pending).map_err(|error| error.to_string())?;
    }
    Ok(())
}
pub fn recover_pending(root: &Path) -> Result<(), String> {
    let file = pending_path(root);
    if !file.exists() {
        return Ok(());
    }
    ensure_game_stopped(root)?;
    let id = fs::read_to_string(&file).map_err(|error| error.to_string())?;
    let transaction = tx_journal(root, id.trim())?;
    rollback(root, &transaction)
}
pub fn state(root: &Path) -> Result<StateView, String> {
    let record = read_state(root)?;
    Ok(StateView {
        commit: record.commit,
        can_restore: record.last_transaction.is_some(),
        updated_at: record.updated_at,
    })
}
fn emit_progress(app: &AppHandle, done: usize, total: usize) {
    let _ = app.emit(
        "script-progress",
        Progress {
            done,
            total,
            message: format!("{done}/{total}"),
        },
    );
}

pub fn update(
    root: &Path,
    client: &Client,
    file_lock: &Mutex<()>,
    app: &AppHandle,
    overwrite_conflicts: bool,
) -> Result<UpdateResult, String> {
    {
        let _guard = file_lock
            .lock()
            .map_err(|_| "Script file lock is unavailable")?;
        settings::initialise(root)?;
        recover_pending(root)?;
        ensure_game_stopped(root)?;
    }
    let previous = read_state(root)?;
    let (commit, tree, entries) = latest_entries(client)?;
    let remote_paths: HashSet<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
    let mut conflicts = Vec::new();
    // Keep the exact state seen before network downloads. A newly created or
    // edited file must never be silently replaced, even after the user agreed
    // to overwrite a different conflict at the start of this update.
    let mut observed = BTreeMap::new();
    for (path, managed) in &previous.files {
        let target = target_path(root, path)?;
        let current_hash = file_hash(&target)?;
        if let Some(current) = &current_hash {
            if current != &managed.installed_sha256 {
                conflicts.push(path.clone());
            }
        }
        observed.insert(path.clone(), current_hash);
    }
    for entry in &entries {
        if previous.files.contains_key(&entry.path) {
            continue;
        }
        let target = target_path(root, &entry.path)?;
        let current_hash = file_hash(&target)?;
        if current_hash.is_some() {
            conflicts.push(entry.path.clone());
        }
        observed.insert(entry.path.clone(), current_hash);
    }
    if !conflicts.is_empty() && !overwrite_conflicts {
        return Ok(UpdateResult {
            status: "conflict",
            files: conflicts,
        });
    }

    let mut next = previous.clone();
    next.commit = Some(commit.clone());
    next.tree = Some(tree.clone());
    next.files.clear();
    let mut planned = Vec::new();
    let total = entries.len();
    for (index, entry) in entries.iter().enumerate() {
        let target = target_path(root, &entry.path)?;
        let current_hash = observed.get(&entry.path).cloned().unwrap_or(None);
        let prior = previous.files.get(&entry.path);
        if let Some(prior) = prior {
            if prior.blob_sha == entry.sha
                && current_hash.as_deref() == Some(prior.installed_sha256.as_str())
            {
                next.files.insert(entry.path.clone(), prior.clone());
                emit_progress(app, index + 1, total);
                continue;
            }
        }
        let bytes = download_script(client, &commit, entry)?;
        let installed_sha256 = sha256(&bytes);
        let original_backup = match prior {
            Some(prior) => prior.original_backup.clone(),
            None if target.exists() => {
                let relative = format!("backups/original/{}.bak", Uuid::new_v4());
                let original = fs::read(&target).map_err(|error| error.to_string())?;
                atomic_write(&settings::data_dir(root).join(&relative), &original)?;
                Some(relative)
            }
            None => None,
        };
        next.files.insert(
            entry.path.clone(),
            ManagedFile {
                blob_sha: entry.sha.clone(),
                installed_sha256,
                original_backup,
            },
        );
        planned.push(PlannedFile {
            path: entry.path.clone(),
            after: Some(bytes),
        });
        emit_progress(app, index + 1, total);
    }
    for (path, managed) in &previous.files {
        if remote_paths.contains(path.as_str()) {
            continue;
        }
        let after = managed
            .original_backup
            .as_ref()
            .map(|name| read_original(root, name))
            .transpose()?;
        planned.push(PlannedFile {
            path: path.clone(),
            after,
        });
    }
    if planned.is_empty() {
        if previous.commit.as_deref() != Some(&commit) || previous.tree.as_deref() != Some(&tree) {
            write_state(root, &next)?;
        }
        return Ok(UpdateResult {
            status: "current",
            files: Vec::new(),
        });
    }

    let _guard = file_lock
        .lock()
        .map_err(|_| "Script file lock is unavailable")?;
    ensure_game_stopped(root)?;
    let changed_during_download = changed_paths(root, &observed)?;
    if !changed_during_download.is_empty() {
        return Ok(UpdateResult {
            status: "conflict",
            files: changed_during_download,
        });
    }
    let id = Uuid::new_v4().to_string();
    let directory = transaction_path(root, &id)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let mut touched = Vec::new();
    for (index, planned_file) in planned.iter().enumerate() {
        let target = target_path(root, &planned_file.path)?;
        let before = if target.exists() {
            let bytes = fs::read(&target).map_err(|error| error.to_string())?;
            let backup = format!("{index}.bak");
            atomic_write(&directory.join(&backup), &bytes)?;
            Some((backup, sha256(&bytes)))
        } else {
            None
        };
        touched.push(TouchedFile {
            path: planned_file.path.clone(),
            before_backup: before.as_ref().map(|entry| entry.0.clone()),
            before_sha256: before.map(|entry| entry.1),
            after_sha256: planned_file.after.as_ref().map(|bytes| sha256(bytes)),
        });
    }
    let transaction = Transaction {
        id: id.clone(),
        previous,
        touched,
    };
    atomic_write(
        &directory.join("journal.json"),
        &serde_json::to_vec_pretty(&transaction).map_err(|error| error.to_string())?,
    )?;
    atomic_write(&pending_path(root), id.as_bytes())?;
    let apply_result: Result<(), String> = (|| {
        for planned_file in &planned {
            let target = target_path(root, &planned_file.path)?;
            match &planned_file.after {
                Some(bytes) => atomic_write(&target, bytes)?,
                None if target.exists() => {
                    fs::remove_file(&target).map_err(|error| error.to_string())?
                }
                None => {}
            }
        }
        next.last_transaction = Some(id);
        next.updated_at = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_secs(),
        );
        write_state(root, &next)?;
        fs::remove_file(pending_path(root)).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = apply_result {
        rollback(root, &transaction).map_err(|rollback_error| {
            format!("{error}; automatic recovery also failed: {rollback_error}")
        })?;
        return Err(error);
    }
    Ok(UpdateResult {
        status: "updated",
        files: Vec::new(),
    })
}

pub fn restore(root: &Path, file_lock: &Mutex<()>) -> Result<UpdateResult, String> {
    let _guard = file_lock
        .lock()
        .map_err(|_| "Script file lock is unavailable")?;
    settings::initialise(root)?;
    recover_pending(root)?;
    ensure_game_stopped(root)?;
    let current = read_state(root)?;
    let id = current
        .last_transaction
        .ok_or("No script update is available to restore")?;
    let transaction = tx_journal(root, &id)?;
    preflight_transaction(root, &transaction)?;
    atomic_write(&pending_path(root), id.as_bytes())?;
    rollback(root, &transaction)?;
    Ok(UpdateResult {
        status: "restored",
        files: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_blob_hash_uses_git_header() {
        assert_eq!(
            git_blob_sha(b"test\n"),
            "9daeafb9864cf43055ae93beb0afd6c7d144bfa4"
        );
    }
    #[test]
    fn raw_download_url_has_one_separator_before_commit() {
        let commit = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            raw_url(commit, "c123.lua").unwrap().as_str(),
            "https://raw.githubusercontent.com/301zrg/specials/0123456789abcdef0123456789abcdef01234567/706/c123.lua"
        );
    }
    #[test]
    fn unsafe_script_names_are_rejected() {
        assert!(safe_path("c123.lua"));
        assert!(!safe_path("../c123.lua"));
        assert!(!safe_path("other.txt"));
        assert!(!safe_path("c1.lua/../c2.lua"));
        assert!(!safe_path("CON.lua"));
        assert!(!safe_path("folder/AUX.lua"));
    }

    #[test]
    fn changed_paths_catches_new_and_modified_local_scripts() {
        let root = std::env::temp_dir().join(format!("srvpro-script-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let existing = target_path(&root, "existing.lua").unwrap();
        atomic_write(&existing, b"original").unwrap();
        let mut observed = BTreeMap::new();
        observed.insert("existing.lua".into(), file_hash(&existing).unwrap());
        observed.insert("new.lua".into(), None);
        assert!(changed_paths(&root, &observed).unwrap().is_empty());
        atomic_write(&existing, b"player edit").unwrap();
        atomic_write(&target_path(&root, "new.lua").unwrap(), b"new local file").unwrap();
        assert_eq!(
            changed_paths(&root, &observed).unwrap(),
            vec!["existing.lua", "new.lua"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rollback_rejects_player_edits_then_restores_only_touched_file() {
        let root = std::env::temp_dir().join(format!("srvpro-script-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        settings::initialise(&root).unwrap();
        let target = target_path(&root, "c123.lua").unwrap();
        let unrelated = target_path(&root, "unrelated.lua").unwrap();
        atomic_write(&target, b"updated").unwrap();
        atomic_write(&unrelated, b"untouched").unwrap();
        let id = Uuid::new_v4().to_string();
        let transaction_dir = transaction_path(&root, &id).unwrap();
        fs::create_dir_all(&transaction_dir).unwrap();
        atomic_write(&transaction_dir.join("0.bak"), b"original").unwrap();
        let transaction = Transaction {
            id,
            previous: ScriptState::default(),
            touched: vec![TouchedFile {
                path: "c123.lua".into(),
                before_backup: Some("0.bak".into()),
                before_sha256: Some(sha256(b"original")),
                after_sha256: Some(sha256(b"updated")),
            }],
        };
        atomic_write(&pending_path(&root), transaction.id.as_bytes()).unwrap();
        atomic_write(&target, b"player edit").unwrap();
        assert!(rollback(&root, &transaction).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"player edit");
        atomic_write(&target, b"updated").unwrap();
        rollback(&root, &transaction).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read(&unrelated).unwrap(), b"untouched");
        assert!(!pending_path(&root).exists());
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
}
