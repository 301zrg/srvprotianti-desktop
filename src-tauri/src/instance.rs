use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::io;
use std::path::Path;
use std::ptr;
use std::thread;
use std::time::Duration;

const ERROR_ALREADY_EXISTS: i32 = 183;

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attributes: *const c_void, initial_owner: i32, name: *const u16) -> isize;
    fn CloseHandle(handle: isize) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn FindWindowW(class_name: *const u16, window_name: *const u16) -> isize;
    fn ShowWindow(window: isize, command: i32) -> i32;
    fn SetForegroundWindow(window: isize) -> i32;
}

pub struct InstanceGuard(isize);

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn scope(root: &Path) -> (String, String) {
    let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let key = canonical.to_string_lossy().to_lowercase();
    let hash = format!("{:x}", Sha256::digest(key.as_bytes()));
    (
        format!("Local\\org.srvprotianti.desktop.{hash}"),
        format!("706 天梯助手 [{}]", &hash[..16]),
    )
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn focus_existing(title: &str) {
    let title = wide(title);
    // The first process may still be creating its webview window.
    for _ in 0..20 {
        let window = unsafe { FindWindowW(ptr::null(), title.as_ptr()) };
        if window != 0 {
            unsafe {
                ShowWindow(window, 9); // SW_RESTORE
                SetForegroundWindow(window);
            }
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

pub fn acquire(root: &Path) -> Result<Option<(InstanceGuard, String)>, String> {
    let (name, title) = scope(root);
    let name = wide(&name);
    let handle = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
    let last_error = io::Error::last_os_error();
    if handle == 0 {
        return Err(format!("Cannot create game-directory lock: {last_error}"));
    }
    if last_error.raw_os_error() == Some(ERROR_ALREADY_EXISTS) {
        unsafe { CloseHandle(handle) };
        focus_existing(&title);
        return Ok(None);
    }
    Ok(Some((InstanceGuard(handle), title)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_game_directory_has_its_own_instance_scope() {
        let root = std::env::temp_dir();
        let first = scope(&root.join("game-a"));
        let second = scope(&root.join("game-b"));
        assert_ne!(first.0, second.0);
        assert_ne!(first.1, second.1);
        assert_eq!(first, scope(&root.join("game-a")));
    }
}
