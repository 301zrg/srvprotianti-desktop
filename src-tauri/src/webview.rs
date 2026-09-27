use std::os::windows::process::CommandExt;
use std::process::Command;

const NO_WINDOW: u32 = 0x0800_0000;
const DOWNLOAD_PAGE: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";
const RUNTIME_ID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(window: isize, text: *const u16, caption: *const u16, style: u32) -> i32;
}

fn installed_version(output: &str) -> bool {
    output.lines().any(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        fields.len() == 3
            && fields[0].eq_ignore_ascii_case("pv")
            && fields[1].eq_ignore_ascii_case("REG_SZ")
            && fields[2]
                .split('.')
                .map(str::parse::<u32>)
                .collect::<Result<Vec<_>, _>>()
                .is_ok_and(|parts| parts.len() == 4 && parts.iter().any(|part| *part > 0))
    })
}

fn registry_has_runtime(key: &str) -> bool {
    Command::new("reg.exe")
        .args(["query", key, "/v", "pv"])
        .creation_flags(NO_WINDOW)
        .output()
        .ok()
        .is_some_and(|result| {
            result.status.success() && installed_version(&String::from_utf8_lossy(&result.stdout))
        })
}

pub fn runtime_ready() -> bool {
    let machine = format!(
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{RUNTIME_ID}"
    );
    let user = format!("HKEY_CURRENT_USER\\Software\\Microsoft\\EdgeUpdate\\Clients\\{RUNTIME_ID}");
    if registry_has_runtime(&machine) || registry_has_runtime(&user) {
        return true;
    }

    let message = "未检测到 Microsoft Edge WebView2 Runtime，桌面助手无法打开。\n\n选择“是”打开微软官方下载页面。安装完成后请重新启动本程序。\n\nMicrosoft Edge WebView2 Runtime was not found. Choose Yes to open Microsoft's download page, then restart the app after installation.";
    let title = "706 天梯助手 · WebView2";
    let wide_message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    let wide_title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    // MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND. This runs before Tauri creates its webview.
    let answer = unsafe { MessageBoxW(0, wide_message.as_ptr(), wide_title.as_ptr(), 0x10034) };
    if answer == 6 {
        let _ = open::that(DOWNLOAD_PAGE);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_version_must_be_nonzero() {
        assert!(installed_version("    pv    REG_SZ    153.0.4234.48\r\n"));
        assert!(!installed_version("    pv    REG_SZ    0.0.0.0\r\n"));
        assert!(!installed_version("    pv    REG_SZ    broken\r\n"));
    }
}
