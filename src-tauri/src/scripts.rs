use crate::game;
use crate::settings::{self, atomic_write};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha1::{Digest as Sha1Digest, Sha1};
use sha2::Sha256;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const REPOSITORY: &str = "https://api.github.com/repos/301zrg/specials";
const OFFICIAL_UTILITY_COMMIT: &str = "14745a5a3908861bba65d79cf9c542605c83d9cb";
const OFFICIAL_UTILITY_BLOB: &str = "276a70dede210f13fec78bd3a1a59d218523a2c2";
const OFFICIAL_UTILITY_BYTES: usize = 66473;
const MAX_FILES: usize = 4096;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 100 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 32 * 1024 * 1024;

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
    let bytes = download_bytes(client, address, "GitHub metadata", 2 * 1024 * 1024)?;
    serde_json::from_slice(&bytes).map_err(|_| "GitHub response was invalid".into())
}

fn download_bytes(
    client: &Client,
    address: &str,
    label: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            thread::sleep(Duration::from_millis(400 * (1 << (attempt - 1))));
        }
        match client.get(address).send() {
            Ok(mut response) => {
                let status = response.status();
                if !status.is_success() {
                    last_error = format!("SCRIPT_HTTP:{}: {label}", status.as_u16());
                    if status.as_u16() != 408 && status.as_u16() != 429 && !status.is_server_error()
                    {
                        break;
                    }
                    continue;
                }
                if response
                    .content_length()
                    .is_some_and(|size| size > limit as u64)
                {
                    return Err(format!("{label} exceeds the size limit"));
                }
                let mut bytes = Vec::new();
                match response.take(limit as u64 + 1).read_to_end(&mut bytes) {
                    Ok(_) if bytes.len() <= limit => return Ok(bytes),
                    Ok(_) => return Err(format!("{label} exceeds the size limit")),
                    Err(error) => last_error = format!("SCRIPT_NETWORK: {label}: {error}"),
                }
            }
            Err(error) => last_error = format!("SCRIPT_NETWORK: {label}: {error}"),
        }
    }
    Err(last_error)
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
    let url = raw_url(commit, &entry.path)?;
    let bytes = download_bytes(client, url.as_str(), &entry.path, MAX_FILE_BYTES)?;
    verify_blob(entry, &bytes)?;
    Ok(bytes)
}

fn verify_blob(entry: &GitEntry, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_FILE_BYTES
        || Some(bytes.len()) != entry.size
        || git_blob_sha(bytes) != entry.sha
    {
        return Err(format!(
            "Script {} did not match its GitHub blob",
            entry.path
        ));
    }
    Ok(())
}

fn archive_scripts(
    client: &Client,
    commit: &str,
    needed: &[GitEntry],
) -> Result<HashMap<String, Vec<u8>>, String> {
    let address = format!("https://codeload.github.com/301zrg/specials/zip/{commit}");
    let bytes = download_bytes(client, &address, "GitHub script archive", MAX_ARCHIVE_BYTES)?;
    parse_archive(bytes, commit, needed)
}

fn parse_archive(
    bytes: Vec<u8>,
    commit: &str,
    needed: &[GitEntry],
) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Invalid GitHub script archive: {error}"))?;
    let expected: HashMap<&str, &GitEntry> = needed
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let mut found = HashMap::new();
    let prefix = format!("specials-{commit}/706/");
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
        if !file.is_file() {
            continue;
        }
        let Some(name) = file.name().strip_prefix(&prefix) else {
            continue;
        };
        let Some(entry) = expected.get(name) else {
            continue;
        };
        if found.contains_key(name) {
            return Err(format!("Duplicate archive script: {name}"));
        }
        if file.size() > MAX_FILE_BYTES as u64 {
            return Err(format!("Archive script is too large: {name}"));
        }
        let mut content = Vec::new();
        file.take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut content)
            .map_err(|error| format!("Failed to read archive script {name}: {error}"))?;
        verify_blob(entry, &content)?;
        found.insert(name.to_string(), content);
    }
    if found.len() != needed.len() {
        return Err("GitHub script archive is missing required files".into());
    }
    Ok(found)
}

fn has_koishi_marker(bytes: &[u8]) -> bool {
    let marker: Vec<u8> = "KoishiPro"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    bytes
        .windows(marker.len())
        .any(|window| window.eq_ignore_ascii_case(&marker))
        || bytes
            .windows(9)
            .any(|window| window.eq_ignore_ascii_case(b"KoishiPro"))
}

fn is_koishipro(root: &Path) -> Result<bool, String> {
    let config = settings::load(root)?;
    let executable = game::executable(root, &config)?;
    let bytes = fs::read(&executable)
        .map_err(|error| format!("Cannot inspect game executable: {error}"))?;
    Ok(has_koishi_marker(&bytes))
}

fn official_utility(client: &Client) -> Result<Vec<u8>, String> {
    let url = format!("https://raw.githubusercontent.com/Fluorohydride/ygopro-scripts/{OFFICIAL_UTILITY_COMMIT}/utility.lua");
    let bytes = download_bytes(client, &url, "official utility.lua", MAX_FILE_BYTES)?;
    if bytes.len() != OFFICIAL_UTILITY_BYTES || git_blob_sha(&bytes) != OFFICIAL_UTILITY_BLOB {
        return Err("Official utility.lua did not match its pinned GitHub blob".into());
    }
    Ok(bytes)
}

