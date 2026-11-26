use serde::Serialize;
mod diagnostics;
mod downloads;
mod gateway;
mod shield;
mod stream;
mod torrent;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

static LIBRARY_ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
static DOWNLOADS_ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
static MEDIA_PREPARE_LOCK: Mutex<()> = Mutex::new(());
static ACTIVE_MEDIA_PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
static LOCAL_PREPARE_GEN: AtomicU64 = AtomicU64::new(0);
static LOCAL_PREPARE_PID: OnceLock<Mutex<Option<(u64, u32)>>> = OnceLock::new();
const LOCAL_MEDIA_CACHE_CAP_BYTES: u64 = 8 * 1024 * 1024 * 1024;

fn active_media_pids() -> &'static Mutex<HashSet<u32>> {
    ACTIVE_MEDIA_PIDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn local_prepare_pid_slot() -> &'static Mutex<Option<(u64, u32)>> {
    LOCAL_PREPARE_PID.get_or_init(|| Mutex::new(None))
}

fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                let _ = TerminateProcess(handle, 1);
                let _ = CloseHandle(handle);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

#[tauri::command]
fn cancel_local_prepare() {
    let gen = LOCAL_PREPARE_GEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let pid_opt = {
        let mut slot = local_prepare_pid_slot().lock().unwrap_or_else(|e| e.into_inner());
        match *slot {
            Some((owner_gen, pid)) if owner_gen < gen => {
                *slot = None;
                Some(pid)
            }
            _ => None,
        }
    };
    if let Some(pid) = pid_opt {
        terminate_pid(pid);
    }
}

pub(crate) struct ActivePidGuard(u32);

impl ActivePidGuard {
    pub(crate) fn new(pid: u32) -> Self {
        let mut set = active_media_pids().lock().unwrap_or_else(|e| e.into_inner());
        set.insert(pid);
        Self(pid)
    }
}

impl Drop for ActivePidGuard {
    fn drop(&mut self) {
        let mut set = active_media_pids().lock().unwrap_or_else(|e| e.into_inner());
        set.remove(&self.0);
    }
}

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
const SUB_EXTS: &[&str] = &["srt", "vtt", "ass", "ssa"];
const SUB_DIRS: &[&str] = &["subs", "subtitles", "sub"];
const MAX_DEPTH: u32 = 8;
/// Stop listing past this many files; a library bigger than this is almost certainly a wrong folder.
const MAX_FILES: usize = 50_000;
/// `.ts` is also TypeScript: only count it as video (MPEG-TS) when it's big enough to be one.
const MIN_TS_BYTES: u64 = 1_000_000;
const MAX_EXTRACTED_SUB_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SAVED_SUB_BYTES: usize = 10 * 1024 * 1024;

fn ext_in(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| list.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_hidden_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.') || n.starts_with('$'))
        .unwrap_or(false)
}

fn is_sub_folder_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| SUB_DIRS.contains(&n.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_video_file_entry(path: &Path, entry: &std::fs::DirEntry) -> Option<u64> {
    if !ext_in(path, VIDEO_EXTS) {
        return None;
    }
    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "ts" && size < MIN_TS_BYTES {
        return None;
    }
    Some(size)
}

fn is_sub_tag_token(tok: &str) -> bool {
    matches!(
        tok,
        "en" | "eng" | "english"
            | "ja" | "jp" | "jpn" | "japanese"
            | "es" | "spa" | "spanish"
            | "fr" | "fre" | "fra" | "french"
            | "de" | "ger" | "deu" | "german"
            | "pt" | "por" | "portuguese" | "pob" | "br"
            | "it" | "ita" | "italian"
            | "ar" | "ara" | "arabic"
            | "zh" | "chi" | "zho" | "chinese" | "chs" | "cht"
            | "ko" | "kor" | "korean"
            | "ru" | "rus" | "russian"
            | "hi" | "hin" | "hindi"
            | "nl" | "dut" | "nld" | "dutch"
            | "pl" | "pol" | "polish"
            | "tr" | "tur" | "turkish"
            | "vi" | "vie" | "vietnamese"
            | "th" | "tha" | "thai"
            | "id" | "ind" | "indonesian"
            | "sv" | "swe" | "swedish"
            | "no" | "nor" | "norwegian"
            | "da" | "dan" | "danish"
            | "fi" | "fin" | "finnish"
            | "cs" | "ces" | "cze" | "czech"
            | "ro" | "ron" | "rum" | "romanian"
            | "el" | "ell" | "gre" | "greek"
            | "he" | "heb" | "hebrew"
            | "uk" | "ukr" | "ukrainian"
            | "forced" | "sdh" | "cc" | "signs" | "songs" | "honorifics" | "dialogue" | "full" | "default" | "us" | "gb" | "latam"
    )
}

/// Match a subtitle stem against a video stem (both lowercased).
/// `"show - 1.en"` and `"show - 1.forced"` match `"show - 1"`, while `"show - 10"` does not.
fn sidecar_matches_stem(sub_stem: &str, video_stem: &str) -> bool {
    if video_stem.is_empty() {
        return false;
    }
    let Some(rest) = sub_stem.strip_prefix(video_stem) else {
        return false;
    };
    if rest.is_empty() || rest.starts_with('.') {
        return true;
    }
    if rest.starts_with('_') || rest.starts_with('-') || rest.starts_with(' ') {
        let tokens: Vec<&str> = rest
            .split(|c: char| matches!(c, '.' | '_' | '-' | ' '))
            .filter(|t| !t.is_empty())
            .collect();
        return !tokens.is_empty() && tokens.iter().all(|t| is_sub_tag_token(t));
    }
    false
}

/// Collect subtitle files from a `subs`/`subtitles`/`sub` directory unless it holds video files
/// (e.g. an anime `Sub/` folder containing episodes). Also collects 1-level video-named folders.
fn is_sample_name(path: &Path) -> bool {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|s| s == "sample" || s.starts_with("sample") || s.ends_with("sample") || s.contains("-sample") || s.contains(".sample"))
}

fn collect_sub_folder(sub_dir: &Path) -> (Vec<PathBuf>, Vec<(String, Vec<PathBuf>)>) {
    let Ok(entries) = std::fs::read_dir(sub_dir) else {
        return (Vec::new(), Vec::new());
    };
    let mut direct_subs = Vec::new();
    let mut nested_dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if !is_hidden_name(&path) {
                nested_dirs.push(path);
            }
            continue;
        }
        // A folder holding real episodes (anime "Sub/" folders) is not a subtitle folder; a stray
        // sample clip doesn't make it one, though, and used to discard every subtitle in it.
        if is_video_file_entry(&path, &entry).is_some() && !is_sample_name(&path) {
            return (Vec::new(), Vec::new());
        }
        if ext_in(&path, SUB_EXTS) {
            direct_subs.push(path);
        }
    }
    let mut nested_subs = Vec::new();
    for nd in nested_dirs {
        let Some(name) = nd.file_name().and_then(|n| n.to_str()).map(|n| n.to_lowercase()) else {
            continue;
        };
        let Ok(nd_entries) = std::fs::read_dir(&nd) else { continue };
        let mut files = Vec::new();
        let mut has_video = false;
        for entry in nd_entries.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                continue;
            }
            if is_video_file_entry(&path, &entry).is_some() {
                has_video = true;
                break;
            }
            if ext_in(&path, SUB_EXTS) {
                files.push(path);
            }
        }
        if !has_video && !files.is_empty() {
            nested_subs.push((name, files));
        }
    }
    (direct_subs, nested_subs)
}

fn push_unique_sub(subs: &mut Vec<String>, path: &Path) {
    let s = path.to_string_lossy().into_owned();
    if !subs.contains(&s) {
        subs.push(s);
    }
}

fn attach_matching_subs(out_subs: &mut Vec<String>, candidates: &[PathBuf], video_stem: &str, lone: bool) {
    for s in candidates {
        let sub_stem = s
            .file_stem()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if lone || sidecar_matches_stem(&sub_stem, video_stem) {
            push_unique_sub(out_subs, s);
        }
    }
}

