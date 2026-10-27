use reqwest::{blocking::Client, header::HeaderMap, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

const MANIFEST_URL: &str =
    "https://github.com/301zrg/srvprotianti-desktop/releases/latest/download/desktop-update.json";
const ASSET_NAME: &str = "srvprotianti-desktop-windows-x64.zip";
const RESPONSE_LIMIT: u64 = 64 * 1024;
const CACHE_SECONDS: u64 = 600;
const FAILURE_SECONDS: u64 = 30;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    version: String,
    tag: String,
    source_commit: String,
    asset: Asset,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    current_version: String,
    latest_version: Option<String>,
    update_available: bool,
    download_url: Option<String>,
    status: &'static str,
    checked_at: Option<u64>,
    retry_at: Option<u64>,
    error: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum CheckError {
    Unavailable(UpdateView),
    Internal(&'static str),
}

#[derive(Clone, Debug)]
struct Failure {
    code: &'static str,
    retry_at: Option<u64>,
}

fn now() -> u64 {
    time::OffsetDateTime::now_utc().unix_timestamp().max(0) as u64
}

fn failure(code: &'static str) -> Failure {
    Failure {
        code,
        retry_at: None,
    }
}

fn stable_version(value: &str) -> Option<Version> {
    let version = Version::parse(value).ok()?;
    (version.pre.is_empty() && version.build.is_empty() && version.to_string() == value)
        .then_some(version)
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn parse_release(body: &[u8], current: &str) -> Result<UpdateView, Failure> {
    let manifest: Manifest =
        serde_json::from_slice(body).map_err(|_| failure("invalid_manifest"))?;
    let latest = stable_version(&manifest.version).ok_or_else(|| failure("invalid_manifest"))?;
    let current_version = Version::parse(current).map_err(|_| failure("invalid_manifest"))?;
    if manifest.schema_version != 1
        || manifest.tag != format!("v{latest}")
        || !hex(&manifest.source_commit, 40)
        || manifest.asset.name != ASSET_NAME
        || manifest.asset.size == 0
        || manifest.asset.size > 9_007_199_254_740_991
        || !hex(&manifest.asset.sha256, 64)
    {
        return Err(failure("invalid_manifest"));
    }
    Ok(UpdateView {
        current_version: current.into(), latest_version: Some(latest.to_string()),
        update_available: latest > current_version,
        download_url: Some(format!("https://github.com/301zrg/srvprotianti-desktop/releases/download/v{latest}/{ASSET_NAME}")),
        status: "fresh", checked_at: None, retry_at: None, error: None,
    })
}

fn allowed_redirect(url: &Url) -> bool {
    if crate::release_http::allowed_asset_redirect(url) {
        return true;
    }
    let Some(path) = url
        .path()
        .strip_prefix("/301zrg/srvprotianti-desktop/releases/download/")
    else {
        return false;
    };
    let Some((tag, asset)) = path.split_once('/') else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && tag.strip_prefix('v').and_then(stable_version).is_some()
        && asset == "desktop-update.json"
}

fn client() -> Result<Client, Failure> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .user_agent(concat!("srvprotianti-desktop/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() <= 5 && allowed_redirect(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| failure("network"))
}

fn retry_at(headers: &HeaderMap, now: u64) -> Option<u64> {
    let after = headers
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.parse::<u64>()
                .ok()
                .map(|seconds| now.saturating_add(seconds))
                .or_else(|| {
                    time::OffsetDateTime::parse(
                        &v.replace(" GMT", " +0000"),
                        &time::format_description::well_known::Rfc2822,
                    )
                    .ok()
                    .and_then(|date| u64::try_from(date.unix_timestamp()).ok())
                })
        });
    let reset = headers
        .get("x-ratelimit-reset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());
    after.or(reset).map(|value| {
        value.clamp(
            now.saturating_add(FAILURE_SECONDS),
            now.saturating_add(86_400),
        )
    })
}

fn fetch_latest(
    client: &Client,
    url: &str,
    current: &str,
    clock: impl Fn() -> u64,
) -> Result<UpdateView, Failure> {
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .map_err(|_| failure("network"))?;
    if !response.status().is_success() {
        let code = match response.status().as_u16() {
            429 => "rate_limited",
            403 if response
                .headers()
                .get("x-ratelimit-remaining")
                .is_some_and(|v| v == "0") =>
            {
                "rate_limited"
            }
            403 => "access_denied",
            404 => "missing_manifest",
            _ => "server",
        };
        return Err(Failure {
            code,
            retry_at: retry_at(response.headers(), clock()),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_LIMIT)
    {
        return Err(failure("invalid_manifest"));
    }
    let mut bytes = Vec::new();
    response
        .take(RESPONSE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("network"))?;
    if bytes.len() as u64 > RESPONSE_LIMIT {
        return Err(failure("invalid_manifest"));
    }
    parse_release(&bytes, current)
}

#[derive(Default)]
struct Cache {
    good: Option<UpdateView>,
    last_failure: Option<Failure>,
    retry_at: u64,
}

#[derive(Default)]
pub struct Updater {
    cache: Mutex<Cache>,
}

impl Updater {
    pub fn check(&self) -> Result<UpdateView, CheckError> {
        self.check_with(now, || {
            fetch_latest(&client()?, MANIFEST_URL, env!("CARGO_PKG_VERSION"), now)
        })
    }

    fn check_with(
        &self,
        clock: impl Fn() -> u64,
        fetch: impl FnOnce() -> Result<UpdateView, Failure>,
    ) -> Result<UpdateView, CheckError> {
        // One request in flight across callers; cache never writes into the game directory.
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| CheckError::Internal("update_state_unavailable"))?;
        let now = clock();
        if cache.last_failure.is_none() {
            if let Some(good) = &cache.good {
                if good
                    .checked_at
                    .is_some_and(|at| now.saturating_sub(at) < CACHE_SECONDS)
                {
                    let mut view = good.clone();
                    view.status = "cached";
                    return Ok(view);
                }
            }
        }
        if cache.last_failure.is_none() || now >= cache.retry_at {
            match fetch() {
                Ok(mut good) => {
                    good.checked_at = Some(clock());
                    cache.good = Some(good.clone());
                    cache.last_failure = None;
                    cache.retry_at = 0;
                    return Ok(good);
                }
                Err(error) => {
                    cache.retry_at = error
                        .retry_at
                        .unwrap_or_else(|| clock().saturating_add(FAILURE_SECONDS));
                    cache.last_failure = Some(error);
                }
            }
        }
        let mut view = cache.good.clone().unwrap_or_else(|| UpdateView {
            current_version: env!("CARGO_PKG_VERSION").into(),
            latest_version: None,
            update_available: false,
            download_url: None,
            status: "unavailable",
            checked_at: None,
            retry_at: None,
            error: None,
        });
        view.status = if cache.good.is_some() {
            "stale"
        } else {
            "unavailable"
        };
        view.error = cache.last_failure.as_ref().map(|error| error.code);
        view.retry_at = Some(cache.retry_at);
        // Older cached pages only inspect success fields. Reject failures so they cannot
        // turn an unavailable check into a false "current version" message.
        Err(CheckError::Unavailable(view))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn failure_view(result: Result<UpdateView, CheckError>) -> UpdateView {
        match result {
            Err(CheckError::Unavailable(view)) => {
                let encoded = serde_json::to_value(CheckError::Unavailable(view.clone())).unwrap();
                assert_eq!(encoded["status"], view.status);
                view
            }
            other => panic!("expected a structured rejection, got {other:?}"),
        }
    }

    fn manifest(version: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({"schemaVersion":1,"version":version,"tag":format!("v{version}"),"sourceCommit":"a".repeat(40),"asset":{"name":ASSET_NAME,"size":1234,"sha256":"b".repeat(64)}})).unwrap()
    }

    #[test]
    fn accepts_static_manifest_without_rest_api_release_fields() {
        let view = parse_release(&manifest("0.2.1"), "0.2.0")
            .expect("static application manifest must be accepted");
        assert!(view.update_available);
        assert_eq!(view.download_url.as_deref(), Some("https://github.com/301zrg/srvprotianti-desktop/releases/download/v0.2.1/srvprotianti-desktop-windows-x64.zip"));
        assert!(
            !parse_release(&manifest("0.2.1"), "0.2.1")
                .unwrap()
                .update_available
        );
        assert!(
            !parse_release(&manifest("0.2.1"), "0.2.2")
                .unwrap()
                .update_available
        );
    }

    #[test]
    fn rejects_invalid_or_untrusted_metadata() {
        let valid: serde_json::Value = serde_json::from_slice(&manifest("0.2.1")).unwrap();
        for (pointer, value) in [
            ("/schemaVersion", json!(2)),
            ("/tag", json!("v0.2.2")),
            ("/version", json!("0.2.1-beta")),
            ("/version", json!("0.2.1+build")),
            ("/version", json!("01.2.1")),
            ("/sourceCommit", json!("A".repeat(40))),
            ("/asset/name", json!("other.zip")),
            ("/asset/size", json!(0)),
            ("/asset/size", json!(9_007_199_254_740_992u64)),
            ("/asset/sha256", json!("invalid")),
        ] {
            let mut bad = valid.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            assert!(
                parse_release(&serde_json::to_vec(&bad).unwrap(), "0.2.0").is_err(),
                "{pointer}"
            );
        }
        let mut bad = valid;
        bad["downloadUrl"] = json!("https://evil.example/game.exe");
        assert!(parse_release(&serde_json::to_vec(&bad).unwrap(), "0.2.0").is_err());
        assert!(parse_release(b"not json", "0.2.0").is_err());
    }

    #[test]
    fn caches_success_cools_failures_and_recovers_at_boundaries() {
        let updater = Updater::default();
        assert_eq!(
            updater
                .check_with(|| 1000, || parse_release(&manifest("0.2.1"), "0.2.0"))
                .unwrap()
                .status,
            "fresh"
        );
        let cached = updater
            .check_with(|| 1599, || panic!("unnecessary request"))
            .unwrap();
        assert_eq!(cached.status, "cached");
        assert_eq!(cached.checked_at, Some(1000));
        let stale = failure_view(updater.check_with(|| 1600, || Err(failure("network"))));
        assert_eq!(stale.status, "stale");
        assert_eq!(stale.checked_at, Some(1000));
        assert_eq!(stale.latest_version.as_deref(), Some("0.2.1"));
        assert_eq!(stale.retry_at, Some(1630));
        assert_eq!(
            failure_view(updater.check_with(|| 1629, || panic!("cooldown request"))).status,
            "stale"
        );
        let recovered = updater
            .check_with(|| 1630, || parse_release(&manifest("0.2.2"), "0.2.0"))
            .unwrap();
        assert_eq!(recovered.status, "fresh");
        assert_eq!(recovered.checked_at, Some(1630));
        assert!(recovered.error.is_none());
    }

    #[test]
    fn failure_is_rejected_so_cached_older_pages_cannot_claim_current() {
        let updater = Updater::default();
        assert!(updater
            .check_with(|| 1000, || Err(failure("network")))
            .is_err());
    }

    #[test]
    fn first_failure_is_unavailable_and_obeys_retry_after() {
        let updater = Updater::default();
        let view = failure_view(updater.check_with(
            || 1000,
            || {
                Err(Failure {
                    code: "rate_limited",
                    retry_at: Some(1120),
                })
            },
        ));
        assert_eq!(view.status, "unavailable");
        assert!(view.latest_version.is_none());
        assert!(view.checked_at.is_none());
        assert_eq!(
            failure_view(updater.check_with(|| 1119, || panic!("must respect retry"))).retry_at,
            Some(1120)
        );
        assert!(updater
            .check_with(|| 1120, || parse_release(&manifest("0.2.1"), "0.2.0"))
            .unwrap()
            .error
            .is_none());
    }

    #[test]
    fn failure_cooldown_starts_after_the_request_finishes() {
        let clock = std::cell::Cell::new(1000);
        let updater = Updater::default();
        let view = failure_view(updater.check_with(
            || clock.get(),
            || {
                clock.set(1015);
                Err(failure("network"))
            },
        ));
        assert_eq!(view.retry_at, Some(1045));
        assert_eq!(
            failure_view(updater.check_with(|| 1044, || panic!("early retry"))).status,
            "unavailable"
        );
        let good = updater.check_with(
            || clock.get(),
            || {
                clock.set(1050);
                parse_release(&manifest("0.2.1"), "0.2.0")
            },
        );
        assert_eq!(failure_view(good).status, "unavailable");
        clock.set(1045);
        let good = updater
            .check_with(
                || clock.get(),
                || {
                    clock.set(1060);
                    parse_release(&manifest("0.2.1"), "0.2.0")
                },
            )
            .unwrap();
        assert_eq!(good.checked_at, Some(1060));
    }

    #[test]
    fn concurrent_checks_share_one_fetch() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Barrier,
        };
        let updater = Arc::new(Updater::default());
        let barrier = Arc::new(Barrier::new(4));
        let calls = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let (updater, barrier, calls) = (updater.clone(), barrier.clone(), calls.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    updater
                        .check_with(
                            || 1000,
                            || {
                                calls.fetch_add(1, Ordering::SeqCst);
                                parse_release(&manifest("0.2.1"), "0.2.0")
                            },
                        )
                        .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn restricts_every_redirect_to_trusted_release_locations() {
        for url in ["https://github.com/301zrg/srvprotianti-desktop/releases/download/v0.2.1/desktop-update.json", "https://release-assets.githubusercontent.com/asset?signature=x"] { assert!(allowed_redirect(&url.parse().unwrap())); }
        for url in ["http://github.com/301zrg/srvprotianti-desktop/releases/download/v0.2.1/desktop-update.json", "https://github.com/evil/repo/releases/download/v0.2.1/desktop-update.json", "https://github.com/301zrg/srvprotianti-desktop/releases/download/v0.2.1/other.json", "https://release-assets.githubusercontent.com.evil.example/a", "https://user@objects.githubusercontent.com/a", "https://objects.githubusercontent.com:444/a"] { assert!(!allowed_redirect(&url.parse().unwrap()),"{url}"); }
    }

    #[test]
    fn parses_and_bounds_retry_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", "120".parse().unwrap());
        assert_eq!(retry_at(&headers, 1000), Some(1120));
        headers.insert("retry-after", "0".parse().unwrap());
        assert_eq!(retry_at(&headers, 1000), Some(1030));
        headers.insert("retry-after", "999999999".parse().unwrap());
        assert_eq!(retry_at(&headers, 1000), Some(87400));
        headers.insert(
            "retry-after",
            "Sun, 25 Oct 2026 18:49:34 GMT".parse().unwrap(),
        );
        assert_eq!(retry_at(&headers, 1792954000), Some(1792954174));
        headers.remove("retry-after");
        headers.insert("x-ratelimit-reset", "1100".parse().unwrap());
        assert_eq!(retry_at(&headers, 1000), Some(1100));
    }

    fn response(status: &str, headers: &str, body: &[u8]) -> Result<UpdateView, Failure> {
        response_with_clock(status, headers, body, || 1000)
    }

    fn response_with_clock(
        status: &str,
        headers: &str,
        body: &[u8],
        clock: impl Fn() -> u64,
    ) -> Result<UpdateView, Failure> {
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response = [
            format!(
                "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes(),
            body.to_vec(),
        ]
        .concat();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|p| p == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0);
                request.extend_from_slice(&buffer[..count]);
                assert!(request.len() < 16384);
            }
            let _ = stream.write_all(&response);
        });
        let result = fetch_latest(
            &Client::builder().no_proxy().build().unwrap(),
            &format!("http://{address}/"),
            "0.2.0",
            clock,
        );
        server.join().unwrap();
        result
    }

    #[test]
    fn http_failures_and_oversized_bodies_never_become_current() {
        assert_eq!(
            response("200 OK", "", &manifest("0.2.1"))
                .unwrap()
                .latest_version
                .as_deref(),
            Some("0.2.1")
        );
        assert_eq!(
            response("403 Forbidden", "", b"private-error")
                .unwrap_err()
                .code,
            "access_denied"
        );
        assert_eq!(
            response("403 Forbidden", "x-ratelimit-remaining: 0\r\n", b"")
                .unwrap_err()
                .code,
            "rate_limited"
        );
        let rate = response("429 Too Many Requests", "Retry-After: 120\r\n", b"").unwrap_err();
        assert_eq!(rate.retry_at, Some(1120));
        let delayed =
            response_with_clock("429 Too Many Requests", "Retry-After: 30\r\n", b"", || 1015)
                .unwrap_err();
        assert_eq!(delayed.retry_at, Some(1045));
        assert_eq!(
            response("404 Not Found", "", b"").unwrap_err().code,
            "missing_manifest"
        );
        assert_eq!(
            response("503 Unavailable", "", b"").unwrap_err().code,
            "server"
        );
        assert_eq!(
            response("200 OK", "", &vec![b' '; RESPONSE_LIMIT as usize + 1])
                .unwrap_err()
                .code,
            "invalid_manifest"
        );
    }
}
