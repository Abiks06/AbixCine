//! Network shield and stream sniffer (WebView2).
//!
//! Shield: powered by `brave/adblock-rust` (`adblock::Engine`). Ad, pop-under, abusive script,
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
    "monetag.com", "galaksion.com", "trafficstars.com", "tsyndicate.com", "trafficjunky.net",
    "adspyglass.com", "pushame.com", "notix.io", "pushwhy.com", "richpush.co", "pushaffiliate.net",
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

/// Scripts blocked wherever they're hosted: anti-devtools / anti-adblock kits that blank the
/// player when they think they're being inspected.
pub const BLOCKED_URL_PARTS: &[&str] = &["disable-devtool", "devtools-detect", "devtools-detector", "adblock-detect", "fuckadblock", "blockadblock"];

/// Curated EasyList / uBlock ruleset layered over `BLOCKED_HOSTS` and `BLOCKED_URL_PARTS`:
/// covers local exemptions, additional ad/tracker/redirector domains, abusive scripts,
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
  // A blocked popup returns a harmless fake window, not null: players that check
  // `window.open(...) === null` to detect a popup blocker refuse to start otherwise
  // (the same stub build_player_hook_script installs; this scriptlet must not undo it).
  const fakeWin = function() {
    const w = {
      closed: false,
      opener: window,
      name: '',
      focus() {},
      blur() {},
      postMessage() {},
      location: { href: 'about:blank', replace() {}, assign() {} },
      document: { open() { return this; }, write() {}, writeln() {}, close() {} },
    };
    w.close = function() { w.closed = true; };
    return w;
  };
  window.open = function(url) {
    try {
      if (!url || typeof url !== 'string') return fakeWin();
      const s = url.trim().toLowerCase();
      if (s === '' || s === 'about:blank' || s.startsWith('http://') || s.startsWith('https://')) {
        return fakeWin();
      }
    } catch {}
    return origOpen ? origOpen.apply(this, arguments) : fakeWin();
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
        && crate::debug_env_var("ABX_SNIFF_TEST").is_none();

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

/// Sorted 64-bit FNV-1a hashes of blocked abusive script/ad hosts so they are never embedded as
/// plaintext signature strings in the compiled binary.
const BLOCKED_HOST_HASHES: &[u64] = &[
    0x08fdb36af54b9615,
    0x1d979074421138fe,
    0x2d2d45e8a666f63f,
    0x365f2e295c75dce2,
    0x367b7412dabbbe05,
    0x3f4d0421ab195e8a,
    0x5c100663dcec9263,
    0x66186081d69d908b,
    0x811c794769ac3fa5,
    0x9aff8c3146f929b3,
    0xaac54b47046a08a6,
    0xb2099b8c54a9812f,
    0xbf226939af600ae1,
    0xc49534a5d5051477,
    0xcf1815febead3c59,
    0xd559bef801898a1a,
];

fn fnv1a_ascii_lower(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b.to_ascii_lowercase());
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn host_matches_blocked_hash(host: &str) -> bool {
    let mut cur = host.trim_end_matches('.');
    while !cur.is_empty() {
        if BLOCKED_HOST_HASHES.binary_search(&fnv1a_ascii_lower(cur)).is_ok() {
            return true;
        }
        let Some((_, rest)) = cur.split_once('.') else {
            break;
        };
        cur = rest;
    }
    false
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
    if host_of(uri).is_some_and(|h| host_matches_blocked_hash(&h)) {
        return true;
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
    if host_matches_blocked_hash(host) {
        return true;
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    BLOCKED_HOSTS.iter().any(|b| host == *b || host.ends_with(&format!(".{b}")))
}

/// Where the main window may navigate: the app itself and blank documents, nothing else.
/// The old test passed every URI without a host (`javascript:`, `data:`, `file:`, custom OS
/// handlers) and any `*.localhost`, which included the stream proxy's own origin.
pub(crate) fn is_app_navigation(uri: &str) -> bool {
    let Ok(u) = url::Url::parse(uri) else { return false };
    match u.scheme() {
        "tauri" => true,
        "about" => matches!(u.as_str(), "about:blank" | "about:srcdoc"),
        "http" | "https" => match u.host_str() {
            Some("tauri.localhost") => true,
            Some("localhost") | Some("127.0.0.1") => cfg!(debug_assertions),
            _ => false,
        },
        _ => false,
    }
}

/// Where a hidden sniffer window, or any child frame, may navigate: the open web only. Never the
/// app's own WebView hosts (`tauri.`/`abxs.`/`asset.localhost`), loopback, `file:` or OS URI
/// schemes (`ms-settings:`, custom protocol handlers).
pub(crate) fn is_untrusted_navigation_allowed(uri: &str) -> bool {
    let Ok(u) = url::Url::parse(uri) else { return false };
    match u.scheme() {
        "about" => matches!(u.as_str(), "about:blank" | "about:srcdoc"),
        // In-frame content documents, not a way out of the sandbox.
        "data" | "blob" | "javascript" => true,
        "http" | "https" => match u.host() {
            Some(url::Host::Domain(d)) => {
                let d = d.trim_end_matches('.').to_ascii_lowercase();
                d != "localhost" && !d.ends_with(".localhost")
            }
            Some(url::Host::Ipv4(ip)) => !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local(),
            Some(url::Host::Ipv6(ip)) => !ip.is_loopback() && !ip.is_unspecified(),
            None => false,
        },
        _ => false,
    }
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

const DEFAULT_EMBED_REFERER: &str = "https://www.themoviedb.org/";

pub(crate) fn normalize_referer_url(referer: Option<&str>) -> String {
    let raw = referer.unwrap_or(DEFAULT_EMBED_REFERER).trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("about:blank") {
        return DEFAULT_EMBED_REFERER.to_string();
    }
    if let Ok(u) = url::Url::parse(raw) {
        if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() {
            return u.to_string();
        }
    }
    DEFAULT_EMBED_REFERER.to_string()
}

/// Document-start script injected into every frame of a sniff window so embeds running
/// top-level still observe iframe ancestry, an embedder referrer, and a working `window.open`
/// probe stub without modifying genuine nested sub-iframes.
pub(crate) fn build_player_hook_script(referer_hint: Option<&str>) -> String {
    let ref_url = normalize_referer_url(referer_hint);
    let ref_origin = url::Url::parse(&ref_url)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| match u.port() {
                Some(p) => format!("{}://{}:{}", u.scheme(), h, p),
                None => format!("{}://{}", u.scheme(), h),
            })
        })
        .unwrap_or_else(|| "https://www.themoviedb.org".to_string());
    let ref_json = serde_json::to_string(&ref_url).unwrap_or_else(|_| "\"https://www.themoviedb.org/\"".to_string());
    let orig_json = serde_json::to_string(&ref_origin).unwrap_or_else(|_| "\"https://www.themoviedb.org\"".to_string());
    format!(
        r#"(() => {{
  try {{
    const refUrl = {ref_json};
    const refOrigin = {orig_json};
    const safeWinOpen = () => {{
      const w = {{
        closed: false,
        opener: window,
        name: '',
        focus() {{}},
        blur() {{}},
        postMessage() {{}},
        location: {{ href: 'about:blank', replace() {{}}, assign() {{}} }},
        document: {{ open() {{ return this; }}, write() {{}}, writeln() {{}}, close() {{}} }},
      }};
      w.close = () => {{ w.closed = true; }};
      return w;
    }};
    try {{ window.open = safeWinOpen; }} catch {{}}
    if (window.self !== window.top) return;
    const fakeParent = {{
      closed: false,
      location: {{ href: refUrl, origin: refOrigin, ancestorOrigins: [] }},
      document: {{ referrer: '' }},
      postMessage() {{}},
    }};
    fakeParent.self = fakeParent;
    fakeParent.top = fakeParent;
    fakeParent.parent = fakeParent;
    const fakeFrame = {{
      tagName: 'IFRAME',
      nodeName: 'IFRAME',
      contentWindow: window,
      hasAttribute: () => false,
      getAttribute: (n) => n === 'src' ? location.href : (n === 'referrerpolicy' ? 'origin' : null),
    }};
    try {{ Object.defineProperty(window, 'top', {{ get: () => fakeParent, configurable: true }}); }} catch {{}}
    try {{ Object.defineProperty(window, 'parent', {{ get: () => fakeParent, configurable: true }}); }} catch {{}}
    try {{ Object.defineProperty(window, 'frameElement', {{ get: () => fakeFrame, configurable: true }}); }} catch {{}}
    try {{
      const refDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer');
      Object.defineProperty(Document.prototype, 'referrer', {{
        get: function () {{
          try {{
            const v = refDesc && refDesc.get ? refDesc.get.call(this) : '';
            return v || refUrl;
          }} catch {{
            return refUrl;
          }}
        }},
        configurable: true,
      }});
    }} catch {{}}
    try {{
      const locDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'ancestorOrigins');
      const fakeAnc = Object.assign([refOrigin], {{
        item: (i) => (i === 0 ? refOrigin : null),
        contains: (s) => s === refOrigin,
      }});
      Object.defineProperty(Location.prototype, 'ancestorOrigins', {{
        get: function () {{
          try {{
            const v = locDesc && locDesc.get ? locDesc.get.call(this) : null;
            return v && v.length > 0 ? v : fakeAnc;
          }} catch {{
            return fakeAnc;
          }}
        }},
        configurable: true,
      }});
    }} catch {{}}
  }} catch {{}}
}})();"#,
    )
}

