use crate::{api, game, scripts, settings};
use base64::Engine;
use reqwest::blocking::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub filename: String,
    pub saved_path: String,
    pub launch_error: Option<String>,
}

fn safe_stem(name: &str, extension: &str) -> Result<String, String> {
    if !name.to_ascii_lowercase().ends_with(extension) {
        return Err("Unexpected download extension".into());
    }
    let stem = &name[..name.len() - extension.len()];
    let mut safe: String = stem
        .chars()
        .take(100)
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    safe = safe.trim_matches([' ', '.']).to_string();
    let upper = safe.to_ascii_uppercase();
    if safe.is_empty() {
        safe = "download".into();
    }
    if matches!(
        upper.as_str(),
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
    ) {
        safe.insert(0, '_');
    }
    Ok(safe)
}

fn check_deck(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > 1024 * 1024 {
        return Err("Deck file has an invalid size".into());
    }
    let content = std::str::from_utf8(bytes).map_err(|_| "Deck file is not UTF-8")?;
    if content.contains('\0') {
        return Err("Deck content is not a YDK file".into());
    }
    let mut section = 0u8;
    let mut card_count = 0usize;
    for raw in content.trim_start_matches('\u{feff}').lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        match line {
            "#main" if section == 0 => {
                section = 1;
                continue;
            }
            "#extra" if section == 1 => {
                section = 2;
                continue;
            }
            "!side" if section == 2 => {
                section = 3;
                continue;
            }
            _ if line.starts_with('#') && line != "#main" && line != "#extra" => continue,
            _ => {}
        }
        if section == 0
            || line.starts_with('#')
            || line.starts_with('!')
            || line.parse::<u32>().ok().filter(|id| *id > 0).is_none()
        {
            return Err("Deck content is not a YDK file".into());
        }
        card_count += 1;
    }
    if section != 3 || card_count == 0 {
        return Err("Deck content is not a YDK file".into());
    }
    Ok(())
}

fn check_replay(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() < 16
        || bytes.len() > 64 * 1024 * 1024
        || !(bytes.starts_with(b"yrp1") || bytes.starts_with(b"yrp2"))
    {
        return Err("Replay content is not a supported YRP file".into());
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn choose_name(
    directory: &Path,
    stem: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<String, String> {
    for index in 1..1000 {
        let filename = if index == 1 {
            format!("{stem}{extension}")
        } else {
            format!("{stem} ({index}){extension}")
        };
        let candidate = directory.join(&filename);
        if !candidate.exists() {
            return Ok(filename);
        }
        let metadata = fs::symlink_metadata(&candidate).map_err(|error| error.to_string())?;
        if settings::is_link_or_reparse(&metadata) || !metadata.is_file() {
            continue;
        }
        if metadata.len() as usize == bytes.len() {
            let current = fs::read(&candidate).map_err(|error| error.to_string())?;
            if digest(&current) == digest(bytes) {
                return Ok(filename);
            }
        }
    }
    Err("Too many files with the same name".into())
}

fn allowed_directory(root: &Path, kind: &str) -> Result<PathBuf, String> {
    let directory = root.join(if kind == "deck" { "deck" } else { "replay" });
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let metadata = fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
    if settings::is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err("Download directory must not be a link".into());
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_directory = directory
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical_directory.starts_with(&canonical_root) || canonical_directory == canonical_root {
        return Err("Download directory is outside the game root".into());
    }
    Ok(canonical_directory)
}

pub fn save_and_open(
    root: &Path,
    client: &Client,
    kind: &str,
    filename: &str,
    route: Option<&str>,
    bytes_base64: Option<&str>,
) -> Result<SaveOutcome, String> {
    let extension = match kind {
        "deck" => ".ydk",
        "replay" => ".yrp",
        _ => return Err("Unknown download type".into()),
    };
    let stem = safe_stem(filename, extension)?;
    let config = settings::load(root)?;
    let bytes = match (route, bytes_base64) {
        (Some(route), None) => {
            let permitted = if kind == "deck" {
                route.starts_with("/example_decks/")
                    || route.starts_with("/api/ladder/deck-template?")
            } else {
                route.starts_with("/api/public/replay/")
            };
            if !permitted {
                return Err("This download source is not allowed".into());
            }
            let response = api::fetch(
                client,
                &config,
                "GET",
                route,
                "",
                if kind == "deck" {
                    1024 * 1024
                } else {
                    64 * 1024 * 1024
                },
            )?;
            if response.status != 200 {
                return Err(format!("Download returned HTTP {}", response.status));
            }
            if response.content_type.contains("html") || response.content_type.contains("json") {
                return Err("Server returned an error page instead of a file".into());
            }
            response.body
        }
        (None, Some(data)) => {
            if kind != "deck" {
                return Err("Replay must come from the replay endpoint".into());
            }
            if data.len() > 2 * 1024 * 1024 {
                return Err("Encoded deck is too large".into());
            }
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|_| "Encoded deck is invalid")?
        }
        _ => return Err("Exactly one download source is required".into()),
    };
    if kind == "deck" {
        check_deck(&bytes)?;
    } else {
        check_replay(&bytes)?;
    }
    let directory = allowed_directory(root, kind)?;
    let saved_name = choose_name(&directory, &stem, extension, &bytes)?;
    let target = directory.join(&saved_name);
    if !target.exists() {
        settings::atomic_write(&target, &bytes)?;
    }
    let launch_error = if scripts::has_pending(root) {
        Some("A script update needs recovery before starting the game".into())
    } else {
        game::launch_saved(root, kind, &saved_name).err()
    };
    Ok(SaveOutcome {
        filename: saved_name,
        saved_path: target.display().to_string(),
        launch_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_names_are_safe_without_losing_extension() {
        assert_eq!(safe_stem("CON.ydk", ".ydk").unwrap(), "_CON");
        assert_eq!(safe_stem("../怪:物?.ydk", ".ydk").unwrap(), "_怪_物_");
        assert!(safe_stem("wrong.txt", ".ydk").is_err());
    }

    #[test]
    fn rejects_error_pages_and_invalid_replays() {
        assert!(check_deck(b"<html>error</html>").is_err());
        assert!(check_deck(b"#main\n123\n#extra\n!side\n").is_ok());
        assert!(check_deck(b"#main\nnot-a-card\n#extra\n!side\n").is_err());
        assert!(check_replay(b"YRP").is_err());
        assert!(check_replay(b"yrp2\0\0\0\0\0\0\0\0\0\0\0\0").is_ok());
    }
}
