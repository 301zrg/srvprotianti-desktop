//! Durable page-only state. A staged package never changes the selected resources of this process.
use crate::pages_package::{self as package, Manifest, TrustedKey};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::{collections::HashSet, fs, io::Read};

#[derive(Clone, Debug)]
pub struct Selected {
    pub version: String,
    pub directory: Option<PathBuf>,
    pub manifest: Option<Manifest>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    version: String,
    sequence: u64,
    envelope_sha256: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Book {
    schema_version: u32,
    highest_sequence: u64,
    highest_version: Option<String>,
    highest_manifest_hash: Option<String>,
    active: Option<Reference>,
    pending: Option<Reference>,
    previous: Option<Reference>,
    booting: Option<Reference>,
    quarantined: Vec<Reference>,
    force_builtin: bool,
}
impl Default for Book {
    fn default() -> Self {
        Self {
            schema_version: 1,
            highest_sequence: 0,
            highest_version: None,
            highest_manifest_hash: None,
            active: None,
            pending: None,
            previous: None,
            booting: None,
            quarantined: Vec::new(),
            force_builtin: false,
        }
    }
}
pub struct Store {
    root: PathBuf,
    boundary: PathBuf,
    key: TrustedKey,
    book: Book,
    disabled: bool,
    pinned: Option<String>,
    pub recovered: bool,
}
impl Selected {
    fn builtin() -> Self {
        Self {
            version: "builtin".into(),
            directory: None,
            manifest: None,
        }
    }
}
fn stable_version(value: &str) -> bool {
    semver::Version::parse(value)
        .is_ok_and(|v| v.pre.is_empty() && v.build.is_empty() && v.to_string() == value)
}
pub fn no_link(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "cache_unavailable")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("cache_link".into());
        }
    }
    if metadata.file_type().is_symlink() {
        return Err("cache_link".into());
    }
    Ok(metadata)
}
pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = no_link(path)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("cache_file_invalid".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .map_err(|_| "cache_unavailable")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cache_unavailable")?;
    if bytes.len() as u64 > limit {
        return Err("cache_file_invalid".into());
    }
    Ok(bytes)
}
impl Store {
    pub fn open_owned(
        root: PathBuf,
        boundary: PathBuf,
        key: TrustedKey,
        now: i64,
    ) -> (Self, Selected) {
        Self::open_inner(root, boundary, key, now)
    }
    #[cfg(test)]
    pub fn open(root: PathBuf, key: TrustedKey, now: i64) -> (Self, Selected) {
        let boundary = root.parent().expect("cache has a parent").to_path_buf();
        Self::open_inner(root, boundary, key, now)
    }
    fn open_inner(root: PathBuf, boundary: PathBuf, key: TrustedKey, now: i64) -> (Self, Selected) {
        let mut store = Self {
            root,
            boundary,
            key,
            book: Book::default(),
            disabled: false,
            pinned: None,
            recovered: false,
        };
        if store.owned().is_err() {
            store.disabled = true;
            return (store, Selected::builtin());
        }
        let state = store.root.join("state.json");
        if state.exists() {
            let loaded = read_limited(&state, 64 * 1024).and_then(|bytes| {
                serde_json::from_slice::<Book>(&bytes).map_err(|_| "invalid_cache_state".into())
            });
            match loaded {
                Ok(book) if valid_book(&book) => store.book = book,
                _ => {
                    store.disabled = true;
                    return (store, Selected::builtin());
                }
            }
        }
        // An unconfirmed boot left by a crash is never retried automatically.
        if let Some(failed) = store.book.booting.take() {
            store.quarantine(failed);
            store.book.pending = None;
            store.recovered = true;
        }
        if store.book.force_builtin {
            store.book.force_builtin = false;
            store.recovered = true;
            if store.save().is_err() {
                store.disabled = true;
            }
            return (store, Selected::builtin());
        }
        if let Some(candidate) = store.book.pending.clone() {
            match store.read_package(&candidate, now) {
                Ok(selected) => {
                    store.book.booting = Some(candidate);
                    if store.save().is_ok() {
                        store.pinned = Some(selected.version.clone());
                        store.prune();
                        return (store, selected);
                    }
                    store.disabled = true;
                    return (store, Selected::builtin());
                }
                Err(_) => {
                    store.quarantine(candidate);
                    store.book.pending = None;
                    store.recovered = true;
                }
            }
        }
        for reference in [store.book.active.clone(), store.book.previous.clone()]
            .into_iter()
            .flatten()
        {
            if store.book.quarantined.contains(&reference) {
                continue;
            }
            match store.read_package(&reference, now) {
                Ok(selected) => {
                    if store.book.active.as_ref() != Some(&reference) {
                        store.book.active = Some(reference);
                        store.book.previous = None;
                        store.recovered = true;
                    }
                    if store.recovered && store.save().is_err() {
                        store.disabled = true;
                        return (store, Selected::builtin());
                    }
                    store.pinned = Some(selected.version.clone());
                    store.prune();
                    return (store, selected);
                }
                Err(_) => {
                    store.quarantine(reference.clone());
                    if store.book.active.as_ref() == Some(&reference) {
                        store.book.active = None;
                    }
                    store.recovered = true;
                }
            }
        }
        if store.recovered && store.save().is_err() {
            store.disabled = true;
        }
        store.prune();
        (store, Selected::builtin())
    }
    pub fn is_new(&self, manifest: &Manifest, envelope: &[u8]) -> Result<bool, String> {
        if self.disabled {
            return Err("cache_state_unavailable".into());
        }
        if manifest.sequence == self.book.highest_sequence
            && self.book.highest_version.as_ref() == Some(&manifest.version)
            && self.book.highest_manifest_hash.as_ref() == Some(&package::hash(envelope))
        {
            return Ok(false);
        }
        if manifest.sequence <= self.book.highest_sequence {
            return Err("page_downgrade_denied".into());
        }
        if let Some(highest) = &self.book.highest_version {
            if semver::Version::parse(&manifest.version).map_err(|_| "invalid_version")?
                <= semver::Version::parse(highest).map_err(|_| "invalid_version")?
            {
                return Err("page_downgrade_denied".into());
            }
        }
        Ok(true)
    }
    pub fn stage(&mut self, envelope: &[u8], archive: &[u8], now: i64) -> Result<(), String> {
        let manifest = package::verify_envelope(envelope, &self.key, now, true)?;
        if !self.is_new(&manifest, envelope)? {
            return Err("pages_already_accepted".into());
        }
        self.owned()?;
        fs::create_dir_all(self.root.join("packages")).map_err(|_| "cache_not_writable")?;
        no_link(&self.root)?;
        no_link(&self.root.join("packages"))?;
        let staging = self
            .root
            .join("packages")
            .join(format!(".staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging).map_err(|_| "cache_not_writable")?;
        let installed = self.root.join("packages").join(&manifest.version);
        let result = (|| {
            package::unpack(archive, &manifest, &staging.join("dist"))?;
            crate::settings::atomic_write(&staging.join("manifest.json"), envelope)
                .map_err(|_| "cache_not_writable")?;
            // Versions are immutable; an existing orphan is removed only by bounded startup pruning.
            if installed.exists() {
                return Err("page_version_exists".into());
            }
            fs::rename(&staging, &installed).map_err(|_| "cache_not_writable")?;
            let reference = Reference {
                version: manifest.version.clone(),
                sequence: manifest.sequence,
                envelope_sha256: package::hash(envelope),
            };
            let mut next = self.book.clone();
            next.highest_sequence = manifest.sequence;
            next.highest_version = Some(manifest.version);
            next.highest_manifest_hash = Some(reference.envelope_sha256.clone());
            next.pending = Some(reference);
            self.commit(next)
        })();
        if staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        if result.is_ok() {
            self.prune();
        }
        result
    }
    pub fn ready(&mut self, selected: &Selected) -> Result<(), String> {
        let Some(candidate) = self.book.booting.clone() else {
            return Ok(());
        };
        if selected.version != candidate.version {
            return Err("unexpected_page_readiness".into());
        }
        let mut next = self.book.clone();
        next.previous = next.active.take();
        next.active = Some(candidate);
        next.pending = None;
        next.booting = None;
        self.commit(next)?;
        self.prune();
        Ok(())
    }
    pub fn recover_builtin(&mut self) -> Result<(), String> {
        if self.disabled {
            return Err("cache_state_unavailable".into());
        }
        let previous = self.book.clone();
        for reference in [self.book.pending.take(), self.book.active.take()]
            .into_iter()
            .flatten()
        {
            self.quarantine(reference);
        }
        self.book.booting = None;
        self.book.force_builtin = true;
        let next = std::mem::replace(&mut self.book, previous);
        self.commit(next)
    }
    #[cfg(test)]
    pub fn highest(&self) -> u64 {
        self.book.highest_sequence
    }
    pub fn pending_version(&self) -> Option<String> {
        self.book.pending.as_ref().map(|p| p.version.clone())
    }
    pub fn fail_boot(&mut self, selected: &Selected) -> Result<bool, String> {
        let Some(candidate) = self.book.booting.clone() else {
            return Ok(false);
        };
        if candidate.version != selected.version {
            return Ok(false);
        }
        let old = self.book.clone();
        self.quarantine(candidate);
        self.book.booting = None;
        self.book.pending = None;
        if self.save().is_err() {
            self.book = old;
            return Err("cache_not_writable".into());
        }
        Ok(true)
    }
    fn quarantine(&mut self, reference: Reference) {
        if !self.book.quarantined.contains(&reference) {
            self.book.quarantined.push(reference);
        }
        if self.book.quarantined.len() > 32 {
            self.book.quarantined.remove(0);
        }
    }
    fn save(&self) -> Result<(), String> {
        self.owned()?;
        let bytes = serde_json::to_vec_pretty(&self.book).map_err(|_| "invalid_cache_state")?;
        crate::settings::atomic_write(&self.root.join("state.json"), &bytes)
            .map_err(|_| "cache_not_writable".into())
    }
    fn commit(&mut self, next: Book) -> Result<(), String> {
        let previous = std::mem::replace(&mut self.book, next);
        if let Err(error) = self.save() {
            self.book = previous;
            return Err(error);
        }
        Ok(())
    }
    fn read_package(&self, reference: &Reference, now: i64) -> Result<Selected, String> {
        self.owned()?;
        if self.book.quarantined.contains(reference) {
            return Err("pages_quarantined".into());
        }
        let container = self.root.join("packages").join(&reference.version);
        no_link(&self.root.join("packages"))?;
        no_link(&container)?;
        let bytes = read_limited(&container.join("manifest.json"), package::ENVELOPE_LIMIT)?;
        if package::hash(&bytes) != reference.envelope_sha256 {
            return Err("cached_manifest_changed".into());
        }
        let manifest = package::verify_envelope(&bytes, &self.key, now, false)?;
        if manifest.version != reference.version || manifest.sequence != reference.sequence {
            return Err("cached_manifest_changed".into());
        }
        let directory = container.join("dist");
        verify_dist(&directory, &manifest)?;
        Ok(Selected {
            version: reference.version.clone(),
            directory: Some(directory),
            manifest: Some(manifest),
        })
    }
    fn prune(&self) {
        if self.disabled || self.owned().is_err() {
            return;
        }
        let packages = self.root.join("packages");
        if no_link(&packages).is_err() {
            return;
        }
        let retain: HashSet<_> = [
            &self.book.active,
            &self.book.pending,
            &self.book.previous,
            &self.book.booting,
        ]
        .into_iter()
        .filter_map(|r| r.as_ref().map(|r| r.version.as_str()))
        .chain(self.pinned.as_deref())
        .collect();
        if let Ok(entries) = fs::read_dir(&packages) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let own_staging = name
                    .strip_prefix(".staging-")
                    .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok());
                if (own_staging || (stable_version(&name) && !retain.contains(name.as_str())))
                    && no_link(&entry.path()).is_ok_and(|m| m.is_dir())
                {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }
    fn owned(&self) -> Result<(), String> {
        // The user-selected game root may itself be a legitimate alias. Runtime canonicalizes it once;
        // every child from that owned boundary to the page cache must remain a real directory.
        if !self.boundary.is_absolute() || !fs::metadata(&self.boundary).is_ok_and(|m| m.is_dir()) {
            return Err("invalid_page_cache_boundary".into());
        }
        let relative = self
            .root
            .strip_prefix(&self.boundary)
            .map_err(|_| "invalid_page_cache_boundary")?;
        let mut current = self.boundary.clone();
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return Err("invalid_page_cache_boundary".into());
            }
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(_) => {
                    if !no_link(&current)?.is_dir() {
                        return Err("invalid_page_cache_boundary".into());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("cache_unavailable".into()),
            }
        }
        Ok(())
    }
}

fn valid_book(book: &Book) -> bool {
    let digest = |value: &str| {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if book.schema_version != 1
        || book.quarantined.len() > 32
        || (book.highest_sequence == 0) != (book.highest_version.is_none())
        || (book.highest_sequence == 0) != (book.highest_manifest_hash.is_none())
        || book
            .highest_version
            .as_ref()
            .is_some_and(|v| !stable_version(v))
        || book
            .highest_manifest_hash
            .as_ref()
            .is_some_and(|v| !digest(v))
    {
        return false;
    }
    [&book.active, &book.pending, &book.previous, &book.booting]
        .into_iter()
        .filter_map(Option::as_ref)
        .chain(book.quarantined.iter())
        .all(|r| {
            stable_version(&r.version)
                && r.sequence > 0
                && r.sequence <= book.highest_sequence
                && digest(&r.envelope_sha256)
        })
        && (book.booting.is_none() || book.booting == book.pending)
}
fn verify_dist(directory: &Path, manifest: &Manifest) -> Result<(), String> {
    if !no_link(directory)?.is_dir() {
        return Err("cache_not_directory".into());
    }
    let files: HashSet<_> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    let mut directories = HashSet::new();
    for file in &manifest.files {
        let mut path = Path::new(&file.path).parent();
        while let Some(parent) = path {
            if parent.as_os_str().is_empty() {
                break;
            }
            directories.insert(parent.to_string_lossy().replace('\\', "/"));
            path = parent.parent();
        }
    }
    let mut pending = vec![directory.to_path_buf()];
    let mut count = 0;
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current).map_err(|_| "cache_unavailable")? {
            let entry = entry.map_err(|_| "cache_unavailable")?;
            let path = entry.path();
            let metadata = no_link(&path)?;
            let relative = path
                .strip_prefix(directory)
                .map_err(|_| "unsafe_cache_path")?
                .to_string_lossy()
                .replace('\\', "/");
            if metadata.is_dir() {
                if !directories.contains(&relative) {
                    return Err("unexpected_cached_directory".into());
                }
                pending.push(path);
            } else if metadata.is_file() {
                if !files.contains(relative.as_str()) {
                    return Err("unexpected_cached_file".into());
                }
                count += 1;
            } else {
                return Err("unsafe_cache_file".into());
            }
        }
    }
    if count != manifest.files.len() {
        return Err("missing_cached_file".into());
    }
    for file in &manifest.files {
        let bytes = read_limited(&directory.join(&file.path), package::FILE_LIMIT)?;
        if bytes.len() as u64 != file.size || package::hash(&bytes) != file.sha256 {
            return Err("cached_file_changed".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages_package::tests::{envelope, fixture, NOW};
    const DOMAIN: &[u8] = b"srvprotianti-desktop-pages-v1\0";
    fn root() -> PathBuf {
        std::env::temp_dir().join(format!("page-store-{}", uuid::Uuid::new_v4()))
    }
    fn data(version: &str, seq: u64) -> (Vec<u8>, Vec<u8>, TrustedKey) {
        let (zip, mut m) = fixture(&[("index.html", b"hello")]);
        m.version = version.into();
        m.sequence = seq;
        m.archive.url=format!("https://github.com/301zrg/srvprotianti-desktop/releases/download/pages-v{version}/srvprotianti-desktop-pages.zip");
        let (json, key) = envelope(&m, DOMAIN);
        (zip, json, key)
    }
    #[test]
    fn stages_for_next_launch_and_confirms_candidate_without_changing_current_selection() {
        let root = root();
        let (zip, json, key) = data("1.0.0", 1);
        let (mut store, current) = Store::open(root.clone(), key, NOW);
        store.stage(&json, &zip, NOW).unwrap();
        assert_eq!(current.version, "builtin");
        assert_eq!(store.highest(), 1);
        let (_, _, key) = data("1.0.0", 1);
        let (mut next, selected) = Store::open(root.clone(), key, NOW);
        assert_eq!(selected.version, "1.0.0");
        next.ready(&selected).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (_, selected) = Store::open(root.clone(), key, NOW + 100 * 86400);
        assert_eq!(selected.version, "1.0.0");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unready_candidate_is_quarantined_while_sequence_barrier_survives_recovery() {
        let root = root();
        let (zip, json, key) = data("1.0.0", 1);
        let (mut store, _) = Store::open(root.clone(), key, NOW);
        store.stage(&json, &zip, NOW).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (_, selected) = Store::open(root.clone(), key, NOW);
        assert_eq!(selected.version, "1.0.0");
        let (_, _, key) = data("1.0.0", 1);
        let (mut recovered, selected) = Store::open(root.clone(), key, NOW);
        assert_eq!(selected.version, "builtin");
        assert!(recovered.stage(&json, &zip, NOW).is_err());
        assert_eq!(recovered.highest(), 1);
        recovered.recover_builtin().unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (mut recovered, selected) = Store::open(root.clone(), key, NOW);
        assert_eq!(selected.version, "builtin");
        assert!(recovered.stage(&json, &zip, NOW).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bad_staging_and_corrupt_cache_do_not_touch_player_files_or_accept_downgrade() {
        let root = root();
        let (zip, json, key) = data("1.0.0", 1);
        let (mut store, _) = Store::open(root.clone(), key, NOW);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("player-sentinel"), b"keep").unwrap();
        assert!(store.stage(&json, b"broken", NOW).is_err());
        assert_eq!(store.highest(), 0);
        store.stage(&json, &zip, NOW).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (mut s, selected) = Store::open(root.clone(), key, NOW);
        s.ready(&selected).unwrap();
        std::fs::write(selected.directory.unwrap().join("index.html"), b"tampered").unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (mut s, selected) = Store::open(root.clone(), key, NOW);
        assert_eq!(selected.version, "builtin");
        assert!(s.stage(&json, &zip, NOW).is_err());
        assert_eq!(
            std::fs::read(root.join("player-sentinel")).unwrap(),
            b"keep"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_active_falls_back_to_previous_and_timeout_quarantines_only_candidate() {
        let root = root();
        let (zip, json, key) = data("1.0.0", 1);
        let (mut store, _) = Store::open(root.clone(), key, NOW);
        store.stage(&json, &zip, NOW).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (mut store, one) = Store::open(root.clone(), key, NOW);
        store.ready(&one).unwrap();
        let (zip, json, _) = data("1.1.0", 2);
        store.stage(&json, &zip, NOW).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (mut store, two) = Store::open(root.clone(), key, NOW);
        assert_eq!(two.version, "1.1.0");
        assert!(store.fail_boot(&two).unwrap());
        assert!(!store.fail_boot(&two).unwrap());
        let (_, _, key) = data("1.0.0", 1);
        let (mut store, one) = Store::open(root.clone(), key, NOW);
        assert_eq!(one.version, "1.0.0");
        assert_eq!(store.highest(), 2);
        let (zip, json, _) = data("1.2.0", 3);
        store.stage(&json, &zip, NOW).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (mut store, three) = Store::open(root.clone(), key, NOW);
        store.ready(&three).unwrap();
        std::fs::remove_file(three.directory.unwrap().join("index.html")).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (store, selected) = Store::open(root.clone(), key, NOW);
        assert_eq!(selected.version, "1.0.0");
        assert_eq!(store.highest(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_state_fails_closed_for_updates_and_preserves_builtin() {
        let root = root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("state.json"), b"broken").unwrap();
        let (zip, json, key) = data("1.0.0", 1);
        let (mut store, selected) = Store::open(root.clone(), key, NOW);
        assert_eq!(selected.version, "builtin");
        assert!(store.stage(&json, &zip, NOW).is_err());
        assert_eq!(std::fs::read(root.join("state.json")).unwrap(), b"broken");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_recovery_write_does_not_forget_previous_active_package_in_memory() {
        let root = root();
        let (zip, json, key) = data("1.0.0", 1);
        let (mut s, _) = Store::open(root.clone(), key, NOW);
        s.stage(&json, &zip, NOW).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (mut s, one) = Store::open(root.clone(), key, NOW);
        s.ready(&one).unwrap();
        std::fs::rename(root.join("state.json"), root.join("state.saved")).unwrap();
        std::fs::create_dir(root.join("state.json")).unwrap();
        assert!(s.recover_builtin().is_err());
        std::fs::remove_dir(root.join("state.json")).unwrap();
        std::fs::rename(root.join("state.saved"), root.join("state.json")).unwrap();
        let (zip, json, _) = data("1.1.0", 2);
        s.stage(&json, &zip, NOW).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (mut s, two) = Store::open(root.clone(), key, NOW);
        s.ready(&two).unwrap();
        std::fs::remove_file(two.directory.unwrap().join("index.html")).unwrap();
        let (_, _, key) = data("1.0.0", 1);
        let (_, selected) = Store::open(root.clone(), key, NOW);
        assert_eq!(selected.version, "1.0.0");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_linked_data_parent_before_writing_outside_owned_game_root() {
        let game = root();
        let outside = root();
        std::fs::create_dir_all(&game).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let link = game.join("srvprotianti-desktop-data");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let result = std::process::Command::new("cmd.exe")
                .args(["/c", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "junction fixture creation failed: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let (zip, json, key) = data("1.0.0", 1);
        let (mut s, selected) =
            Store::open_owned(link.join("page-packages"), game.clone(), key, NOW);
        let rejected = s.stage(&json, &zip, NOW).is_err();
        let escaped = outside.join("page-packages").exists();
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(game).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
        assert_eq!(selected.version, "builtin");
        assert!(rejected, "linked parent must disable cache writes");
        assert!(!escaped, "must not create data outside selected game root");
    }
}