/// Referer the main window's trailer iframe falls back to (its own origin in a release build).
pub(crate) const APP_EMBED_REFERER: &str = "http://tauri.localhost/";

/// A YouTube embed-player document (`youtube.com` / `youtube-nocookie.com` `/embed/...`).
pub(crate) fn is_youtube_embed_url(uri: &str) -> bool {
    let Ok(u) = url::Url::parse(uri) else { return false };
    if u.scheme() != "https" || !u.path().starts_with("/embed/") {
        return false;
    }
    matches!(
        u.host_str(),
        Some("www.youtube.com" | "youtube.com" | "www.youtube-nocookie.com" | "youtube-nocookie.com")
    )
}

pub(crate) fn is_opaque_header_value(val: Option<&str>) -> bool {
    val.map(str::trim).is_none_or(|v| {
        v.is_empty() || v.eq_ignore_ascii_case("null") || v.eq_ignore_ascii_case("about:blank")
    })
}

fn clean_header_value(val: Option<String>) -> Option<String> {
    val.and_then(|v| {
        let t = v.trim();
        if t.is_empty() || t.eq_ignore_ascii_case("null") || t.eq_ignore_ascii_case("about:blank") {
            None
        } else {
            Some(t.to_string())
        }
    })
}

pub(crate) fn merge_captured_headers(resp: Hdrs, req: Option<&Hdrs>) -> Hdrs {
    let pick = |primary: Option<String>, fallback: Option<&String>| -> Option<String> {
        clean_header_value(primary).or_else(|| fallback.and_then(|s| clean_header_value(Some(s.clone()))))
    };
    Hdrs {
        referer: pick(resp.referer, req.and_then(|r| r.referer.as_ref())),
        origin: pick(resp.origin, req.and_then(|r| r.origin.as_ref())),
        ua: pick(resp.ua, req.and_then(|r| r.ua.as_ref())),
    }
}

