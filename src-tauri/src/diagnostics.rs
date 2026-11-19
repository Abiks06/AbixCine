//! Startup diagnostics for machines we can't debug directly.
//!
//! A release build is a GUI-subsystem exe with `panic = "abort"`: if WebView2 is missing, the GPU
//! process crashes, or Tauri fails to build the window, the app just vanishes. This module:
//!
//! * appends a plain-text `startup.log` under `%LOCALAPPDATA%\app.abixcine.desktop\` (version,
//!   OS, WebView2 version, every startup failure and any panic with a backtrace),
//! * shows a native message box for fatal startup errors instead of exiting silently,
//! * keeps a "launch pending" marker that the frontend clears once it has rendered
//!   ([`app_ready`]). If a launch never got that far, the next one starts in *safe graphics
//!   mode* (WebView2 with GPU compositing off), which persists until the viewer turns it off.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Must match `identifier` in tauri.conf.json (Tauri's own app-data folder).
const APP_ID: &str = "app.abixcine.desktop";
const LOG_NAME: &str = "startup.log";
const PENDING_NAME: &str = "startup.pending";
const SAFE_NAME: &str = "safe-graphics";
const MAX_LOG_BYTES: u64 = 256 * 1024;

/// Base WebView2 arguments (also `additionalBrowserArgs` in tauri.conf.json, overridden at
/// startup). Autoplay with sound is allowed: pressing Play in the app is the gesture, and the
/// stream should never start muted. Every webview sharing the data folder must use identical
/// arguments (WebView2 runs one browser per folder), so the main window and sniff windows both
/// read [`browser_args`].
pub const BASE_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
const SAFE_GPU_ARGS: &str = "--disable-gpu --disable-gpu-compositing";

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupInfo {
    /// Running with GPU compositing disabled.
    pub safe_mode: bool,
    /// Safe mode was switched on this launch because the previous one never finished starting.
    pub safe_mode_new: bool,
    pub log_path: Option<String>,
}

static INFO: OnceLock<StartupInfo> = OnceLock::new();
static ARGS: OnceLock<String> = OnceLock::new();

fn dir() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))?;
    let d = base.join(APP_ID);
    std::fs::create_dir_all(&d).ok()?;
    Some(d)
}

pub fn log_path() -> Option<PathBuf> {
    dir().map(|d| d.join(LOG_NAME))
}

/// `2026-11-19 13:44:52Z` from the system clock, without a date crate.
fn stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Append one line to startup.log. Never fails loudly: diagnostics must not cause a crash.
pub fn log(msg: impl AsRef<str>) {
    let Some(path) = log_path() else { return };
    if std::fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.old"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] {}", stamp(), msg.as_ref());
    }
}

/// Decide safe mode from the marker files: pure so it can be tested.
fn decide_safe_mode(dir: &Path, forced: bool) -> (bool, bool) {
    let safe_flag = dir.join(SAFE_NAME);
    let pending = dir.join(PENDING_NAME);
    let already = safe_flag.exists();
    // Dev builds get killed mid-start all the time (Ctrl-C, hot restarts): only honour --safe-mode there.
    let previous_failed = pending.exists() && !cfg!(debug_assertions);
    let new = !already && (previous_failed || forced);
    if new && previous_failed {
        let _ = std::fs::write(&safe_flag, b"previous launch did not finish starting\n");
    }
    let _ = std::fs::write(&pending, std::process::id().to_string());
    (already || new, new)
}

/// Call first thing in `run()`: panic hook, header line, safe-mode decision.
pub fn init() -> &'static StartupInfo {
    INFO.get_or_init(|| {
        install_panic_hook();
        let forced = std::env::args().any(|a| a == "--safe-mode") || std::env::var_os("ABIXCINE_SAFE_MODE").is_some();
        let (safe_mode, safe_mode_new) = match dir() {
            Some(d) => decide_safe_mode(&d, forced),
            None => (forced, forced),
        };
        log(format!(
            "start v{} {}-{} pid={} safe_mode={}{}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::process::id(),
            safe_mode,
            if safe_mode_new { " (enabled after an unfinished launch)" } else { "" },
        ));
        StartupInfo { safe_mode, safe_mode_new, log_path: log_path().map(|p| p.display().to_string()) }
    })
}

