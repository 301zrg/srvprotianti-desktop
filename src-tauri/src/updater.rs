use reqwest::blocking::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::io::Read;

const API_URL: &str = "https://api.github.com/repos/301zrg/srvprotianti-desktop/releases/latest";
const ASSET_NAME: &str = "srvprotianti-desktop-windows-x64.zip";
const DOWNLOAD_URL: &str = "https://github.com/301zrg/srvprotianti-desktop/releases/latest/download/srvprotianti-desktop-windows-x64.zip";
const RESPONSE_LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    size: u64,
    state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    current_version: String,
    latest_version: String,
    update_available: bool,
    download_url: Option<&'static str>,
}

fn parse_release(body: &[u8], current: &str) -> Result<UpdateView, String> {
    let release: Release = serde_json::from_slice(body)
        .map_err(|_| "GitHub returned an invalid release description")?;
    if release.draft || release.prerelease {
        return Err("GitHub did not return a stable release".into());
    }
    let latest = release
        .tag_name
        .strip_prefix('v')
        .ok_or("Latest release tag does not start with v")?;
    let latest = Version::parse(latest).map_err(|_| "Latest release tag is not a valid version")?;
    let current = Version::parse(current).map_err(|_| "Current app version is invalid")?;
    let has_asset = release
        .assets
        .iter()
        .any(|asset| asset.name == ASSET_NAME && asset.size > 0 && asset.state == "uploaded");
    Ok(UpdateView {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        update_available: latest > current,
        download_url: has_asset.then_some(DOWNLOAD_URL),
    })
}

fn fetch_latest(client: &Client, url: &str, current: &str) -> Result<UpdateView, String> {
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("Cache-Control", "no-cache")
        .send()
        .map_err(|error| format!("Could not reach GitHub Releases: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            403 | 429 => "GitHub temporarily limited update checks".into(),
            404 => "No published desktop release was found".into(),
            code => format!("GitHub Releases returned HTTP {code}"),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_LIMIT as u64)
    {
        return Err("GitHub release description is too large".into());
    }
    let mut bytes = Vec::new();
    response
        .take(RESPONSE_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read GitHub release: {error}"))?;
    if bytes.len() > RESPONSE_LIMIT {
        return Err("GitHub release description is too large".into());
    }
    parse_release(&bytes, current)
}

pub fn check(client: &Client) -> Result<UpdateView, String> {
    fetch_latest(client, API_URL, env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, asset: bool) -> Vec<u8> {
        let assets = if asset {
            format!("[{{\"name\":\"{ASSET_NAME}\",\"size\":6320474,\"state\":\"uploaded\"}}]")
        } else {
            "[]".into()
        };
        format!(
            "{{\"tag_name\":\"{tag}\",\"draft\":false,\"prerelease\":false,\"assets\":{assets}}}"
        )
        .into_bytes()
    }

    #[test]
    fn compares_stable_versions_and_requires_the_portable_asset() {
        let newer = parse_release(&release("v0.1.1", true), "0.1.0").unwrap();
        assert!(newer.update_available);
        assert_eq!(newer.download_url, Some(DOWNLOAD_URL));
        let same = parse_release(&release("v0.1.0", true), "0.1.0").unwrap();
        assert!(!same.update_available);
        let older = parse_release(&release("v0.1.0", true), "0.1.1").unwrap();
        assert!(!older.update_available);
        let missing = parse_release(&release("v0.1.2", false), "0.1.0").unwrap();
        assert!(missing.update_available);
        assert!(missing.download_url.is_none());
    }

    #[test]
    fn rejects_unexpected_release_metadata() {
        assert!(parse_release(&release("nightly", true), "0.1.0").is_err());
        assert!(parse_release(b"not json", "0.1.0").is_err());
        let draft = br#"{"tag_name":"v0.1.2","draft":true,"prerelease":false,"assets":[]}"#;
        assert!(parse_release(draft, "0.1.0").is_err());
    }

    #[test]
    fn reports_http_failure_without_treating_it_as_current() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::thread;
        use std::time::Duration;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0, "client closed before sending HTTP headers");
                request.extend_from_slice(&buffer[..count]);
                assert!(request.len() < 16 * 1024, "request headers were too large");
            }
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
            stream.flush().unwrap();
        });
        let client = Client::builder().no_proxy().build().unwrap();
        let error = fetch_latest(&client, &format!("http://{address}/"), "0.1.0")
            .err()
            .unwrap();
        server.join().unwrap();
        assert!(error.contains("503"), "unexpected error: {error}");
    }
}