fn walk(dir: &Path, out: &mut Vec<LibFile>, seen: &mut HashSet<PathBuf>, depth: u32) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut videos: Vec<LibFile> = Vec::new();
    let mut subs: Vec<PathBuf> = Vec::new();
    let mut sub_dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        // The cap applies inside a folder too: one folder of 100k files used to blow straight past it.
        if out.len() + videos.len() >= MAX_FILES {
            break;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            // Skip hidden and system folders like .git or $RECYCLE.BIN.
            if !is_hidden_name(&path) {
                if is_sub_folder_name(&path) {
                    sub_dirs.push(path.clone());
                }
                walk(&path, out, seen, depth + 1);
            }
            continue;
        }
        if ext_in(&path, SUB_EXTS) {
            subs.push(path);
        } else if let Some(size) = is_video_file_entry(&path, &entry) {
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
    if videos.is_empty() {
        return;
    }
    let sub_folder_entries: Vec<_> = sub_dirs.iter().map(|d| collect_sub_folder(d)).collect();
    // A lone video in a folder takes every subtitle there (common for "Movie (2010)/" folders).
    let lone = videos.len() == 1;
    for v in videos.iter_mut() {
        let stem = v.name.to_lowercase();
        attach_matching_subs(&mut v.subs, &subs, &stem, lone);
        for (direct_subs, nested_subs) in &sub_folder_entries {
            attach_matching_subs(&mut v.subs, direct_subs, &stem, lone);
            for (folder_name, files) in nested_subs {
                if folder_name == &stem || sidecar_matches_stem(folder_name, &stem) {
                    for s in files {
                        push_unique_sub(&mut v.subs, s);
                    }
                }
            }
        }
        v.subs.sort();
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
async fn scan_library(
    app: tauri::AppHandle,
    paths: Vec<String>,
    register_roots: Option<bool>,
) -> Result<ScanResult, String> {
    let should_register = register_roots.unwrap_or(true);
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
    if should_register {
        *LIBRARY_ROOTS
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .map_err(|e| e.to_string())? = allowed_roots;
    }
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

fn platform_tool_name(name: &str) -> String {
    let base = name.strip_suffix(".exe").unwrap_or(name);
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn resolve_tool_in_dirs_and_path(
    bin_name: &str,
    bundle_dirs: &[PathBuf],
    path_env: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    for dir in bundle_dirs {
        let candidate = dir.join(bin_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Some(paths) = path_env {
        for dir in std::env::split_paths(paths) {
            let candidate = dir.join(bin_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn bundled_ffmpeg_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    if cfg!(debug_assertions) {
        vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("ffmpeg")]
    } else {
        match app.path().resource_dir() {
            Ok(res) => vec![res.join("ffmpeg"), res.join("resources").join("ffmpeg")],
            Err(_) => Vec::new(),
        }
    }
}

pub(crate) fn ffmpeg_tool(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let bin_name = platform_tool_name(name);
    let bundle_dirs = bundled_ffmpeg_dirs(app);
    let path_env = std::env::var_os("PATH");
    resolve_tool_in_dirs_and_path(&bin_name, &bundle_dirs, path_env.as_deref())
        .ok_or_else(|| format!("Bundled media tool is missing: {bin_name}"))
}

fn ffprobe_tool(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    ffmpeg_tool(app, "ffprobe")
}

pub(crate) fn background_command(program: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

pub(crate) fn run_background_output(cmd: &mut std::process::Command) -> std::io::Result<std::process::Output> {
    use std::process::Stdio;
    let child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let _guard = ActivePidGuard::new(child.id());
    child.wait_with_output()
}

pub(crate) fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    p
}

pub(crate) fn register_downloads_root(app: &tauri::AppHandle, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create downloads folder: {e}"))?;
    let canonical = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&canonical, true)
        .map_err(|e| e.to_string())?;
    let clean = strip_verbatim_prefix(canonical);
    let _ = app.asset_protocol_scope().allow_directory(&clean, true);
    *DOWNLOADS_ROOT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())? = Some(clean.clone());
    Ok(clean)
}

fn ensure_in_allowed_roots(path: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    let canonical = strip_verbatim_prefix(std::fs::canonicalize(path).map_err(|e| e.to_string())?);
    if !canonical.is_file()
        || !allowed_roots
            .iter()
            .any(|root| canonical.starts_with(strip_verbatim_prefix(root.clone())))
    {
        return Err("The requested file is not inside a selected library folder".into());
    }
    Ok(canonical)
}

fn all_allowed_roots() -> Result<Vec<PathBuf>, String> {
    let mut allowed_roots = LIBRARY_ROOTS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if let Some(dl_root) = DOWNLOADS_ROOT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
    {
        if !allowed_roots.contains(&dl_root) {
            allowed_roots.push(dl_root);
        }
    }
    Ok(allowed_roots)
}

fn ensure_in_library_roots(path: &Path) -> Result<PathBuf, String> {
    let allowed_roots = all_allowed_roots()?;
    ensure_in_allowed_roots(path, &allowed_roots)
}

const OSHASH_CHUNK_BYTES: usize = 64 * 1024;

/// Compute the standard OpenSubtitles 64-bit file hash:
/// `file_size + sum_u64_le(first 64 KiB) + sum_u64_le(last 64 KiB)` (wrapping 64-bit arithmetic),
/// formatted as 16 lowercase hex characters.
fn compute_oshash_from_path(canonical: &Path) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(canonical).map_err(|e| e.to_string())?;
    let file_size = file.metadata().map_err(|e| e.to_string())?.len();
    if file_size < OSHASH_CHUNK_BYTES as u64 {
        return Err("File is smaller than 64 KiB; cannot compute OpenSubtitles hash".into());
    }

    let sum_chunk = |buf: &[u8]| -> u64 {
        buf.chunks_exact(8).fold(0u64, |acc, chunk| {
            acc.wrapping_add(u64::from_le_bytes([
                chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7],
            ]))
        })
    };

    let mut buf = vec![0u8; OSHASH_CHUNK_BYTES];
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let head_sum = sum_chunk(&buf);

    file.seek(SeekFrom::Start(file_size - OSHASH_CHUNK_BYTES as u64))
        .map_err(|e| e.to_string())?;
    file.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let tail_sum = sum_chunk(&buf);

    let hash = file_size.wrapping_add(head_sum).wrapping_add(tail_sum);
    Ok(format!("{hash:016x}"))
}

#[cfg(test)]
fn compute_oshash_in_roots(path: &Path, allowed_roots: &[PathBuf]) -> Result<String, String> {
    let canonical = ensure_in_allowed_roots(path, allowed_roots)?;
    compute_oshash_from_path(&canonical)
}

#[derive(serde::Serialize)]
struct OsHashResult {
    hash: String,
    /// OpenSubtitles matches on hash *and* size; the size is free here (the hash is built from it).
    size: u64,
}

#[tauri::command]
async fn compute_oshash(path: String) -> Result<OsHashResult, String> {
    let path = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = ensure_in_library_roots(&path)?;
        let hash = compute_oshash_from_path(&canonical)?;
        let size = std::fs::metadata(&canonical).map_err(|e| e.to_string())?.len();
        Ok(OsHashResult { hash, size })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn is_text_sub_codec(codec: &str) -> bool {
    matches!(
        codec.trim().to_ascii_lowercase().as_str(),
        "subrip" | "srt" | "ass" | "ssa" | "webvtt" | "mov_text" | "text"
    )
}

fn has_multichannel_audio(probe: &serde_json::Value) -> bool {
    probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("audio"))
        .any(|s| s.get("channels").and_then(serde_json::Value::as_u64).is_some_and(|ch| ch > 2))
}

fn audio_downmix_filter(channels: Option<u64>) -> Option<&'static str> {
    if channels.unwrap_or(2) > 2 {
        Some("pan=stereo|FL=0.5*FL+0.707*FC+0.35*BL+0.35*SL+0.35*LFE|FR=0.5*FR+0.707*FC+0.35*BR+0.35*SR+0.35*LFE")
    } else {
        None
    }
}

fn media_needs_audio_conversion(path: &Path, probe: &serde_json::Value) -> bool {
    if has_multichannel_audio(probe) {
        return true;
    }
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let streams = probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let video_codecs: Vec<String> = streams
        .iter()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("video"))
        .filter_map(|s| s.get("codec_name").and_then(serde_json::Value::as_str))
        .map(|s| s.trim().to_ascii_lowercase())
        .collect();
    let audio_codecs: Vec<String> = streams
        .iter()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("audio"))
        .filter_map(|s| s.get("codec_name").and_then(serde_json::Value::as_str))
        .map(|s| s.trim().to_ascii_lowercase())
        .collect();
    match extension.as_str() {
        "mp4" | "m4v" | "mov" => audio_codecs.iter().any(|c| !["aac", "mp3"].contains(&c.as_str())),
        "mkv" => {
            video_codecs.is_empty()
                || video_codecs
                    .iter()
                    .any(|c| !["h264", "avc1", "vp8", "vp9", "av1"].contains(&c.as_str()))
                || audio_codecs
                    .iter()
                    .any(|c| !["aac", "mp3", "opus", "vorbis"].contains(&c.as_str()))
        }
        "webm" => audio_codecs.iter().any(|c| !["opus", "vorbis"].contains(&c.as_str())),
        _ => true,
    }
}

/// FNV-1a over a list of parts. Cache file names must stay the same across Rust releases:
/// `DefaultHasher` makes no such promise, and a toolchain update would orphan every cached file.
fn stable_hash(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for b in part.iter().chain(std::iter::once(&0xffu8)) {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

/// The stereo audio codecs a browser plays natively inside MP4 (these can be copied instead of
/// downmixed/normalized; 5.1/7.1 streams are re-encoded with dialogue-focused stereo matrices).
fn mp4_audio_compatible(probe: &serde_json::Value) -> bool {
    if has_multichannel_audio(probe) {
        return false;
    }
    let codecs: Vec<&str> = probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("audio"))
        .filter_map(|s| s.get("codec_name").and_then(serde_json::Value::as_str))
        .collect();
    !codecs.is_empty() && codecs.iter().all(|c| ["aac", "mp3"].contains(c))
}

/// Remove conversions that never finished (the app was closed mid-way).
fn sweep_partials(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().contains(".partial.") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Evict oldest completed conversions in `local-media` once total size exceeds `max_bytes`.
fn prune_local_media_cache(cache_dir: &Path, max_bytes: u64, preserve: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(cache_dir) else { return };
    let mut files: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for ent in entries.flatten() {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.contains(".partial.") || !name.to_ascii_lowercase().ends_with(".mp4") {
            continue;
        }
        let Ok(meta) = ent.metadata() else { continue };
        let len = meta.len();
        total = total.saturating_add(len);
        if preserve.is_some_and(|p| p == path) {
            continue;
        }
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        files.push((path, len, modified));
    }
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, len, _) in files {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
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
                .map(is_text_sub_codec)
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
            &probe(&[("video", "h264"), ("audio", "ac3")]),
        ));
        assert!(media_needs_audio_conversion(
            Path::new("Film.mkv"),
            &probe(&[("video", "hevc"), ("audio", "aac")]),
        ));
    }

    #[test]
    fn leaves_supported_mp4_and_webm_audio_alone() {
        assert!(!media_needs_audio_conversion(
            Path::new("Film.mp4"),
            &probe(&[("video", "h264"), ("audio", "aac")]),
        ));
        assert!(!media_needs_audio_conversion(
            Path::new("Film.mkv"),
            &probe(&[("video", "h264"), ("audio", "aac")]),
        ));
        assert!(!media_needs_audio_conversion(
            Path::new("Film.mkv"),
            &probe(&[("video", "vp9"), ("audio", "opus")]),
        ));
        assert!(!media_needs_audio_conversion(
            Path::new("Clip.webm"),
            &probe(&[("video", "vp9"), ("audio", "opus")]),
        ));
    }

    #[test]
    fn downmixes_multichannel_mp4_audio_with_center_dialogue_matrix() {
        let surround = serde_json::json!({
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "h264" },
                { "index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 6 }
            ]
        });
        assert!(has_multichannel_audio(&surround));
        assert!(!mp4_audio_compatible(&surround));
        assert!(media_needs_audio_conversion(Path::new("Film.mp4"), &surround));
        assert!(media_needs_audio_conversion(Path::new("Film.mkv"), &surround));
        assert!(audio_downmix_filter(Some(6)).is_some_and(|f| f.contains("pan=stereo")));
        assert!(audio_downmix_filter(Some(2)).is_none());
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

    #[test]
    fn lists_audio_tracks_and_picks_the_chosen_codec() {
        let audio_only = serde_json::json!({ "streams": [
            { "index": 1, "codec_name": "eac3", "channels": 6, "tags": { "language": "jpn", "title": "Japanese 5.1" }, "disposition": { "default": 1 } },
            { "index": 2, "codec_name": "aac", "channels": 2, "tags": { "language": "eng" }, "disposition": { "default": 0 } },
            { "index": 3, "codec_name": "aac", "tags": { "language": "und" } }
        ]});
        let tracks = parse_local_audio_tracks(&audio_only);
        assert_eq!(tracks.len(), 3);
        assert_eq!(tracks[0].index, 0);
        assert!(tracks[0].is_default);
        assert_eq!(tracks[0].channels, Some(6));
        assert_eq!(tracks[1].language.as_deref(), Some("eng"));
        assert_eq!(tracks[2].language, None); // "und" means unknown

        let full = serde_json::json!({ "streams": [
            { "index": 0, "codec_type": "video", "codec_name": "h264" },
            { "index": 1, "codec_type": "audio", "codec_name": "eac3" },
            { "index": 2, "codec_type": "subtitle", "codec_name": "ass" },
            { "index": 3, "codec_type": "audio", "codec_name": "aac" }
        ]});
        assert_eq!(audio_stream_count(&full), 2);
        assert_eq!(nth_audio_codec(&full, 0).as_deref(), Some("eac3"));
        assert_eq!(nth_audio_codec(&full, 1).as_deref(), Some("aac"));
        assert_eq!(nth_audio_codec(&full, 2), None);
    }

    struct TempDirGuard(PathBuf);

    impl TempDirGuard {
        fn new(label: &str) -> Self {
            static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("abixcine-test-{label}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn classifies_text_and_bitmap_subtitle_codecs() {
        for codec in ["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "ASS", "WebVTT"] {
            assert!(is_text_sub_codec(codec), "expected text codec for {codec}");
        }
        for codec in ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub", ""] {
            assert!(!is_text_sub_codec(codec), "expected non-text codec for {codec}");
        }
        assert_eq!(extracted_sub_format_and_codec("ass"), ("ass", "ass"));
        assert_eq!(extracted_sub_format_and_codec("SSA"), ("ass", "ass"));
        assert_eq!(extracted_sub_format_and_codec("subrip"), ("vtt", "webvtt"));
        assert_eq!(extracted_sub_format_and_codec("mov_text"), ("vtt", "webvtt"));
    }

    #[test]
    fn parses_ffprobe_subtitles_metadata_and_flags() {
        let payload = serde_json::json!({
            "streams": [
                {
                    "index": 2,
                    "codec_type": "subtitle",
                    "codec_name": "ass",
                    "tags": { "LANGUAGE": "jpn", "Title": "Dialogue" },
                    "disposition": { "default": 1, "forced": 0, "hearing_impaired": 0 }
                },
                {
                    "index": 3,
                    "codec_type": "subtitle",
                    "codec_name": "subrip",
                    "tags": { "language": "eng", "title": "English (SDH)" },
                    "disposition": { "default": 0, "forced": 1, "hearing_impaired": 1 }
                },
                {
                    "index": 4,
                    "codec_type": "subtitle",
                    "codec_name": "hdmv_pgs_subtitle",
                    "tags": { "language": "eng" }
                }
            ]
        });
        let parsed = parse_ffprobe_subtitles(&payload);
        assert_eq!(parsed.len(), 3);
        assert_eq!(
            parsed[0],
            EmbeddedSubtitle {
                index: 2,
                codec: "ass".into(),
                lang: Some("jpn".into()),
                title: Some("Dialogue".into()),
                is_default: true,
                is_forced: false,
                is_hearing_impaired: false,
                is_text: true,
            }
        );
        assert!(parsed[1].is_forced && parsed[1].is_hearing_impaired && parsed[1].is_text);
        assert!(!parsed[2].is_text);
    }

    #[test]
    fn matches_sidecar_subtitles_including_ass_ssa_and_subs_subfolders() {
        let root = TempDirGuard::new("sidecars");
        let movie_dir = root.0.join("Movie (2010)");
        let movie_subs = movie_dir.join("Subs");
        std::fs::create_dir_all(&movie_subs).unwrap();
        std::fs::write(movie_dir.join("Movie (2010).mkv"), b"vid").unwrap();
        std::fs::write(movie_dir.join("Movie (2010).en.ass"), b"ass").unwrap();
        std::fs::write(movie_subs.join("English.srt"), b"srt").unwrap();

        let show_dir = root.0.join("Show");
        let show_subs = show_dir.join("Subtitles");
        let ep1_nested = show_subs.join("Show - 1");
        std::fs::create_dir_all(&ep1_nested).unwrap();
        std::fs::write(show_dir.join("Show - 1.mkv"), b"v1").unwrap();
        std::fs::write(show_dir.join("Show - 10.mkv"), b"v10").unwrap();
        std::fs::write(show_dir.join("Show - 1.forced.srt"), b"f1").unwrap();
        std::fs::write(show_subs.join("Show - 1.ja.ssa"), b"s1").unwrap();
        std::fs::write(show_subs.join("Show - 10.en.ass"), b"s10").unwrap();
        std::fs::write(ep1_nested.join("2_English.vtt"), b"vtt1").unwrap();

        // Anime Sub/ folder holding actual videos must NOT be treated as sidecar subfolder for parent video
        let anime_dir = root.0.join("Anime");
        let anime_sub_dir = anime_dir.join("Sub");
        std::fs::create_dir_all(&anime_sub_dir).unwrap();
        std::fs::write(anime_dir.join("Trailer.mp4"), b"trailer").unwrap();
        std::fs::write(anime_sub_dir.join("Ep01.mkv"), b"ep1").unwrap();
        std::fs::write(anime_sub_dir.join("Ep01.ass"), b"ep1sub").unwrap();

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        walk(&root.0, &mut out, &mut seen, 0);

        let movie = out.iter().find(|f| f.name == "Movie (2010)").unwrap();
        assert_eq!(movie.subs.len(), 2);
        assert!(movie.subs.iter().any(|s| s.ends_with("Movie (2010).en.ass")));
        assert!(movie.subs.iter().any(|s| s.ends_with("English.srt")));

        let ep1 = out.iter().find(|f| f.name == "Show - 1").unwrap();
        assert_eq!(ep1.subs.len(), 3);
        assert!(ep1.subs.iter().any(|s| s.ends_with("Show - 1.forced.srt")));
        assert!(ep1.subs.iter().any(|s| s.ends_with("Show - 1.ja.ssa")));
        assert!(ep1.subs.iter().any(|s| s.ends_with("2_English.vtt")));
        assert!(!ep1.subs.iter().any(|s| s.contains("Show - 10")));

        let ep10 = out.iter().find(|f| f.name == "Show - 10").unwrap();
        assert_eq!(ep10.subs.len(), 1);
        assert!(ep10.subs[0].ends_with("Show - 10.en.ass"));

        let trailer = out.iter().find(|f| f.name == "Trailer").unwrap();
        assert!(trailer.subs.is_empty());

        let anime_ep1 = out.iter().find(|f| f.name == "Ep01").unwrap();
        assert_eq!(anime_ep1.subs.len(), 1);
        assert!(anime_ep1.subs[0].ends_with("Ep01.ass"));
    }

    #[test]
    fn validates_sidecar_filenames_and_library_root_confinement() {
        for bad in [
            "",
            "   ",
            "../evil.srt",
            "..\\evil.srt",
            "sub/file.srt",
            "sub\\file.vtt",
            "..",
            ".",
            "movie..srt",
            "movie.srt\0.txt",
            "movie.exe",
            "movie.txt",
            "C:movie.srt",
            "CON.srt",
            "movie.srt.",
        ] {
            assert!(validate_sidecar_filename(bad).is_err(), "expected error for {bad:?}");
        }
        for good in ["Movie.en.srt", "Movie.forced.vtt", "Anime.ja.ASS", "Show.ssa"] {
            assert!(validate_sidecar_filename(good).is_ok(), "expected ok for {good:?}");
        }

        let root = TempDirGuard::new("save-sidecar-root");
        let outside = TempDirGuard::new("save-sidecar-outside");
        let canonical_root = std::fs::canonicalize(&root.0).unwrap();
        let video = root.0.join("Film.mkv");
        let outside_video = outside.0.join("Outside.mkv");
        std::fs::write(&video, b"mkv").unwrap();
        std::fs::write(&outside_video, b"mkv").unwrap();

        let saved = save_sidecar_subtitle_in_roots(
            &video,
            "Film.en.ass",
            "[Script Info]\n",
            &[canonical_root.clone()],
        )
        .unwrap();
        assert_eq!(std::fs::read_to_string(&saved).unwrap(), "[Script Info]\n");

        // Outside LIBRARY_ROOTS rejected
        assert!(save_sidecar_subtitle_in_roots(
            &outside_video,
            "Outside.en.srt",
            "1\n",
            &[canonical_root.clone()],
        )
        .is_err());

        // Stripped Windows root (matching register_downloads_root) is accepted alongside canonical paths
        let stripped_root = strip_verbatim_prefix(canonical_root.clone());
        let saved2 = save_sidecar_subtitle_in_roots(
            &video,
            "Film.fr.srt",
            "1\n",
            &[stripped_root],
        )
        .unwrap();
        assert!(saved2.ends_with("Film.fr.srt"));

        // Oversized > 10 MiB rejected
        let too_big = "a".repeat(MAX_SAVED_SUB_BYTES + 1);
        assert!(save_sidecar_subtitle_in_roots(&video, "Film.en.srt", &too_big, &[canonical_root]).is_err());
    }

    #[test]
    fn prunes_oldest_local_media_cache_files_when_over_budget() {
        let dir = TempDirGuard::new("local-media-prune");
        let f1 = dir.0.join("old.mp4");
        let f2 = dir.0.join("mid.mp4");
        let f3 = dir.0.join("new.mp4");
        std::fs::write(&f1, vec![1u8; 60]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        std::fs::write(&f2, vec![2u8; 60]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        std::fs::write(&f3, vec![3u8; 60]).unwrap();

        prune_local_media_cache(&dir.0, 120, Some(&f1));
        assert!(f1.is_file(), "preserved file should not be evicted");
        assert!(!f2.is_file(), "oldest non-preserved file should be evicted");
        assert!(f3.is_file(), "newest file should remain under budget");
    }

    #[test]
    fn resolves_media_tools_from_bundle_then_path() {
        let root = TempDirGuard::new("tool-res");
        let bundle = root.0.join("bundle");
        let path_dir = root.0.join("path");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::create_dir_all(&path_dir).unwrap();
        let bin = platform_tool_name("ffprobe");
        let path_tool = path_dir.join(&bin);
        std::fs::write(&path_tool, b"path").unwrap();

        let resolved_from_path =
            resolve_tool_in_dirs_and_path(&bin, &[bundle.clone()], Some(path_dir.as_os_str()));
        assert_eq!(resolved_from_path.as_deref(), Some(path_tool.as_path()));

        let bundled_tool = bundle.join(&bin);
        std::fs::write(&bundled_tool, b"bundle").unwrap();
        let resolved_from_bundle =
            resolve_tool_in_dirs_and_path(&bin, &[bundle], Some(path_dir.as_os_str()));
        assert_eq!(resolved_from_bundle.as_deref(), Some(bundled_tool.as_path()));
    }

    #[test]
    fn invalidates_extracted_subtitle_cache_key_and_enforces_size_cap() {
        let p = Path::new("/media/movie.mkv");
        let k1 = extracted_sub_cache_key(p, 1000, 12345, 2, "ass");
        assert_ne!(k1, extracted_sub_cache_key(p, 1001, 12345, 2, "ass"));
        assert_ne!(k1, extracted_sub_cache_key(p, 1000, 12346, 2, "ass"));
        assert_ne!(k1, extracted_sub_cache_key(p, 1000, 12345, 3, "ass"));
        assert_ne!(k1, extracted_sub_cache_key(p, 1000, 12345, 2, "vtt"));

        let root = TempDirGuard::new("cap-test");
        let ok_file = root.0.join("ok.vtt");
        std::fs::write(&ok_file, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n").unwrap();
        assert!(read_text_capped(&ok_file, 1024).is_ok());

        let big_file = root.0.join("big.vtt");
        std::fs::write(&big_file, vec![b'a'; 200]).unwrap();
        assert!(read_text_capped(&big_file, 100).is_err());
    }

    #[test]
    fn computes_standard_opensubtitles_64bit_hash_and_enforces_library_roots() {
        let root = TempDirGuard::new("oshash-root");
        let outside = TempDirGuard::new("oshash-outside");
        let canonical_root = std::fs::canonicalize(&root.0).unwrap();

        // Reject files smaller than 64 KiB
        let tiny = root.0.join("tiny.mkv");
        std::fs::write(&tiny, vec![0u8; OSHASH_CHUNK_BYTES - 1]).unwrap();
        assert!(compute_oshash_in_roots(&tiny, &[canonical_root.clone()]).is_err());

        // Reject files outside LIBRARY_ROOTS
        let outside_vid = outside.0.join("outside.mkv");
        std::fs::write(&outside_vid, vec![0u8; OSHASH_CHUNK_BYTES]).unwrap();
        assert!(compute_oshash_in_roots(&outside_vid, &[canonical_root.clone()]).is_err());

        // Exact 64 KiB file: head and tail overlap completely -> file_size + 2 * sum(64 KiB)
        let exact_64k = root.0.join("exact64k.mkv");
        let mut data_64k = Vec::with_capacity(OSHASH_CHUNK_BYTES);
        for i in 0..(OSHASH_CHUNK_BYTES / 8) {
            data_64k.extend_from_slice(&(i as u64 + 1).to_le_bytes());
        }
        std::fs::write(&exact_64k, &data_64k).unwrap();
        let sum_64k: u64 = (1..=(OSHASH_CHUNK_BYTES as u64 / 8)).fold(0u64, u64::wrapping_add);
        let expected_64k = (OSHASH_CHUNK_BYTES as u64)
            .wrapping_add(sum_64k)
            .wrapping_add(sum_64k);
        assert_eq!(
            compute_oshash_in_roots(&exact_64k, &[canonical_root.clone()]).unwrap(),
            format!("{expected_64k:016x}")
        );

        // Non-overlapping head & tail (> 128 KiB) with wrapping overflow arithmetic
        let big_vid = root.0.join("movie.mkv");
        let total_size = OSHASH_CHUNK_BYTES * 2 + 123;
        let mut data_big = vec![0u8; total_size];
        // Put 0x0102030405060708 in first 8 bytes of head and 0xffffffffffffffff in last 8 bytes of tail
        let head_val: u64 = 0x0102_0304_0506_0708;
        let tail_val: u64 = u64::MAX;
        data_big[..8].copy_from_slice(&head_val.to_le_bytes());
        data_big[total_size - 8..].copy_from_slice(&tail_val.to_le_bytes());
        std::fs::write(&big_vid, &data_big).unwrap();
        let expected_big = (total_size as u64).wrapping_add(head_val).wrapping_add(tail_val);
        let got_big = compute_oshash_in_roots(&big_vid, &[canonical_root]).unwrap();
        assert_eq!(got_big.len(), 16);
        assert_eq!(got_big, format!("{expected_big:016x}"));
    }

    #[test]
    fn active_pid_guard_registers_and_cleans_up_on_drop() {
        const TEST_PID: u32 = 0xFFFF_FFFE;
        {
            let _guard = ActivePidGuard::new(TEST_PID);
            let set = active_media_pids().lock().unwrap_or_else(|e| e.into_inner());
            assert!(set.contains(&TEST_PID));
        }
        let set = active_media_pids().lock().unwrap_or_else(|e| e.into_inner());
        assert!(!set.contains(&TEST_PID));
    }
}

/// The codec of the `n`-th audio stream (audio-relative, as in `-map 0:a:n`).
fn nth_audio_codec(probe: &serde_json::Value, n: u32) -> Option<String> {
    probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("audio"))
        .nth(n as usize)
        .and_then(|s| s.get("codec_name").and_then(serde_json::Value::as_str))
        .map(str::to_string)
}

fn nth_audio_channels(probe: &serde_json::Value, n: u32) -> Option<u64> {
    probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("audio"))
        .nth(n as usize)
        .and_then(|s| s.get("channels").and_then(serde_json::Value::as_u64))
}

fn audio_stream_count(probe: &serde_json::Value) -> u32 {
    probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("codec_type").and_then(serde_json::Value::as_str) == Some("audio"))
        .count() as u32
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPrepareProgress {
    path: String,
    percent: f64,
}

fn is_prepare_superseded(expected_gen: Option<u64>) -> bool {
    expected_gen.is_some_and(|g| LOCAL_PREPARE_GEN.load(Ordering::SeqCst) != g)
}

fn prepare_local_media_file(
    app: Option<tauri::AppHandle>,
    raw_path: Option<String>,
    path: PathBuf,
    cache_dir: PathBuf,
    ffmpeg: Result<PathBuf, String>,
    ffprobe: PathBuf,
    audio_index: Option<u32>,
    force_remux: bool,
    expected_gen: Option<u64>,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Read};
    use std::process::Stdio;

    let canonical = ensure_in_library_roots(&path)?;
    let extension = canonical.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !ext_in(&canonical, VIDEO_EXTS) || extension == "m3u8" {
        return Err("The requested file is not a supported local video".into());
    }

    let mut probe_cmd = background_command(&ffprobe);
    probe_cmd
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,codec_name,channels",
            "-of",
            "json",
        ])
        .arg(&canonical);
    let probe = run_background_output(&mut probe_cmd)
        .map_err(|e| format!("Could not inspect local media: {e}"))?;
    if !probe.status.success() {
        return Err(format!("Could not inspect local media: {}", String::from_utf8_lossy(&probe.stderr)));
    }
    let probe: serde_json::Value = serde_json::from_slice(&probe.stdout).map_err(|e| e.to_string())?;
    let duration_sec = probe
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(serde_json::Value::as_str)
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|&d| d.is_finite() && d > 0.0);
    // WebView2 can't switch audio tracks itself (no HTMLMediaElement.audioTracks), so a chosen
    // non-default track gets its own copy of the file with only that track in it.
    let chosen_audio = audio_index.filter(|&i| i > 0 && i < audio_stream_count(&probe));
    if !force_remux && chosen_audio.is_none() && !media_needs_audio_conversion(&canonical, &probe) {
        return Ok(canonical.to_string_lossy().into_owned());
    }
    let ffmpeg = ffmpeg?;

    let metadata = std::fs::metadata(&canonical).map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
        .unwrap_or_default();
    let key = stable_hash(&[
        canonical.to_string_lossy().as_bytes(),
        &metadata.len().to_le_bytes(),
        &modified.to_le_bytes(),
        b"abixcine-local-mp4-aac-v5",
        &chosen_audio.map(|i| i.to_le_bytes()).unwrap_or([0xff; 4]),
    ]);
    let output = cache_dir.join(format!("{key:016x}.mp4"));
    if output.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(output.to_string_lossy().into_owned());
    }
    if is_prepare_superseded(expected_gen) {
        return Err("cancelled".into());
    }
    prune_local_media_cache(&cache_dir, LOCAL_MEDIA_CACHE_CAP_BYTES, Some(&output));

    let partial = output.with_extension("partial.mp4");
    let _ = std::fs::remove_file(&partial);
    let mut command = background_command(&ffmpeg);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"])
        .arg(&canonical)
        // `V` (capital) skips attached pictures: `v:0` picked an MKV's embedded cover JPEG over the film.
        .args(["-map", "0:V:0", "-map"])
        .arg(match chosen_audio {
            Some(i) => format!("0:a:{i}"),
            None => "0:a?".to_string(),
        });
    // Audio the browser already plays is copied (a remux takes seconds, not minutes). Anything
    // else becomes stereo AAC: 5.1 squeezed into 192k sounded thin, and browsers downmix
    // multichannel AAC unpredictably.
    let copy_audio = match chosen_audio {
        Some(i) => {
            nth_audio_codec(&probe, i).is_some_and(|c| c == "aac" || c == "mp3")
                && nth_audio_channels(&probe, i).is_none_or(|ch| ch <= 2)
        }
        None => mp4_audio_compatible(&probe),
    };
    if copy_audio {
        command.args(["-c:v", "copy", "-c:a", "copy", "-map_metadata", "0", "-sn", "-dn"]);
    } else {
        let target_channels = chosen_audio
            .and_then(|i| nth_audio_channels(&probe, i))
            .or_else(|| nth_audio_channels(&probe, 0));
        command.args(["-c:v", "copy"]);
        if let Some(af) = audio_downmix_filter(target_channels) {
            command.args(["-af", af]);
        }
        command.args([
            "-c:a",
            "aac",
            "-ac",
            "2",
            "-b:a",
            "256k",
            "-map_metadata",
            "0",
            "-sn",
            "-dn",
        ]);
    }
    command
        .args(["-movflags", "+faststart", "-f", "mp4", "-progress", "pipe:1"])
        .arg(&partial);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not convert local audio: {e}"))?;
    let child_pid = child.id();
    let _guard = ActivePidGuard::new(child_pid);
    if let Some(g) = expected_gen {
        let mut slot = local_prepare_pid_slot().lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some((g, child_pid));
        drop(slot);
        if is_prepare_superseded(expected_gen) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_file(&partial);
            return Err("cancelled".into());
        }
    }
    let stderr_handle = child.stderr.take().map(|mut se| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = se.read_to_string(&mut s);
            s
        })
    });
    if let Some(stdout) = child.stdout.take() {
        let event_path = raw_path.unwrap_or_else(|| canonical.to_string_lossy().into_owned());
        let reader = BufReader::new(stdout);
        let mut last_emit = std::time::Instant::now()
            .checked_sub(std::time::Duration::from_millis(200))
            .unwrap_or_else(std::time::Instant::now);
        let mut last_pct = -1.0_f64;
        for line in reader.lines().map_while(Result::ok) {
            if let Some(val) = line.strip_prefix("out_time_us=") {
                if let (Ok(us), Some(tot)) = (val.trim().parse::<u64>(), duration_sec) {
                    let pct = (((us as f64) / 1_000_000.0) / tot * 100.0).clamp(0.0, 99.0);
                    if pct - last_pct >= 1.0 || last_emit.elapsed().as_millis() >= 150 {
                        last_pct = pct;
                        last_emit = std::time::Instant::now();
                        if let Some(ref handle) = app {
                            let _ = handle.emit(
                                "abx://local-prepare-progress",
                                LocalPrepareProgress {
                                    path: event_path.clone(),
                                    percent: pct,
                                },
                            );
                        }
                    }
                }
            } else if line.trim() == "progress=end" {
                if let Some(ref handle) = app {
                    let _ = handle.emit(
                        "abx://local-prepare-progress",
                        LocalPrepareProgress {
                            path: event_path.clone(),
                            percent: 100.0,
                        },
                    );
                }
            }
        }
    }
    let status = child
        .wait()
        .map_err(|e| format!("Could not convert local audio: {e}"))?;
    if expected_gen.is_some() {
        let mut slot = local_prepare_pid_slot().lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some_and(|(g, _)| Some(g) == expected_gen) {
            *slot = None;
        }
    }
    let detail = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    if is_prepare_superseded(expected_gen) {
        let _ = std::fs::remove_file(&partial);
        return Err("cancelled".into());
    }
    if !status.success() || !partial.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        let _ = std::fs::remove_file(&partial);
        let tail = detail.chars().rev().take(900).collect::<String>().chars().rev().collect::<String>();
        return Err(format!("Could not convert local audio: {tail}"));
    }
    std::fs::rename(&partial, &output).map_err(|e| {
        let _ = std::fs::remove_file(&partial);
        e.to_string()
    })?;
    Ok(output.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAudioTrack {
    /// Audio-relative index, as `prepare_local_media`'s `audioIndex` takes it.
    index: u32,
    codec: String,
    channels: Option<u64>,
    language: Option<String>,
    title: Option<String>,
    is_default: bool,
}

/// The audio streams of a library file, so the player can offer a choice WebView2 can't make itself.
#[tauri::command]
async fn probe_local_audio(app: tauri::AppHandle, path: String) -> Result<Vec<LocalAudioTrack>, String> {
    let path = PathBuf::from(path);
    let ffprobe = ffprobe_tool(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = ensure_in_library_roots(&path)?;
        let mut out_cmd = background_command(&ffprobe);
        out_cmd
            .args([
                "-v",
                "error",
                "-select_streams",
                "a",
                "-show_entries",
                "stream=index,codec_name,channels:stream_tags=language,title:stream_disposition=default",
                "-of",
                "json",
            ])
            .arg(&canonical);
        let out = run_background_output(&mut out_cmd)
            .map_err(|e| format!("Could not inspect local audio: {e}"))?;
        if !out.status.success() {
            return Err(format!("Could not inspect local audio: {}", String::from_utf8_lossy(&out.stderr)));
        }
        let probe: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        Ok(parse_local_audio_tracks(&probe))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_local_audio_tracks(probe: &serde_json::Value) -> Vec<LocalAudioTrack> {
    let tag = |s: &serde_json::Value, k: &str| {
        s.get("tags")
            .and_then(|t| t.get(k))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(i, s)| LocalAudioTrack {
            index: i as u32,
            codec: s.get("codec_name").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
            channels: s.get("channels").and_then(serde_json::Value::as_u64),
            language: tag(s, "language").filter(|l| l != "und"),
            title: tag(s, "title"),
            is_default: s
                .get("disposition")
                .and_then(|d| d.get("default"))
                .and_then(serde_json::Value::as_u64)
                == Some(1),
        })
        .collect()
}

#[tauri::command]
async fn prepare_local_media(
    app: tauri::AppHandle,
    path: String,
    audio_index: Option<u32>,
    force_remux: Option<bool>,
) -> Result<String, String> {
    let raw_path = path.clone();
    let path = PathBuf::from(path);
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("local-media");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let scope = app.asset_protocol_scope();
    scope.allow_directory(&cache_dir, true).map_err(|e| e.to_string())?;
    let ffmpeg = ffmpeg_tool(&app, "ffmpeg");
    let ffprobe = ffprobe_tool(&app)?;
    let app_handle = app.clone();
    let my_gen = LOCAL_PREPARE_GEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let stale_pid = {
        let mut slot = local_prepare_pid_slot().lock().unwrap_or_else(|e| e.into_inner());
        match *slot {
            Some((owner_gen, pid)) if owner_gen < my_gen => {
                *slot = None;
                Some(pid)
            }
            _ => None,
        }
    };
    if let Some(pid) = stale_pid {
        terminate_pid(pid);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = MEDIA_PREPARE_LOCK.lock().map_err(|e| e.to_string())?;
        prepare_local_media_file(
            Some(app_handle),
            Some(raw_path),
            path,
            cache_dir,
            ffmpeg,
            ffprobe,
            audio_index,
            force_remux.unwrap_or(false),
            Some(my_gen),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct EmbeddedSubtitle {
    index: u64,
    codec: String,
    lang: Option<String>,
    title: Option<String>,
    is_default: bool,
    is_forced: bool,
    is_hearing_impaired: bool,
    is_text: bool,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExtractedSubtitle {
    format: String,
    content: String,
    path: String,
}

fn get_tag_ci(tags: Option<&serde_json::Map<String, serde_json::Value>>, key: &str) -> Option<String> {
    let map = tags?;
    map.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .and_then(|(_, v)| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn disposition_flag(disp: Option<&serde_json::Map<String, serde_json::Value>>, key: &str) -> bool {
    disp.and_then(|m| m.get(key))
        .map(|v| v.as_u64() == Some(1) || v.as_i64() == Some(1) || v.as_bool() == Some(true))
        .unwrap_or(false)
}

fn parse_ffprobe_subtitles(probe: &serde_json::Value) -> Vec<EmbeddedSubtitle> {
    probe
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| {
            s.get("codec_type")
                .and_then(serde_json::Value::as_str)
                .map(|t| t == "subtitle")
                .unwrap_or(false)
        })
        .filter_map(|s| {
            let index = s.get("index").and_then(serde_json::Value::as_u64)?;
            let codec = s
                .get("codec_name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let tags = s.get("tags").and_then(serde_json::Value::as_object);
            let disp = s.get("disposition").and_then(serde_json::Value::as_object);
            Some(EmbeddedSubtitle {
                index,
                is_text: is_text_sub_codec(&codec),
                codec,
                lang: get_tag_ci(tags, "language"),
                title: get_tag_ci(tags, "title"),
                is_default: disposition_flag(disp, "default"),
                is_forced: disposition_flag(disp, "forced"),
                is_hearing_impaired: disposition_flag(disp, "hearing_impaired"),
            })
        })
        .collect()
}

fn probe_subtitles_sync(canonical: &Path, ffprobe: &Path) -> Result<Vec<EmbeddedSubtitle>, String> {
    let mut out_cmd = background_command(ffprobe);
    out_cmd
        .args(["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "s"])
        .arg(canonical);
    let out = run_background_output(&mut out_cmd)
        .map_err(|e| format!("Could not probe local subtitles: {e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("Could not probe local subtitles (exit {})", out.status)
        } else {
            format!("Could not probe local subtitles: {detail}")
        });
    }
    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(parse_ffprobe_subtitles(&parsed))
}

#[tauri::command]
async fn probe_local_subtitles(app: tauri::AppHandle, path: String) -> Result<Vec<EmbeddedSubtitle>, String> {
    let ffprobe = ffprobe_tool(&app)?;
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = ensure_in_library_roots(&path)?;
        probe_subtitles_sync(&canonical, &ffprobe)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_text_capped(path: &Path, max_bytes: u64) -> Result<String, String> {
    use std::io::Read;
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > max_bytes {
        return Err(format!("Subtitle file exceeds {} MiB limit", max_bytes / (1024 * 1024)));
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.take(max_bytes + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > max_bytes {
        return Err(format!("Subtitle file exceeds {} MiB limit", max_bytes / (1024 * 1024)));
    }
    Ok(String::from_utf8(buf).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
}

fn extracted_sub_format_and_codec(codec: &str) -> (&'static str, &'static str) {
    match codec.trim().to_ascii_lowercase().as_str() {
        "ass" | "ssa" => ("ass", "ass"),
        _ => ("vtt", "webvtt"),
    }
}

fn extracted_sub_cache_key(canonical: &Path, size: u64, modified_nanos: u128, stream_index: u64, format: &str) -> u64 {
    stable_hash(&[
        canonical.to_string_lossy().as_bytes(),
        &size.to_le_bytes(),
        &modified_nanos.to_le_bytes(),
        &stream_index.to_le_bytes(),
        format.as_bytes(),
        b"abixcine-local-sub-v2",
    ])
}

fn extract_local_subtitle_sync(
    canonical: &Path,
    stream_index: u64,
    cache_dir: &Path,
    ffmpeg: &Path,
    ffprobe: &Path,
) -> Result<ExtractedSubtitle, String> {
    let streams = probe_subtitles_sync(canonical, ffprobe)?;
    let stream = streams
        .into_iter()
        .find(|s| s.index == stream_index)
        .ok_or_else(|| format!("Subtitle stream {stream_index} was not found"))?;
    if !stream.is_text {
        return Err(format!(
            "Subtitle stream {stream_index} ({}) is a bitmap subtitle and cannot be extracted as text",
            stream.codec
        ));
    }

    let (format, ffmpeg_codec) = extracted_sub_format_and_codec(&stream.codec);
    let metadata = std::fs::metadata(canonical).map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
        .unwrap_or_default();
    let hash = extracted_sub_cache_key(canonical, metadata.len(), modified, stream_index, format);
    let output = cache_dir.join(format!("{hash:016x}.{format}"));

    if output.metadata().map(|m| m.is_file() && m.len() > 0).unwrap_or(false) {
        let content = read_text_capped(&output, MAX_EXTRACTED_SUB_BYTES)?;
        return Ok(ExtractedSubtitle {
            format: format.to_string(),
            content,
            path: output.to_string_lossy().into_owned(),
        });
    }

    static PARTIAL_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = PARTIAL_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let partial = cache_dir.join(format!("{hash:016x}.partial.{}.{seq}.{format}", std::process::id()));
    let _ = std::fs::remove_file(&partial);

    let mut sub_cmd = background_command(ffmpeg);
    sub_cmd
        .args(["-hide_banner", "-nostdin", "-y", "-v", "error", "-i"])
        .arg(canonical)
        .arg("-map")
        .arg(format!("0:{stream_index}"))
        .args(["-c:s", ffmpeg_codec])
        .arg(&partial);
    let result = run_background_output(&mut sub_cmd)
        .map_err(|e| format!("Could not extract subtitle: {e}"))?;

    if !result.status.success() || !partial.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        let _ = std::fs::remove_file(&partial);
        let detail = String::from_utf8_lossy(&result.stderr);
        let detail = detail.chars().rev().take(900).collect::<String>().chars().rev().collect::<String>();
        return Err(if detail.trim().is_empty() {
            format!("Could not extract subtitle stream {stream_index}")
        } else {
            format!("Could not extract subtitle: {}", detail.trim())
        });
    }

    let content = match read_text_capped(&partial, MAX_EXTRACTED_SUB_BYTES) {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            return Err(e);
        }
    };

    if let Err(e) = std::fs::rename(&partial, &output) {
        let _ = std::fs::remove_file(&partial);
        if !output.metadata().map(|m| m.is_file() && m.len() > 0).unwrap_or(false) {
            return Err(e.to_string());
        }
    }

    Ok(ExtractedSubtitle {
        format: format.to_string(),
        content,
        path: output.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn extract_local_subtitle(
    app: tauri::AppHandle,
    path: String,
    stream_index: u64,
) -> Result<ExtractedSubtitle, String> {
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("local-subs");
    std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(&cache_dir, true)
        .map_err(|e| e.to_string())?;
    let ffmpeg = ffmpeg_tool(&app, "ffmpeg")?;
    let ffprobe = ffprobe_tool(&app)?;
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        let canonical = ensure_in_library_roots(&path)?;
        extract_local_subtitle_sync(&canonical, stream_index, &cache_dir, &ffmpeg, &ffprobe)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn validate_sidecar_filename(filename: &str) -> Result<String, String> {
    if filename.contains('\0') || filename.chars().any(|c| c.is_control()) {
        return Err("Invalid subtitle filename".into());
    }
    let name = filename.trim();
    if name.is_empty() {
        return Err("Subtitle filename cannot be empty".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') {
        return Err("Subtitle filename must not contain path separators".into());
    }
    if name.contains("..") || name == "." || name.ends_with('.') {
        return Err("Subtitle filename contains invalid path segments".into());
    }
    // Windows ignores trailing spaces, so "CON .srt" is the CON device too.
    let first_label = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    if matches!(
        first_label.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err("Invalid reserved subtitle filename".into());
    }
    let p = Path::new(name);
    let mut comps = p.components();
    match (comps.next(), comps.next()) {
        (Some(std::path::Component::Normal(_)), None) => {}
        _ => return Err("Subtitle filename must be a plain file name".into()),
    }
    if p.file_name().and_then(|s| s.to_str()) != Some(name) {
        return Err("Subtitle filename must be a plain file name".into());
    }
    if !ext_in(p, SUB_EXTS) {
        return Err("Subtitle filename must end with .srt, .vtt, .ass, or .ssa".into());
    }
    Ok(name.to_string())
}

fn save_sidecar_subtitle_in_roots(
    video_path: &Path,
    filename: &str,
    content: &str,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    if content.len() > MAX_SAVED_SUB_BYTES {
        return Err("Subtitle content exceeds 10 MiB limit".into());
    }
    let sanitized = validate_sidecar_filename(filename)?;
    let canonical_video = ensure_in_allowed_roots(video_path, allowed_roots)?;
    let parent = canonical_video
        .parent()
        .ok_or_else(|| "Video file has no parent directory".to_string())?;
    let canonical_parent = strip_verbatim_prefix(std::fs::canonicalize(parent).map_err(|e| e.to_string())?);
    if !canonical_parent.is_dir()
        || !allowed_roots
            .iter()
            .any(|root| canonical_parent.starts_with(strip_verbatim_prefix(root.clone())))
    {
        return Err("The requested folder is not inside a selected library folder".into());
    }
    let target = canonical_parent.join(&sanitized);
    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            return Err("Refusing to overwrite a symlink".into());
        }
    }
    std::fs::write(&target, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(target)
}

#[tauri::command]
async fn save_sidecar_subtitle(
    app: tauri::AppHandle,
    video_path: String,
    filename: String,
    content: String,
) -> Result<String, String> {
    let video_path = PathBuf::from(video_path);
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let allowed_roots = all_allowed_roots()?;
        save_sidecar_subtitle_in_roots(&video_path, &filename, &content, &allowed_roots)
    })
    .await
    .map_err(|e| e.to_string())??;
    app.asset_protocol_scope()
        .allow_file(&saved)
        .map_err(|e| e.to_string())?;
    Ok(saved.to_string_lossy().into_owned())
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

/// Test-harness environment switches (`ABX_SNIFF_TEST`, `ABX_JS_TEST`, ...) only exist in debug
/// builds: in a release build they are always unset, so nothing on the machine can drive the app.
pub(crate) fn debug_env_var(name: &str) -> Option<std::ffi::OsString> {
    if cfg!(debug_assertions) {
        std::env::var_os(name)
    } else {
        None
    }
}

pub(crate) fn debug_env_string(name: &str) -> Result<String, std::env::VarError> {
    if cfg!(debug_assertions) {
        std::env::var(name)
    } else {
        Err(std::env::VarError::NotPresent)
    }
}

fn cleanup_before_exit(app: &tauri::AppHandle) {
    downloads::pause_all_on_exit();
    shield::close_all_sniff_windows(app);
    let pids: Vec<u32> = {
        let mut set = active_media_pids().lock().unwrap_or_else(|e| e.into_inner());
        set.drain().collect()
    };
    #[cfg(windows)]
    if !pids.is_empty() {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
        for pid in pids {
            // Terminate only PIDs spawned by AbixCine rather than invoking `taskkill /F /IM`.
            unsafe {
                if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    let _ = TerminateProcess(handle, 1);
                    let _ = CloseHandle(handle);
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = pids;
}

static FULLSCREEN_WAS_MAXIMIZED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
fn get_window_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_window_fullscreen(window: tauri::WebviewWindow, fullscreen: bool) -> Result<bool, String> {
    let currently_full = window.is_fullscreen().unwrap_or(false);
    if fullscreen {
        if !currently_full {
            let was_max = window.is_maximized().unwrap_or(false);
            FULLSCREEN_WAS_MAXIMIZED.store(was_max, std::sync::atomic::Ordering::SeqCst);
            if was_max {
                let _ = window.unmaximize();
            }
        }
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
    } else {
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
        if FULLSCREEN_WAS_MAXIMIZED.swap(false, std::sync::atomic::Ordering::SeqCst) {
            let _ = window.maximize();
        }
    }
    window.is_fullscreen().map_err(|e| e.to_string())
}

#[tauri::command]
fn prepare_for_update_exit(app: tauri::AppHandle) {
    cleanup_before_exit(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything else: panic hook, startup.log, safe-graphics decision (see diagnostics.rs).
    let startup = diagnostics::init();
    #[cfg(windows)]
    diagnostics::require_webview();
    let mut context = tauri::generate_context!();
    // One argument string for every webview (WebView2 shares a browser per data folder); in safe
    // graphics mode it also turns GPU compositing off.
    for w in context.config_mut().app.windows.iter_mut() {
        w.additional_browser_args = Some(diagnostics::browser_args().to_string());
    }
    if startup.safe_mode {
        diagnostics::log(format!("webview args: {}", diagnostics::browser_args()));
    }
    let mut builder = tauri::Builder::default();
    // A second launch (e.g. from the Start menu while it's open) focuses the existing window.
    // The debug sniff harness runs alongside an installed copy, so it skips this.
    if debug_env_var("ABX_SNIFF_TEST").is_none() && debug_env_var("ABX_JS_TEST").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            } else {
                app.exit(0);
            }
        }));
    }
    let result = builder
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                )
            {
                let app = window.app_handle().clone();
                cleanup_before_exit(&app);
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    app.exit(0);
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Direct streams play through this scheme (see stream.rs).
        .register_asynchronous_uri_scheme_protocol("abxs", |ctx, req, responder| {
            // Only the app's own window may use the proxy. Hidden `sniff-*` windows run untrusted
            // embed pages, which must not be able to fetch through it.
            if ctx.webview_label() != "main" {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(tauri::http::StatusCode::FORBIDDEN)
                        .body(Vec::new())
                        .unwrap(),
                );
                return;
            }
            tauri::async_runtime::spawn(async move { responder.respond(stream::handle(req).await) });
        })
        .setup(|app| {
            diagnostics::log("setup");
            // Zero-copy loopback transport for proxied streams (gateway.rs); abxs: stays as fallback.
            gateway::start();
            if let Ok(cache) = app.path().app_cache_dir() {
                std::thread::spawn(move || {
                    let dir = cache.join("local-media");
                    sweep_partials(&dir);
                    prune_local_media_cache(&dir, LOCAL_MEDIA_CACHE_CAP_BYTES, None);
                });
            }
            // Ad, tracker and pop-up shield on the main window, covering every embedded frame.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.with_webview(|pw| shield::install(&pw, true, None));
            }
            // Debug harness: ABX_JS_TEST="<js expression returning a promise of a string>" runs in the
            // main window once the app has loaded; the result is written to the URL hash and printed.
            #[cfg(debug_assertions)]
            if let Ok(js) = debug_env_string("ABX_JS_TEST") {
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
                            if debug_env_var("ABX_JS_VERBOSE").is_some() {
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
            if let Ok(list) = debug_env_string("ABX_SNIFF_TEST") {
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
                    if let (Some(w), Ok(u)) = (h.get_webview_window("main"), debug_env_string("ABX_WEBVIEW_TEST")) {
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
        .invoke_handler(tauri::generate_handler![
            scan_library,
            prepare_local_media,
            cancel_local_prepare,
            probe_local_audio,
            probe_local_subtitles,
            extract_local_subtitle,
            save_sidecar_subtitle,
            compute_oshash,
            stream::http_fetch,
            stream::http_fetch_bytes,
            shield::sniff_media,
            shield::cancel_sniff,
            shield::shield_stats,
            shield::open_external,
            torrent::torrent_is_supported,
            torrent::torrent_start_stream,
            torrent::torrent_status,
            torrent::torrent_stop,
            downloads::download_default_dir,
            downloads::download_init_root,
            downloads::download_migrate_root,
            downloads::download_start,
            downloads::download_pause,
            downloads::download_pause_all,
            downloads::download_resume,
            downloads::download_resume_all,
            downloads::download_switch_source,
            downloads::download_cancel,
            downloads::download_cancel_all,
            downloads::download_resolve_quality,
            downloads::download_remove,
            downloads::download_clear_failed,
            downloads::download_list,
            downloads::download_open_folder,
            downloads::download_organize_vault,
            prepare_for_update_exit,
            get_window_fullscreen,
            set_window_fullscreen,
            diagnostics::app_ready,
            gateway::stream_gateway,
            diagnostics::reset_safe_mode,
            diagnostics::log_frontend_error
        ])
        .run(context);
    if let Err(e) = result {
        diagnostics::fatal(
            "AbixCine couldn't start",
            &format!(
                "The app window could not be created ({e}).\n\nIf this keeps happening, start AbixCine with \
                 --safe-mode, or update your graphics driver and the Microsoft Edge WebView2 Runtime."
            ),
        );
    }
}
