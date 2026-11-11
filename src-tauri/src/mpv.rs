//! mpv playback engine.
//!
//! The built-in player is WebView2's <video> element, which can't decode HEVC, DTS, TrueHD and
//! many MKV layouts. For those (or always, if the viewer picks it) AbixCine drives an mpv process:
//!
//! * mpv runs as a child process and is controlled over its JSON IPC (a named pipe on Windows).
//! * "Embedded" mode: mpv draws into a plain native window that sits exactly behind the main
//!   window. During playback the main window is made the *owned* window of that host (owned
//!   windows always stay above their owner), the page turns transparent where the picture is, and
//!   the AbixCine controls float over mpv's picture. The host follows the main window around.
//! * "Separate" mode: mpv opens its own window; the app becomes a remote control for it.
//!
//! The webview never gets a raw pipe. Commands go through `mpv_command`, which only allows a short
//! list of playback commands, so a page can't use mpv's `run`/`load-script` or read arbitrary files:
//! files must be inside a library folder the user chose, everything else must be http(s).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const HOST_LABEL: &str = "mpv-host";

/// Properties the player UI needs, observed as soon as the pipe opens.
const OBSERVE: &[&str] = &[
    "time-pos",
    "duration",
    "pause",
    "paused-for-cache",
    "core-idle",
    "seeking",
    "eof-reached",
    "demuxer-cache-time",
    "volume",
    "mute",
    "speed",
    "track-list",
    "sid",
    "aid",
    "video-params",
    "chapter-list",
    "idle-active",
];

const ALLOWED_COMMANDS: &[&str] = &[
    "loadfile", "stop", "seek", "set_property", "get_property", "cycle", "add", "sub-add", "frame-step", "frame-back-step",
];
const ALLOWED_PROPS: &[&str] = &[
    "pause", "volume", "mute", "speed", "sid", "aid", "start", "sub-visibility", "sub-delay", "audio-delay", "time-pos",
    "hwdec", "alang", "slang", "sub-scale", "loop-file", "deinterlace", "chapter", "ab-loop-a", "ab-loop-b",
];

struct Session {
    tx: mpsc::UnboundedSender<String>,
    child: Arc<tokio::sync::Mutex<tokio::process::Child>>,
    embedded: bool,
    id: u64,
}

#[derive(Default)]
pub struct MpvState {
    session: Mutex<Option<Session>>,
    /// Library folders the user chose (set by scan_library). Local files outside them are refused.
    roots: Mutex<Vec<PathBuf>>,
    next_id: Mutex<u64>,
}

impl MpvState {
    pub fn set_roots(&self, roots: Vec<PathBuf>) {
        let canon = roots.into_iter().map(|r| std::fs::canonicalize(&r).unwrap_or(r)).collect();
        *self.roots.lock().unwrap() = canon;
    }
}

#[derive(Serialize)]
pub struct MpvInfo {
    path: String,
    version: String,
    bundled: bool,
}

#[derive(Serialize)]
pub struct Started {
    #[serde(flatten)]
    info: MpvInfo,
    /// Every "mpv-event" carries this, so a page ignores events from an earlier mpv.
    session: u64,
    /// False when embedding wasn't possible and mpv opened its own window instead.
    embedded: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOpts {
    /// Custom mpv.exe chosen in Settings; otherwise the bundled copy or one on PATH.
    path: Option<String>,
    /// Draw inside the AbixCine window (true) or in mpv's own window.
    embedded: bool,
    /// Hardware decoding (auto-safe). Off fixes the odd driver that shows green frames.
    #[serde(default = "yes")]
    hwdec: bool,
    /// Preferred audio / subtitle languages, e.g. "jpn,ja" and "eng,en".
    alang: Option<String>,
    slang: Option<String>,
    /// Window title in separate mode.
    title: Option<String>,
}
fn yes() -> bool {
    true
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "mpv.exe"
    } else {
        "mpv"
    }
}

