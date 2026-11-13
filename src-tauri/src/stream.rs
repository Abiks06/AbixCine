//! Stream proxy and HTTP helper.
//!
//! Video hosts usually refuse requests that don't carry the embed page's Referer/Origin,
//! and a webview can't set those headers itself. Everything AbixCine plays directly goes
//! through the `abxs:` scheme instead: Rust fetches the URL with the right headers, and for
//! HLS playlists rewrites every nested URI (variants, segments, keys, subtitles) so those
//! come back through the proxy too. The webview only ever talks to a same-machine origin,
//! so there are no CORS or mixed-content problems and no third-party page is ever loaded.

use base64::{engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64}, Engine};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::OnceLock, time::Duration};
use tauri::http::{header, Request, Response, StatusCode};

pub const UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// The proxy as the webview addresses it (WebView2 maps custom schemes to http://<scheme>.localhost).
pub const PROXY_BASE: &str = if cfg!(windows) { "http://abxs.localhost" } else { "abxs://localhost" };

/// Upper bound for one proxied byte range of a progressive file, so an open-ended
/// `Range: bytes=N-` doesn't make us buffer a whole movie.
const RANGE_CHUNK: u64 = 6 * 1024 * 1024;
/// Maximum byte offset we are willing to discard from a `200 OK` body if upstream ignores `Range`.
const MAX_RANGE_SKIP: u64 = RANGE_CHUNK * 4;

/// Playlists fetched while verifying a capture, kept briefly so the player's first request is
/// answered instantly (the slow part on a new host is the connection, which is now warm too).
static PLAYLISTS: std::sync::Mutex<Option<HashMap<String, (std::time::Instant, String, Vec<u8>)>>> = std::sync::Mutex::new(None);
const PLAYLIST_TTL: Duration = Duration::from_secs(60);
const EXP_BUFFER_MS: u64 = 5_000;

fn parse_epoch_ms(raw: &str) -> Option<u64> {
    let s = raw.trim();
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ms = match s.len() {
        10 => s.parse::<u64>().ok()?.checked_mul(1000)?,
        13 => s.parse::<u64>().ok()?,
        _ => return None,
    };
    // Plausible token window: 2020-01-01 to 2100-01-01
    (1_577_836_800_000..=4_102_444_800_000).contains(&ms).then_some(ms)
}

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn is_url_token_expired_at(raw_url: &str, now_ms: u64) -> bool {
    let Ok(u) = url::Url::parse(raw_url) else {
        return false;
    };
    for (k, v) in u.query_pairs() {
        let kl = k.to_ascii_lowercase();
        if matches!(
            kl.as_str(),
            "exp" | "expires" | "e" | "token_exp" | "validto" | "endtime" | "etime" | "until"
        ) {
            if let Some(exp_ms) = parse_epoch_ms(&v) {
                if exp_ms <= now_ms.saturating_add(EXP_BUFFER_MS) {
                    return true;
                }
            }
        }
    }
    let path = u.path().to_ascii_lowercase();
    for key in ["exp", "expires", "validto"] {
        for sep in ['=', '/'] {
            let needle = format!("{key}{sep}");
            let mut scan = path.as_str();
            while let Some(pos) = scan.find(&needle) {
                let preceded_ok = pos == 0 || matches!(scan.as_bytes()[pos - 1], b'/' | b'=' | b';');
                let after = &scan[pos + needle.len()..];
                if preceded_ok {
                    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Some(exp_ms) = parse_epoch_ms(&digits) {
                        let rest_ok = after[digits.len()..]
                            .chars()
                            .next()
                            .is_none_or(|c| matches!(c, '/' | ';' | '&'));
                        if rest_ok && exp_ms <= now_ms.saturating_add(EXP_BUFFER_MS) {
                            return true;
                        }
                    }
                }
                scan = after;
            }
        }
    }
    false
}

fn playlist_body_has_expired_token(body: &[u8], base_url: &str, now_ms: u64) -> bool {
    let Ok(base) = url::Url::parse(base_url) else {
        return false;
    };
    let text = String::from_utf8_lossy(body);
    if !text.trim_start_matches('\u{feff}').trim_start().starts_with("#EXTM3U") {
        return false;
    }
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if l.starts_with('#') {
            let mut rest = l;
            while let Some(i) = rest.find("URI=\"") {
                let after = &rest[i + 5..];
                let Some(end) = after.find('"') else {
                    break;
                };
                let resolved = resolve(&base, &after[..end]);
                if is_url_token_expired_at(&resolved, now_ms) {
                    return true;
                }
                rest = &after[end + 1..];
            }
        } else {
            let resolved = resolve(&base, l);
            if is_url_token_expired_at(&resolved, now_ms) {
                return true;
            }
        }
    }
    false
}

fn cached_playlist(url: &str) -> Option<(String, Vec<u8>)> {
    cached_playlist_at(url, now_epoch_ms())
}

fn cached_playlist_at(url: &str, now_ms: u64) -> Option<(String, Vec<u8>)> {
    if is_url_token_expired_at(url, now_ms) {
        if let Ok(mut g) = PLAYLISTS.lock() {
            if let Some(map) = g.as_mut() {
                map.remove(url);
            }
        }
        return None;
    }
    let mut g = PLAYLISTS.lock().ok()?;
    let map = g.as_mut()?;
    let expired = {
        let (at, final_url, body) = map.get(url)?;
        at.elapsed() >= PLAYLIST_TTL
            || is_url_token_expired_at(final_url, now_ms)
            || playlist_body_has_expired_token(body, final_url, now_ms)
    };
    if expired {
        map.remove(url);
        return None;
    }
    let (_, final_url, body) = map.get(url)?;
    Some((final_url.clone(), body.clone()))
}

fn cache_playlist(url: &str, final_url: &str, body: &[u8]) {
    if let Ok(mut g) = PLAYLISTS.lock() {
        let map = g.get_or_insert_with(HashMap::new);
        map.retain(|_, (at, _, _)| at.elapsed() < PLAYLIST_TTL);
        map.insert(url.to_string(), (std::time::Instant::now(), final_url.to_string(), body.to_vec()));
    }
}

