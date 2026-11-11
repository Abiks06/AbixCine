use serde::Serialize;
mod shield;
mod stream;

use std::path::Path;
use tauri::Manager;

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

fn ext_in(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| list.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn walk(dir: &Path, out: &mut Vec<LibFile>, depth: u32) {
    if depth > MAX_DEPTH {
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
                walk(&path, out, depth + 1);
            }
            continue;
        }
        if ext_in(&path, SUB_EXTS) {
            subs.push(path);
        } else if ext_in(&path, VIDEO_EXTS) {
            videos.push(LibFile {
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                path: path.to_string_lossy().into_owned(),
                size: entry.metadata().map(|m| m.len()).unwrap_or(0),
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
                                    let r = shield::sniff_media(h, u.clone(), Some(12_000)).await.ok().flatten();
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
                        let r = shield::sniff_media(h.clone(), u.to_string(), Some(16_000)).await;
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
                        if let Ok(Some(s)) = shield::sniff_media(h.clone(), u, Some(16_000)).await {
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
        .invoke_handler(tauri::generate_handler![scan_library, stream::http_fetch, shield::sniff_media, shield::shield_stats])
        .run(tauri::generate_context!())
        .expect("error while running AbixCine");
}
