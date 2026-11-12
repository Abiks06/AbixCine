use serde::Serialize;
mod shield;
mod stream;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

static LIBRARY_ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
static MEDIA_PREPARE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
struct LibFile {
    path: String,
    name: String,
    size: u64,
    /// Sidecar subtitle files next to the video whose name starts with the video's
    /// ("Movie.srt", "Movie.en.srt", "Movie.English.forced.vtt").
    subs: Vec<String>,
}

const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov", "ts", "m3u8"];
const SUB_EXTS: &[&str] = &["srt", "vtt"];
const MAX_DEPTH: u32 = 8;
/// Stop listing past this many files; a library bigger than this is almost certainly a wrong folder.
const MAX_FILES: usize = 50_000;
/// `.ts` is also TypeScript: only count it as video (MPEG-TS) when it's big enough to be one.
const MIN_TS_BYTES: u64 = 1_000_000;

fn ext_in(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| list.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn walk(dir: &Path, out: &mut Vec<LibFile>, seen: &mut HashSet<PathBuf>, depth: u32) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut videos: Vec<LibFile> = Vec::new();
    let mut subs: Vec<std::path::PathBuf> = Vec::new();
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
        if ext_in(&path, SUB_EXTS) {
            subs.push(path);
        } else if ext_in(&path, VIDEO_EXTS) {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if ext == "ts" && size < MIN_TS_BYTES {
                continue;
            }
            // Overlapping folders (D:\Media and D:\Media\Anime) must not list a file twice.
            let canon = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !seen.insert(canon) {
                continue;
            }
            videos.push(LibFile {
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
                size,
                subs: Vec::new(),
            });
        }
    }
    // A lone video in a folder takes every subtitle there (common for "Movie (2010)/" folders).
    let lone = videos.len() == 1;
    for v in videos.iter_mut() {
        let stem = v.name.to_lowercase();
        for s in &subs {
            let sub_stem = s
                .file_stem()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            // "Show - 1.en.srt" belongs to "Show - 1", but "Show - 10.srt" does not.
            let belongs = sub_stem == stem || sub_stem.starts_with(&format!("{stem}."));
            if lone || belongs {
                v.subs.push(s.to_string_lossy().into_owned());
            }
        }
    }
    out.extend(videos);
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
    let mut roots = Vec::new();
    let mut allowed_roots = Vec::new();
    let mut errors = Vec::new();
    for p in paths {
        let dir = PathBuf::from(&p);
        match std::fs::metadata(&dir) {
            Ok(m) if m.is_dir() => {
                let canonical = match std::fs::canonicalize(&dir) {
                    Ok(c) => c,
                    Err(e) => {
                        errors.push(ScanError { path: p, message: e.to_string() });
                        continue;
                    }
                };
                if let Err(e) = scope.allow_directory(&canonical, true) {
                    errors.push(ScanError { path: p, message: e.to_string() });
                    continue;
                }
                allowed_roots.push(canonical.clone());
                roots.push(canonical);
            }
            Ok(_) => errors.push(ScanError { path: p, message: "not a folder".into() }),
            Err(e) => errors.push(ScanError { path: p, message: e.to_string() }),
        }
    }
    *LIBRARY_ROOTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|e| e.to_string())? = allowed_roots;
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

fn ffmpeg_tool(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("ffmpeg")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("ffmpeg")
    };
    let path = dir.join(name);
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("Bundled media tool is missing: {name}"))
    }
}

fn media_needs_audio_conversion(path: &Path, probe: &serde_json::Value) -> bool {
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let audio_codecs: Vec<&str> = probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("audio"))
        .filter_map(|s| s.get("codec_name").and_then(serde_json::Value::as_str))
        .collect();
    match extension.as_str() {
        "mp4" | "m4v" | "mov" => audio_codecs.iter().any(|c| !["aac", "mp3"].contains(c)),
        "webm" => audio_codecs.iter().any(|c| !["opus", "vorbis"].contains(c)),
        _ => true,
    }
}