/// Where to look for mpv, most specific first.
fn candidates<R: Runtime>(app: &AppHandle<R>, custom: Option<&str>) -> Vec<(PathBuf, bool)> {
    let mut out = Vec::new();
    if let Some(c) = custom.filter(|c| !c.trim().is_empty()) {
        let p = PathBuf::from(c.trim());
        out.push((if p.is_dir() { p.join(exe_name()) } else { p }, false));
    }
    if let Ok(res) = app.path().resource_dir() {
        out.push((res.join("mpv").join(exe_name()), true));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            out.push((dir.join(exe_name()), false));
        }
    }
    #[cfg(windows)]
    {
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        if let Some(h) = env("USERPROFILE") {
            out.push((h.join("scoop").join("apps").join("mpv").join("current").join("mpv.exe"), false));
        }
        if let Some(l) = env("LOCALAPPDATA") {
            out.push((l.join("Programs").join("mpv").join("mpv.exe"), false));
            out.push((l.join("Microsoft").join("WinGet").join("Links").join("mpv.exe"), false));
        }
        for k in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(p) = env(k) {
                out.push((p.join("mpv").join("mpv.exe"), false));
            }
        }
        out.push((PathBuf::from(r"C:\ProgramData\chocolatey\bin\mpv.exe"), false));
    }
    #[cfg(target_os = "macos")]
    {
        out.push((PathBuf::from("/opt/homebrew/bin/mpv"), false));
        out.push((PathBuf::from("/usr/local/bin/mpv"), false));
        out.push((PathBuf::from("/Applications/mpv.app/Contents/MacOS/mpv"), false));
    }
    out
}

fn no_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never flash a console.
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

async fn version_of(path: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version").stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null());
    no_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?.trim().to_string();
    first.starts_with("mpv").then_some(first)
}

async fn find<R: Runtime>(app: &AppHandle<R>, custom: Option<&str>) -> Option<MpvInfo> {
    for (p, bundled) in candidates(app, custom) {
        if !p.is_file() {
            continue;
        }
        if let Some(version) = version_of(&p).await {
            return Some(MpvInfo { path: p.to_string_lossy().into_owned(), version, bundled });
        }
    }
    None
}

/// Is mpv available, and which one? `null` when it isn't installed.
#[tauri::command]
pub async fn mpv_probe(app: AppHandle, path: Option<String>) -> Option<MpvInfo> {
    find(&app, path.as_deref()).await
}

/// A local file is only playable if it's inside a library folder; streams must be http(s).
fn allowed_target(state: &MpvState, target: &str) -> bool {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return true;
    }
    if lower.contains("://") || target.starts_with('-') {
        return false; // mpv understands lavf://, av://, memory:// … none of which we need.
    }
    let Ok(p) = std::fs::canonicalize(target) else { return false };
    if !p.is_file() {
        return false;
    }
    state.roots.lock().unwrap().iter().any(|r| p.starts_with(r))
}

