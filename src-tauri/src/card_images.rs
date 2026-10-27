use base64::Engine;
use serde::Serialize;
use std::{fs, io::Read, path::Path};

const IMAGE_LIMIT: usize = 2 * 1024 * 1024;
const TOTAL_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardImage {
    pub content_type: &'static str,
    pub body_base64: String,
}

#[cfg(windows)]
fn pin_directory(path: &Path) -> Option<fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        // BACKUP_SEMANTICS opens directories; OPEN_REPARSE_POINT does not follow junctions.
        .custom_flags(0x0220_0000)
        .share_mode(1)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    (metadata.is_dir() && !crate::settings::is_link_or_reparse(&metadata)).then_some(file)
}

pub fn read(root: &Path, card_id: u32) -> Vec<CardImage> {
    if card_id == 0 {
        return Vec::new();
    }
    let Ok(root) = root.canonicalize() else {
        return Vec::new();
    };
    #[cfg(windows)]
    let Some(_root_guard) = pin_directory(&root) else {
        return Vec::new();
    };
    let directory = root.join("pics");
    #[cfg(windows)]
    let Some(_directory_guard) = pin_directory(&directory) else {
        return Vec::new();
    };
    let Ok(metadata) = fs::symlink_metadata(&directory) else {
        return Vec::new();
    };
    if !metadata.is_dir() || crate::settings::is_link_or_reparse(&metadata) {
        return Vec::new();
    }
    let Ok(directory) = directory.canonicalize() else {
        return Vec::new();
    };
    if directory.parent() != Some(root.as_path()) {
        return Vec::new();
    }
    let mut images = Vec::new();
    let mut total = 0;
    for (extension, content_type) in [
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("png", "image/png"),
        ("webp", "image/webp"),
    ] {
        let path = directory.join(format!("{card_id}.{extension}"));
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || crate::settings::is_link_or_reparse(&metadata) {
            continue;
        }
        let limit = IMAGE_LIMIT.min(TOTAL_LIMIT - total);
        if metadata.len() == 0 || metadata.len() > limit as u64 {
            continue;
        }
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        if canonical.parent() != Some(directory.as_path()) {
            continue;
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Open the final reparse point itself and deny writes/renames while reading.
            options.custom_flags(0x0020_0000).share_mode(1);
        }
        let Ok(file) = options.open(&path) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        if !metadata.is_file() || crate::settings::is_link_or_reparse(&metadata) {
            continue;
        }
        let mut bytes = Vec::new();
        if file.take(limit as u64 + 1).read_to_end(&mut bytes).is_err()
            || bytes.is_empty()
            || bytes.len() > limit
        {
            continue;
        }
        total += bytes.len();
        images.push(CardImage {
            content_type,
            body_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    images
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("srvpro-card-images-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(root.join("pics")).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_only_the_requested_numeric_card_and_supported_formats() {
        let fixture = Fixture::new();
        for extension in ["jpg", "jpeg", "png", "webp"] {
            fs::write(fixture.0.join(format!("pics/123.{extension}")), extension).unwrap();
        }
        fs::write(fixture.0.join("pics/124.jpg"), "other card").unwrap();
        fs::write(fixture.0.join("pics/123.svg"), "not supported").unwrap();
        let images = read(&fixture.0, 123);
        assert_eq!(images.len(), 4);
        assert_eq!(images[0].content_type, "image/jpeg");
        assert_eq!(images[2].content_type, "image/png");
        assert_eq!(images[3].content_type, "image/webp");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&images[0].body_base64)
                .unwrap(),
            b"jpg"
        );
        assert!(read(&fixture.0, 0).is_empty());
        assert!(read(&fixture.0, 999).is_empty());
    }

    #[test]
    fn absent_directory_empty_files_and_directories_are_missing_images() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("pics/123.jpg")).unwrap();
        fs::write(fixture.0.join("pics/123.png"), []).unwrap();
        assert!(read(&fixture.0, 123).is_empty());
        fs::remove_dir_all(fixture.0.join("pics")).unwrap();
        assert!(read(&fixture.0, 123).is_empty());
    }

    #[test]
    fn limits_individual_and_combined_image_bytes() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("pics/123.jpg"), vec![1; IMAGE_LIMIT + 1]).unwrap();
        fs::write(fixture.0.join("pics/123.jpeg"), vec![2; IMAGE_LIMIT]).unwrap();
        fs::write(fixture.0.join("pics/123.png"), vec![3; IMAGE_LIMIT]).unwrap();
        fs::write(fixture.0.join("pics/123.webp"), vec![4; 10]).unwrap();
        let images = read(&fixture.0, 123);
        assert_eq!(images.len(), 2);
        let total: usize = images
            .iter()
            .map(|image| {
                base64::engine::general_purpose::STANDARD
                    .decode(&image.body_base64)
                    .unwrap()
                    .len()
            })
            .sum();
        assert_eq!(total, TOTAL_LIMIT);
    }

    #[cfg(windows)]
    #[test]
    fn directory_pin_blocks_replacement_until_the_read_finishes() {
        let fixture = Fixture::new();
        let pics = fixture.0.join("pics");
        let moved = fixture.0.join("moved");
        fs::rename(&pics, &moved).unwrap();
        fs::rename(&moved, &pics).unwrap();
        let guard = pin_directory(&pics).expect("readable pics can be pinned");
        assert!(fs::rename(&pics, &moved).is_err());
        drop(guard);
        fs::rename(&pics, &moved).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn rejects_a_pics_junction_to_another_directory() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("pics/123.jpg"), "outside").unwrap();
        fs::remove_dir(fixture.0.join("pics")).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(fixture.0.join("pics"))
            .arg(outside.0.join("pics"))
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "{}",
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(read(&fixture.0, 123).is_empty());
    }
}