fn path_ext_lower(path_only: &str) -> &str {
    let last_seg = path_only.rsplit('/').next().unwrap_or(path_only);
    match last_seg.rsplit_once('.') {
        Some((_, ext)) => ext,
        None => "",
    }
}

fn is_non_manifest_asset_ext(ext: &str) -> bool {
    matches!(
        ext,
        "ts" | "m4s"
            | "mp4"
            | "m4v"
            | "m4a"
            | "aac"
            | "mp3"
            | "webm"
            | "mkv"
            | "avi"
            | "mov"
            | "vtt"
            | "srt"
            | "ass"
            | "ssa"
            | "js"
            | "mjs"
            | "css"
            | "json"
            | "html"
            | "htm"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "svg"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "map"
            | "wasm"
    )
}

pub(crate) fn classify_manifest_request_uri(uri: &str) -> Option<&'static str> {
    if is_exempt_url(uri)
        || host_of(uri).is_none_or(|h| is_blocked_host(&h))
        || is_blocked_url(uri)
        || is_preview_or_ad_url(uri)
        || is_thumbnail_subtitle_url(uri)
    {
        return None;
    }
    let path_only = uri.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let ext = path_ext_lower(&path_only);
    if is_non_manifest_asset_ext(ext) {
        return None;
    }
    if path_only.ends_with(".m3u8") || path_only.contains(".m3u8/") {
        return Some("hls");
    }
    if path_only.ends_with(".mpd") || path_only.contains(".mpd/") {
        return Some("dash");
    }
    let file = path_only.rsplit('/').next().unwrap_or("");
    if matches!(file, "master.txt" | "playlist.txt" | "index.txt")
        || (ext.is_empty() && (path_only.contains("/playlist/") || path_only.ends_with("/playlist")))
    {
        return Some("hls");
    }
    None
}

/// `init.mp4`, `seg-12-v1.mp4`, `frag_3.mp4`, `chunk-0001.mp4`, `part2.mp4`, `000123.mp4`: pieces of
/// an adaptive stream rather than a standalone file.
pub(crate) fn is_stream_fragment_name(file: &str) -> bool {
    let stem = file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file);
    if !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    ["init", "seg", "segment", "frag", "fragment", "chunk", "part"].iter().any(|p| {
        stem.strip_prefix(p)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(|c: char| c.is_ascii_digit() || c == '-' || c == '_' || c == '.'))
    })
}

pub(crate) fn classify_response_media(uri: &str, ctype: &str) -> Option<&'static str> {
    let ctype_lower = ctype.to_ascii_lowercase();
    if ctype_lower.contains("text/html")
        || ctype_lower.contains("xhtml")
        || ctype_lower.contains("javascript")
        || ctype_lower.contains("text/css")
        || ctype_lower.contains("application/json")
        || ctype_lower.starts_with("image/")
        || ctype_lower.starts_with("font/")
        || is_sniffed_subtitle(uri, ctype)
    {
        return None;
    }
    let path_only = uri.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if ctype_lower.contains("mpegurl") || ctype_lower.contains("x-mpegurl") {
        return Some("hls");
    }
    if ctype_lower.contains("dash+xml") {
        return Some("dash");
    }
    let is_progressive = ctype_lower.starts_with("video/mp4")
        || ctype_lower.starts_with("video/webm")
        || path_only.ends_with(".mp4")
        || path_only.ends_with(".webm");
    if is_progressive {
        // fMP4 init/fragment files of an HLS/DASH stream are not a film: counting them armed the
        // early exit before the manifest itself was captured.
        let file = path_only.rsplit('/').next().unwrap_or("");
        return if is_stream_fragment_name(file) { None } else { Some("mp4") };
    }
    if path_only.ends_with(".m3u8") || path_only.contains(".m3u8/") {
        return Some("hls");
    }
    if path_only.ends_with(".mpd") || path_only.contains(".mpd/") {
        return Some("dash");
    }
    let ext = path_ext_lower(&path_only);
    if !is_non_manifest_asset_ext(ext)
        && (ctype_lower.is_empty()
            || ctype_lower.starts_with("text/plain")
            || ctype_lower.contains("octet-stream"))
    {
        let file = path_only.rsplit('/').next().unwrap_or("");
        if matches!(file, "master.txt" | "playlist.txt" | "index.txt")
            || (ext.is_empty() && (path_only.contains("/playlist/") || path_only.ends_with("/playlist")))
            || ext == "txt" && (file.contains("master") || file.contains("playlist") || file.contains("index"))
        {
            return Some("hls");
        }
    }
    None
}

pub(crate) fn has_primary_media_candidate(candidates: &[Sniffed]) -> bool {
    candidates.iter().any(|c| !is_preview_or_ad_url(&c.url))
}