fn merged_utility(base: &[u8], special: &[u8]) -> Result<Vec<u8>, String> {
    let base = std::str::from_utf8(base).map_err(|_| "Official utility.lua is not UTF-8")?;
    let special = std::str::from_utf8(special).map_err(|_| "special.lua is not UTF-8")?;
    let marker = "aux=Auxiliary\n";
    let (header, remainder) = base
        .split_once(marker)
        .ok_or("Official utility.lua has no Auxiliary setup")?;
    if !header.starts_with("Auxiliary={}") || !special.contains("function Auxiliary.PreloadUds()") {
        return Err("Official utility.lua or special.lua has an unexpected structure".into());
    }
    Ok(format!("{header}{marker}\n-- 706 old-ruling compatibility for original YGOPro\n{special}\nAuxiliary.PreloadUds()\n\n{remainder}").into_bytes())
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
    _client: &Client,
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
    let client = &Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("srvprotianti-desktop/0.1")
        .build()
        .map_err(|error| error.to_string())?;
    let previous = read_state(root)?;
    let (commit, tree, mut entries) = latest_entries(client)?;
    if !is_koishipro(root)? {
        let special = entries
            .iter()
            .find(|entry| entry.path == "special.lua")
            .ok_or("The 706 script set has no special.lua")?;
        if entries.iter().any(|entry| entry.path == "utility.lua") {
            return Err("The 706 script set unexpectedly includes utility.lua".into());
        }
        entries.push(GitEntry {
            path: "utility.lua".into(),
            mode: "100644".into(),
            kind: "blob".into(),
            sha: git_blob_sha(format!("{}:{}", OFFICIAL_UTILITY_BLOB, special.sha).as_bytes()),
            size: None,
        });
    }
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

    let needed: Vec<GitEntry> = entries
        .iter()
        .filter(|entry| {
            previous.files.get(&entry.path).is_none_or(|prior| {
                prior.blob_sha != entry.sha
                    || observed.get(&entry.path).and_then(Option::as_deref)
                        != Some(prior.installed_sha256.as_str())
            })
        })
        .filter(|entry| entry.path != "utility.lua")
        .cloned()
        .collect();
    let mut archive_error = None;
    let archive = if needed.len() > 4 {
        match archive_scripts(client, &commit, &needed) {
            Ok(files) => Some(files),
            Err(error) => {
                archive_error = Some(error);
                None
            }
        }
    } else {
        None
    };
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
        let bytes = if entry.path == "utility.lua" {
            let special = planned
                .iter()
                .find(|file: &&PlannedFile| file.path == "special.lua")
                .and_then(|file| file.after.as_deref());
            let saved_special = if special.is_none() {
                Some(
                    fs::read(target_path(root, "special.lua")?)
                        .map_err(|error| error.to_string())?,
                )
            } else {
                None
            };
            let special = special
                .or(saved_special.as_deref())
                .ok_or("special.lua was not downloaded")?;
            merged_utility(&official_utility(client)?, special)?
        } else if let Some(bytes) = archive.as_ref().and_then(|files| files.get(&entry.path)) {
            bytes.clone()
        } else {
            download_script(client, &commit, entry).map_err(|error| {
                if let Some(archive_error) = &archive_error {
                    format!("{error}; archive download also failed: {archive_error}")
                } else {
                    error
                }
            })?
        };
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
    use std::io::Write;

    #[test]
    fn original_client_utility_runs_special_after_defining_it() {
        let base = b"Auxiliary={}\naux=Auxiliary\nfunction GetID() end\n";
        let special = b"function Auxiliary.PreloadUds() end\n";
        let merged = String::from_utf8(merged_utility(base, special).unwrap()).unwrap();
        assert!(
            merged.find("function Auxiliary.PreloadUds()").unwrap()
                < merged
                    .find("Auxiliary.PreloadUds()\n\nfunction GetID")
                    .unwrap()
        );
        assert!(merged.ends_with("function GetID() end\n"));
        assert!(!String::from_utf8_lossy(base).contains("PreloadUds"));
    }

    #[test]
    fn executable_marker_distinguishes_clients() {
        let utf16: Vec<u8> = "KoishiPro"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert!(has_koishi_marker(&utf16));
        assert!(has_koishi_marker(b"xxKoishiProxx"));
        assert!(!has_koishi_marker(b"YGOPro"));
    }

    #[test]
    fn archive_accepts_only_expected_verified_script() {
        let commit = "0123456789abcdef0123456789abcdef01234567";
        let content = b"return true\n";
        let entry = GitEntry {
            path: "special.lua".into(),
            mode: "100644".into(),
            kind: "blob".into(),
            sha: git_blob_sha(content),
            size: Some(content.len()),
        };
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                format!("specials-{commit}/706/special.lua"),
                zip::write::FileOptions::default(),
            )
            .unwrap();
        writer.write_all(content).unwrap();
        writer
            .start_file(
                format!("specials-{commit}/other/ignored.lua"),
                zip::write::FileOptions::default(),
            )
            .unwrap();
        writer.write_all(b"ignored").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let parsed = parse_archive(bytes.clone(), commit, &[entry.clone()]).unwrap();
        assert_eq!(parsed.get("special.lua").unwrap(), content);
        let mut bad = entry;
        bad.sha = "0000000000000000000000000000000000000000".into();
        assert!(parse_archive(bytes, commit, &[bad]).is_err());
    }

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
