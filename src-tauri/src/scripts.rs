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
/// Git smart-HTTP ref advertisement: not the REST API, so it does not spend the
/// unauthenticated 60-an-hour quota.
const REFS_URL: &str = "https://github.com/301zrg/specials.git/info/refs?service=git-upload-pack";
const REFS_LIMIT: usize = 64 * 1024;
/// File lists verified against their 706 tree id, one per environment.
const TREE_CACHE_LIMIT: usize = 16;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptState {
    commit: Option<String>,
    tree: Option<String>,
    files: BTreeMap<String, ManagedFile>,
    last_transaction: Option<String>,
    #[serde(default)]
    updated_at: Option<u64>,
    /// Environment the player chose; None follows the newest one (plan 02 §4.1).
    #[serde(default)]
    environment_choice: Option<String>,
    /// Environment actually resolved by the last successful install; None before
    /// 706-meta existed or for states written by older versions.
    #[serde(default)]
    installed_environment: Option<String>,
}

/// One rule environment from 706-meta/versions.json (plan 02 §2). Other fields are ignored.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentEntry {
    pub id: String,
    pub effective_from_unix: Option<i64>,
    pub specials: EnvironmentSpecials,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct EnvironmentSpecials {
    pub commit: String,
    pub tree706: String,
}
#[derive(Deserialize)]
struct VersionTable {
    format: u32,
    environments: Vec<EnvironmentEntry>,
}
/// The environment table read from one pinned master commit.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentList {
    pub master: String,
    pub environments: Vec<EnvironmentEntry>,
}

fn environment_id_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    if !id.starts_with("706-") || bytes.len() < 12 || !bytes[4..12].iter().all(u8::is_ascii_digit) {
        return false;
    }
    match &id[12..] {
        "" => true,
        rest => {
            rest.len() > 1 && rest.starts_with('-') && rest[1..].bytes().all(|b| b.is_ascii_digit())
        }
    }
}