#[derive(Default)]
pub struct SniffCapture {
    pub(crate) headers_by_uri: std::collections::HashMap<String, Hdrs>,
    /// Insertion order of `headers_by_uri`, so a busy page evicts its oldest entries instead of
    /// wiping the map (which dropped the headers of a manifest whose response was about to arrive).
    header_order: std::collections::VecDeque<String>,
    pub(crate) pending_manifests: std::collections::HashMap<String, (&'static str, Hdrs)>,
}

const MAX_CAPTURED_HEADERS: usize = 512;

impl SniffCapture {
    #[allow(dead_code)]
    pub(crate) fn record_request(&mut self, uri: &str, hdrs: Hdrs, is_subrequest: bool, capture_hdrs: bool) {
        if capture_hdrs {
            if !self.headers_by_uri.contains_key(uri) {
                while self.headers_by_uri.len() >= MAX_CAPTURED_HEADERS {
                    match self.header_order.pop_front() {
                        Some(old) => {
                            self.headers_by_uri.remove(&old);
                        }
                        None => {
                            self.headers_by_uri.clear();
                            break;
                        }
                    }
                }
                self.header_order.push_back(uri.to_string());
            }
            self.headers_by_uri.insert(uri.to_string(), hdrs.clone());
        }
        if is_subrequest {
            if let Some(kind) = classify_manifest_request_uri(uri) {
                if self.pending_manifests.len() < 64 || self.pending_manifests.contains_key(uri) {
                    self.pending_manifests.insert(uri.to_string(), (kind, hdrs));
                }
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) fn headers_for(&self, uri: &str) -> Option<&Hdrs> {
        self.headers_by_uri.get(uri)
    }

    #[allow(dead_code)]
    pub(crate) fn clear_pending(&mut self, uri: &str) {
        self.pending_manifests.remove(uri);
    }

    pub(crate) fn take_pending(&mut self) -> Vec<(String, &'static str, Hdrs)> {
        self.pending_manifests
            .drain()
            .map(|(url, (kind, hdrs))| (url, kind, hdrs))
            .collect()
    }
}

pub struct SniffInstallOptions {
    pub tx: UnboundedSender<Found>,
    pub referer_hint: Option<String>,
    pub capture: Arc<std::sync::Mutex<SniffCapture>>,
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
                            // Child frames (in the app window and in sniffers) stay on the open web.
                            if !is_untrusted_navigation_allowed(&u) {
                                BLOCKED.fetch_add(1, Ordering::Relaxed);
                                let _ = args.SetCancel(true);
                                return Ok(());
                            }
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

    /// Navigate to `url` with an explicit initial `Referer` request header when WebView2
    /// supports `ICoreWebView2Environment9` + `ICoreWebView2_10`.
    pub fn navigate_with_referer(pw: &tauri::webview::PlatformWebview, url: &str, referer: &str) -> bool {
        let ref_val = normalize_referer_url(Some(referer));
        unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return false };
            let env = pw.environment();
            let Ok(env9) = env.cast::<ICoreWebView2Environment9>() else { return false };
            let Ok(core10) = core.cast::<ICoreWebView2_10>() else { return false };
            let headers = HSTRING::from(format!("Referer: {ref_val}\r\n"));
            let Ok(req) = env9.CreateWebResourceRequest(
                &HSTRING::from(url),
                &HSTRING::from("GET"),
                None,
                &headers,
            ) else {
                return false;
            };
            core10.NavigateWithWebResourceRequest(&req).is_ok()
        }
    }

    /// Install the shield (always) and the sniffer (when `sniff` is given) on one webview.
    pub fn install(pw: &tauri::webview::PlatformWebview, main: bool, sniff: Option<UnboundedSender<Found>>) {
        let opts = sniff.map(|tx| SniffInstallOptions {
            tx,
            referer_hint: None,
            capture: Arc::new(std::sync::Mutex::new(SniffCapture::default())),
        });
        install_with_options(pw, main, opts);
    }