pub(crate) fn is_retryable_status(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

fn is_valid_m3u8_body(text: &str) -> bool {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if !trimmed.starts_with("#EXTM3U") {
        return false;
    }
    let lower = trimmed[..trimmed.len().min(2048)].to_ascii_lowercase();
    if lower.contains("<!doctype") || lower.contains("<html") || lower.contains("<script") || lower.contains("cf-browser-verification") || lower.contains("captcha") {
        return false;
    }
    let has_tag = trimmed.contains("#EXT-X-STREAM-INF") || trimmed.contains("#EXTINF");
    let has_uri = trimmed.lines().map(str::trim).any(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with('<'));
    has_tag && has_uri
}

/// Fetch and check a captured HLS playlist from Rust: Some(top resolution or 0) when it's a real
/// playlist, None when the host refuses or answers with something else.
pub async fn verify_playlist(url: &str, h: &Hdrs) -> Option<u32> {
    for attempt in 0..2 {
        let res = apply(client().get(url), h).timeout(Duration::from_secs(10)).send().await.ok()?;
        let status = res.status().as_u16();
        if is_retryable_status(status) && attempt == 0 {
            tokio::time::sleep(Duration::from_millis(1200)).await;
            continue;
        }
        if !res.status().is_success() {
            return None;
        }
        let final_url = res.url().to_string();
        let body = res.bytes().await.ok()?;
        let text = String::from_utf8_lossy(&body);
        if !is_valid_m3u8_body(&text) {
            return None;
        }
        cache_playlist(url, &final_url, &body);
        let top = text
            .match_indices("RESOLUTION=")
            .filter_map(|(i, _)| text[i + 11..].split(|c: char| c == ',' || c == '\n').next())
            .filter_map(|r| r.split('x').nth(1).and_then(|h| h.trim().parse::<u32>().ok()))
            .max()
            .unwrap_or(0);
        return Some(top);
    }
    None
}

pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .user_agent(UA)
            .pool_max_idle_per_host(16)
            .pool_idle_timeout(Duration::from_secs(90))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            // No transparent decompression: some media hosts label raw bytes as gzip, and
            // video gains nothing from it anyway.
            .build()
            .expect("http client")
    })
}

/// Headers a stream host expects, captured from the page that played it.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct Hdrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ua: Option<String>,
}

fn origin_of(uri: &str) -> Option<String> {
    let u = url::Url::parse(uri).ok()?;
    let host = u.host_str()?;
    match u.port() {
        Some(port) => Some(format!("{}://{}:{}", u.scheme(), host, port)),
        None => Some(format!("{}://{}", u.scheme(), host)),
    }
}

fn apply(mut rb: reqwest::RequestBuilder, h: &Hdrs) -> reqwest::RequestBuilder {
    let referer = h.referer.as_deref().filter(|s| !s.is_empty());
    if let Some(r) = referer {
        rb = rb.header(header::REFERER, r);
    }
    let derived_origin = referer.and_then(origin_of);
    if let Some(o) = h.origin.as_deref().filter(|s| !s.is_empty()).or(derived_origin.as_deref()) {
        rb = rb.header(header::ORIGIN, o);
    }
    rb.header(header::USER_AGENT, h.ua.as_deref().filter(|s| !s.is_empty()).unwrap_or(UA))
}

/// Path + query of the proxy URL for a stream (used by the debug harness).
#[allow(dead_code)]
pub fn proxy_path(url: &str, h: &Hdrs) -> String {
    proxied("", url, h)
}

fn proxied(base: &str, url: &str, h: &Hdrs) -> String {
    let hj = serde_json::to_vec(h).unwrap_or_default();
    format!("{base}/p?u={}&h={}", B64.encode(url), B64.encode(hj))
}

fn xml_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Proxy a DASH attribute URL while preserving any unexpanded `$...$` template identifiers
/// (`$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$`) outside Base64 so the client
/// DASH player can substitute them at runtime, and XML-escaping `&` as `&amp;`.
fn proxied_mpd_attr(base: &str, effective_base: &url::Url, val: &str, h: &Hdrs) -> String {
    let unescaped = xml_unescape(val.trim());
    let Some(dollar_idx) = unescaped.find('$') else {
        return xml_escape(&proxied(base, &resolve(effective_base, &unescaped), h));
    };
    let (base_str, tail) = match unescaped[..dollar_idx].rfind('/') {
        Some(slash_idx) => (resolve(effective_base, &unescaped[..=slash_idx]), &unescaped[slash_idx + 1..]),
        None => (effective_base.to_string(), unescaped.as_str()),
    };
    let hj = serde_json::to_vec(h).unwrap_or_default();
    let tail_escaped = tail.replace('&', "%26").replace('#', "%23");
    xml_escape(&format!("{base}/p?u={}&h={}&t={tail_escaped}", B64.encode(base_str), B64.encode(hj)))
}

fn resolve(base_url: &url::Url, reference: &str) -> String {
    base_url.join(reference.trim()).map(|u| u.to_string()).unwrap_or_else(|_| reference.trim().to_string())
}

/// Point every URI in a playlist back at the proxy, with the same headers.
fn rewrite_playlist(text: &str, playlist_url: &str, h: &Hdrs, base: &str) -> String {
    let Ok(pu) = url::Url::parse(playlist_url) else { return text.to_string() };
    let mut out = String::with_capacity(text.len() + 1024);
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            out.push('\n');
            continue;
        }
        if l.starts_with('#') {
            // URI="..." attributes: keys, media renditions, I-frame playlists, maps (may appear more than once per line).
            let mut rest = l;
            while let Some(i) = rest.find("URI=\"") {
                let start = i + 5;
                out.push_str(&rest[..start]);
                let after_prefix = &rest[start..];
                if let Some(len) = after_prefix.find('"') {
                    let uri = &after_prefix[..len];
                    let p = proxied(base, &resolve(&pu, uri), h);
                    out.push_str(&p);
                    out.push('"');
                    rest = &after_prefix[len + 1..];
                } else {
                    rest = after_prefix;
                    break;
                }
            }
            out.push_str(rest);
        } else {
            out.push_str(&proxied(base, &resolve(&pu, l), h));
        }
        out.push('\n');
    }
    out
}

fn rewrite_mpd_tag_attrs(tag_str: &str, effective_base: &url::Url, h: &Hdrs, base: &str) -> String {
    let mut current = tag_str.to_string();
    for attr in ["initialization=\"", "media=\"", "sourceURL=\""] {
        if !current.contains(attr) {
            continue;
        }
        let mut next_out = String::with_capacity(current.len() + 256);
        let mut scan = current.as_str();
        while let Some(pos) = scan.find(attr) {
            let start = pos + attr.len();
            next_out.push_str(&scan[..start]);
            let after_attr = &scan[start..];
            if let Some(end) = after_attr.find('"') {
                let val = after_attr[..end].trim();
                if !val.is_empty() && !val.starts_with("http://abxs.localhost") && !val.starts_with("abxs://localhost") {
                    next_out.push_str(&proxied_mpd_attr(base, effective_base, val, h));
                } else {
                    next_out.push_str(val);
                }
                next_out.push('"');
                scan = &after_attr[end + 1..];
            } else {
                scan = after_attr;
                break;
            }
        }
        next_out.push_str(scan);
        current = next_out;
    }
    current
}

