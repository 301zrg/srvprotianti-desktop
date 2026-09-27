use crate::settings::{self, Settings};
use base64::Engine;
use reqwest::blocking::Client;
use reqwest::header::{HeaderValue, CONTENT_TYPE};
use serde::Serialize;
use std::io::Read;
use std::path::Path;
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub content_type: String,
    pub body_base64: String,
}

pub struct Fetched {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("srvprotianti-desktop/0.1")
        .build()
        .map_err(|error| error.to_string())
}

fn permitted(method: &str, route: &str) -> bool {
    if route.len() > 2048
        || route.contains('#')
        || route.contains('\\')
        || route.contains("..")
        || route.contains("//")
    {
        return false;
    }
    let lower = route.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") || lower.contains("%00") {
        return false;
    }
    let pathname = route.split('?').next().unwrap_or("");
    if pathname.starts_with("/api/public/replay/") {
        let name = &pathname["/api/public/replay/".len()..];
        return method == "GET"
            && !name.is_empty()
            && !name.contains('/')
            && name.to_ascii_lowercase().ends_with(".yrp");
    }
    if pathname.starts_with("/example_decks/") {
        let name = &pathname["/example_decks/".len()..];
        return method == "GET"
            && !name.is_empty()
            && !name.contains('/')
            && name.to_ascii_lowercase().ends_with(".ydk");
    }
    match (method, pathname) {
        ("POST", "/api/ladder/player" | "/api/ladder/player/deck") => true,
        (
            "GET",
            "/api/public/rooms"
            | "/api/public/replays"
            | "/api/ladder"
            | "/api/ladder-config"
            | "/api/ladder-deck-stats"
            | "/api/ladder/usage/cards"
            | "/api/ladder/usage/decks"
            | "/api/ladder/deck-search"
            | "/api/ladder/deck-detail"
            | "/api/ladder/deck-template"
            | "/api/example-decks",
        ) => true,
        _ => false,
    }
}

pub fn fetch(
    client: &Client,
    config: &Settings,
    method: &str,
    route: &str,
    body: &str,
    limit: usize,
) -> Result<Fetched, String> {
    if !permitted(method, route) {
        return Err("Unsupported API operation".into());
    }
    if body.len() > 4096 {
        return Err("API request body is too large".into());
    }
    let base = config.server.api_base_url.trim_end_matches('/');
    let url = reqwest::Url::parse(&format!("{base}{route}")).map_err(|_| "Invalid API URL")?;
    let mut request = match method {
        "GET" => client.get(url),
        "POST" => client
            .post(url)
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .body(body.to_string()),
        _ => return Err("Unsupported HTTP method".into()),
    };
    request = request.header("Accept", "*/*");
    let response = request
        .send()
        .map_err(|error| format!("API request failed: {error}"))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("API response exceeds size limit".into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("API response exceeds size limit".into());
    }
    Ok(Fetched {
        status,
        content_type,
        body: bytes,
    })
}

pub fn request(
    root: &Path,
    client: &Client,
    method: &str,
    route: &str,
    body: &str,
) -> Result<ApiResponse, String> {
    let config = settings::load(root)?;
    let result = fetch(client, &config, method, route, body, 16 * 1024 * 1024)?;
    Ok(ApiResponse {
        status: result.status,
        content_type: result.content_type,
        body_base64: base64::engine::general_purpose::STANDARD.encode(result.body),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unapproved_and_traversal_routes() {
        assert!(permitted("GET", "/api/public/rooms?t=1"));
        assert!(permitted("POST", "/api/ladder/player/deck"));
        assert!(!permitted("GET", "/api/getrooms"));
        assert!(!permitted("GET", "/api/public/replay/..%2fsecret.yrp"));
        assert!(!permitted("POST", "/api/public/replay/x.yrp"));
    }
}
