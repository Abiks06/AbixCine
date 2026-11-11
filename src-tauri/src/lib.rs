use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::Manager;

mod mpv;

#[derive(Serialize)]
struct LibFile {
    path: String,
    name: String,
    size: u64,
}

const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov", "ts", "m3u8", "avi", "wmv", "flv", "mpg", "mpeg", "m2ts", "mts", "vob", "ogv", "rmvb", "3gp"];
const MAX_DEPTH: u32 = 8;
/// Stop listing past this many files; a library bigger than this is almost certainly a wrong folder.
const MAX_FILES: usize = 50_000;
/// `.ts` is also TypeScript: only count it as video (MPEG-TS) when it's big enough to be one.
const MIN_TS_BYTES: u64 = 1_000_000;

fn walk(dir: &Path, out: &mut Vec<LibFile>, seen: &mut HashSet<PathBuf>, depth: u32) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            // Skip hidden and system folders like .git or $RECYCLE.BIN.
            let hidden = path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.') || n.starts_with('$'))
                .unwrap_or(false);
            if !hidden {
                walk(&path, out, seen, depth + 1);
            }
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !VIDEO_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if ext == "ts" && size < MIN_TS_BYTES {
            continue;
        }
        // Overlapping folders (D:\Media and D:\Media\Anime) must not list a file twice.
        let canon = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen.insert(canon) {
            continue;
        }
        out.push(LibFile {
            name: path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            size,
        });
    }
}

#[derive(Serialize)]
struct ScanResult {
    files: Vec<LibFile>,
    /// Folders that couldn't be read (unplugged drive, no permission), so the UI can say so.
    errors: Vec<ScanError>,
}

#[derive(Serialize)]
struct ScanError {
    path: String,
    message: String,
}

/// Recursively list video files under the given folders. Runs off the UI thread.
///
/// The asset protocol starts with an empty scope (see tauri.conf.json); only folders the user
/// chose as library folders are opened to it here, so the webview can never read arbitrary files.
#[tauri::command]
async fn scan_library(app: tauri::AppHandle, paths: Vec<String>) -> Result<ScanResult, String> {
    let scope = app.asset_protocol_scope();
    let mpv_state = app.state::<mpv::MpvState>();
    let mut roots = Vec::new();
    let mut errors = Vec::new();
    for p in paths {
        let dir = PathBuf::from(&p);
        match std::fs::metadata(&dir) {
            Ok(m) if m.is_dir() => {
                scope.allow_directory(&dir, true).map_err(|e| e.to_string())?;
                roots.push(dir);
            }
            Ok(_) => errors.push(ScanError { path: p, message: "not a folder".into() }),
            Err(e) => errors.push(ScanError { path: p, message: e.to_string() }),
        }
    }
    // mpv may only open files inside the folders the user chose (see mpv.rs).
    mpv_state.set_roots(roots.clone());
    let files = tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for r in roots {
            walk(&r, &mut out, &mut seen, 0);
        }
        out
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(ScanResult { files, errors })
}

/// True when this build can install updates: it was built with an updater public key (release
/// builds from CI). Local dev builds have none, so the UI only offers to open the download page.
#[tauri::command]
fn updater_ready(app: tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|k| k.as_str())
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(mpv::MpvState::default())
        .setup(|app| {
            if let Some(main) = app.get_webview_window("main") {
                mpv::keep_taskbar_button(&main);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                mpv::on_main_event(window.app_handle(), event);
            }
        })
        .invoke_handler(tauri::generate_handler![
            scan_library,
            updater_ready,
            mpv::mpv_probe,
            mpv::mpv_start,
            mpv::mpv_command,
            mpv::mpv_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running AbixCine");
}