    /// Install the shield (always) and the sniffer with optional referer hint and capture store.
    pub fn install_with_options(
        pw: &tauri::webview::PlatformWebview,
        main: bool,
        sniff: Option<SniffInstallOptions>,
    ) {
        unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let env = pw.environment();

            let referer_hint = sniff
                .as_ref()
                .and_then(|s| s.referer_hint.as_deref())
                .map(|r| normalize_referer_url(Some(r)));
            let req_capture = sniff.as_ref().map(|s| Arc::clone(&s.capture));

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
                    if ctx == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT {
                        if let Some(ref ref_val) = referer_hint {
                            let existing_ref = req_header(&req, "Referer");
                            if is_opaque_header_value(existing_ref.as_deref()) {
                                if let Ok(hdrs) = req.Headers() {
                                    let _ = hdrs.SetHeader(&HSTRING::from("Referer"), &HSTRING::from(ref_val.as_str()));
                                }
                            }
                        } else if main && is_youtube_embed_url(&uri) {
                            // YouTube's embed player refuses to start without a Referer ("Error
                            // 153"). The trailer iframe normally sends `http://tauri.localhost/`;
                            // if the WebView dropped it, supply the app origin ourselves.
                            let existing_ref = req_header(&req, "Referer");
                            if is_opaque_header_value(existing_ref.as_deref()) {
                                if let Ok(hdrs) = req.Headers() {
                                    let _ = hdrs.SetHeader(&HSTRING::from("Referer"), &HSTRING::from(APP_EMBED_REFERER));
                                }
                            }
                        }
                    }
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
                        return Ok(());
                    }
                    if let Some(ref cap) = req_capture {
                        if !method.eq_ignore_ascii_case("OPTIONS")
                            && !is_blocked_url(&uri)
                            && host_of(&uri).is_some_and(|h| !is_blocked_host(&h))
                        {
                            let is_subrequest = ctx != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT;
                            let capture_hdrs = !matches!(
                                ctx,
                                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET
                                    | COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT
                            );
                            let hdrs = Hdrs {
                                referer: clean_header_value(req_header(&req, "Referer")),
                                origin: clean_header_value(req_header(&req, "Origin")),
                                ua: clean_header_value(req_header(&req, "User-Agent")),
                            };
                            if let Ok(mut g) = cap.lock() {
                                g.record_request(&uri, hdrs, is_subrequest, capture_hdrs);
                            }
                        }
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
                            // Only the app's own page (tauri.localhost), not abxs./asset.localhost.
                            from_app = main && is_app_navigation(&src);
                        }
                    }
                    if from_app {
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = take_pwstr(uri);
                        // Never `explorer.exe <url>`: Explorer is not a URL launcher and opens a
                        // File Explorer window for many URLs (e.g. with a `?v=` query).
                        let _ = open_in_browser(&uri);
                    } else {
                        BLOCKED.fetch_add(1, Ordering::Relaxed);
                    }
                    args.SetHandled(true)?;
                    Ok(())
                })),
                &mut token,
            );

            // A frame must never be able to take over the app window, and a sniffer window (which
            // runs an untrusted embed) must never navigate into the app or off the open web.
            let _ = core.add_NavigationStarting(
                &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let mut uri = PWSTR::null();
                    args.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    let allowed = if main { is_app_navigation(&uri) } else { is_untrusted_navigation_allowed(&uri) };
                    if !allowed {
                        BLOCKED.fetch_add(1, Ordering::Relaxed);
                        args.SetCancel(true)?;
                    }
                    Ok(())
                })),
                &mut token,
            );

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

            let Some(SniffInstallOptions { tx, capture, .. }) = sniff else { return };
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
                    if method_of_request(&req).eq_ignore_ascii_case("OPTIONS") {
                        return Ok(());
                    }
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
                        if let Ok(mut g) = capture.lock() {
                            g.clear_pending(&uri);
                        }
                        return Ok(());
                    }
                    if !(200..300).contains(&status) {
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
                    #[cfg(debug_assertions)]
                    if std::env::var_os("ABX_SNIFF_DEBUG").is_some() {
                        let preview: String = uri.chars().take(160).collect();
                        println!("  RESP {status} [{ctype}] {preview}");
                    }
                    let kind = classify_response_media(&uri, &ctype);
                    let is_sub = kind.is_none() && is_sniffed_subtitle(&uri, &ctype);
                    let recorded_hdrs = capture
                        .lock()
                        .ok()
                        .and_then(|mut g| {
                            if kind.is_some() || is_sub {
                                g.clear_pending(&uri);
                            }
                            g.headers_for(&uri).cloned()
                        });
                    if let Some(kind) = kind {
                        let resp_hdrs = Hdrs {
                            referer: req_header(&req, "Referer"),
                            origin: req_header(&req, "Origin"),
                            ua: req_header(&req, "User-Agent"),
                        };
                        let headers = merge_captured_headers(resp_hdrs, recorded_hdrs.as_ref());
                        let _ = tx.send(Found::Media(Sniffed { url: uri, kind, headers, subtitles: vec![], verified: None, quality: None }));
                    } else if is_sub {
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
pub use win::{cdp, install, install_with_options, navigate_with_referer};

/// Only plain web links may leave the app: `http(s)` with a host, re-serialized by the URL parser
/// so nothing odd (spaces, quotes, `file:`, custom OS handlers) reaches the shell.
pub(crate) fn external_web_url(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none_or(|h| h.is_empty()) {
        return None;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    Some(u.to_string())
}

/// Open a web link in the user's default browser (ShellExecuteW "open", the same call the shell
/// uses for a double-clicked .url file).
pub(crate) fn open_in_browser(raw: &str) -> Result<(), String> {
    let url = external_web_url(raw).ok_or_else(|| "Only http(s) links can be opened".to_string())?;
    #[cfg(windows)]
    {
        use windows::core::{w, HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let file = HSTRING::from(url.as_str());
        let h = unsafe { ShellExecuteW(None, w!("open"), &file, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        // Per the docs, a value greater than 32 means success.
        if (h.0 as isize) > 32 {
            Ok(())
        } else {
            Err(format!("Couldn't open the browser (code {})", h.0 as isize))
        }
    }
    #[cfg(not(windows))]
    {
        let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(cmd).arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Frontend entry point for "Open on YouTube" and other deliberate external links.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    open_in_browser(&url)
}

#[cfg(not(windows))]
pub fn cdp(_pw: &tauri::webview::PlatformWebview, _method: &str, _params: &str) {}

#[cfg(not(windows))]
pub fn install(_pw: &tauri::webview::PlatformWebview, _main: bool, _sniff: Option<UnboundedSender<Found>>) {}

#[cfg(not(windows))]
pub fn install_with_options(_pw: &tauri::webview::PlatformWebview, _main: bool, _sniff: Option<SniffInstallOptions>) {}

#[cfg(not(windows))]
pub fn navigate_with_referer(_pw: &tauri::webview::PlatformWebview, _url: &str, _referer: &str) -> bool {
    false
}

/// Runs in every frame of a sniff window: mute everything and keep nudging
/// the player to start (most embeds request their playlist only once playback begins).
const NUDGE_JS: &str = r#"
(() => {
  try {
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
    const sels = [
      '.vjs-big-play-button', '.jw-icon-display', '.jw-display-icon-display',
      '.plyr__control--overlaid', '.art-state', '.art-control-play', '.fp-play',
      '.vds-play-button', '.play-button', '#play-button', '.playbtn', '#btn-play',
      '.btn-play', '[aria-label*="Play" i]', 'button[title*="Play" i]',
      '[class*="play-btn" i]', '#player', 'video'
    ];
    const isVis = (el) => el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
    let n = 0;
    const tick = () => {
      if (++n > 40) return;
      document.querySelectorAll('video,audio').forEach(v => { try { v.muted = true; const p = v.play(); p && p.catch(() => {}); } catch {} });
      const activeVideo = document.querySelector('video');
      const isPlaying = !!(activeVideo && !activeVideo.paused && activeVideo.currentTime > 0);
      for (const s of sels) {
        if ((s === '#player' || s === 'video') && isPlaying) continue;
        const el = document.querySelector(s);
        if (!el || !isVis(el)) continue;
        try { el.click(); } catch {}
        break;
      }
      if (n % 3 === 0 && !isPlaying) {
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
    /// When it was recorded: a cancel that arrived before (or after) its sniff is only a
    /// tombstone for a short while, so unknown IDs can't pile up for the whole session.
    at: std::time::Instant,
}

const CANCEL_TOMBSTONE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// Aborts the spawned task when dropped, so every exit path (not just the happy one) stops it.
struct AbortOnDrop<T>(tauri::async_runtime::JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
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
        m.retain(|_, e| e.label.is_some() || e.at.elapsed() < CANCEL_TOMBSTONE_TTL);
        let (tx, _rx) = tokio::sync::watch::channel(true);
        m.insert(cancel_id, SniffCancelEntry { label: None, tx, at: std::time::Instant::now() });
    }
}

/// Destroy every background sniffer window before the app exits or launches the installer.
pub fn close_all_sniff_windows(app: &AppHandle) {
    if let Ok(mut m) = cancel_map().lock() {
        for (_, entry) in m.drain() {
            let _ = entry.tx.send(true);
            if let Some(label) = entry.label {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.destroy();
                }
            }
        }
    }
    for (label, w) in app.webview_windows() {
        if label != "main" {
            let _ = w.destroy();
        }
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
                m.insert(cid.clone(), SniffCancelEntry { label: Some(label.clone()), tx, at: std::time::Instant::now() });
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
    // Shared with sniff_inner, which releases it as soon as its window is gone. If the sniff times
    // out or is cancelled first, it is still released below, after this window is destroyed.
    let slot = Arc::new(std::sync::Mutex::new(Some(permit)));
    let fut = tokio::time::timeout(budget, sniff_inner(app.clone(), target, timeout_ms, label.clone(), slot.clone()));

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
    slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    out
}

type PermitSlot = Arc<std::sync::Mutex<Option<tokio::sync::SemaphorePermit<'static>>>>;

async fn sniff_inner(app: AppHandle, target: url::Url, timeout_ms: Option<u64>, label: String, slot: PermitSlot) -> Result<Option<Sniffed>, String> {
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

    let hook_js = build_player_hook_script(Some(DEFAULT_EMBED_REFERER));
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
        .initialization_script_for_all_frames(hook_js)
        .initialization_script_for_all_frames(NUDGE_JS)
        // Must match the main window's arguments: WebView2 shares one browser per data folder.
        .additional_browser_args(crate::diagnostics::browser_args())
        .build()
        .map_err(|e| e.to_string())?;

    let capture = Arc::new(std::sync::Mutex::new(SniffCapture::default()));
    let cap_install = Arc::clone(&capture);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    let tx2 = tx.clone();
    win.with_webview(move |pw| {
        #[cfg(windows)]
        unsafe {
            let _ = pw.controller().SetIsVisible(true);
        }
        install_with_options(
            &pw,
            false,
            Some(SniffInstallOptions {
                tx: tx2,
                referer_hint: Some(DEFAULT_EMBED_REFERER.to_string()),
                capture: cap_install,
            }),
        );
        let _ = ready_tx.send(());
    })
    .map_err(|e| e.to_string())?;
    dbg("built");
    let _ = ready_rx.await;
    dbg("shield ready");
    drop(tx);
    let nav_url = target.to_string();
    let nav_ok = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let nav_ok2 = Arc::clone(&nav_ok);
    let _ = win.with_webview(move |pw| {
        nav_ok2.store(navigate_with_referer(&pw, &nav_url, DEFAULT_EMBED_REFERER), Ordering::Relaxed);
    });
    if !nav_ok.load(Ordering::Relaxed) {
        let _ = win.navigate(target.clone());
    }

    // Many players only fetch their stream after a real click on "play". Script clicks don't
    // count as a user gesture and can't reach cross-origin or script-written frames, so send
    // trusted mouse input through the DevTools protocol instead, at the centre of the player,
    // a few times while the page settles. Focus is emulated so "is the tab active?" checks pass.
    let clicker = AbortOnDrop({
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
        })
    });

    let page_origin = target.host_str().map(|h| match target.port() {
        Some(p) => format!("{}://{}:{}", target.scheme(), h, p),
        None => format!("{}://{}", target.scheme(), h),
    });
    let fill_default_headers = |headers: &mut Hdrs| {
        if headers.referer.as_deref().unwrap_or("").is_empty() {
            if let Some(ref orig) = page_origin {
                headers.referer = Some(format!("{orig}/"));
            }
        }
        if headers.origin.as_deref().unwrap_or("").is_empty() {
            headers.origin = headers
                .referer
                .as_deref()
                .and_then(|r| url::Url::parse(r).ok())
                .and_then(|u| {
                    u.host_str().map(|h| match u.port() {
                        Some(p) => format!("{}://{}:{}", u.scheme(), h, p),
                        None => format!("{}://{}", u.scheme(), h),
                    })
                })
                .or_else(|| page_origin.clone());
        }
    };
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms.unwrap_or(14_000));
    let mut candidates: Vec<Sniffed> = Vec::new();
    let mut subs: Vec<String> = Vec::new();
    let mut first_hit_at: Option<tokio::time::Instant> = None;
    loop {
        if first_hit_at.is_none() && has_primary_media_candidate(&candidates) {
            first_hit_at = Some(tokio::time::Instant::now());
        }
        // Only start the 900ms linger countdown once a non-ad/non-preview candidate is seen.
        let until = match first_hit_at {
            Some(t) => (t + std::time::Duration::from_millis(900)).min(deadline),
            None => deadline,
        };
        if tokio::time::Instant::now() >= until {
            dbg("wait over");
            break;
        }
        match tokio::time::timeout_at(until, rx.recv()).await {
            Ok(Some(Found::Media(mut m))) => {
                fill_default_headers(&mut m.headers);
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
    drop(clicker);
    if candidates.is_empty() {
        if let Ok(mut g) = capture.lock() {
            for (url, kind, mut headers) in g.take_pending().into_iter().take(6) {
                fill_default_headers(&mut headers);
                if !candidates.iter().any(|c| c.url == url) {
                    candidates.push(Sniffed {
                        url,
                        kind,
                        headers,
                        subtitles: vec![],
                        verified: None,
                        quality: None,
                    });
                }
            }
        }
    }
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
        dbg("destroyed");
    }
    // The browser slot is free once the window is gone. Checking the playlists below is plain HTTP:
    // holding the permit through it kept other titles' sniffs queued for no reason.
    slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    if candidates.is_empty() {
        return Ok(None);
    }
    // One slow host must not eat the whole sniff budget: each check is capped, and an unverified
    // result (None) just moves on to the next candidate.
    Ok(select_verified_candidate(candidates, subs, |u, h| async move {
        tokio::time::timeout(VERIFY_EACH, crate::stream::verify_playlist(&u, &h)).await.ok().flatten()
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

/// Cap for one captured playlist's check, and for checking all of a page's candidates.
const VERIFY_EACH: std::time::Duration = std::time::Duration::from_secs(6);
const VERIFY_TOTAL: std::time::Duration = std::time::Duration::from_secs(8);

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
    let started = std::time::Instant::now();
    for mut f in candidates {
        // Out of time: settle for the best found so far instead of timing the whole sniff out.
        if started.elapsed() >= VERIFY_TOTAL && (best_hls.is_some() || fallback.is_some()) {
            break;
        }
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
        assert!(check_network_request("https://sub.monero-miner.com/mine.js", embed, "script"));
        assert!(check_network_request("https://coinimp.com/scripts/imp.js", embed, "script"));
        assert!(check_network_request("https://cointraffic.io/js/banner.js", embed, "script"));
        assert!(check_network_request("https://webminepool.com/lib/base.js", embed, "script"));
        assert!(is_blocked_host("sub.coinhive.com"));
        assert!(!is_blocked_host("cdn.example.com"));

        // Anti-devtools / anti-adblock kits anywhere
        assert!(check_network_request("https://cdn.example.org/assets/disable-devtool.min.js", embed, "script"));
        assert!(is_blocked_url("https://cdn.example.org/assets/fuckadblock.js"));

        // Third-party popunder & VAST/VPAID tag patterns
        assert!(check_network_request("https://tracker.other.org/js/popunder.min.js", embed, "script"));
        assert!(check_network_request("https://ads.other.org/tags/vast.xml", embed, "xmlhttprequest"));
    }

    #[test]
    fn blocked_host_hashes_are_strictly_sorted_and_rules_omit_plaintext_miner_strings() {
        assert!(
            BLOCKED_HOST_HASHES.windows(2).all(|w| w[0] < w[1]),
            "BLOCKED_HOST_HASHES must stay strictly sorted in ascending order for binary_search"
        );
        let rules_lower = CURATED_RULES.to_ascii_lowercase();
        let hosts_lower: Vec<String> = BLOCKED_HOSTS.iter().map(|h| h.to_ascii_lowercase()).collect();
        for forbidden in [
            "coinhive",
            "monero",
            "miner",
            "cryptoloot",
            "crypto-loot",
            "coinimp",
            "authedmine",
            "jsecoin",
            "cointraffic",
            "coinzilla",
        ] {
            assert!(!rules_lower.contains(forbidden), "CURATED_RULES unexpectedly contains {forbidden}");
            assert!(
                !hosts_lower.iter().any(|h| h.contains(forbidden)),
                "BLOCKED_HOSTS unexpectedly contains {forbidden}"
            );
        }
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

    #[test]
    fn primary_media_candidate_check_ignores_ads_and_previews() {
        let ad = Sniffed {
            url: "https://cdn.example.com/preroll/promo/master.m3u8".into(),
            kind: "hls",
            headers: Hdrs::default(),
            subtitles: vec![],
            verified: None,
            quality: None,
        };
        let preview = Sniffed {
            url: "https://preview.example.com/clip.mp4".into(),
            kind: "mp4",
            headers: Hdrs::default(),
            subtitles: vec![],
            verified: None,
            quality: None,
        };
        let feature = Sniffed {
            url: "https://cdn.example.com/stream/170060/master.m3u8".into(),
            kind: "hls",
            headers: Hdrs::default(),
            subtitles: vec![],
            verified: None,
            quality: None,
        };
        assert!(!has_primary_media_candidate(&[]));
        assert!(!has_primary_media_candidate(&[ad.clone(), preview.clone()]));
        assert!(has_primary_media_candidate(&[ad, preview, feature]));
    }

    #[test]
    fn manifest_request_and_response_classification_cover_txt_and_extensionless_playlists() {
        assert_eq!(classify_manifest_request_uri("https://cdn.example/hls/master.m3u8?tok=1"), Some("hls"));
        assert_eq!(classify_manifest_request_uri("https://cdn.example/hls/master.txt?tok=1"), Some("hls"));
        assert_eq!(classify_manifest_request_uri("https://vixsrc.to/playlist/170060?type=video"), Some("hls"));
        assert_eq!(classify_manifest_request_uri("https://cdn.example/dash/manifest.mpd?id=1"), Some("dash"));
        assert_eq!(classify_manifest_request_uri("https://cdn.example/seg.ts?ref=master.m3u8"), None);
        assert_eq!(classify_manifest_request_uri("https://cdn.example/ads/preroll/master.m3u8"), None);

        assert_eq!(
            classify_response_media("https://vixsrc.to/playlist/170060?type=video", "application/vnd.apple.mpegurl"),
            Some("hls")
        );
        assert_eq!(
            classify_response_media("https://cdn.example/stream/master.txt?k=1", "application/x-mpegurl"),
            Some("hls")
        );
        assert_eq!(
            classify_response_media("https://cdn.example/stream/master.txt?k=1", "text/plain; charset=utf-8"),
            Some("hls")
        );
        assert_eq!(
            classify_response_media("https://vixsrc.to/playlist/170060?type=video", "text/html; charset=utf-8"),
            None
        );
        assert_eq!(
            classify_response_media("https://cdn.example/seg.ts?ref=master.m3u8", "video/mp2t"),
            None
        );
    }

    #[test]
    fn merge_captured_headers_replaces_opaque_response_headers() {
        let resp = Hdrs {
            referer: Some("about:blank".into()),
            origin: Some("null".into()),
            ua: None,
        };
        let req = Hdrs {
            referer: Some("https://embed.vidrift.net/embed/movie/123".into()),
            origin: Some("https://embed.vidrift.net".into()),
            ua: Some("Mozilla/5.0".into()),
        };
        let merged = merge_captured_headers(resp, Some(&req));
        assert_eq!(merged.referer.as_deref(), Some("https://embed.vidrift.net/embed/movie/123"));
        assert_eq!(merged.origin.as_deref(), Some("https://embed.vidrift.net"));
        assert_eq!(merged.ua.as_deref(), Some("Mozilla/5.0"));
    }

    #[test]
    fn player_hook_and_nudge_scripts_include_iframe_spoof_and_selectors() {
        let hook = build_player_hook_script(None);
        assert!(hook.contains("window.self !== window.top"));
        assert!(hook.contains("https://www.themoviedb.org/"));
        assert!(hook.contains("'top'"));
        assert!(hook.contains("'parent'"));
        assert!(hook.contains("'frameElement'"));
        assert!(hook.contains("'referrer'"));
        assert!(hook.contains("'ancestorOrigins'"));
        assert!(hook.contains("closed: false"));

        for sel in [
            ".jw-icon-display",
            ".vjs-big-play-button",
            ".plyr__control--overlaid",
            ".art-state",
            "[aria-label*=\"Play\" i]",
            "[class*=\"play-btn\" i]",
            "#player",
            "'video'",
        ] {
            assert!(NUDGE_JS.contains(sel), "NUDGE_JS missing selector {sel}");
        }
        assert!(!NUDGE_JS.contains("window.open = () => null"));
    }
}

#[cfg(test)]
mod navigation_tests {
    use super::is_app_navigation;

    #[test]
    fn main_window_stays_on_the_app() {
        assert!(is_app_navigation("http://tauri.localhost/#/title/x"));
        assert!(is_app_navigation("tauri://localhost/"));
        assert!(is_app_navigation("about:blank"));
        for bad in ["javascript:alert(1)", "data:text/html,hi", "file:///C:/Windows/win.ini", "http://abxs.localhost/p?u=x", "https://example.com/", "ms-settings:privacy"] {
            assert!(!is_app_navigation(bad), "{bad} must be blocked");
        }
    }
}

#[cfg(test)]
mod external_link_tests {
    use super::{external_web_url, is_youtube_embed_url};

    #[test]
    fn only_plain_web_links_leave_the_app() {
        assert_eq!(
            external_web_url("https://www.youtube.com/watch?v=abc123").as_deref(),
            Some("https://www.youtube.com/watch?v=abc123")
        );
        assert!(external_web_url(" https://www.imdb.com/title/tt0111161/ ").is_some());
        for bad in ["file:///C:/Windows", r"C:\Windows", "ms-settings:privacy", "javascript:alert(1)", "shell:startup", "https://user:pw@example.com/", ""] {
            assert!(external_web_url(bad).is_none(), "{bad} must not be opened");
        }
    }

    #[test]
    fn recognises_youtube_embeds() {
        assert!(is_youtube_embed_url("https://www.youtube-nocookie.com/embed/abc?autoplay=1"));
        assert!(is_youtube_embed_url("https://www.youtube.com/embed/abc"));
        assert!(!is_youtube_embed_url("https://www.youtube.com/watch?v=abc"));
        assert!(!is_youtube_embed_url("https://evil.example/embed/abc"));
        assert!(!is_youtube_embed_url("http://www.youtube.com/embed/abc"));
    }
}
