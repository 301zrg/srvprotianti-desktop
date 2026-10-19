use crate::settings;
use base64::Engine;
use std::io::{Cursor, Read};
use std::path::Path;

const MAX_REPORT_BYTES: usize = 8 * 1024 * 1024;
const XLSX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

fn validate(filename: &str, contents: &str) -> Result<(), String> {
    validate_name(filename, "csv")?;
    if contents.is_empty() || contents.len() > MAX_REPORT_BYTES || contents.contains('\0') {
        return Err("CSV data is empty or too large".into());
    }
    Ok(())
}

fn validate_name(filename: &str, extension: &str) -> Result<(), String> {
    if filename.is_empty()
        || filename.len() > 180
        || filename.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
        || filename.chars().any(char::is_control)
        || !filename
            .to_ascii_lowercase()
            .ends_with(&format!(".{extension}"))
    {
        return Err("Invalid report filename".into());
    }
    Ok(())
}

pub fn save(
    owner: isize,
    filename: &str,
    contents: &str,
    language: &str,
) -> Result<Option<String>, String> {
    validate(filename, contents)?;
    save_bytes(owner, filename, contents.as_bytes(), language, "csv")
}

pub fn save_xlsx(
    owner: isize,
    filename: &str,
    encoded: &str,
    language: &str,
) -> Result<Option<String>, String> {
    validate_name(filename, "xlsx")?;
    if encoded.len() > MAX_REPORT_BYTES.div_ceil(3) * 4 {
        return Err("XLSX data is too large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid XLSX encoding")?;
    validate_xlsx(&bytes)?;
    save_bytes(owner, filename, &bytes, language, "xlsx")
}

fn validate_xlsx(bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_REPORT_BYTES {
        return Err("XLSX data is empty or too large".into());
    }
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "Invalid XLSX archive")?;
    if archive.len() > 512 {
        return Err("XLSX has too many parts".into());
    }
    let mut expanded = 0u64;
    let mut workbook = false;
    let mut sheet = false;
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|_| "Invalid XLSX part")?;
        expanded = expanded
            .checked_add(file.size())
            .ok_or("XLSX is too large")?;
        if expanded > 32 * 1024 * 1024 || file.name().to_ascii_lowercase().ends_with(".bin") {
            return Err("XLSX parts exceed limits or contain macros".into());
        }
        workbook |= file.name() == "xl/workbook.xml";
        sheet |= file.name() == "xl/worksheets/sheet1.xml";
    }
    let mut content_types = String::new();
    archive
        .by_name("[Content_Types].xml")
        .map_err(|_| "Missing XLSX content types")?
        .take(65537)
        .read_to_string(&mut content_types)
        .map_err(|_| "Invalid XLSX content types")?;
    if !workbook
        || !sheet
        || content_types.len() > 65536
        || !content_types.contains(XLSX_CONTENT_TYPE)
        || content_types.to_ascii_lowercase().contains("macroenabled")
    {
        return Err("Unsupported XLSX workbook".into());
    }
    Ok(())
}

#[cfg(windows)]
fn save_bytes(
    owner: isize,
    filename: &str,
    contents: &[u8],
    language: &str,
    extension_name: &str,
) -> Result<Option<String>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };

    let title = match language {
        "ja" => "統計表を保存",
        "en" => "Save statistics table",
        "ko" => "통계 표 저장",
        _ => "保存统计表",
    };
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    let filter: Vec<u16> = if extension_name == "xlsx" {
        "Excel (*.xlsx)\0*.xlsx\0\0"
    } else {
        "CSV (*.csv)\0*.csv\0\0"
    }
    .encode_utf16()
    .collect();
    let extension: Vec<u16> = format!("{extension_name}\0").encode_utf16().collect();
    let mut buffer = vec![0u16; 32768];
    let name: Vec<u16> = filename.encode_utf16().collect();
    buffer[..name.len()].copy_from_slice(&name);
    // The native dialog owns path selection and overwrite confirmation; the
    // webview can provide validated report bytes and a suggested basename, never a path.
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
    write_bytes(&target, contents, extension_name)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg(not(windows))]
fn save_bytes(
    _owner: isize,
    _filename: &str,
    _contents: &[u8],
    _language: &str,
    _extension: &str,
) -> Result<Option<String>, String> {
    Err("Report save dialog requires Windows".into())
}

#[cfg(test)]
fn write(target: &Path, contents: &str) -> Result<(), String> {
    write_bytes(target, contents.as_bytes(), "csv")
}

fn write_bytes(target: &Path, contents: &[u8], extension_name: &str) -> Result<(), String> {
    if !target
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case(extension_name))
    {
        return Err("Unexpected report extension".into());
    }
    if let Ok(metadata) = std::fs::symlink_metadata(target) {
        if !metadata.is_file() || settings::is_link_or_reparse(&metadata) {
            return Err("Report destination is not a regular file".into());
        }
    }
    settings::atomic_write(target, contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn workbook(macros: bool) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut output);
            for (name, content) in [
                ("[Content_Types].xml", XLSX_CONTENT_TYPE),
                ("xl/workbook.xml", "<workbook/>"),
                ("xl/worksheets/sheet1.xml", "<worksheet/>"),
            ] {
                writer
                    .start_file(name, zip::write::FileOptions::default())
                    .unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            if macros {
                writer
                    .start_file("xl/vbaProject.bin", zip::write::FileOptions::default())
                    .unwrap();
                writer.write_all(b"macro").unwrap();
            }
            writer.finish().unwrap();
        }
        output.into_inner()
    }

    #[test]
    fn xlsx_rejects_wrong_types_names_and_macros() {
        assert!(validate_xlsx(b"a,b\r\n").is_err());
        assert!(validate_xlsx(&workbook(true)).is_err());
        assert!(validate_xlsx(&workbook(false)).is_ok());
        assert!(validate_name("../report.xlsx", "xlsx").is_err());
        assert!(validate_name("report.csv", "xlsx").is_err());
        assert!(save_xlsx(0, "report.xlsx", "not base64!", "zh").is_err());
        assert!(save_xlsx(
            0,
            "report.xlsx",
            &"A".repeat(MAX_REPORT_BYTES.div_ceil(3) * 4 + 4),
            "zh"
        )
        .is_err());
        let directory = std::env::temp_dir().join(format!("srvpro-xlsx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let bytes = workbook(false);
        assert!(write_bytes(&directory.join("report.csv"), &bytes, "xlsx").is_err());
        let target = directory.join("report.xlsx");
        write_bytes(&target, &bytes, "xlsx").unwrap();
        assert_eq!(std::fs::read(target).unwrap(), bytes);
        std::fs::remove_dir_all(directory).unwrap();
    }

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