fn compatible_subtitle_indices(probe: &serde_json::Value) -> Vec<u64> {
    probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("subtitle"))
        .filter(|s| {
            s.get("codec_name")
                .and_then(serde_json::Value::as_str)
                .map(|codec| ["subrip", "ass", "ssa", "webvtt", "mov_text"].contains(&codec))
                .unwrap_or(false)
        })
        .filter_map(|s| s.get("index").and_then(serde_json::Value::as_u64))
        .collect()
}

#[cfg(test)]
mod local_media_tests {
    use super::*;

    fn probe(streams: &[(&str, &str)]) -> serde_json::Value {
        serde_json::json!({
            "streams": streams.iter().enumerate().map(|(index, (kind, codec))| {
                serde_json::json!({"index": index, "codec_type": kind, "codec_name": codec})
            }).collect::<Vec<_>>()
        })
    }

    #[test]
    fn converts_audio_codecs_not_supported_by_the_webview_container() {
        assert!(media_needs_audio_conversion(
            Path::new("Film.mp4"),
            &probe(&[("video", "h264"), ("audio", "ac3")]),
        ));
        assert!(media_needs_audio_conversion(
            Path::new("Film.mkv"),
            &probe(&[("video", "h264"), ("audio", "aac")]),
        ));
    }

    #[test]
    fn leaves_supported_mp4_and_webm_audio_alone() {
        assert!(!media_needs_audio_conversion(
            Path::new("Film.mp4"),
            &probe(&[("video", "h264"), ("audio", "aac")]),
        ));
        assert!(!media_needs_audio_conversion(
            Path::new("Clip.webm"),
            &probe(&[("video", "vp9"), ("audio", "opus")]),
        ));
    }

    #[test]
    fn keeps_text_subtitle_streams_and_skips_bitmap_subtitles() {
        let streams = serde_json::json!({
            "streams": [
                {"index": 2, "codec_type": "subtitle", "codec_name": "subrip"},
                {"index": 3, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle"},
                {"index": 4, "codec_type": "subtitle", "codec_name": "ass"}
            ]
        });
        assert_eq!(compatible_subtitle_indices(&streams), vec![2, 4]);
    }
}

fn prepare_local_media_file(
    path: PathBuf,
    cache_dir: PathBuf,
    ffmpeg: Result<PathBuf, String>,
    ffprobe: PathBuf,
) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let allowed_roots = LIBRARY_ROOTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|e| e.to_string())?;
    if !canonical.is_file() || !allowed_roots.iter().any(|root| canonical.starts_with(root)) {
        return Err("The requested file is not inside a selected library folder".into());
    }
    drop(allowed_roots);
    let extension = canonical.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !ext_in(&canonical, VIDEO_EXTS) || extension == "m3u8" {
        return Err("The requested file is not a supported local video".into());
    }

    let probe = std::process::Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "stream=index,codec_type,codec_name", "-of", "json"])
        .arg(&canonical)
        .output()
        .map_err(|e| format!("Could not inspect local media: {e}"))?;
    if !probe.status.success() {
        return Err(format!("Could not inspect local media: {}", String::from_utf8_lossy(&probe.stderr)));
    }
    let probe: serde_json::Value = serde_json::from_slice(&probe.stdout).map_err(|e| e.to_string())?;
    if !media_needs_audio_conversion(&canonical, &probe) {
        return Ok(canonical.to_string_lossy().into_owned());
    }
    let ffmpeg = ffmpeg?;
    let subtitle_indices = compatible_subtitle_indices(&probe);

    let metadata = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
        .unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    canonical.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    modified.hash(&mut hasher);
    "abixcine-local-mp4-aac-v1".hash(&mut hasher);
    let output = cache_dir.join(format!("{:016x}.mp4", hasher.finish()));
    if output.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(output.to_string_lossy().into_owned());
    }

    let partial = output.with_extension("partial.mp4");
    let _ = std::fs::remove_file(&partial);
    let mut command = std::process::Command::new(ffmpeg);
    command
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(&canonical)
        .args(["-map", "0:v:0", "-map", "0:a?"]);
    for index in &subtitle_indices {
        command.arg("-map").arg(format!("0:{index}"));
    }
    command.args(["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-map_metadata", "0", "-dn"]);
    if !subtitle_indices.is_empty() {
        command.args(["-c:s", "mov_text"]);
    }
    let result = command
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(&partial)
        .output()
        .map_err(|e| format!("Could not convert local audio: {e}"))?;
    if !result.status.success() || !partial.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        let _ = std::fs::remove_file(&partial);
        let detail = String::from_utf8_lossy(&result.stderr);
        let detail = detail.chars().rev().take(900).collect::<String>().chars().rev().collect::<String>();
        return Err(format!("Could not convert local audio: {detail}"));
    }
    std::fs::rename(&partial, &output).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        e.to_string()
    })?;
    Ok(output.to_string_lossy().into_owned())
}

