//! Network shield and stream sniffer (WebView2).
//!
//! Shield: powered by `brave/adblock-rust` (`adblock::Engine`). Ad, pop-under, crypto-miner,
//! redirector and tracker requests are answered with an empty 403 before a request leaves the
//! machine, in every frame (embeds included), and targeted cosmetic/scriptlet rules sanitize
//! embed overlays and popunder hooks without touching AbixCine's own UI or video players.
//! Pop-ups and new windows opened by frames are swallowed, a frame can't navigate the app
//! away, and pages can't start downloads. Blocked requests are only counted.
//!
//! Sniffer: an off-screen, muted window loads an embed page with the same shield, nudges its
//! player to start, and reports the first HLS playlist (or MP4) it requests, together with the
//! Referer/Origin/User-Agent that request carried. AbixCine then plays that stream itself
//! through the proxy, so the embed page (and its ads) never appear.

use crate::stream::Hdrs;
use adblock::{
    lists::{FilterSet, ParseOptions},
    request::Request as AdblockRequest,
    resources::{MimeType, Resource, ResourceType},
    Engine,
};
use base64::{engine::general_purpose::STANDARD as B64_STD, Engine as _};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock, RwLock,
};
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

/// Curated EasyList / uBlock ruleset layered over `BLOCKED_HOSTS` and `BLOCKED_URL_PARTS`:
/// covers local exemptions, additional ad/tracker/redirector domains, crypto miners,
/// third-party popunder & VAST/VPAID patterns, and safe embed cosmetic/scriptlet rules.
const CURATED_RULES: &str = r#"
! Local & Tauri protocol exemptions
@@||localhost^$important
@@||127.0.0.1^$important
@@||abxs.localhost^$important
@@||tauri.localhost^$important
@@||asset.localhost^$important

! Additional ad networks, trackers & embed redirectors
||a.magsrv.com^
||s.magsrv.com^
||a.realsrv.com^
||s.realsrv.com^
||syndication.exoclick.com^
||syndication.realsrv.com^
||cdn.tsyndicate.com^
||ero-advertising.com^
||plugrush.com^
||twinred.com^
||trafficforce.com^
||adxpansion.com^
||protraffic.net^
||cloudflareinsights.com^
||alexametrics.com^
||mc.yandex.com^
||pixel.facebook.com^
||bat.bing.com^
||ads.twitter.com^
||analytics.tiktok.com^

! Crypto miners
||coinhive.com^
||coin-hive.com^
||authedmine.com^
||jsecoin.com^
||crypto-loot.com^
||cryptoloot.pro^
||minero.cc^
||webminepool.com^
||monero-miner.com^
||ppoi.org^
||browsermine.com^
||coinimp.com^
||webminerpool.com^

! Pop-under, redirector & ad-tag URL patterns (third-party / script scoped so media is untouched)
*/popunder*.js$script
*/pop.js$script,third-party
*/popup*.js$script,third-party
/pagead/$script,third-party
/vast.xml$xmlhttprequest,third-party
/vpaid$script,third-party

! Targeted cosmetic hide rules for ad overlays & click-hijack layers (never player controls)
##.adsbytrafficjunky
##.adsbox
##.ad-overlay
##.ads-overlay
##.pop-overlay
##.popunder-overlay
##.exo-ipp
##.mgbox
##ins.adsbygoogle
##[id^="mgid"]
##[id*="ScriptRoot"]
##iframe[src*="doubleclick.net"]
##iframe[src*="googlesyndication.com"]
##iframe[src*="exosrv.com"]
##iframe[src*="realsrv.com"]
##iframe[src*="adsterra.com"]
##iframe[src*="highperformanceformat.com"]
##div[style*="z-index: 2147483647"] > a[target="_blank"]

! Safe anti-popup & anti-adblock scriptlets for streaming embed hosts/entities
vidsrc.*,vidlink.*,2embed.*,embed.*,multiembed.*,moviesapi.*,smashy.*,autoembed.*,vidbinge.*,vidplay.*,megacloud.*,filemoon.*,streamwish.*,doodstream.*,dood.*,mixdrop.*,voe.*,streamtape.*,upstream.*,lulustream.*,vidhide.*,filelions.*,hglink.*,cybervynx.*##+js(nowoif)
vidsrc.*,vidlink.*,2embed.*,embed.*,multiembed.*,moviesapi.*,smashy.*,autoembed.*,vidbinge.*,vidplay.*,megacloud.*,filemoon.*,streamwish.*,doodstream.*,dood.*,mixdrop.*,voe.*,streamtape.*,upstream.*,lulustream.*,vidhide.*,filelions.*,hglink.*,cybervynx.*##+js(set-constant, canRunAds, true)
vidsrc.*,vidlink.*,2embed.*,embed.*,multiembed.*,moviesapi.*,smashy.*,autoembed.*,vidbinge.*,vidplay.*,megacloud.*,filemoon.*,streamwish.*,doodstream.*,dood.*,mixdrop.*,voe.*,streamtape.*,upstream.*,lulustream.*,vidhide.*,filelions.*,hglink.*,cybervynx.*##+js(set-constant, isAdBlockActive, false)
vidsrc.*,vidlink.*,2embed.*,embed.*,multiembed.*,moviesapi.*,smashy.*,autoembed.*,vidbinge.*,vidplay.*,megacloud.*,filemoon.*,streamwish.*,doodstream.*,dood.*,mixdrop.*,voe.*,streamtape.*,upstream.*,lulustream.*,vidhide.*,filelions.*,hglink.*,cybervynx.*##+js(set-constant, adblockDetected, false)
"#;

const SHIELD_CACHE_FILE: &str = "shield_filters.txt";
const FILTER_UPDATE_URL: &str =
    "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext";
