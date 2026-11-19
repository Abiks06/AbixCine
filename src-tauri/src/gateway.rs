//! Loopback streaming gateway (PERF-07).
//!
//! The `abxs:` custom protocol answers each request with one `Vec<u8>`, so every proxied
//! segment or byte range is read completely into memory before WebView2 sees its first byte —
//! extra latency on every request and up to tens of MB per in-flight range on 4K files.
//!
//! This serves the very same proxy (`stream::handle_with`) over HTTP/1.1 on `127.0.0.1:<random
//! port>`, but media bodies are forwarded chunk by chunk as they arrive from upstream: memory
//! stays flat, the player gets the first bytes immediately, and a seek simply drops the
//! connection (and with it the upstream request). Playlists and MPDs are still buffered, since
//! they have to be rewritten.
//!
//! Access control: the listener is loopback-only, every path must start with a random
//! per-launch token (which only the app's own window learns, via [`stream_gateway`]), the Host
//! header must be the literal loopback address (no DNS rebinding), and a request carrying an
//! Origin must come from the app. Proxy targets are validated exactly as for `abxs:`.
//!
//! The frontend health-checks the gateway and keeps using `abxs:` when it isn't reachable.

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::sync::OnceLock;
use tauri::http::{header, Request, Response, StatusCode};

use crate::stream::{self, Proxied};

struct Gateway {
    port: u16,
    token: String,
    /// `http://127.0.0.1:<port>/<token>`: what nested playlist URIs are rewritten to.
    base: String,
}

static GATEWAY: OnceLock<Gateway> = OnceLock::new();

type Body = BoxBody<Bytes, std::io::Error>;

fn random_token() -> String {
    let mut buf = [0u8; 16];
    if getrandom::getrandom(&mut buf).is_err() {
        // Practically unreachable; fall back to std's randomly seeded hasher.
        use std::hash::{BuildHasher, Hasher};
        for (i, chunk) in buf.chunks_mut(8).enumerate() {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_usize(i);
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
            chunk.copy_from_slice(&h.finish().to_le_bytes());
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Bind the listener and start serving. Safe to call once; later calls are no-ops.
pub fn start() {
    if GATEWAY.get().is_some() {
        return;
    }
    let std_listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            crate::diagnostics::log(format!("stream gateway disabled: bind failed: {e}"));
            return;
        }
    };
    let port = match std_listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return,
    };
    if std_listener.set_nonblocking(true).is_err() {
        return;
    }
    let token = random_token();
    let base = format!("http://127.0.0.1:{port}/{token}");
    if GATEWAY.set(Gateway { port, token, base }).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                crate::diagnostics::log(format!("stream gateway disabled: {e}"));
                return;
            }
        };
        serve(listener).await;
    });
}