fn tag_matches(tag_str: &str, prefix: &str) -> bool {
    let Some(after) = tag_str.strip_prefix(prefix) else { return false };
    matches!(after.as_bytes().first(), Some(b'>' | b'/' | b' ' | b'\t' | b'\r' | b'\n'))
}

/// Point `<BaseURL>` elements and segment attributes (`initialization`, `media`, `sourceURL`) in a
/// DASH `.mpd` manifest back at the proxy, resolving relative URLs against `manifest_url` with proper
/// `<MPD>` / `<Period>` / `<AdaptationSet>` / `<Representation>` hierarchy scoping and preserving
/// unexpanded `<SegmentTemplate>` tokens (`$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$`).
fn rewrite_mpd(text: &str, manifest_url: &str, h: &Hdrs, base: &str) -> String {
    let Ok(root_base) = url::Url::parse(manifest_url) else {
        return text.to_string();
    };
    struct MpdScope {
        tag: &'static str,
        parent_base: url::Url,
        active_base: url::Url,
        has_base_url: bool,
    }
    let mut stack = vec![MpdScope {
        tag: "MPD",
        parent_base: root_base.clone(),
        active_base: root_base,
        has_base_url: false,
    }];
    let mut out = String::with_capacity(text.len() + 1024);
    let mut rest = text;

    while let Some(lt) = rest.find('<') {
        out.push_str(&rest[..lt]);
        rest = &rest[lt..];

        if rest.starts_with("<!--") {
            if let Some(end) = rest.find("-->") {
                out.push_str(&rest[..end + 3]);
                rest = &rest[end + 3..];
                continue;
            }
        }
        if rest.starts_with("<![CDATA[") {
            if let Some(end) = rest.find("]]>") {
                out.push_str(&rest[..end + 3]);
                rest = &rest[end + 3..];
                continue;
            }
        }

        let Some(gt) = rest.find('>') else {
            out.push_str(rest);
            return out;
        };
        let tag_str = &rest[..=gt];

        // Closing scope tags: pop matching hierarchy level.
        for scope_tag in ["Period", "AdaptationSet", "Representation"] {
            if let Some(after) = tag_str.strip_prefix("</").and_then(|s| s.strip_prefix(scope_tag)) {
                if after.trim_end_matches('>').trim().is_empty() && tag_str.ends_with('>') {
                    if stack.len() > 1 && stack.last().map(|s| s.tag) == Some(scope_tag) {
                        stack.pop();
                    }
                }
            }
        }

        // `<BaseURL>` or `<BaseURL ...>` elements.
        if tag_matches(tag_str, "<BaseURL") {
            out.push_str(tag_str);
            rest = &rest[gt + 1..];
            if tag_str.ends_with("/>") {
                continue;
            }
            if let Some(close) = rest.find("</BaseURL>") {
                let inner = rest[..close].trim();
                if !inner.is_empty() && !inner.starts_with("http://abxs.localhost") && !inner.starts_with("abxs://localhost") {
                    let unescaped = xml_unescape(inner);
                    let scope = stack.last_mut().unwrap();
                    let resolved = resolve(&scope.parent_base, &unescaped);
                    if !scope.has_base_url {
                        if let Ok(next_base) = url::Url::parse(&resolved) {
                            scope.active_base = next_base;
                            scope.has_base_url = true;
                        }
                    }
                    out.push_str(&xml_escape(&proxied(base, &resolved, h)));
                } else {
                    out.push_str(inner);
                }
                out.push_str("</BaseURL>");
                rest = &rest[close + "</BaseURL>".len()..];
            }
            continue;
        }

        // Opening scope tags: push child scope inheriting current active_base.
        for scope_tag in ["Period", "AdaptationSet", "Representation"] {
            let open_prefix = match scope_tag {
                "Period" => "<Period",
                "AdaptationSet" => "<AdaptationSet",
                _ => "<Representation",
            };
            if tag_matches(tag_str, open_prefix) && !tag_str.ends_with("/>") {
                let cur = stack.last().unwrap().active_base.clone();
                stack.push(MpdScope {
                    tag: scope_tag,
                    parent_base: cur.clone(),
                    active_base: cur,
                    has_base_url: false,
                });
                break;
            }
        }

        let effective_base = &stack.last().unwrap().active_base;
        out.push_str(&rewrite_mpd_tag_attrs(tag_str, effective_base, h, base));
        rest = &rest[gt + 1..];
    }
    out.push_str(rest);
    out
}

fn cors(b: tauri::http::response::Builder) -> tauri::http::response::Builder {
    b.header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Timing-Allow-Origin", "*")
}

