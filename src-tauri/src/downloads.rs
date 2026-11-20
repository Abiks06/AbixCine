//! Download manager & auto-sorted offline media vault.
//!
//! Supports:
//! - Direct progressive HTTP downloads with `Range` pause/resume across restarts.
//! - True Rust HLS segment-by-segment downloads (concurrent segment workers, persistent state,
//!   AES-128 & fMP4 `#EXT-X-MAP`, separate audio renditions) followed by bundled `ffmpeg`
//!   stream-copy remux into `.mp4` / `.mkv`.
//! - Automatic human-friendly subfolder sorting (`Movies/`, `Series/`, `Anime/`) compatible
//!   with AbixCine's `localProvider` parser, bundled sidecar subtitles, and `.abixcine/index.json`
//!   offline metadata storage.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

use crate::stream::{self, Hdrs};

const MAX_CONCURRENT_JOBS: usize = 2;
const HLS_SEGMENT_CONCURRENCY: usize = 4;
const PROGRESS_EMIT_MS: u128 = 250;
const SEGMENT_MAX_ATTEMPTS: usize = 3;
const MAX_SUBTITLE_TRACKS: usize = 4;
const MAX_SUBTITLE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ART_BYTES: usize = 4 * 1024 * 1024;
const EVENT_PROGRESS: &str = "abx://download-progress";

static MANAGER: OnceLock<Arc<DownloadManager>> = OnceLock::new();
static DL_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn download_client() -> &'static reqwest::Client {
    DL_CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .user_agent(stream::UA)
            .pool_max_idle_per_host(16)
            .pool_idle_timeout(Duration::from_secs(90))
            .connect_timeout(Duration::from_secs(15))
            // Keep overall request timeout unbounded so large files finish cleanly; stalled sockets fail fast.
            .read_timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 8 {
                    return attempt.error("too many redirects");
                }
                let verdict = match attempt.previous().first() {
                    Some(first) => stream::redirect_allowed(first, attempt.url()),
                    None => stream::check_target_host(attempt.url()).map_err(|_| "redirect to a blocked address"),
                };
                match verdict {
                    Ok(()) => attempt.follow(),
                    Err(why) => attempt.error(why),
                }
            }))
            .dns_resolver(Arc::new(stream::GuardedResolver))
            .build()
            .expect("download http client")
    })
}

