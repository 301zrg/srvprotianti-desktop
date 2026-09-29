use crate::{game, scripts, settings};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

const REVISION: &str = "1103-201103-v1";
const LANGUAGES: [(&str, &str); 4] = [
    ("zh", "zh-CN"),
    ("ja", "ja-JP"),
    ("en", "en-US"),
    ("ko", "ko-KR"),
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    path: String,
    original_sha256: Option<String>,
    managed_sha256: Option<String>,
    #[serde(default)]
    pending_previous_sha256: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallState {
    schema_version: u32,
    revision: String,
    kind: String,
    backup_id: String,
    phase: String,
    entries: Vec<Entry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateView {
    installed: bool,
    revision: Option<String>,
    kind: Option<String>,
    needs_recovery: bool,
}

fn state_path(root: &Path) -> PathBuf {
    settings::data_dir(root).join("environment-state.json")
}

fn backup_root(root: &Path, state: &InstallState) -> Result<PathBuf, String> {
    Uuid::parse_str(&state.backup_id).map_err(|_| "Invalid environment backup ID")?;
    checked_path(root, &format!("srvprotianti-desktop-data/environment-backups/{}", state.backup_id))
}

fn asset_root(root: &Path) -> (PathBuf, bool) {
    let portable = settings::data_dir(root).join("resources").join(REVISION);
    if portable.exists() || !cfg!(debug_assertions) {
        (portable, true)
    } else {
        #[cfg(debug_assertions)]
        {
            (Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("environment")
                .join(REVISION), false)
        }
        #[cfg(not(debug_assertions))]
        {
            (portable, true)
        }
    }
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_relative(relative: &str) -> Result<(), String> {
    let path = Path::new(relative);
    if path.as_os_str().is_empty()
        || path.components().any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Invalid environment file path".into());
    }
    Ok(())
}

fn checked_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_relative(relative)?;
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        path.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if settings::is_link_or_reparse(&metadata) {
                return Err(format!("Environment path is a link: {relative}"));
            }
        }
    }
    Ok(path)
}

fn read_if_exists(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read {}: {error}", path.display())),
    }
}

fn save_state(root: &Path, state: &InstallState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    settings::atomic_write(&state_path(root), &bytes)
}

fn load_state(root: &Path) -> Result<Option<InstallState>, String> {
    let path = state_path(root);
    let Some(bytes) = read_if_exists(&path)? else {
        return Ok(None);
    };
    let state: InstallState = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Environment state is damaged; keep its backups: {error}"))?;
    if state.schema_version != 1 || state.revision != REVISION {
        return Err("Unsupported environment state; keep its backups".into());
    }
    backup_root(root, &state)?;
    for entry in &state.entries {
        validate_relative(&entry.path)?;
    }
    Ok(Some(state))
}

pub fn state(root: &Path) -> Result<StateView, String> {
    let state = load_state(root)?;
    Ok(StateView {
        installed: state.as_ref().is_some_and(|value| value.phase == "active"),
        revision: state.as_ref().map(|value| value.revision.clone()),
        kind: state.as_ref().map(|value| value.kind.clone()),
        needs_recovery: state.as_ref().is_some_and(|value| value.phase != "active"),
    })
}

fn ensure_stopped(root: &Path) -> Result<settings::Settings, String> {
    let config = settings::load(root)?;
    game::executable(root, &config)?;
    if scripts::game_running(root, &config.game.executable) {
        return Err("Close the game before changing the 1103 environment".into());
    }
    Ok(config)
}

fn asset(root: &Path, name: &str) -> Result<Vec<u8>, String> {
    validate_relative(name)?;
    let (base, portable) = asset_root(root);
    let relative = format!("srvprotianti-desktop-data/resources/{REVISION}/{name}");
    let path = if portable {
        checked_path(root, &relative)?
    } else {
        let mut path = base.clone();
        for component in Path::new(name).components() {
            path.push(component.as_os_str());
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Missing bundled environment resource: {error}"))?;
            if settings::is_link_or_reparse(&metadata) {
                return Err("Bundled resource path is a link".into());
            }
        }
        path
    };
    fs::read(path).map_err(|error| format!("Missing bundled environment resource: {error}"))
}

