//! Network shield and stream sniffer (WebView2).
//!
//! Shield: ad, pop-under and tracker hosts are answered with an empty 403 before a request
//! leaves the machine, in every frame (embeds included). Pop-ups and new windows opened by
//! frames are swallowed, a frame can't navigate the app away, and pages can't start downloads.
//! Nothing is shown to the viewer; blocked requests are only counted.
//!
//! Sniffer: an off-screen, muted window loads an embed page with the same shield, nudges its
//! player to start, and reports the first HLS playlist (or MP4) it requests, together with the
//! Referer/Origin/User-Agent that request carried. AbixCine then plays that stream itself
//! through the proxy, so the embed page (and its ads) never appear.

use crate::stream::Hdrs;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc::UnboundedSender;

/// Ad networks, pop-under rotators, push-notification spam and trackers seen on streaming
/// embeds. Matched against the host and all its subdomains.
pub const BLOCKED_HOSTS: &[&str] = &[
    // Google ads & analytics
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com", "googletagmanager.com",
    "googletagservices.com", "adservice.google.com", "adservice.google.de", "analytics.google.com", "pagead2.googlesyndication.com",
    // Pop-under / push / native ad networks common on embeds
    "popads.net", "popcash.net", "propellerads.com", "propellerclick.com", "adsterra.com", "adsterratools.com",
    "highperformanceformat.com", "profitabledisplaynetwork.com", "effectivegatecpm.com", "effectiveratecpm.com", "exoclick.com",
    "exosrv.com", "exdynsrv.com", "juicyads.com", "hilltopads.net", "hilltopads.com", "adcash.com", "a-ads.com", "clickadu.com",
    "onclickads.net", "onclkds.com", "onclickalgo.com", "mgid.com", "adskeeper.com", "admaven.com", "ad-maven.com", "rollerads.com",
    "monetag.com", "galaksion.com", "trafficstars.com", "tsyndicate.com", "trafficjunky.net", "cointraffic.io", "coinzilla.com",
    "bitmedia.io", "adspyglass.com", "pushame.com", "notix.io", "pushwhy.com", "richpush.co", "pushaffiliate.net",
    "rapidadexchange.com", "xadsmart.com", "imp-mintads.site", "usrpubtrck.com", "ahacdn.me", "acint.net", "dtscout.com",
    "dtscdn.com", "realsrv.com", "adxadserv.com", "aclib.net", "acscdn.com", "1rx.io", "betterads.co", "adblockanalytics.com",
    "pncloudfl.com", "srvqk3.com", "luugy.com", "tryedesign.com", "uuidksinc.net", "blockadsnot.com",
    // Rotating pop-under domains observed on vidsrc-family players
    "ukankingwithea.com", "canseealltheugline.org", "eifitcannotke.org", "embercascademaple.com", "bancadeltempoidea.org",
    "autorepairworcester.com", "aelwynvel.com", "cometslourdy.cfd", "pusleybrand.cyou", "nimbusgrovelodge.com",
    "brushetenglandagacant.qpon", "hyaloidsatury.com", "stummelbeelbow.com", "deedwaifpleas.org", "oceanicdreamcove.com",
    "cysyjucymudity.com", "cruzswim.org", "darnobedienceupscale.com", "derricknationtop.com",
    "e89d45b16370ee7e43daeaf6ce8d9547.com", "cepesbritons.qpon", "sarplerlacunes.qpon", "ixiondartman.com", "varnishtala.cyou",
    // Display ad exchanges
    "adnxs.com", "criteo.com", "criteo.net", "amazon-adsystem.com", "taboola.com", "outbrain.com", "revcontent.com",
    "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com", "33across.com", "bidswitch.net", "smartadserver.com",
    "adform.net", "zedo.com", "yieldmo.com", "sharethrough.com", "media.net",
    // Trackers / session recorders
    "facebook.net", "connect.facebook.net", "scorecardresearch.com", "quantserve.com", "hotjar.com", "clarity.ms",
    "mc.yandex.ru", "histats.com", "statcounter.com", "mixpanel.com", "segment.io", "amplitude.com", "newrelic.com",
    "nr-data.net", "csp-reporting.cloudflare.com", "sentry-cdn.com", "browser.sentry-cdn.com",
    // Exact hosts from known ad CDN buckets
    "1158060716.rsc.cdn77.org", "1376341044.rsc.cdn77.org", "1037973644.rsc.cdn77.org", "adright.xml-v4.ak-is2.net",
    // Parked-domain redirect and affiliate chains seen hijacking dead embed hosts
    "parklogic.com", "torbackg.com", "toplakehorizon.com", "dealshik.com", "adsco.re", "tagivi.com", "whos.amung.us",
    "bodis.com", "sedoparking.com", "parkingcrew.net", "above.com",
];