async fn serve(listener: tokio::net::TcpListener) {
    loop {
        let (sock, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let _ = sock.set_nodelay(true);
        tauri::async_runtime::spawn(async move {
            let _ = hyper::server::conn::http1::Builder::new()
                .keep_alive(true)
                .serve_connection(TokioIo::new(sock), service_fn(route))
                .await;
        });
    }
}

fn plain(status: StatusCode, msg: &'static str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Full::new(Bytes::from_static(msg.as_bytes())).map_err(|e| match e {}).boxed())
        .unwrap()
}

/// Host / Origin / token checks. Returns the proxy-relative path+query (`/p?...`) when allowed.
fn authorize<'a>(path_and_query: &'a str, host: Option<&str>, origin: Option<&str>, gw: &Gateway) -> Result<&'a str, StatusCode> {
    let expected_host = format!("127.0.0.1:{}", gw.port);
    if host != Some(expected_host.as_str()) {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(o) = origin {
        if o != stream::app_origin() {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    let rest = path_and_query
        .strip_prefix('/')
        .and_then(|p| p.strip_prefix(gw.token.as_str()))
        .filter(|r| r.starts_with('/'))
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(rest)
}

async fn route(req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    let Some(gw) = GATEWAY.get() else {
        return Ok(plain(StatusCode::SERVICE_UNAVAILABLE, "gateway not ready"));
    };
    let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok());
    let origin = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let pq = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let rest = match authorize(pq, host, origin, gw) {
        Ok(r) => r.to_string(),
        Err(code) => return Ok(plain(code, "forbidden")),
    };

    if rest == "/ping" {
        let r = stream::cors_builder(Response::builder().status(StatusCode::NO_CONTENT)).body(Vec::new()).unwrap();
        return Ok(full(r));
    }
    if !rest.starts_with("/p?") {
        return Ok(plain(StatusCode::NOT_FOUND, "not found"));
    }

    // Same request shape the abxs: handler sees: method, Range header, proxy query.
    let mut b = Request::builder().method(req.method().clone()).uri(format!("http://127.0.0.1:{}{rest}", gw.port));
    if let Some(r) = req.headers().get(header::RANGE) {
        b = b.header(header::RANGE, r.clone());
    }
    let Ok(inner) = b.body(Vec::new()) else {
        return Ok(plain(StatusCode::BAD_REQUEST, "bad request"));
    };
    drop(req);

    Ok(match stream::handle_with(inner, &gw.base, true).await {
        Proxied::Full(r) => full(r),
        Proxied::Stream { head, prefix, rest } => {
            let first = (!prefix.is_empty()).then(|| Ok::<_, std::io::Error>(Frame::data(Bytes::from(prefix))));
            let tail = futures_util::stream::unfold(Some(rest), |state| async move {
                let mut res = state?;
                match res.chunk().await {
                    Ok(Some(c)) => Some((Ok(Frame::data(c)), Some(res))),
                    Ok(None) => None,
                    Err(e) => Some((Err(std::io::Error::other(e)), None)),
                }
            });
            let body = StreamBody::new(futures_util::stream::iter(first).chain(tail));
            match head.body(BodyExt::boxed(body)) {
                Ok(r) => r,
                Err(_) => plain(StatusCode::BAD_GATEWAY, "bad upstream headers"),
            }
        }
    })
}

fn full(r: Response<Vec<u8>>) -> Response<Body> {
    let (parts, body) = r.into_parts();
    Response::from_parts(parts, Full::new(Bytes::from(body)).map_err(|e| match e {}).boxed())
}

use futures_util::StreamExt as _;

/// The gateway's base URL for the main window, or `None` when it isn't running.
#[tauri::command]
pub fn stream_gateway(webview: tauri::Webview) -> Option<String> {
    // Hidden sniff windows run untrusted embed pages: they must never learn the token.
    if webview.label() != "main" {
        return None;
    }
    GATEWAY.get().map(|g| g.base.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gw() -> Gateway {
        Gateway { port: 5555, token: "ab".repeat(16), base: String::new() }
    }

    #[test]
    fn requires_token_host_and_app_origin() {
        let g = gw();
        let ok_path = format!("/{}/p?u=x", g.token);
        assert_eq!(authorize(&ok_path, Some("127.0.0.1:5555"), None, &g), Ok("/p?u=x"));
        assert_eq!(authorize(&ok_path, Some("127.0.0.1:5555"), Some(stream::app_origin()), &g), Ok("/p?u=x"));
        assert_eq!(authorize(&ok_path, Some("evil.example:5555"), None, &g), Err(StatusCode::FORBIDDEN));
        assert_eq!(authorize(&ok_path, None, None, &g), Err(StatusCode::FORBIDDEN));
        assert_eq!(authorize(&ok_path, Some("127.0.0.1:5555"), Some("https://evil.example"), &g), Err(StatusCode::FORBIDDEN));
        assert_eq!(authorize("/p?u=x", Some("127.0.0.1:5555"), None, &g), Err(StatusCode::NOT_FOUND));
        let wrong = format!("/{}/p?u=x", "cd".repeat(16));
        assert_eq!(authorize(&wrong, Some("127.0.0.1:5555"), None, &g), Err(StatusCode::NOT_FOUND));
        // Token must be a whole path segment.
        let glued = format!("/{}x/p", g.token);
        assert_eq!(authorize(&glued, Some("127.0.0.1:5555"), None, &g), Err(StatusCode::NOT_FOUND));
    }

    #[test]
    fn tokens_are_random_hex() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