fn fail(code: StatusCode, msg: &str) -> Response<Vec<u8>> {
    cors(Response::builder().status(code))
        .header(header::CONTENT_TYPE, "text/plain")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

fn query(uri: &tauri::http::Uri) -> HashMap<String, String> {
    uri.query()
        .unwrap_or("")
        .split('&')
        .filter_map(|kv| kv.strip_prefix("amp;").unwrap_or(kv).split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn subtitle_mime_for_path(url: &str) -> Option<&'static str> {
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if path.ends_with(".vtt") {
        Some("text/vtt; charset=utf-8")
    } else if path.ends_with(".srt") {
        Some("application/x-subrip; charset=utf-8")
    } else if path.ends_with(".ass") || path.ends_with(".ssa") {
        Some("text/x-ssa; charset=utf-8")
    } else {
        None
    }
}

fn resolve_proxy_content_type(target: &str, final_url: &str, upstream_ctype: &str) -> Option<String> {
    let essence = upstream_ctype
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let is_generic = essence.is_empty()
        || essence == "text/plain"
        || essence == "application/octet-stream";
    if is_generic {
        if let Some(sub_mime) = subtitle_mime_for_path(final_url).or_else(|| subtitle_mime_for_path(target)) {
            return Some(sub_mime.to_string());
        }
    }
    (!upstream_ctype.trim().is_empty()).then(|| upstream_ctype.trim().to_string())
}

const MPD_SNIFF_WINDOW: usize = 8192;

fn is_video_extension(target: &str) -> bool {
    let path = target.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    [".mp4", ".mkv", ".webm", ".m4v", ".mov"]
        .iter()
        .any(|e| path.ends_with(e))
}

pub(crate) fn parse_byte_range(header: &str) -> Option<(u64, Option<u64>)> {
    let trimmed = header.trim();
    if trimmed.len() < 6 || !trimmed[..6].eq_ignore_ascii_case("bytes=") {
        return None;
    }
    let spec = trimmed[6..].trim();
    if spec.contains(',') {
        return None;
    }
    let (start_s, end_s) = spec.split_once('-')?;
    let start = start_s.trim().parse::<u64>().ok()?;
    let end_s = end_s.trim();
    if end_s.is_empty() {
        return Some((start, None));
    }
    let end = end_s.parse::<u64>().ok()?;
    (end >= start).then_some((start, Some(end)))
}

pub(crate) fn plan_outbound_range(
    raw_range: Option<&str>,
    target: &str,
    looks_playlist: bool,
    looks_dash: bool,
) -> (Option<String>, Option<(u64, u64)>) {
    if let Some(r) = raw_range {
        if !looks_playlist && !looks_dash {
            if let Some((start, opt_end)) = parse_byte_range(r) {
                let max_len = match opt_end {
                    Some(end) => end.saturating_sub(start).saturating_add(1).min(RANGE_CHUNK),
                    None => RANGE_CHUNK,
                };
                let capped_end = start.saturating_add(max_len.saturating_sub(1));
                return (Some(format!("bytes={start}-{capped_end}")), Some((start, max_len)));
            }
        }
        return (Some(r.to_string()), None);
    }
    // A progressive file asked for without a range: answer with the first chunk (206),
    // never the whole movie in one buffered response.
    if is_video_extension(target) {
        return (Some(format!("bytes=0-{}", RANGE_CHUNK - 1)), Some((0, RANGE_CHUNK)));
    }
    (None, None)
}

pub(crate) fn build_content_range(start: u64, len: usize, total: Option<u64>) -> String {
    let end = start.saturating_add(len as u64).saturating_sub(1);
    match total {
        Some(t) => format!("bytes {start}-{end}/{t}"),
        None => format!("bytes {start}-{end}/*"),
    }
}

pub(crate) struct RangeWindow {
    skip_remaining: u64,
    max_bytes: usize,
    buf: Vec<u8>,
    has_more: bool,
}

impl RangeWindow {
    pub(crate) fn new(start: u64, max_bytes: usize) -> Self {
        Self {
            skip_remaining: start,
            max_bytes,
            buf: Vec::with_capacity(max_bytes.min(512 * 1024)),
            has_more: false,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.buf.len()
    }

    pub(crate) fn is_full(&self) -> bool {
        self.buf.len() >= self.max_bytes
    }

    pub(crate) fn mark_has_more(&mut self) {
        self.has_more = true;
    }

    pub(crate) fn push_chunk(&mut self, mut slice: &[u8]) -> bool {
        if self.skip_remaining > 0 {
            let skip = self.skip_remaining.min(slice.len() as u64) as usize;
            self.skip_remaining -= skip as u64;
            slice = &slice[skip..];
            if slice.is_empty() {
                return false;
            }
        }
        let avail = self.max_bytes.saturating_sub(self.buf.len());
        if avail > 0 {
            let take = avail.min(slice.len());
            self.buf.extend_from_slice(&slice[..take]);
            slice = &slice[take..];
        }
        if !slice.is_empty() {
            self.has_more = true;
            return true;
        }
        false
    }

    pub(crate) fn into_parts(self) -> (Vec<u8>, bool) {
        (self.buf, self.has_more)
    }
}

pub(crate) fn should_guard_range_200(
    upstream_status: StatusCode,
    is_manifest_hint: bool,
    requested_range: Option<(u64, u64)>,
    target: &str,
    final_url: &str,
    ctype: &str,
    upstream_cl: Option<u64>,
) -> bool {
    if upstream_status != StatusCode::OK || is_manifest_hint {
        return false;
    }
    if requested_range.is_some() {
        return true;
    }
    let ctype_lower = ctype.to_ascii_lowercase();
    let is_video = is_video_extension(target)
        || is_video_extension(final_url)
        || ctype_lower.starts_with("video/");
    is_video && upstream_cl.is_none_or(|n| n > RANGE_CHUNK * 2)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_media_response(
    upstream_status: StatusCode,
    synthetically_chunked: bool,
    chunk_start: u64,
    upstream_cl: Option<u64>,
    upstream_crange: Option<&str>,
    upstream_accept_ranges: Option<&str>,
    resolved_ctype: Option<String>,
    body: Vec<u8>,
    was_unwrapped: bool,
) -> Response<Vec<u8>> {
    let out_status = if synthetically_chunked {
        StatusCode::PARTIAL_CONTENT
    } else {
        upstream_status
    };
    let mut b = cors(Response::builder().status(out_status));
    if let Some(ct) = resolved_ctype {
        b = b.header(header::CONTENT_TYPE, ct);
    }
    if synthetically_chunked {
        if !was_unwrapped && !body.is_empty() {
            b = b.header(header::CONTENT_RANGE, build_content_range(chunk_start, body.len(), upstream_cl));
        }
        b = b.header(header::ACCEPT_RANGES, "bytes");
        if !was_unwrapped {
            b = b.header(header::CONTENT_LENGTH, body.len().to_string());
        }
    } else {
        if !was_unwrapped {
            if let Some(cr) = upstream_crange {
                b = b.header(header::CONTENT_RANGE, cr);
            }
        }
        if out_status == StatusCode::OK || out_status == StatusCode::PARTIAL_CONTENT {
            let accepts_bytes = out_status == StatusCode::PARTIAL_CONTENT
                || upstream_crange.is_some()
                || !upstream_accept_ranges.is_some_and(|v| v.eq_ignore_ascii_case("none"));
            if accepts_bytes {
                b = b.header(header::ACCEPT_RANGES, "bytes");
            }
            if !was_unwrapped {
                let len = upstream_cl.unwrap_or(body.len() as u64);
                b = b.header(header::CONTENT_LENGTH, len.to_string());
            }
        }
    }
    b.body(body).unwrap()
}

pub async fn handle(req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == tauri::http::Method::OPTIONS {
        return cors(Response::builder().status(StatusCode::NO_CONTENT)).body(Vec::new()).unwrap();
    }
    let q = query(req.uri());
    let Some(raw_target) = q.get("u").and_then(|u| B64.decode(u).ok()).and_then(|b| String::from_utf8(b).ok()) else {
        let raw = q.get("u").cloned().unwrap_or_default();
        let why = B64.decode(&raw).err().map(|e| e.to_string()).unwrap_or_else(|| "not utf-8".into());
        return fail(StatusCode::BAD_REQUEST, &format!("missing url (len {} uri len {}: {why})", raw.len(), req.uri().to_string().len()));
    };
    let target = match q.get("t").filter(|t| !t.is_empty()) {
        Some(t) => {
            let unescaped = t.replace("%26", "&").replace("%23", "#");
            url::Url::parse(&raw_target)
                .ok()
                .map(|b| resolve(&b, &unescaped))
                .unwrap_or_else(|| format!("{raw_target}{unescaped}"))
        }
        None => raw_target,
    };
    let h: Hdrs = q
        .get("h")
        .and_then(|v| B64.decode(v).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Where the webview can reach us. The request URI can't tell us: on Windows wry hands the
    // handler `abxs://localhost/...` even though the page requested `http://abxs.localhost/...`,
    // and a playlist pointing at abxs:// would be unloadable there.
    let base = PROXY_BASE;

    let target_lower = target.to_ascii_lowercase();
    let looks_playlist = target_lower.contains(".m3u8");
    let looks_dash = target_lower.contains(".mpd");
    if let Some((final_url, body)) = cached_playlist(&target) {
        let text = String::from_utf8_lossy(&body);
        let head = &text[..text.len().min(MPD_SNIFF_WINDOW)];
        if looks_dash || head.contains("<MPD") {
            let out = rewrite_mpd(&text, &final_url, &h, base);
            return cors(Response::builder().status(200))
                .header(header::CONTENT_TYPE, "application/dash+xml")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(out.into_bytes())
                .unwrap();
        }
        let out = rewrite_playlist(&text, &final_url, &h, base);
        return cors(Response::builder().status(200))
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(out.into_bytes())
            .unwrap();
    }

    let raw_range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let (outbound_range, requested_range) = plan_outbound_range(raw_range, &target, looks_playlist, looks_dash);
    let can_retry = req.method() == tauri::http::Method::GET;

    let mut res_opt = None;
    for attempt in 0..2 {
        let mut rb = apply(client().get(&target), &h);
        if let Some(ref rng) = outbound_range {
            rb = rb.header(header::RANGE, rng.as_str());
        }
        match rb.send().await {
            Ok(r) => {
                if can_retry && attempt == 0 && is_retryable_status(r.status().as_u16()) {
                    drop(r);
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
                res_opt = Some(r);
                break;
            }
            Err(e) => {
                if can_retry && attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    continue;
                }
                return fail(StatusCode::BAD_GATEWAY, &e.to_string());
            }
        }
    }
    let mut res = match res_opt {
        Some(r) => r,
        None => return fail(StatusCode::BAD_GATEWAY, "upstream retry exhausted"),
    };

    let status = res.status();
    let ctype = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let crange = res
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let upstream_cl = res
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let upstream_accept_ranges = res
        .headers()
        .get(header::ACCEPT_RANGES)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string());
    let final_url = res.url().to_string();

    let ctype_lower = ctype.to_ascii_lowercase();
    let is_manifest_hint = looks_playlist
        || looks_dash
        || ctype_lower.contains("mpegurl")
        || ctype_lower.contains("dash+xml");

    let (body, synthetically_chunked, chunk_start) = if should_guard_range_200(
        status,
        is_manifest_hint,
        requested_range,
        &target,
        &final_url,
        &ctype,
        upstream_cl,
    ) {
        let (start, max_len) = requested_range.unwrap_or((0, RANGE_CHUNK));
        if let Some(total) = upstream_cl {
            if start >= total {
                return cors(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .header(header::ACCEPT_RANGES, "bytes")
                    .body(Vec::new())
                    .unwrap();
            }
        }
        if start > MAX_RANGE_SKIP {
            return fail(StatusCode::BAD_GATEWAY, "upstream ignored Range for large offset");
        }
        let mut window = RangeWindow::new(start, max_len as usize);
        while let Some(chunk) = match res.chunk().await {
            Ok(c) => c,
            Err(e) => return fail(StatusCode::BAD_GATEWAY, &e.to_string()),
        } {
            if window.push_chunk(&chunk) {
                break;
            }
            if window.is_full() {
                if let Some(total) = upstream_cl {
                    if start.saturating_add(window.len() as u64) >= total {
                        break;
                    }
                    window.mark_has_more();
                    break;
                }
            }
        }
        drop(res);
        let (buf, has_more) = window.into_parts();
        if buf.is_empty() && start > 0 {
            return cors(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
                .header(header::CONTENT_RANGE, "bytes */*")
                .header(header::ACCEPT_RANGES, "bytes")
                .body(Vec::new())
                .unwrap();
        }
        let chunked = (has_more || start > 0) && !buf.is_empty();
        (buf, chunked, start)
    } else {
        let bytes = match res.bytes().await {
            Ok(b) => b,
            Err(e) => return fail(StatusCode::BAD_GATEWAY, &e.to_string()),
        };
        (bytes.to_vec(), false, 0)
    };

    if !synthetically_chunked && status.is_success() {
        let is_playlist = looks_playlist
            || ctype_lower.contains("mpegurl")
            || body.starts_with(b"#EXTM3U")
            || body.get(..3) == Some(b"\xEF\xBB\xBF") && body[3..].starts_with(b"#EXTM3U");
        if is_playlist {
            let text = String::from_utf8_lossy(&body);
            let out = rewrite_playlist(&text, &final_url, &h, base);
            return cors(Response::builder().status(status.as_u16()))
                .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(out.into_bytes())
                .unwrap();
        }
        let is_dash = looks_dash
            || ctype_lower.contains("dash+xml")
            || {
                let head = String::from_utf8_lossy(&body[..body.len().min(MPD_SNIFF_WINDOW)]);
                head.contains("<MPD")
            };
        if is_dash {
            let text = String::from_utf8_lossy(&body);
            let out = rewrite_mpd(&text, &final_url, &h, base);
            return cors(Response::builder().status(status.as_u16()))
                .header(header::CONTENT_TYPE, "application/dash+xml")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(out.into_bytes())
                .unwrap();
        }
    }

    // Some hosts disguise MPEG-TS segments as images: strip a PNG/WebP header before the TS sync byte.
    let (body, was_unwrapped) = unwrap_disguised_segment(body);
    let resolved_ctype = if status.is_success() {
        resolve_proxy_content_type(&target, &final_url, &ctype)
    } else {
        (!ctype.trim().is_empty()).then(|| ctype.trim().to_string())
    };
    build_media_response(
        status,
        synthetically_chunked,
        chunk_start,
        upstream_cl,
        crange.as_deref(),
        upstream_accept_ranges.as_deref(),
        resolved_ctype,
        body,
        was_unwrapped,
    )
}

fn unwrap_disguised_segment(body: Vec<u8>) -> (Vec<u8>, bool) {
    let png = body.starts_with(&[0x89, 0x50, 0x4e, 0x47]);
    let webp = body.len() > 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP";
    if !(png || webp) {
        return (body, false);
    }
    // Find the first MPEG-TS sync byte that repeats every 188 bytes.
    let limit = body.len().saturating_sub(188 * 3).min(64 * 1024);
    for i in 0..limit {
        if body[i] == 0x47 && body[i + 188] == 0x47 && body[i + 376] == 0x47 {
            return (body[i..].to_vec(), i > 0);
        }
    }
    (body, false)
}

const MAX_FETCH_BYTES: usize = 20 * 1024 * 1024;

#[derive(Serialize)]
pub struct FetchResult {
    status: u16,
    url: String,
    body: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchBytesResult {
    status: u16,
    url: String,
    body_b64: String,
}

fn validate_http_url(raw_url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw_url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("Unsupported URL scheme: {other}")),
    }
}

fn build_http_request(
    url: &str,
    headers: Option<HashMap<String, String>>,
    method: Option<String>,
    body: Option<String>,
) -> Result<reqwest::RequestBuilder, String> {
    let m = reqwest::Method::from_bytes(method.as_deref().unwrap_or("GET").as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = client().request(m, url).header(header::USER_AGENT, UA);
    for (k, v) in headers.unwrap_or_default() {
        rb = rb.header(k, v);
    }
    if let Some(b) = body {
        rb = rb.body(b);
    }
    Ok(rb)
}

fn encode_fetch_bytes(status: u16, url: String, bytes: &[u8]) -> Result<FetchBytesResult, String> {
    if bytes.len() > MAX_FETCH_BYTES {
        return Err(format!("Response body exceeds {} MiB limit", MAX_FETCH_BYTES / (1024 * 1024)));
    }
    Ok(FetchBytesResult {
        status,
        url,
        body_b64: B64_STD.encode(bytes),
    })
}

/// Fetch a page or API as text from Rust (no CORS, any Referer). Used by direct providers.
#[tauri::command]
pub async fn http_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
    method: Option<String>,
    body: Option<String>,
) -> Result<FetchResult, String> {
    let rb = build_http_request(&url, headers, method, body)?;
    let res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let url = res.url().to_string();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(FetchResult { status, url, body })
}

/// Fetch a remote resource as raw bytes (standard Base64 encoded, 20 MiB cap) so non-UTF-8
/// payloads such as Windows-1252 or UTF-16 subtitles are never lossily decoded before JS sees them.
#[tauri::command]
pub async fn http_fetch_bytes(
    url: String,
    headers: Option<HashMap<String, String>>,
    method: Option<String>,
    body: Option<String>,
) -> Result<FetchBytesResult, String> {
    let parsed = validate_http_url(&url)?;
    let rb = build_http_request(parsed.as_str(), headers, method, body)?;
    let mut res = rb.send().await.map_err(|e| e.to_string())?;
    validate_http_url(res.url().as_str())?;
    if let Some(len) = res.content_length() {
        if len > MAX_FETCH_BYTES as u64 {
            return Err(format!("Response body exceeds {} MiB limit", MAX_FETCH_BYTES / (1024 * 1024)));
        }
    }
    let status = res.status().as_u16();
    let final_url = res.url().to_string();
    let initial_cap = res
        .content_length()
        .and_then(|n| usize::try_from(n).ok())
        .map(|n| n.min(MAX_FETCH_BYTES))
        .unwrap_or(0);
    let mut buf = Vec::with_capacity(initial_cap);
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        if buf.len().saturating_add(chunk.len()) > MAX_FETCH_BYTES {
            return Err(format!("Response body exceeds {} MiB limit", MAX_FETCH_BYTES / (1024 * 1024)));
        }
        buf.extend_from_slice(&chunk);
    }
    encode_fetch_bytes(status, final_url, &buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_relative_and_attribute_uris() {
        let pl = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-CUSTOM:URI=\"a.bin\",FALLBACK,URI=\"b.bin\"\n#EXTINF:4,\nseg1.ts\nhttps://cdn.x/seg2.ts\n";
        let h = Hdrs { referer: Some("https://e.x/".into()), ..Default::default() };
        let out = rewrite_playlist(pl, "https://cdn.x/v/1080/index.m3u8", &h, "http://abxs.localhost");
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[1].starts_with("#EXT-X-KEY:METHOD=AES-128,URI=\"http://abxs.localhost/p?u="));
        assert_eq!(lines[2].matches("http://abxs.localhost/p?u=").count(), 2);
        let seg = lines[4].split("u=").nth(1).unwrap().split('&').next().unwrap();
        assert_eq!(String::from_utf8(B64.decode(seg).unwrap()).unwrap(), "https://cdn.x/v/1080/seg1.ts");
        assert!(lines[5].starts_with("http://abxs.localhost/p?u="));
    }

    #[test]
    fn rewrites_dash_mpd_urls() {
        let mpd = r#"<?xml version="1.0"?><MPD><Period><BaseURL>tracks/</BaseURL><AdaptationSet><SegmentTemplate initialization="init.m4s" media="seg1.m4s"/></AdaptationSet></Period></MPD>"#;
        let h = Hdrs { referer: Some("https://e.x/".into()), ..Default::default() };
        let out = rewrite_mpd(mpd, "https://cdn.x/dash/manifest.mpd", &h, "http://abxs.localhost");
        assert!(out.contains("<BaseURL>http://abxs.localhost/p?u="));
        assert!(out.contains("initialization=\"http://abxs.localhost/p?u="));
        assert!(out.contains("media=\"http://abxs.localhost/p?u="));
        // XML must escape `&` as `&amp;` and never emit bare `&h=`.
        assert!(!out.contains("&h="));
        assert!(out.contains("&amp;h="));
    }

    #[test]
    fn rewrites_dash_mpd_scoped_base_urls_and_segment_templates() {
        let mpd = r#"<?xml version="1.0"?>
<MPD>
  <Period id="p1">
    <BaseURL serviceLocation="cdn1">tracks/</BaseURL>
    <AdaptationSet mimeType="video/mp4">
      <BaseURL>video/</BaseURL>
      <SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <BaseURL serviceLocation="audio">audio/</BaseURL>
      <SegmentTemplate initialization="init-audio.m4s?tok=1&amp;v=2" media="seg-$Time$.m4s"/>
    </AdaptationSet>
  </Period>
</MPD>"#;
        let h = Hdrs { referer: Some("https://e.x/".into()), ..Default::default() };
        let out = rewrite_mpd(mpd, "https://cdn.x/dash/manifest.mpd", &h, "http://abxs.localhost");

        // `<BaseURL serviceLocation="cdn1">` with attributes must be rewritten with XML-escaped `&amp;h=`.
        assert!(out.contains("<BaseURL serviceLocation=\"cdn1\">http://abxs.localhost/p?u="));
        assert!(!out.contains("&h="));
        assert!(!out.contains("&t="));
        // Template tokens must remain unencoded in `&amp;t=` rather than hidden inside Base64 `?u=`.
        assert!(out.contains("&amp;t=init-$RepresentationID$.m4s\""));
        assert!(out.contains("&amp;t=chunk-$RepresentationID$-$Number%05d$.m4s\""));
        assert!(out.contains("&amp;t=seg-$Time$.m4s\""));

        // Verify sibling AdaptationSet `<BaseURL>audio/</BaseURL>` resolved against `tracks/` (not `tracks/video/`)
        // and unescaped `&amp;` before Base64 encoding.
        let audio_init_u = out
            .split("<BaseURL serviceLocation=\"audio\">")
            .nth(1)
            .unwrap()
            .split("initialization=\"http://abxs.localhost/p?u=")
            .nth(1)
            .unwrap()
            .split("&amp;")
            .next()
            .unwrap();
        let decoded_audio_init = String::from_utf8(B64.decode(audio_init_u).unwrap()).unwrap();
        assert_eq!(decoded_audio_init, "https://cdn.x/dash/tracks/audio/init-audio.m4s?tok=1&v=2");
    }

    #[test]
    fn strips_png_wrapper_from_ts() {
        let mut b = vec![0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
        let mut ts = vec![0u8; 188 * 4];
        for k in 0..4 {
            ts[k * 188] = 0x47;
        }
        b.extend(&ts);
        let (unwrapped, stripped) = unwrap_disguised_segment(b);
        assert!(stripped);
        assert_eq!(unwrapped[0], 0x47);
    }

    #[test]
    fn normalizes_subtitle_content_types_for_generic_upstream_headers() {
        assert_eq!(
            resolve_proxy_content_type("https://cdn.x/subs/en.vtt?tok=1", "https://cdn.x/subs/en.vtt?tok=1", ""),
            Some("text/vtt; charset=utf-8".into())
        );
        assert_eq!(
            resolve_proxy_content_type("https://cdn.x/subs/en.srt", "https://cdn.x/subs/en.srt", "text/plain; charset=utf-8"),
            Some("application/x-subrip; charset=utf-8".into())
        );
        assert_eq!(
            resolve_proxy_content_type("https://cdn.x/subs/jp.ASS", "https://cdn.x/subs/jp.ASS", "application/octet-stream"),
            Some("text/x-ssa; charset=utf-8".into())
        );
        assert_eq!(
            resolve_proxy_content_type("https://cdn.x/redirect", "https://cdn.x/final/track.ssa?v=2", "TEXT/PLAIN"),
            Some("text/x-ssa; charset=utf-8".into())
        );
        // Preserves explicit subtitle MIME and non-subtitle generic MIME
        assert_eq!(
            resolve_proxy_content_type("https://cdn.x/subs/en.vtt", "https://cdn.x/subs/en.vtt", "text/vtt; charset=iso-8859-1"),
            Some("text/vtt; charset=iso-8859-1".into())
        );
        assert_eq!(
            resolve_proxy_content_type("https://cdn.x/video.mp4", "https://cdn.x/video.mp4", "application/octet-stream"),
            Some("application/octet-stream".into())
        );
    }

    #[test]
    fn validates_http_fetch_bytes_scheme_cap_and_standard_base64() {
        assert!(validate_http_url("https://sub.wyzie.ru/file.srt").is_ok());
        assert!(validate_http_url("http://example.com/sub.vtt").is_ok());
        for bad in ["file:///etc/passwd", "ftp://example.com/a", "javascript:alert(1)", "abxs://localhost/p", "not a url"] {
            assert!(validate_http_url(bad).is_err(), "expected error for {bad}");
        }

        // Preserve non-UTF-8 raw bytes (Win-1252 0xe9, UTF-16LE BOM 0xff 0xfe) using standard Base64 (+, /, =)
        let raw = vec![0xff, 0xfe, 0x43, 0x00, 0xfb, 0xff, 0xbf, 0xe9];
        let res = encode_fetch_bytes(200, "https://example.com/sub.srt".into(), &raw).unwrap();
        let json = serde_json::to_value(&res).unwrap();
        assert_eq!(json["status"], 200);
        assert_eq!(json["url"], "https://example.com/sub.srt");
        assert!(json.get("bodyB64").is_some(), "expected camelCase bodyB64 field");
        assert!(json.get("body_b64").is_none());
        assert!(res.body_b64.contains('+'));
        assert!(res.body_b64.contains('/'));
        assert!(res.body_b64.ends_with('='));
        let decoded = B64_STD.decode(res.body_b64).unwrap();
        assert_eq!(decoded, raw);

        // Enforce 20 MiB cap
        let oversized = vec![0u8; MAX_FETCH_BYTES + 1];
        assert!(encode_fetch_bytes(200, "https://example.com/huge.srt".into(), &oversized).is_err());
    }

    #[test]
    fn classifies_retryable_upstream_statuses() {
        for s in [429, 500, 502, 503, 504] {
            assert!(is_retryable_status(s), "expected status {s} to be retryable");
        }
        for s in [200, 206, 302, 400, 401, 403, 404, 410, 416] {
            assert!(!is_retryable_status(s), "expected status {s} not to be retryable");
        }
    }

    #[test]
    fn plans_range_requests_and_synthetic_206_windows() {
        assert_eq!(parse_byte_range("bytes=0-"), Some((0, None)));
        assert_eq!(parse_byte_range("Bytes=1024-2047"), Some((1024, Some(2047))));
        assert_eq!(parse_byte_range("bytes=0-10, 20-30"), None);
        assert_eq!(parse_byte_range("bytes=500-100"), None);

        // Open-ended and oversized ranges are capped at RANGE_CHUNK for media; small ranges stay intact
        assert_eq!(
            plan_outbound_range(Some("bytes=0-"), "https://cdn.x/movie.mp4", false, false),
            (Some(format!("bytes=0-{}", RANGE_CHUNK - 1)), Some((0, RANGE_CHUNK)))
        );
        assert_eq!(
            plan_outbound_range(Some("bytes=100-50000000"), "https://cdn.x/movie.mp4", false, false),
            (Some(format!("bytes=100-{}", 100 + RANGE_CHUNK - 1)), Some((100, RANGE_CHUNK)))
        );
        assert_eq!(
            plan_outbound_range(Some("bytes=0-65535"), "https://cdn.x/movie.mp4", false, false),
            (Some("bytes=0-65535".into()), Some((0, 65536)))
        );
        // Video extensions without an incoming Range request the initial chunk
        assert_eq!(
            plan_outbound_range(None, "https://cdn.x/video.mkv?tok=1", false, false),
            (Some(format!("bytes=0-{}", RANGE_CHUNK - 1)), Some((0, RANGE_CHUNK)))
        );
        // Playlists leave Range un-capped
        assert_eq!(
            plan_outbound_range(Some("bytes=0-"), "https://cdn.x/master.m3u8", true, false),
            (Some("bytes=0-".into()), None)
        );

        // Guard triggers when upstream ignores Range and returns 200 OK, or on huge video 200 OK
        assert!(should_guard_range_200(
            StatusCode::OK,
            false,
            Some((0, RANGE_CHUNK)),
            "https://cdn.x/video.mp4",
            "https://cdn.x/video.mp4",
            "video/mp4",
            Some(2_000_000_000),
        ));
        assert!(should_guard_range_200(
            StatusCode::OK,
            false,
            None,
            "https://cdn.x/play?id=1",
            "https://cdn.x/play?id=1",
            "video/mp4",
            Some(RANGE_CHUNK * 2 + 1),
        ));
        assert!(!should_guard_range_200(
            StatusCode::PARTIAL_CONTENT,
            false,
            Some((0, RANGE_CHUNK)),
            "https://cdn.x/video.mp4",
            "https://cdn.x/video.mp4",
            "video/mp4",
            Some(RANGE_CHUNK),
        ));
        assert!(!should_guard_range_200(
            StatusCode::OK,
            true,
            None,
            "https://cdn.x/master.m3u8",
            "https://cdn.x/master.m3u8",
            "application/vnd.apple.mpegurl",
            Some(1024),
        ));

        // RangeWindow slices accurately across chunk boundaries and stops early once excess bytes appear
        let mut w = RangeWindow::new(5, 4);
        assert!(!w.push_chunk(b"012"));
        assert!(!w.push_chunk(b"3456"));
        assert!(w.push_chunk(b"789ABC"));
        let (buf, has_more) = w.into_parts();
        assert_eq!(buf, b"5678");
        assert!(has_more);

        assert_eq!(build_content_range(0, 6_291_456, Some(2_000_000_000)), "bytes 0-6291455/2000000000");
        assert_eq!(build_content_range(100, 500, None), "bytes 100-599/*");
    }

    #[test]
    fn forwards_content_length_and_accept_ranges_cleanly_on_200_and_206() {
        // Synthetic 206 emits 206, Content-Range, Accept-Ranges: bytes, and chunk Content-Length
        let syn = build_media_response(
            StatusCode::OK,
            true,
            0,
            Some(2_000_000_000),
            None,
            None,
            Some("video/mp4".into()),
            vec![1, 2, 3, 4],
            false,
        );
        assert_eq!(syn.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(syn.headers().get(header::CONTENT_RANGE).unwrap(), "bytes 0-3/2000000000");
        assert_eq!(syn.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
        assert_eq!(syn.headers().get(header::CONTENT_LENGTH).unwrap(), "4");

        // Normal 200 preserves Content-Length and exposes Accept-Ranges: bytes
        let ok = build_media_response(
            StatusCode::OK,
            false,
            0,
            Some(1234),
            None,
            None,
            Some("video/mp4".into()),
            vec![0; 1234],
            false,
        );
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
        assert_eq!(ok.headers().get(header::CONTENT_LENGTH).unwrap(), "1234");

        // Unwrapped PNG/WebP TS segment must NOT forward stale upstream Content-Length
        let unwrapped = build_media_response(
            StatusCode::OK,
            false,
            0,
            Some(999),
            None,
            None,
            Some("video/mp2t".into()),
            vec![0x47; 188],
            true,
        );
        assert!(unwrapped.headers().get(header::CONTENT_LENGTH).is_none());
        assert_eq!(unwrapped.headers().get(header::ACCEPT_RANGES).unwrap(), "bytes");
    }

    #[test]
    fn playlist_cache_uses_60s_ttl_and_respects_expired_token_queries() {
        assert_eq!(PLAYLIST_TTL, Duration::from_secs(60));
        let now_ms = 1_750_000_000_000u64;
        let fresh_exp = 1_750_000_120u64; // +120s
        let stale_exp = 1_750_000_002u64; // +2s (within 5s buffer -> expired)

        let fresh_url = format!("https://test-cache.example.com/1/master.m3u8?exp={fresh_exp}");
        let stale_url = format!("https://test-cache.example.com/2/master.m3u8?expires={stale_exp}");
        let nested_stale_url = "https://test-cache.example.com/3/master.m3u8";

        let valid_body = b"#EXTM3U\n#EXTINF:6,\nhttps://cdn.example.com/seg1.ts\n";
        let expired_nested_body = format!(
            "#EXTM3U\n#EXTINF:6,\nhttps://cdn.example.com/seg1.ts?exp={stale_exp}\n"
        );

        cache_playlist(&fresh_url, &fresh_url, valid_body);
        cache_playlist(&stale_url, &stale_url, valid_body);
        cache_playlist(nested_stale_url, nested_stale_url, expired_nested_body.as_bytes());

        assert!(cached_playlist_at(&fresh_url, now_ms).is_some());
        assert!(cached_playlist_at(&stale_url, now_ms).is_none());
        assert!(cached_playlist_at(nested_stale_url, now_ms).is_none());
        assert!(is_url_token_expired_at(&format!("https://cdn.example.com/exp/{stale_exp}/master.m3u8"), now_ms));
    }
}
