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
/// The most a single non-windowed proxied response may buffer (segments and manifests are far smaller).
const MAX_BUFFERED_BODY: usize = (RANGE_CHUNK * 4) as usize;

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

fn find_next_uri_attr(s: &str) -> Option<usize> {
    let mut offset = 0;
    while let Some(rel) = s[offset..].find("URI=\"") {
        let idx = offset + rel;
        if idx == 0 || matches!(s.as_bytes()[idx - 1], b':' | b',' | b' ' | b'\t') {
            return Some(idx);
        }
        offset = idx + 5;
    }
    None
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
        let l = line.trim().trim_start_matches('\u{feff}').trim();
        if l.is_empty() {
            continue;
        }
        if l.starts_with('#') {
            let mut rest = l;
            while let Some(i) = find_next_uri_attr(rest) {
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

/// A cached playlist is only reused for a request with the same Referer/Origin: hosts that bind
/// tokens to the embedding page answer differently per page. (UA is left out: callers normalise it
/// differently, and a miss only costs one refetch.)
fn playlist_key(url: &str, h: &Hdrs) -> String {
    format!(
        "{url}\u{1}{}\u{1}{}",
        h.referer.as_deref().unwrap_or(""),
        h.origin.as_deref().unwrap_or("")
    )
}

fn cached_playlist(url: &str, h: &Hdrs) -> Option<(String, Vec<u8>)> {
    cached_playlist_at(url, h, now_epoch_ms())
}

fn cached_playlist_at(url: &str, h: &Hdrs, now_ms: u64) -> Option<(String, Vec<u8>)> {
    let key = playlist_key(url, h);
    let forget = || {
        if let Ok(mut g) = PLAYLISTS.lock() {
            if let Some(map) = g.as_mut() {
                map.remove(&key);
            }
        }
    };
    if is_url_token_expired_at(url, now_ms) {
        forget();
        return None;
    }
    // Copy out under the lock, then scan the body for expired tokens without holding it: that
    // scan parses every line and used to stall every other proxied request meanwhile.
    let (at, final_url, body) = {
        let g = PLAYLISTS.lock().ok()?;
        let (at, final_url, body) = g.as_ref()?.get(&key)?;
        (*at, final_url.clone(), body.clone())
    };
    let expired = at.elapsed() >= PLAYLIST_TTL
        || is_url_token_expired_at(&final_url, now_ms)
        || playlist_body_has_expired_token(&body, &final_url, now_ms);
    if expired {
        forget();
        return None;
    }
    Some((final_url, body))
}

const MAX_PLAYLIST_CACHE: usize = 64;

fn url_path_lower(url: &str) -> String {
    if let Ok(u) = url::Url::parse(url) {
        return u.path().to_ascii_lowercase();
    }
    url.split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

pub(crate) fn looks_like_hls_url(url: &str) -> bool {
    let path = url_path_lower(url);
    path.ends_with(".m3u8") || path.contains(".m3u8/")
}

pub(crate) fn looks_like_dash_url(url: &str) -> bool {
    let path = url_path_lower(url);
    path.ends_with(".mpd") || path.contains(".mpd/")
}

pub(crate) fn is_extm3u_bytes(body: &[u8]) -> bool {
    let stripped = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    let idx = stripped.iter().position(|b| !b.is_ascii_whitespace());
    idx.is_some_and(|i| stripped[i..].starts_with(b"#EXTM3U"))
}

fn looks_like_binary_media_path(url: &str) -> bool {
    let path = url_path_lower(url);
    matches!(
        path.rsplit('.').next(),
        Some("ts" | "m4s" | "mp4" | "m4v" | "m4a" | "aac" | "mp3" | "webm" | "mkv" | "avi" | "mov" | "vtt" | "srt" | "ass")
    ) && !path.ends_with(".m3u8")
        && !path.ends_with(".mpd")
}

fn looks_like_html_doc(text: &str) -> bool {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    let lower = trimmed[..floor_char_boundary(trimmed, 2048)].to_ascii_lowercase();
    lower.contains("<!doctype")
        || lower.contains("<html")
        || lower.contains("<script")
        || lower.contains("cf-browser-verification")
        || lower.contains("captcha")
}

fn cache_playlist(url: &str, h: &Hdrs, final_url: &str, body: &[u8]) {
    let url = playlist_key(url, h);
    let url = url.as_str();
    if let Ok(mut g) = PLAYLISTS.lock() {
        let map = g.get_or_insert_with(HashMap::new);
        map.retain(|_, (at, _, _)| at.elapsed() < PLAYLIST_TTL);
        if map.len() >= MAX_PLAYLIST_CACHE && !map.contains_key(url) {
            if let Some(oldest_key) = map
                .iter()
                .max_by_key(|(_, (at, _, _))| at.elapsed())
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest_key);
            }
        }
        map.insert(url.to_string(), (std::time::Instant::now(), final_url.to_string(), body.to_vec()));
    }
}

pub(crate) fn is_retryable_status(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

/// The largest index <= `max` that falls on a char boundary, so a byte window over untrusted
/// text can never split a multi-byte character (which panics).
pub(crate) fn floor_char_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn is_valid_m3u8_body(text: &str) -> bool {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if !trimmed.starts_with("#EXTM3U") || looks_like_html_doc(trimmed) {
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
        // Only a plain 200 is a whole playlist worth replaying to the player.
        let cacheable = res.status() == reqwest::StatusCode::OK;
        let final_url = res.url().to_string();
        let body = res.bytes().await.ok()?;
        let text = String::from_utf8_lossy(&body);
        if !is_valid_m3u8_body(&text) {
            return None;
        }
        if cacheable {
            cache_playlist(url, h, &final_url, &body);
        }
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
            // A stalled socket gives up quickly; a slow but steady large read still finishes.
            .read_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(120))
            // Every hop is re-checked against the same rules as the first URL (see the SSRF guard).
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 8 {
                    return attempt.error("too many redirects");
                }
                let verdict = match attempt.previous().first() {
                    Some(first) => redirect_allowed(first, attempt.url()),
                    None => check_target_host(attempt.url()).map_err(|_| "redirect to a blocked address"),
                };
                match verdict {
                    Ok(()) => attempt.follow(),
                    Err(why) => attempt.error(why),
                }
            }))
            // Public names may not resolve into the LAN, on the first request or any redirect hop.
            .dns_resolver(GuardedResolver)
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
    // A template inside the query (`seg?path=/a/b/$Number$.m4s`) must not be split at a `/` of the
    // query: the base would lose its query when the proxy re-joins it. Split right at the `$` instead;
    // the proxy then appends the tail verbatim (see `join_template`).
    let query_idx = unescaped.find('?').filter(|&q| q < dollar_idx);
    let (base_str, tail) = match (query_idx, unescaped[..dollar_idx].rfind('/')) {
        (Some(_), _) => (resolve(effective_base, &unescaped[..dollar_idx]), &unescaped[dollar_idx..]),
        (None, Some(slash_idx)) => (resolve(effective_base, &unescaped[..=slash_idx]), &unescaped[slash_idx + 1..]),
        (None, None) => (effective_base.to_string(), unescaped.as_str()),
    };
    let hj = serde_json::to_vec(h).unwrap_or_default();
    let tail_escaped = escape_tail(tail);
    xml_escape(&format!("{base}/p?u={}&h={}&t={tail_escaped}", B64.encode(base_str), B64.encode(hj)))
}