/// Rejects a table that breaks 02 §2: unique ids, only the first start is null,
/// strictly increasing boundaries, well-formed commit and 706 tree ids.
fn validate_environments(table: VersionTable) -> Result<Vec<EnvironmentEntry>, String> {
    let list = table.environments;
    if table.format != 1 || list.is_empty() || list.len() > 1000 {
        return Err("The 706 environment table is invalid".into());
    }
    let mut seen = HashSet::new();
    for (index, entry) in list.iter().enumerate() {
        let start_ok = match (index, entry.effective_from_unix) {
            (0, None) => true,
            (0, Some(_)) | (_, None) => false,
            (1, Some(_)) => true,
            (_, Some(start)) => list[index - 1]
                .effective_from_unix
                .is_some_and(|prior| start > prior),
        };
        if !environment_id_valid(&entry.id)
            || !seen.insert(entry.id.clone())
            || !start_ok
            || !valid_sha(&entry.specials.commit)
            || !valid_sha(&entry.specials.tree706)
        {
            return Err("The 706 environment table is invalid".into());
        }
    }
    Ok(list)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFile {
    blob_sha: String,
    installed_sha256: String,
    original_backup: Option<String>,
    /// The original backup held exactly the bytes first installed over it, i.e. an
    /// earlier copy of the same 706 script rather than the player's own file.
    /// Missing in legacy records: its origin must be established before removal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_matches_install: Option<bool>,
}

/// An unmanaged local file that already equals the remote blob loses nothing when
/// it is taken over, so it is not a conflict (utility.lua has no real blob id).
fn adoptable(path: &str, local: &[u8], remote_blob: &str) -> bool {
    path != "utility.lua" && git_blob_sha(local) == remote_blob
}

/// What a file removed from the 706 set becomes. The player's own original comes
/// back; an original that was only an earlier copy of the 706 script is dropped,
/// otherwise a stale override would outlive its removal. The backup file stays.
fn removal_result(managed: &ManagedFile, original: Option<Vec<u8>>) -> Option<Vec<u8>> {
    original.filter(|bytes| {
        managed.original_matches_install != Some(true) && sha256(bytes) != managed.installed_sha256
    })
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
#[derive(Clone, Serialize, Deserialize)]
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
    /// Installed 706 subtree; compared with the table's tree706 to check local scripts.
    pub tree: Option<String>,
    /// The player's choice; None follows the newest environment.
    pub environment_choice: Option<String>,
    /// Environment resolved by the last successful install (None for older states).
    pub installed_environment: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub status: &'static str,
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub backup_requests: Vec<BackupRequest>,
}
impl UpdateResult {
    pub fn for_pages(self, supports_confirmation: Option<bool>) -> Result<Self, String> {
        // Old pages treat unfamiliar statuses as success and may launch a replay.
        if self.status == "backup_confirmation" && supports_confirmation != Some(true) {
            return Err("Old script backups need your confirmation. Update the assistant pages, restart the assistant, and check for script updates again. No script files were changed.".into());
        }
        Ok(self)
    }
}
#[derive(Serialize)]
pub struct BackupRequest {
    path: String,
    token: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum BackupAction {
    Drop,
    Restore,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupDecision {
    token: String,
    action: BackupAction,
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
/// GitHub's unauthenticated quota (60 requests an hour per address) is spent when a
/// 403/429 says no requests remain; the reset time is Unix seconds.
fn rate_limit_reset(status: u16, remaining: Option<&str>, reset: Option<&str>) -> Option<u64> {
    if !matches!(status, 403 | 429) || remaining.map(str::trim) != Some("0") {
        return None;
    }
    reset.and_then(|value| value.trim().parse().ok())
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
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    last_error = format!("SCRIPT_HTTP:{}: {label}", status.as_u16());
                    let header = |name| {
                        response
                            .headers()
                            .get(name)
                            .and_then(|value| value.to_str().ok())
                    };
                    let reset = rate_limit_reset(
                        status.as_u16(),
                        header("x-ratelimit-remaining"),
                        header("x-ratelimit-reset"),
                    );
                    if let Some(reset) = reset {
                        // Retrying cannot help before the quota resets; the page shows when.
                        last_error.push_str(&format!("; reset={reset}"));
                        break;
                    }
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
fn get_commit(client: &Client, reference: &str) -> Result<CommitResponse, String> {
    let commit: CommitResponse = get_json(client, &format!("{REPOSITORY}/commits/{reference}"))?;
    if !valid_sha(&commit.sha) || !valid_sha(&commit.commit.tree.sha) {
        return Err("GitHub supplied an invalid commit".into());
    }
    Ok(commit)
}

/// The table at one pinned commit. Missing (before 706-meta existed) is Ok(None);
/// any other failure is an error, never a silent fallback.
fn environment_table(
    client: &Client,
    commit: &str,
) -> Result<Option<Vec<EnvironmentEntry>>, String> {
    let url = format!(
        "https://raw.githubusercontent.com/301zrg/specials/{commit}/706-meta/versions.json"
    );
    match download_bytes(client, &url, "706 environment table", 1024 * 1024) {
        Ok(bytes) => {
            let table: VersionTable = serde_json::from_slice(&bytes)
                .map_err(|_| "The 706 environment table is invalid")?;
            validate_environments(table).map(Some)
        }
        Err(error) if error.starts_with("SCRIPT_HTTP:404") => Ok(None),
        Err(error) => Err(error),
    }
}

/// GitHub client for scripts and the environment table: no redirects, bounded timeouts.
fn github_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("srvprotianti-desktop/0.1")
        .build()
        .map_err(|error| error.to_string())
}

/// Master's commit from the git ref advertisement (pkt-lines). Anything unexpected
/// is an error, never a guess.
fn parse_master_ref(bytes: &[u8]) -> Result<String, String> {
    let invalid = || "The specials ref list is invalid".to_string();
    let mut rest = bytes;
    let mut master = None;
    while !rest.is_empty() {
        let length = rest
            .get(..4)
            .and_then(|digits| std::str::from_utf8(digits).ok())
            .and_then(|digits| usize::from_str_radix(digits, 16).ok())
            .ok_or_else(invalid)?;
        if length == 0 {
            rest = &rest[4..];
            continue;
        }
        if length < 4 || length > rest.len() {
            return Err(invalid());
        }
        let line = &rest[4..length];
        rest = &rest[length..];
        // The first ref carries capabilities after a NUL.
        let line = line.split(|byte| *byte == 0).next().unwrap_or_default();
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        if let Some(sha) = line.strip_suffix(b" refs/heads/master") {
            let sha = std::str::from_utf8(sha).map_err(|_| invalid())?;
            if !valid_sha(sha) || master.replace(sha.to_string()).is_some() {
                return Err(invalid());
            }
        }
    }
    master.ok_or_else(|| "The specials ref list has no master".into())
}

/// Master's commit without the REST API; the API is only the fallback.
fn master_commit(client: &Client) -> Result<String, String> {
    let refs = download_bytes(client, REFS_URL, "GitHub master reference", REFS_LIMIT)
        .and_then(|bytes| parse_master_ref(&bytes));
    match refs {
        Ok(sha) => Ok(sha),
        Err(error) => {
            eprintln!("Reading master from git refs failed, using the GitHub API: {error}");
            get_commit(client, "master").map(|commit| commit.sha)
        }
    }
}

pub fn environments() -> Result<Option<EnvironmentList>, String> {
    let client = &github_client()?;
    let master = master_commit(client)?;
    Ok(
        environment_table(client, &master)?.map(|environments| EnvironmentList {
            master,
            environments,
        }),
    )
}

/// 706 script bytes by path.
type ScriptFiles = HashMap<String, Vec<u8>>;

/// What to install. `files` holds every 706 script when the list came from the
/// archive, so nothing is downloaded twice.
struct Selection {
    commit: String,
    tree: String,
    environment: Option<String>,
    entries: Vec<GitEntry>,
    files: Option<ScriptFiles>,
}

/// Resolves what to install: the chosen environment's S commit, or the newest one,
/// or plain master while no table exists. The table and master are read once from
/// the same pinned commit.
fn select_entries(client: &Client, root: &Path, choice: Option<&str>) -> Result<Selection, String> {
    let master = master_commit(client)?;
    let table = environment_table(client, &master)?;
    let environment = match (table, choice) {
        (None, None) => None,
        (None, Some(_)) => return Err("The 706 environment table is not available yet".into()),
        (Some(list), None) => list.last().cloned(),
        (Some(list), Some(id)) => Some(
            list.into_iter()
                .find(|entry| entry.id == id)
                .ok_or_else(|| format!("Unknown 706 environment: {id}"))?,
        ),
    };
    let Some(environment) = environment else {
        let master = get_commit(client, &master)?;
        let (tree, entries) = entries_at(client, &master)?;
        return Ok(Selection {
            commit: master.sha,
            tree,
            environment: None,
            entries,
            files: None,
        });
    };
    let commit = environment.specials.commit;
    // The table pins the 706 subtree; anything else is not this environment.
    let tree = environment.specials.tree706;
    let local = match local_entries(client, root, &commit, &tree) {
        Ok((entries, files)) => {
            return Ok(Selection {
                commit,
                tree,
                environment: Some(environment.id),
                entries,
                files,
            })
        }
        Err(error) => error,
    };
    eprintln!("Verifying the 706 list without the GitHub API failed, using the API: {local}");
    let with_api = || -> Result<Vec<GitEntry>, String> {
        let response = get_commit(client, &commit)?;
        if response.sha != commit {
            return Err("GitHub returned a different commit for the environment".into());
        }
        let (api_tree, entries) = entries_at(client, &response)?;
        if api_tree != tree {
            return Err("The environment's 706 tree does not match the table".into());
        }
        Ok(entries)
    };
    let entries = with_api().map_err(|error| format!("{error}; without the API: {local}"))?;
    Ok(Selection {
        commit,
        tree,
        environment: Some(environment.id),
        entries,
        files: None,
    })
}

/// The 706 file list for a pinned tree: from the cache, or from the commit's
/// archive. Either way it is used only if its git tree id equals `tree706`.
fn local_entries(
    client: &Client,
    root: &Path,
    commit: &str,
    tree706: &str,
) -> Result<(Vec<GitEntry>, Option<ScriptFiles>), String> {
    let cache = tree_cache_dir(root).join(format!("{tree706}.json"));
    if let Some(entries) = read_tree_cache(&cache, tree706) {
        return Ok((entries, None));
    }
    let address = format!("https://codeload.github.com/301zrg/specials/zip/{commit}");
    let bytes = download_bytes(client, &address, "GitHub script archive", MAX_ARCHIVE_BYTES)?;
    let (entries, files) = archive_tree(bytes, commit)?;
    if tree_sha(&entries)? != tree706 {
        return Err("The script archive does not match the environment's 706 tree".into());
    }
    if let Err(error) = write_tree_cache(root, &cache, &entries) {
        eprintln!("Cannot cache the 706 file list: {error}");
    }
    Ok((entries, Some(files)))
}

fn tree_cache_dir(root: &Path) -> PathBuf {
    settings::data_dir(root).join("script-trees")
}

/// A cached list that is unreadable or does not hash to its tree is dropped.
fn read_tree_cache(path: &Path, tree706: &str) -> Option<Vec<GitEntry>> {
    let bytes = read_small(path)?;
    let verified = serde_json::from_slice::<Vec<GitEntry>>(&bytes)
        .ok()
        .and_then(|entries| validate_entries(entries).ok())
        .filter(|entries| tree_sha(entries).ok().as_deref() == Some(tree706));
    if verified.is_none() {
        let _ = fs::remove_file(path);
    }
    verified
}

fn read_small(path: &Path) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= 2 * 1024 * 1024).then_some(bytes)
}

fn write_tree_cache(root: &Path, path: &Path, entries: &[GitEntry]) -> Result<(), String> {
    let bytes = serde_json::to_vec(entries).map_err(|error| error.to_string())?;
    atomic_write(path, &bytes)?;
    // Keep the newest lists only; any of them can be rebuilt from its archive.
    let mut cached: Vec<(SystemTime, PathBuf)> = fs::read_dir(tree_cache_dir(root))
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|item| item.path() != path)
        .filter(|item| item.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|item| Some((item.metadata().ok()?.modified().ok()?, item.path())))
        .collect();
    cached.sort();
    let excess = cached.len().saturating_sub(TREE_CACHE_LIMIT - 1);
    for (_, old) in cached.into_iter().take(excess) {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

/// Every file under 706/ in a codeload archive, with git blob ids. The archive
/// carries no file modes, so all files count as 100644; anything else (an
/// executable or a link) changes the tree id and is caught by the caller.
fn archive_tree(bytes: Vec<u8>, commit: &str) -> Result<(Vec<GitEntry>, ScriptFiles), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("Invalid GitHub script archive: {error}"))?;
    let prefix = format!("specials-{commit}/706/");
    let mut entries = Vec::new();
    let mut files = HashMap::new();
    let mut total = 0usize;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        if file.is_dir() {
            continue;
        }
        let Some(name) = file.name().strip_prefix(&prefix).map(str::to_string) else {
            continue;
        };
        if file.size() > MAX_FILE_BYTES as u64 {
            return Err(format!("Archive script is too large: {name}"));
        }
        let mut content = Vec::new();
        file.take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut content)
            .map_err(|error| format!("Failed to read archive script {name}: {error}"))?;
        if content.len() > MAX_FILE_BYTES {
            return Err(format!("Archive script is too large: {name}"));
        }
        total = total
            .checked_add(content.len())
            .ok_or("Script size overflow")?;
        if total > MAX_TOTAL_BYTES {
            return Err("Script set exceeds the size limit".into());
        }
        entries.push(GitEntry {
            path: name.clone(),
            mode: "100644".into(),
            kind: "blob".into(),
            sha: git_blob_sha(&content),
            size: Some(content.len()),
        });
        if files.insert(name.clone(), content).is_some() {
            return Err(format!("Duplicate archive script: {name}"));
        }
    }
    Ok((validate_entries(entries)?, files))
}