const MAX_CACHE_BYTES: usize = 2 * 1024 * 1024;
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;

static BLOCKED: AtomicU64 = AtomicU64::new(0);
static ENGINE: OnceLock<RwLock<Arc<Engine>>> = OnceLock::new();
static CACHE_INIT: OnceLock<()> = OnceLock::new();

fn shield_resources() -> Vec<Resource> {
    let nowoif_js = r#"function abxNoWoiF() {
  if (window.__abxNoWoiF) return;
  window.__abxNoWoiF = true;
  const origOpen = window.open;
  window.open = function(url) {
    try {
      if (!url || typeof url !== 'string') return null;
      const s = url.trim().toLowerCase();
      if (s === '' || s === 'about:blank' || s.startsWith('http://') || s.startsWith('https://')) {
        return null;
      }
    } catch {}
    return origOpen ? origOpen.apply(this, arguments) : null;
  };
}"#;
    let set_const_js = r#"function abxSetConstant(prop, val) {
  try {
    let parsed;
    if (val === 'true') parsed = true;
    else if (val === 'false') parsed = false;
    else if (val === 'null') parsed = null;
    else if (val === 'undefined') parsed = undefined;
    else if (val === 'noopFunc') parsed = function() {};
    else if (val === 'trueFunc') parsed = function() { return true; };
    else if (val === 'falseFunc') parsed = function() { return false; };
    else parsed = val;
    const parts = String(prop).split('.');
    let obj = window;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') return;
      obj = obj[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    Object.defineProperty(obj, leaf, {
      get: () => parsed,
      set: () => {},
      configurable: true
    });
  } catch {}
}"#;
    vec![
        Resource {
            name: "nowoif.js".to_string(),
            aliases: vec![],
            kind: ResourceType::Mime(MimeType::ApplicationJavascript),
            content: B64_STD.encode(nowoif_js),
            dependencies: vec![],
            permission: Default::default(),
        },
        Resource {
            name: "set-constant.js".to_string(),
            aliases: vec![],
            kind: ResourceType::Mime(MimeType::ApplicationJavascript),
            content: B64_STD.encode(set_const_js),
            dependencies: vec![],
            permission: Default::default(),
        },
    ]
}

pub(crate) fn build_engine(extra_rules: Option<&str>) -> Engine {
    let mut filter_set = FilterSet::new(false);
    filter_set.add_filter_list(CURATED_RULES.to_string(), ParseOptions::default());

    let mut host_rules = String::with_capacity(BLOCKED_HOSTS.len() * 24 + BLOCKED_URL_PARTS.len() * 24);
    for h in BLOCKED_HOSTS {
        host_rules.push_str("||");
        host_rules.push_str(h);
        host_rules.push_str("^\n");
    }
    for part in BLOCKED_URL_PARTS {
        host_rules.push('*');
        host_rules.push_str(part);
        host_rules.push_str("*\n");
    }
    filter_set.add_filter_list(host_rules, ParseOptions::default());

    if let Some(extra) = extra_rules {
        if !extra.trim().is_empty() {
            filter_set.add_filter_list(extra.to_string(), ParseOptions::default());
        }
    }

    let mut eng = Engine::new_with_filter_set(filter_set);
    eng.use_resources(shield_resources());
    eng
}

fn engine_lock() -> &'static RwLock<Arc<Engine>> {
    ENGINE.get_or_init(|| RwLock::new(Arc::new(build_engine(None))))
}

fn engine() -> Arc<Engine> {
    match engine_lock().read() {
        Ok(guard) => Arc::clone(&guard),
        Err(poisoned) => Arc::clone(&poisoned.into_inner()),
    }
}

fn swap_engine_with_extra(extra_rules: &str) {
    let next = Arc::new(build_engine(Some(extra_rules)));
    if let Ok(mut guard) = engine_lock().write() {
        *guard = next;
    }
}

fn maybe_refresh_filter_cache(app: &AppHandle) {
    if CACHE_INIT.set(()).is_err() {
        return;
    }
    let Ok(dir) = app.path().app_local_data_dir() else {
        return;
    };
    let path = dir.join(SHIELD_CACHE_FILE);
    let allow_remote = std::env::var_os("ABX_NO_FILTER_UPDATE").is_none()
        && std::env::var_os("ABX_SNIFF_TEST").is_none();

    tauri::async_runtime::spawn(async move {
        let mut needs_refresh = allow_remote;
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            if meta.len() <= MAX_CACHE_BYTES as u64 {
                if let Ok(text) = tokio::fs::read_to_string(&path).await {
                    if text.contains("||") {
                        swap_engine_with_extra(&text);
                    }
                }
            }
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = std::time::SystemTime::now().duration_since(modified) {
                    if age.as_secs() < CACHE_TTL_SECS {
                        needs_refresh = false;
                    }
                }
            }
        }
        if !needs_refresh {
            return;
        }
        let Ok(resp) = crate::stream::client()
            .get(FILTER_UPDATE_URL)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        else {
            return;
        };
        if !resp.status().is_success() {
            return;
        }
        let Ok(body) = resp.text().await else {
            return;
        };
        if body.len() > MAX_CACHE_BYTES
            || !body.contains("||")
            || body.trim_start().starts_with('<')
        {
            return;
        }
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        let tmp = path.with_extension("txt.tmp");
        if tokio::fs::write(&tmp, body.as_bytes()).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &path).await;
        }
        swap_engine_with_extra(&body);
    });
}

