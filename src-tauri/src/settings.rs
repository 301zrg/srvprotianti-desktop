use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const DEFAULT_CONFIG: &str = include_str!("../resources/config.default.json");
const DATA_DIRECTORY: &str = "srvprotianti-desktop-data";
const MAX_LOGIN_NAME_UTF16_UNITS: usize = 80;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub player: Player,
    pub server: Server,
    pub game: Game,
    pub ui: Ui,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    pub launch_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub game_host: String,
    pub game_port: u16,
    pub api_base_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Game {
    pub executable: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ui {
    pub language: String,
}

pub fn data_dir(root: &Path) -> PathBuf {
    root.join(DATA_DIRECTORY)
}

pub fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub fn initialise(root: &Path) -> Result<(), String> {
    let data = data_dir(root);
    fs::create_dir_all(&data)
        .map_err(|error| format!("Cannot create application data directory: {error}"))?;
    let metadata = fs::symlink_metadata(&data).map_err(|error| error.to_string())?;
    if is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err("Application data directory must not be a link".into());
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_data = data.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_data.starts_with(&canonical_root) || canonical_data == canonical_root {
        return Err("Application data directory escapes the game root".into());
    }
    let default_file = data.join("config.default.json");
    if !default_file.exists() {
        atomic_write(&default_file, DEFAULT_CONFIG.as_bytes())?;
    }
    Ok(())
}

pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".desktop-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temp).map_err(|error| error.to_string())?;
        use std::io::Write;
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::rename(&temp, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn merge(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                match base_map.get_mut(&key) {
                    Some(existing) => merge(existing, value),
                    None => {
                        base_map.insert(key, value);
                    }
                }
            }
        }
        (target, value) => *target = value,
    }
}

fn diff(value: &Value, default: &Value) -> Option<Value> {
    if value == default {
        return None;
    }
    if let (Value::Object(current), Value::Object(default_map)) = (value, default) {
        let mut result = serde_json::Map::new();
        for (key, child) in current {
            let difference = match default_map.get(key) {
                Some(default_child) => diff(child, default_child),
                None => Some(child.clone()),
            };
            if let Some(difference) = difference {
                result.insert(key.clone(), difference);
            }
        }
        return if result.is_empty() {
            None
        } else {
            Some(Value::Object(result))
        };
    }
    Some(value.clone())
}