/* ------------------------------------------------------------------ models */

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Remuxing,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSubtitleReq {
    pub lang: String,
    pub label: String,
    pub url: String,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub headers: Option<Hdrs>,
    #[serde(default)]
    pub is_forced: Option<bool>,
    #[serde(default)]
    pub is_hearing_impaired: Option<bool>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStartReq {
    pub root: String,
    pub media_key: String,
    pub canonical_key: String,
    pub title: String,
    pub media_kind: String,
    pub is_film: bool,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub season: Option<u32>,
    #[serde(default)]
    pub episode: Option<u32>,
    #[serde(default)]
    pub episode_title: Option<String>,
    #[serde(default)]
    pub audio: Option<String>,
    #[serde(default)]
    pub quality: Option<u32>,
    pub provider_id: String,
    pub provider_name: String,
    pub url: String,
    pub kind: String,
    #[serde(default)]
    pub headers: Hdrs,
    #[serde(default)]
    pub preferred_quality: Option<u32>,
    #[serde(default)]
    pub subtitles: Vec<DownloadSubtitleReq>,
    #[serde(default)]
    pub poster_url: Option<String>,
    #[serde(default)]
    pub backdrop_url: Option<String>,
    #[serde(default)]
    pub media_snapshot: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub root: String,
    pub media_key: String,
    pub canonical_key: String,
    pub title: String,
    pub media_kind: String,
    pub is_film: bool,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub season: Option<u32>,
    #[serde(default)]
    pub episode: Option<u32>,
    #[serde(default)]
    pub episode_title: Option<String>,
    #[serde(default)]
    pub audio: Option<String>,
    #[serde(default)]
    pub quality: Option<u32>,
    pub provider_id: String,
    pub provider_name: String,
    pub url: String,
    pub kind: String,
    #[serde(default)]
    pub headers: Hdrs,
    #[serde(default)]
    pub preferred_quality: Option<u32>,
    #[serde(default)]
    pub subtitles: Vec<DownloadSubtitleReq>,
    #[serde(default)]
    pub poster_url: Option<String>,
    #[serde(default)]
    pub backdrop_url: Option<String>,
    pub status: DownloadStatus,
    #[serde(default)]
    pub stage: Option<String>,
    pub bytes_downloaded: u64,
    #[serde(default)]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub segments_done: Option<u32>,
    #[serde(default)]
    pub segments_total: Option<u32>,
    pub speed_bps: u64,
    #[serde(default)]
    pub eta_sec: Option<u64>,
    pub percent: f64,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub media_snapshot: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJobView {
    pub id: String,
    pub root: String,
    pub media_key: String,
    pub canonical_key: String,
    pub title: String,
    pub media_kind: String,
    pub is_film: bool,
    pub year: Option<u32>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub episode_title: Option<String>,
    pub audio: Option<String>,
    pub quality: Option<u32>,
    pub provider_id: String,
    pub provider_name: String,
    pub url: String,
    pub kind: String,
    pub status: DownloadStatus,
    pub stage: Option<String>,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub segments_done: Option<u32>,
    pub segments_total: Option<u32>,
    pub speed_bps: u64,
    pub eta_sec: Option<u64>,
    pub percent: f64,
    pub file_path: Option<String>,
    pub error: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl From<&DownloadJob> for DownloadJobView {
    fn from(j: &DownloadJob) -> Self {
        Self {
            id: j.id.clone(),
            root: j.root.clone(),
            media_key: j.media_key.clone(),
            canonical_key: j.canonical_key.clone(),
            title: j.title.clone(),
            media_kind: j.media_kind.clone(),
            is_film: j.is_film,
            year: j.year,
            season: j.season,
            episode: j.episode,
            episode_title: j.episode_title.clone(),
            audio: j.audio.clone(),
            quality: j.quality,
            provider_id: j.provider_id.clone(),
            provider_name: j.provider_name.clone(),
            url: j.url.clone(),
            kind: j.kind.clone(),
            status: j.status,
            stage: j.stage.clone(),
            bytes_downloaded: j.bytes_downloaded,
            total_bytes: j.total_bytes,
            segments_done: j.segments_done,
            segments_total: j.segments_total,
            speed_bps: j.speed_bps,
            eta_sec: j.eta_sec,
            percent: j.percent,
            file_path: j.file_path.clone(),
            error: j.error.clone(),
            created_at: j.created_at,
            updated_at: j.updated_at,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedEntry {
    pub id: String,
    pub media_key: String,
    pub canonical_key: String,
    pub title: String,
    pub media_kind: String,
    pub is_film: bool,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub season: Option<u32>,
    #[serde(default)]
    pub episode: Option<u32>,
    #[serde(default)]
    pub episode_title: Option<String>,
    #[serde(default)]
    pub audio: Option<String>,
    #[serde(default)]
    pub quality: Option<u32>,
    pub provider_id: String,
    pub provider_name: String,
    pub file_path: String,
    pub file_size: u64,
    #[serde(default)]
    pub subtitle_paths: Vec<String>,
    #[serde(default)]
    pub poster_path: Option<String>,
    #[serde(default)]
    pub backdrop_path: Option<String>,
    pub downloaded_at: u64,
    #[serde(default)]
    pub media_snapshot: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSnapshot {
    pub root: Option<String>,
    pub jobs: Vec<DownloadJobView>,
    pub items: Vec<DownloadedEntry>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct QueueStore {
    jobs: Vec<DownloadJob>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct IndexStore {
    items: Vec<DownloadedEntry>,
}

/* ----------------------------------------------------------- path & naming */

fn is_reserved_windows_name(stem: &str) -> bool {
    matches!(
        stem.trim_end().to_ascii_uppercase().as_str(),
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
    )
}

pub(crate) fn sanitize_component(raw: &str) -> String {
    let mut cleaned = String::with_capacity(raw.len());
    let mut last_space = false;
    for ch in raw.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            if !last_space {
                cleaned.push(' ');
                last_space = true;
            }
        } else if ch.is_whitespace() {
            if !last_space {
                cleaned.push(' ');
                last_space = true;
            }
        } else {
            cleaned.push(ch);
            last_space = false;
        }
    }
    let mut trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.len() > 110 {
        let cut = stream::floor_char_boundary(&trimmed, 110);
        trimmed.truncate(cut);
        trimmed = trimmed.trim().trim_end_matches(['.', ' ']).to_string();
    }
    if trimmed.is_empty() {
        return "Untitled".into();
    }
    let base_stem = trimmed.split('.').next().unwrap_or("");
    if is_reserved_windows_name(base_stem) {
        return format!("_{trimmed}");
    }
    trimmed
}

fn title_folder_name(title: &str, year: Option<u32>) -> String {
    let safe = sanitize_component(title);
    match year {
        Some(y) if (1900..=2100).contains(&y) => sanitize_component(&format!("{safe} ({y})")),
        _ => safe,
    }
}

fn audio_tag(audio: Option<&str>) -> Option<&'static str> {
    match audio.map(|a| a.to_ascii_lowercase()).as_deref() {
        Some("sub") => Some("[Sub]"),
        Some("dub") => Some("[Dub]"),
        Some("dual") => Some("[Dual Audio]"),
        _ => None,
    }
}

fn normalize_video_ext(ext: &str) -> &'static str {
    match ext.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
        "mkv" => "mkv",
        "webm" => "webm",
        "m4v" => "m4v",
        "mov" => "mov",
        _ => "mp4",
    }
}

pub(crate) fn infer_direct_ext(url: &str, content_type: Option<&str>) -> &'static str {
    let path_part = url.split(['?', '#']).next().unwrap_or("");
    if let Some(ext) = path_part.rsplit('.').next() {
        let lower = ext.to_ascii_lowercase();
        if matches!(lower.as_str(), "mp4" | "mkv" | "webm" | "m4v" | "mov") {
            return normalize_video_ext(&lower);
        }
    }
    if let Some(ct) = content_type {
        let lower = ct.to_ascii_lowercase();
        if lower.contains("matroska") {
            return "mkv";
        }
        if lower.contains("webm") {
            return "webm";
        }
        if lower.contains("quicktime") {
            return "mov";
        }
    }
    "mp4"
}

pub(crate) fn resolve_target_paths(root: &Path, req: &DownloadStartReq, ext: &str) -> (PathBuf, PathBuf) {
    let safe_ext = normalize_video_ext(ext);
    let safe_title = sanitize_component(&req.title);
    let show_dir = title_folder_name(&req.title, req.year);
    let q_tag = req.quality.filter(|&q| q >= 240).map(|q| format!("[{q}p]"));

    if req.is_film || req.media_kind == "movie" {
        let folder = root.join("Movies").join(&show_dir);
        let mut parts = vec![show_dir.clone()];
        if req.media_kind == "anime" {
            if let Some(a) = audio_tag(req.audio.as_deref()) {
                parts.push(a.to_string());
            }
        }
        if let Some(q) = q_tag {
            parts.push(q);
        }
        let stem = sanitize_component(&parts.join(" "));
        let file = folder.join(format!("{stem}.{safe_ext}"));
        return (folder, file);
    }

    let root_bucket = if req.media_kind == "anime" { "Anime" } else { "Series" };
    let season_num = req.season.unwrap_or(1);
    let ep_num = req.episode.unwrap_or(1);
    let season_dir = if season_num == 0 {
        "Specials".to_string()
    } else {
        format!("Season {season_num:02}")
    };
    let folder = root.join(root_bucket).join(&show_dir).join(season_dir);

    let mut stem = format!("{safe_title} - S{season_num:02}E{ep_num:02}");
    if let Some(ep_title) = req.episode_title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let clean_ep = sanitize_component(ep_title);
        let generic = clean_ep.eq_ignore_ascii_case(&format!("Episode {ep_num}"));
        if !generic && clean_ep != "Untitled" {
            let short_ep = if clean_ep.len() > 48 {
                let cut = stream::floor_char_boundary(&clean_ep, 48);
                clean_ep[..cut].trim().to_string()
            } else {
                clean_ep
            };
            if !short_ep.is_empty() {
                stem.push_str(&format!(" - {short_ep}"));
            }
        }
    }
    if req.media_kind == "anime" {
        if let Some(a) = audio_tag(req.audio.as_deref()) {
            stem.push(' ');
            stem.push_str(a);
        }
    }
    if let Some(q) = q_tag {
        stem.push(' ');
        stem.push_str(&q);
    }
    let clean_stem = sanitize_component(&stem);
    let file = folder.join(format!("{clean_stem}.{safe_ext}"));
    (folder, file)
}

/* ----------------------------------------------------------- HLS playlists */

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HlsVariant {
    pub uri: String,
    pub bandwidth: u64,
    pub height: Option<u32>,
    pub audio_group: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HlsAudioRendition {
    pub group_id: String,
    pub uri: String,
    pub language: Option<String>,
    pub is_default: bool,
    pub autoselect: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HlsKeySpec {
    pub method: String,
    pub uri: Option<String>,
    pub iv: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HlsSegment {
    pub index: usize,
    pub uri: String,
    pub duration: f64,
    pub byte_range: Option<(u64, u64)>,
    pub discontinuity: bool,
    pub key: Option<HlsKeySpec>,
    pub map_uri: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HlsMediaPlaylist {
    pub target_duration: u32,
    pub media_sequence: u64,
    pub segments: Vec<HlsSegment>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct HlsWorkState {
    video_playlist_url: String,
    audio_playlist_url: Option<String>,
    video: HlsMediaPlaylist,
    audio: Option<HlsMediaPlaylist>,
}

fn parse_attr_list(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let bytes = raw.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        while i < len && matches!(bytes[i], b' ' | b'\t' | b',') {
            i += 1;
        }
        let key_start = i;
        while i < len && bytes[i] != b'=' && bytes[i] != b',' {
            i += 1;
        }
        if i >= len || bytes[i] != b'=' {
            continue;
        }
        let key = raw[key_start..i].trim().to_ascii_uppercase();
        i += 1; // skip '='
        let val = if i < len && bytes[i] == b'"' {
            i += 1;
            let start = i;
            while i < len && bytes[i] != b'"' {
                i += 1;
            }
            let s = raw[start..i].to_string();
            if i < len {
                i += 1;
            }
            s
        } else {
            let start = i;
            while i < len && bytes[i] != b',' {
                i += 1;
            }
            raw[start..i].trim().to_string()
        };
        if !key.is_empty() {
            map.insert(key, val);
        }
    }
    map
}

pub(crate) fn parse_master_playlist(text: &str, base_url: &str) -> Result<(Vec<HlsVariant>, Vec<HlsAudioRendition>), String> {
    let base = url::Url::parse(base_url).map_err(|e| format!("Invalid master playlist URL: {e}"))?;
    let mut variants = Vec::new();
    let mut audios = Vec::new();
    let mut pending_inf: Option<HashMap<String, String>> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim().trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA:") {
            let attrs = parse_attr_list(rest);
            if attrs.get("TYPE").map(String::as_str) == Some("AUDIO") {
                if let (Some(group_id), Some(uri)) = (attrs.get("GROUP-ID"), attrs.get("URI")) {
                    if !uri.trim().is_empty() {
                        audios.push(HlsAudioRendition {
                            group_id: group_id.clone(),
                            uri: stream::resolve(&base, uri),
                            language: attrs.get("LANGUAGE").cloned(),
                            is_default: attrs.get("DEFAULT").map(String::as_str) == Some("YES"),
                            autoselect: attrs.get("AUTOSELECT").map(String::as_str) == Some("YES"),
                        });
                    }
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending_inf = Some(parse_attr_list(rest));
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        if let Some(attrs) = pending_inf.take() {
            let bandwidth = attrs
                .get("BANDWIDTH")
                .or_else(|| attrs.get("AVERAGE-BANDWIDTH"))
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            let height = attrs.get("RESOLUTION").and_then(|r| {
                r.split('x')
                    .nth(1)
                    .and_then(|h| h.trim().parse::<u32>().ok())
            });
            let audio_group = attrs.get("AUDIO").cloned();
            variants.push(HlsVariant {
                uri: stream::resolve(&base, line),
                bandwidth,
                height,
                audio_group,
            });
        }
    }

    Ok((variants, audios))
}

pub(crate) fn select_hls_variant(variants: &[HlsVariant], preferred_quality: Option<u32>) -> Option<&HlsVariant> {
    if variants.is_empty() {
        return None;
    }
    let pref = preferred_quality.filter(|&q| q > 0);
    if let Some(cap) = pref {
        let within: Vec<&HlsVariant> = variants
            .iter()
            .filter(|v| v.height.is_some_and(|h| h <= cap))
            .collect();
        if let Some(best) = within
            .into_iter()
            .max_by_key(|v| (v.height.unwrap_or(0), v.bandwidth))
        {
            return Some(best);
        }
    }
    variants
        .iter()
        .max_by_key(|v| (v.height.unwrap_or(0), v.bandwidth))
}

fn select_audio_rendition<'a>(
    audios: &'a [HlsAudioRendition],
    group_id: Option<&str>,
    preferred_audio: Option<&str>,
) -> Option<&'a HlsAudioRendition> {
    let g = group_id?;
    let pool: Vec<&HlsAudioRendition> = audios.iter().filter(|a| a.group_id == g).collect();
    if pool.is_empty() {
        return None;
    }
    if let Some(want) = preferred_audio {
        let want_langs = if want.eq_ignore_ascii_case("dub") {
            ["en", "eng", "english"].as_slice()
        } else {
            ["ja", "jp", "jpn", "japanese"].as_slice()
        };
        if let Some(found) = pool.iter().copied().find(|a| {
            a.language
                .as_deref()
                .is_some_and(|l| want_langs.iter().any(|w| l.eq_ignore_ascii_case(w)))
        }) {
            return Some(found);
        }
    }
    pool.iter()
        .copied()
        .find(|a| a.is_default)
        .or_else(|| pool.iter().copied().find(|a| a.autoselect))
        .or_else(|| pool.first().copied())
}

fn parse_byte_range(raw: &str, prev_end: u64) -> Option<(u64, u64)> {
    let mut parts = raw.trim().splitn(2, '@');
    let len = parts.next()?.trim().parse::<u64>().ok()?;
    if len == 0 {
        return None;
    }
    let offset = match parts.next() {
        Some(off) => off.trim().parse::<u64>().ok()?,
        None => prev_end,
    };
    Some((offset, len))
}

pub(crate) fn parse_media_playlist(text: &str, base_url: &str) -> Result<HlsMediaPlaylist, String> {
    let base = url::Url::parse(base_url).map_err(|e| format!("Invalid playlist URL: {e}"))?;
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if !trimmed.starts_with("#EXTM3U") {
        return Err("Upstream did not return a valid HLS playlist".into());
    }

    let mut target_duration = 6u32;
    let mut media_sequence = 0u64;
    let mut current_key: Option<HlsKeySpec> = None;
    let mut current_map: Option<String> = None;
    let mut pending_dur: Option<f64> = None;
    let mut pending_range: Option<(u64, u64)> = None;
    let mut prev_range_end = 0u64;
    let mut discontinuity = false;
    let mut segments = Vec::new();

    for raw_line in trimmed.lines() {
        let line = raw_line.trim().trim_start_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            if let Ok(d) = rest.trim().parse::<f64>() {
                target_duration = d.ceil().max(1.0) as u32;
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            if let Ok(seq) = rest.trim().parse::<u64>() {
                media_sequence = seq;
            }
            continue;
        }
        if line.starts_with("#EXT-X-SESSION-KEY:") || line.starts_with("#EXT-X-KEY:") {
            let rest = line.split_once(':').map(|(_, r)| r).unwrap_or("");
            let attrs = parse_attr_list(rest);
            let method = attrs
                .get("METHOD")
                .map(|m| m.trim().to_ascii_uppercase())
                .unwrap_or_default();
            let keyformat = attrs
                .get("KEYFORMAT")
                .map(|k| k.to_ascii_lowercase())
                .unwrap_or_default();
            let key_uri = attrs.get("URI").map(String::as_str).unwrap_or("");

            if method.starts_with("SAMPLE-AES")
                || keyformat.contains("widevine")
                || keyformat.contains("playready")
                || key_uri.to_ascii_lowercase().starts_with("skd:")
            {
                return Err("DRM-protected stream cannot be downloaded".into());
            }

            if line.starts_with("#EXT-X-KEY:") {
                if method == "NONE" || method.is_empty() {
                    current_key = None;
                } else if method == "AES-128" {
                    let resolved = if key_uri.is_empty() {
                        None
                    } else {
                        Some(stream::resolve(&base, key_uri))
                    };
                    current_key = Some(HlsKeySpec {
                        method,
                        uri: resolved,
                        iv: attrs.get("IV").cloned(),
                    });
                } else {
                    return Err(format!("Unsupported HLS encryption method: {method}"));
                }
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            let attrs = parse_attr_list(rest);
            if let Some(uri) = attrs.get("URI") {
                current_map = Some(stream::resolve(&base, uri));
            }
            continue;
        }
        if line == "#EXT-X-DISCONTINUITY" {
            discontinuity = true;
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let dur_str = rest.split(',').next().unwrap_or("0").trim();
            pending_dur = dur_str.parse::<f64>().ok().filter(|d| d.is_finite() && *d >= 0.0);
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            if let Some((off, len)) = parse_byte_range(rest, prev_range_end) {
                pending_range = Some((off, len));
                prev_range_end = off.saturating_add(len);
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }

        if let Some(dur) = pending_dur.take() {
            let idx = segments.len();
            segments.push(HlsSegment {
                index: idx,
                uri: stream::resolve(&base, line),
                duration: dur,
                byte_range: pending_range.take(),
                discontinuity,
                key: current_key.clone(),
                map_uri: current_map.clone(),
            });
            discontinuity = false;
        }
    }

    if segments.is_empty() {
        return Err("HLS playlist contains no playable segments".into());
    }

    Ok(HlsMediaPlaylist {
        target_duration,
        media_sequence,
        segments,
    })
}

pub(crate) fn segment_ext(uri: &str) -> &'static str {
    let path = uri.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if path.ends_with(".m4s") {
        "m4s"
    } else if path.ends_with(".mp4") {
        "mp4"
    } else if path.ends_with(".aac") {
        "aac"
    } else {
        "ts"
    }
}

pub(crate) fn build_local_m3u8(
    playlist: &HlsMediaPlaylist,
    prefix: &str,
    map_files: &HashMap<String, String>,
    key_files: &HashMap<String, String>,
) -> String {
    let mut out = String::with_capacity(playlist.segments.len() * 64 + 128);
    out.push_str("#EXTM3U\n");
    out.push_str("#EXT-X-VERSION:6\n");
    out.push_str(&format!("#EXT-X-TARGETDURATION:{}\n", playlist.target_duration.max(1)));
    out.push_str(&format!("#EXT-X-MEDIA-SEQUENCE:{}\n", playlist.media_sequence));

    let mut active_key: Option<(Option<String>, Option<String>)> = None;
    let mut active_map: Option<String> = None;

    for seg in &playlist.segments {
        if seg.discontinuity {
            out.push_str("#EXT-X-DISCONTINUITY\n");
            active_key = None;
            active_map = None;
        }

        let desired_key = seg.key.as_ref().map(|k| {
            let local_uri = k
                .uri
                .as_ref()
                .and_then(|u| key_files.get(u))
                .cloned();
            (local_uri, k.iv.clone())
        });
        if desired_key != active_key {
            match &desired_key {
                None => out.push_str("#EXT-X-KEY:METHOD=NONE\n"),
                Some((Some(uri), iv)) => {
                    if let Some(iv_val) = iv {
                        out.push_str(&format!("#EXT-X-KEY:METHOD=AES-128,URI=\"{uri}\",IV={iv_val}\n"));
                    } else {
                        out.push_str(&format!("#EXT-X-KEY:METHOD=AES-128,URI=\"{uri}\"\n"));
                    }
                }
                Some((None, _)) => out.push_str("#EXT-X-KEY:METHOD=NONE\n"),
            }
            active_key = desired_key;
        }

        let desired_map = seg.map_uri.as_ref().and_then(|u| map_files.get(u)).cloned();
        if desired_map != active_map {
            if let Some(ref map_file) = desired_map {
                out.push_str(&format!("#EXT-X-MAP:URI=\"{map_file}\"\n"));
            }
            active_map = desired_map;
        }

        out.push_str(&format!("#EXTINF:{:.6},\n", seg.duration));
        let ext = segment_ext(&seg.uri);
        out.push_str(&format!("{prefix}_{:06}.{ext}\n", seg.index));
    }
    out.push_str("#EXT-X-ENDLIST\n");
    out
}

/* ----------------------------------------------------------- store helpers */

fn meta_dir(root: &Path) -> PathBuf {
    root.join(".abixcine")
}

fn art_dir(root: &Path) -> PathBuf {
    meta_dir(root).join("art")
}

fn queue_path(root: &Path) -> PathBuf {
    meta_dir(root).join("queue.json")
}

fn index_path(root: &Path) -> PathBuf {
    meta_dir(root).join("index.json")
}

fn write_json_atomic<T: Serialize>(path: &Path, val: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(val).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn load_queue(root: &Path) -> QueueStore {
    let p = queue_path(root);
    let Ok(bytes) = std::fs::read(&p) else {
        return QueueStore::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn load_index(root: &Path) -> IndexStore {
    let p = index_path(root);
    let Ok(bytes) = std::fs::read(&p) else {
        return IndexStore::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn upsert_index_entry(items: &mut Vec<DownloadedEntry>, entry: DownloadedEntry) {
    items.retain(|existing| {
        !(existing.canonical_key == entry.canonical_key
            && existing.season == entry.season
            && existing.episode == entry.episode
            && existing.audio == entry.audio)
            && existing.file_path != entry.file_path
    });
    items.insert(0, entry);
}

fn ensure_path_inside_root(target: &Path, root: &Path) -> Result<PathBuf, String> {
    let canon_root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
    let canon_target = std::fs::canonicalize(target).map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_root) {
        return Err("Refusing to access file outside the Downloads folder".into());
    }
    Ok(canon_target)
}

/* ----------------------------------------------------------- job scheduler */

#[derive(Default)]
struct JobSignals {
    pause: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

struct ManagerState {
    root: Option<PathBuf>,
    jobs: Vec<DownloadJob>,
    items: Vec<DownloadedEntry>,
    queue: VecDeque<String>,
    active: HashMap<String, JobSignals>,
}

impl Default for ManagerState {
    fn default() -> Self {
        Self {
            root: None,
            jobs: Vec::new(),
            items: Vec::new(),
            queue: VecDeque::new(),
            active: HashMap::new(),
        }
    }
}

pub(crate) struct DownloadManager {
    state: Mutex<ManagerState>,
    app: Mutex<Option<tauri::AppHandle>>,
}

impl DownloadManager {
    fn new() -> Self {
        Self {
            state: Mutex::new(ManagerState::default()),
            app: Mutex::new(None),
        }
    }

    fn set_app(&self, app: &tauri::AppHandle) {
        if let Ok(mut g) = self.app.lock() {
            *g = Some(app.clone());
        }
    }

    fn snapshot(&self) -> DownloadSnapshot {
        let g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        DownloadSnapshot {
            root: g.root.as_ref().map(|p| p.to_string_lossy().into_owned()),
            jobs: g.jobs.iter().map(DownloadJobView::from).collect(),
            items: g.items.clone(),
        }
    }

    fn persist_locked(g: &ManagerState) {
        let Some(root) = g.root.as_ref() else { return };
        let _ = write_json_atomic(&queue_path(root), &QueueStore { jobs: g.jobs.clone() });
        let _ = write_json_atomic(&index_path(root), &IndexStore { items: g.items.clone() });
    }

    fn emit_job(&self, job: &DownloadJobView) {
        let handle = self.app.lock().ok().and_then(|g| g.clone());
        if let Some(app) = handle {
            let _ = app.emit(EVENT_PROGRESS, job);
        }
    }

    fn init_root(&self, app: &tauri::AppHandle, dir: &Path) -> Result<DownloadSnapshot, String> {
        self.set_app(app);
        let canonical = crate::register_downloads_root(app, dir)?;
        let _ = std::fs::create_dir_all(meta_dir(&canonical));
        let art = art_dir(&canonical);
        let _ = std::fs::create_dir_all(&art);
        let scope = app.asset_protocol_scope();
        let _ = scope.allow_directory(&art, true);

        let mut q = load_queue(&canonical);
        for j in &mut q.jobs {
            if matches!(
                j.status,
                DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Remuxing
            ) {
                j.status = DownloadStatus::Paused;
                j.stage = Some("Paused (app restarted)".into());
                j.speed_bps = 0;
                j.eta_sec = None;
            }
        }

        let mut idx = load_index(&canonical);
        idx.items.retain(|it| Path::new(&it.file_path).is_file());
        for it in &idx.items {
            if let Some(ref p) = it.poster_path {
                if Path::new(p).is_file() {
                    let _ = scope.allow_file(Path::new(p));
                }
            }
            if let Some(ref b) = it.backdrop_path {
                if Path::new(b).is_file() {
                    let _ = scope.allow_file(Path::new(b));
                }
            }
        }

        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // If another root was open before, signal active tasks to pause cleanly.
        for sig in g.active.values() {
            sig.pause.store(true, Ordering::Relaxed);
        }
        g.root = Some(canonical);
        g.jobs = q.jobs;
        g.items = idx.items;
        g.queue.clear();
        Self::persist_locked(&g);
        Ok(DownloadSnapshot {
            root: g.root.as_ref().map(|p| p.to_string_lossy().into_owned()),
            jobs: g.jobs.iter().map(DownloadJobView::from).collect(),
            items: g.items.clone(),
        })
    }

    fn enqueue(self: &Arc<Self>, app: &tauri::AppHandle, req: DownloadStartReq) -> Result<DownloadJobView, String> {
        self.set_app(app);
        stream::validate_http_url(&req.url)?;

        let root_path = PathBuf::from(&req.root);
        let canonical_root = crate::register_downloads_root(app, &root_path)?;

        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if g.root.as_ref() != Some(&canonical_root) {
            drop(g);
            self.init_root(app, &canonical_root)?;
            g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        }

        // Reuse existing non-cancelled/non-completed active or paused job for the exact target request + url.
        if let Some(existing) = g.jobs.iter_mut().find(|j| {
            j.canonical_key == req.canonical_key
                && j.season == req.season
                && j.episode == req.episode
                && j.audio == req.audio
                && matches!(
                    j.status,
                    DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Remuxing
                )
        }) {
            return Ok(DownloadJobView::from(&*existing));
        }

        let id = format!(
            "dl_{}_{:x}",
            now_ms(),
            stable_id_hash(&[
                req.canonical_key.as_bytes(),
                req.url.as_bytes(),
                &req.season.unwrap_or(0).to_le_bytes(),
                &req.episode.unwrap_or(0).to_le_bytes(),
            ])
        );
        let now = now_ms();
        let job = DownloadJob {
            id: id.clone(),
            root: canonical_root.to_string_lossy().into_owned(),
            media_key: req.media_key,
            canonical_key: req.canonical_key,
            title: req.title,
            media_kind: req.media_kind,
            is_film: req.is_film,
            year: req.year,
            season: req.season,
            episode: req.episode,
            episode_title: req.episode_title,
            audio: req.audio,
            quality: req.quality,
            provider_id: req.provider_id,
            provider_name: req.provider_name,
            url: req.url,
            kind: req.kind,
            headers: req.headers,
            preferred_quality: req.preferred_quality,
            subtitles: req.subtitles,
            poster_url: req.poster_url,
            backdrop_url: req.backdrop_url,
            status: DownloadStatus::Queued,
            stage: Some("Queued".into()),
            bytes_downloaded: 0,
            total_bytes: None,
            segments_done: None,
            segments_total: None,
            speed_bps: 0,
            eta_sec: None,
            percent: 0.0,
            file_path: None,
            error: None,
            created_at: now,
            updated_at: now,
            media_snapshot: req.media_snapshot,
        };
        let view = DownloadJobView::from(&job);
        g.jobs.insert(0, job);
        g.queue.push_back(id);
        Self::persist_locked(&g);
        drop(g);

        self.emit_job(&view);
        self.pump();
        Ok(view)
    }

    fn pause(&self, id: &str) -> Result<Option<DownloadJobView>, String> {
        let view = {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(sig) = g.active.get(id) {
                sig.pause.store(true, Ordering::Relaxed);
            }
            g.queue.retain(|q| q != id);
            let mut out = None;
            if let Some(j) = g.jobs.iter_mut().find(|j| j.id == id) {
                if matches!(j.status, DownloadStatus::Queued | DownloadStatus::Downloading) {
                    j.status = DownloadStatus::Paused;
                    j.stage = Some("Paused".into());
                    j.speed_bps = 0;
                    j.eta_sec = None;
                    j.updated_at = now_ms();
                }
                out = Some(DownloadJobView::from(&*j));
            }
            Self::persist_locked(&g);
            out
        };
        if let Some(ref v) = view {
            self.emit_job(v);
        }
        Ok(view)
    }

    fn resume(self: &Arc<Self>, app: &tauri::AppHandle, id: &str) -> Result<Option<DownloadJobView>, String> {
        self.set_app(app);
        let (view, should_pump) = {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let mut out = None;
            let mut requeue = false;
            if let Some(j) = g.jobs.iter_mut().find(|j| j.id == id) {
                if matches!(j.status, DownloadStatus::Paused | DownloadStatus::Failed) {
                    j.status = DownloadStatus::Queued;
                    j.stage = Some("Queued".into());
                    j.error = None;
                    j.updated_at = now_ms();
                    requeue = true;
                }
                out = Some(DownloadJobView::from(&*j));
            }
            if requeue && !g.queue.iter().any(|q| q == id) && !g.active.contains_key(id) {
                g.queue.push_back(id.to_string());
            }
            Self::persist_locked(&g);
            (out, requeue)
        };
        if let Some(ref v) = view {
            self.emit_job(v);
            if should_pump {
                self.pump();
            }
        }
        Ok(view)
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut cleanup_target: Option<DownloadJob> = None;
        let view = {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(sig) = g.active.get(id) {
                sig.cancel.store(true, Ordering::Relaxed);
            }
            g.queue.retain(|q| q != id);
            let mut out = None;
            if let Some(pos) = g.jobs.iter().position(|j| j.id == id) {
                let is_active = g.active.contains_key(id);
                if is_active {
                    let j = &mut g.jobs[pos];
                    j.status = DownloadStatus::Cancelled;
                    j.stage = Some("Cancelling…".into());
                    j.updated_at = now_ms();
                    out = Some(DownloadJobView::from(&*j));
                } else {
                    cleanup_target = Some(g.jobs.remove(pos));
                }
            }
            Self::persist_locked(&g);
            out
        };
        if let Some(ref job) = cleanup_target {
            cleanup_job_artifacts(job);
        }
        if let Some(ref v) = view {
            self.emit_job(v);
        }
        Ok(())
    }

    fn remove_entry(&self, id: &str, delete_file: bool) -> Result<DownloadSnapshot, String> {
        let removed_entry: Option<DownloadedEntry>;
        let remaining_items: Vec<DownloadedEntry>;
        let root_opt: Option<PathBuf>;
        {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            root_opt = g.root.clone();
            removed_entry = g
                .items
                .iter()
                .position(|it| it.id == id || it.file_path == id)
                .map(|idx| g.items.remove(idx));
            g.jobs.retain(|j| j.id != id);
            remaining_items = g.items.clone();
            Self::persist_locked(&g);
        }

        if delete_file {
            if let (Some(entry), Some(root)) = (removed_entry, root_opt) {
                let p = Path::new(&entry.file_path);
                if let Ok(canon) = ensure_path_inside_root(p, &root) {
                    let _ = std::fs::remove_file(&canon);
                    for sub in &entry.subtitle_paths {
                        if let Ok(sub_c) = ensure_path_inside_root(Path::new(sub), &root) {
                            let _ = std::fs::remove_file(sub_c);
                        }
                    }
                    // Prune empty season / title folders upward without ever removing `root`.
                    let mut cur = canon.parent().map(Path::to_path_buf);
                    while let Some(dir) = cur {
                        if dir == root {
                            break;
                        }
                        if std::fs::remove_dir(&dir).is_err() {
                            break;
                        }
                        cur = dir.parent().map(Path::to_path_buf);
                    }
                }
                remove_orphaned_artwork(&root, &remaining_items, &entry);
            }
        }

        Ok(self.snapshot())
    }

    fn pump(self: &Arc<Self>) {
        loop {
            let (id, job, sig) = {
                let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
                if g.active.len() >= MAX_CONCURRENT_JOBS {
                    break;
                }
                let Some(next_id) = g.queue.pop_front() else {
                    break;
                };
                let Some(job) = g.jobs.iter().find(|j| j.id == next_id).cloned() else {
                    continue;
                };
                let sig = JobSignals::default();
                g.active.insert(next_id.clone(), JobSignals {
                    pause: sig.pause.clone(),
                    cancel: sig.cancel.clone(),
                });
                (next_id, job, sig)
            };

            let mgr = self.clone();
            tauri::async_runtime::spawn(async move {
                mgr.run_job(job, sig).await;
                {
                    let mut g = mgr.state.lock().unwrap_or_else(|e| e.into_inner());
                    g.active.remove(&id);
                    Self::persist_locked(&g);
                }
                mgr.pump();
            });
        }
    }

    fn update_job(&self, id: &str, emit: bool, f: impl FnOnce(&mut DownloadJob)) {
        let view = {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let mut out = None;
            if let Some(j) = g.jobs.iter_mut().find(|j| j.id == id) {
                f(j);
                j.updated_at = now_ms();
                out = Some(DownloadJobView::from(&*j));
            }
            if emit {
                Self::persist_locked(&g);
            }
            out
        };
        if emit {
            if let Some(v) = view {
                self.emit_job(&v);
            }
        }
    }

    async fn run_job(&self, job: DownloadJob, sig: JobSignals) {
        self.update_job(&job.id, true, |j| {
            j.status = DownloadStatus::Downloading;
            j.stage = Some(if j.kind == "hls" { "Fetching playlist…" } else { "Connecting…" }.into());
            j.error = None;
        });

        let root = PathBuf::from(&job.root);
        let outcome = if job.kind == "hls" {
            self.run_hls_job(&job, &root, &sig).await
        } else {
            self.run_direct_job(&job, &root, &sig).await
        };

        match outcome {
            Ok((final_path, final_size)) => {
                let (subtitle_paths, (poster_path, backdrop_path)) = tokio::join!(
                    download_sidecar_subtitles(&final_path, &job.subtitles),
                    cache_title_artwork(
                        &root,
                        &job.canonical_key,
                        job.poster_url.as_deref(),
                        job.backdrop_url.as_deref(),
                    )
                );
                if let Some(app) = self.app.lock().ok().and_then(|g| g.clone()) {
                    let scope = app.asset_protocol_scope();
                    let _ = scope.allow_file(&final_path);
                    for s in &subtitle_paths {
                        let _ = scope.allow_file(Path::new(s));
                    }
                    if let Some(ref p) = poster_path {
                        let _ = scope.allow_file(Path::new(p));
                    }
                    if let Some(ref b) = backdrop_path {
                        let _ = scope.allow_file(Path::new(b));
                    }
                }
                let final_str = final_path.to_string_lossy().into_owned();
                let entry = DownloadedEntry {
                    id: job.id.clone(),
                    media_key: job.media_key.clone(),
                    canonical_key: job.canonical_key.clone(),
                    title: job.title.clone(),
                    media_kind: job.media_kind.clone(),
                    is_film: job.is_film,
                    year: job.year,
                    season: job.season,
                    episode: job.episode,
                    episode_title: job.episode_title.clone(),
                    audio: job.audio.clone(),
                    quality: job.quality,
                    provider_id: job.provider_id.clone(),
                    provider_name: job.provider_name.clone(),
                    file_path: final_str.clone(),
                    file_size: final_size,
                    subtitle_paths,
                    poster_path,
                    backdrop_path,
                    downloaded_at: now_ms(),
                    media_snapshot: job.media_snapshot.clone(),
                };
                let view = {
                    let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    upsert_index_entry(&mut g.items, entry);
                    let mut out = None;
                    if let Some(j) = g.jobs.iter_mut().find(|j| j.id == job.id) {
                        j.status = DownloadStatus::Completed;
                        j.stage = Some("Saved offline".into());
                        j.file_path = Some(final_str);
                        j.bytes_downloaded = final_size;
                        j.total_bytes = Some(final_size);
                        j.speed_bps = 0;
                        j.eta_sec = Some(0);
                        j.percent = 100.0;
                        j.error = None;
                        j.updated_at = now_ms();
                        out = Some(DownloadJobView::from(&*j));
                    }
                    Self::persist_locked(&g);
                    out
                };
                if let Some(v) = view {
                    self.emit_job(&v);
                }
            }
            Err(JobStop::Paused) => {
                self.update_job(&job.id, true, |j| {
                    j.status = DownloadStatus::Paused;
                    j.stage = Some("Paused".into());
                    j.speed_bps = 0;
                    j.eta_sec = None;
                });
            }
            Err(JobStop::Cancelled) => {
                cleanup_job_artifacts(&job);
                let view = {
                    let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
                    let mut out = None;
                    if let Some(pos) = g.jobs.iter().position(|j| j.id == job.id) {
                        let mut removed = g.jobs.remove(pos);
                        removed.status = DownloadStatus::Cancelled;
                        removed.stage = Some("Cancelled".into());
                        out = Some(DownloadJobView::from(&removed));
                    }
                    Self::persist_locked(&g);
                    out
                };
                if let Some(v) = view {
                    self.emit_job(&v);
                }
            }
            Err(JobStop::Failed(msg)) => {
                self.update_job(&job.id, true, |j| {
                    j.status = DownloadStatus::Failed;
                    j.stage = Some("Failed".into());
                    j.speed_bps = 0;
                    j.eta_sec = None;
                    j.error = Some(msg);
                });
            }
        }
    }

    async fn run_direct_job(
        &self,
        job: &DownloadJob,
        root: &Path,
        sig: &JobSignals,
    ) -> Result<(PathBuf, u64), JobStop> {
        let req_meta = start_req_from_job(job);
        let init_ext = infer_direct_ext(&job.url, None);
        let (folder, mut final_path) = resolve_target_paths(root, &req_meta, init_ext);
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|e| JobStop::Failed(e.to_string()))?;

        let file_name = final_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("video.mp4")
            .to_string();
        let mut part_path = folder.join(format!(".{file_name}.abxpart"));

        let mut existing_bytes = tokio::fs::metadata(&part_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);

        let mut attempt_offset = existing_bytes;
        let mut res = loop {
            check_sig(sig)?;
            let mut rb = stream::apply(download_client().get(&job.url), &job.headers);
            if attempt_offset > 0 {
                rb = rb.header(reqwest::header::RANGE, format!("bytes={attempt_offset}-"));
            }
            let r = rb
                .send()
                .await
                .map_err(|e| JobStop::Failed(format!("Download request failed: {e}")))?;

            if r.status().as_u16() == 416 && attempt_offset > 0 {
                attempt_offset = 0;
                existing_bytes = 0;
                let _ = tokio::fs::remove_file(&part_path).await;
                continue;
            }
            if !r.status().is_success() {
                return Err(JobStop::Failed(format!("Server returned HTTP {}", r.status().as_u16())));
            }
            break r;
        };

        // Update extension if Content-Type revealed MKV/WebM on a tokenised URL without file extension.
        if init_ext == "mp4" {
            let ct = res
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok());
            let detected = infer_direct_ext(&job.url, ct);
            if detected != init_ext {
                let (_, updated_final) = resolve_target_paths(root, &req_meta, detected);
                let updated_name = updated_final
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("video.mkv");
                let updated_part = folder.join(format!(".{updated_name}.abxpart"));
                if existing_bytes > 0 {
                    let _ = tokio::fs::rename(&part_path, &updated_part).await;
                }
                final_path = updated_final;
                part_path = updated_part;
            }
        }

        let is_partial = res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        let start_offset = if is_partial { attempt_offset } else { 0 };
        let total_bytes = if is_partial {
            parse_content_range_total(res.headers().get(reqwest::header::CONTENT_RANGE))
                .or_else(|| res.content_length().map(|len| start_offset + len))
        } else {
            res.content_length()
        };

        let mut file = if is_partial && start_offset > 0 {
            tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&part_path)
                .await
                .map_err(|e| JobStop::Failed(e.to_string()))?
        } else {
            tokio::fs::File::create(&part_path)
                .await
                .map_err(|e| JobStop::Failed(e.to_string()))?
        };

        let mut downloaded = start_offset;
        let mut last_emit = Instant::now();
        let mut win_start = Instant::now();
        let mut win_bytes = 0u64;
        let mut ewma_bps = 0f64;

        self.update_job(&job.id, true, |j| {
            j.stage = Some("Downloading file…".into());
            j.bytes_downloaded = downloaded;
            j.total_bytes = total_bytes;
            j.percent = pct(downloaded, total_bytes);
        });

        while let Some(chunk) = res
            .chunk()
            .await
            .map_err(|e| JobStop::Failed(format!("Stream interrupted: {e}")))?
        {
            if sig.cancel.load(Ordering::Relaxed) {
                drop(file);
                let _ = tokio::fs::remove_file(&part_path).await;
                return Err(JobStop::Cancelled);
            }
            if sig.pause.load(Ordering::Relaxed) {
                let _ = file.flush().await;
                let _ = file.sync_data().await;
                return Err(JobStop::Paused);
            }

            file.write_all(&chunk)
                .await
                .map_err(|e| JobStop::Failed(format!("Disk write error: {e}")))?;

            let n = chunk.len() as u64;
            downloaded += n;
            win_bytes += n;

            let win_elapsed = win_start.elapsed().as_secs_f64();
            if win_elapsed >= 0.45 {
                let inst = (win_bytes as f64) / win_elapsed;
                ewma_bps = if ewma_bps <= 0.0 {
                    inst
                } else {
                    ewma_bps * 0.6 + inst * 0.4
                };
                win_start = Instant::now();
                win_bytes = 0;
            }

            if last_emit.elapsed().as_millis() >= PROGRESS_EMIT_MS {
                last_emit = Instant::now();
                let bps = ewma_bps.round() as u64;
                let eta = total_bytes
                    .filter(|&tot| tot > downloaded && bps > 0)
                    .map(|tot| (tot - downloaded) / bps);
                self.update_job(&job.id, true, |j| {
                    j.bytes_downloaded = downloaded;
                    j.total_bytes = total_bytes;
                    j.speed_bps = bps;
                    j.eta_sec = eta;
                    j.percent = pct(downloaded, total_bytes);
                });
            }
        }

        file.flush()
            .await
            .map_err(|e| JobStop::Failed(e.to_string()))?;
        file.sync_data()
            .await
            .map_err(|e| JobStop::Failed(e.to_string()))?;
        drop(file);

        check_sig(sig)?;

        tokio::fs::rename(&part_path, &final_path)
            .await
            .map_err(|e| JobStop::Failed(format!("Could not finalize file: {e}")))?;

        let final_size = tokio::fs::metadata(&final_path)
            .await
            .map(|m| m.len())
            .unwrap_or(downloaded);
        Ok((final_path, final_size))
    }

    async fn run_hls_job(
        &self,
        job: &DownloadJob,
        root: &Path,
        sig: &JobSignals,
    ) -> Result<(PathBuf, u64), JobStop> {
        let req_meta = start_req_from_job(job);
        let (folder, mp4_path) = resolve_target_paths(root, &req_meta, "mp4");
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|e| JobStop::Failed(e.to_string()))?;

        let work_dir = hls_work_dir(&folder, &job.id);
        tokio::fs::create_dir_all(&work_dir)
            .await
            .map_err(|e| JobStop::Failed(e.to_string()))?;

        let state_path = work_dir.join("state.json");
        let work_state = if let Ok(bytes) = tokio::fs::read(&state_path).await {
            match serde_json::from_slice::<HlsWorkState>(&bytes) {
                Ok(s) => s,
                Err(_) => self.fetch_and_save_hls_state(job, &state_path).await?,
            }
        } else {
            self.fetch_and_save_hls_state(job, &state_path).await?
        };

        check_sig(sig)?;

        // Gather unique key & init-map URLs across both video and optional audio playlists.
        let (video_maps, video_keys) = download_aux_hls_assets(
            &work_dir,
            "v",
            &work_state.video,
            &job.headers,
            sig,
        )
        .await?;
        let (audio_maps, audio_keys) = if let Some(ref ap) = work_state.audio {
            download_aux_hls_assets(&work_dir, "a", ap, &job.headers, sig).await?
        } else {
            (HashMap::new(), HashMap::new())
        };

        // Build full list of segments (video + audio) to download concurrently with resume support.
        let mut tasks: Vec<(&HlsSegment, PathBuf)> = Vec::with_capacity(
            work_state.video.segments.len() + work_state.audio.as_ref().map(|a| a.segments.len()).unwrap_or(0),
        );
        for seg in &work_state.video.segments {
            let ext = segment_ext(&seg.uri);
            tasks.push((seg, work_dir.join(format!("vseg_{:06}.{ext}", seg.index))));
        }
        if let Some(ref ap) = work_state.audio {
            for seg in &ap.segments {
                let ext = segment_ext(&seg.uri);
                tasks.push((seg, work_dir.join(format!("aseg_{:06}.{ext}", seg.index))));
            }
        }

        let total_segs = tasks.len() as u32;
        let done_count = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let total_bytes_done = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut pending_indices = Vec::new();
        for (i, (_, path)) in tasks.iter().enumerate() {
            if let Ok(m) = tokio::fs::metadata(path).await {
                if m.len() > 0 {
                    done_count.fetch_add(1, Ordering::Relaxed);
                    total_bytes_done.fetch_add(m.len(), Ordering::Relaxed);
                    continue;
                }
            }
            pending_indices.push(i);
        }

        let initial_done = done_count.load(Ordering::Relaxed);
        let initial_bytes = total_bytes_done.load(Ordering::Relaxed);
        self.update_job(&job.id, true, |j| {
            j.stage = Some(format!("Downloading segments ({initial_done}/{total_segs})…"));
            j.segments_done = Some(initial_done);
            j.segments_total = Some(total_segs);
            j.bytes_downloaded = initial_bytes;
            j.percent = if total_segs > 0 {
                (initial_done as f64 / total_segs as f64) * 95.0
            } else {
                0.0
            };
        });

        let sem = Arc::new(Semaphore::new(HLS_SEGMENT_CONCURRENCY));
        let started_at = Instant::now();
        let baseline_bytes = initial_bytes;
        let last_emit = Arc::new(Mutex::new(Instant::now()));

        let mut join_set = tokio::task::JoinSet::new();
        for idx in pending_indices {
            let (seg, seg_path) = (tasks[idx].0.clone(), tasks[idx].1.clone());
            let sem_c = sem.clone();
            let headers_c = job.headers.clone();
            let pause_flag = sig.pause.clone();
            let cancel_flag = sig.cancel.clone();
            let done_c = done_count.clone();
            let bytes_c = total_bytes_done.clone();

            join_set.spawn(async move {
                let _permit = sem_c
                    .acquire_owned()
                    .await
                    .map_err(|_| JobStop::Failed("Download pool closed".into()))?;
                if cancel_flag.load(Ordering::Relaxed) {
                    return Err(JobStop::Cancelled);
                }
                if pause_flag.load(Ordering::Relaxed) {
                    return Err(JobStop::Paused);
                }
                let seg_bytes = download_single_segment(
                    &seg.uri,
                    seg.byte_range,
                    &seg_path,
                    &headers_c,
                    &pause_flag,
                    &cancel_flag,
                )
                .await?;
                done_c.fetch_add(1, Ordering::Relaxed);
                bytes_c.fetch_add(seg_bytes, Ordering::Relaxed);
                Ok(())
            });
        }

        let mut first_err: Option<JobStop> = None;
        while let Some(res) = join_set.join_next().await {
            match res {
                Ok(Ok(())) => {
                    let should_emit = {
                        let mut lg = last_emit.lock().unwrap_or_else(|e| e.into_inner());
                        if lg.elapsed().as_millis() >= PROGRESS_EMIT_MS {
                            *lg = Instant::now();
                            true
                        } else {
                            false
                        }
                    };
                    if should_emit {
                        let done = done_count.load(Ordering::Relaxed);
                        let bytes = total_bytes_done.load(Ordering::Relaxed);
                        let elapsed = started_at.elapsed().as_secs_f64().max(0.25);
                        let delta_bytes = bytes.saturating_sub(baseline_bytes);
                        let bps = ((delta_bytes as f64) / elapsed).round() as u64;
                        let est_total = if done > 0 && bytes > 0 {
                            Some((bytes as u128 * total_segs as u128 / done as u128) as u64)
                        } else {
                            None
                        };
                        let eta = est_total
                            .filter(|&tot| tot > bytes && bps > 0)
                            .map(|tot| (tot - bytes) / bps);
                        self.update_job(&job.id, true, |j| {
                            j.stage = Some(format!("Downloading segments ({done}/{total_segs})…"));
                            j.segments_done = Some(done);
                            j.segments_total = Some(total_segs);
                            j.bytes_downloaded = bytes;
                            j.total_bytes = est_total;
                            j.speed_bps = bps;
                            j.eta_sec = eta;
                            j.percent = if total_segs > 0 {
                                (done as f64 / total_segs as f64) * 95.0
                            } else {
                                0.0
                            };
                        });
                    }
                }
                Ok(Err(stop)) => {
                    if first_err.is_none() {
                        first_err = Some(stop);
                        join_set.abort_all();
                    }
                }
                Err(join_err) if !join_err.is_cancelled() => {
                    if first_err.is_none() {
                        first_err = Some(JobStop::Failed(join_err.to_string()));
                        join_set.abort_all();
                    }
                }
                Err(_) => {}
            }
        }

        if let Some(stop) = first_err {
            return Err(stop);
        }
        check_sig(sig)?;

        // Write local playlists inside work_dir using strictly relative file names.
        let local_v = work_dir.join("local.m3u8");
        let v_text = build_local_m3u8(&work_state.video, "vseg", &video_maps, &video_keys);
        tokio::fs::write(&local_v, v_text.as_bytes())
            .await
            .map_err(|e| JobStop::Failed(e.to_string()))?;

        let has_audio = if let Some(ref ap) = work_state.audio {
            let local_a = work_dir.join("local_audio.m3u8");
            let a_text = build_local_m3u8(ap, "aseg", &audio_maps, &audio_keys);
            tokio::fs::write(&local_a, a_text.as_bytes())
                .await
                .map_err(|e| JobStop::Failed(e.to_string()))?;
            true
        } else {
            false
        };

        let seg_bytes = total_bytes_done.load(Ordering::Relaxed);
        self.update_job(&job.id, true, |j| {
            j.status = DownloadStatus::Remuxing;
            j.stage = Some("Remuxing container…".into());
            j.segments_done = Some(total_segs);
            j.segments_total = Some(total_segs);
            j.bytes_downloaded = seg_bytes;
            j.speed_bps = 0;
            j.eta_sec = None;
            j.percent = 96.0;
        });

        let app = self
            .app
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .ok_or_else(|| JobStop::Failed("App handle unavailable for remux".into()))?;
        let ffmpeg = crate::ffmpeg_tool(&app, "ffmpeg").map_err(JobStop::Failed)?;
        let mkv_path = resolve_target_paths(root, &req_meta, "mkv").1;

        let work_dir_c = work_dir.clone();
        let mp4_path_c = mp4_path.clone();
        let mkv_path_c = mkv_path.clone();
        let final_out = tauri::async_runtime::spawn_blocking(move || {
            remux_local_hls(&ffmpeg, &work_dir_c, has_audio, &mp4_path_c, &mkv_path_c)
        })
        .await
        .map_err(|e| JobStop::Failed(e.to_string()))?
        .map_err(JobStop::Failed)?;

        let _ = tokio::fs::remove_dir_all(&work_dir).await;
        let final_size = tokio::fs::metadata(&final_out)
            .await
            .map(|m| m.len())
            .unwrap_or(seg_bytes);
        Ok((final_out, final_size))
    }

    async fn fetch_and_save_hls_state(&self, job: &DownloadJob, state_path: &Path) -> Result<HlsWorkState, JobStop> {
        let master_or_media = fetch_text_with_headers(&job.url, &job.headers)
            .await
            .map_err(JobStop::Failed)?;

        let (video_url, audio_url, video_text) = if master_or_media.contains("#EXT-X-STREAM-INF") {
            let (variants, audios) =
                parse_master_playlist(&master_or_media, &job.url).map_err(JobStop::Failed)?;
            let picked = select_hls_variant(&variants, job.preferred_quality.or(job.quality))
                .ok_or_else(|| JobStop::Failed("No playable HLS variants found".into()))?;
            let audio_rend = select_audio_rendition(
                &audios,
                picked.audio_group.as_deref(),
                job.audio.as_deref(),
            );
            let v_txt = fetch_text_with_headers(&picked.uri, &job.headers)
                .await
                .map_err(JobStop::Failed)?;
            (picked.uri.clone(), audio_rend.map(|a| a.uri.clone()), v_txt)
        } else {
            (job.url.clone(), None, master_or_media)
        };

        let video = parse_media_playlist(&video_text, &video_url).map_err(JobStop::Failed)?;
        let audio = if let Some(ref au) = audio_url {
            let a_txt = fetch_text_with_headers(au, &job.headers)
                .await
                .map_err(JobStop::Failed)?;
            Some(parse_media_playlist(&a_txt, au).map_err(JobStop::Failed)?)
        } else {
            None
        };

        let state = HlsWorkState {
            video_playlist_url: video_url,
            audio_playlist_url: audio_url,
            video,
            audio,
        };
        write_json_atomic(state_path, &state).map_err(JobStop::Failed)?;
        Ok(state)
    }
}

enum JobStop {
    Paused,
    Cancelled,
    Failed(String),
}

fn check_sig(sig: &JobSignals) -> Result<(), JobStop> {
    if sig.cancel.load(Ordering::Relaxed) {
        return Err(JobStop::Cancelled);
    }
    if sig.pause.load(Ordering::Relaxed) {
        return Err(JobStop::Paused);
    }
    Ok(())
}

fn pct(done: u64, total: Option<u64>) -> f64 {
    match total {
        Some(t) if t > 0 => ((done as f64 / t as f64) * 100.0).clamp(0.0, 99.9),
        _ => 0.0,
    }
}

fn parse_content_range_total(val: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    let raw = val?.to_str().ok()?;
    let total = raw.rsplit('/').next()?.trim();
    if total == "*" {
        return None;
    }
    total.parse::<u64>().ok()
}

fn hls_work_dir(folder: &Path, job_id: &str) -> PathBuf {
    folder.join(format!(".abx-dl-{job_id}"))
}

fn start_req_from_job(job: &DownloadJob) -> DownloadStartReq {
    DownloadStartReq {
        root: job.root.clone(),
        media_key: job.media_key.clone(),
        canonical_key: job.canonical_key.clone(),
        title: job.title.clone(),
        media_kind: job.media_kind.clone(),
        is_film: job.is_film,
        year: job.year,
        season: job.season,
        episode: job.episode,
        episode_title: job.episode_title.clone(),
        audio: job.audio.clone(),
        quality: job.quality,
        provider_id: job.provider_id.clone(),
        provider_name: job.provider_name.clone(),
        url: job.url.clone(),
        kind: job.kind.clone(),
        headers: job.headers.clone(),
        preferred_quality: job.preferred_quality,
        subtitles: job.subtitles.clone(),
        poster_url: job.poster_url.clone(),
        backdrop_url: job.backdrop_url.clone(),
        media_snapshot: job.media_snapshot.clone(),
    }
}

fn infer_image_ext(url: &str, content_type: Option<&str>) -> &'static str {
    let ct = content_type.unwrap_or("").to_ascii_lowercase();
    if ct.contains("webp") {
        return "webp";
    }
    if ct.contains("png") {
        return "png";
    }
    let clean = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if clean.ends_with(".webp") {
        "webp"
    } else if clean.ends_with(".png") {
        "png"
    } else {
        "jpg"
    }
}

async fn cache_single_artwork(dir: &Path, stem: &str, url_opt: Option<&str>) -> Option<String> {
    let url = url_opt.map(str::trim).filter(|u| !u.is_empty())?;
    for ext in ["jpg", "webp", "png"] {
        let existing = dir.join(format!("{stem}.{ext}"));
        if tokio::fs::metadata(&existing).await.map(|m| m.len() > 0).unwrap_or(false) {
            return Some(existing.to_string_lossy().into_owned());
        }
    }
    if stream::validate_http_url(url).is_err() {
        return None;
    }
    let res = download_client()
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let ct = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let ext = infer_image_ext(url, ct.as_deref());
    let bytes = res.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_ART_BYTES {
        return None;
    }
    tokio::fs::create_dir_all(dir).await.ok()?;
    let final_path = dir.join(format!("{stem}.{ext}"));
    let tmp_path = dir.join(format!(".{stem}.{}.tmp", std::process::id()));
    tokio::fs::write(&tmp_path, &bytes).await.ok()?;
    if tokio::fs::rename(&tmp_path, &final_path).await.is_err() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return None;
    }
    Some(final_path.to_string_lossy().into_owned())
}

async fn cache_title_artwork(
    root: &Path,
    canonical_key: &str,
    poster_url: Option<&str>,
    backdrop_url: Option<&str>,
) -> (Option<String>, Option<String>) {
    let dir = art_dir(root);
    let hash = format!("{:016x}", stable_id_hash(&[canonical_key.as_bytes()]));
    let poster_stem = format!("{hash}_poster");
    let backdrop_stem = format!("{hash}_backdrop");
    tokio::join!(
        cache_single_artwork(&dir, &poster_stem, poster_url),
        cache_single_artwork(&dir, &backdrop_stem, backdrop_url),
    )
}

pub(crate) fn remove_orphaned_artwork(
    root: &Path,
    remaining_items: &[DownloadedEntry],
    removed: &DownloadedEntry,
) {
    for path_opt in [&removed.poster_path, &removed.backdrop_path] {
        let Some(ref path_str) = path_opt else { continue };
        let still_used = remaining_items.iter().any(|it| {
            it.poster_path.as_deref() == Some(path_str.as_str())
                || it.backdrop_path.as_deref() == Some(path_str.as_str())
        });
        if !still_used {
            if let Ok(canon) = ensure_path_inside_root(Path::new(path_str), root) {
                let _ = std::fs::remove_file(canon);
            }
        }
    }
}

fn cleanup_job_artifacts(job: &DownloadJob) {
    let root = PathBuf::from(&job.root);
    let req = start_req_from_job(job);
    for ext in ["mp4", "mkv", "webm", "m4v", "mov"] {
        let (folder, path) = resolve_target_paths(&root, &req, ext);
        if let Some(fname) = path.file_name().and_then(|s| s.to_str()) {
            let _ = std::fs::remove_file(folder.join(format!(".{fname}.abxpart")));
        }
        let _ = std::fs::remove_dir_all(hls_work_dir(&folder, &job.id));
    }
}

async fn fetch_text_with_headers(url: &str, headers: &Hdrs) -> Result<String, String> {
    stream::validate_http_url(url)?;
    let res = stream::apply(download_client().get(url), headers)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch playlist: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Playlist HTTP {}", res.status().as_u16()));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("Failed reading playlist: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn download_aux_hls_assets(
    work_dir: &Path,
    prefix: &str,
    pl: &HlsMediaPlaylist,
    headers: &Hdrs,
    sig: &JobSignals,
) -> Result<(HashMap<String, String>, HashMap<String, String>), JobStop> {
    let mut map_files = HashMap::new();
    let mut key_files = HashMap::new();
    let mut map_idx = 0usize;
    let mut key_idx = 0usize;

    for seg in &pl.segments {
        check_sig(sig)?;
        if let Some(ref uri) = seg.map_uri {
            if !map_files.contains_key(uri) {
                let fname = format!("{prefix}init_{map_idx}.mp4");
                map_idx += 1;
                let dest = work_dir.join(&fname);
                let exists = tokio::fs::metadata(&dest).await.map(|m| m.len() > 0).unwrap_or(false);
                if !exists {
                    download_single_segment(uri, None, &dest, headers, &sig.pause, &sig.cancel).await?;
                }
                map_files.insert(uri.clone(), fname);
            }
        }
        if let Some(ref k) = seg.key {
            if let Some(ref uri) = k.uri {
                if !key_files.contains_key(uri) {
                    let fname = format!("{prefix}key_{key_idx}.key");
                    key_idx += 1;
                    let dest = work_dir.join(&fname);
                    let exists = tokio::fs::metadata(&dest).await.map(|m| m.len() > 0).unwrap_or(false);
                    if !exists {
                        download_single_segment(uri, None, &dest, headers, &sig.pause, &sig.cancel).await?;
                    }
                    key_files.insert(uri.clone(), fname);
                }
            }
        }
    }
    Ok((map_files, key_files))
}

async fn download_single_segment(
    url: &str,
    byte_range: Option<(u64, u64)>,
    dest: &Path,
    headers: &Hdrs,
    pause_flag: &AtomicBool,
    cancel_flag: &AtomicBool,
) -> Result<u64, JobStop> {
    stream::validate_http_url(url).map_err(JobStop::Failed)?;
    let part = dest.with_extension("part");
    let mut last_err = String::new();

    for attempt in 0..SEGMENT_MAX_ATTEMPTS {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(JobStop::Cancelled);
        }
        if pause_flag.load(Ordering::Relaxed) {
            return Err(JobStop::Paused);
        }

        let mut rb = stream::apply(download_client().get(url), headers).timeout(Duration::from_secs(30));
        if let Some((off, len)) = byte_range {
            rb = rb.header(
                reqwest::header::RANGE,
                format!("bytes={off}-{}", off.saturating_add(len).saturating_sub(1)),
            );
        }

        match rb.send().await {
            Ok(res) if res.status().is_success() => {
                match res.bytes().await {
                    Ok(bytes) => {
                        if cancel_flag.load(Ordering::Relaxed) {
                            let _ = tokio::fs::remove_file(&part).await;
                            return Err(JobStop::Cancelled);
                        }
                        if pause_flag.load(Ordering::Relaxed) {
                            let _ = tokio::fs::remove_file(&part).await;
                            return Err(JobStop::Paused);
                        }
                        if let Err(e) = tokio::fs::write(&part, &bytes).await {
                            return Err(JobStop::Failed(e.to_string()));
                        }
                        if let Err(e) = tokio::fs::rename(&part, dest).await {
                            let _ = tokio::fs::remove_file(&part).await;
                            return Err(JobStop::Failed(e.to_string()));
                        }
                        return Ok(bytes.len() as u64);
                    }
                    Err(e) => {
                        last_err = format!("Segment read error: {e}");
                    }
                }
            }
            Ok(res) => {
                let code = res.status().as_u16();
                last_err = format!("Segment HTTP {code}");
                if !stream::is_retryable_status(code) && code != 408 {
                    break;
                }
            }
            Err(e) => {
                last_err = format!("Segment request failed: {e}");
            }
        }

        if attempt + 1 < SEGMENT_MAX_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(450 * (attempt as u64 + 1))).await;
        }
    }

    Err(JobStop::Failed(last_err))
}

fn remux_local_hls(
    ffmpeg: &Path,
    work_dir: &Path,
    has_audio: bool,
    mp4_path: &Path,
    mkv_path: &Path,
) -> Result<PathBuf, String> {
    let tmp_mp4 = mp4_path.with_extension("abxremux.mp4");
    let tmp_mkv = mkv_path.with_extension("abxremux.mkv");
    let _ = std::fs::remove_file(&tmp_mp4);
    let _ = std::fs::remove_file(&tmp_mkv);

    let run_pass = |use_bsf: bool, format: &str, out_path: &Path| -> Result<(), String> {
        let mut cmd = crate::background_command(ffmpeg);
        cmd.current_dir(work_dir)
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
            .args(["-allowed_extensions", "ALL", "-protocol_whitelist", "file,crypto"])
            .args(["-i", "local.m3u8"]);
        if has_audio {
            cmd.args(["-allowed_extensions", "ALL", "-protocol_whitelist", "file,crypto"])
                .args(["-i", "local_audio.m3u8", "-map", "0:v:0", "-map", "1:a:0"]);
        }
        cmd.args(["-c", "copy"]);
        if use_bsf {
            cmd.args(["-bsf:a", "aac_adtstoasc"]);
        }
        if format == "mp4" {
            cmd.args(["-movflags", "+faststart", "-f", "mp4"]);
        } else {
            cmd.args(["-f", "matroska"]);
        }
        cmd.arg(out_path);

        let out = crate::run_background_output(&mut cmd)
            .map_err(|e| format!("Failed to start FFmpeg remux: {e}"))?;
        if out.status.success() && out_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(());
        }
        let _ = std::fs::remove_file(out_path);
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    };

    if run_pass(true, "mp4", &tmp_mp4).is_ok() {
        std::fs::rename(&tmp_mp4, mp4_path).map_err(|e| e.to_string())?;
        return Ok(mp4_path.to_path_buf());
    }
    if run_pass(false, "mp4", &tmp_mp4).is_ok() {
        std::fs::rename(&tmp_mp4, mp4_path).map_err(|e| e.to_string())?;
        return Ok(mp4_path.to_path_buf());
    }
    match run_pass(false, "matroska", &tmp_mkv) {
        Ok(()) => {
            std::fs::rename(&tmp_mkv, mkv_path).map_err(|e| e.to_string())?;
            Ok(mkv_path.to_path_buf())
        }
        Err(err) => Err(format!("FFmpeg remux failed: {err}")),
    }
}

async fn download_sidecar_subtitles(video_path: &Path, subs: &[DownloadSubtitleReq]) -> Vec<String> {
    let mut saved = Vec::new();
    let Some(parent) = video_path.parent() else { return saved };
    let stem = video_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    let mut used_names = HashSet::new();

    for sub in subs.iter().take(MAX_SUBTITLE_TRACKS) {
        let url_lower = sub.url.to_ascii_lowercase();
        if !url_lower.starts_with("http://") && !url_lower.starts_with("https://") {
            continue;
        }
        if stream::validate_http_url(&sub.url).is_err() {
            continue;
        }
        let ext = match sub.format.as_deref().map(|f| f.to_ascii_lowercase()).as_deref() {
            Some("srt") => "srt",
            Some("ass") => "ass",
            Some("ssa") => "ssa",
            Some("vtt") => "vtt",
            _ => {
                let p = sub.url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
                if p.ends_with(".srt") {
                    "srt"
                } else if p.ends_with(".ass") {
                    "ass"
                } else if p.ends_with(".ssa") {
                    "ssa"
                } else {
                    "vtt"
                }
            }
        };
        let lang = sanitize_component(if sub.lang.trim().is_empty() { "und" } else { &sub.lang })
            .to_ascii_lowercase();
        let mut suffix = format!(".{lang}");
        if sub.is_forced == Some(true) {
            suffix.push_str(".forced");
        }
        if sub.is_hearing_impaired == Some(true) {
            suffix.push_str(".sdh");
        }
        let mut candidate_name = format!("{stem}{suffix}.{ext}");
        let mut n = 2usize;
        while !used_names.insert(candidate_name.clone()) {
            candidate_name = format!("{stem}{suffix}.{n}.{ext}");
            n += 1;
        }
        let hdrs = sub.headers.clone().unwrap_or_default();
        if let Ok(res) = stream::apply(download_client().get(&sub.url), &hdrs)
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            if res.status().is_success() {
                if let Ok(bytes) = res.bytes().await {
                    if !bytes.is_empty() && bytes.len() <= MAX_SUBTITLE_BYTES {
                        let out_path = parent.join(&candidate_name);
                        if tokio::fs::write(&out_path, &bytes).await.is_ok() {
                            saved.push(out_path.to_string_lossy().into_owned());
                        }
                    }
                }
            }
        }
    }
    saved
}

fn stable_id_hash(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for b in part.iter().chain(std::iter::once(&0xffu8)) {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

fn manager() -> &'static Arc<DownloadManager> {
    MANAGER.get_or_init(|| Arc::new(DownloadManager::new()))
}

pub(crate) fn pause_all_on_exit() {
    let Some(mgr) = MANAGER.get() else { return };
    let mut g = mgr.state.lock().unwrap_or_else(|e| e.into_inner());
    for sig in g.active.values() {
        sig.pause.store(true, Ordering::Relaxed);
    }
    g.queue.clear();
    for j in &mut g.jobs {
        if matches!(
            j.status,
            DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Remuxing
        ) {
            j.status = DownloadStatus::Paused;
            j.stage = Some("Paused".into());
            j.speed_bps = 0;
            j.eta_sec = None;
        }
    }
    DownloadManager::persist_locked(&g);
}

/* ----------------------------------------------------------- Tauri commands */

#[tauri::command]
pub fn download_default_dir(app: tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .video_dir()
        .or_else(|_| app.path().download_dir())
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    Ok(base.join("AbixCine Downloads").to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn download_init_root(app: tauri::AppHandle, root: String) -> Result<DownloadSnapshot, String> {
    let dir = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || manager().init_root(&app, &dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_start(app: tauri::AppHandle, req: DownloadStartReq) -> Result<DownloadJobView, String> {
    manager().enqueue(&app, req)
}

#[tauri::command]
pub fn download_pause(id: String) -> Result<Option<DownloadJobView>, String> {
    manager().pause(&id)
}

#[tauri::command]
pub async fn download_resume(app: tauri::AppHandle, id: String) -> Result<Option<DownloadJobView>, String> {
    manager().resume(&app, &id)
}

#[tauri::command]
pub fn download_cancel(id: String) -> Result<(), String> {
    manager().cancel(&id)
}

#[tauri::command]
pub async fn download_remove(id: String, delete_file: bool) -> Result<DownloadSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || manager().remove_entry(&id, delete_file))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn download_list() -> DownloadSnapshot {
    manager().snapshot()
}

#[tauri::command]
pub fn download_open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let canon = crate::register_downloads_root(&app, &target)?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe")
            .arg(&canon)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&canon)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&canon)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ------------------------------------------------------------------- tests */

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_req(kind: &str, is_film: bool) -> DownloadStartReq {
        DownloadStartReq {
            root: "D:/Vault".into(),
            media_key: "tmdb:tv:95396".into(),
            canonical_key: "tmdb:tv:95396".into(),
            title: "Severance: Part / One?".into(),
            media_kind: kind.into(),
            is_film,
            year: Some(2022),
            season: Some(1),
            episode: Some(2),
            episode_title: Some("Half Loop".into()),
            audio: Some("sub".into()),
            quality: Some(1080),
            provider_id: "vidlink-direct".into(),
            provider_name: "VidLink".into(),
            url: "https://cdn.example/master.m3u8".into(),
            kind: "hls".into(),
            headers: Hdrs::default(),
            preferred_quality: Some(1080),
            subtitles: Vec::new(),
            poster_url: None,
            backdrop_url: None,
            media_snapshot: serde_json::json!({}),
        }
    }

    #[test]
    fn sanitizes_forbidden_and_reserved_filenames() {
        assert_eq!(sanitize_component("Dune: Part Two / <4K>?"), "Dune Part Two 4K");
        assert_eq!(sanitize_component("...   "), "Untitled");
        assert_eq!(sanitize_component("CON"), "_CON");
        assert_eq!(sanitize_component("nul.mp4"), "_nul.mp4");
        assert_eq!(sanitize_component("Title."), "Title");
        assert!(sanitize_component(&"é".repeat(80)).len() <= 110);
    }

    #[test]
    fn resolves_sorted_subfolders_for_movies_series_and_anime() {
        let root = Path::new("C:/AbixDownloads");

        let movie = DownloadStartReq {
            title: "Dune: Part Two".into(),
            year: Some(2024),
            season: None,
            episode: None,
            episode_title: None,
            ..sample_req("movie", true)
        };
        let (m_dir, m_file) = resolve_target_paths(root, &movie, "mp4");
        assert_eq!(m_dir, root.join("Movies").join("Dune Part Two (2024)"));
        assert_eq!(m_file, m_dir.join("Dune Part Two (2024) [1080p].mp4"));

        let series = sample_req("tv", false);
        let (s_dir, s_file) = resolve_target_paths(root, &series, "mp4");
        assert_eq!(
            s_dir,
            root.join("Series").join("Severance Part One (2022)").join("Season 01")
        );
        assert_eq!(s_file, s_dir.join("Severance Part One - S01E02 - Half Loop [1080p].mp4"));

        let anime = DownloadStartReq {
            title: "Frieren".into(),
            year: Some(2023),
            season: Some(1),
            episode: Some(5),
            episode_title: Some("Episode 5".into()),
            audio: Some("dub".into()),
            quality: Some(720),
            ..sample_req("anime", false)
        };
        let (a_dir, a_file) = resolve_target_paths(root, &anime, "mkv");
        assert_eq!(a_dir, root.join("Anime").join("Frieren (2023)").join("Season 01"));
        assert_eq!(a_file, a_dir.join("Frieren - S01E05 [Dub] [720p].mkv"));
    }

    #[test]
    fn parses_master_playlist_and_picks_preferred_quality_and_audio() {
        let master = r#"#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="jpn",DEFAULT=YES,URI="audio_jpn.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="eng",AUTOSELECT=YES,URI="audio_eng.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="aud"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080,AUDIO="aud"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=9500000,RESOLUTION=3840x2160,AUDIO="aud"
2160p/index.m3u8
"#;
        let (variants, audios) =
            parse_master_playlist(master, "https://cdn.example/show/master.m3u8").unwrap();
        assert_eq!(variants.len(), 3);
        assert_eq!(audios.len(), 2);

        let v1080 = select_hls_variant(&variants, Some(1080)).unwrap();
        assert_eq!(v1080.height, Some(1080));
        assert_eq!(v1080.uri, "https://cdn.example/show/1080p/index.m3u8");

        let dub = select_audio_rendition(&audios, v1080.audio_group.as_deref(), Some("dub")).unwrap();
        assert_eq!(dub.uri, "https://cdn.example/show/audio_eng.m3u8");
    }

    #[test]
    fn parses_media_playlist_with_map_aes128_byterange_and_rejects_drm() {
        let media = r#"#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1",IV=0x0000000000000000000000000000000a
#EXTINF:5.5,
#EXT-X-BYTERANGE:1000@0
seg1.m4s
#EXTINF:4.25,
#EXT-X-BYTERANGE:1200
seg2.m4s
#EXT-X-ENDLIST
"#;
        let pl = parse_media_playlist(media, "https://cdn.example/hls/v.m3u8").unwrap();
        assert_eq!(pl.target_duration, 6);
        assert_eq!(pl.media_sequence, 10);
        assert_eq!(pl.segments.len(), 2);
        assert_eq!(pl.segments[0].byte_range, Some((0, 1000)));
        assert_eq!(pl.segments[1].byte_range, Some((1000, 1200)));
        assert_eq!(pl.segments[0].map_uri.as_deref(), Some("https://cdn.example/hls/init.mp4"));

        let mut maps = HashMap::new();
        maps.insert("https://cdn.example/hls/init.mp4".into(), "vinit_0.mp4".into());
        let mut keys = HashMap::new();
        keys.insert("https://keys.example/k1".into(), "vkey_0.key".into());
        let rewritten = build_local_m3u8(&pl, "vseg", &maps, &keys);
        assert!(rewritten.contains("#EXT-X-MAP:URI=\"vinit_0.mp4\""));
        assert!(rewritten.contains("#EXT-X-KEY:METHOD=AES-128,URI=\"vkey_0.key\""));
        assert!(rewritten.contains("vseg_000000.m4s"));
        assert!(rewritten.contains("vseg_000001.m4s"));
        assert!(rewritten.contains("#EXT-X-ENDLIST"));

        let drm = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://fairplay\"\n#EXTINF:4,\nseg.ts\n";
        assert!(parse_media_playlist(drm, "https://cdn.example/drm.m3u8").is_err());
    }

    #[test]
    fn confines_index_deletion_inside_downloads_root() {
        let base = std::env::temp_dir().join(format!("abx-dl-confinement-{}", std::process::id()));
        let root = base.join("root");
        let outside = base.join("outside.mp4");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&outside, b"keep").unwrap();

        assert!(ensure_path_inside_root(&outside, &root).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn deserializes_phase1_index_without_art_fields() {
        let raw = serde_json::json!({
            "items": [{
                "id": "dl_1",
                "mediaKey": "tmdb:movie:693134",
                "canonicalKey": "tmdb:movie:693134",
                "title": "Dune: Part Two",
                "mediaKind": "movie",
                "isFilm": true,
                "providerId": "vidlink-direct",
                "providerName": "VidLink",
                "filePath": "C:/Downloads/Movies/Dune.mp4",
                "fileSize": 1024,
                "downloadedAt": 1700000000000u64
            }]
        });
        let store: IndexStore = serde_json::from_value(raw).unwrap();
        assert_eq!(store.items.len(), 1);
        assert_eq!(store.items[0].poster_path, None);
        assert_eq!(store.items[0].backdrop_path, None);
    }

    #[test]
    fn cleans_up_orphaned_artwork_only_when_no_other_entry_references_it() {
        let base = std::env::temp_dir().join(format!("abx-art-cleanup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let art = art_dir(&base);
        std::fs::create_dir_all(&art).unwrap();
        let poster_file = art.join("show_poster.jpg");
        let shared_backdrop = art.join("show_backdrop.jpg");
        std::fs::write(&poster_file, b"poster").unwrap();
        std::fs::write(&shared_backdrop, b"backdrop").unwrap();

        let mk = |id: &str, poster: Option<&PathBuf>| DownloadedEntry {
            id: id.into(),
            media_key: "tmdb:tv:1".into(),
            canonical_key: "tmdb:tv:1".into(),
            title: "Show".into(),
            media_kind: "tv".into(),
            is_film: false,
            year: None,
            season: Some(1),
            episode: Some(1),
            episode_title: None,
            audio: None,
            quality: Some(1080),
            provider_id: "vidlink".into(),
            provider_name: "VidLink".into(),
            file_path: base.join(format!("{id}.mp4")).to_string_lossy().into_owned(),
            file_size: 100,
            subtitle_paths: Vec::new(),
            poster_path: poster.map(|p| p.to_string_lossy().into_owned()),
            backdrop_path: Some(shared_backdrop.to_string_lossy().into_owned()),
            downloaded_at: 1,
            media_snapshot: serde_json::json!({}),
        };

        let ep1 = mk("ep1", Some(&poster_file));
        let ep2 = mk("ep2", None);

        // Removing ep1 deletes unreferenced poster_file, keeps shared_backdrop referenced by ep2.
        remove_orphaned_artwork(&base, &[ep2.clone()], &ep1);
        assert!(!poster_file.exists());
        assert!(shared_backdrop.exists());

        // Removing ep2 deletes the now-orphaned shared_backdrop.
        remove_orphaned_artwork(&base, &[], &ep2);
        assert!(!shared_backdrop.exists());

        let _ = std::fs::remove_dir_all(&base);
    }
}
