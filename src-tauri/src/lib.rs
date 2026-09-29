mod api;
mod downloads;
mod environment;
mod game;
#[cfg(windows)]
mod instance;
mod scripts;
mod settings;
#[cfg(windows)]
mod webview;

use api::ApiResponse;
use reqwest::blocking::Client;
use settings::Settings;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

struct AppState {
    root: PathBuf,
    client: Client,
    config_lock: Mutex<()>,
    file_lock: Mutex<()>,
    script_lock: Mutex<()>,
}

fn game_root() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        // The desktop executable is copied beside ygopro.exe in release builds.
        // During development, use this project root unless a test fixture is selected.
        if let Some(path) = std::env::var_os("SRVPRO_DESKTOP_GAME_ROOT") {
            return PathBuf::from(path);
        }
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("Cargo manifest has a parent")
            .to_path_buf();
    }
    #[cfg(not(debug_assertions))]
    {
        std::env::current_exe()
            .expect("Cannot locate desktop executable")
            .parent()
            .expect("Desktop executable has no parent")
            .to_path_buf()
    }
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    settings::load(&state.root)
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let _guard = state
        .config_lock
        .lock()
        .map_err(|_| "Settings lock is unavailable")?;
    settings::save(&state.root, &settings)
}

#[tauri::command]
fn reset_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let _guard = state
        .config_lock
        .lock()
        .map_err(|_| "Settings lock is unavailable")?;
    settings::reset(&state.root)
}

#[tauri::command]
fn set_language(state: State<'_, AppState>, language: String) -> Result<(), String> {
    let _guard = state
        .config_lock
        .lock()
        .map_err(|_| "Settings lock is unavailable")?;
    let mut settings = settings::load(&state.root)?;
    settings.ui.language = language;
    settings::save(&state.root, &settings).map(|_| ())
}

#[tauri::command]
fn api_request(
    state: State<'_, AppState>,
    route: String,
    method: String,
    body: String,
) -> Result<ApiResponse, String> {
    api::request(&state.root, &state.client, &method, &route, &body)
}

#[tauri::command]
fn launch_game(
    state: State<'_, AppState>,
    kind: String,
    room_name: Option<String>,
) -> Result<(), String> {
    let _guard = state
        .file_lock
        .lock()
        .map_err(|_| "Game action lock is unavailable")?;
    if scripts::has_pending(&state.root) {
        return Err("A script update needs recovery before starting the game".into());
    }
    let settings = settings::load(&state.root)?;
    game::launch(&state.root, &settings, &kind, room_name.as_deref())
}

#[tauri::command]
fn save_and_open(
    state: State<'_, AppState>,
    kind: String,
    filename: String,
    route: Option<String>,
    bytes_base64: Option<String>,
) -> Result<downloads::SaveOutcome, String> {
    let _guard = state
        .file_lock
        .lock()
        .map_err(|_| "Game action lock is unavailable")?;
    downloads::save_and_open(
        &state.root,
        &state.client,
        &kind,
        &filename,
        route.as_deref(),
        bytes_base64.as_deref(),
    )
}

#[tauri::command]
fn open_saved(state: State<'_, AppState>, kind: String, filename: String) -> Result<(), String> {
    let _guard = state
        .file_lock
        .lock()
        .map_err(|_| "Game action lock is unavailable")?;
    if scripts::has_pending(&state.root) {
        return Err("A script update needs recovery before starting the game".into());
    }
    game::launch_saved(&state.root, &kind, &filename)
}

#[tauri::command]
fn script_state(state: State<'_, AppState>) -> Result<scripts::StateView, String> {
    scripts::state(&state.root)
}

#[tauri::command]
fn update_scripts(
    state: State<'_, AppState>,
    app: AppHandle,
    overwrite_conflicts: bool,
) -> Result<scripts::UpdateResult, String> {
    let _guard = state
        .script_lock
        .lock()
        .map_err(|_| "Script updater is unavailable")?;
    scripts::update(
        &state.root,
        &state.client,
        &state.file_lock,
        &app,
        overwrite_conflicts,
    )
}

#[tauri::command]
fn restore_scripts(state: State<'_, AppState>) -> Result<scripts::UpdateResult, String> {
    let _guard = state
        .script_lock
        .lock()
        .map_err(|_| "Script updater is unavailable")?;
    scripts::restore(&state.root, &state.file_lock)
}

#[tauri::command]
fn environment_state(state: State<'_, AppState>) -> Result<environment::StateView, String> {
    environment::state(&state.root)
}

#[tauri::command]
fn install_environment(state: State<'_, AppState>) -> Result<environment::StateView, String> {
    let _guard = state.file_lock.lock().map_err(|_| "Game action lock is unavailable")?;
    environment::install(&state.root)
}

#[tauri::command]
fn restore_environment(state: State<'_, AppState>) -> Result<environment::StateView, String> {
    let _guard = state.file_lock.lock().map_err(|_| "Game action lock is unavailable")?;
    environment::restore(&state.root)
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid external link")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("External link is not allowed".into());
    }
    open::that(url).map_err(|error| format!("Could not open browser: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    if !webview::runtime_ready() {
        return;
    }
    let root = game_root();
    #[cfg(windows)]
    let (_instance_guard, window_title) = match instance::acquire(&root) {
        Ok(Some(value)) => value,
        Ok(None) => return,
        Err(error) => panic!("Cannot protect game directory against duplicate clients: {error}"),
    };
    let state = AppState {
        root,
        client: api::client().expect("Cannot create HTTP client"),
        config_lock: Mutex::new(()),
        file_lock: Mutex::new(()),
        script_lock: Mutex::new(()),
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .setup(move |app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.set_title(&window_title)?;
            }
            let state = app.state::<AppState>();
            settings::initialise(&state.root).map_err(std::io::Error::other)?;
            if let Err(error) = scripts::recover_pending(&state.root) {
                eprintln!("Script recovery requires attention: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            reset_settings,
            set_language,
            api_request,
            launch_game,
            save_and_open,
            open_saved,
            script_state,
            update_scripts,
            restore_scripts,
            environment_state,
            install_environment,
            restore_environment,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("Tauri application error");
}