/// WebView2 arguments for every webview this process creates.
pub fn browser_args() -> &'static str {
    ARGS.get_or_init(|| {
        if INFO.get().is_some_and(|i| i.safe_mode) {
            format!("{BASE_BROWSER_ARGS} {SAFE_GPU_ARGS}")
        } else {
            BASE_BROWSER_ARGS.to_string()
        }
    })
}

fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        log(format!("PANIC {info}\n{bt}"));
        prev(info);
    }));
}

/// A fatal startup error: log it, tell the viewer where the log is, exit non-zero.
pub fn fatal(title: &str, body: &str) -> ! {
    log(format!("FATAL {title}: {body}"));
    let where_ = log_path().map(|p| format!("\n\nDetails were saved to:\n{}", p.display())).unwrap_or_default();
    message_box(title, &format!("{body}{where_}"));
    std::process::exit(1);
}

#[cfg(windows)]
fn message_box(title: &str, body: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (t, b) = (w(title), w(body));
    unsafe {
        MessageBoxW(None, PCWSTR(b.as_ptr()), PCWSTR(t.as_ptr()), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
fn message_box(title: &str, body: &str) {
    eprintln!("{title}: {body}");
}

/// Refuse to start without WebView2 (portable copies, broken installs) with a clear way out.
pub fn require_webview() {
    match tauri::webview_version() {
        Ok(v) => log(format!("webview {v}")),
        Err(e) => {
            #[cfg(windows)]
            open_url("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
            fatal(
                "AbixCine can't start",
                &format!(
                    "The Microsoft Edge WebView2 Runtime is missing or broken ({e}).\n\n\
                     A download page has been opened — install the Evergreen runtime, then start AbixCine again."
                ),
            );
        }
    }
}

#[cfg(windows)]
fn open_url(url: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (op, u) = (w("open"), w(url));
    unsafe {
        ShellExecuteW(None, PCWSTR(op.as_ptr()), PCWSTR(u.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
    }
}

/// The frontend rendered: this launch succeeded, so the next one needn't fall back.
#[tauri::command]
pub fn app_ready() -> StartupInfo {
    if let Some(d) = dir() {
        let _ = std::fs::remove_file(d.join(PENDING_NAME));
    }
    let info = INFO.get().cloned().unwrap_or(StartupInfo { safe_mode: false, safe_mode_new: false, log_path: None });
    log(format!("ready safe_mode={}", info.safe_mode));
    info
}

/// Leave safe graphics mode from the next launch on.
#[tauri::command]
pub fn reset_safe_mode() {
    if let Some(d) = dir() {
        let _ = std::fs::remove_file(d.join(SAFE_NAME));
    }
    log("safe graphics mode turned off for the next launch");
}

/// Renderer-side errors worth keeping (uncaught errors before/after first render).
#[tauri::command]
pub fn log_frontend_error(message: String) {
    log(format!("frontend {}", message.chars().take(4000).collect::<String>()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("abx-diag-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn clean_launch_is_not_safe_mode_and_leaves_marker() {
        let d = temp_dir("clean");
        assert_eq!(decide_safe_mode(&d, false), (false, false));
        assert!(d.join(PENDING_NAME).exists());
    }

    #[test]
    #[cfg_attr(debug_assertions, ignore = "auto safe mode is release-only")]
    fn unfinished_launch_turns_on_persistent_safe_mode() {
        let d = temp_dir("crash");
        decide_safe_mode(&d, false); // launch 1 never calls app_ready
        assert_eq!(decide_safe_mode(&d, false), (true, true));
        std::fs::remove_file(d.join(PENDING_NAME)).unwrap(); // launch 2 got ready
        assert_eq!(decide_safe_mode(&d, false), (true, false)); // stays on
        std::fs::remove_file(d.join(SAFE_NAME)).unwrap(); // viewer turned it off
        std::fs::remove_file(d.join(PENDING_NAME)).unwrap();
        assert_eq!(decide_safe_mode(&d, false), (false, false));
    }

    #[test]
    fn forced_safe_mode_does_not_persist() {
        let d = temp_dir("forced");
        assert_eq!(decide_safe_mode(&d, true), (true, true));
        assert!(!d.join(SAFE_NAME).exists());
    }

    #[test]
    fn stamp_is_iso_like() {
        let s = stamp();
        assert_eq!(s.len(), 20, "{s}");
        assert!(s.ends_with('Z'));
    }
}