fn verified_assets(root: &Path) -> Result<(), String> {
    let manifest: serde_json::Value = serde_json::from_slice(&asset(root, "manifest.json")?)
        .map_err(|error| format!("Invalid environment manifest: {error}"))?;
    if manifest["revision"] != REVISION || manifest["cardCount"] != 5267 {
        return Err("Unexpected environment resource version".into());
    }
    let banlist = asset(root, "lflist.conf")?;
    if manifest["banlistSha256"].as_str() != Some(hash(&banlist).as_str()) {
        return Err("Bundled banlist failed integrity check".into());
    }
    for (_, locale) in LANGUAGES {
        for (name, key) in [("cards.cdb", "cardsSha256"), ("strings.conf", "stringsSha256")] {
            let bytes = asset(root, &format!("{locale}/{name}"))?;
            if manifest["locales"][locale][key].as_str() != Some(hash(&bytes).as_str()) {
                return Err(format!("Bundled {locale}/{name} failed integrity check"));
            }
        }
    }
    Ok(())
}

fn snapshot(root: &Path, state: &mut InstallState, relative: &str) -> Result<(), String> {
    if state.entries.iter().any(|entry| entry.path == relative) {
        return Ok(());
    }
    let path = checked_path(root, relative)?;
    let original = read_if_exists(&path)?;
    if let Some(bytes) = &original {
        if !path.is_file() {
            return Err(format!("Environment target is not a file: {relative}"));
        }
        let backup = checked_path(&backup_root(root, state)?, relative)?;
        settings::atomic_write(&backup, bytes)?;
    }
    state.entries.push(Entry {
        path: relative.into(),
        original_sha256: original.as_ref().map(|bytes| hash(bytes)),
        managed_sha256: original.as_ref().map(|bytes| hash(bytes)),
        pending_previous_sha256: None,
    });
    save_state(root, state)
}

fn verify_managed(root: &Path, entry: &Entry) -> Result<(), String> {
    let path = checked_path(root, &entry.path)?;
    let current = read_if_exists(&path)?.as_ref().map(|bytes| hash(bytes));
    if current != entry.managed_sha256 {
        return Err(format!("Environment file changed outside the assistant: {}. Restore it manually or keep the backup before retrying", entry.path));
    }
    Ok(())
}

fn verify_recoverable(root: &Path, entry: &Entry) -> Result<(), String> {
    let path = checked_path(root, &entry.path)?;
    let current = read_if_exists(&path)?.as_ref().map(|bytes| hash(bytes));
    let previous = entry.pending_previous_sha256.as_ref().map(|value| {
        if value == "__missing__" { None } else { Some(value.clone()) }
    }).unwrap_or(None);
    if current == entry.managed_sha256 || current == entry.original_sha256
        || (entry.pending_previous_sha256.is_some() && current == previous) {
        Ok(())
    } else {
        Err(format!("Environment file changed outside the assistant: {}. Keep its backup and review before restoring", entry.path))
    }
}

fn put(root: &Path, state: &mut InstallState, relative: &str, bytes: &[u8]) -> Result<(), String> {
    snapshot(root, state, relative)?;
    let entry = state.entries.iter_mut().find(|entry| entry.path == relative).unwrap();
    verify_managed(root, entry)?;
    entry.pending_previous_sha256 = Some(entry.managed_sha256.clone().unwrap_or_else(|| "__missing__".into()));
    entry.managed_sha256 = Some(hash(bytes));
    save_state(root, state)?; // Journal the intended bytes before replacing the target.
    let path = checked_path(root, relative)?;
    settings::atomic_write(&path, bytes)?;
    let entry = state.entries.iter_mut().find(|entry| entry.path == relative).unwrap();
    entry.pending_previous_sha256 = None;
    save_state(root, state)
}

fn stage_cdb(root: &Path, state: &mut InstallState, relative: &str) -> Result<(), String> {
    snapshot(root, state, relative)?;
    let entry = state.entries.iter_mut().find(|entry| entry.path == relative).unwrap();
    verify_managed(root, entry)?;
    entry.pending_previous_sha256 = Some(entry.managed_sha256.clone().unwrap_or_else(|| "__missing__".into()));
    entry.managed_sha256 = None;
    save_state(root, state)?;
    let path = checked_path(root, relative)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("Cannot stage {relative}: {error}"))?;
    }
    let entry = state.entries.iter_mut().find(|entry| entry.path == relative).unwrap();
    entry.pending_previous_sha256 = None;
    save_state(root, state)
}

