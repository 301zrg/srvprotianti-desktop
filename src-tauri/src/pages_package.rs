//! Signed page artifacts: no network, application state, or game-directory access.
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub application: String,
    pub channel: String,
    pub version: String,
    pub sequence: u64,
    pub bridge_version: u32,
    pub min_app_version: String,
    pub created_at: String,
    pub expires_at: String,
    pub archive: Archive,
    pub files: Vec<File>,
    pub source_commits: SourceCommits,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archive {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub unpacked_size: u64,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Deserialize, Serialize, Debug)]
#[serde(deny_unknown_fields)]
pub struct SourceCommits {
    pub desktop: String,
    pub website: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedKey {
    pub key_id: String,
    pub public_key: String,
}

pub const ENVELOPE_LIMIT: u64 = 1024 * 1024;
pub const ARCHIVE_LIMIT: u64 = 20 * 1024 * 1024;
pub const UNPACKED_LIMIT: u64 = 50 * 1024 * 1024;
pub const FILE_LIMIT: u64 = 5 * 1024 * 1024;
pub const INDEX_URL: &str =
    "https://raw.githubusercontent.com/301zrg/srvprotianti-desktop/page-updates/stable.json";
const DOMAIN: &[u8] = b"srvprotianti-desktop-pages-v1\0";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    schema_version: u32,
    key_id: String,
    payload: String,
    signature: String,
}