/// Same as `additionalBrowserArgs` in tauri.conf.json. Autoplay with sound is allowed:
/// pressing Play in the app is the gesture, and the stream should never start muted.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// Scripts blocked wherever they're hosted: anti-devtools / anti-adblock kits that blank the
/// player when they think they're being inspected.
pub const BLOCKED_URL_PARTS: &[&str] = &["disable-devtool", "devtools-detect", "devtools-detector", "adblock-detect", "fuckadblock", "blockadblock"];

static BLOCKED: AtomicU64 = AtomicU64::new(0);

pub fn is_blocked_url(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    host_of(uri).is_some_and(|h| is_blocked_host(&h)) || BLOCKED_URL_PARTS.iter().any(|p| lower.contains(p))
}

pub fn is_blocked_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    BLOCKED_HOSTS.iter().any(|b| host == *b || host.ends_with(&format!(".{b}")))
}

fn host_of(uri: &str) -> Option<String> {
    url::Url::parse(uri).ok().and_then(|u| u.host_str().map(|h| h.to_string()))
}

#[tauri::command]
pub fn shield_stats() -> u64 {
    BLOCKED.load(Ordering::Relaxed)
}

/// What the sniffer found on an embed page.
#[derive(Serialize, Clone, Debug)]
pub struct Sniffed {
    pub url: String,
    pub kind: &'static str, // "hls" | "mp4"
    pub headers: Hdrs,
    pub subtitles: Vec<String>,
    /// HLS only: the playlist was fetched and checked from Rust (None when not checked).
    pub verified: Option<bool>,
    /// Top resolution from the playlist, when known.
    pub quality: Option<u32>,
}

#[derive(Debug)]
pub enum Found {
    Media(Sniffed),
    Subtitle(String),
}

#[cfg(windows)]
mod win {
    use super::*;
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
    use windows::core::{Interface, BOOL, HSTRING, PWSTR};

    unsafe fn uri_of_request(req: &ICoreWebView2WebResourceRequest) -> String {
        let mut uri = PWSTR::null();
        let _ = req.Uri(&mut uri);
        take_pwstr(uri)
    }

    unsafe fn req_header(req: &ICoreWebView2WebResourceRequest, name: &str) -> Option<String> {
        let headers = req.Headers().ok()?;
        let mut contains = BOOL::default();
        headers.Contains(&HSTRING::from(name), &mut contains).ok()?;
        if !contains.as_bool() {
            return None;
        }
        let mut v = PWSTR::null();
        headers.GetHeader(&HSTRING::from(name), &mut v).ok()?;
        Some(take_pwstr(v))
    }