#[tauri::command]
async fn prepare_local_media(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("local-media");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let scope = app.asset_protocol_scope();
    scope.allow_directory(&cache_dir, true).map_err(|e| e.to_string())?;
    let ffmpeg = ffmpeg_tool(&app, "ffmpeg.exe");
    let ffprobe = ffmpeg_tool(&app, "ffprobe.exe")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = MEDIA_PREPARE_LOCK.lock().map_err(|e| e.to_string())?;
        prepare_local_media_file(path, cache_dir, ffmpeg, ffprobe)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(debug_assertions)]
fn urlencoding_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // A second launch (e.g. from the Start menu while it's open) focuses the existing window.
    // The debug sniff harness runs alongside an installed copy, so it skips this.
    if std::env::var_os("ABX_SNIFF_TEST").is_none() && std::env::var_os("ABX_JS_TEST").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Direct streams play through this scheme (see stream.rs).
        .register_asynchronous_uri_scheme_protocol("abxs", |_ctx, req, responder| {
            tauri::async_runtime::spawn(async move { responder.respond(stream::handle(req).await) });
        })
        .setup(|app| {
            // Ad, tracker and pop-up shield on the main window, covering every embedded frame.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.with_webview(|pw| shield::install(&pw, true, None));
            }
            // Debug harness: ABX_JS_TEST="<js expression returning a promise of a string>" runs in the
            // main window once the app has loaded; the result is written to the URL hash and printed.
            #[cfg(debug_assertions)]
            if let Ok(js) = std::env::var("ABX_JS_TEST") {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                    if let Some(w) = h.get_webview_window("main") {
                        let wrapped = format!("Promise.resolve().then(async () => {{ return String(await ({js})); }}).catch(e => 'ERR ' + (e && e.stack || e)).then(r => history.replaceState(null, '', '#RESULT=' + encodeURIComponent(r)))");
                        // Re-run until the page is up and the hooks exist (dev server may still be compiling).
                        let wrapped = format!("if (window.__abx && !window.__abxRan) {{ window.__abxRan = 1; {wrapped}; }}");
                        for i in 0..120 {
                            if i % 3 == 0 {
                                let _ = w.eval(&wrapped);
                            }
                            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                            if std::env::var_os("ABX_JS_VERBOSE").is_some() {
                                println!("JSURL {:?}", w.url().map(|u| u.to_string()));
                            }
                            if let Some(f) = w.url().ok().and_then(|u| u.fragment().map(|f| f.to_string())) {
                                if let Some(r) = f.strip_prefix("RESULT=") {
                                    println!("JSRESULT {}", urlencoding_decode(r));
                                    break;
                                }
                            }
                        }
                    }
                    h.exit(0);
                });
            }
            // Debug harness: ABX_SNIFF_TEST="url|url" sniffs each URL, prints the result, exits.
            #[cfg(debug_assertions)]
            if let Ok(list) = std::env::var("ABX_SNIFF_TEST") {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // ABX_SNIFF_PARALLEL: run them all at once, like the app's race does.
                    if std::env::var_os("ABX_SNIFF_PARALLEL").is_some() {
                        let t = std::time::Instant::now();
                        let jobs: Vec<_> = list
                            .split('|')
                            .map(|u| {
                                let (h, u) = (h.clone(), u.to_string());
                                tauri::async_runtime::spawn(async move {
                                    let r = shield::sniff_media(h, u.clone(), Some(12_000), None).await.ok().flatten();
                                    (u, r.is_some())
                                })
                            })
                            .collect();
                        for j in jobs {
                            if let Ok((u, ok)) = j.await {
                                println!("SNIFF {u} found={ok} at {}ms", t.elapsed().as_millis());
                            }
                        }
                        h.exit(0);
                        return;
                    }
                    for u in list.split('|') {
                        let t = std::time::Instant::now();
                        let r = shield::sniff_media(h.clone(), u.to_string(), Some(16_000), None).await;
                        let found = r.ok().flatten();
                        println!("SNIFF {} {}ms {:?}", u, t.elapsed().as_millis(), found.as_ref().map(|s| (s.kind, &s.url[..s.url.len().min(80)])));
                        // Push the stream through the real proxy: playlist, then one nested hop, then bytes.
                        if let Some(s) = found {
                            let mut next = stream::proxy_path(&s.url, &s.headers);
                            for hop in 0..3 {
                                let req = tauri::http::Request::builder().uri(format!("http://abxs.localhost{next}")).body(Vec::new()).unwrap();
                                let res = stream::handle(req).await;
                                let body = res.body();
                                let text = String::from_utf8_lossy(&body[..body.len().min(4000)]).to_string();
                                println!("  hop{hop} status={} bytes={} head={:?}", res.status(), body.len(), &text.chars().take(40).collect::<String>());
                                if std::env::var_os("ABX_DUMP").is_some() && text.starts_with("#EXTM3U") {
                                    for l in text.lines().take(14) { println!("    | {}", &l[..l.len().min(150)]); }
                                }
                                let full = String::from_utf8_lossy(body).to_string();
                                match full.lines().find(|l| l.starts_with("http://abxs.localhost/p?")) {
                                    Some(l) => next = l.trim_start_matches("http://abxs.localhost").to_string(),
                                    None => break,
                                }
                            }
                        }
                    }
                    // The webview itself must be able to read the proxy scheme (that's what hls.js does).
                    if let (Some(w), Ok(u)) = (h.get_webview_window("main"), std::env::var("ABX_WEBVIEW_TEST")) {
                        if let Ok(Some(s)) = shield::sniff_media(h.clone(), u, Some(16_000), None).await {
                            let p = stream::proxy_path(&s.url, &s.headers);
                            let js = format!("fetch('http://abxs.localhost{p}').then(r=>r.text().then(t=>history.replaceState(null,'','#WV-'+r.status+'-'+t.length+'-'+encodeURIComponent(t.slice(0,7))))).catch(e=>history.replaceState(null,'','#WVERR-'+encodeURIComponent(String(e))))");
                            let _ = w.eval(&js);
                            tokio::time::sleep(std::time::Duration::from_secs(6)).await;
                            println!("SNIFF webview {:?}", w.url().map(|u| u.fragment().map(|f| f.to_string())));
                        }
                    }
                    println!("SNIFF blocked={}", shield::shield_stats());
                    h.exit(0);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![scan_library, prepare_local_media, stream::http_fetch, shield::sniff_media, shield::cancel_sniff, shield::shield_stats])
        .run(tauri::generate_context!())
        .expect("error while running AbixCine");
}
