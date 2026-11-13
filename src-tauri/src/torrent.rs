use serde::Serialize;

#[cfg(any(feature = "torrent", test))]
const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "webm", "avi", "mov"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TorrentFileInfo {
    pub index: usize,
    pub name: String,
    pub size: u64,
    pub is_video: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStreamInfo {
    pub id: usize,
    pub url: String,
    pub file_idx: usize,
    pub file_name: String,
    pub file_size: u64,
    pub info_hash: String,
    pub name: Option<String>,
    pub files: Vec<TorrentFileInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStatusInfo {
    pub id: usize,
    pub state: String,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub progress: f64,
    pub download_speed_bps: u64,
    pub upload_speed_bps: u64,
    pub peers: u32,
    pub seeders: u32,
    pub finished: bool,
    pub error: Option<String>,
}

#[cfg(any(feature = "torrent", test))]
pub(crate) fn is_video_filename(name: &str) -> bool {
    std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|ext| {
            let lower = ext.to_ascii_lowercase();
            VIDEO_EXTENSIONS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

#[cfg(any(feature = "torrent", test))]
pub(crate) fn video_mime_type(name: &str) -> &'static str {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mkv" => "video/x-matroska",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

#[cfg(any(feature = "torrent", test))]
fn is_valid_btih_hash(hash: &str) -> bool {
    (hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        || (hash.len() == 32
            && hash
                .bytes()
                .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'2'..=b'7')))
}

#[cfg(any(feature = "torrent", test))]
fn is_valid_xt_value(val: &str) -> bool {
    if let Some(hash) = val
        .strip_prefix("urn:btih:")
        .or_else(|| val.strip_prefix("URN:BTIH:"))
    {
        return is_valid_btih_hash(hash);
    }
    if let Some(hash) = val
        .strip_prefix("urn:btmh:")
        .or_else(|| val.strip_prefix("URN:BTMH:"))
    {
        return hash.len() >= 42 && hash.bytes().all(|b| b.is_ascii_hexdigit());
    }
    false
}

/// Validate and normalize a `magnet:?xt=...` URI or a bare 40-hex / 32-base32 infohash
/// into a canonical `magnet:` URI. Rejects HTTP(S) URLs and filesystem paths.
#[cfg(any(feature = "torrent", test))]
pub(crate) fn parse_magnet_or_infohash(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Magnet URI or infohash cannot be empty".into());
    }

    if trimmed.len() == 40 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(format!("magnet:?xt=urn:btih:{}", trimmed.to_ascii_lowercase()));
    }

    if trimmed.len() == 32
        && trimmed
            .bytes()
            .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'2'..=b'7'))
    {
        return Ok(format!("magnet:?xt=urn:btih:{}", trimmed.to_ascii_uppercase()));
    }

    if let Some(rest) = trimmed
        .strip_prefix("magnet:")
        .or_else(|| trimmed.strip_prefix("MAGNET:"))
        .or_else(|| {
            trimmed
                .get(..7)
                .filter(|p| p.eq_ignore_ascii_case("magnet:"))
                .map(|_| &trimmed[7..])
        })
    {
        let query = rest.strip_prefix('?').unwrap_or(rest);
        let has_valid_xt = query.split('&').any(|pair| {
            let Some((k, v)) = pair.split_once('=') else {
                return false;
            };
            k.eq_ignore_ascii_case("xt") && is_valid_xt_value(v)
        });
        if !has_valid_xt {
            return Err("Magnet URI must contain a valid xt=urn:btih:... infohash".into());
        }
        return Ok(format!("magnet:{rest}"));
    }

    Err("Expected a magnet:?xt=urn:btih:... URI or a 40-hex / 32-base32 BitTorrent infohash".into())
}