/// Returns true for local app origins, proxy URLs, and internal browser schemes that must
/// never be blocked or cosmetically modified.
pub fn is_exempt_url(uri: &str) -> bool {
    let lower = uri.trim_start().to_ascii_lowercase();
    if lower.is_empty()
        || lower.starts_with("about:")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("tauri:")
        || lower.starts_with("asset:")
        || lower.starts_with("abxs:")
        || lower.starts_with("javascript:")
    {
        return true;
    }
    host_of(uri).is_some_and(|h| {
        let h = h.trim_end_matches('.').to_ascii_lowercase();
        h == "localhost" || h.ends_with(".localhost") || h == "127.0.0.1" || h == "[::1]" || h == "::1"
    })
}

pub(crate) fn check_network_request_with_engine(
    eng: &Engine,
    uri: &str,
    source_url: &str,
    request_type: &str,
    method: &str,
) -> bool {
    if is_exempt_url(uri) {
        return false;
    }
    match AdblockRequest::new(uri, source_url, request_type, method) {
        Ok(req) => eng.check_network_request(&req).should_block(),
        Err(_) => {
            let lower = uri.to_ascii_lowercase();
            BLOCKED_URL_PARTS.iter().any(|p| lower.contains(p))
        }
    }
}

pub fn check_network_request(uri: &str, source_url: &str, request_type: &str) -> bool {
    check_network_request_with_engine(&engine(), uri, source_url, request_type, "get")
}

pub fn is_blocked_url(uri: &str) -> bool {
    check_network_request(uri, "", "other")
}

pub fn is_blocked_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    BLOCKED_HOSTS.iter().any(|b| host == *b || host.ends_with(&format!(".{b}")))
}

fn host_of(uri: &str) -> Option<String> {
    url::Url::parse(uri).ok().and_then(|u| u.host_str().map(|h| h.to_string()))
}

/// Build JS injecting scriptlets (`nowoif`, `set-constant`) for a non-exempt http(s) frame.
pub(crate) fn build_scriptlet_injection_js(url: &str) -> Option<String> {
    if is_exempt_url(url) || (!url.starts_with("http://") && !url.starts_with("https://")) {
        return None;
    }
    let res = engine().url_cosmetic_resources(url);
    let script = res.injected_script.trim();
    if script.is_empty() {
        return None;
    }
    Some(format!("(() => {{\n  try {{\n{script}\n  }} catch {{}}\n}})();"))
}

const COMMON_AD_CLASSES: &[&str] = &[
    "adsbytrafficjunky",
    "adsbox",
    "ad-overlay",
    "ads-overlay",
    "pop-overlay",
    "popunder-overlay",
    "exo-ipp",
    "mgbox",
];