fn check_command(state: &MpvState, args: &[Value]) -> Result<(), String> {
    let name = args.first().and_then(Value::as_str).ok_or("empty command")?;
    if !ALLOWED_COMMANDS.contains(&name) {
        return Err(format!("command not allowed: {name}"));
    }
    match name {
        "loadfile" | "sub-add" => {
            let target = args.get(1).and_then(Value::as_str).ok_or("missing target")?;
            if !allowed_target(state, target) {
                return Err("that file isn't in one of your library folders".into());
            }
            // Only the plain forms: loadfile <url> [replace|append], sub-add <url> [select|auto|cached] [title] [lang].
            if name == "loadfile" && args.len() > 3 {
                return Err("loadfile options are not allowed".into());
            }
            if args.iter().skip(2).any(|a| !a.is_string() && !a.is_number()) {
                return Err("bad arguments".into());
            }
        }
        "set_property" | "cycle" | "add" => {
            let prop = args.get(1).and_then(Value::as_str).ok_or("missing property")?;
            if !ALLOWED_PROPS.contains(&prop) {
                return Err(format!("property not allowed: {prop}"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// Send one command, e.g. ["seek", 10, "relative"] or ["set_property", "pause", true].
#[tauri::command]
pub fn mpv_command(state: tauri::State<'_, MpvState>, args: Vec<Value>, request_id: Option<u64>) -> Result<(), String> {
    check_command(&state, &args)?;
    let guard = state.session.lock().unwrap();
    let s = guard.as_ref().ok_or("mpv isn't running")?;
    let mut msg = json!({ "command": args });
    if let Some(id) = request_id {
        msg["request_id"] = json!(id);
    }
    s.tx.send(msg.to_string() + "\n").map_err(|_| "mpv has stopped".to_string())
}

#[cfg(windows)]
mod pipe {
    use std::time::Duration;
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

    pub fn name(tag: &str) -> String {
        format!(r"\\.\pipe\abixcine-mpv-{tag}")
    }
    pub async fn connect(name: &str) -> std::io::Result<NamedPipeClient> {
        let mut last = None;
        for _ in 0..100 {
            match ClientOptions::new().open(name) {
                Ok(c) => return Ok(c),
                Err(e) => last = Some(e),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err(last.unwrap_or_else(|| std::io::Error::other("mpv pipe never appeared")))
    }
}

#[cfg(unix)]
mod pipe {
    use std::time::Duration;
    use tokio::net::UnixStream;

    pub fn name(tag: &str) -> String {
        std::env::temp_dir().join(format!("abixcine-mpv-{tag}.sock")).to_string_lossy().into_owned()
    }
    pub async fn connect(name: &str) -> std::io::Result<UnixStream> {
        let mut last = None;
        for _ in 0..100 {
            match UnixStream::connect(name).await {
                Ok(c) => return Ok(c),
                Err(e) => last = Some(e),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err(last.unwrap_or_else(|| std::io::Error::other("mpv socket never appeared")))
    }
}

/// Start (or restart) mpv idle, ready for `loadfile`. Events arrive as "mpv-event"; "mpv-exit" when it quits.
#[tauri::command]
pub async fn mpv_start(app: AppHandle, state: tauri::State<'_, MpvState>, opts: StartOpts) -> Result<Started, String> {
    stop_session(&app, &state).await;
    let info = find(&app, opts.path.as_deref()).await.ok_or("mpv isn't installed")?;
    let id = {
        let mut n = state.next_id.lock().unwrap();
        *n += 1;
        *n
    };
    let tag = format!("{}-{}-{:08x}", std::process::id(), id, rand::random::<u32>());
    let pipe_name = pipe::name(&tag);

    let host_wid = if opts.embedded { host_window(&app).ok() } else { None };
    let embedded = host_wid.is_some();

    let mut cmd = tokio::process::Command::new(&info.path);
    cmd.arg("--no-config")
        .arg("--idle=yes")
        .arg("--force-window=yes")
        .arg("--keep-open=yes")
        .arg("--load-scripts=no")
        .arg("--ytdl=no")
        .arg("--osc=no")
        .arg("--osd-level=0")
        .arg("--terminal=no")
        .arg("--msg-level=all=error")
        .arg("--sub-auto=fuzzy")
        .arg("--audio-file-auto=no")
        .arg("--cache=yes")
        .arg("--demuxer-max-bytes=256MiB")
        .arg("--hls-bitrate=max")
        .arg("--vo=gpu-next")
        .arg("--target-colorspace-hint=yes")
        .arg("--save-position-on-quit=no")
        .arg(format!("--hwdec={}", if opts.hwdec { "auto-safe" } else { "no" }))
        .arg(format!("--input-ipc-server={pipe_name}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(a) = opts.alang.as_deref().filter(|a| valid_langs(a)) {
        cmd.arg(format!("--alang={a}"));
    }
    if let Some(s) = opts.slang.as_deref().filter(|s| valid_langs(s)) {
        cmd.arg(format!("--slang={s}"));
    }
    if let Some(wid) = host_wid {
        // AbixCine's own controls draw on top; mpv must not grab keys or the mouse.
        cmd.arg(format!("--wid={wid}"))
            .arg("--input-default-bindings=no")
            .arg("--input-vo-keyboard=no")
            .arg("--input-cursor=no")
            .arg("--cursor-autohide=no");
    } else {
        let title = opts.title.unwrap_or_else(|| "AbixCine".into()).replace(['\n', '\r'], " ");
        cmd.arg(format!("--title={title} · AbixCine")).arg("--geometry=1280x720").arg("--autofit-larger=90%x90%");
    }
    no_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("couldn't start mpv: {e}"))?;
    let child = Arc::new(tokio::sync::Mutex::new(child));

    let conn = match pipe::connect(&pipe_name).await {
        Ok(c) => c,
        Err(e) => {
            let _ = child.lock().await.kill().await;
            hide_host(&app);
            return Err(format!("mpv didn't open its control pipe: {e}"));
        }
    };
    let (rd, mut wr) = tokio::io::split(conn);
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    for (i, p) in OBSERVE.iter().enumerate() {
        let _ = tx.send(json!({ "command": ["observe_property", i + 1, p] }).to_string() + "\n");
    }

    tauri::async_runtime::spawn(async move {
        while let Some(line) = rx.recv().await {
            if wr.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(rd).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let _ = app2.emit("mpv-event", json!({ "session": id, "msg": v }));
            }
        }
        // Pipe closed: mpv quit or crashed.
        let st = app2.state::<MpvState>();
        let mine = st.session.lock().unwrap().as_ref().map(|s| s.id) == Some(id);
        if mine {
            st.session.lock().unwrap().take();
            hide_host(&app2);
        }
        let _ = app2.emit("mpv-exit", json!({ "session": id }));
    });

    if embedded {
        attach_host(&app);
    }
    *state.session.lock().unwrap() = Some(Session { tx, child, embedded, id });
    Ok(Started { info, session: id, embedded })
}

fn valid_langs(s: &str) -> bool {
    !s.is_empty() && s.len() < 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == ',' || c == '-')
}

async fn stop_session<R: Runtime>(app: &AppHandle<R>, state: &MpvState) {
    let s = state.session.lock().unwrap().take();
    if let Some(s) = s {
        let _ = s.tx.send("{\"command\":[\"quit\"]}\n".into());
        let child = s.child.clone();
        // Give mpv a moment to exit cleanly, then make sure.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let _ = child.lock().await.kill().await;
        });
        if s.embedded {
            hide_host(app);
        }
    }
}

#[tauri::command]
pub async fn mpv_stop(app: AppHandle, state: tauri::State<'_, MpvState>) -> Result<(), String> {
    stop_session(&app, &state).await;
    Ok(())
}

/// The plain native window mpv draws into. Created once, hidden when idle.
fn host_window<R: Runtime>(app: &AppHandle<R>) -> Result<isize, String> {
    let main = app.get_webview_window("main").ok_or("no main window")?;
    let host = match app.get_window(HOST_LABEL) {
        Some(w) => w,
        None => tauri::window::WindowBuilder::new(app, HOST_LABEL)
            .title("AbixCine video")
            .decorations(false)
            .skip_taskbar(true)
            .shadow(false)
            .focused(false)
            .visible(false)
            .background_color(tauri::window::Color(0, 0, 0, 255))
            .build()
            .map_err(|e| e.to_string())?,
    };
    follow(&main.as_ref().window(), &host);
    host_hwnd(&host)
}

#[cfg(windows)]
fn host_hwnd<R: Runtime>(w: &tauri::Window<R>) -> Result<isize, String> {
    w.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string())
}
#[cfg(not(windows))]
fn host_hwnd<R: Runtime>(_w: &tauri::Window<R>) -> Result<isize, String> {
    // X11/Cocoa embedding isn't wired up: fall back to mpv's own window.
    Err("embedding is Windows-only".into())
}

/// Put the host exactly behind the main window.
fn follow<R: Runtime>(main: &tauri::Window<R>, host: &tauri::Window<R>) {
    if let (Ok(pos), Ok(size)) = (main.outer_position(), main.outer_size()) {
        let _ = host.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = host.set_size(PhysicalSize::new(size.width.max(1), size.height.max(1)));
    }
}

fn attach_host<R: Runtime>(app: &AppHandle<R>) {
    let (Some(main), Some(host)) = (app.get_webview_window("main"), app.get_window(HOST_LABEL)) else { return };
    let main_w = main.as_ref().window();
    follow(&main_w, &host);
    let _ = host.show();
    set_owner(&main_w, Some(&host));
    let _ = main.set_focus();
}

fn hide_host<R: Runtime>(app: &AppHandle<R>) {
    if let Some(host) = app.get_window(HOST_LABEL) {
        if let Some(main) = app.get_webview_window("main") {
            set_owner(&main.as_ref().window(), None);
        }
        let _ = host.hide();
    }
}

/// Owned windows always sit above their owner, so making the host the main window's owner keeps
/// mpv's picture directly behind the (transparent) player page, whatever else is on screen.
#[cfg(windows)]
fn set_owner<R: Runtime>(main: &tauri::Window<R>, owner: Option<&tauri::Window<R>>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_HWNDPARENT};
    let Ok(m) = main.hwnd() else { return };
    let o = owner.and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize).unwrap_or(0);
    unsafe {
        SetWindowLongPtrW(m.0 as _, GWLP_HWNDPARENT, o);
    }
}
#[cfg(not(windows))]
fn set_owner<R: Runtime>(_main: &tauri::Window<R>, _owner: Option<&tauri::Window<R>>) {}

/// An owned window loses its taskbar button unless it's marked as an app window. Set once at startup.
#[cfg(windows)]
pub fn keep_taskbar_button<R: Runtime>(main: &tauri::WebviewWindow<R>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW};
    if let Ok(h) = main.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(h.0 as _, GWL_EXSTYLE);
            SetWindowLongPtrW(h.0 as _, GWL_EXSTYLE, ex | WS_EX_APPWINDOW as isize);
        }
    }
}
#[cfg(not(windows))]
pub fn keep_taskbar_button<R: Runtime>(_main: &tauri::WebviewWindow<R>) {}