/// Choose `requested` when valid, or the largest supported video file (`.mkv/.mp4/.webm/.avi/.mov`).
#[cfg(any(feature = "torrent", test))]
pub(crate) fn pick_video_file_index(
    files: &[(String, u64)],
    requested: Option<usize>,
) -> Result<usize, String> {
    if files.is_empty() {
        return Err("Torrent contains no files".into());
    }
    if let Some(idx) = requested {
        if idx < files.len() {
            return Ok(idx);
        }
        return Err(format!(
            "Requested file index {idx} is out of range (0..{})",
            files.len()
        ));
    }

    files
        .iter()
        .enumerate()
        .filter(|(_, (name, _))| is_video_filename(name))
        .max_by_key(|(idx, (_, size))| (*size, std::cmp::Reverse(*idx)))
        .map(|(idx, _)| idx)
        .ok_or_else(|| {
            "No supported video file (.mkv, .mp4, .webm, .avi, .mov) found in torrent".into()
        })
}

#[cfg(any(feature = "torrent", test))]
pub(crate) fn parse_http_range_header(header_val: &str, total_len: u64) -> Result<(u64, u64), ()> {
    if total_len == 0 {
        return Err(());
    }
    let spec = header_val.trim().strip_prefix("bytes=").ok_or(())?.trim();
    if spec.contains(',') {
        return Err(());
    }
    let (start_s, end_s) = spec.split_once('-').ok_or(())?;
    let start_s = start_s.trim();
    let end_s = end_s.trim();

    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = total_len.saturating_sub(suffix);
        return Ok((start, total_len - 1));
    }

    let start: u64 = start_s.parse().map_err(|_| ())?;
    if start >= total_len {
        return Err(());
    }
    let end = if end_s.is_empty() {
        total_len - 1
    } else {
        end_s.parse::<u64>().map_err(|_| ())?.min(total_len - 1)
    };
    if end < start {
        return Err(());
    }
    Ok((start, end))
}

#[tauri::command]
pub fn torrent_is_supported() -> bool {
    cfg!(feature = "torrent")
}

#[cfg(not(feature = "torrent"))]
const DISABLED_MSG: &str =
    "Built-in torrent streaming is not enabled in this build (compile with Cargo feature `torrent`).";

#[cfg(not(feature = "torrent"))]
#[tauri::command]
pub async fn torrent_start_stream(
    _app: tauri::AppHandle,
    _magnet_or_hash: String,
    _file_idx: Option<usize>,
) -> Result<TorrentStreamInfo, String> {
    Err(DISABLED_MSG.to_string())
}

#[cfg(not(feature = "torrent"))]
#[tauri::command]
pub async fn torrent_status(_id: usize) -> Result<TorrentStatusInfo, String> {
    Err(DISABLED_MSG.to_string())
}

#[cfg(not(feature = "torrent"))]
#[tauri::command]
pub async fn torrent_stop(_id: usize) -> Result<(), String> {
    Err(DISABLED_MSG.to_string())
}

#[cfg(feature = "torrent")]
mod enabled {
    use super::*;
    use librqbit::api::TorrentIdOrHash;
    use librqbit::{
        AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, Session,
        SessionOptions, TorrentStatsState,
    };
    use std::collections::HashSet;
    use std::io::SeekFrom;
    use std::sync::Arc;
    use tauri::Manager;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::OnceCell;

    struct TorrentRuntime {
        session: Arc<Session>,
        base_url: String,
    }

    static TORRENT_RUNTIME: OnceCell<Arc<TorrentRuntime>> = OnceCell::const_new();