/// Git's tree id for a flat list of blobs (paths may contain '/'), computed the
/// way git does: one tree object per directory, entries in git's order.
fn tree_sha(entries: &[GitEntry]) -> Result<String, String> {
    enum Node {
        Blob(String, [u8; 20]),
        Tree(BTreeMap<String, Node>),
    }
    fn raw_sha(hex: &str) -> Result<[u8; 20], String> {
        let mut out = [0u8; 20];
        if !valid_sha(hex) {
            return Err("Invalid blob id".into());
        }
        for (index, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                .map_err(|_| "Invalid blob id")?;
        }
        Ok(out)
    }
    fn hash(tree: &BTreeMap<String, Node>) -> [u8; 20] {
        let mut items: Vec<(Vec<u8>, Vec<u8>)> = tree
            .iter()
            .map(|(name, node)| {
                let (mode, sha, key) = match node {
                    Node::Blob(mode, sha) => (mode.as_str(), *sha, name.clone()),
                    // Git orders a directory as if its name ended with '/'.
                    Node::Tree(children) => ("40000", hash(children), format!("{name}/")),
                };
                let mut record = format!("{mode} {name}\0").into_bytes();
                record.extend_from_slice(&sha);
                (key.into_bytes(), record)
            })
            .collect();
        items.sort();
        let body: Vec<u8> = items.into_iter().flat_map(|(_, record)| record).collect();
        let mut sha = Sha1::new();
        sha.update(format!("tree {}\0", body.len()).as_bytes());
        sha.update(&body);
        sha.finalize().into()
    }
    let mut top = BTreeMap::new();
    for entry in entries {
        let mut parts: Vec<&str> = entry.path.split('/').collect();
        let name = parts.pop().ok_or("Empty script path")?;
        let mut folder = &mut top;
        for part in parts {
            let node = folder
                .entry(part.to_string())
                .or_insert_with(|| Node::Tree(BTreeMap::new()));
            folder = match node {
                Node::Tree(children) => children,
                Node::Blob(..) => return Err("A script path is both a file and a folder".into()),
            };
        }
        let blob = Node::Blob(entry.mode.clone(), raw_sha(&entry.sha)?);
        if folder.insert(name.to_string(), blob).is_some() {
            return Err("A script path is listed twice".into());
        }
    }
    let sha = hash(&top);
    Ok(sha.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn entries_at(client: &Client, commit: &CommitResponse) -> Result<(String, Vec<GitEntry>), String> {
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
    let entries = children
        .tree
        .into_iter()
        .filter(|entry| entry.kind != "tree")
        .collect();
    Ok((folder.sha, validate_entries(entries)?))
}

/// The same limits for every source of a 706 list: plain files with safe,
/// case-distinct names, valid ids and bounded sizes.
fn validate_entries(entries: Vec<GitEntry>) -> Result<Vec<GitEntry>, String> {
    let mut names = HashSet::new();
    let mut total = 0usize;
    for entry in &entries {
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
    }
    if entries.is_empty() || entries.len() > MAX_FILES {
        return Err("GitHub 706 file list is empty or too large".into());
    }
    Ok(entries)
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
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        if !file.is_file() {
            continue;
        }
        let Some(name) = file.name().strip_prefix(&prefix).map(str::to_string) else {
            continue;
        };
        let Some(entry) = expected.get(name.as_str()) else {
            continue;
        };
        if found.contains_key(&name) {
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
        found.insert(name, content);
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

pub(crate) fn is_koishipro(root: &Path) -> Result<bool, String> {
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
    let marker = "NULL_VALUE=-10\n";
    let (header, remainder) = base
        .split_once(marker)
        .ok_or("Official utility.lua has no Auxiliary setup")?;
    if !header.starts_with("Auxiliary={}\naux=Auxiliary\n")
        || !special.contains("function Auxiliary.PreloadUds()")
    {
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
pub(crate) fn game_running(root: &Path, game_executable: &str) -> bool {
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

/// Only follow journals linked by the installed state, with the same original
/// backup reference. Missing, corrupt or truncated history leaves the origin unknown.
fn historical_origins(
    root: &Path,
    state: &ScriptState,
    originals: &BTreeMap<String, String>,
) -> BTreeMap<String, bool> {
    let mut found = BTreeMap::new();
    if originals.is_empty() {
        return found;
    }
    let mut snapshot = state.clone();
    let mut seen = HashSet::new();
    let mut remaining = 64 * 1024 * 1024usize;
    for _ in 0..128 {
        for (path, hash) in originals {
            let Some(managed) = snapshot
                .files
                .get(path)
                .filter(|record| record.original_backup == state.files[path].original_backup)
            else {
                continue;
            };
            if let Some(known) = managed.original_matches_install {
                found.entry(path.clone()).or_insert(known);
            } else if &managed.installed_sha256 == hash {
                found.entry(path.clone()).or_insert(true);
            }
        }
        if found.len() == originals.len() {
            break;
        }
        let Some(id) = snapshot.last_transaction.as_deref() else {
            break;
        };
        if !seen.insert(id.to_string()) {
            break;
        }
        let read = (|| -> Option<Transaction> {
            let mut bytes = Vec::new();
            fs::File::open(transaction_path(root, id).ok()?.join("journal.json"))
                .ok()?
                .take((remaining + 1) as u64)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() > remaining {
                return None;
            }
            remaining -= bytes.len();
            let journal: Transaction = serde_json::from_slice(&bytes).ok()?;
            (journal.id == id).then_some(journal)
        })();
        let Some(journal) = read else { break };
        snapshot = journal.previous;
    }
    found
}

fn plan_removals(
    root: &Path,
    previous: &ScriptState,
    remote_paths: &HashSet<&str>,
    commit: &str,
    tree: &str,
    observed: &BTreeMap<String, Option<String>>,
    decisions: Option<&BTreeMap<String, BackupDecision>>,
) -> Result<(Vec<PlannedFile>, Vec<BackupRequest>), String> {
    let mut originals = BTreeMap::new();
    let mut unknown_hashes = BTreeMap::new();
    for (path, managed) in &previous.files {
        if remote_paths.contains(path.as_str()) {
            continue;
        }
        let original = managed
            .original_backup
            .as_ref()
            .map(|name| read_original(root, name))
            .transpose()?;
        if managed.original_matches_install.is_none() {
            if let Some(bytes) = &original {
                unknown_hashes.insert(path.clone(), sha256(bytes));
            }
        }
        originals.insert(path.clone(), original);
    }
    let origins = historical_origins(root, previous, &unknown_hashes);
    let mut planned = Vec::new();
    let mut requests = Vec::new();
    let mut requested_paths = HashSet::new();
    for (path, original) in originals {
        let mut managed = previous.files[&path].clone();
        managed.original_matches_install = managed
            .original_matches_install
            .or_else(|| origins.get(&path).copied());
        if let Some(bytes) = &original {
            if managed.original_matches_install.is_none() {
                let token = sha256(
                    &serde_json::to_vec(&(previous, commit, tree, observed, &path, sha256(bytes)))
                        .map_err(|error| error.to_string())?,
                );
                requested_paths.insert(path.clone());
                if let Some(decision) = decisions.and_then(|items| items.get(&path)) {
                    if decision.token != token {
                        return Err(
                            "Script backups or update target changed; check for updates again"
                                .into(),
                        );
                    }
                    managed.original_matches_install =
                        Some(matches!(decision.action, BackupAction::Drop));
                } else {
                    requests.push(BackupRequest {
                        path: path.clone(),
                        token,
                    });
                }
            }
        }
        planned.push(PlannedFile {
            path,
            after: removal_result(&managed, original),
        });
    }
    if decisions.is_some_and(|items| items.keys().any(|path| !requested_paths.contains(path))) {
        return Err("Script backup confirmation no longer matches this update".into());
    }
    Ok((planned, requests))
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
        tree: record.tree,
        environment_choice: record.environment_choice,
        installed_environment: record.installed_environment,
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
    environment: Option<&str>,
    backup_decisions: Option<&BTreeMap<String, BackupDecision>>,
) -> Result<UpdateResult, String> {
    if let Some(id) = environment {
        if id != "latest" && !environment_id_valid(id) {
            return Err("Invalid 706 environment id".into());
        }
    }
    {
        let _guard = file_lock
            .lock()
            .map_err(|_| "Script file lock is unavailable")?;
        settings::initialise(root)?;
        recover_pending(root)?;
        ensure_game_stopped(root)?;
    }
    let client = &github_client()?;
    let previous = read_state(root)?;
    // None keeps the saved choice; "latest" follows the newest environment again.
    let choice = match environment {
        None => previous.environment_choice.clone(),
        Some("latest") => None,
        Some(id) => Some(id.to_string()),
    };
    let Selection {
        commit,
        tree,
        environment: resolved,
        mut entries,
        files: prefetched,
    } = select_entries(client, root, choice.as_deref())?;
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
        let current_hash = if target.exists() {
            let local = fs::read(&target).map_err(|error| error.to_string())?;
            if !adoptable(&entry.path, &local, &entry.sha) {
                conflicts.push(entry.path.clone());
            }
            Some(sha256(&local))
        } else {
            None
        };
        observed.insert(entry.path.clone(), current_hash);
    }
    if !conflicts.is_empty() && !overwrite_conflicts {
        return Ok(UpdateResult {
            status: "conflict",
            files: conflicts,
            backup_requests: Vec::new(),
        });
    }

    let (removals, backup_requests) = plan_removals(
        root,
        &previous,
        &remote_paths,
        &commit,
        &tree,
        &observed,
        backup_decisions,
    )?;
    if !backup_requests.is_empty() {
        return Ok(UpdateResult {
            status: "backup_confirmation",
            files: backup_requests
                .iter()
                .map(|request| request.path.clone())
                .collect(),
            backup_requests,
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
    let archive = if prefetched.is_some() {
        prefetched
    } else if needed.len() > 4 {
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
    next.environment_choice = choice.clone();
    next.installed_environment = resolved.clone();
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
        let (original_backup, original_matches_install) = match prior {
            Some(prior) => (
                prior.original_backup.clone(),
                prior.original_matches_install,
            ),
            None if target.exists() => {
                let relative = format!("backups/original/{}.bak", Uuid::new_v4());
                let original = fs::read(&target).map_err(|error| error.to_string())?;
                atomic_write(&settings::data_dir(root).join(&relative), &original)?;
                (Some(relative), Some(sha256(&original) == installed_sha256))
            }
            None => (None, Some(false)),
        };
        next.files.insert(
            entry.path.clone(),
            ManagedFile {
                blob_sha: entry.sha.clone(),
                installed_sha256,
                original_backup,
                original_matches_install,
            },
        );
        planned.push(PlannedFile {
            path: entry.path.clone(),
            after: Some(bytes),
        });
        emit_progress(app, index + 1, total);
    }
    planned.extend(removals);
    if planned.is_empty() {
        if previous.commit.as_deref() != Some(&commit)
            || previous.tree.as_deref() != Some(&tree)
            || previous.environment_choice != choice
            || previous.installed_environment != resolved
        {
            write_state(root, &next)?;
        }
        return Ok(UpdateResult {
            status: "current",
            files: Vec::new(),
            backup_requests: Vec::new(),
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
            backup_requests: Vec::new(),
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
        backup_requests: Vec::new(),
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
        backup_requests: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn env(id: &str, start: Option<i64>) -> EnvironmentEntry {
        EnvironmentEntry {
            id: id.into(),
            effective_from_unix: start,
            specials: EnvironmentSpecials {
                commit: "a".repeat(40),
                tree706: "b".repeat(40),
            },
        }
    }
    fn table(list: Vec<EnvironmentEntry>) -> Result<Vec<EnvironmentEntry>, String> {
        validate_environments(VersionTable {
            format: 1,
            environments: list,
        })
    }

    #[test]
    fn environment_ids_follow_the_table_naming() {
        for ok in ["706-20260907", "706-20261110-2", "706-20261110-12"] {
            assert!(environment_id_valid(ok), "{ok}");
        }
        for bad in [
            "706-2026090",
            "706-2026-11-10",
            "706-20261110-",
            "706-20261110x",
            "707-20261110",
            "latest",
            "",
        ] {
            assert!(!environment_id_valid(bad), "{bad}");
        }
    }

    #[test]
    fn environment_table_rules_are_enforced() {
        let first = env("706-20260907", None);
        assert_eq!(
            table(vec![
                first.clone(),
                env("706-20261110", Some(100)),
                env("706-20261201", Some(200))
            ])
            .unwrap()
            .len(),
            3
        );
        assert!(table(vec![]).is_err(), "empty");
        assert!(
            table(vec![env("706-20260907", Some(1))]).is_err(),
            "first must be null"
        );
        assert!(
            table(vec![first.clone(), env("706-20261110", None)]).is_err(),
            "only the first is null"
        );
        assert!(
            table(vec![first.clone(), env("706-20260907", Some(5))]).is_err(),
            "duplicate id"
        );
        assert!(
            table(vec![
                first.clone(),
                env("706-20261110", Some(200)),
                env("706-20261201", Some(200))
            ])
            .is_err(),
            "boundaries strictly increase"
        );
        let mut bad_sha = env("706-20261110", Some(5));
        bad_sha.specials.tree706 = "not-a-sha".into();
        assert!(
            table(vec![first.clone(), bad_sha]).is_err(),
            "tree706 must be a sha"
        );
        assert!(
            validate_environments(VersionTable {
                format: 2,
                environments: vec![first]
            })
            .is_err(),
            "unknown format"
        );
    }

    /// Network: run with `cargo test -- --ignored`. Until 706-meta exists on master
    /// the table is absent and updates must keep following master as before.
    #[test]
    #[ignore]
    fn live_table_is_absent_or_valid() {
        match environments() {
            Ok(None) => {}
            Ok(Some(list)) => assert!(!list.environments.is_empty() && valid_sha(&list.master)),
            Err(error) => panic!("environment table lookup failed: {error}"),
        }
    }

    #[test]
    fn spent_github_quota_reports_its_reset_time() {
        assert_eq!(
            rate_limit_reset(403, Some("0"), Some("1794263763")),
            Some(1794263763)
        );
        assert_eq!(rate_limit_reset(429, Some(" 0 "), Some("5")), Some(5));
        // A 403 with quota left (e.g. a private repository) is not a rate limit.
        assert_eq!(rate_limit_reset(403, Some("12"), Some("5")), None);
        assert_eq!(rate_limit_reset(403, None, Some("5")), None);
        assert_eq!(rate_limit_reset(404, Some("0"), Some("5")), None);
        assert_eq!(rate_limit_reset(403, Some("0"), Some("soon")), None);
    }

    #[test]
    fn identical_unmanaged_files_are_adopted_without_conflict() {
        let bytes = b"--old ruling\r\nlocal s,id=GetID()\r\n";
        assert!(adoptable("c10032958.lua", bytes, &git_blob_sha(bytes)));
        // One changed byte (here only the line ending) is still a conflict.
        assert!(!adoptable(
            "c10032958.lua",
            b"--old ruling\nlocal s,id=GetID()\n",
            &git_blob_sha(bytes)
        ));
        // utility.lua carries a synthetic id and is never adopted silently.
        assert!(!adoptable("utility.lua", bytes, &git_blob_sha(bytes)));
    }

    #[test]
    fn removed_scripts_drop_originals_that_were_706_copies() {
        let installed = b"706 copy".to_vec();
        let own = b"player's own script".to_vec();
        let managed = |matches| ManagedFile {
            blob_sha: git_blob_sha(&installed),
            installed_sha256: sha256(&installed),
            original_backup: Some("backups/original/x.bak".into()),
            original_matches_install: Some(matches),
        };
        // The player's own file comes back.
        assert_eq!(
            removal_result(&managed(false), Some(own.clone())),
            Some(own.clone())
        );
        // An original equal to the installed copy is removed with it.
        assert_eq!(
            removal_result(&managed(false), Some(installed.clone())),
            None
        );
        // Recorded at takeover: removed even after the 706 copy changed since.
        assert_eq!(removal_result(&managed(true), Some(own)), None);
        assert_eq!(removal_result(&managed(false), None), None);
        // Older state files without the flag still read.
        let old = r#"{"blobSha":"a","installedSha256":"b","originalBackup":null}"#;
        let file: ManagedFile = serde_json::from_str(old).unwrap();
        assert!(file.original_matches_install.is_none());
        assert!(!serde_json::to_string(&file)
            .unwrap()
            .contains("originalMatchesInstall"));
    }

    #[test]
    fn original_provenance_distinguishes_legacy_absence_from_explicit_false() {
        let old = r#"{"blobSha":"a","installedSha256":"b","originalBackup":null}"#;
        let legacy: ManagedFile = serde_json::from_str(old).unwrap();
        let known: ManagedFile =
            serde_json::from_str(&old.replace("null}", "null,\"originalMatchesInstall\":false}"))
                .unwrap();
        assert!(serde_json::to_value(&legacy)
            .unwrap()
            .get("originalMatchesInstall")
            .is_none());
        assert_eq!(
            serde_json::to_value(&known)
                .unwrap()
                .get("originalMatchesInstall"),
            Some(&serde_json::json!(false))
        );
    }

    #[test]
    fn old_pages_never_receive_a_confirmation_status_they_mistake_for_success() {
        let result = || UpdateResult {
            status: "backup_confirmation",
            files: vec!["c1.lua".into()],
            backup_requests: vec![BackupRequest {
                path: "c1.lua".into(),
                token: "token".into(),
            }],
        };
        assert!(result().for_pages(None).is_err());
        assert!(result().for_pages(Some(false)).is_err());
        assert!(result().for_pages(Some(true)).is_ok());
        let value = serde_json::to_value(result()).unwrap();
        assert_eq!(value["backupRequests"][0]["path"], "c1.lua");
    }

    struct OriginFixture {
        root: PathBuf,
        state: ScriptState,
        observed: BTreeMap<String, Option<String>>,
        original: Vec<u8>,
    }
    impl OriginFixture {
        fn new(original: &[u8]) -> Self {
            let root = std::env::temp_dir().join(format!("srvpro-origin-test-{}", Uuid::new_v4()));
            let reference = "backups/original/test.bak";
            atomic_write(&settings::data_dir(&root).join(reference), original).unwrap();
            let a = b"706 A";
            let b = b"706 B";
            let first_id = Uuid::new_v4().to_string();
            let second_id = Uuid::new_v4().to_string();
            let first = Transaction {
                id: first_id.clone(),
                previous: ScriptState::default(),
                touched: vec![TouchedFile {
                    path: "c1.lua".into(),
                    before_backup: Some("0.bak".into()),
                    before_sha256: Some(sha256(original)),
                    after_sha256: Some(sha256(a)),
                }],
            };
            let mut state = ScriptState {
                last_transaction: Some(first_id.clone()),
                ..ScriptState::default()
            };
            state.files.insert(
                "c1.lua".into(),
                ManagedFile {
                    blob_sha: git_blob_sha(a),
                    installed_sha256: sha256(a),
                    original_backup: Some(reference.into()),
                    original_matches_install: None,
                },
            );
            let second = Transaction {
                id: second_id.clone(),
                previous: state.clone(),
                touched: vec![TouchedFile {
                    path: "c1.lua".into(),
                    before_backup: Some("0.bak".into()),
                    before_sha256: Some(sha256(a)),
                    after_sha256: Some(sha256(b)),
                }],
            };
            for journal in [first, second] {
                atomic_write(
                    &transaction_path(&root, &journal.id)
                        .unwrap()
                        .join("journal.json"),
                    &serde_json::to_vec(&journal).unwrap(),
                )
                .unwrap();
            }
            state.last_transaction = Some(second_id);
            let managed = state.files.get_mut("c1.lua").unwrap();
            managed.installed_sha256 = sha256(b);
            managed.blob_sha = git_blob_sha(b);
            atomic_write(&target_path(&root, "c1.lua").unwrap(), b).unwrap();
            Self {
                root,
                state,
                observed: BTreeMap::from([("c1.lua".into(), Some(sha256(b)))]),
                original: original.to_vec(),
            }
        }
        fn plan(
            &self,
            decisions: Option<&BTreeMap<String, BackupDecision>>,
        ) -> Result<(Vec<PlannedFile>, Vec<BackupRequest>), String> {
            plan_removals(
                &self.root,
                &self.state,
                &HashSet::new(),
                "commit",
                "tree",
                &self.observed,
                decisions,
            )
        }
        fn assert_untouched(&self) {
            assert_eq!(
                read_original(&self.root, "backups/original/test.bak").unwrap(),
                self.original
            );
            assert_eq!(
                fs::read(target_path(&self.root, "c1.lua").unwrap()).unwrap(),
                b"706 B"
            );
            assert!(!pending_path(&self.root).exists());
        }
    }
    impl Drop for OriginFixture {
        fn drop(&mut self) {
            assert!(self.root.starts_with(std::env::temp_dir()));
            assert!(self
                .root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("srvpro-origin-test-"));
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn legacy_a_to_b_then_removed_uses_only_positive_history_evidence() {
        let copied = OriginFixture::new(b"706 A");
        let (plan, requests) = copied.plan(None).unwrap();
        assert!(requests.is_empty());
        assert!(plan[0].after.is_none());
        copied.assert_untouched();
        let custom = OriginFixture::new(b"player's own original");
        let (_, requests) = custom.plan(None).unwrap();
        // A different first-install hash does not establish that this was the
        // player's own file: it might also be an even older manually copied 706.
        assert_eq!(requests.len(), 1);
        let choices = BTreeMap::from([(
            "c1.lua".into(),
            BackupDecision {
                token: requests[0].token.clone(),
                action: BackupAction::Restore,
            },
        )]);
        let (plan, requests) = custom.plan(Some(&choices)).unwrap();
        assert!(requests.is_empty());
        assert_eq!(plan[0].after.as_deref(), Some(custom.original.as_slice()));
        custom.assert_untouched();
        let mut old_copy = OriginFixture::new(b"706 A");
        let newest = tx_journal(
            &old_copy.root,
            old_copy.state.last_transaction.as_deref().unwrap(),
        )
        .unwrap();
        old_copy.state.last_transaction = newest.previous.last_transaction;
        assert_eq!(
            old_copy.plan(None).unwrap().1.len(),
            1,
            "an original that differs from the first installed version also needs confirmation"
        );
        old_copy.assert_untouched();
    }

    #[test]
    fn known_originals_retained_files_and_missing_backups_are_handled_safely() {
        let mut fixture = OriginFixture::new(b"player original");
        fixture
            .state
            .files
            .get_mut("c1.lua")
            .unwrap()
            .original_matches_install = Some(false);
        fixture.state.last_transaction = None;
        let (plan, requests) = fixture.plan(None).unwrap();
        assert!(requests.is_empty());
        assert_eq!(plan[0].after.as_deref(), Some(fixture.original.as_slice()));
        let (plan, requests) = plan_removals(
            &fixture.root,
            &fixture.state,
            &HashSet::from(["c1.lua"]),
            "commit",
            "tree",
            &fixture.observed,
            None,
        )
        .unwrap();
        assert!(plan.is_empty() && requests.is_empty());
        let backup = settings::data_dir(&fixture.root).join("backups/original/test.bak");
        fs::remove_file(&backup).unwrap();
        assert!(
            fixture.plan(None).is_err(),
            "never remove an override with an unreadable original backup"
        );
        atomic_write(&backup, &fixture.original).unwrap();
        fixture.assert_untouched();
    }

    #[test]
    fn unknown_origin_needs_confirmation_before_any_changes_and_keeps_backups() {
        let mut fixture = OriginFixture::new(b"706 A");
        fixture.state.last_transaction = None;
        let (_, requests) = fixture.plan(None).unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].path, "c1.lua");
        for action in [BackupAction::Drop, BackupAction::Restore] {
            let restore = matches!(action, BackupAction::Restore);
            let choices = BTreeMap::from([(
                "c1.lua".into(),
                BackupDecision {
                    token: requests[0].token.clone(),
                    action,
                },
            )]);
            let (plan, requests) = fixture.plan(Some(&choices)).unwrap();
            assert!(requests.is_empty());
            assert_eq!(
                plan[0].after.as_deref(),
                restore.then_some(fixture.original.as_slice())
            );
            fixture.assert_untouched();
        }
    }

    #[test]
    fn confirmation_is_invalidated_by_state_target_backup_or_current_file_changes() {
        let mut fixture = OriginFixture::new(b"706 A");
        fixture.state.last_transaction = None;
        let (_, requests) = fixture.plan(None).unwrap();
        let choices = BTreeMap::from([(
            "c1.lua".into(),
            BackupDecision {
                token: requests[0].token.clone(),
                action: BackupAction::Drop,
            },
        )]);
        assert!(plan_removals(
            &fixture.root,
            &fixture.state,
            &HashSet::new(),
            "other commit",
            "tree",
            &fixture.observed,
            Some(&choices)
        )
        .is_err());
        fixture.state.commit = Some("other state".into());
        assert!(fixture.plan(Some(&choices)).is_err());
        fixture.state.commit = None;
        fixture
            .observed
            .insert("c1.lua".into(), Some(sha256(b"edited")));
        assert!(fixture.plan(Some(&choices)).is_err());
        fixture
            .observed
            .insert("c1.lua".into(), Some(sha256(b"706 B")));
        atomic_write(
            &settings::data_dir(&fixture.root).join("backups/original/test.bak"),
            b"changed backup",
        )
        .unwrap();
        assert!(fixture.plan(Some(&choices)).is_err());
        atomic_write(
            &settings::data_dir(&fixture.root).join("backups/original/test.bak"),
            &fixture.original,
        )
        .unwrap();
        let extra = BTreeMap::from([(
            "c2.lua".into(),
            BackupDecision {
                token: "invalid".into(),
                action: BackupAction::Drop,
            },
        )]);
        assert!(fixture.plan(Some(&extra)).is_err());
        fixture.assert_untouched();
    }

    #[test]
    fn incomplete_corrupt_or_unrelated_history_never_proves_a_backup_origin() {
        for mode in [
            "missing",
            "corrupt",
            "wrong id",
            "different backup",
            "cycle",
        ] {
            let mut fixture = OriginFixture::new(b"706 A");
            let id = fixture.state.last_transaction.clone().unwrap();
            let path = transaction_path(&fixture.root, &id)
                .unwrap()
                .join("journal.json");
            let mut journal = tx_journal(&fixture.root, &id).unwrap();
            match mode {
                "missing" => {
                    fs::remove_file(&path).unwrap();
                }
                "corrupt" => {
                    fs::write(&path, b"invalid").unwrap();
                }
                "wrong id" => {
                    journal.id = Uuid::new_v4().to_string();
                }
                "different backup" => {
                    journal
                        .previous
                        .files
                        .get_mut("c1.lua")
                        .unwrap()
                        .original_backup = Some("backups/original/other.bak".into());
                }
                "cycle" => {
                    journal.previous = fixture.state.clone();
                }
                _ => unreachable!(),
            }
            if !matches!(mode, "missing" | "corrupt") {
                fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
            }
            let (_, requests) = fixture.plan(None).unwrap();
            assert_eq!(requests.len(), 1, "{mode}");
            fixture.assert_untouched();
            fixture.state.last_transaction = None;
        }
    }

    #[test]
    fn older_state_files_read_without_environment_fields() {
        let old = r#"{"commit":null,"tree":null,"files":{},"lastTransaction":null}"#;
        let state: ScriptState = serde_json::from_str(old).unwrap();
        assert!(state.environment_choice.is_none() && state.installed_environment.is_none());
    }

    #[test]
    fn original_client_utility_runs_special_after_defining_it() {
        let base = b"Auxiliary={}\naux=Auxiliary\nNULL_VALUE=-10\nfunction GetID() end\n";
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
        assert_eq!(parsed.get("special.lua").unwrap().as_slice(), content);
        let mut bad = entry;
        bad.sha = "0000000000000000000000000000000000000000".into();
        assert!(parse_archive(bytes, commit, &[bad]).is_err());
    }

    fn blob(path: &str, content: &[u8]) -> GitEntry {
        GitEntry {
            path: path.into(),
            mode: "100644".into(),
            kind: "blob".into(),
            sha: git_blob_sha(content),
            size: Some(content.len()),
        }
    }
    /// `git write-tree` of these four files; "sub.lua" sorts before folder "sub".
    const VECTOR_TREE: &str = "6f30343bea9d213b313f654c37c42d7127876ef9";
    fn vector() -> Vec<(&'static str, &'static [u8])> {
        vec![
            ("sub/deep/c.lua", b"w\n"),
            ("a.lua", b"x\n"),
            ("sub/b.lua", b"z\n"),
            ("sub.lua", b"y\n"),
        ]
    }
    fn vector_archive(commit: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::FileOptions::default();
        writer
            .add_directory(format!("specials-{commit}/706/sub/"), options)
            .unwrap();
        for (path, content) in files {
            writer
                .start_file(format!("specials-{commit}/706/{path}"), options)
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer
            .start_file(format!("specials-{commit}/706-meta/versions.json"), options)
            .unwrap();
        writer.write_all(b"{}").unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn tree_id_matches_git_write_tree() {
        let entries: Vec<GitEntry> = vector().into_iter().map(|(p, c)| blob(p, c)).collect();
        assert_eq!(tree_sha(&entries).unwrap(), VECTOR_TREE);
        // A different mode or content is a different tree.
        let mut executable = entries.clone();
        executable[1].mode = "100755".into();
        assert_ne!(tree_sha(&executable).unwrap(), VECTOR_TREE);
        let mut twice = entries.clone();
        twice.push(blob("a.lua", b"x\n"));
        assert!(tree_sha(&twice).is_err());
        let mut both = entries;
        both.push(blob("a.lua/inner.lua", b"x\n"));
        assert!(tree_sha(&both).is_err());
    }

    #[test]
    fn master_is_read_from_the_git_ref_list() {
        fn pkt(line: &[u8]) -> Vec<u8> {
            let mut out = format!("{:04x}", line.len() + 4).into_bytes();
            out.extend_from_slice(line);
            out
        }
        let master = "40c4b3b391624f39c6e5aa8da2cbe8205a62651f";
        let list = |refs: &[Vec<u8>]| {
            let mut out = pkt(b"# service=git-upload-pack\n");
            out.extend_from_slice(b"0000");
            for line in refs {
                out.extend(pkt(line));
            }
            out.extend_from_slice(b"0000");
            out
        };
        let head = format!("{master} HEAD\0multi_ack symref=HEAD:refs/heads/master\n").into_bytes();
        let good = list(&[
            head.clone(),
            format!("{} refs/heads/main\n", "1".repeat(40)).into_bytes(),
            format!("{master} refs/heads/master\n").into_bytes(),
        ]);
        assert_eq!(parse_master_ref(&good).unwrap(), master);
        // Master as the first ref carries the capabilities.
        let first = list(&[format!("{master} refs/heads/master\0caps\n").into_bytes()]);
        assert_eq!(parse_master_ref(&first).unwrap(), master);
        assert!(parse_master_ref(&list(&[head])).is_err());
        let twice = list(&[
            format!("{master} refs/heads/master\n").into_bytes(),
            format!("{master} refs/heads/master\n").into_bytes(),
        ]);
        assert!(parse_master_ref(&twice).is_err());
        assert!(parse_master_ref(&list(&[b"nothex refs/heads/master\n".to_vec()])).is_err());
        let mut cut = good.clone();
        cut.truncate(good.len() - 10);
        assert!(parse_master_ref(&cut).is_err());
        assert!(parse_master_ref(b"<html>rate limited</html>").is_err());
    }

    #[test]
    fn archive_list_is_verified_cached_and_rejected_when_tampered() {
        let commit = "0123456789abcdef0123456789abcdef01234567";
        let (entries, files) = archive_tree(vector_archive(commit, &vector()), commit).unwrap();
        assert_eq!(tree_sha(&entries).unwrap(), VECTOR_TREE);
        assert_eq!(files.len(), 4);
        assert_eq!(files.get("sub/deep/c.lua").unwrap().as_slice(), b"w\n");
        // A changed script gives another tree id.
        let mut changed = vector();
        changed[1].1 = b"X\n";
        let (other, _) = archive_tree(vector_archive(commit, &changed), commit).unwrap();
        assert_ne!(tree_sha(&other).unwrap(), VECTOR_TREE);
        // Nothing under 706/ is an error, not an empty environment.
        assert!(archive_tree(vector_archive(commit, &[]), commit).is_err());

        let root = std::env::temp_dir().join(format!("srvpro-script-test-{}", Uuid::new_v4()));
        let cache = tree_cache_dir(&root).join(format!("{VECTOR_TREE}.json"));
        write_tree_cache(&root, &cache, &entries).unwrap();
        assert_eq!(read_tree_cache(&cache, VECTOR_TREE).unwrap().len(), 4);
        // Read under another tree id, or after an edit, the list is dropped.
        assert!(read_tree_cache(&cache, &"0".repeat(40)).is_none());
        assert!(!cache.exists());
        let mut tampered = entries.clone();
        tampered[0].sha = git_blob_sha(b"other");
        write_tree_cache(&root, &cache, &tampered).unwrap();
        assert!(read_tree_cache(&cache, VECTOR_TREE).is_none());
        assert!(!cache.exists());
        fs::write(&cache, b"not json").unwrap();
        assert!(read_tree_cache(&cache, VECTOR_TREE).is_none());
        // Only the newest lists are kept.
        for index in 0..TREE_CACHE_LIMIT + 3 {
            let path = tree_cache_dir(&root).join(format!("{index:040}.json"));
            write_tree_cache(&root, &path, &entries).unwrap();
        }
        assert_eq!(
            fs::read_dir(tree_cache_dir(&root)).unwrap().count(),
            TREE_CACHE_LIMIT
        );
        let last = format!("{:040}.json", TREE_CACHE_LIMIT + 2);
        assert!(tree_cache_dir(&root).join(last).exists());
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }

    /// Network: run with `cargo test -- --ignored`. Every live environment's 706
    /// list is rebuilt from its archive alone and must match the table.
    #[test]
    #[ignore]
    fn live_environments_verify_without_the_rest_api() {
        let client = &github_client().unwrap();
        let master =
            parse_master_ref(&download_bytes(client, REFS_URL, "refs", REFS_LIMIT).unwrap())
                .unwrap();
        let list = environment_table(client, &master).unwrap().unwrap();
        let root = std::env::temp_dir().join(format!("srvpro-script-test-{}", Uuid::new_v4()));
        for entry in list {
            let (entries, files) = local_entries(
                client,
                &root,
                &entry.specials.commit,
                &entry.specials.tree706,
            )
            .unwrap_or_else(|error| panic!("{}: {error}", entry.id));
            assert_eq!(files.unwrap().len(), entries.len(), "{}", entry.id);
            // Second time from the cache, without downloading.
            let (cached, none) = local_entries(
                client,
                &root,
                &entry.specials.commit,
                &entry.specials.tree706,
            )
            .unwrap();
            assert!(none.is_none() && cached.len() == entries.len());
        }
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
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
