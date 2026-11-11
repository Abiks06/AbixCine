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
static PLAYLISTS: std::sync::Mutex<Option<HashMap<String, (std::time::Instant, Vec<u8>)>>> = std::sync::Mutex::new(None);
const PLAYLIST_TTL: Duration = Duration::from_secs(25);

fn cached_playlist(url: &str) -> Option<Vec<u8>> {
    let g = PLAYLISTS.lock().ok()?;
    let (at, body) = g.as_ref()?.get(url)?;
    (at.elapsed() < PLAYLIST_TTL).then(|| body.clone())
}

fn cache_playlist(url: &str, body: &[u8]) {
    if let Ok(mut g) = PLAYLISTS.lock() {
        let map = g.get_or_insert_with(HashMap::new);
        map.retain(|_, (at, _)| at.elapsed() < PLAYLIST_TTL);
        map.insert(url.to_string(), (std::time::Instant::now(), body.to_vec()));
    }
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
        let body = res.bytes().await.ok()?;
        let text = String::from_utf8_lossy(&body);
        if !text.contains("#EXTM3U") || !(text.contains("#EXT-X-STREAM-INF") || text.contains("#EXTINF")) {
            return None;
        }
        cache_playlist(url, &body);
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

fn apply(mut rb: reqwest::RequestBuilder, h: &Hdrs) -> reqwest::RequestBuilder {
    if let Some(r) = h.referer.as_deref().filter(|s| !s.is_empty()) {
        rb = rb.header(header::REFERER, r);
    }
    if let Some(o) = h.origin.as_deref().filter(|s| !s.is_empty()) {
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
            // URI="..." attributes: keys, media renditions, I-frame playlists, maps.
            if let Some(i) = l.find("URI=\"") {
                let start = i + 5;
                if let Some(len) = l[start..].find('"') {
                    let uri = &l[start..start + len];
                    let p = proxied(base, &resolve(&pu, uri), h);
                    out.push_str(&l[..start]);
                    out.push_str(&p);
                    out.push_str(&l[start + len..]);
                    out.push('\n');
                    continue;
                }
            }
            out.push_str(l);
        } else {
            out.push_str(&proxied(base, &resolve(&pu, l), h));
        }
        out.push('\n');
    }
    out
}

fn cors(b: tauri::http::response::Builder) -> tauri::http::response::Builder {
    b.header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")
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
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

pub async fn handle(req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == tauri::http::Method::OPTIONS {
        return cors(Response::builder().status(StatusCode::NO_CONTENT)).body(Vec::new()).unwrap();
    }
    let q = query(req.uri());
    let Some(target) = q.get("u").and_then(|u| B64.decode(u).ok()).and_then(|b| String::from_utf8(b).ok()) else {
        let raw = q.get("u").cloned().unwrap_or_default();
        let why = B64.decode(&raw).err().map(|e| e.to_string()).unwrap_or_else(|| "not utf-8".into());
        return fail(StatusCode::BAD_REQUEST, &format!("missing url (len {} uri len {}: {why})", raw.len(), req.uri().to_string().len()));
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
    if let Some(body) = cached_playlist(&target) {
        let out = rewrite_playlist(&String::from_utf8_lossy(&body), &target, &h, base);
        return cors(Response::builder().status(200))
            .header(header::CONTENT_TYPE, "application/vnd.apple.mpegurl")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(out.into_bytes())
            .unwrap();
    }
    let mut rb = apply(client().get(&target), &h);
    if let Some(r) = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let capped = match r.strip_prefix("bytes=").and_then(|s| s.strip_suffix('-')).and_then(|s| s.parse::<u64>().ok()) {
            Some(start) if !looks_playlist => format!("bytes={}-{}", start, start + RANGE_CHUNK - 1),
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
        let pl = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg1.ts\nhttps://cdn.x/seg2.ts\n";
        let h = Hdrs { referer: Some("https://e.x/".into()), ..Default::default() };
        let out = rewrite_playlist(pl, "https://cdn.x/v/1080/index.m3u8", &h, "http://abxs.localhost");
        let lines: Vec<&str> = out.lines().collect();
        assert!(lines[1].starts_with("#EXT-X-KEY:METHOD=AES-128,URI=\"http://abxs.localhost/p?u="));
        let seg = lines[3].split("u=").nth(1).unwrap().split('&').next().unwrap();
        assert_eq!(String::from_utf8(B64.decode(seg).unwrap()).unwrap(), "https://cdn.x/v/1080/seg1.ts");
        assert!(lines[4].starts_with("http://abxs.localhost/p?u="));
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