    async fn get_or_init_runtime(app: &tauri::AppHandle) -> Result<Arc<TorrentRuntime>, String> {
        TORRENT_RUNTIME
            .get_or_try_init(|| async {
                let _ = rustls::crypto::ring::default_provider().install_default();
                let data_dir = app
                    .path()
                    .app_local_data_dir()
                    .map_err(|e| format!("Failed to resolve app_local_data_dir: {e}"))?
                    .join("torrents");
                std::fs::create_dir_all(&data_dir)
                    .map_err(|e| format!("Failed to create torrents directory: {e}"))?;

                let opts = SessionOptions {
                    dht: Some(DhtSessionConfig {
                        bootstrap_addrs: None,
                        port: None,
                        persistence: None,
                    }),
                    persistence: None,
                    fastresume: false,
                    concurrent_init_limit: Some(2),
                    ..Default::default()
                };

                let session = Session::new_with_opts(data_dir, opts)
                    .await
                    .map_err(|e| format!("Failed to initialize BitTorrent session: {e:#}"))?;

                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|e| format!("Failed to bind local torrent stream server: {e}"))?;
                let port = listener
                    .local_addr()
                    .map_err(|e| format!("Failed to read local stream server port: {e}"))?
                    .port();

                let rt = Arc::new(TorrentRuntime {
                    session: session.clone(),
                    base_url: format!("http://127.0.0.1:{port}"),
                });

                tauri::async_runtime::spawn(run_stream_server(listener, session));
                Ok(rt)
            })
            .await
            .map(Arc::clone)
    }

    async fn run_stream_server(listener: TcpListener, session: Arc<Session>) {
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                continue;
            };
            let session = session.clone();
            tauri::async_runtime::spawn(async move {
                let _ = handle_http_connection(socket, session).await;
            });
        }
    }

    fn parse_stream_path(target: &str) -> Option<(usize, usize)> {
        let path = target.split('?').next().unwrap_or(target);
        let mut parts = path.trim_start_matches('/').split('/');
        if parts.next()? != "torrents" {
            return None;
        }
        let id = parts.next()?.parse::<usize>().ok()?;
        if parts.next()? != "stream" {
            return None;
        }
        let file_idx = parts.next()?.parse::<usize>().ok()?;
        Some((id, file_idx))
    }

    async fn write_simple_response(
        socket: &mut TcpStream,
        status: &str,
        extra_headers: &str,
        body: &[u8],
    ) -> std::io::Result<()> {
        let head = format!(
            "HTTP/1.1 {status}\r\n\
             Content-Length: {}\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
             Access-Control-Allow-Headers: Range, Content-Type\r\n\
             Cache-Control: no-store\r\n\
             {extra_headers}\r\n",
            body.len()
        );
        socket.write_all(head.as_bytes()).await?;
        if !body.is_empty() {
            socket.write_all(body).await?;
        }
        socket.flush().await
    }

    async fn handle_http_connection(
        mut socket: TcpStream,
        session: Arc<Session>,
    ) -> std::io::Result<()> {
        const MAX_HEADER_BYTES: usize = 16 * 1024;
        let mut buf = Vec::with_capacity(2048);

        loop {
            let header_end = loop {
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break pos + 4;
                }
                if buf.len() >= MAX_HEADER_BYTES {
                    let _ = write_simple_response(&mut socket, "431 Request Header Fields Too Large", "Connection: close\r\n", b"").await;
                    return Ok(());
                }
                let mut tmp = [0u8; 1024];
                let n = socket.read(&mut tmp).await?;
                if n == 0 {
                    return Ok(());
                }
                buf.extend_from_slice(&tmp[..n]);
            };

            let req_text = String::from_utf8_lossy(&buf[..header_end]).into_owned();
            buf.drain(..header_end);
            let mut lines = req_text.split("\r\n");
            let Some(request_line) = lines.next() else {
                return Ok(());
            };
            let mut req_parts = request_line.split_whitespace();
            let method = req_parts.next().unwrap_or("");
            let target = req_parts.next().unwrap_or("");
            let version = req_parts.next().unwrap_or("HTTP/1.1");

            let mut range_hdr: Option<String> = None;
            let mut close_conn = version.eq_ignore_ascii_case("HTTP/1.0");
            for line in lines {
                if line.is_empty() {
                    break;
                }
                if let Some((name, val)) = line.split_once(':') {
                    let name_trim = name.trim();
                    if name_trim.eq_ignore_ascii_case("range") {
                        range_hdr = Some(val.trim().to_string());
                    } else if name_trim.eq_ignore_ascii_case("connection")
                        && val.trim().eq_ignore_ascii_case("close")
                    {
                        close_conn = true;
                    }
                }
            }

            if method.eq_ignore_ascii_case("OPTIONS") {
                write_simple_response(&mut socket, "204 No Content", "", b"").await?;
                if close_conn {
                    return Ok(());
                }
                continue;
            }

            let is_head = method.eq_ignore_ascii_case("HEAD");
            let is_get = method.eq_ignore_ascii_case("GET");
            if !is_get && !is_head {
                write_simple_response(&mut socket, "405 Method Not Allowed", "", b"").await?;
                if close_conn {
                    return Ok(());
                }
                continue;
            }

            let Some((torrent_id, file_idx)) = parse_stream_path(target) else {
                write_simple_response(&mut socket, "404 Not Found", "", b"not found").await?;
                if close_conn {
                    return Ok(());
                }
                continue;
            };

            let Some(handle) = session.get(TorrentIdOrHash::Id(torrent_id)) else {
                write_simple_response(&mut socket, "404 Not Found", "", b"torrent not found").await?;
                if close_conn {
                    return Ok(());
                }
                continue;
            };

            let file_name = handle
                .with_metadata(|m| {
                    m.file_infos
                        .get(file_idx)
                        .map(|f| f.relative_filename.to_string_lossy().into_owned())
                })
                .ok()
                .flatten()
                .unwrap_or_default();
            let mime = video_mime_type(&file_name);

            let mut stream = match handle.stream(file_idx).await {
                Ok(s) => s,
                Err(_) => {
                    write_simple_response(&mut socket, "404 Not Found", "", b"stream unavailable")
                        .await?;
                    if close_conn {
                        return Ok(());
                    }
                    continue;
                }
            };

            let total_len = stream.len();
            let (status_line, start, end, content_range_hdr) = if let Some(ref r) = range_hdr {
                match parse_http_range_header(r, total_len) {
                    Ok((s, e)) => (
                        "206 Partial Content",
                        s,
                        e,
                        Some(format!("Content-Range: bytes {s}-{e}/{total_len}\r\n")),
                    ),
                    Err(()) => {
                        let hdr = format!("Content-Range: bytes */{total_len}\r\n");
                        write_simple_response(&mut socket, "416 Range Not Satisfiable", &hdr, b"")
                            .await?;
                        if close_conn {
                            return Ok(());
                        }
                        continue;
                    }
                }
            } else if total_len == 0 {
                ("200 OK", 0, 0, None)
            } else {
                ("200 OK", 0, total_len - 1, None)
            };

            let content_len = if total_len == 0 { 0 } else { end - start + 1 };
            if !is_head && start > 0 {
                if let Err(err) = stream.seek(SeekFrom::Start(start)).await {
                    let msg = format!("seek error: {err}");
                    write_simple_response(
                        &mut socket,
                        "500 Internal Server Error",
                        "Connection: close\r\n",
                        msg.as_bytes(),
                    )
                    .await?;
                    return Ok(());
                }
            }

            let conn_hdr = if close_conn {
                "Connection: close\r\n"
            } else {
                "Connection: keep-alive\r\n"
            };
            let cr = content_range_hdr.as_deref().unwrap_or("");
            let head = format!(
                "HTTP/1.1 {status_line}\r\n\
                 Content-Type: {mime}\r\n\
                 Accept-Ranges: bytes\r\n\
                 Content-Length: {content_len}\r\n\
                 {cr}\
                 Access-Control-Allow-Origin: *\r\n\
                 Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
                 Access-Control-Allow-Headers: Range, Content-Type\r\n\
                 Cache-Control: no-store\r\n\
                 {conn_hdr}\r\n"
            );
            socket.write_all(head.as_bytes()).await?;

            if is_get && content_len > 0 {
                let mut remaining = content_len;
                let mut chunk = vec![0u8; 64 * 1024];
                while remaining > 0 {
                    let to_read = (remaining as usize).min(chunk.len());
                    let n = stream.read(&mut chunk[..to_read]).await?;
                    if n == 0 {
                        return Ok(());
                    }
                    socket.write_all(&chunk[..n]).await?;
                    remaining -= n as u64;
                }
            }
            socket.flush().await?;

            if close_conn {
                return Ok(());
            }
        }
    }

    pub async fn start_stream(
        app: tauri::AppHandle,
        magnet_or_hash: String,
        file_idx: Option<usize>,
    ) -> Result<TorrentStreamInfo, String> {
        let magnet = parse_magnet_or_infohash(&magnet_or_hash)?;
        let rt = get_or_init_runtime(&app).await?;

        let add_resp = rt
            .session
            .add_torrent(
                AddTorrent::from_url(magnet),
                Some(AddTorrentOptions {
                    overwrite: true,
                    ..Default::default()
                }),
            )
            .await
            .map_err(|e| format!("Failed to add torrent: {e:#}"))?;

        let (id, handle) = match add_resp {
            AddTorrentResponse::Added(id, handle)
            | AddTorrentResponse::AlreadyManaged(id, handle) => (id, handle),
            AddTorrentResponse::ListOnly(_) => {
                return Err("Unexpected list_only response when adding torrent".into());
            }
        };

        let files_meta: Vec<(String, u64)> = handle
            .with_metadata(|m| {
                m.file_infos
                    .iter()
                    .map(|f| (f.relative_filename.to_string_lossy().into_owned(), f.len))
                    .collect()
            })
            .map_err(|e| format!("Torrent metadata unavailable: {e:#}"))?;

        let chosen_idx = pick_video_file_index(&files_meta, file_idx)?;

        // Wait briefly for initial disk check so we can focus downloads on the selected file.
        if handle.wait_until_initialized().await.is_ok() {
            let mut only = HashSet::new();
            only.insert(chosen_idx);
            let _ = rt.session.update_only_files(&handle, &only).await;
        }

        let (file_name, file_size) = files_meta[chosen_idx].clone();
        let files = files_meta
            .into_iter()
            .enumerate()
            .map(|(index, (name, size))| TorrentFileInfo {
                index,
                is_video: is_video_filename(&name),
                name,
                size,
            })
            .collect();

        Ok(TorrentStreamInfo {
            id,
            url: format!("{}/torrents/{}/stream/{}", rt.base_url, id, chosen_idx),
            file_idx: chosen_idx,
            file_name,
            file_size,
            info_hash: handle.info_hash().as_string(),
            name: handle.name(),
            files,
        })
    }

    pub async fn status(id: usize) -> Result<TorrentStatusInfo, String> {
        let rt = TORRENT_RUNTIME
            .get()
            .ok_or_else(|| "Torrent session is not initialized".to_string())?;
        let handle = rt
            .session
            .get(TorrentIdOrHash::Id(id))
            .ok_or_else(|| format!("Torrent {id} not found"))?;

        let stats = handle.stats();
        let state = match stats.state {
            TorrentStatsState::Initializing { .. } => "initializing",
            TorrentStatsState::Live => "live",
            TorrentStatsState::Paused => "paused",
            TorrentStatsState::Error => "error",
        }
        .to_string();

        let progress = if stats.total_bytes > 0 {
            (stats.progress_bytes as f64 / stats.total_bytes as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };

        let (download_speed_bps, upload_speed_bps, peers, seeders) = match stats.live {
            Some(ref live) => (
                live.download_speed.as_bytes(),
                live.upload_speed.as_bytes(),
                live.snapshot.peer_stats.live,
                live.snapshot.peer_stats.live_seeders,
            ),
            None => (0, 0, 0, 0),
        };

        Ok(TorrentStatusInfo {
            id,
            state,
            progress_bytes: stats.progress_bytes,
            total_bytes: stats.total_bytes,
            progress,
            download_speed_bps,
            upload_speed_bps,
            peers,
            seeders,
            finished: stats.finished,
            error: stats.error,
        })
    }

    pub async fn stop(id: usize) -> Result<(), String> {
        let rt = TORRENT_RUNTIME
            .get()
            .ok_or_else(|| "Torrent session is not initialized".to_string())?;
        rt.session
            .delete(TorrentIdOrHash::Id(id), true)
            .await
            .map_err(|e| format!("Failed to stop torrent {id}: {e:#}"))
    }
}