/// Escape a template tail for the `t=` parameter: `%` (so a literal `%26` in a token survives the
/// round trip), `&` and `#`. Text inside `$...$` identifiers is left alone: the DASH player must
/// still see `$Number%05d$` verbatim to substitute it.
fn escape_tail(tail: &str) -> String {
    let mut out = String::with_capacity(tail.len() + 8);
    let mut in_ident = false;
    for ch in tail.chars() {
        match ch {
            '$' => {
                in_ident = !in_ident;
                out.push(ch);
            }
            '%' if !in_ident => out.push_str("%25"),
            '&' if !in_ident => out.push_str("%26"),
            '#' if !in_ident => out.push_str("%23"),
            _ => out.push(ch),
        }
    }
    out
}

fn unescape_tail(t: &str) -> String {
    t.replace("%26", "&").replace("%23", "#").replace("%25", "%")
}

/// Rebuild a templated DASH URL: a base that carries a query gets the tail appended verbatim
/// (joining would drop the query); otherwise the tail resolves against the base as a URL.
fn join_template(raw_base: &str, tail: &str) -> String {
    if raw_base.contains('?') {
        return format!("{raw_base}{tail}");
    }
    url::Url::parse(raw_base)
        .ok()
        .map(|b| resolve(&b, tail))
        .unwrap_or_else(|| format!("{raw_base}{tail}"))
}

/// Inline or DRM key URIs are not fetchable through the proxy: leave them as they are.
fn is_unproxyable_uri(uri: &str) -> bool {
    let lower = uri.trim_start().get(..6).unwrap_or(uri).to_ascii_lowercase();
    lower.starts_with("data:") || lower.starts_with("skd:") || lower.starts_with("blob:")
}

fn resolve(base_url: &url::Url, reference: &str) -> String {
    base_url.join(reference.trim()).map(|u| u.to_string()).unwrap_or_else(|_| reference.trim().to_string())
}

