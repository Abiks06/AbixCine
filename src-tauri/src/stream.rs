//! Stream proxy and HTTP helper.
//!
//! Video hosts usually refuse requests that don't carry the embed page's Referer/Origin,
//! and a webview can't set those headers itself. Everything AbixCine plays directly goes
//! through the `abxs:` scheme instead: Rust fetches the URL with the right headers, and for
//! HLS playlists rewrites every nested URI (variants, segments, keys, subtitles) so those
//! come back through the proxy too. The webview only ever talks to a same-machine origin,
//! so there are no CORS or mixed-content problems and no third-party page is ever loaded.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
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

/// Playlists fetched while verifying a capture, kept briefly so the player's first request is
/// answered instantly (the slow part on a new host is the connection, which is now warm too).
static PLAYLISTS: std::sync::Mutex<Option<HashMap<String, (std::time::Instant, String, Vec<u8>)>>> = std::sync::Mutex::new(None);
const PLAYLIST_TTL: Duration = Duration::from_secs(25);

fn cached_playlist(url: &str) -> Option<(String, Vec<u8>)> {
    let g = PLAYLISTS.lock().ok()?;
    let (at, final_url, body) = g.as_ref()?.get(url)?;
    (at.elapsed() < PLAYLIST_TTL).then(|| (final_url.clone(), body.clone()))
}

fn cache_playlist(url: &str, final_url: &str, body: &[u8]) {
    if let Ok(mut g) = PLAYLISTS.lock() {
        let map = g.get_or_insert_with(HashMap::new);
        map.retain(|_, (at, _, _)| at.elapsed() < PLAYLIST_TTL);
        map.insert(url.to_string(), (std::time::Instant::now(), final_url.to_string(), body.to_vec()));
    }
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
        if [429, 500, 502, 503, 504].contains(&status) && attempt == 0 {
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

const MPD_SNIFF_WINDOW: usize = 8192;

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

    let looks_playlist = target.contains(".m3u8");
    let looks_dash = target.contains(".mpd");
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
    let mut rb = apply(client().get(&target), &h);
    if let Some(r) = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let capped = match r.strip_prefix("bytes=").and_then(|s| s.strip_suffix('-')).and_then(|s| s.parse::<u64>().ok()) {
            Some(start) if !looks_playlist && !looks_dash => format!("bytes={}-{}", start, start + RANGE_CHUNK - 1),
            _ => r.to_string(),
        };
        rb = rb.header(header::RANGE, capped);
    } else {
        // A progressive file asked for without a range: answer with the first chunk (206),
        // never the whole movie in one buffered response.
        let path = target.split('?').next().unwrap_or("").to_ascii_lowercase();
        if [".mp4", ".mkv", ".webm", ".m4v", ".mov"].iter().any(|e| path.ends_with(e)) {
            rb = rb.header(header::RANGE, format!("bytes=0-{}", RANGE_CHUNK - 1));
        }
    }

    let res = match rb.send().await {
        Ok(r) => r,
        Err(e) => return fail(StatusCode::BAD_GATEWAY, &e.to_string()),
    };
    let status = res.status();
    let ctype = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let crange = res.headers().get(header::CONTENT_RANGE).cloned();
    let final_url = res.url().to_string();
    let body = match res.bytes().await {
        Ok(b) => b,
        Err(e) => return fail(StatusCode::BAD_GATEWAY, &e.to_string()),
    };

    let is_playlist = looks_playlist
        || ctype.contains("mpegurl")
        || body.starts_with(b"#EXTM3U")
        || body.get(..3) == Some(b"\xEF\xBB\xBF") && body[3..].starts_with(b"#EXTM3U");
    let is_dash = looks_dash
        || ctype.contains("dash+xml")
        || {
            let head = String::from_utf8_lossy(&body[..body.len().min(MPD_SNIFF_WINDOW)]);
            head.contains("<MPD")
        };
    let mut b = cors(Response::builder().status(status.as_u16()));
    if is_playlist && status.is_success() {
        let text = String::from_utf8_lossy(&body);
        let out = rewrite_playlist(&text, &final_url, &h, base);
        return b
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(out.into_bytes())
            .unwrap();
    }
    if is_dash && status.is_success() {
        let text = String::from_utf8_lossy(&body);
        let out = rewrite_mpd(&text, &final_url, &h, base);
        return b
            .header(header::CONTENT_TYPE, "application/dash+xml")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(out.into_bytes())
            .unwrap();
    }
    // Some hosts disguise MPEG-TS segments as images: strip a PNG/WebP header before the TS sync byte.
    let body = unwrap_disguised_segment(body.to_vec());
    if !ctype.is_empty() {
        b = b.header(header::CONTENT_TYPE, ctype);
    }
    if let Some(cr) = crange {
        b = b.header(header::CONTENT_RANGE, cr).header(header::ACCEPT_RANGES, "bytes");
    }
    b.body(body).unwrap()
}

fn unwrap_disguised_segment(body: Vec<u8>) -> Vec<u8> {
    let png = body.starts_with(&[0x89, 0x50, 0x4e, 0x47]);
    let webp = body.len() > 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP";
    if !(png || webp) {
        return body;
    }
    // Find the first MPEG-TS sync byte that repeats every 188 bytes.
    let limit = body.len().saturating_sub(188 * 3).min(64 * 1024);
    for i in 0..limit {
        if body[i] == 0x47 && body[i + 188] == 0x47 && body[i + 376] == 0x47 {
            return body[i..].to_vec();
        }
    }
    body
}

#[derive(Serialize)]
pub struct FetchResult {
    status: u16,
    url: String,
    body: String,
}

/// Fetch a page or API as text from Rust (no CORS, any Referer). Used by direct providers.
#[tauri::command]
pub async fn http_fetch(
    url: String,
    headers: Option<HashMap<String, String>>,
    method: Option<String>,
    body: Option<String>,
) -> Result<FetchResult, String> {
    let m = reqwest::Method::from_bytes(method.as_deref().unwrap_or("GET").as_bytes()).map_err(|e| e.to_string())?;
    let mut rb = client().request(m, &url).header(header::USER_AGENT, UA);
    for (k, v) in headers.unwrap_or_default() {
        rb = rb.header(k, v);
    }
    if let Some(b) = body {
        rb = rb.body(b);
    }
    let res = rb.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let url = res.url().to_string();
    let body = res.text().await.map_err(|e| e.to_string())?;
    Ok(FetchResult { status, url, body })
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
        assert_eq!(unwrap_disguised_segment(b)[0], 0x47);
    }
}