/// Build JS injecting cosmetic element-hiding CSS + scriptlets for a non-exempt http(s) frame.
pub(crate) fn build_cosmetic_injection_js(url: &str) -> Option<String> {
    if is_exempt_url(url) || (!url.starts_with("http://") && !url.starts_with("https://")) {
        return None;
    }
    let eng = engine();
    let res = eng.url_cosmetic_resources(url);
    let mut selectors: Vec<String> = res
        .hide_selectors
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if !res.generichide {
        selectors.extend(
            eng.hidden_class_id_selectors(COMMON_AD_CLASSES, std::iter::empty::<&str>(), &res.exceptions)
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        );
    }
    selectors.sort_unstable();
    selectors.dedup();

    let style_js = if selectors.is_empty() {
        String::new()
    } else {
        let css = format!("{} {{ display: none !important; }}", selectors.join(", "));
        let Ok(css_json) = serde_json::to_string(&css) else {
            return None;
        };
        format!(
            "if (!document.querySelector('style[data-abx-shield]')) {{ \
               const st = document.createElement('style'); \
               st.setAttribute('data-abx-shield', '1'); \
               st.textContent = {css_json}; \
               (document.head || document.documentElement).appendChild(st); \
             }}\n"
        )
    };
    let script = res.injected_script.trim();
    if style_js.is_empty() && script.is_empty() {
        return None;
    }
    Some(format!(
        "(() => {{\n  try {{\n{style_js}{script}\n  }} catch {{}}\n}})();"
    ))
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

pub fn is_thumbnail_subtitle_url(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or("");
    if lower.contains("/bif/")
        || path.contains("/thumbnails/")
        || path.contains("/storyboard/")
    {
        return true;
    }
    let file = path.rsplit('/').next().unwrap_or(path);
    let Some(stem) = file.strip_suffix(".vtt") else {
        return false;
    };
    stem.split(|c: char| !c.is_ascii_alphanumeric()).any(|tok| {
        let stripped = tok.trim_end_matches(|c: char| c.is_ascii_digit());
        matches!(
            stripped,
            "thumbnails" | "thumbnail" | "thumbs" | "sprite" | "sprites" | "storyboard"
        )
    })
}

pub fn is_sniffed_subtitle(uri: &str, ctype: &str) -> bool {
    if is_thumbnail_subtitle_url(uri) {
        return false;
    }
    let path = uri.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let ctype = ctype.to_ascii_lowercase();
    let has_sub_ext = [".vtt", ".srt", ".ass", ".ssa"]
        .iter()
        .any(|ext| path.ends_with(ext));
    let has_sub_mime = ctype.contains("text/vtt")
        || ctype.contains("text/x-ssa")
        || ctype.contains("text/x-ass")
        || ctype.contains("application/x-subrip");
    has_sub_ext || has_sub_mime
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::Mutex;
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, *};
    use windows::core::{Interface, BOOL, HSTRING, PWSTR};

    unsafe fn uri_of_request(req: &ICoreWebView2WebResourceRequest) -> String {
        let mut uri = PWSTR::null();
        let _ = req.Uri(&mut uri);
        take_pwstr(uri)
    }

    unsafe fn method_of_request(req: &ICoreWebView2WebResourceRequest) -> String {
        let mut m = PWSTR::null();
        if req.Method(&mut m).is_ok() {
            let s = take_pwstr(m);
            if !s.is_empty() {
                return s;
            }
        }
        "get".to_string()
    }

    unsafe fn source_of_webview(core: &ICoreWebView2) -> Option<String> {
        let mut src = PWSTR::null();
        core.Source(&mut src).ok()?;
        let s = take_pwstr(src);
        (!s.is_empty() && s != "about:blank").then_some(s)
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

    fn map_resource_context(ctx: COREWEBVIEW2_WEB_RESOURCE_CONTEXT) -> &'static str {
        match ctx {
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT => "document",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET => "stylesheet",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE => "image",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA => "media",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT => "font",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT => "script",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST
            | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH => "xmlhttprequest",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING => "ping",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET => "websocket",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT => "csp_report",
            _ => "other",
        }
    }

    unsafe fn exec_frame_js(frame: &ICoreWebView2Frame, js: &str) {
        if let Ok(f2) = frame.cast::<ICoreWebView2Frame2>() {
            let _ = f2.ExecuteScript(
                &HSTRING::from(js),
                &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
            );
        }
    }

    unsafe fn hook_frame_cosmetics(frame: &ICoreWebView2Frame) {
        let frame_url = Arc::new(Mutex::new(String::new()));
        let mut token = 0i64;
        if let Ok(f2) = frame.cast::<ICoreWebView2Frame2>() {
            let url_ref = Arc::clone(&frame_url);
            let _ = f2.add_NavigationStarting(
                &FrameNavigationStartingEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let mut uri = PWSTR::null();
                        if args.Uri(&mut uri).is_ok() {
                            let u = take_pwstr(uri);
                            if let Ok(mut g) = url_ref.lock() {
                                *g = u;
                            }
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );

            let url_ref = Arc::clone(&frame_url);
            let _ = f2.add_ContentLoading(
                &FrameContentLoadingEventHandler::create(Box::new(move |sender, _| {
                    let Some(frame) = sender else { return Ok(()) };
                    let u = url_ref.lock().map(|g| g.clone()).unwrap_or_default();
                    if let Some(js) = build_scriptlet_injection_js(&u) {
                        exec_frame_js(&frame, &js);
                    }
                    Ok(())
                })),
                &mut token,
            );

            let url_ref = Arc::clone(&frame_url);
            let _ = f2.add_DOMContentLoaded(
                &FrameDOMContentLoadedEventHandler::create(Box::new(move |sender, _| {
                    let Some(frame) = sender else { return Ok(()) };
                    let u = url_ref.lock().map(|g| g.clone()).unwrap_or_default();
                    if let Some(js) = build_cosmetic_injection_js(&u) {
                        exec_frame_js(&frame, &js);
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
        if let Ok(f7) = frame.cast::<ICoreWebView2Frame7>() {
            let _ = f7.add_FrameCreated(
                &FrameChildFrameCreatedEventHandler::create(Box::new(|_, args| {
                    if let Some(args) = args {
                        if let Ok(child) = args.Frame() {
                            hook_frame_cosmetics(&child);
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
        }
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

            // Single wildcard filter routes requests to the `adblock::Engine`, while
            // `is_exempt_url` fast-paths localhost/abxs/asset/tauri requests immediately.
            let core22 = core.cast::<ICoreWebView2_22>().ok();
            let all_pat = HSTRING::from("*");
            let filter_ok = core22.as_ref().is_some_and(|c| {
                c.AddWebResourceRequestedFilterWithRequestSourceKinds(
                    &all_pat,
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                )
                .is_ok()
            });
            if !filter_ok {
                let _ = core.AddWebResourceRequestedFilter(&all_pat, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
            }

            let mut token = Default::default();
            let env2 = env.clone();
            let _ = core.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |sender, args| {
                    let Some(args) = args else { return Ok(()) };
                    let req = args.Request()?;
                    let uri = uri_of_request(&req);
                    // Other handlers (Tauri's own protocols) see these events too: only act on ours.
                    if is_exempt_url(&uri) {
                        return Ok(());
                    }
                    let mut ctx = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                    let _ = args.ResourceContext(&mut ctx);
                    let req_type = map_resource_context(ctx);
                    let source_url = req_header(&req, "Referer")
                        .or_else(|| req_header(&req, "Origin"))
                        .or_else(|| sender.as_ref().and_then(|wv| source_of_webview(wv)))
                        .unwrap_or_default();
                    let method = method_of_request(&req);
                    if check_network_request_with_engine(&engine(), &uri, &source_url, req_type, &method) {
                        BLOCKED.fetch_add(1, Ordering::Relaxed);
                        let resp = env2.CreateWebResourceResponse(None, 403, &HSTRING::from("Blocked"), &HSTRING::new())?;
                        args.SetResponse(&resp)?;
                    }
                    Ok(())
                })),
                &mut token,
            );

            // Cosmetic & scriptlet injection on embed / sniff frames (never on local app origins).
            let _ = core.add_ContentLoading(
                &ContentLoadingEventHandler::create(Box::new(|sender, _| {
                    if let Some(wv) = sender {
                        if let Some(url) = source_of_webview(&wv) {
                            if let Some(js) = build_scriptlet_injection_js(&url) {
                                let _ = wv.ExecuteScript(
                                    &HSTRING::from(js),
                                    &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                                );
                            }
                        }
                    }
                    Ok(())
                })),
                &mut token,
            );
            if let Ok(c2) = core.cast::<ICoreWebView2_2>() {
                let _ = c2.add_DOMContentLoaded(
                    &DOMContentLoadedEventHandler::create(Box::new(|sender, _| {
                        if let Some(wv) = sender {
                            if let Some(url) = source_of_webview(&wv) {
                                if let Some(js) = build_cosmetic_injection_js(&url) {
                                    let _ = wv.ExecuteScript(
                                        &HSTRING::from(js),
                                        &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                                    );
                                }
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            }
            if let Ok(c4) = core.cast::<ICoreWebView2_4>() {
                let _ = c4.add_FrameCreated(
                    &FrameCreatedEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            if let Ok(frame) = args.Frame() {
                                hook_frame_cosmetics(&frame);
                            }
                        }
                        Ok(())
                    })),
                    &mut token,
                );
            }

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
                    if host_of(&uri).is_none_or(|h| is_blocked_host(&h)) || is_blocked_url(&uri) {
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
                    } else if is_sniffed_subtitle(&uri, &ctype) {
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

async fn acquire_permit_or_cancel<'a>(
    semaphore: &'a tokio::sync::Semaphore,
    mut cancel_rx: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> Result<Option<tokio::sync::SemaphorePermit<'a>>, String> {
    if let Some(rx) = cancel_rx.as_deref() {
        if *rx.borrow() {
            return Ok(None);
        }
    }
    match cancel_rx.as_deref_mut() {
        Some(rx) => {
            tokio::select! {
                p = semaphore.acquire() => Ok(Some(p.map_err(|e| e.to_string())?)),
                _ = rx.changed() => Ok(None),
            }
        }
        None => Ok(Some(semaphore.acquire().await.map_err(|e| e.to_string())?)),
    }
}

fn cleanup_cancel_entry(cancel_id: Option<&str>) {
    if let Some(cid) = cancel_id {
        if let Ok(mut m) = cancel_map().lock() {
            m.remove(cid);
        }
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
    let target: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    maybe_refresh_filter_cache(&app);
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

    // Acquire the concurrency permit before starting the outer timeout budget so queued sniffs
    // waiting behind active WebView2 slots do not burn their page-load timeout while waiting.
    let permit = match acquire_permit_or_cancel(sem(), cancel_rx.as_mut()).await {
        Ok(Some(p)) => p,
        Ok(None) => {
            cleanup_cancel_entry(cancel_id.as_deref());
            return Ok(None);
        }
        Err(e) => {
            cleanup_cancel_entry(cancel_id.as_deref());
            return Err(e);
        }
    };

    let budget = std::time::Duration::from_millis(timeout_ms.unwrap_or(14_000) + 6_000);
    let fut = tokio::time::timeout(budget, sniff_inner(app.clone(), target, timeout_ms, label.clone()));

    let res = match cancel_rx.as_mut() {
        Some(rx) => {
            if *rx.borrow() {
                None
            } else {
                tokio::select! {
                    r = fut => r.ok(),
                    _ = rx.changed() => None,
                }
            }
        }
        None => fut.await.ok(),
    };

    cleanup_cancel_entry(cancel_id.as_deref());

    // Hard ceiling or cancellation: whatever a page does, its window is destroyed on exit
    // before the semaphore permit is released to the next waiting sniff.
    let out = match res {
        Some(r) => {
            if r.is_err() {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.destroy();
                }
            }
            r
        }
        None => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
            Ok(None)
        }
    };
    drop(permit);
    out
}

async fn sniff_inner(app: AppHandle, target: url::Url, timeout_ms: Option<u64>, label: String) -> Result<Option<Sniffed>, String> {
    let t0 = std::time::Instant::now();
    let _ = t0; // only read by the debug timing log
    let dbg = |what: &str| {
        #[cfg(debug_assertions)]
        if std::env::var_os("ABX_SNIFF_DEBUG").is_some() {
            println!("  T+{}ms {what}", t0.elapsed().as_millis());
        }
        let _ = what;
    };
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
    Ok(select_verified_candidate(candidates, subs, |u, h| async move {
        crate::stream::verify_playlist(&u, &h).await
    })
    .await)
}

fn url_path_and_query_lower(uri: &str) -> (Vec<String>, String) {
    if let Ok(parsed) = url::Url::parse(uri) {
        let host_labels = parsed
            .host_str()
            .unwrap_or("")
            .split('.')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_ascii_lowercase())
            .collect();
        let mut pq = parsed.path().to_ascii_lowercase();
        if let Some(q) = parsed.query() {
            pq.push('?');
            pq.push_str(&q.to_ascii_lowercase());
        }
        (host_labels, pq)
    } else {
        let no_frag = uri.split('#').next().unwrap_or(uri);
        (Vec::new(), no_frag.to_ascii_lowercase())
    }
}

pub(crate) fn is_preview_or_ad_url(uri: &str) -> bool {
    let (host_labels, pq) = url_path_and_query_lower(uri);
    if host_labels.iter().any(|lbl| {
        matches!(
            lbl.as_str(),
            "ad" | "ads" | "adserver" | "adserv" | "preroll" | "promo" | "preview" | "teaser" | "trailer" | "vast" | "vpaid"
        )
    }) {
        return true;
    }
    if [
        "preview",
        "teaser",
        "trailer",
        "preroll",
        "pre-roll",
        "pre_roll",
        "midroll",
        "mid-roll",
        "mid_roll",
        "postroll",
        "post-roll",
        "post_roll",
        "adbreak",
        "ad-break",
        "ad_break",
        "advert",
        "commercial",
    ]
    .iter()
    .any(|kw| pq.contains(kw))
    {
        return true;
    }
    pq.split(|c: char| !c.is_ascii_alphanumeric()).any(|tok| {
        if tok.is_empty() {
            return false;
        }
        let base = tok.trim_end_matches(|c: char| c.is_ascii_digit());
        matches!(
            base,
            "ad" | "ads" | "promo" | "promos" | "bumper" | "bumpers" | "vast" | "vpaid"
        )
    })
}

pub(crate) fn hls_url_priority(uri: &str) -> u8 {
    let (_host_labels, pq) = url_path_and_query_lower(uri);
    if pq.contains("master") {
        0
    } else if pq.contains("playlist") {
        1
    } else if pq.contains("index") {
        2
    } else {
        3
    }
}

pub(crate) fn sort_candidates(candidates: &mut [Sniffed]) {
    // Deprioritize obvious preview/teaser/trailer/ad URLs when other candidates exist,
    // prefer likely master/primary HLS playlists, and prefer HLS/DASH over progressive MP4.
    candidates.sort_by_key(|m| {
        let deprio = u8::from(is_preview_or_ad_url(&m.url));
        let (kind_rank, hls_rank) = match m.kind {
            "hls" => (0u8, hls_url_priority(&m.url)),
            "dash" => (1u8, 0u8),
            _ => (2u8, 0u8),
        };
        (deprio, kind_rank, hls_rank)
    });
}

async fn select_verified_candidate<F, Fut>(
    mut candidates: Vec<Sniffed>,
    subs: Vec<String>,
    verify: F,
) -> Option<Sniffed>
where
    F: Fn(String, Hdrs) -> Fut,
    Fut: std::future::Future<Output = Option<u32>>,
{
    if candidates.is_empty() {
        return None;
    }
    sort_candidates(&mut candidates);
    let mut best_hls: Option<(bool, Sniffed)> = None;
    let mut fallback: Option<Sniffed> = None;
    for mut f in candidates {
        let deprio = is_preview_or_ad_url(&f.url);
        if matches!(best_hls, Some((false, _))) && deprio {
            break;
        }
        f.subtitles = subs.clone();
        if f.kind == "hls" {
            match verify(f.url.clone(), f.headers.clone()).await {
                Some(q) if q > 0 => {
                    f.verified = Some(true);
                    f.quality = Some(q);
                    return Some(f);
                }
                Some(_) => {
                    f.verified = Some(true);
                    f.quality = None;
                    if best_hls.is_none() {
                        best_hls = Some((deprio, f));
                    }
                }
                None => {
                    f.verified = Some(false);
                    if fallback.is_none() {
                        fallback = Some(f);
                    }
                }
            }
        } else {
            if let Some((_, best)) = best_hls {
                return Some(best);
            }
            return Some(f);
        }
    }
    best_hls.map(|(_, best)| best).or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

    fn make_sniffed(url: &str, kind: &'static str) -> Sniffed {
        Sniffed {
            url: url.to_string(),
            kind,
            headers: Hdrs::default(),
            subtitles: vec![],
            verified: None,
            quality: None,
        }
    }

    #[test]
    fn captures_supported_subtitle_extensions_and_mimes() {
        assert!(is_sniffed_subtitle("https://cdn.example.com/subs/en.vtt?t=1", ""));
        assert!(is_sniffed_subtitle("https://cdn.example.com/subs/en.srt", ""));
        assert!(is_sniffed_subtitle("https://cdn.example.com/subs/jp.ASS?sig=abc", ""));
        assert!(is_sniffed_subtitle("https://cdn.example.com/subs/dialogue.ssa", ""));
        assert!(is_sniffed_subtitle("https://cdn.example.com/track?id=1", "text/vtt; charset=utf-8"));
        assert!(is_sniffed_subtitle("https://cdn.example.com/track?id=2", "text/x-ssa"));
        assert!(is_sniffed_subtitle("https://cdn.example.com/track?id=3", "application/x-subrip"));
        assert!(!is_sniffed_subtitle("https://cdn.example.com/video.mp4", "video/mp4"));
    }

    #[test]
    fn ignores_thumbnail_sprite_and_bif_vtt_urls() {
        assert!(!is_sniffed_subtitle("https://cdn.example.com/v/123/thumbnails.vtt", "text/vtt"));
        assert!(!is_sniffed_subtitle("https://cdn.example.com/v/123/thumbs.vtt?exp=999", "text/vtt"));
        assert!(!is_sniffed_subtitle("https://cdn.example.com/v/123/sprite.vtt", ""));
        assert!(!is_sniffed_subtitle("https://cdn.example.com/v/123/storyboard.vtt", "text/vtt"));
        assert!(!is_sniffed_subtitle("https://cdn.example.com/bif/preview.vtt", "text/vtt"));
        assert!(!is_sniffed_subtitle("https://cdn.example.com/bif/track?id=1", "text/vtt"));
        // Real subtitles must still be captured
        assert!(is_sniffed_subtitle("https://cdn.example.com/subs/English.vtt", "text/vtt"));
    }

    #[test]
    fn ranks_master_primary_hls_ahead_of_variants_and_deprioritizes_previews_and_ads() {
        assert!(is_preview_or_ad_url("https://cdn.example.com/ads/preroll.m3u8"));
        assert!(is_preview_or_ad_url("https://cdn.example.com/video/preview_720.mp4"));
        assert!(is_preview_or_ad_url("https://cdn.example.com/teaser/master.m3u8"));
        assert!(is_preview_or_ad_url("https://cdn.example.com/movie-trailer.m3u8"));
        // Words like "download", "adaptive", "shadow", "media" must NOT false-positive on "ad"
        assert!(!is_preview_or_ad_url("https://cdn.example.com/download/adaptive/shadow_media/master.m3u8"));

        let mut cands = vec![
            make_sniffed("https://cdn.example.com/trailer/master.m3u8", "hls"),
            make_sniffed("https://cdn.example.com/movie.mp4", "mp4"),
            make_sniffed("https://cdn.example.com/ads/ad1/playlist.m3u8", "hls"),
            make_sniffed("https://cdn.example.com/v/720p/chunklist.m3u8", "hls"),
            make_sniffed("https://cdn.example.com/v/index.m3u8", "hls"),
            make_sniffed("https://cdn.example.com/v/playlist.m3u8", "hls"),
            make_sniffed("https://cdn.example.com/v/master.m3u8", "hls"),
            make_sniffed("https://cdn.example.com/v/manifest.mpd", "dash"),
        ];
        sort_candidates(&mut cands);
        let urls: Vec<&str> = cands.iter().map(|c| c.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://cdn.example.com/v/master.m3u8",
                "https://cdn.example.com/v/playlist.m3u8",
                "https://cdn.example.com/v/index.m3u8",
                "https://cdn.example.com/v/720p/chunklist.m3u8",
                "https://cdn.example.com/v/manifest.mpd",
                "https://cdn.example.com/movie.mp4",
                "https://cdn.example.com/trailer/master.m3u8",
                "https://cdn.example.com/ads/ad1/playlist.m3u8",
            ]
        );
    }

    #[test]
    fn prefers_multivariant_master_over_single_bitrate_without_extra_delay() {
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let calls_ref = calls.clone();
        let chosen = tauri::async_runtime::block_on(select_verified_candidate(
            vec![
                make_sniffed("https://cdn.example.com/v/720p/playlist.m3u8", "hls"),
                make_sniffed("https://cdn.example.com/v/alt_stream.m3u8", "hls"),
                make_sniffed("https://cdn.example.com/v/backup.m3u8", "hls"),
            ],
            vec!["https://cdn.example.com/subs/en.vtt".into()],
            move |u, _h| {
                let calls_ref = calls_ref.clone();
                async move {
                    calls_ref.lock().unwrap().push(u.clone());
                    if u.contains("720p") {
                        Some(0)
                    } else if u.contains("alt_stream") {
                        Some(1080)
                    } else {
                        Some(720)
                    }
                }
            },
        ))
        .unwrap();

        assert_eq!(chosen.url, "https://cdn.example.com/v/alt_stream.m3u8");
        assert_eq!(chosen.verified, Some(true));
        assert_eq!(chosen.quality, Some(1080));
        assert_eq!(chosen.subtitles, vec!["https://cdn.example.com/subs/en.vtt"]);
        // Continued past single-bitrate Some(0), then stopped immediately once q > 0 validated cleanly.
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                "https://cdn.example.com/v/720p/playlist.m3u8",
                "https://cdn.example.com/v/alt_stream.m3u8",
            ]
        );

        // When the first HLS validates with q > 0, no further HLS requests are made at all.
        let count = Arc::new(AtomicUsize::new(0));
        let count_ref = count.clone();
        let immediate = tauri::async_runtime::block_on(select_verified_candidate(
            vec![
                make_sniffed("https://cdn.example.com/v/master.m3u8", "hls"),
                make_sniffed("https://cdn.example.com/v/second_master.m3u8", "hls"),
            ],
            vec![],
            move |_u, _h| {
                let count_ref = count_ref.clone();
                async move {
                    count_ref.fetch_add(1, Ordering::Relaxed);
                    Some(720)
                }
            },
        ))
        .unwrap();
        assert_eq!(immediate.url, "https://cdn.example.com/v/master.m3u8");
        assert_eq!(immediate.quality, Some(720));
        assert_eq!(count.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn falls_back_cleanly_for_single_bitrate_unverified_and_non_hls_candidates() {
        // Single-bitrate verified HLS (Some(0)) still beats trailing MP4 and deprioritized preview masters.
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let calls_ref = calls.clone();
        let single_hls = tauri::async_runtime::block_on(select_verified_candidate(
            vec![
                make_sniffed("https://cdn.example.com/preview/master.m3u8", "hls"),
                make_sniffed("https://cdn.example.com/v/chunklist.m3u8", "hls"),
                make_sniffed("https://cdn.example.com/v/video.mp4", "mp4"),
            ],
            vec![],
            move |u, _h| {
                let calls_ref = calls_ref.clone();
                async move {
                    calls_ref.lock().unwrap().push(u.clone());
                    if u.contains("preview") { Some(1080) } else { Some(0) }
                }
            },
        ))
        .unwrap();
        assert_eq!(single_hls.url, "https://cdn.example.com/v/chunklist.m3u8");
        assert_eq!(single_hls.verified, Some(true));
        assert_eq!(single_hls.quality, None);
        assert_eq!(*calls.lock().unwrap(), vec!["https://cdn.example.com/v/chunklist.m3u8"]);

        // Failed HLS verification falls back to MP4 when present, or unverified HLS when alone.
        let mp4_fallback = tauri::async_runtime::block_on(select_verified_candidate(
            vec![
                make_sniffed("https://cdn.example.com/v/bad.m3u8", "hls"),
                make_sniffed("https://cdn.example.com/v/film.mp4", "mp4"),
            ],
            vec![],
            |_u, _h| async { None },
        ))
        .unwrap();
        assert_eq!(mp4_fallback.url, "https://cdn.example.com/v/film.mp4");
        assert_eq!(mp4_fallback.verified, None);

        let hls_fallback = tauri::async_runtime::block_on(select_verified_candidate(
            vec![make_sniffed("https://cdn.example.com/v/bad.m3u8", "hls")],
            vec![],
            |_u, _h| async { None },
        ))
        .unwrap();
        assert_eq!(hls_fallback.url, "https://cdn.example.com/v/bad.m3u8");
        assert_eq!(hls_fallback.verified, Some(false));
    }

    #[test]
    fn queued_permit_acquisition_honors_cancellation_without_blocking() {
        tauri::async_runtime::block_on(async {
            let local_sem = tokio::sync::Semaphore::new(1);
            let _held = local_sem.acquire().await.unwrap();
            let (tx, mut rx) = tokio::sync::watch::channel(false);
            let cancel_task = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                let _ = tx.send(true);
            });
            let permit = acquire_permit_or_cancel(&local_sem, Some(&mut rx)).await.unwrap();
            assert!(permit.is_none());
            let _ = cancel_task.await;
        });
    }

    #[test]
    fn adblock_engine_blocks_ads_popunders_miners_and_anti_devtools() {
        let embed = "https://vidsrc.example.com/embed/movie/123";

        // Known ad networks & subdomains
        assert!(check_network_request("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js", embed, "script"));
        assert!(check_network_request("https://sub.popads.net/pop.js", embed, "script"));
        assert!(check_network_request("https://a.exosrv.com/ad-provider.js", embed, "script"));
        assert!(check_network_request("https://cdn.adsterra.com/banner.js", embed, "script"));
        assert!(check_network_request("https://ukankingwithea.com/jump/next", embed, "document"));
        assert!(check_network_request("https://a.magsrv.com/native.js", embed, "script"));

        // Crypto miners
        assert!(check_network_request("https://coinhive.com/lib/coinhive.min.js", embed, "script"));
        assert!(check_network_request("https://authedmine.com/lib/authedmine.min.js", embed, "script"));

        // Anti-devtools / anti-adblock kits anywhere
        assert!(check_network_request("https://cdn.example.org/assets/disable-devtool.min.js", embed, "script"));
        assert!(is_blocked_url("https://cdn.example.org/assets/fuckadblock.js"));

        // Third-party popunder & VAST/VPAID tag patterns
        assert!(check_network_request("https://tracker.other.org/js/popunder.min.js", embed, "script"));
        assert!(check_network_request("https://ads.other.org/tags/vast.xml", embed, "xmlhttprequest"));
    }

    #[test]
    fn adblock_engine_allows_video_streams_segments_subtitles_and_local_origins() {
        let embed = "https://vidsrc.example.com/embed/movie/123";

        // Video streams & segments must never be blocked
        assert!(!check_network_request("https://cdn.example.com/hls/master.m3u8", embed, "xmlhttprequest"));
        assert!(!check_network_request("https://cdn.example.com/hls/720p/seg-001.ts", embed, "xmlhttprequest"));
        assert!(!check_network_request("https://cdn.example.com/dash/manifest.mpd", embed, "xmlhttprequest"));
        assert!(!check_network_request("https://cdn.example.com/video/movie_1080p.mp4", embed, "media"));
        assert!(!check_network_request("https://cdn.example.com/download/adaptive/shadow_media/master.m3u8", embed, "xmlhttprequest"));
        assert!(!check_network_request("https://cdn.example.com/subs/English.vtt", embed, "other"));

        // Localhost, proxy & Tauri origins must always be exempt
        assert!(!check_network_request("http://abxs.localhost/p?u=https%3A%2F%2Fcdn.example.com%2Fmaster.m3u8", "http://localhost:1420/", "xmlhttprequest"));
        assert!(!check_network_request("http://localhost:1420/assets/index.js", "http://localhost:1420/", "script"));
        assert!(!check_network_request("http://tauri.localhost/index.html", "", "document"));
        assert!(!check_network_request("http://asset.localhost/poster.jpg", "http://tauri.localhost/", "image"));
        assert!(!is_blocked_url("http://abxs.localhost/p?url=https%3A%2F%2Fdoubleclick.net%2Ftest"));
        assert!(!is_blocked_url("about:blank"));
    }

    #[test]
    fn cosmetic_and_scriptlet_injection_skips_local_origins_and_sanitizes_embeds() {
        assert!(build_cosmetic_injection_js("http://localhost:1420/").is_none());
        assert!(build_cosmetic_injection_js("http://tauri.localhost/index.html").is_none());
        assert!(build_cosmetic_injection_js("http://abxs.localhost/p?u=1").is_none());
        assert!(build_scriptlet_injection_js("http://localhost:1420/").is_none());
        assert!(build_cosmetic_injection_js("about:blank").is_none());

        let js = build_cosmetic_injection_js("https://vidsrc.to/embed/123")
            .expect("embed page should receive cosmetic & scriptlet injection");
        assert!(js.contains("data-abx-shield"));
        assert!(js.contains("display: none !important"));
        assert!(js.contains(".ad-overlay"));
        assert!(js.contains("abxNoWoiF"));
        assert!(js.contains("abxSetConstant"));
        // Must never hide video or common player containers
        assert!(!js.contains(".plyr"));
        assert!(!js.contains(".vjs-"));

        let early_js = build_scriptlet_injection_js("https://vidsrc.to/embed/123")
            .expect("embed page should receive early scriptlet injection");
        assert!(early_js.contains("abxNoWoiF"));
        assert!(early_js.contains("abxSetConstant"));

        // Generic cosmetic hide rules also apply to unlisted embed origins
        let generic_js = build_cosmetic_injection_js("https://player.example.org/e/1")
            .expect("generic embed should receive cosmetic CSS hide rules");
        assert!(generic_js.contains("data-abx-shield"));
        assert!(generic_js.contains(".ad-overlay"));
    }

    #[test]
    fn custom_supplementary_rules_can_extend_engine() {
        let custom = build_engine(Some("||evil-custom-rotator.example^\n"));
        assert!(check_network_request_with_engine(
            &custom,
            "https://sub.evil-custom-rotator.example/pop.js",
            "https://vidsrc.example.com/embed/1",
            "script",
            "get",
        ));
        assert!(!check_network_request_with_engine(
            &custom,
            "http://abxs.localhost/p?u=https%3A%2F%2Fevil-custom-rotator.example%2F",
            "http://localhost:1420/",
            "xmlhttprequest",
            "get",
        ));
    }
}