/// Main window events: keep the host glued behind it, hide it while minimized.
pub fn on_main_event<R: Runtime>(app: &AppHandle<R>, event: &tauri::WindowEvent) {
    let embedded = app.state::<MpvState>().session.lock().unwrap().as_ref().map(|s| s.embedded).unwrap_or(false);
    if !embedded {
        return;
    }
    let (Some(main), Some(host)) = (app.get_webview_window("main"), app.get_window(HOST_LABEL)) else { return };
    match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            if main.is_minimized().unwrap_or(false) {
                let _ = host.hide();
            } else {
                follow(&main.as_ref().window(), &host);
                if !host.is_visible().unwrap_or(true) {
                    let _ = host.show();
                    let _ = main.set_focus();
                }
            }
        }
        tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. } => {
            let st = app.state::<MpvState>();
            if let Some(s) = st.session.lock().unwrap().take() {
                let _ = s.tx.send("{\"command\":[\"quit\"]}\n".into());
            }
            let _ = host.close();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_dangerous_commands() {
        let st = MpvState::default();
        assert!(check_command(&st, &[json!("run"), json!("calc.exe")]).is_err());
        assert!(check_command(&st, &[json!("load-script"), json!("x.lua")]).is_err());
        assert!(check_command(&st, &[json!("set_property"), json!("script-opts"), json!("x")]).is_err());
        assert!(check_command(&st, &[json!("loadfile"), json!("lavf://file:/etc/passwd")]).is_err());
        assert!(check_command(&st, &[json!("loadfile"), json!("/etc/passwd")]).is_err());
        assert!(check_command(&st, &[json!("loadfile"), json!("https://x/y.m3u8"), json!("replace"), json!("opt=1")]).is_err());
        assert!(check_command(&st, &[json!("loadfile"), json!("https://x/y.m3u8"), json!("replace")]).is_ok());
        assert!(check_command(&st, &[json!("set_property"), json!("pause"), json!(true)]).is_ok());
        assert!(check_command(&st, &[json!("seek"), json!(10), json!("relative")]).is_ok());
    }

    #[test]
    fn files_must_be_in_a_library_folder() {
        let dir = std::env::temp_dir().join(format!("abx-mpv-test-{}", std::process::id()));
        let lib = dir.join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        let inside = lib.join("a.mkv");
        let outside = dir.join("b.mkv");
        std::fs::write(&inside, b"x").unwrap();
        std::fs::write(&outside, b"x").unwrap();
        let st = MpvState::default();
        st.set_roots(vec![lib.clone()]);
        assert!(allowed_target(&st, inside.to_str().unwrap()));
        assert!(!allowed_target(&st, outside.to_str().unwrap()));
        let sneaky = lib.join("..").join("b.mkv");
        assert!(!allowed_target(&st, sneaky.to_str().unwrap()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
