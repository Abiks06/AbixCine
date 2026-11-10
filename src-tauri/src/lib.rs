use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
struct LibFile {
    path: String,
    name: String,
    size: u64,
}

const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov", "ts", "m3u8"];
const MAX_DEPTH: u32 = 8;

fn walk(dir: &Path, out: &mut Vec<LibFile>, depth: u32) {
    if depth > MAX_DEPTH {
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
                walk(&path, out, depth + 1);
            }
            continue;
        }
        let is_video = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| VIDEO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
            .unwrap_or(false);
        if is_video {
            out.push(LibFile {
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
                size: entry.metadata().map(|m| m.len()).unwrap_or(0),
            });
        }
    }
}

/// Recursively list video files under the given folders. Runs off the UI thread.
#[tauri::command]
async fn scan_library(paths: Vec<String>) -> Result<Vec<LibFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for p in paths {
            walk(Path::new(&p), &mut out, 0);
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_library])
        .run(tauri::generate_context!())
        .expect("error while running AbixCine");
}