pub fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn verify_envelope(
    bytes: &[u8],
    key: &TrustedKey,
    now: i64,
    network: bool,
) -> Result<Manifest, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::signature::{UnparsedPublicKey, ED25519};
    if bytes.len() as u64 > ENVELOPE_LIMIT {
        return Err("manifest_too_large".into());
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "invalid_envelope")?;
    if envelope.schema_version != 1 || envelope.key_id != key.key_id {
        return Err("untrusted_key".into());
    }
    let raw = STANDARD
        .decode(&envelope.payload)
        .map_err(|_| "invalid_payload")?;
    let public = STANDARD
        .decode(&key.public_key)
        .map_err(|_| "invalid_trusted_key")?;
    let signature = STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "invalid_signature")?;
    if public.len() != 32 || signature.len() != 64 {
        return Err("invalid_signature".into());
    }
    UnparsedPublicKey::new(&ED25519, public)
        .verify(&[DOMAIN, &raw].concat(), &signature)
        .map_err(|_| "invalid_signature")?;
    // Deserialize only after authenticating the exact raw bytes; JSON reserialization is not a signature format.
    let manifest: Manifest = serde_json::from_slice(&raw).map_err(|_| "invalid_manifest")?;
    validate_manifest(&manifest, now, network)?;
    Ok(manifest)
}
fn validate_manifest(m: &Manifest, now: i64, network: bool) -> Result<(), String> {
    use semver::Version;
    use time::{format_description::well_known::Rfc3339, OffsetDateTime};
    if m.application != "org.srvprotianti.desktop" || m.channel != "stable" || m.bridge_version != 1
    {
        return Err("incompatible_pages".into());
    }
    let version = Version::parse(&m.version).map_err(|_| "invalid_version")?;
    let minimum = Version::parse(&m.min_app_version).map_err(|_| "invalid_app_version")?;
    let app = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|_| "invalid_app_version")?;
    if !version.pre.is_empty()
        || !version.build.is_empty()
        || minimum > app
        || m.sequence == 0
        || m.sequence > 9_007_199_254_740_991
    {
        return Err("incompatible_pages".into());
    }
    let created = OffsetDateTime::parse(&m.created_at, &Rfc3339)
        .map_err(|_| "invalid_dates")?
        .unix_timestamp();
    let expires = OffsetDateTime::parse(&m.expires_at, &Rfc3339)
        .map_err(|_| "invalid_dates")?
        .unix_timestamp();
    if !m.created_at.ends_with('Z')
        || !m.expires_at.ends_with('Z')
        || expires <= created
        || (network && (created > now + 300 || expires <= now))
    {
        return Err("expired_manifest".into());
    }
    let url = format!("https://github.com/301zrg/srvprotianti-desktop/releases/download/pages-v{}/srvprotianti-desktop-pages.zip",m.version);
    if m.archive.url != url
        || m.archive.size == 0
        || m.archive.size > ARCHIVE_LIMIT
        || m.archive.unpacked_size == 0
        || m.archive.unpacked_size > UNPACKED_LIMIT
        || !hex(&m.archive.sha256, 64)
        || !hex(&m.source_commits.desktop, 40)
        || !hex(&m.source_commits.website, 40)
    {
        return Err("invalid_archive_metadata".into());
    }
    if m.files.is_empty() || m.files.len() > 4096 {
        return Err("invalid_file_count".into());
    }
    let mut names = std::collections::HashSet::new();
    let mut total = 0u64;
    for file in &m.files {
        validate_path(&file.path)?;
        if !names.insert(file.path.to_ascii_lowercase()) {
            return Err("duplicate_path".into());
        }
        if file.size > FILE_LIMIT || !hex(&file.sha256, 64) {
            return Err("invalid_file_metadata".into());
        }
        total = total.checked_add(file.size).ok_or("files_too_large")?;
    }
    if total != m.archive.unpacked_size || !m.files.iter().any(|f| f.path == "index.html") {
        return Err("incomplete_manifest".into());
    }
    Ok(())
}
pub fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 240
        || path.starts_with('/')
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
    {
        return Err("unsafe_path".into());
    }
    let parts: Vec<_> = path.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        let lower = part.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or_default();
        if part.is_empty()
            || part.starts_with('.')
            || part.ends_with('.')
            || matches!(stem, "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("unsafe_path".into());
        }
        if i + 1 < parts.len()
            && matches!(
                lower.as_str(),
                "private"
                    | "config"
                    | "game"
                    | "games"
                    | "ygopro"
                    | "script"
                    | "scripts"
                    | "expansions"
                    | "replay"
                    | "replays"
                    | "deck"
                    | "decks"
                    | "database"
                    | "db"
                    | "card"
                    | "cards"
                    | "resources"
                    | "node_modules"
            )
        {
            return Err("forbidden_resource".into());
        }
    }
    let name = parts.last().unwrap().to_ascii_lowercase();
    if [
        "secret",
        "credential",
        "private-key",
        "private_key",
        "private.key",
        "privatekey",
        "id_rsa",
        "id_ed25519",
        "password",
    ]
    .iter()
    .any(|s| name.contains(s))
        || matches!(
            name.as_str(),
            "config.json"
                | "settings.json"
                | "account.json"
                | "accounts.json"
                | "player.json"
                | "players.json"
                | "userdata.json"
                | "key.json"
                | "tauri.conf.json"
                | "package.json"
                | "package-lock.json"
                | "tsconfig.json"
                | "cargo.json"
        )
    {
        return Err("forbidden_configuration".into());
    }
    let ext = name.rsplit('.').next().unwrap_or_default();
    if !matches!(
        ext,
        "html"
            | "css"
            | "js"
            | "mjs"
            | "json"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "svg"
            | "webp"
            | "ico"
            | "avif"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "eot"
            | "txt"
            | "webmanifest"
            | "map"
    ) {
        return Err("forbidden_file_type".into());
    }
    Ok(())
}
pub fn unpack(bytes: &[u8], manifest: &Manifest, target: &std::path::Path) -> Result<(), String> {
    use std::{
        fs,
        io::{Cursor, Read, Write},
    };
    validate_manifest(manifest, 0, false)?;
    if bytes.len() as u64 != manifest.archive.size || hash(bytes) != manifest.archive.sha256 {
        return Err("archive_hash_mismatch".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "invalid_zip")?;
    if zip.len() != manifest.files.len() {
        return Err("archive_file_mismatch".into());
    }
    fs::create_dir(target).map_err(|_| "staging_unavailable")?;
    let expected: std::collections::HashMap<_, _> = manifest
        .files
        .iter()
        .map(|f| (f.path.as_str(), f))
        .collect();
    let mut seen = std::collections::HashSet::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|_| "invalid_zip_entry")?;
        let name = file.name().to_string();
        validate_path(&name)?;
        if file.is_dir()
            || file.unix_mode().is_some_and(|mode| {
                mode & 0o111 != 0 || (mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
            })
            || !seen.insert(name.to_ascii_lowercase())
        {
            return Err("unsafe_zip_entry".into());
        }
        let declared = expected.get(name.as_str()).ok_or("unexpected_file")?;
        if file.size() != declared.size || file.size() > FILE_LIMIT {
            return Err("file_size_mismatch".into());
        }
        let mut content = Vec::with_capacity(file.size() as usize);
        (&mut file)
            .take(declared.size + 1)
            .read_to_end(&mut content)
            .map_err(|_| "invalid_zip_data")?;
        if content.len() as u64 != declared.size || hash(&content) != declared.sha256 {
            return Err("file_hash_mismatch".into());
        }
        let private_markers: [&[u8]; 5] = [
            b"BEGIN PRIVATE KEY",
            b"BEGIN RSA PRIVATE KEY",
            b"BEGIN EC PRIVATE KEY",
            b"BEGIN ENCRYPTED PRIVATE KEY",
            b"BEGIN OPENSSH PRIVATE KEY",
        ];
        if content.starts_with(b"MZ")
            || content.starts_with(b"\x7fELF")
            || private_markers.iter().any(|marker| {
                content
                    .windows(marker.len())
                    .any(|window| window == *marker)
            })
        {
            return Err("forbidden_file_content".into());
        }
        let output = target.join(&name);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|_| "staging_unavailable")?;
        }
        let mut destination = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)
            .map_err(|_| "staging_unavailable")?;
        destination
            .write_all(&content)
            .and_then(|_| destination.sync_all())
            .map_err(|_| "staging_unavailable")?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use sha2::{Digest, Sha256};
    use std::io::{Cursor, Write};

    pub fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    pub fn fixture(entries: &[(&str, &[u8])]) -> (Vec<u8>, Manifest) {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "application":"org.srvprotianti.desktop","channel":"stable","version":"1.0.0",
            "sequence":1,"bridgeVersion":1,"minAppVersion":"0.2.0",
            "createdAt":"2026-10-24T00:00:00Z","expiresAt":"2026-11-24T00:00:00Z",
            "archive":{"url":"https://github.com/301zrg/srvprotianti-desktop/releases/download/pages-v1.0.0/srvprotianti-desktop-pages.zip","size":bytes.len(),"sha256":hash(&bytes),"unpackedSize":entries.iter().map(|(_,v)| v.len()).sum::<usize>()},
            "files":entries.iter().map(|(name,v)| serde_json::json!({"path":name,"size":v.len(),"sha256":hash(v)})).collect::<Vec<_>>(),
            "sourceCommits":{"desktop":"a".repeat(40),"website":"b".repeat(40)}
        })).unwrap();
        (bytes, manifest)
    }
    pub fn envelope(manifest: &Manifest, domain: &[u8]) -> (Vec<u8>, TrustedKey) {
        let pair = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let payload = serde_json::to_vec(manifest).unwrap();
        let signature = pair.sign(&[domain, &payload].concat());
        (serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"keyId":"test","payload":STANDARD.encode(payload),"signature":STANDARD.encode(signature.as_ref())})).unwrap(), TrustedKey { key_id:"test".into(), public_key:STANDARD.encode(pair.public_key().as_ref()) })
    }
    pub const NOW: i64 = 1792800000; // 2026-10-24 00:00 UTC.

    #[test]
    fn authenticates_raw_payload_and_enforces_domain_and_trusted_key() {
        let (_, manifest) = fixture(&[("index.html", b"ok")]);
        let (bytes, key) = envelope(&manifest, b"srvprotianti-desktop-pages-v1\0");
        assert_eq!(
            verify_envelope(&bytes, &key, NOW, true).unwrap().version,
            "1.0.0"
        );
        let (wrong_domain, _) = envelope(&manifest, b"different\0");
        assert!(verify_envelope(&wrong_domain, &key, NOW, true).is_err());
        let wrong = TrustedKey {
            key_id: "untrusted".into(),
            public_key: key.public_key.clone(),
        };
        assert!(verify_envelope(&bytes, &wrong, NOW, true).is_err());
        let mut tampered: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        tampered["payload"] = STANDARD.encode(b"{}").into();
        assert!(verify_envelope(&serde_json::to_vec(&tampered).unwrap(), &key, NOW, true).is_err());
    }
    #[test]
    fn rejects_incompatible_or_stale_signed_metadata_but_keeps_accepted_offline_pages() {
        let (_, base) = fixture(&[("index.html", b"ok")]);
        let mut bad = Vec::new();
        let mut m = base.clone();
        m.application = "different".into();
        bad.push(m);
        let mut m = base.clone();
        m.channel = "other".into();
        bad.push(m);
        let mut m = base.clone();
        m.bridge_version = 2;
        bad.push(m);
        let mut m = base.clone();
        m.min_app_version = "99.0.0".into();
        bad.push(m);
        let mut m = base.clone();
        m.sequence = 0;
        bad.push(m);
        let mut m = base.clone();
        m.expires_at = "2026-10-23T00:00:00Z".into();
        bad.push(m);
        let mut m = base.clone();
        m.created_at = "2026-10-25T00:00:00Z".into();
        bad.push(m);
        let mut m = base.clone();
        m.archive.url = "https://evil.test/pages.zip".into();
        bad.push(m);
        for m in bad {
            let (b, k) = envelope(&m, b"srvprotianti-desktop-pages-v1\0");
            assert!(
                verify_envelope(&b, &k, NOW, true).is_err(),
                "accepted {m:?}"
            );
        }
        let (b, k) = envelope(&base, b"srvprotianti-desktop-pages-v1\0");
        assert!(verify_envelope(&b, &k, NOW + 100 * 86400, false).is_ok());
    }
    #[test]
    fn rejects_windows_escape_paths_resources_and_executable_content() {
        for good in ["rooms.html", "assets/a.woff2", "js/platform.mjs"] {
            assert!(validate_path(good).is_ok(), "{good}");
        }
        for bad in [
            "../a.js",
            "/a.js",
            "C:/a.js",
            "a\\b.js",
            "a//b.js",
            "a/./b.js",
            "a/../b.js",
            "CON.html",
            "aux.txt",
            "a. /b.js",
            "a%2fb.js",
            "a.exe",
            "a.dll",
            "x.lua",
            "config.json",
            "resources/a.png",
            "expansions/x.js",
            "中文.js",
        ] {
            assert!(validate_path(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn installs_only_exact_hashed_manifest_without_partial_acceptance() {
        let (bytes, m) = fixture(&[("index.html", b"ok"), ("assets/a.css", b"body{}")]);
        let target = std::env::temp_dir().join(format!("page-test-{}", uuid::Uuid::new_v4()));
        unpack(&bytes, &m, &target).unwrap();
        assert_eq!(std::fs::read(target.join("index.html")).unwrap(), b"ok");
        let mut bad = m.clone();
        bad.files[0].sha256 = "0".repeat(64);
        assert!(unpack(&bytes, &bad, &target.with_extension("bad")).is_err());
        let mut extra = m.clone();
        extra.files.pop();
        assert!(unpack(&bytes, &extra, &target.with_extension("extra")).is_err());
        let _ = std::fs::remove_dir_all(target);
    }
    #[test]
    fn rejects_executable_zip_permissions_even_when_name_and_hash_are_allowed() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "index.html",
                zip::write::FileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        writer.write_all(b"ok").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let (_, mut m) = fixture(&[("index.html", b"ok")]);
        m.archive.size = bytes.len() as u64;
        m.archive.sha256 = hash(&bytes);
        let target = std::env::temp_dir().join(format!("page-permission-{}", uuid::Uuid::new_v4()));
        assert!(unpack(&bytes, &m, &target).is_err());
        let _ = std::fs::remove_dir_all(target);
    }
    #[test]
    fn verifies_actual_node_producer_signature_and_deterministic_zip() {
        let key: TrustedKey =
            serde_json::from_slice(include_bytes!("../tests/fixtures/pages/trusted.json")).unwrap();
        let bytes = include_bytes!("../tests/fixtures/pages/manifest.json");
        let manifest = verify_envelope(bytes, &key, NOW, true).unwrap();
        assert_eq!(
            manifest.archive.sha256,
            "d7bfd1728e914ffe8caaa33160fa1f34c8a908ee182ea741fcb2a6387891c4e7"
        );
        let target =
            std::env::temp_dir().join(format!("page-node-fixture-{}", uuid::Uuid::new_v4()));
        unpack(
            include_bytes!("../tests/fixtures/pages/pages.zip"),
            &manifest,
            &target,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(target.join("assets/main.js")).unwrap(),
            b"window.fixtureReady=true;"
        );
        std::fs::remove_dir_all(target).unwrap();
    }
    #[test]
    fn rejects_declared_zip_bombs_and_case_collisions_before_extracting() {
        let (_, base) = fixture(&[("index.html", b"ok")]);
        let mut cases = Vec::new();
        let mut m = base.clone();
        m.files[0].size = 5 * 1024 * 1024 + 1;
        m.archive.unpacked_size = m.files[0].size;
        cases.push(m);
        let mut m = base.clone();
        m.archive.size = 20 * 1024 * 1024 + 1;
        cases.push(m);
        let mut m = base.clone();
        m.files.push(File {
            path: "INDEX.HTML".into(),
            size: 0,
            sha256: "0".repeat(64),
        });
        cases.push(m);
        let mut m = base.clone();
        m.files = (0..13)
            .map(|i| File {
                path: if i == 0 {
                    "index.html".into()
                } else {
                    format!("a{i}.js")
                },
                size: 4 * 1024 * 1024,
                sha256: "0".repeat(64),
            })
            .collect();
        m.archive.unpacked_size = 13 * 4 * 1024 * 1024;
        cases.push(m);
        let mut m = base.clone();
        m.files.extend((0..4096).map(|i| File {
            path: format!("a{i}.js"),
            size: 0,
            sha256: "0".repeat(64),
        }));
        cases.push(m);
        for m in cases {
            let (raw, key) = envelope(&m, b"srvprotianti-desktop-pages-v1\0");
            assert!(verify_envelope(&raw, &key, NOW, true).is_err());
        }
    }
    #[test]
    fn rejects_zip_links_and_secret_or_executable_payloads_with_valid_hashes() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink(
                "index.html",
                "outside",
                zip::write::FileOptions::default().unix_permissions(0o644),
            )
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let (_, mut m) = fixture(&[("index.html", b"outside")]);
        m.archive.size = bytes.len() as u64;
        m.archive.sha256 = hash(&bytes);
        let target = std::env::temp_dir().join(format!("page-link-{}", uuid::Uuid::new_v4()));
        assert!(unpack(&bytes, &m, &target).is_err());
        let _ = std::fs::remove_dir_all(&target);
        for content in [
            b"MZfixture".as_slice(),
            b"\x7fELFfixture",
            b"-----BEGIN EC PRIVATE KEY-----",
            b"-----BEGIN ENCRYPTED PRIVATE KEY-----",
        ] {
            let (bytes, m) = fixture(&[("index.html", content)]);
            let target =
                std::env::temp_dir().join(format!("page-content-{}", uuid::Uuid::new_v4()));
            assert!(unpack(&bytes, &m, &target).is_err());
            let _ = std::fs::remove_dir_all(target);
        }
    }
}