fn defaults(root: &Path) -> Result<Value, String> {
    let file = data_dir(root).join("config.default.json");
    let text = fs::read_to_string(&file)
        .map_err(|error| format!("Cannot read default settings: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("Default settings are invalid: {error}"))
}

pub fn load(root: &Path) -> Result<Settings, String> {
    initialise(root)?;
    let mut value = defaults(root)?;
    let user_file = data_dir(root).join("config.user.json");
    if user_file.exists() {
        let contents = fs::read_to_string(&user_file)
            .map_err(|error| format!("Cannot read player settings: {error}"))?;
        let overlay: Value = serde_json::from_str(&contents).map_err(|error| {
            format!("Player settings are invalid; original file was kept: {error}")
        })?;
        merge(&mut value, overlay);
    }
    let settings: Settings = serde_json::from_value(value)
        .map_err(|error| format!("Settings have an invalid field: {error}"))?;
    validate(&settings)?;
    Ok(settings)
}

pub fn save(root: &Path, settings: &Settings) -> Result<Settings, String> {
    // A corrupt user file must remain available for repair; never overwrite it silently.
    let _ = load(root)?;
    validate(settings)?;
    let defaults = defaults(root)?;
    let current = serde_json::to_value(settings).map_err(|error| error.to_string())?;
    let overlay = diff(&current, &defaults).unwrap_or_else(|| Value::Object(Default::default()));
    let contents = serde_json::to_vec_pretty(&overlay).map_err(|error| error.to_string())?;
    atomic_write(&data_dir(root).join("config.user.json"), &contents)?;
    load(root)
}

pub fn reset(root: &Path) -> Result<Settings, String> {
    initialise(root)?;
    let user_file = data_dir(root).join("config.user.json");
    if user_file.exists() {
        let archive = data_dir(root).join(format!("config.user.reset-{}.json", Uuid::new_v4()));
        fs::rename(&user_file, archive).map_err(|error| error.to_string())?;
    }
    load(root)
}

pub fn validate(settings: &Settings) -> Result<(), String> {
    if settings.schema_version != 1 {
        return Err("Unsupported settings version".into());
    }
    if settings.player.launch_name.contains('\0')
        || settings.player.launch_name.contains('\n')
        || settings.player.launch_name.contains('\r')
        || settings.player.launch_name.encode_utf16().count() > MAX_LOGIN_NAME_UTF16_UNITS
    {
        return Err("Game login string contains unsupported characters or is too long".into());
    }
    let host = &settings.server.game_host;
    if host.is_empty()
        || host.len() > 253
        || host.starts_with('.')
        || host.ends_with('.')
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        || host.split('.').any(|label| {
            label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
        })
    {
        return Err("Game host must be an IPv4 address or hostname".into());
    }
    if settings.server.game_port == 0 {
        return Err("Game port must be 1–65535".into());
    }
    let url =
        reqwest::Url::parse(&settings.server.api_base_url).map_err(|_| "API address is invalid")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("API address must be an HTTP(S) base URL without credentials or query".into());
    }
    let executable = &settings.game.executable;
    let candidate = Path::new(executable);
    if candidate.file_name().and_then(|name| name.to_str()) != Some(executable)
        || !executable.to_ascii_lowercase().ends_with(".exe")
        || executable.len() > 180
        || executable.contains(['/', '\\', ':'])
    {
        return Err("Game executable must be an .exe filename in the same directory".into());
    }
    if !matches!(settings.ui.language.as_str(), "zh" | "ja" | "en" | "ko") {
        return Err("Unsupported language".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_string_allows_eighty_utf16_units() {
        let mut settings: Settings = serde_json::from_str(DEFAULT_CONFIG).unwrap();
        settings.player.launch_name = "a".repeat(80);
        assert!(validate(&settings).is_ok());
        settings.player.launch_name.push('a');
        assert!(validate(&settings).is_err());

        settings.player.launch_name = "😀".repeat(40);
        assert!(validate(&settings).is_ok());
        settings.player.launch_name.push('😀');
        assert!(validate(&settings).is_err());
    }

    #[test]
    fn explicit_empty_string_overrides_existing_value() {
        let mut base = serde_json::json!({"player":{"launchName":"Old"}});
        merge(&mut base, serde_json::json!({"player":{"launchName":""}}));
        assert_eq!(base["player"]["launchName"], "");
    }

    #[test]
    fn changed_fields_only_are_saved() {
        let base = serde_json::json!({"player":{"launchName":""},"server":{"gamePort":7911}});
        let current = serde_json::json!({"player":{"launchName":"A$B"},"server":{"gamePort":7911}});
        assert_eq!(
            diff(&current, &base),
            Some(serde_json::json!({"player":{"launchName":"A$B"}}))
        );
    }

    #[test]
    fn user_overrides_survive_reload_without_changing_defaults() {
        let root = std::env::temp_dir().join(format!("srvpro-desktop-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut config = load(&root).unwrap();
        assert_eq!(config.player.launch_name, "");
        config.player.launch_name = "玩家$secret".into();
        config.server.game_port = 7920;
        save(&root, &config).unwrap();
        config.server.game_port = 7921;
        save(&root, &config).unwrap();
        assert_eq!(load(&root).unwrap(), config);
        assert_eq!(
            fs::read_to_string(data_dir(&root).join("config.default.json")).unwrap(),
            DEFAULT_CONFIG
        );
        let overlay: Value =
            serde_json::from_slice(&fs::read(data_dir(&root).join("config.user.json")).unwrap())
                .unwrap();
        assert_eq!(overlay["player"]["launchName"], "玩家$secret");
        assert!(overlay["server"].get("gameHost").is_none());
        reset(&root).unwrap();
        assert_eq!(load(&root).unwrap().player.launch_name, "");
        assert!(root.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(root).unwrap();
    }
}