    /// Call a Chrome DevTools Protocol method on a webview (fire and forget).
    pub fn cdp(pw: &tauri::webview::PlatformWebview, method: &str, params: &str) {
        unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let _ = core.CallDevToolsProtocolMethod(
                &HSTRING::from(method),
                &HSTRING::from(params),
                &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(()))),
            );
        }
    }

    /// Install the shield (always) and the sniffer (when `sniff` is given) on one webview.
    pub fn install(pw: &tauri::webview::PlatformWebview, main: bool, sniff: Option<UnboundedSender<Found>>) {
        unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let env = pw.environment();

            // Filters: only the blocked hosts reach our request handler, so normal traffic
            // (including every video segment) pays nothing.
            let core22 = core.cast::<ICoreWebView2_22>().ok();
            for part in BLOCKED_URL_PARTS {
                let f = HSTRING::from(format!("*{part}*"));
                let ok = core22.as_ref().is_some_and(|c| {
                    c.AddWebResourceRequestedFilterWithRequestSourceKinds(&f, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL).is_ok()
                });
                if !ok {
                    let _ = core.AddWebResourceRequestedFilter(&f, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
                }
            }
            for h in BLOCKED_HOSTS {
                for pat in [format!("*://{h}/*"), format!("*://*.{h}/*")] {
                    let f = HSTRING::from(pat);
                    let ok = match &core22 {
                        Some(c) => c
                            .AddWebResourceRequestedFilterWithRequestSourceKinds(
                                &f,
                                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                                COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                            )
                            .is_ok(),
                        None => false,
                    };
                    if !ok {
                        let _ = core.AddWebResourceRequestedFilter(&f, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
                    }
                }
            }
            let mut token = Default::default();
            let env2 = env.clone();
            let _ = core.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let req = args.Request()?;
                    let uri = uri_of_request(&req);
                    // Other handlers (Tauri's own protocols) see these events too: only act on ours.
                    if is_blocked_url(&uri) {
                        BLOCKED.fetch_add(1, Ordering::Relaxed);
                        let resp = env2.CreateWebResourceResponse(None, 403, &HSTRING::from("Blocked"), &HSTRING::new())?;
                        args.SetResponse(&resp)?;
                    }
                    Ok(())
                })),
                &mut token,
            );

            // Pop-ups and new windows. Links the app itself opens (trailers, IMDb) go to the
            // system browser; anything a frame tries to open is dropped.
            let _ = core.add_NewWindowRequested(
                &NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut from_app = false;
                    if let Ok(a3) = args.cast::<ICoreWebView2NewWindowRequestedEventArgs3>() {
                        if let Ok(frame) = a3.OriginalSourceFrameInfo() {
                            let mut src = PWSTR::null();
                            let _ = frame.Source(&mut src);
                            let src = take_pwstr(src);
                            from_app = main && host_of(&src).is_some_and(|h| h == "localhost" || h.ends_with(".localhost"));
                        }
                    }
                    if from_app {
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = take_pwstr(uri);
                        if uri.starts_with("https://") || uri.starts_with("http://") {
                            let _ = std::process::Command::new("explorer").arg(&uri).spawn();
                        }
                    } else {
                        BLOCKED.fetch_add(1, Ordering::Relaxed);
                    }
                    args.SetHandled(true)?;
                    Ok(())
                })),
                &mut token,
            );

            // A frame must never be able to take over the app window.
            if main {
                let _ = core.add_NavigationStarting(
                    &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = take_pwstr(uri);
                        let ours = host_of(&uri).is_none_or(|h| h == "localhost" || h.ends_with(".localhost"))
                            || uri.starts_with("about:")
                            || uri.starts_with("tauri:");
                        if !ours {
                            BLOCKED.fetch_add(1, Ordering::Relaxed);
                            args.SetCancel(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            }

            // No drive-by downloads.
            if let Ok(c4) = core.cast::<ICoreWebView2_4>() {
                let _ = c4.add_DownloadStarting(
                    &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                        if let Some(args) = args {
                            args.SetHandled(true)?;
                            args.SetCancel(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            }

            let Some(tx) = sniff else { return };
            #[cfg(debug_assertions)]
            if std::env::var_os("ABX_SNIFF_DEBUG").is_some() {
                let _ = core.add_NavigationStarting(
                    &NavigationStartingEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            println!("  NAV start {}", take_pwstr(uri));
                        }
                        Ok(())
                    })),
                    &mut token,
                );
                let _ = core.add_NavigationCompleted(
                    &NavigationCompletedEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            let mut ok = BOOL::default();
                            let _ = args.IsSuccess(&mut ok);
                            let mut st = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                            let _ = args.WebErrorStatus(&mut st);
                            println!("  NAV done ok={} status={:?}", ok.as_bool(), st.0);
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            }
            if let Ok(c8) = core.cast::<ICoreWebView2_8>() {
                let _ = c8.SetIsMuted(true);
            }
            let Ok(c2) = core.cast::<ICoreWebView2_2>() else { return };
            let _ = c2.add_WebResourceResponseReceived(
                &WebResourceResponseReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let req = args.Request()?;
                    let uri = uri_of_request(&req);
                    if host_of(&uri).is_none_or(|h| is_blocked_host(&h)) {
                        return Ok(());
                    }
                    let status = args
                        .Response()
                        .ok()
                        .and_then(|r| {
                            let mut c = 0i32;
                            r.StatusCode(&mut c).ok().map(|_| c)
                        })
                        .unwrap_or(200);
                    if status >= 400 {
                        return Ok(());
                    }
                    let ctype = args
                        .Response()
                        .and_then(|r| r.Headers())
                        .ok()
                        .and_then(|h| {
                            let mut v = PWSTR::null();
                            h.GetHeader(&HSTRING::from("Content-Type"), &mut v).ok().map(|_| take_pwstr(v))
                        })
                        .unwrap_or_default()
                        .to_ascii_lowercase();
                    let path = uri.split('?').next().unwrap_or("").to_ascii_lowercase();
                    #[cfg(debug_assertions)]
                    if std::env::var_os("ABX_SNIFF_DEBUG").is_some() {
                        let preview: String = uri.chars().take(160).collect();
                        println!("  RESP {status} [{ctype}] {preview}");
                    }
                    let kind = if ctype.contains("mpegurl") || path.ends_with(".m3u8") || uri.to_ascii_lowercase().contains(".m3u8") {
                        Some("hls")
                    } else if ctype.contains("dash+xml") || path.ends_with(".mpd") {
                        Some("dash")
                    } else if ctype.starts_with("video/mp4") || path.ends_with(".mp4") {
                        Some("mp4")
                    } else {
                        None
                    };
                    if let Some(kind) = kind {
                        let headers = Hdrs {
                            referer: req_header(&req, "Referer"),
                            origin: req_header(&req, "Origin"),
                            ua: req_header(&req, "User-Agent"),
                        };
                        let _ = tx.send(Found::Media(Sniffed { url: uri, kind, headers, subtitles: vec![], verified: None, quality: None }));
                    } else if path.ends_with(".vtt") || path.ends_with(".srt") || ctype.contains("text/vtt") {
                        let _ = tx.send(Found::Subtitle(uri));
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
    }
}

#[cfg(windows)]
pub use win::{cdp, install};

#[cfg(not(windows))]
pub fn cdp(_pw: &tauri::webview::PlatformWebview, _method: &str, _params: &str) {}

#[cfg(not(windows))]
pub fn install(_pw: &tauri::webview::PlatformWebview, _main: bool, _sniff: Option<UnboundedSender<Found>>) {}

/// Runs in every frame of a sniff window: mute everything, stop window.open, and keep nudging
/// the player to start (most embeds request their playlist only once playback begins).
const NUDGE_JS: &str = r#"
(() => {
  try {
    window.open = () => null;
    // The check window is hidden: tell players they're on screen so they load like normal.
    try {
      Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
      Document.prototype.hasFocus = () => true;
      const IO = window.IntersectionObserver;
      if (IO) window.IntersectionObserver = class {
        constructor(cb) { this.cb = cb; }
        observe(el) { const r = el.getBoundingClientRect(); setTimeout(() => this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1, boundingClientRect: r, intersectionRect: r, rootBounds: null, time: performance.now() }], this), 0); }
        unobserve() {} disconnect() {} takeRecords() { return []; }
      };
    } catch {}
    const sels = ['.vjs-big-play-button','.jw-display-icon-display','.plyr__control--overlaid','.play-button','#play-button',
      '.playbtn','#btn-play','.btn-play','[aria-label="Play"]','button[title="Play"]','.art-control-play','.fp-play','.vds-play-button'];
    let n = 0;
    const tick = () => {
      if (++n > 40) return;
      document.querySelectorAll('video,audio').forEach(v => { try { v.muted = true; const p = v.play(); p && p.catch(() => {}); } catch {} });
      for (const s of sels) { const el = document.querySelector(s); if (el) { try { el.click(); } catch {} break; } }
      if (n % 3 === 0) {
        const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        if (el && el.tagName !== 'IFRAME') try { el.click(); } catch {}
      }
      setTimeout(tick, 700);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(tick, 300));
    else setTimeout(tick, 300);
  } catch {}
})();
"#;