/// Point every URI in a playlist back at the proxy, with the same headers.
fn rewrite_playlist(text: &str, playlist_url: &str, h: &Hdrs, base: &str) -> String {
    let Ok(pu) = url::Url::parse(playlist_url) else { return text.to_string() };
    let mut out = String::with_capacity(text.len() + 1024);
    for line in text.lines() {
        let l = line.trim().trim_start_matches('\u{feff}').trim();
        if l.is_empty() {
            out.push('\n');
            continue;
        }
        if l.starts_with('#') {
            // URI="..." attributes: keys, media renditions, I-frame playlists, maps (may appear more than once per line).
            let mut rest = l;
            while let Some(i) = find_next_uri_attr(rest) {
                let start = i + 5;
                out.push_str(&rest[..start]);
                let after_prefix = &rest[start..];
                if let Some(len) = after_prefix.find('"') {
                    let uri = &after_prefix[..len];
                    if uri.is_empty()
                        || uri.starts_with("http://abxs.localhost")
                        || uri.starts_with("abxs://localhost")
                        || is_unproxyable_uri(uri)
                    {
                        out.push_str(uri);
                    } else {
                        let p = proxied(base, &resolve(&pu, uri), h);
                        out.push_str(&p);
                    }
                    out.push('"');
                    rest = &after_prefix[len + 1..];
                } else {
                    rest = after_prefix;
                    break;
                }
            }
            out.push_str(rest);
        } else if l.starts_with("http://abxs.localhost") || l.starts_with("abxs://localhost") {
            out.push_str(l);
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

/// The only page that should read proxied media: AbixCine's own window.
pub(crate) fn app_origin() -> &'static str {
    if cfg!(debug_assertions) {
        "http://localhost:1420"
    } else if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

pub(crate) fn cors_builder(b: tauri::http::response::Builder) -> tauri::http::response::Builder {
    cors(b)
}

fn cors(b: tauri::http::response::Builder) -> tauri::http::response::Builder {
    b.header("Access-Control-Allow-Origin", app_origin())
        .header("Vary", "Origin")
        .header("Access-Control-Allow-Headers", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        // The loopback gateway (gateway.rs) is a private-network target for Chromium.
        .header("Access-Control-Allow-Private-Network", "true")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Timing-Allow-Origin", "*")
        // Whatever upstream sends, it is media to us: never sniffed into a document, never run.
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
}

/// Content types a browser would render or execute. The proxy forwards bytes for a media
/// player; served as one of these, an upstream page would run with the proxy's origin.
fn is_active_document_type(ct: &str) -> bool {
    let base = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(
        base.as_str(),
        "text/html" | "application/xhtml+xml" | "image/svg+xml" | "application/javascript" | "text/javascript" | "application/ecmascript" | "text/xml" | "application/xml"
    )
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

/// `bytes=-N`: the last N bytes (MP4 demuxers read the index at the end of a file this way).
pub(crate) fn parse_suffix_range(header: &str) -> Option<u64> {
    let trimmed = header.trim();
    if !trimmed.as_bytes().get(..6).is_some_and(|b| b.eq_ignore_ascii_case(b"bytes=")) {
        return None;
    }
    let spec = trimmed[6..].trim();
    let n = spec.strip_prefix('-')?.trim().parse::<u64>().ok()?;
    (n > 0 && !spec.contains(',')).then_some(n)
}

pub(crate) fn parse_byte_range(header: &str) -> Option<(u64, Option<u64>)> {
    let trimmed = header.trim();
    // Compared as bytes: slicing the str at 6 panicked when a multi-byte character straddled it.
    if !trimmed.as_bytes().get(..6).is_some_and(|b| b.eq_ignore_ascii_case(b"bytes=")) {
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
    let len = body.len();
    media_head(
        upstream_status,
        synthetically_chunked,
        chunk_start,
        upstream_cl,
        upstream_crange,
        upstream_accept_ranges,
        resolved_ctype,
        Some(len),
        was_unwrapped,
    )
    .body(body)
    .unwrap()
}

/// Status and headers of a proxied media response. `body_len` is the buffered body's size, or
/// `None` for a streamed body: then only upstream's own Content-Length is forwarded, and without
/// one the gateway answers chunked (a guessed length of 0 would truncate the body to nothing).
#[allow(clippy::too_many_arguments)]
pub(crate) fn media_head(
    upstream_status: StatusCode,
    synthetically_chunked: bool,
    chunk_start: u64,
    upstream_cl: Option<u64>,
    upstream_crange: Option<&str>,
    upstream_accept_ranges: Option<&str>,
    resolved_ctype: Option<String>,
    body_len: Option<usize>,
    was_unwrapped: bool,
) -> tauri::http::response::Builder {
    let known_len = body_len.unwrap_or(0);
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
        if !was_unwrapped && known_len > 0 {
            b = b.header(header::CONTENT_RANGE, build_content_range(chunk_start, known_len, upstream_cl));
        }
        b = b.header(header::ACCEPT_RANGES, "bytes");
        if !was_unwrapped {
            b = b.header(header::CONTENT_LENGTH, known_len.to_string());
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
                if let Some(len) = upstream_cl.or(body_len.map(|n| n as u64)) {
                    b = b.header(header::CONTENT_LENGTH, len.to_string());
                }
            }
        }
    }
    b
}

impl From<Response<Vec<u8>>> for Proxied {
    fn from(r: Response<Vec<u8>>) -> Self {
        Proxied::Full(r)
    }
}

/// A proxied response: fully buffered, or headers plus a live upstream body (gateway only).
pub(crate) enum Proxied {
    Full(Response<Vec<u8>>),
    Stream {
        head: tauri::http::response::Builder,
        /// Bytes already read from upstream to classify the body (possibly de-disguised).
        prefix: Vec<u8>,
        rest: reqwest::Response,
    },
}

/// Whether a (start of a) response body is an HLS playlist or DASH manifest that must be rewritten.
fn body_is_manifest(body: &[u8], target: &str, ctype_lower: &str, looks_playlist: bool, looks_dash: bool) -> bool {
    let magic_m3u8 = is_extm3u_bytes(body);
    if magic_m3u8 || (!looks_like_binary_media_path(target) && (looks_playlist || ctype_lower.contains("mpegurl"))) {
        return true;
    }
    let non_binary_media = !ctype_lower.starts_with("video/") && !ctype_lower.starts_with("audio/") && !looks_like_binary_media_path(target);
    non_binary_media
        && (looks_dash || ctype_lower.contains("dash+xml") || String::from_utf8_lossy(&body[..body.len().min(MPD_SNIFF_WINDOW)]).contains("<MPD"))
}

/// Outbound range for the streaming gateway: the player's own range goes upstream unchanged
/// (nothing is buffered, so an open-ended `bytes=N-` is fine); the window is only kept for the
/// rare upstream that ignores `Range`, which still takes the capped, buffered path.
pub(crate) fn plan_outbound_range_streaming(raw_range: Option<&str>, looks_playlist: bool, looks_dash: bool) -> (Option<String>, Option<(u64, u64)>) {
    let Some(r) = raw_range else { return (None, None) };
    if looks_playlist || looks_dash {
        return (Some(r.to_string()), None);
    }
    let window = parse_byte_range(r).map(|(start, end)| {
        let len = end.map(|e| e.saturating_sub(start).saturating_add(1)).unwrap_or(RANGE_CHUNK);
        (start, len.min(RANGE_CHUNK))
    });
    (Some(r.to_string()), window)
}

pub async fn handle(req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match handle_with(req, PROXY_BASE, false).await {
        Proxied::Full(r) => r,
        // Never produced when `streaming` is false.
        Proxied::Stream { .. } => fail(StatusCode::INTERNAL_SERVER_ERROR, "unexpected stream"),
    }
}

/// The proxy behind both transports. `base` is what nested playlist URIs are rewritten to;
/// with `streaming`, media bodies are handed back unread ([`Proxied::Stream`]) instead of being
/// collected into memory first (the `abxs:` custom protocol can only return a whole `Vec<u8>`).
pub(crate) async fn handle_with(req: Request<Vec<u8>>, base: &str, streaming: bool) -> Proxied {
    if req.method() == tauri::http::Method::OPTIONS {
        return cors(Response::builder().status(StatusCode::NO_CONTENT)).body(Vec::new()).unwrap().into();
    }
    let q = query(req.uri());
    let Some(raw_target) = q.get("u").and_then(|u| B64.decode(u).ok()).and_then(|b| String::from_utf8(b).ok()) else {
        let raw = q.get("u").cloned().unwrap_or_default();
        let why = B64.decode(&raw).err().map(|e| e.to_string()).unwrap_or_else(|| "not utf-8".into());
        return fail(StatusCode::BAD_REQUEST, &format!("missing url (len {} uri len {}: {why})", raw.len(), req.uri().to_string().len())).into();
    };
    let target = match q.get("t").filter(|t| !t.is_empty()) {
        Some(t) => join_template(&raw_target, &unescape_tail(t)),
        None => raw_target,
    };
    if let Err(e) = validate_proxy_target(&target) {
        return fail(StatusCode::FORBIDDEN, &e).into();
    }
    let h: Hdrs = q
        .get("h")
        .and_then(|v| B64.decode(v).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Where the webview can reach us. The request URI can't tell us: on Windows wry hands the
    // handler `abxs://localhost/...` even though the page requested `http://abxs.localhost/...`,
    // and a playlist pointing at abxs:// would be unloadable there.

    let looks_playlist = looks_like_hls_url(&target);
    let looks_dash = looks_like_dash_url(&target);
    if let Some((final_url, body)) = cached_playlist(&target, &h) {
        let text = String::from_utf8_lossy(&body);
        let head = &text[..floor_char_boundary(&text, MPD_SNIFF_WINDOW)];
        if looks_dash || (!is_extm3u_bytes(&body) && head.contains("<MPD")) {
            let out = rewrite_mpd(&text, &final_url, &h, base);
            return cors(Response::builder().status(200))
                .header(header::CONTENT_TYPE, "application/dash+xml")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(out.into_bytes())
                .unwrap().into();
        }
        let out = rewrite_playlist(&text, &final_url, &h, base);
        return cors(Response::builder().status(200))
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(out.into_bytes())
            .unwrap().into();
    }

    // A HEAD probe asks for the headers only. It used to be sent upstream as a GET, which
    // downloaded (and returned) a whole chunk of media just to learn its length.
    if req.method() == tauri::http::Method::HEAD {
        return match apply(client().head(&target), &h).send().await {
            Ok(r) => {
                let mut b = cors(Response::builder().status(r.status().as_u16()));
                for name in [header::CONTENT_LENGTH, header::ACCEPT_RANGES, header::CONTENT_RANGE] {
                    if let Some(v) = r.headers().get(&name).and_then(|v| v.to_str().ok()) {
                        b = b.header(name, v);
                    }
                }
                let ct = r.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
                if !ct.is_empty() {
                    b = b.header(header::CONTENT_TYPE, if is_active_document_type(ct) { "application/octet-stream" } else { ct });
                }
                b.body(Vec::new()).unwrap()
            }
            Err(e) => fail(StatusCode::BAD_GATEWAY, &e.to_string()),
        }.into();
    }
    if req.method() != tauri::http::Method::GET {
        return fail(StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into();
    }

    let raw_range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    let (outbound_range, mut requested_range) = if streaming {
        plan_outbound_range_streaming(raw_range, looks_playlist, looks_dash)
    } else {
        plan_outbound_range(raw_range, &target, looks_playlist, looks_dash)
    };
    let suffix_len = raw_range.and_then(parse_suffix_range);
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
                return fail(StatusCode::BAD_GATEWAY, &e.to_string()).into();
            }
        }
    }
    let mut res = match res_opt {
        Some(r) => r,
        None => return fail(StatusCode::BAD_GATEWAY, "upstream retry exhausted").into(),
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

    // A suffix range the upstream ignored (200 with the whole file): serve the tail it asked for,
    // which the guard below can only do when the size is known. Without this the guard answered
    // with the start of the file, which a demuxer looking for the index can't use.
    if let (Some(n), true, Some(total)) = (suffix_len, status == StatusCode::OK, upstream_cl) {
        if requested_range.is_none() {
            let start = total.saturating_sub(n);
            requested_range = Some((start, n.min(total).min(RANGE_CHUNK)));
        }
    }

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
    ) && !(streaming && requested_range.is_none())
    {
        let (start, max_len) = requested_range.unwrap_or((0, RANGE_CHUNK));
        if let Some(total) = upstream_cl {
            if start >= total {
                return cors(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .header(header::ACCEPT_RANGES, "bytes")
                    .body(Vec::new())
                    .unwrap().into();
            }
        }
        if start > MAX_RANGE_SKIP {
            return fail(StatusCode::BAD_GATEWAY, "upstream ignored Range for large offset").into();
        }
        let mut window = RangeWindow::new(start, max_len as usize);
        while let Some(chunk) = match res.chunk().await {
            Ok(c) => c,
            Err(e) => return fail(StatusCode::BAD_GATEWAY, &e.to_string()).into(),
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
                .unwrap().into();
        }
        let chunked = (has_more || start > 0) && !buf.is_empty();
        (buf, chunked, start)
    } else {
        // Read against a cap: an extensionless video labelled octet-stream slips past the guard
        // above, and buffering it whole could take gigabytes of RAM.
        let mut buf: Vec<u8> = Vec::with_capacity(upstream_cl.map(|n| n.min(MAX_BUFFERED_BODY as u64) as usize).unwrap_or(0));
        let mut overflow = false;
        let mut eof = false;
        // Streaming gateway: read just enough to tell a manifest (rewritten, so buffered) from
        // media bytes, then hand the rest of the upstream body straight to the player.
        if streaming && status.is_success() {
            while buf.len() < MPD_SNIFF_WINDOW {
                match res.chunk().await {
                    Ok(Some(c)) => buf.extend_from_slice(&c),
                    Ok(None) => {
                        eof = true;
                        break;
                    }
                    Err(e) => return fail(StatusCode::BAD_GATEWAY, &e.to_string()).into(),
                }
            }
            // Image-disguised TS segments are small and need up to 64 KiB scanned: buffered path.
            if !eof && !looks_disguised(&buf) && !body_is_manifest(&buf, &target, &ctype_lower, looks_playlist, looks_dash) {
                let resolved_ctype = resolve_proxy_content_type(&target, &final_url, &ctype)
                    .map(|ct| if is_active_document_type(&ct) { "application/octet-stream".to_string() } else { ct });
                let head = media_head(
                    status,
                    false,
                    0,
                    upstream_cl,
                    crange.as_deref(),
                    upstream_accept_ranges.as_deref(),
                    resolved_ctype,
                    None,
                    false,
                );
                return Proxied::Stream { head, prefix: buf, rest: res };
            }
        }
        // The rest of the body, unless the sniff above already reached its end.
        while !eof {
            match res.chunk().await {
                Ok(Some(c)) => {
                    if buf.len() + c.len() > MAX_BUFFERED_BODY {
                        let take = MAX_BUFFERED_BODY - buf.len();
                        buf.extend_from_slice(&c[..take]);
                        overflow = true;
                        break;
                    }
                    buf.extend_from_slice(&c);
                }
                Ok(None) => eof = true,
                Err(e) => return fail(StatusCode::BAD_GATEWAY, &e.to_string()).into(),
            }
        }
        drop(res);
        if overflow {
            if status != StatusCode::OK || is_manifest_hint {
                return fail(StatusCode::BAD_GATEWAY, "upstream body too large to proxy").into();
            }
            // Same contract as the guard: the first window as a 206, the player asks for the rest.
            buf.truncate(RANGE_CHUNK as usize);
            (buf, true, 0)
        } else {
            (buf, false, 0)
        }
    };

    if !synthetically_chunked && status.is_success() {
        let magic_m3u8 = is_extm3u_bytes(&body);
        let is_playlist = magic_m3u8 || (!looks_like_binary_media_path(&target) && (looks_playlist || ctype_lower.contains("mpegurl")));
        if is_playlist {
            let text = String::from_utf8_lossy(&body);
            if magic_m3u8 && status == StatusCode::OK && !looks_like_html_doc(&text) {
                cache_playlist(&target, &h, &final_url, &body);
            }
            let out = rewrite_playlist(&text, &final_url, &h, base);
            return cors(Response::builder().status(status.as_u16()))
                .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(out.into_bytes())
                .unwrap().into();
        }
        let non_binary_media = !ctype_lower.starts_with("video/")
            && !ctype_lower.starts_with("audio/")
            && !looks_like_binary_media_path(&target);
        let is_dash = non_binary_media
            && (looks_dash
                || ctype_lower.contains("dash+xml")
                || {
                    let head = String::from_utf8_lossy(&body[..body.len().min(MPD_SNIFF_WINDOW)]);
                    head.contains("<MPD")
                });
        if is_dash {
            let text = String::from_utf8_lossy(&body);
            if status == StatusCode::OK && !looks_like_html_doc(&text) && text.contains("<MPD") {
                cache_playlist(&target, &h, &final_url, &body);
            }
            let out = rewrite_mpd(&text, &final_url, &h, base);
            return cors(Response::builder().status(status.as_u16()))
                .header(header::CONTENT_TYPE, "application/dash+xml")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(out.into_bytes())
                .unwrap().into();
        }
    }

    // Some hosts disguise MPEG-TS segments as images: strip a PNG/WebP header before the TS sync byte.
    let (body, was_unwrapped) = unwrap_disguised_segment(body);
    let resolved_ctype = if status.is_success() {
        resolve_proxy_content_type(&target, &final_url, &ctype)
    } else {
        (!ctype.trim().is_empty()).then(|| ctype.trim().to_string())
    }
    // Segments are often mislabelled text/html by CDNs: keep the bytes, drop the label.
    .map(|ct| if is_active_document_type(&ct) { "application/octet-stream".to_string() } else { ct });
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
    ).into()
}

fn looks_disguised(body: &[u8]) -> bool {
    body.starts_with(&[0x89, 0x50, 0x4e, 0x47]) || (body.len() > 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP")
}

fn unwrap_disguised_segment(body: Vec<u8>) -> (Vec<u8>, bool) {
    if !looks_disguised(&body) {
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

/* ------------------------------------------------------------------ */
/* Outbound request guard (SSRF)                                       */
/* ------------------------------------------------------------------ */
//
// Policy, applied to the first URL, every redirect hop and every DNS answer:
// - Never: link-local (incl. the 169.254.169.254 cloud-metadata address), unspecified, multicast,
//   broadcast, and the app's own `*.localhost` WebView hosts.
// - Loopback / private only when asked for explicitly: the URL names a private IP, `localhost`, or
//   a LAN-style name (`nas.local`, `mybox`). Self-hosted Stremio addons depend on this.
// - No pivots: a public site can't redirect into the LAN, and a public domain can't resolve to a
//   private address (DNS rebinding).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddrClass {
    Public,
    Private,
    Loopback,
    Forbidden,
}

fn classify_v4(v4: std::net::Ipv4Addr) -> AddrClass {
    let o = v4.octets();
    if v4.is_loopback() {
        AddrClass::Loopback
    } else if v4.is_unspecified() || v4.is_link_local() || v4.is_broadcast() || v4.is_multicast() || o[0] == 0 {
        AddrClass::Forbidden
    } else if v4.is_private() || (o[0] == 100 && (o[1] & 0xc0) == 64) {
        // RFC 1918 plus CGNAT 100.64.0.0/10 (Tailscale and friends).
        AddrClass::Private
    } else {
        AddrClass::Public
    }
}

pub(crate) fn classify_ip(ip: std::net::IpAddr) -> AddrClass {
    match ip {
        std::net::IpAddr::V4(v4) => classify_v4(v4),
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return classify_v4(v4);
            }
            let seg0 = v6.segments()[0];
            if v6.is_loopback() {
                AddrClass::Loopback
            } else if v6.is_unspecified() || v6.is_multicast() || (seg0 & 0xffc0) == 0xfe80 {
                AddrClass::Forbidden
            } else if (seg0 & 0xfe00) == 0xfc00 {
                AddrClass::Private
            } else {
                AddrClass::Public
            }
        }
    }
}

/// A name someone types for a machine on their own network.
fn is_local_name(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "localhost"
        || !h.contains('.')
        || h.ends_with(".local")
        || h.ends_with(".lan")
        || h.ends_with(".home.arpa")
        || h.ends_with(".internal")
}

/// The WebView's own scheme hosts (`tauri.`, `abxs.`, `asset.localhost`): never a fetch target.
fn is_app_internal_name(host: &str) -> bool {
    host.trim_end_matches('.').to_ascii_lowercase().ends_with(".localhost")
}

/// The address class a URL names directly (an IP literal or a local name), if any.
fn literal_class(u: &url::Url) -> Option<AddrClass> {
    match u.host()? {
        url::Host::Ipv4(ip) => Some(classify_v4(ip)),
        url::Host::Ipv6(ip) => Some(classify_ip(std::net::IpAddr::V6(ip))),
        url::Host::Domain(d) if d.eq_ignore_ascii_case("localhost") => Some(AddrClass::Loopback),
        url::Host::Domain(d) if is_local_name(d) => Some(AddrClass::Private),
        url::Host::Domain(_) => None,
    }
}

/// Points into the user's own machine or network (by literal address or LAN-style name).
fn targets_local_network(u: &url::Url) -> bool {
    matches!(literal_class(u), Some(AddrClass::Private | AddrClass::Loopback))
}

fn check_target_host(u: &url::Url) -> Result<(), String> {
    match u.host() {
        None => Err("URL has no host".into()),
        Some(url::Host::Domain(d)) if is_app_internal_name(d) => Err(format!("Blocked internal host: {d}")),
        _ if literal_class(u) == Some(AddrClass::Forbidden) => Err("Blocked address (link-local, unspecified or multicast)".into()),
        _ => Ok(()),
    }
}

/// May a redirect go from `from` to `to`? Same rules as the first URL, plus no public → local pivot.
fn redirect_allowed(from: &url::Url, to: &url::Url) -> Result<(), &'static str> {
    if !matches!(to.scheme(), "http" | "https") {
        return Err("redirect to a non-http(s) URL");
    }
    if check_target_host(to).is_err() {
        return Err("redirect to a blocked address");
    }
    if !targets_local_network(from) && targets_local_network(to) {
        return Err("redirect from a public site into the local network");
    }
    Ok(())
}

/// Virtual tunnel and CGNAT DNS ranges returned by local VPN / DNS adapters (e.g. Cloudflare WARP,
/// Tailscale, Clash/Sing-box Fake-IP, NAT64) when resolving ordinary public domains.
pub(crate) fn is_vpn_or_tun_addr(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            (o[0] == 100 && (o[1] & 0xc0) == 64) || (o[0] == 198 && (o[1] & 0xfe) == 18)
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_vpn_or_tun_addr(std::net::IpAddr::V4(v4));
            }
            let segs = v6.segments();
            (segs[0] & 0xfe00) == 0xfc00 || (segs[0] == 0x0064 && segs[1] == 0xff9b)
        }
    }
}