#[cfg(feature = "torrent")]
#[tauri::command]
pub async fn torrent_start_stream(
    app: tauri::AppHandle,
    magnet_or_hash: String,
    file_idx: Option<usize>,
) -> Result<TorrentStreamInfo, String> {
    enabled::start_stream(app, magnet_or_hash, file_idx).await
}

#[cfg(feature = "torrent")]
#[tauri::command]
pub async fn torrent_status(id: usize) -> Result<TorrentStatusInfo, String> {
    enabled::status(id).await
}

#[cfg(feature = "torrent")]
#[tauri::command]
pub async fn torrent_stop(id: usize) -> Result<(), String> {
    enabled::stop(id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_magnets_and_infohashes() {
        let hex_hash = "0123456789ABCDEF0123456789abcdef01234567";
        assert_eq!(
            parse_magnet_or_infohash(hex_hash).unwrap(),
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"
        );

        let b32_hash = "abcdefghijklmnop234567abcdefghij";
        assert_eq!(
            parse_magnet_or_infohash(&format!("  {b32_hash}  ")).unwrap(),
            "magnet:?xt=urn:btih:ABCDEFGHIJKLMNOP234567ABCDEFGHIJ"
        );

        let full_magnet =
            "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Big+Buck+Bunny&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337";
        assert_eq!(parse_magnet_or_infohash(full_magnet).unwrap(), full_magnet);
    }

    #[test]
    fn rejects_invalid_or_non_magnet_inputs() {
        for bad in [
            "",
            "   ",
            "https://example.com/file.torrent",
            "C:\\movies\\test.torrent",
            "magnet:?dn=NoInfoHash",
            "magnet:?xt=urn:btih:tooshort",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        ] {
            assert!(
                parse_magnet_or_infohash(bad).is_err(),
                "expected error for {bad:?}"
            );
        }
    }

    #[test]
    fn picks_requested_or_largest_video_file() {
        let files = vec![
            ("Readme.txt".to_string(), 1024),
            ("Sample/Sample.mp4".to_string(), 50 * 1024 * 1024),
            ("Movie.2024.1080p.MKV".to_string(), 2_000 * 1024 * 1024),
            ("Extras/Trailer.webm".to_string(), 120 * 1024 * 1024),
        ];

        assert_eq!(pick_video_file_index(&files, None).unwrap(), 2);
        assert_eq!(pick_video_file_index(&files, Some(3)).unwrap(), 3);
        assert!(pick_video_file_index(&files, Some(9)).is_err());

        let non_video = vec![("archive.zip".to_string(), 500), ("notes.txt".to_string(), 100)];
        assert!(pick_video_file_index(&non_video, None).is_err());
        assert_eq!(pick_video_file_index(&non_video, Some(0)).unwrap(), 0);
        assert!(pick_video_file_index(&[], None).is_err());
    }

    #[test]
    fn detects_video_extensions_and_mime_types() {
        for name in ["a.mkv", "b.MP4", "c.webm", "d.Avi", "e.mov"] {
            assert!(is_video_filename(name), "expected video for {name}");
        }
        for name in ["a.srt", "b.txt", "c.exe", "noext"] {
            assert!(!is_video_filename(name), "expected non-video for {name}");
        }
        assert_eq!(video_mime_type("movie.mkv"), "video/x-matroska");
        assert_eq!(video_mime_type("movie.MP4"), "video/mp4");
        assert_eq!(video_mime_type("movie.webm"), "video/webm");
        assert_eq!(video_mime_type("movie.avi"), "video/x-msvideo");
        assert_eq!(video_mime_type("movie.mov"), "video/quicktime");
    }

    #[test]
    fn parses_http_byte_ranges() {
        assert_eq!(parse_http_range_header("bytes=0-", 1000).unwrap(), (0, 999));
        assert_eq!(parse_http_range_header("bytes=100-199", 1000).unwrap(), (100, 199));
        assert_eq!(parse_http_range_header("bytes=900-5000", 1000).unwrap(), (900, 999));
        assert_eq!(parse_http_range_header("bytes=-250", 1000).unwrap(), (750, 999));
        assert!(parse_http_range_header("bytes=1000-", 1000).is_err());
        assert!(parse_http_range_header("bytes=500-400", 1000).is_err());
        assert!(parse_http_range_header("bytes=0-", 0).is_err());
    }

    #[test]
    fn feature_flag_and_stub_behavior_match_cfg() {
        #[cfg(feature = "torrent")]
        assert!(torrent_is_supported());

        #[cfg(not(feature = "torrent"))]
        {
            assert!(!torrent_is_supported());
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            let err_status = rt.block_on(torrent_status(0)).unwrap_err();
            let err_stop = rt.block_on(torrent_stop(0)).unwrap_err();
            assert!(err_status.contains("not enabled"));
            assert!(err_stop.contains("not enabled"));
        }
    }
}