fn sem() -> &'static tokio::sync::Semaphore {
    static S: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(4))
}

struct SniffCancelEntry {
    label: Option<String>,
    tx: tokio::sync::watch::Sender<bool>,
}

fn cancel_map() -> &'static std::sync::Mutex<std::collections::HashMap<String, SniffCancelEntry>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, SniffCancelEntry>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Immediately cancel an in-flight `sniff_media` task and destroy its hidden WebView2 window.
#[tauri::command]
pub fn cancel_sniff(app: AppHandle, cancel_id: String) {
    let entry = cancel_map().lock().ok().and_then(|mut m| m.remove(&cancel_id));
    if let Some(entry) = entry {
        let _ = entry.tx.send(true);
        if let Some(label) = entry.label {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
        }
    } else if let Ok(mut m) = cancel_map().lock() {
        let (tx, _rx) = tokio::sync::watch::channel(true);
        m.insert(cancel_id, SniffCancelEntry { label: None, tx });
    }
}

/// Load `url` off-screen and return the stream it plays, or None if nothing turned up in time.
#[tauri::command]
pub async fn sniff_media(
    app: AppHandle,
    url: String,
    timeout_ms: Option<u64>,
    cancel_id: Option<String>,
) -> Result<Option<Sniffed>, String> {
    use std::sync::atomic::AtomicUsize;
    static N: AtomicUsize = AtomicUsize::new(0);
    let label = format!("sniff-{}", N.fetch_add(1, Ordering::Relaxed));

    let mut cancel_rx = if let Some(ref cid) = cancel_id {
        let (tx, rx) = tokio::sync::watch::channel(false);
        let already_cancelled = if let Ok(mut m) = cancel_map().lock() {
            if let Some(existing) = m.remove(cid) {
                *existing.tx.borrow()
            } else {
                m.insert(cid.clone(), SniffCancelEntry { label: Some(label.clone()), tx });
                false
            }
        } else {
            false
        };
        if already_cancelled {
            return Ok(None);
        }
        Some(rx)
    } else {
        None
    };

    let budget = std::time::Duration::from_millis(timeout_ms.unwrap_or(14_000) + 6_000);
    let fut = tokio::time::timeout(budget, sniff_inner(app.clone(), url, timeout_ms, label.clone()));

    let res = match cancel_rx.as_mut() {
        Some(rx) => {
            tokio::select! {
                r = fut => r.ok(),
                _ = rx.changed() => None,
            }
        }
        None => fut.await.ok(),
    };

    if let Some(ref cid) = cancel_id {
        if let Ok(mut m) = cancel_map().lock() {
            m.remove(cid);
        }
    }

    // Hard ceiling or cancellation: whatever a page does, its window is destroyed on exit.
    match res {
        Some(r) => r,
        None => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
            Ok(None)
        }
    }
}

