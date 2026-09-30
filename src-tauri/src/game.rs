use crate::environment;
use crate::settings::{self, Settings};
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn executable(root: &Path, settings: &Settings) -> Result<PathBuf, String> {
    let candidate = root.join(&settings.game.executable);
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let resolved = candidate
        .canonicalize()
        .map_err(|_| "Game executable was not found beside the desktop program")?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err("Game executable is outside the game directory".into());
    }
    if resolved == std::env::current_exe().unwrap_or_default() {
        return Err("The desktop program cannot launch itself as the game".into());
    }
    Ok(resolved)
}

pub fn args(
    settings: &Settings,
    kind: &str,
    room_name: Option<&str>,
) -> Result<Vec<String>, String> {
    match kind {
        "deck-editor" => Ok(vec!["-d".into()]),
        "replay-list" => Ok(vec!["-r".into()]),
        "regular" | "ladder" | "join" | "watch" => {
            if settings.player.launch_name.trim().is_empty() {
                return Err("Set a game login name in Settings first".into());
            }
            let mut values = vec![
                "-n".into(),
                settings.player.launch_name.clone(),
                "-h".into(),
                settings.server.game_host.clone(),
                "-p".into(),
                settings.server.game_port.to_string(),
            ];
            if kind == "ladder" {
                values.extend(["-w".into(), "TT".into(), "-k".into(), "-j".into()]);
            } else if kind == "join" || kind == "watch" {
                let room = room_name.ok_or("Missing room name")?;
                if room.is_empty() || room.contains(['\0', '\n', '\r']) || room.len() > 160 {
                    return Err("Invalid room name".into());
                }
                values.extend(["-w".into(), room.into(), "-j".into()]);
            }
            Ok(values)
        }
        _ => Err("Unknown game action".into()),
    }
}

pub fn launch(
    root: &Path,
    settings: &Settings,
    kind: &str,
    room_name: Option<&str>,
) -> Result<(), String> {
    let arguments = args(settings, kind, room_name)?;
    spawn(root, settings, &arguments)
}

pub fn spawn(root: &Path, settings: &Settings, arguments: &[String]) -> Result<(), String> {
    let program = executable(root, settings)?;
    environment::prepare_launch(root, settings)?;
    Command::new(program)
        .current_dir(root)
        .args(arguments)
        .spawn()
        .map_err(|error| format!("Could not start the game: {error}"))?;
    Ok(())
}

pub fn launch_saved(root: &Path, kind: &str, filename: &str) -> Result<(), String> {
    let config = settings::load(root)?;
    if filename.contains(['/', '\\', '\0']) || filename.is_empty() {
        return Err("Invalid saved file name".into());
    }
    let argument = if kind == "deck" {
        filename
            .strip_suffix(".ydk")
            .ok_or("Deck name must end in .ydk")?
            .to_string()
    } else if kind == "replay" {
        if !filename.to_ascii_lowercase().ends_with(".yrp") {
            return Err("Replay name must end in .yrp".into());
        }
        filename.to_string()
    } else {
        return Err("Unknown saved file type".into());
    };
    let directory = root.join(if kind == "deck" { "deck" } else { "replay" });
    let candidate = directory.join(filename);
    let resolved = candidate
        .canonicalize()
        .map_err(|_| "Saved file is missing")?;
    let allowed = directory
        .canonicalize()
        .map_err(|_| "Saved directory is missing")?;
    if !resolved.starts_with(&allowed) || !resolved.is_file() {
        return Err("Saved file is outside its directory".into());
    }
    spawn(
        root,
        &config,
        &[
            if kind == "deck" {
                "-d".into()
            } else {
                "-r".into()
            },
            argument,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> Settings {
        serde_json::from_str(settings::DEFAULT_CONFIG).unwrap()
    }

    #[test]
    fn launch_argument_order_is_stable() {
        let mut config = settings();
        config.player.launch_name = "玩家$secret with space".into();
        let regular = args(&config, "regular", None).unwrap();
        assert_eq!(
            regular,
            vec![
                "-n",
                "玩家$secret with space",
                "-h",
                "121.4.34.71",
                "-p",
                "7911"
            ]
        );
        let ladder = args(&config, "ladder", None).unwrap();
        assert_eq!(&ladder[6..], &["-w", "TT", "-k", "-j"]);
        let watch = args(&config, "watch", Some("M#Room")).unwrap();
        assert_eq!(&watch[6..], &["-w", "M#Room", "-j"]);
        let join = args(&config, "join", Some("M#Room")).unwrap();
        assert_eq!(join, watch);
        let protected = args(&config, "watch", Some("M#Room$secret with space")).unwrap();
        assert_eq!(&protected[6..], &["-w", "M#Room$secret with space", "-j"]);
        config.player.launch_name.clear();
        assert_eq!(args(&config, "deck-editor", None).unwrap(), vec!["-d"]);
        assert_eq!(args(&config, "replay-list", None).unwrap(), vec!["-r"]);
        assert!(args(&config, "ladder", None).is_err());
    }
}
