use crate::settings;
use std::path::Path;

const MAX_CSV_BYTES: usize = 8 * 1024 * 1024;

fn validate(filename: &str, contents: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.len() > 180
        || filename.contains(['/', '\\'])
        || filename.chars().any(char::is_control)
        || !filename.to_ascii_lowercase().ends_with(".csv")
    {
        return Err("Invalid CSV filename".into());
    }
    if contents.is_empty() || contents.len() > MAX_CSV_BYTES || contents.contains('\0') {
        return Err("CSV data is empty or too large".into());
    }
    Ok(())
}

#[cfg(windows)]
pub fn save(
    owner: isize,
    filename: &str,
    contents: &str,
    language: &str,
) -> Result<Option<String>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    validate(filename, contents)?;
    let title = match language {
        "ja" => "統計表を保存",
        "en" => "Save statistics table",
        "ko" => "통계 표 저장",
        _ => "保存统计表",
    };
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    let filter: Vec<u16> = "CSV (*.csv)\0*.csv\0\0".encode_utf16().collect();
    let extension: Vec<u16> = "csv\0".encode_utf16().collect();
    let mut buffer = vec![0u16; 32768];
    let name: Vec<u16> = filename.encode_utf16().collect();
    buffer[..name.len()].copy_from_slice(&name);
    // The native dialog owns path selection and overwrite confirmation; the
    // webview can provide CSV bytes and a suggested basename, never a path.
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    dialog.hwndOwner = owner as _;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.nFilterIndex = 1;
    dialog.lpstrFile = buffer.as_mut_ptr();
    dialog.nMaxFile = buffer.len() as u32;
    dialog.lpstrTitle = title.as_ptr();
    dialog.lpstrDefExt = extension.as_ptr();
    dialog.Flags = OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST;
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        let code = unsafe { CommDlgExtendedError() };
        return if code == 0 {
            Ok(None)
        } else {
            Err(format!("Save dialog failed: {code}"))
        };
    }
    let length = buffer.iter().position(|value| *value == 0).unwrap_or(0);
    let target = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
    write(&target, contents)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg(not(windows))]
pub fn save(
    _owner: isize,
    _filename: &str,
    _contents: &str,
    _language: &str,
) -> Result<Option<String>, String> {
    Err("CSV save dialog requires Windows".into())
}

fn write(target: &Path, contents: &str) -> Result<(), String> {
    if !target
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("csv"))
    {
        return Err("Only CSV files can be saved".into());
    }
    if let Ok(metadata) = std::fs::symlink_metadata(target) {
        if !metadata.is_file() || settings::is_link_or_reparse(&metadata) {
            return Err("CSV destination is not a regular file".into());
        }
    }
    settings::atomic_write(target, contents.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_input_rejects_paths_and_non_csv_files() {
        assert!(validate("../report.csv", "a,b\r\n").is_err());
        assert!(validate("report.exe", "a,b\r\n").is_err());
        assert!(validate("report.csv", "\0").is_err());
        assert!(validate("report.csv", "a,b\r\n").is_ok());
    }

    #[test]
    fn selected_destination_is_restricted_to_csv() {
        let directory = std::env::temp_dir().join(format!("srvpro-csv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        assert!(write(&directory.join("report.exe"), "a,b\r\n").is_err());
        let file = directory.join("report.csv");
        write(&file, "\u{feff}名称,胜率\r\n测试,50%\r\n").unwrap();
        assert!(std::fs::read_to_string(file)
            .unwrap()
            .starts_with('\u{feff}'));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