async fn sniff_inner(app: AppHandle, url: String, timeout_ms: Option<u64>, label: String) -> Result<Option<Sniffed>, String> {
    let target: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    let t0 = std::time::Instant::now();
    let _ = t0; // only read by the debug timing log
    let dbg = |what: &str| {
        #[cfg(debug_assertions)]
        if std::env::var_os("ABX_SNIFF_DEBUG").is_some() {
            println!("  T+{}ms {what}", t0.elapsed().as_millis());
        }
        let _ = what;
    };
    let _permit = sem().acquire().await.map_err(|e| e.to_string())?;
    dbg("permit");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Found>();

    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External("about:blank".parse().unwrap()))
        .title("AbixCine resolver")
        .inner_size(960.0, 540.0)
        .position(-32000.0, -32000.0)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        // Never shown: no taskbar entry, no Alt-Tab, no flash. The webview inside is still
        // marked visible (below), so pages don't throttle their players.
        .visible(false)
        .initialization_script_for_all_frames(NUDGE_JS)
        // Must match the main window's arguments: WebView2 shares one browser per data folder.
        .additional_browser_args(BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let tx2 = tx.clone();
    win.with_webview(move |pw| {
        #[cfg(windows)]
        unsafe {
            let _ = pw.controller().SetIsVisible(true);
        }
        install(&pw, false, Some(tx2));
        let _ = ready_tx.send(());
    })
    .map_err(|e| e.to_string())?;
    dbg("built");
    let _ = ready_rx.await;
    dbg("shield ready");
    drop(tx);
    let _ = win.navigate(target.clone());

    // Many players only fetch their stream after a real click on "play". Script clicks don't
    // count as a user gesture and can't reach cross-origin or script-written frames, so send
    // trusted mouse input through the DevTools protocol instead, at the centre of the player,
    // a few times while the page settles. Focus is emulated so "is the tab active?" checks pass.
    {
        let w = win.clone();
        tauri::async_runtime::spawn(async move {
            let _ = w.with_webview(|pw| cdp(&pw, "Emulation.setFocusEmulationEnabled", r#"{"enabled":true}"#));
            for i in 0..9u32 {
                tokio::time::sleep(std::time::Duration::from_millis(if i == 0 { 1800 } else { 1400 })).await;
                // Centre, then slightly lower (big play buttons sit centre; some players put a bar below).
                let (x, y) = if i % 3 == 2 { (480, 330) } else { (480, 270) };
                let ok = w.with_webview(move |pw| {
                    for (kind, buttons) in [("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 1)] {
                        let p = format!(r#"{{"type":"{kind}","x":{x},"y":{y},"button":"left","buttons":{buttons},"clickCount":1}}"#);
                        cdp(&pw, "Input.dispatchMouseEvent", &p);
                    }
                });
                if ok.is_err() {
                    break; // window already closed: the stream was found
                }
            }
        });
    }

    let page_origin = target.host_str().map(|h| match target.port() {
        Some(p) => format!("{}://{}:{}", target.scheme(), h, p),
        None => format!("{}://{}", target.scheme(), h),
    });
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.unwrap_or(14_000));
    let mut candidates: Vec<Sniffed> = Vec::new();
    let mut subs: Vec<String> = Vec::new();
    loop {
        // Once a stream is found, linger briefly for a master playlist or subtitle tracks.
        let until = match candidates.first() {
            Some(_) => (tokio::time::Instant::now() + std::time::Duration::from_millis(900)).min(deadline),
            None => deadline,
        };
        match tokio::time::timeout_at(until, rx.recv()).await {
            Ok(Some(Found::Media(mut m))) => {
                if m.headers.referer.as_deref().unwrap_or("").is_empty() {
                    if let Some(ref orig) = page_origin {
                        m.headers.referer = Some(format!("{orig}/"));
                    }
                }
                if m.headers.origin.as_deref().unwrap_or("").is_empty() {
                    m.headers.origin = m
                        .headers
                        .referer
                        .as_deref()
                        .and_then(|r| url::Url::parse(r).ok())
                        .and_then(|u| u.host_str().map(|h| match u.port() {
                            Some(p) => format!("{}://{}:{}", u.scheme(), h, p),
                            None => format!("{}://{}", u.scheme(), h),
                        }))
                        .or_else(|| page_origin.clone());
                }
                if !candidates.iter().any(|c| c.url == m.url) {
                    candidates.push(m);
                }
            }
            Ok(Some(Found::Subtitle(s))) => {
                if !subs.contains(&s) {
                    subs.push(s);
                }
            }
            Ok(None) | Err(_) => {
                dbg("wait over");
                break;
            }
        }
    }
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
        dbg("destroyed");
    }
    if candidates.is_empty() {
        return Ok(None);
    }
    // Prefer HLS master playlists over variant playlists, and HLS/DASH over progressive MP4.
    candidates.sort_by_key(|m| {
        let rank_kind = match m.kind {
            "hls" if m.url.contains("master") => 0,
            "hls" => 1,
            "dash" => 2,
            _ => 3,
        };
        rank_kind
    });
    let mut fallback: Option<Sniffed> = None;
    for mut f in candidates {
        f.subtitles = subs.clone();
        if f.kind == "hls" {
            match crate::stream::verify_playlist(&f.url, &f.headers).await {
                Some(q) => {
                    f.verified = Some(true);
                    f.quality = (q > 0).then_some(q);
                    return Ok(Some(f));
                }
                None => {
                    f.verified = Some(false);
                    if fallback.is_none() {
                        fallback = Some(f);
                    }
                }
            }
        } else {
            return Ok(Some(f));
        }
    }
    Ok(fallback)
}