fn collect_files(root: &Path, directory: &str, output: &mut Vec<String>) -> Result<(), String> {
    let path = checked_path(root, directory)?;
    for item in fs::read_dir(&path).map_err(|error| format!("Cannot read {directory}: {error}"))? {
        let item = item.map_err(|error| error.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        let relative = format!("{directory}/{name}");
        let metadata = fs::symlink_metadata(item.path()).map_err(|error| error.to_string())?;
        if settings::is_link_or_reparse(&metadata) {
            return Err(format!("Locale path is a link: {relative}"));
        }
        if metadata.is_dir() {
            collect_files(root, &relative, output)?;
        } else if metadata.is_file() {
            output.push(relative);
        } else {
            return Err(format!("Unsupported locale item: {relative}"));
        }
    }
    Ok(())
}

fn config_values(original: &[u8], updates: &[(&str, String)]) -> Result<Vec<u8>, String> {
    let text = std::str::from_utf8(original).map_err(|_| "Game configuration is not UTF-8")?;
    let mut result = String::new();
    let mut found = vec![false; updates.len()];
    for line in text.lines() {
        let key = line.split_once('=').map(|(key, _)| key.trim());
        if let Some((index, _)) = updates
            .iter()
            .enumerate()
            .find(|(_, (candidate, _))| Some(*candidate) == key)
        {
            if !found[index] {
                result.push_str(&format!("{} = {value}\n", updates[index].0));
                found[index] = true;
            }
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }
    for (index, (key, value)) in updates.iter().enumerate() {
        if !found[index] {
            result.push_str(&format!("{key} = {value}\n"));
        }
    }
    Ok(result.into_bytes())
}

fn ensure_banlist(root: &Path, state: &mut InstallState) -> Result<(), String> {
    let relative = "expansions/lflist.conf";
    let existing = if let Some(entry) = state.entries.iter().find(|entry| entry.path == relative) {
        if entry.original_sha256.is_some() {
            fs::read(checked_path(&backup_root(root, state)?, relative)?)
                .map_err(|error| format!("Missing original banlist backup: {error}"))?
        } else { Vec::new() }
    } else {
        read_if_exists(&checked_path(root, relative)?)?.unwrap_or_default()
    };
    let mut result = asset(root, "lflist.conf")?;
    if !result.ends_with(b"\n") {
        result.push(b'\n');
    }
    result.extend_from_slice(&existing);
    put(root, state, relative, &result)
}

fn install_koishi(root: &Path, state: &mut InstallState, config: &settings::Settings) -> Result<(), String> {
    for (_, locale) in LANGUAGES {
        let source = format!("locales/{locale}");
        let target = format!("locales/1103_{locale}");
        let mut files = Vec::new();
        collect_files(root, &source, &mut files)?;
        if !files.iter().any(|file| file == &format!("{source}/cards.cdb")) {
            return Err(format!("Missing base locale card database: {source}"));
        }
        for file in files {
            let suffix = file.strip_prefix(&source).unwrap();
            let content = fs::read(checked_path(root, &file)?).map_err(|error| error.to_string())?;
            put(root, state, &format!("{target}{suffix}"), &content)?;
        }
        put(root, state, &format!("{target}/cards.cdb"), &asset(root, &format!("{locale}/cards.cdb"))?)?;
        put(root, state, &format!("{target}/strings.conf"), &asset(root, &format!("{locale}/strings.conf"))?)?;
        let server_file = format!("{target}/servers.conf");
        let original = read_if_exists(&checked_path(root, &server_file)?)?.unwrap_or_default();
        let text = std::str::from_utf8(&original).map_err(|_| "servers.conf is not UTF-8")?;
        let mut updated = text.lines().filter(|line| !line.starts_with("706 Ladder|"))
            .collect::<Vec<_>>().join("\n");
        if !updated.is_empty() { updated.push('\n'); }
        updated.push_str(&format!("706 Ladder|{}:{}\n", config.server.game_host, config.server.game_port));
        put(root, state, &server_file, updated.as_bytes())?;
    }
    Ok(())
}

fn apply_locale_and_config(root: &Path, state: &mut InstallState, config: &settings::Settings) -> Result<(), String> {
    let locale = LANGUAGES.iter().find(|(language, _)| *language == config.ui.language.as_str())
        .map(|(_, locale)| *locale).ok_or("Unsupported resource language")?;
    if state.kind == "ygopro" {
        put(root, state, "cards.cdb", &asset(root, &format!("{locale}/cards.cdb"))?)?;
    }
    let relative = "system_user.conf";
    let old = read_if_exists(&checked_path(root, relative)?)?.unwrap_or_default();
    let mut updates = vec![("use_lflist", "1".to_string()), ("default_lflist", "0".to_string())];
    if state.kind == "koishipro" {
        updates.push(("locale", format!("1103_{locale}")));
    }
    put(root, state, relative, &config_values(&old, &updates)?)?;
    Ok(())
}

fn stage_expansion_databases(root: &Path, state: &mut InstallState) -> Result<(), String> {
    let directory = checked_path(root, "expansions")?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for item in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.to_ascii_lowercase().ends_with(".cdb") {
            let relative = format!("expansions/{name}");
            stage_cdb(root, state, &relative)?;
        }
    }
    Ok(())
}

pub fn install(root: &Path) -> Result<StateView, String> {
    let config = ensure_stopped(root)?;
    verified_assets(root)?;
    let kind = if scripts::is_koishipro(root)? { "koishipro" } else { "ygopro" };
    let mut state = if let Some(state) = load_state(root)? {
        if state.phase != "active" || state.kind != kind {
            return Err("Environment needs recovery or the game executable changed".into());
        }
        for entry in &state.entries { verify_managed(root, entry)?; }
        state
    } else {
        InstallState { schema_version: 1, revision: REVISION.into(), kind: kind.into(),
            backup_id: Uuid::new_v4().to_string(), phase: "installing".into(), entries: Vec::new() }
    };
    state.phase = "installing".into();
    save_state(root, &state)?;
    let result = (|| {
        stage_expansion_databases(root, &mut state)?;
        if kind == "koishipro" { install_koishi(root, &mut state, &config)?; }
        ensure_banlist(root, &mut state)?;
        apply_locale_and_config(root, &mut state, &config)?;
        state.phase = "active".into();
        save_state(root, &state)
    })();
    if let Err(error) = result {
        let rollback = restore_inner(root, &mut state);
        return Err(match rollback {
            Ok(()) => format!("Environment installation rolled back: {error}"),
            Err(recovery) => format!("Environment installation stopped: {error}; recovery needed: {recovery}"),
        });
    }
    self::state(root)
}

fn restore_inner(root: &Path, state: &mut InstallState) -> Result<(), String> {
    state.phase = "restoring".into();
    save_state(root, state)?;
    // Check every target before touching any. Edited managed files are never silently lost.
    for entry in &state.entries { verify_recoverable(root, entry)?; }
    for entry in state.entries.iter().rev() {
        let path = checked_path(root, &entry.path)?;
        if entry.original_sha256.is_some() {
            let backup = checked_path(&backup_root(root, state)?, &entry.path)?;
            let bytes = fs::read(&backup).map_err(|error| format!("Missing environment backup: {error}"))?;
            if Some(hash(&bytes)) != entry.original_sha256 {
                return Err(format!("Environment backup checksum mismatch: {}", entry.path));
            }
            settings::atomic_write(&path, &bytes)?;
        } else if path.exists() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
    }
    for (_, locale) in LANGUAGES {
        let directory = checked_path(root, &format!("locales/1103_{locale}"))?;
        if directory.exists() {
            let _ = fs::remove_dir(&directory); // Only remove a directory that became empty.
        }
    }
    fs::remove_file(state_path(root)).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn restore(root: &Path) -> Result<StateView, String> {
    ensure_stopped(root)?;
    let Some(mut state) = load_state(root)? else { return self::state(root); };
    restore_inner(root, &mut state)?;
    self::state(root)
}

pub fn prepare_launch(root: &Path, config: &settings::Settings) -> Result<(), String> {
    let Some(mut state) = load_state(root)? else { return Ok(()); };
    if state.phase != "active" { return Err("Recover the 1103 environment before starting the game".into()); }
    verified_assets(root)?;
    for entry in &state.entries { verify_managed(root, entry)?; }
    // A live game may read the same files; launch without rewriting only when the
    // selected language and server are already synchronized.
    let locale = LANGUAGES.iter().find(|(language, _)| *language == config.ui.language.as_str())
        .map(|(_, locale)| *locale).ok_or("Unsupported resource language")?;
    let old_config = read_if_exists(&checked_path(root, "system_user.conf")?)?.unwrap_or_default();
    let mut updates = vec![("use_lflist", "1".to_string()), ("default_lflist", "0".to_string())];
    if state.kind == "koishipro" { updates.push(("locale", format!("1103_{locale}"))); }
    let mut needs_sync = config_values(&old_config, &updates)? != old_config;
    if state.kind == "ygopro" {
        needs_sync |= read_if_exists(&checked_path(root, "cards.cdb")?)?
            != Some(asset(root, &format!("{locale}/cards.cdb"))?);
    }
    let expansion_dir = checked_path(root, "expansions")?;
    if expansion_dir.exists() {
        for item in fs::read_dir(expansion_dir).map_err(|error| error.to_string())? {
            let name = item.map_err(|error| error.to_string())?.file_name().to_string_lossy().into_owned();
            if name.to_ascii_lowercase().ends_with(".cdb") { needs_sync = true; }
        }
    }
    if state.kind == "koishipro" {
        for (_, locale) in LANGUAGES {
            let relative = format!("locales/1103_{locale}/servers.conf");
            let old = read_if_exists(&checked_path(root, &relative)?)?.unwrap_or_default();
            let text = std::str::from_utf8(&old).map_err(|_| "servers.conf is not UTF-8")?;
            let mut expected = text.lines().filter(|line| !line.starts_with("706 Ladder|"))
                .collect::<Vec<_>>().join("\n");
            if !expected.is_empty() { expected.push('\n'); }
            expected.push_str(&format!("706 Ladder|{}:{}\n", config.server.game_host, config.server.game_port));
            if expected.as_bytes() != old.as_slice() { needs_sync = true; }
        }
    }
    if !needs_sync { return Ok(()); }
    if scripts::game_running(root, &config.game.executable) {
        return Err("Close the running game before changing 1103 language or server resources".into());
    }
    state.phase = "installing".into();
    save_state(root, &state)?;
    let result = (|| {
        stage_expansion_databases(root, &mut state)?;
        if state.kind == "koishipro" {
            // Refresh all four server lists when the saved game address changes.
            for (_, locale) in LANGUAGES {
                let relative = format!("locales/1103_{locale}/servers.conf");
                let old = read_if_exists(&checked_path(root, &relative)?)?.unwrap_or_default();
                let text = std::str::from_utf8(&old).map_err(|_| "servers.conf is not UTF-8")?;
                let mut result = text.lines().filter(|line| !line.starts_with("706 Ladder|"))
                    .collect::<Vec<_>>().join("\n");
                if !result.is_empty() { result.push('\n'); }
                result.push_str(&format!("706 Ladder|{}:{}\n", config.server.game_host, config.server.game_port));
                put(root, &mut state, &relative, result.as_bytes())?;
            }
        }
        apply_locale_and_config(root, &mut state, config)?;
        state.phase = "active".into();
        save_state(root, &state)
    })();
    if let Err(error) = result {
        let recovery = restore_inner(root, &mut state);
        return Err(match recovery {
            Ok(()) => format!("Environment update rolled back: {error}"),
            Err(failure) => format!("Environment update failed: {error}; recovery needed: {failure}"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_keys_are_replaced_without_erasing_other_settings() {
        let original = b"sound = 1\nlocale = old\nuse_lflist = 0\n";
        let output = config_values(original, &[("locale", "1103_zh-CN".into()), ("default_lflist", "0".into())]).unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("sound = 1\n"));
        assert!(text.contains("locale = 1103_zh-CN\n"));
        assert!(text.contains("default_lflist = 0\n"));
        assert!(!text.contains("locale = old"));
    }

    #[test]
    fn unsafe_relative_path_is_rejected() {
        for path in ["../cards.cdb", "/cards.cdb", "locales/../cards.cdb", ""] {
            assert!(validate_relative(path).is_err());
        }
    }

    fn fixture(koishi: bool) -> PathBuf {
        let root = std::env::temp_dir().join(format!("srvpro-environment-test-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("expansions")).unwrap();
        fs::write(root.join("ygopro.exe"), if koishi { &b"MZ KoishiPro"[..] } else { &b"MZ"[..] }).unwrap();
        fs::write(root.join("cards.cdb"), b"original root database").unwrap();
        fs::write(root.join("system_user.conf"), b"sound = 1\nlocale = zh-CN\n").unwrap();
        fs::write(root.join("expansions/extra.cdb"), b"extra database").unwrap();
        fs::write(root.join("expansions/lflist.conf"), b"!Other list\n123 0\n").unwrap();
        if koishi {
            for (_, locale) in LANGUAGES {
                let path = root.join("locales").join(locale);
                fs::create_dir_all(&path).unwrap();
                fs::write(path.join("cards.cdb"), b"base database").unwrap();
                fs::write(path.join("strings.conf"), b"base strings").unwrap();
                fs::write(path.join("servers.conf"), b"Existing|host:123\n").unwrap();
                fs::write(path.join("bot.conf"), b"bot config").unwrap();
            }
        }
        root
    }

    #[test]
    fn original_ygopro_files_survive_install_language_change_and_restore() {
        let root = fixture(false);
        let mut config = settings::load(&root).unwrap();
        assert!(install(&root).unwrap().installed);
        assert!(!root.join("expansions/extra.cdb").exists());
        assert_eq!(fs::read(root.join("cards.cdb")).unwrap(), asset(&root, "zh-CN/cards.cdb").unwrap());
        assert!(fs::read_to_string(root.join("expansions/lflist.conf")).unwrap().starts_with("#[2011.3.1]"));
        config.ui.language = "ja".into();
        prepare_launch(&root, &config).unwrap();
        assert_eq!(fs::read(root.join("cards.cdb")).unwrap(), asset(&root, "ja-JP/cards.cdb").unwrap());
        assert!(!prepare_launch(&root, &config).is_err());
        restore(&root).unwrap();
        assert_eq!(fs::read(root.join("cards.cdb")).unwrap(), b"original root database");
        assert_eq!(fs::read(root.join("expansions/extra.cdb")).unwrap(), b"extra database");
        assert_eq!(fs::read(root.join("expansions/lflist.conf")).unwrap(), b"!Other list\n123 0\n");
        assert_eq!(fs::read(root.join("system_user.conf")).unwrap(), b"sound = 1\nlocale = zh-CN\n");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn koishi_clones_four_locales_and_restores_existing_custom_locale() {
        let root = fixture(true);
        let custom = root.join("locales/1103_zh-CN");
        fs::create_dir_all(&custom).unwrap();
        fs::write(custom.join("cards.cdb"), b"existing custom database").unwrap();
        install(&root).unwrap();
        for (_, locale) in LANGUAGES {
            let path = root.join("locales").join(format!("1103_{locale}"));
            assert_eq!(fs::read(path.join("cards.cdb")).unwrap(), asset(&root, &format!("{locale}/cards.cdb")).unwrap());
            assert!(fs::read_to_string(path.join("servers.conf")).unwrap().contains("706 Ladder|121.4.34.71:7911"));
            assert_eq!(fs::read(path.join("bot.conf")).unwrap(), b"bot config");
        }
        assert!(fs::read_to_string(root.join("system_user.conf")).unwrap().contains("locale = 1103_zh-CN"));
        restore(&root).unwrap();
        assert_eq!(fs::read(custom.join("cards.cdb")).unwrap(), b"existing custom database");
        assert!(!root.join("locales/1103_ja-JP/cards.cdb").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edited_managed_file_blocks_restore_and_preserves_backup() {
        let root = fixture(false);
        install(&root).unwrap();
        fs::write(root.join("cards.cdb"), b"player edit").unwrap();
        assert!(restore(&root).is_err());
        assert_eq!(fs::read(root.join("cards.cdb")).unwrap(), b"player edit");
        assert!(state_path(&root).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