/// DNS with the rebinding guard: a public name may only resolve to public addresses (plus
/// CGNAT/TUN/ULA addresses mapped by local VPN resolvers); LAN-style names may also resolve to
/// private/loopback ones. Forbidden ranges are never returned.
struct GuardedResolver;

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let local = is_local_name(&host);
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|a| match classify_ip(a.ip()) {
                    AddrClass::Public => true,
                    AddrClass::Private => local || is_vpn_or_tun_addr(a.ip()),
                    AddrClass::Loopback => local,
                    AddrClass::Forbidden => false,
                })
                .collect();
            if addrs.is_empty() {
                return Err(format!("{host} resolves only to blocked addresses").into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn validate_http_url(raw_url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw_url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Unsupported URL scheme: {other}")),
    }
    check_target_host(&parsed)?;
    Ok(parsed)
}

#[cfg(test)]
thread_local! {
    // Proxy tests run a mock upstream on 127.0.0.1; they opt in per thread.
    static TEST_ALLOW_LOOPBACK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn loopback_allowed_for_tests() -> bool {
    #[cfg(test)]
    {
        TEST_ALLOW_LOOPBACK.with(|c| c.get())
    }
    #[cfg(not(test))]
    {
        false
    }
}

/// The stream proxy plays remote media only. Loopback is refused outright: nothing the player
/// streams lives there (local files use the asset protocol, torrents are played directly), so a
/// `localhost` URL arriving from an extractor's response is never legitimate.
fn validate_proxy_target(raw_url: &str) -> Result<url::Url, String> {
    let parsed = validate_http_url(raw_url)?;
    if literal_class(&parsed) == Some(AddrClass::Loopback) && !loopback_allowed_for_tests() {
        return Err("Blocked loopback stream target".into());
    }
    Ok(parsed)
}

fn build_http_request(
    url: &str,
    headers: Option<HashMap<String, String>>,
    method: Option<String>,
    body: Option<Vec<u8>>,
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

/// Decode a request body sent from JS as standard or URL-safe Base64 (padding optional).
fn decode_body_b64(b: &str) -> Result<Vec<u8>, String> {
    let trimmed = b.trim().trim_end_matches('=');
    let normalized: String = trimmed.chars().map(|c| match c { '+' => '-', '/' => '_', c => c }).collect();
    if normalized.len() > MAX_FETCH_BYTES {
        return Err("Request body too large".into());
    }
    B64.decode(normalized.as_bytes()).map_err(|e| format!("Invalid base64 request body: {e}"))
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
    validate_http_url(&url)?;
    let rb = build_http_request(&url, headers, method, body.map(String::into_bytes))?;
    let mut res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let url = res.url().to_string();
    if res.content_length().is_some_and(|n| n as usize > MAX_FETCH_BYTES) {
        return Err(format!("Response body exceeds {} MiB limit", MAX_FETCH_BYTES / (1024 * 1024)));
    }
    // Read in chunks against the cap: a server that lies about (or omits) its length can't make
    // us buffer an unbounded body.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > MAX_FETCH_BYTES {
            return Err(format!("Response body exceeds {} MiB limit", MAX_FETCH_BYTES / (1024 * 1024)));
        }
        buf.extend_from_slice(&chunk);
    }
    let body = String::from_utf8_lossy(&buf).into_owned();
    Ok(FetchResult { status, url, body })
}

/// Fetch a remote resource as raw bytes (standard Base64 encoded, 20 MiB cap) so non-UTF-8
/// payloads such as Windows-1252 or UTF-16 subtitles are never lossily decoded before JS sees them.
/// `body_b64` (standard or URL-safe Base64) sends a binary request body; it wins over `body`.
#[tauri::command]
pub async fn http_fetch_bytes(
    url: String,
    headers: Option<HashMap<String, String>>,
    method: Option<String>,
    body: Option<String>,
    body_b64: Option<String>,
) -> Result<FetchBytesResult, String> {
    let parsed = validate_http_url(&url)?;
    let raw_body = match body_b64 {
        Some(b) => Some(decode_body_b64(&b)?),
        None => body.map(String::into_bytes),
    };
    let rb = build_http_request(parsed.as_str(), headers, method, raw_body)?;
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

    /// PERF-07: in streaming mode a ranged media request is passed through unbuffered (the
    /// player's open-ended range goes upstream as-is), while playlists are still rewritten —
    /// to the gateway's base, so nested segments stay on the gateway.
    #[test]
    fn streaming_mode_passes_media_through_and_rewrites_playlists_to_gateway_base() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        tauri::async_runtime::block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().unwrap();
            let total = 3 * 1024 * 1024usize; // bigger than the 8 KiB sniff window, many chunks
            let movie: Vec<u8> = (0..total).map(|i| (i % 251) as u8).collect();
            let movie_srv = movie.clone();
            let seen_range = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
            let seen_srv = seen_range.clone();
            tokio::spawn(async move {
                for _ in 0..3 {
                    let (mut sock, _) = listener.accept().await.unwrap();
                    let movie = movie_srv.clone();
                    let seen = seen_srv.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 4096];
                        let n = sock.read(&mut buf).await.unwrap_or(0);
                        let req = String::from_utf8_lossy(&buf[..n]).to_string();
                        let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
                        if path.starts_with("/movie.mp4") {
                            let range = req.lines().find_map(|l| l.strip_prefix("range: ").or_else(|| l.strip_prefix("Range: "))).unwrap_or("").to_string();
                            *seen.lock().unwrap() = range.clone();
                            let start: usize = range.trim_start_matches("bytes=").trim_end_matches('-').parse().unwrap_or(0);
                            let hdr = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{total}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                total - start,
                                total - 1
                            );
                            let _ = sock.write_all(hdr.as_bytes()).await;
                            for c in movie[start..].chunks(64 * 1024) {
                                let _ = sock.write_all(c).await;
                            }
                        } else if path.starts_with("/seg-1.jpg") {
                            // A TS segment disguised as an image, sent chunked: no Content-Length.
                            let hdr = "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                            let _ = sock.write_all(hdr.as_bytes()).await;
                            for c in movie[..200_000].chunks(32 * 1024) {
                                let _ = sock.write_all(format!("{:x}\r\n", c.len()).as_bytes()).await;
                                let _ = sock.write_all(c).await;
                                let _ = sock.write_all(b"\r\n").await;
                            }
                            let _ = sock.write_all(b"0\r\n\r\n").await;
                        } else {
                            let body = b"#EXTM3U\n#EXTINF:6.0,\nseg0.ts\n";
                            let hdr = format!("HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                            let _ = sock.write_all(hdr.as_bytes()).await;
                            let _ = sock.write_all(body).await;
                        }
                    });
                }
            });

            let mk = |u: &str, range: Option<&str>| {
                let uri = format!("http://127.0.0.1:1/p?u={}&h={}", B64.encode(u), B64.encode(b"{}"));
                let mut b = Request::builder().method("GET").uri(uri);
                if let Some(r) = range {
                    b = b.header(header::RANGE, r);
                }
                b.body(Vec::new()).unwrap()
            };
            TEST_ALLOW_LOOPBACK.with(|c| c.set(true));

            let start = 1_000_000usize;
            match handle_with(mk(&format!("http://{addr}/movie.mp4"), Some(&format!("bytes={start}-"))), "http://gw/tok", true).await {
                Proxied::Stream { head, prefix, mut rest } => {
                    let r = head.body(()).unwrap();
                    assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
                    assert_eq!(r.headers()[header::CONTENT_LENGTH], (total - start).to_string().as_str());
                    assert_eq!(r.headers()[header::CONTENT_RANGE], format!("bytes {start}-{}/{total}", total - 1).as_str());
                    assert!(prefix.len() < 1024 * 1024, "only a sniff prefix may be buffered, got {}", prefix.len());
                    let mut got = prefix;
                    while let Some(c) = rest.chunk().await.unwrap() {
                        got.extend_from_slice(&c);
                    }
                    assert!(got == movie[start..], "streamed bytes differ");
                }
                Proxied::Full(r) => panic!("expected a streamed body, got buffered {}", r.status()),
            }
            assert_eq!(*seen_range.lock().unwrap(), format!("bytes={start}-"), "open-ended range must go upstream uncapped");

            // Regression: a chunked upstream (no Content-Length) must not be announced as length 0.
            match handle_with(mk(&format!("http://{addr}/seg-1.jpg"), None), "http://gw/tok", true).await {
                Proxied::Stream { head, prefix, mut rest } => {
                    let r = head.body(()).unwrap();
                    assert_eq!(r.status(), StatusCode::OK);
                    assert!(r.headers().get(header::CONTENT_LENGTH).is_none(), "unknown length must be left out: {:?}", r.headers());
                    let mut got = prefix;
                    while let Some(c) = rest.chunk().await.unwrap() {
                        got.extend_from_slice(&c);
                    }
                    assert!(got == movie[..200_000], "chunked body must pass through whole");
                }
                Proxied::Full(r) => panic!("expected a streamed body, got buffered {}", r.status()),
            }

            match handle_with(mk(&format!("http://{addr}/index.m3u8"), None), "http://gw/tok", true).await {
                Proxied::Full(r) => {
                    let text = String::from_utf8(r.body().clone()).unwrap();
                    assert!(text.lines().any(|l| l.starts_with("http://gw/tok/p?u=")), "segments must point at the gateway: {text}");
                }
                Proxied::Stream { .. } => panic!("playlists must be buffered and rewritten"),
            }
            TEST_ALLOW_LOOPBACK.with(|c| c.set(false));
        });
    }

    #[test]
    fn suffix_ranges_and_templated_dash_urls_round_trip() {
        assert_eq!(parse_suffix_range("bytes=-65536"), Some(65536));
        assert_eq!(parse_suffix_range("bytes=0-10"), None);
        assert_eq!(parse_suffix_range("bytes=-0"), None);

        // `$Number$` inside a query: the base keeps its query and the tail is appended verbatim.
        let h = Hdrs::default();
        let base = url::Url::parse("https://cdn.x/dash/manifest.mpd").unwrap();
        let attr = proxied_mpd_attr("http://abxs.localhost", &base, "seg?path=/a/b/$Number$.m4s&tok=%26x", &h);
        let unxml = attr.replace("&amp;", "&");
        let q: HashMap<String, String> = unxml
            .split_once('?')
            .unwrap()
            .1
            .split('&')
            .filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
            .collect();
        let raw_base = String::from_utf8(B64.decode(&q["u"]).unwrap()).unwrap();
        let rebuilt = join_template(&raw_base, &unescape_tail(&q["t"]).replace("$Number$", "7"));
        assert_eq!(rebuilt, "https://cdn.x/dash/seg?path=/a/b/7.m4s&tok=%26x");

        // Path templates still resolve as before.
        let attr = proxied_mpd_attr("http://abxs.localhost", &base, "video/$Number$.m4s", &h);
        let unxml = attr.replace("&amp;", "&");
        let t = unxml.split("&t=").nth(1).unwrap();
        let u = unxml.split("u=").nth(1).unwrap().split('&').next().unwrap();
        let raw_base = String::from_utf8(B64.decode(u).unwrap()).unwrap();
        assert_eq!(join_template(&raw_base, &unescape_tail(t)), "https://cdn.x/dash/video/$Number$.m4s");

        // Inline and DRM keys are left untouched.
        let pl = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\"\n#EXTINF:4,\nseg.ts\n";
        let out = rewrite_playlist(pl, "https://cdn.x/a/index.m3u8", &h, "http://abxs.localhost");
        assert!(out.contains("URI=\"data:text/plain;base64,AAAA\""));
    }

    #[test]
    fn ssrf_guard_classifies_and_validates_targets() {
        use std::net::IpAddr;
        let c = |s: &str| classify_ip(s.parse::<IpAddr>().unwrap());
        assert_eq!(c("8.8.8.8"), AddrClass::Public);
        assert_eq!(c("127.0.0.1"), AddrClass::Loopback);
        assert_eq!(c("::1"), AddrClass::Loopback);
        assert_eq!(c("192.168.1.20"), AddrClass::Private);
        assert_eq!(c("100.101.0.7"), AddrClass::Private);
        assert_eq!(c("fd12::1"), AddrClass::Private);
        assert_eq!(c("169.254.169.254"), AddrClass::Forbidden);
        assert_eq!(c("fe80::1"), AddrClass::Forbidden);
        assert_eq!(c("0.0.0.0"), AddrClass::Forbidden);
        assert_eq!(c("::ffff:169.254.169.254"), AddrClass::Forbidden);
        assert!(is_vpn_or_tun_addr("100.96.0.2".parse().unwrap()));
        assert!(is_vpn_or_tun_addr("198.18.0.5".parse().unwrap()));
        assert!(is_vpn_or_tun_addr("fd01:5ca1:ab1e::1".parse().unwrap()));
        assert!(!is_vpn_or_tun_addr("192.168.1.20".parse().unwrap()));
        assert!(!is_vpn_or_tun_addr("127.0.0.1".parse().unwrap()));

        // Explicit local targets stay usable (self-hosted addons); forbidden ones never are.
        assert!(validate_http_url("http://192.168.1.20:7000/manifest.json").is_ok());
        assert!(validate_http_url("http://localhost:3000/manifest.json").is_ok());
        assert!(validate_http_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_http_url("http://[fe80::1]/").is_err());
        assert!(validate_http_url("http://tauri.localhost/").is_err());
        assert!(validate_http_url("http://abxs.localhost/p?u=x").is_err());
        assert!(validate_http_url("http://0x7f000001/").map(|u| literal_class(&u)).unwrap() == Some(AddrClass::Loopback));

        // The stream proxy refuses loopback entirely, but still plays LAN media.
        assert!(validate_proxy_target("http://127.0.0.1:8080/admin").is_err());
        assert!(validate_proxy_target("http://localhost/x.m3u8").is_err());
        assert!(validate_proxy_target("http://nas.local:8096/v.m3u8").is_ok());
        assert!(validate_proxy_target("https://cdn.example.com/v.m3u8").is_ok());
    }

    #[test]
    fn ssrf_guard_blocks_public_to_local_redirect_pivots() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(redirect_allowed(&u("https://cdn.example.com/a"), &u("https://other.example.org/b")).is_ok());
        assert!(redirect_allowed(&u("https://cdn.example.com/a"), &u("http://127.0.0.1:9000/")).is_err());
        assert!(redirect_allowed(&u("https://cdn.example.com/a"), &u("http://192.168.0.1/")).is_err());
        assert!(redirect_allowed(&u("https://cdn.example.com/a"), &u("http://router/")).is_err());
        assert!(redirect_allowed(&u("https://cdn.example.com/a"), &u("http://169.254.169.254/")).is_err());
        assert!(redirect_allowed(&u("https://cdn.example.com/a"), &u("file:///C:/Windows/win.ini")).is_err());
        // A LAN addon redirecting within the LAN, or out to a public CDN, is fine.
        assert!(redirect_allowed(&u("http://192.168.1.20:7000/s"), &u("http://192.168.1.20:7000/t")).is_ok());
        assert!(redirect_allowed(&u("http://192.168.1.20:7000/s"), &u("https://cdn.example.com/v")).is_ok());
    }

    #[test]
    fn decodes_binary_request_bodies_in_both_base64_alphabets() {
        let bytes = vec![0x02u8, 0xfb, 0xff, 0x00, 0x3e, 0x80];
        assert_eq!(decode_body_b64(&B64_STD.encode(&bytes)).unwrap(), bytes);
        assert_eq!(decode_body_b64(&B64.encode(&bytes)).unwrap(), bytes);
        assert!(decode_body_b64("not base64!").is_err());
    }

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

        let h0 = Hdrs::default();
        cache_playlist(&fresh_url, &h0, &fresh_url, valid_body);
        cache_playlist(&stale_url, &h0, &stale_url, valid_body);
        cache_playlist(nested_stale_url, &h0, nested_stale_url, expired_nested_body.as_bytes());

        assert!(cached_playlist_at(&fresh_url, &h0, now_ms).is_some());
        assert!(cached_playlist_at(&stale_url, &h0, now_ms).is_none());
        assert!(cached_playlist_at(nested_stale_url, &h0, now_ms).is_none());
        // Another page's Referer doesn't get this page's playlist.
        let other = Hdrs { referer: Some("https://other.example/".into()), ..Default::default() };
        assert!(cached_playlist_at(&fresh_url, &other, now_ms).is_none());
        assert!(is_url_token_expired_at(&format!("https://cdn.example.com/exp/{stale_exp}/master.m3u8"), now_ms));
    }

    #[test]
    fn looks_like_hls_and_dash_inspect_path_only() {
        assert!(looks_like_hls_url("https://cdn.example/master.m3u8?token=abc"));
        assert!(looks_like_hls_url("https://cdn.example/master.m3u8#t=10"));
        assert!(looks_like_hls_url("https://cdn.example/master.m3u8/stream?x=1"));
        assert!(!looks_like_hls_url("https://cdn.example/seg.ts?ref=master.m3u8"));
        assert!(!looks_like_hls_url("https://cdn.example/seg.ts#master.m3u8"));
        assert!(!looks_like_hls_url("https://cdn.example/master.m3u8.ts"));

        assert!(looks_like_dash_url("https://cdn.example/manifest.mpd?token=1"));
        assert!(looks_like_dash_url("https://cdn.example/manifest.mpd#t=0"));
        assert!(!looks_like_dash_url("https://cdn.example/seg.m4s?src=manifest.mpd"));
        assert!(!looks_like_dash_url("https://cdn.example/seg.m4s#manifest.mpd"));
        assert!(!looks_like_dash_url("https://cdn.example/manifest.mpd.m4s"));
    }

    #[test]
    fn rewrite_playlist_handles_bom_and_keyuri_boundary() {
        let input = "\u{feff}#EXTM3U\n\
            #EXT-X-KEY:METHOD=AES-128,KEYURI=\"https://cdn.example/raw.bin\",URI=\"key.bin\"\n\
            #EXT-X-MAP:URI=\"init.mp4\"\n\
            #EXTINF:6.0,\n\
            seg0.ts?ref=master.m3u8\n";
        let h = Hdrs {
            referer: Some("https://embed.example/".to_string()),
            ..Default::default()
        };
        let out = rewrite_playlist(input, "https://cdn.example/hls/master.m3u8", &h, "http://abxs.localhost");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "#EXTM3U");
        assert!(lines[1].contains("KEYURI=\"https://cdn.example/raw.bin\""), "KEYURI must not be rewritten: {}", lines[1]);
        assert!(lines[1].contains(",URI=\"http://abxs.localhost/p?u="), "URI attr must be rewritten: {}", lines[1]);
        assert!(lines[2].starts_with("#EXT-X-MAP:URI=\"http://abxs.localhost/p?u="), "MAP URI must be rewritten: {}", lines[2]);
        assert!(lines[4].starts_with("http://abxs.localhost/p?u="), "segment URI must be rewritten: {}", lines[4]);

        // Rewriting an already-proxied playlist (e.g. if passed twice) must not double-wrap proxy URLs.
        let again = rewrite_playlist(&out, "https://cdn.example/hls/master.m3u8", &h, "http://abxs.localhost");
        let twice_wrapped = format!("{}p?u=", B64.encode("http://abxs.localhost/"));
        assert!(!again.contains(&twice_wrapped));
        assert_eq!(again, out);
    }

    #[test]
    fn extensionless_bom_playlist_caches_and_query_m3u8_ts_is_uncorrupted() {
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        tauri::async_runtime::block_on(async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("local_addr");
            let playlist_hits = Arc::new(AtomicUsize::new(0));
            let hits_srv = playlist_hits.clone();
            let raw_ts: Vec<u8> = vec![0x47, 0x40, 0x11, 0x10, 0xFF, 0xFE, 0x80, 0x00, 0x99, 0x01, 0x02];
            let ts_srv = raw_ts.clone();

            let srv = tokio::spawn(async move {
                for _ in 0..2 {
                    let (mut sock, _) = listener.accept().await.expect("accept");
                    let hits_c = hits_srv.clone();
                    let ts_c = ts_srv.clone();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 2048];
                        let n = sock.read(&mut buf).await.unwrap_or(0);
                        let req_str = String::from_utf8_lossy(&buf[..n]);
                        let path = req_str
                            .lines()
                            .next()
                            .and_then(|l| l.split_whitespace().nth(1))
                            .unwrap_or("");
                        let (ctype, body): (&str, Vec<u8>) = if path.starts_with("/playlist/170060") {
                            hits_c.fetch_add(1, Ordering::SeqCst);
                            (
                                "text/plain",
                                b"\xEF\xBB\xBF#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720p/index.m3u8?tok=1\n".to_vec(),
                            )
                        } else if path.starts_with("/seg.ts?ref=master.m3u8") {
                            ("video/mp2t", ts_c)
                        } else {
                            ("text/plain", b"not found".to_vec())
                        };
                        let hdr = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = sock.write_all(hdr.as_bytes()).await;
                        let _ = sock.write_all(&body).await;
                    });
                }
            });

            let h = Hdrs::default();
            let playlist_url = format!("http://{addr}/playlist/170060?type=video");
            let ts_url = format!("http://{addr}/seg.ts?ref=master.m3u8");

            let mk_req = |u: &str| {
                let uri = format!(
                    "http://abxs.localhost/p?u={}&h={}",
                    B64.encode(u),
                    B64.encode(serde_json::to_vec(&h).unwrap())
                );
                Request::builder().method("GET").uri(uri).body(Vec::new()).unwrap()
            };

            TEST_ALLOW_LOOPBACK.with(|c| c.set(true));
            let r1 = handle(mk_req(&playlist_url)).await;
            assert_eq!(r1.status(), StatusCode::OK);
            assert_eq!(playlist_hits.load(Ordering::SeqCst), 1);
            let b1 = String::from_utf8(r1.body().clone()).unwrap();
            assert!(b1.starts_with("#EXTM3U\n"), "unexpected playlist body: {b1}");
            assert_eq!(b1.matches("http://abxs.localhost/p?u=").count(), 1);

            // Second request must be served from PLAYLISTS cache with zero extra upstream requests.
            let r2 = handle(mk_req(&playlist_url)).await;
            assert_eq!(r2.status(), StatusCode::OK);
            assert_eq!(playlist_hits.load(Ordering::SeqCst), 1);
            let b2 = String::from_utf8(r2.body().clone()).unwrap();
            assert_eq!(b2, b1);

            // Binary TS segment whose query string contains `.m3u8` must stay byte-identical.
            let r3 = handle(mk_req(&ts_url)).await;
            assert_eq!(r3.status(), StatusCode::OK);
            assert_eq!(r3.body(), &raw_ts);

            srv.await.unwrap();
        });
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;

    #[test]
    fn byte_windows_never_split_a_character() {
        // "é" is two bytes; put its second byte exactly on each window edge.
        let mut s = "#EXTM3U\n".to_string();
        while s.len() < 2047 {
            s.push('a');
        }
        s.push('é');
        s.push_str("\n#EXTINF:1,\nseg.ts\n");
        assert!(!s.is_char_boundary(2048));
        assert!(is_valid_m3u8_body(&s));
        assert_eq!(floor_char_boundary(&s, 2048), 2047);
        assert_eq!(floor_char_boundary("abc", 10), 3);
    }

    #[test]
    fn range_header_with_multibyte_prefix_is_rejected_not_a_panic() {
        assert_eq!(parse_byte_range("bytéé=0-1"), None);
        assert_eq!(parse_byte_range("BYTES=5-"), Some((5, None)));
        assert_eq!(parse_byte_range("bytes=2-9"), Some((2, Some(9))));
    }

    #[test]
    fn active_documents_are_recognised() {
        assert!(is_active_document_type("text/html; charset=utf-8"));
        assert!(is_active_document_type("image/svg+xml"));
        assert!(!is_active_document_type("video/mp2t"));
        assert!(!is_active_document_type("application/vnd.apple.mpegurl"));
    }
}
