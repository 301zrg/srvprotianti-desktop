//! One fixed local origin and package selection per process; network work starts after readiness.
use crate::{
    pages_cache::{self, Selected, Store},
    pages_package::{self as package, TrustedKey},
};
use reqwest::blocking::Client;
use serde::Serialize;
use std::{io::Read, path::Path, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

const CSP:&str="default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost";
const RECOVER_MENU: &str = "recover-builtin-pages";

pub use crate::release_http::allowed_asset_redirect as allowed_redirect;
pub fn local_path(path: &str) -> Result<String, String> {
    if path == "/" {
        return Ok("index.html".into());
    }
    let relative = path.strip_prefix('/').ok_or("invalid_local_path")?;
    package::validate_path(relative)?;
    Ok(relative.into())
}
fn trusted_key() -> TrustedKey {
    serde_json::from_str(include_str!("../page-update-public-key.json"))
        .expect("Build contains an invalid page public key")
}
fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub status: String,
    pub current_version: String,
    pub pending_version: Option<String>,
    pub update_available: bool,
    pub error: Option<String>,
}
pub struct Pages {
    inner: Mutex<Session>,
    pub selected: Selected,
}
struct Session {
    store: Store,
    status: String,
    error: Option<String>,
    ready: bool,
    auto_checked: bool,
    checking: bool,
}
impl Pages {
    pub fn new(game_root: &Path) -> Self {
        let boundary = game_root
            .canonicalize()
            .unwrap_or_else(|_| game_root.to_path_buf());
        let root = crate::settings::data_dir(&boundary).join("page-packages");
        let (store, selected) = Store::open_owned(root, boundary, trusted_key(), now());
        let status = if store.recovered {
            "recovered"
        } else {
            "current"
        }
        .into();
        Self {
            inner: Mutex::new(Session {
                store,
                status,
                error: None,
                ready: false,
                auto_checked: false,
                checking: false,
            }),
            selected,
        }
    }
    pub fn status(&self) -> Result<View, String> {
        let state = self.inner.lock().map_err(|_| "page_state_unavailable")?;
        Ok(self.view(&state))
    }
    fn view(&self, state: &Session) -> View {
        let pending = state.store.pending_version();
        View {
            status: state.status.clone(),
            current_version: self.selected.version.clone(),
            update_available: pending.is_some(),
            pending_version: pending,
            error: state.error.clone(),
        }
    }
    pub fn ready(&self, app: &AppHandle) -> Result<(), String> {
        let mut state = self.inner.lock().map_err(|_| "page_state_unavailable")?;
        if !state.ready {
            state.store.ready(&self.selected)?;
            state.ready = true;
        }
        let start = !state.auto_checked;
        state.auto_checked = true;
        drop(state);
        if start {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = check(&app);
            });
        }
        Ok(())
    }
    pub fn recover(&self) -> Result<View, String> {
        let mut state = self.inner.lock().map_err(|_| "page_state_unavailable")?;
        state.store.recover_builtin()?;
        state.status = "recovered".into();
        state.error = None;
        Ok(self.view(&state))
    }
}
fn publish(app: &AppHandle, pages: &Pages) {
    if let Ok(view) = pages.status() {
        let _ = app.emit("srvpro-page-update", view);
    }
}
pub fn check(app: &AppHandle) -> Result<View, String> {
    let pages = app.state::<Pages>();
    {
        let mut state = pages.inner.lock().map_err(|_| "page_state_unavailable")?;
        if state.checking {
            return Ok(pages.view(&state));
        }
        state.checking = true;
        state.status = "checking".into();
        state.error = None;
    }
    publish(app, &pages);
    let result = (|| -> Result<(), (&str, String)> {
        let index_client = Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("srvprotianti-desktop-pages/0.2.0")
            .build()
            .map_err(|_| ("unavailable", "page_network_unavailable".into()))?;
        let envelope = fetch(&index_client, package::INDEX_URL, package::ENVELOPE_LIMIT)
            .map_err(|e| ("unavailable", e))?;
        let manifest = package::verify_envelope(&envelope, &trusted_key(), now(), true)
            .map_err(|e| ("rejected", e))?;
        {
            let state = pages
                .inner
                .lock()
                .map_err(|_| ("unavailable", "page_state_unavailable".into()))?;
            if !state
                .store
                .is_new(&manifest, &envelope)
                .map_err(|e| ("rejected", e))?
            {
                return Ok(());
            }
        }
        let archive_client = Client::builder()
            .timeout(Duration::from_secs(45))
            .connect_timeout(Duration::from_secs(8))
            .user_agent("srvprotianti-desktop-pages/0.2.0")
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() <= 5 && allowed_redirect(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|_| ("unavailable", "page_network_unavailable".into()))?;
        let archive = fetch(
            &archive_client,
            &manifest.archive.url,
            manifest.archive.size,
        )
        .map_err(|e| ("unavailable", e))?;
        pages
            .inner
            .lock()
            .map_err(|_| ("unavailable", "page_state_unavailable".into()))?
            .store
            .stage(&envelope, &archive, now())
            .map_err(|e| ("rejected", e))?;
        Ok(())
    })();
    let mut state = pages.inner.lock().map_err(|_| "page_state_unavailable")?;
    state.checking = false;
    match result {
        Ok(()) => {
            state.status = if state.store.pending_version().is_some() {
                "staged"
            } else {
                "current"
            }
            .into();
            state.error = None;
        }
        Err((status, error)) => {
            state.status = status.into();
            state.error = Some(error);
        }
    }
    let view = pages.view(&state);
    drop(state);
    let _ = app.emit("srvpro-page-update", &view);
    Ok(view)
}
fn fetch(client: &Client, url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header("Cache-Control", "no-cache")
        .send()
        .map_err(|_| "page_network_unavailable")?;
    if !response.status().is_success() {
        return Err("page_update_unavailable".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err("page_response_too_large".into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "page_network_unavailable")?;
    if bytes.len() as u64 > limit {
        return Err("page_response_too_large".into());
    }
    Ok(bytes)
}
fn mime(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        _ => "text/plain; charset=utf-8",
    }
}
pub fn serve(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{Method, Response};
    let failure = |status| {
        Response::builder()
            .status(status)
            .header("Content-Type", "text/plain")
            .body(Vec::new())
            .unwrap()
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return failure(405);
    }
    let path = match local_path(request.uri().path()) {
        Ok(path) => path,
        Err(_) => return failure(404),
    };
    let pages = app.state::<Pages>();
    let (bytes, content_type, csp) = if let Some(directory) = &pages.selected.directory {
        let Some(file) = pages
            .selected
            .manifest
            .as_ref()
            .and_then(|m| m.files.iter().find(|f| f.path == path))
        else {
            return failure(404);
        };
        // A cached file modified after startup is never silently replaced with another version's asset.
        let bytes = match pages_cache::read_limited(&directory.join(&path), package::FILE_LIMIT) {
            Ok(bytes) => bytes,
            Err(_) => return failure(500),
        };
        if bytes.len() as u64 != file.size || package::hash(&bytes) != file.sha256 {
            return failure(500);
        }
        (bytes, mime(&path).to_string(), Some(CSP.to_string()))
    } else {
        match app.asset_resolver().get(path) {
            Some(asset) => (asset.bytes, asset.mime_type, asset.csp_header),
            None => return failure(404),
        }
    };
    let mut builder = Response::builder()
        .header("Content-Type", content_type)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff");
    if let Some(csp) = csp {
        builder = builder.header("Content-Security-Policy", csp);
    }
    builder
        .body(if request.method() == Method::HEAD {
            Vec::new()
        } else {
            bytes
        })
        .unwrap()
}
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, Submenu};
    let language = crate::settings::load(&app.state::<crate::AppState>().root)?
        .ui
        .language;
    let (label, title) = match language.as_str() {
        "en" => ("Use built-in pages on next launch", "Page recovery"),
        "ja" => ("次回起動時に内蔵ページを使用", "ページの復旧"),
        "ko" => ("다음 실행 시 내장 페이지 사용", "페이지 복구"),
        _ => ("下次启动使用内置页面", "页面恢复"),
    };
    let item = MenuItem::with_id(app, RECOVER_MENU, label, true, Some("Ctrl+Shift+R"))?;
    let submenu = Submenu::with_items(app, title, true, &[&item])?;
    app.set_menu(Menu::with_items(app, &[&submenu])?)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == RECOVER_MENU {
            let saved = app.state::<Pages>().recover().is_ok();
            let language = crate::settings::load(&app.state::<crate::AppState>().root)
                .map(|s| s.ui.language)
                .unwrap_or_default();
            let message = match (language.as_str(), saved) {
                ("en", true) => "Built-in pages will be used on next launch.",
                ("en", false) => {
                    "Recovery state could not be saved. Built-in pages remain in the app."
                }
                ("ja", true) => "次回起動時に内蔵ページを使用します。",
                ("ja", false) => {
                    "復旧状態を保存できませんでした。内蔵ページはアプリ内に保持されています。"
                }
                ("ko", true) => "다음 실행 시 내장 페이지를 사용합니다.",
                ("ko", false) => {
                    "복구 상태를 저장할 수 없습니다. 내장 페이지는 앱에 보관되어 있습니다."
                }
                (_, true) => "下次启动将使用内置页面。",
                (_, false) => "页面恢复状态暂不可写；内置页面仍保留在程序中。",
            };
            native_message(message);
            publish(app, &app.state::<Pages>());
        }
    });
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(45));
        let pages = app.state::<Pages>();
        let failed = pages.inner.lock().ok().is_some_and(|mut state| {
            !state.ready && state.store.fail_boot(&pages.selected).unwrap_or(false)
        });
        if failed {
            app.restart();
        }
    });
    Ok(())
}
fn native_message(message: &str) {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(owner: isize, text: *const u16, title: *const u16, style: u32) -> i32;
        }
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "706 / Page recovery"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            MessageBoxW(0, text.as_ptr(), title.as_ptr(), 0x10040);
        }
    }
    #[cfg(not(windows))]
    eprintln!("{message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permits_only_https_github_asset_redirects_without_credentials_or_foreign_ports() {
        for good in ["https://release-assets.githubusercontent.com/github-production-release-asset/abc?token=x","https://objects.githubusercontent.com/github-production-release-asset/abc"] {
            assert!(allowed_redirect(&good.parse().unwrap()),"{good}");
        }
        for bad in [
            "http://release-assets.githubusercontent.com/a",
            "https://evil.test/a",
            "https://github.com.evil.test/a",
            "https://user@release-assets.githubusercontent.com/a",
            "https://release-assets.githubusercontent.com:444/a",
            "https://raw.githubusercontent.com/a",
            "https://github.com/foreign/repo",
        ] {
            assert!(!allowed_redirect(&bad.parse().unwrap()), "{bad}");
        }
    }
    #[test]
    fn resolves_root_and_absolute_assets_but_never_filesystem_or_encoded_traversal() {
        assert_eq!(local_path("/").unwrap(), "index.html");
        assert_eq!(local_path("/assets/page.js").unwrap(), "assets/page.js");
        for bad in [
            "/../config.json",
            "/%2e%2e/a.js",
            "/C:/a.js",
            "//a.js",
            "/x\\a.js",
        ] {
            assert!(local_path(bad).is_err(), "{bad}");
        }
    }
}
