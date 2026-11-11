import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { AudioToggle } from "../components/AudioToggle";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { changePassword, errorMessage, getApiBase, leaveGuest, sendVerification, signOut, updateProfile, useAuth, verifyEmail } from "../lib/account";
import { checkNewEpisodes } from "../lib/alerts";
import { fmtAgo } from "../lib/format";
import { checkForUpdates, RELEASES_URL, releaseNotes, useUpdates, type Release } from "../lib/updater";
import { probeMpv, useMpv } from "../player/mpv";
import { Notes } from "../components/Updates";
import { updateSettings, useSettings } from "../lib/settings";
import { getHealth, reliability, resetHealth } from "../sources/health";
import { scanLibrary } from "../sources/local";
import { PROVIDERS } from "../sources/registry";

export function Settings() {
  const s = useSettings();
  const { user, tmdbProxy, online } = useAuth();
  const loc = useLocation();
  const sourcesRef = useRef<HTMLElement>(null);
  const [tmdb, setTmdb] = useState(s.tmdbKey);
  const [jf, setJf] = useState(s.jellyfin);
  const [scan, setScan] = useState<string | null>(null);
  const [jfTest, setJfTest] = useState<string | null>(null);
  const [name, setName] = useState(user?.name ?? "");
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [showExternal, setShowExternal] = useState(s.jellyfin.enabled);
  const [, setHealthTick] = useState(0);
  const mpv = useMpv(s.mpvPath);
  const [mpvPath, setMpvPath] = useState(s.mpvPath);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const up = useUpdates();
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [relErr, setRelErr] = useState<string | null>(null);
  const [openRel, setOpenRel] = useState<string | null>(null);
  useEffect(() => {
    releaseNotes().then(setReleases, (e) => setRelErr(String(e?.message ?? e)));
  }, []);
  const openLink = async (url: string) => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  };

  useEffect(() => {
    if (loc.hash === "#sources") sourcesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loc.hash]);

  const addFolder = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Add a media folder" });
    if (typeof dir === "string" && !s.libraryPaths.includes(dir)) {
      const paths = [...s.libraryPaths, dir];
      updateSettings({ libraryPaths: paths });
      rescan(paths);
    }
  };
  const rescan = async (paths = s.libraryPaths) => {
    setScan("Scanning…");
    try {
      const files = await scanLibrary(paths, true);
      setScan(`${files.length} video files indexed`);
    } catch (e: any) {
      setScan(`Scan failed: ${e?.message ?? e}`);
    }
  };
  const testJellyfin = async () => {
    setJfTest("Testing…");
    try {
      const r = await fetch(jf.url.replace(/\/$/, "") + "/System/Info", { headers: { "X-Emby-Token": jf.apiKey } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setJfTest(`Connected to ${j.ServerName} (v${j.Version})`);
      updateSettings({ jellyfin: { ...jf, enabled: true } });
      setJf({ ...jf, enabled: true });
    } catch (e: any) {
      setJfTest(`Couldn't connect: ${e?.message ?? e}`);
    }
  };

  return (
    <div className="page settings">
      <h1 className="page-title">Settings</h1>

      {!user && (
        <section className="panel">
          <h2>Account</h2>
          <div className="account-row">
            <div className="account-info">
              <strong>Using AbixCine without an account</strong>
              <span className="muted">Progress, My List and settings are saved on this PC only. Sign in to sync them to every device; nothing here is lost.</span>
            </div>
            <button className="btn btn-ion sm" onClick={leaveGuest}><Icon name="user" size={15} /> Sign in or create account</button>
          </div>
        </section>
      )}
      {user && (
        <section className="panel">
          <h2>Account</h2>
          <div className="account-row">
            <button className="avatar-cycle" title="Change color" onClick={() => updateProfile({ avatarHue: (user.avatarHue + 47) % 360 }).catch((e) => setProfileMsg(errorMessage(e)))}>
              <Avatar user={user} size={56} />
            </button>
            <div className="account-info">
              <div className="field-row">
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
                <button
                  className="btn btn-glass sm"
                  disabled={!name.trim() || name === user.name}
                  onClick={() => updateProfile({ name }).then(() => setProfileMsg("Saved"), (e) => setProfileMsg(errorMessage(e)))}
                >
                  Save
                </button>
              </div>
              <span className="muted">{user.email}{user.emailVerified ? " ✓" : ""} · {online ? "synced" : "offline, will sync when back"} · {getApiBase().replace(/^https?:\/\//, "")}</span>
              {profileMsg && <span className="muted">{profileMsg}</span>}
            </div>
            <button className="btn btn-glass sm" onClick={signOut}><Icon name="logout" size={15} /> Sign out</button>
          </div>
          {user.emailVerified === false && (
            <div className="verify-box">
              <div>
                <strong>Confirm your email</strong>
                <span className="muted">So you can reset your password if you ever forget it. We sent a 6-digit code when you signed up.</span>
              </div>
              <div className="field-row">
                <input inputMode="numeric" maxLength={6} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ""))} placeholder="6-digit code" aria-label="Verification code" />
                <button className="btn btn-ion sm" disabled={verifyCode.length !== 6} onClick={() => verifyEmail(verifyCode).then(() => setVerifyMsg("Email confirmed"), (e) => setVerifyMsg(errorMessage(e)))}>Confirm</button>
                <button className="btn btn-glass sm" onClick={() => sendVerification().then(() => setVerifyMsg(`New code sent to ${user.email}`), (e) => setVerifyMsg(errorMessage(e)))}>Send a new code</button>
              </div>
              {verifyMsg && <span className="muted">{verifyMsg}</span>}
            </div>
          )}
          <button className="expander" onClick={() => setShowPw((x) => !x)} aria-expanded={showPw}>
            <Icon name={showPw ? "chevL" : "chevR"} size={14} /> {user.hasPassword === false ? "Set a password" : "Change password"}
            <span className="muted">{user.hasPassword === false ? "so you can also sign in with email" : "signs out your other devices"}</span>
          </button>
          {showPw && (
            <div className="field-grid">
              {user.hasPassword !== false && <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} placeholder="Current password" autoComplete="current-password" />}
              <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} placeholder="New password (8+ characters)" autoComplete="new-password" />
              <div className="field-row">
                <button className="btn btn-glass sm" disabled={pw.next.length < 8} onClick={() => changePassword(pw.current, pw.next).then(() => { setPw({ current: "", next: "" }); setPwMsg("Password saved. Other devices were signed out."); }, (e) => setPwMsg(errorMessage(e)))}>Save password</button>
                {pwMsg && <span className="muted">{pwMsg}</span>}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="panel" id="sources" ref={sourcesRef}>
        <h2>Sources</h2>
        <p className="muted">When you press play, AbixCine checks every source at once and plays the best match by quality and speed. If a stream drops, it switches to the next one and keeps your place.</p>

        <div className="source-block primary">
          <div className="source-head"><Icon name="folder" /><strong>Media folders on this PC</strong><span className={`badge ${s.libraryPaths.length ? "on" : ""}`}>{s.libraryPaths.length ? `${s.libraryPaths.length} folder${s.libraryPaths.length > 1 ? "s" : ""}` : "Not set up"}</span></div>
          <p className="muted">Names like “Show S01E02 1080p.mp4”, “Anime - 05 [Dub].mkv” or “Movie (2021).mp4” are matched automatically. Files tagged Dub or Dual Audio show up under the Dub toggle.</p>
          {s.libraryPaths.map((p) => (
            <div key={p} className="path-row">
              <code>{p}</code>
              <button className="icon-btn" aria-label="Remove folder" onClick={() => updateSettings({ libraryPaths: s.libraryPaths.filter((x) => x !== p) })}><Icon name="x" size={14} /></button>
            </div>
          ))}
          <div className="field-row">
            <button className="btn btn-ion sm" onClick={addFolder} disabled={!isTauri()}><Icon name="plus" size={15} /> Add folder</button>
            {s.libraryPaths.length > 0 && <button className="btn btn-glass sm" onClick={() => rescan()}>Rescan</button>}
            {scan && <span className="muted">{scan}</span>}
            {!isTauri() && <span className="muted">Folder access works in the desktop app.</span>}
          </div>
        </div>

        <button className="expander" onClick={() => setShowExternal((x) => !x)} aria-expanded={showExternal}>
          <Icon name={showExternal ? "chevL" : "chevR"} size={14} /> External servers <span className="muted">optional, for streaming from another machine</span>
        </button>
        {showExternal && (
          <div className="source-block">
            <div className="source-head"><Icon name="layers" /><strong>Jellyfin server</strong><span className={`badge ${s.jellyfin.enabled ? "on" : ""}`}>{s.jellyfin.enabled ? "On" : "Off"}</span></div>
            <p className="muted">Your own Jellyfin server. Create a key in Dashboard → API Keys. More server types can plug in here later.</p>
            <div className="field-grid">
              <input value={jf.url} onChange={(e) => setJf({ ...jf, url: e.target.value })} placeholder="http://192.168.1.10:8096" />
              <input type="password" value={jf.apiKey} onChange={(e) => setJf({ ...jf, apiKey: e.target.value })} placeholder="API key" />
            </div>
            <div className="field-row">
              <button className="btn btn-glass sm" onClick={testJellyfin} disabled={!jf.url || !jf.apiKey}>Connect</button>
              {s.jellyfin.enabled && <button className="btn btn-glass sm" onClick={() => { updateSettings({ jellyfin: { ...jf, enabled: false } }); setJf({ ...jf, enabled: false }); }}>Disable</button>}
              {jfTest && <span className="muted">{jfTest}</span>}
            </div>
          </div>
        )}

        <div className="picker-stats">
          <div className="setting-line">
            <div>
              <strong>Source picker</strong>
              <span className="muted">Every source is asked at once. The pick weighs quality, speed, each source's track record and what played this show last time. The rest stay on standby as backup servers.</span>
            </div>
            <button className="btn btn-glass sm" onClick={() => { resetHealth(); setHealthTick((n) => n + 1); }}>Reset history</button>
          </div>
          <div className="health-list">
            {PROVIDERS.filter((p) => p.isEnabled(s)).map((p) => {
              const h = getHealth(p.id);
              const seen = h.ok + h.fail > 0.5;
              return (
                <div key={p.id} className="health">
                  <span>{p.name}</span>
                  <span className="muted">{seen ? `${Math.round(reliability(p.id) * 100)}% reliable` : "no history yet"}{h.latency != null ? ` · ~${Math.round(h.latency)} ms` : ""}</span>
                  <i style={{ ["--w" as any]: `${seen ? reliability(p.id) * 100 : 0}%` }} />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>Playback</h2>
        <div className="setting-line">
          <div><strong>Anime audio</strong><span className="muted">Default for every show. You can still flip it per show or mid-episode.</span></div>
          <AudioToggle value={s.animeAudio} onChange={(a) => updateSettings({ animeAudio: a })} />
        </div>
        <div className="setting-line">
          <div><strong>Preferred quality</strong><span className="muted">Used to rank sources.</span></div>
          <div className="tabs">
            {[2160, 1080, 720, 480].map((q) => (
              <button key={q} className={`chip ${s.preferredQuality === q ? "on" : ""}`} onClick={() => updateSettings({ preferredQuality: q })}>{q === 2160 ? "4K" : `${q}p`}</button>
            ))}
          </div>
        </div>
        <div className="setting-line">
          <div>
            <strong>Player engine</strong>
            <span className="muted">
              {mpv
                ? `mpv found: ${mpv.version.split(" ").slice(0, 2).join(" ")}${mpv.bundled ? " (built in)" : ""}. Auto uses the built-in player and switches to mpv for HEVC, DTS/TrueHD, 10-bit, HDR and anything else it can't decode.`
                : mpv === null
                  ? "Only the built-in player is available. Install mpv (mpv.io, or winget install mpv) to play HEVC, DTS, TrueHD, HDR and every other format."
                  : "Looking for mpv…"}
            </span>
          </div>
          <div className="tabs">
            {(["auto", "builtin", "mpv"] as const).map((e) => (
              <button key={e} className={`chip ${s.engine === e ? "on" : ""}`} disabled={e === "mpv" && !mpv} onClick={() => updateSettings({ engine: e })}>{e === "auto" ? "Auto" : e === "builtin" ? "Built-in" : "Always mpv"}</button>
            ))}
          </div>
        </div>
        {isTauri() && (
          <div className="setting-line">
            <div><strong>mpv location</strong><span className="muted">Leave empty to use the copy bundled with AbixCine or one that's installed. Or paste the path to mpv.exe.</span></div>
            <div className="field-row">
              <input value={mpvPath} onChange={(e) => setMpvPath(e.target.value)} placeholder="C:\Tools\mpv\mpv.exe" aria-label="mpv path" />
              <button className="btn btn-glass sm" onClick={() => { updateSettings({ mpvPath: mpvPath.trim() }); void probeMpv(mpvPath.trim(), true); }}>Check</button>
            </div>
          </div>
        )}
        {mpv && (
          <>
            <div className="setting-line">
              <div><strong>mpv picture</strong><span className="muted">Inside the AbixCine window with AbixCine's controls on top, or in mpv's own window.</span></div>
              <div className="tabs">
                <button className={`chip ${s.mpvWindow === "embedded" ? "on" : ""}`} onClick={() => updateSettings({ mpvWindow: "embedded" })}>Inside AbixCine</button>
                <button className={`chip ${s.mpvWindow === "separate" ? "on" : ""}`} onClick={() => updateSettings({ mpvWindow: "separate" })}>Own window</button>
              </div>
            </div>
            <label className="setting-line toggle">
              <div><strong>Hardware decoding</strong><span className="muted">Smooth 4K with less CPU. Turn off if you ever see green or frozen frames.</span></div>
              <input type="checkbox" className="switch" checked={s.mpvHwdec} onChange={(e) => updateSettings({ mpvHwdec: e.target.checked })} />
            </label>
          </>
        )}
        <label className="setting-line toggle">
          <div><strong>Skip intros automatically</strong><span className="muted">Anime openings and recaps (from AniSkip), and chapters marked as an intro. Off shows a Skip button instead (or press S).</span></div>
          <input type="checkbox" className="switch" checked={s.autoSkipIntro} onChange={(e) => updateSettings({ autoSkipIntro: e.target.checked })} />
        </label>
        <label className="setting-line toggle">
          <div><strong>Autoplay next episode</strong></div>
          <input type="checkbox" className="switch" checked={s.autoplayNext} onChange={(e) => updateSettings({ autoplayNext: e.target.checked })} />
        </label>
        <label className="setting-line toggle">
          <div><strong>Reduce motion</strong><span className="muted">Turns off the intro, page morphs and card tilt.</span></div>
          <input type="checkbox" className="switch" checked={s.reduceMotion} onChange={(e) => updateSettings({ reduceMotion: e.target.checked })} />
        </label>
        <p className="muted kbd-help">Ctrl K anywhere: search and commands · Player: Space · ←/→ 5s · J/L 10s · ↑/↓ volume · M mute · F fullscreen · S skip intro · N next · Esc back</p>
      </section>

      <section className="panel">
        <h2>Notifications</h2>
        <label className="setting-line toggle">
          <div><strong>New episodes and seasons</strong><span className="muted">For shows in My List and Continue watching. Checked every few hours while AbixCine is open. A show you'd finished goes back into Continue watching.</span></div>
          <input type="checkbox" className="switch" checked={s.notifyEpisodes} onChange={(e) => updateSettings({ notifyEpisodes: e.target.checked })} />
        </label>
        <label className="setting-line toggle">
          <div><strong>Windows notifications</strong><span className="muted">Also pop up a notification, not just the bell in the title bar.</span></div>
          <input type="checkbox" className="switch" checked={s.notifyDesktop} disabled={!s.notifyEpisodes} onChange={(e) => updateSettings({ notifyDesktop: e.target.checked })} />
        </label>
        <div className="field-row">
          <button className="btn btn-glass sm" disabled={!s.notifyEpisodes} onClick={() => { setAlertMsg("Checking…"); checkNewEpisodes().then((n) => setAlertMsg(n ? `${n} new` : "Nothing new yet"), () => setAlertMsg("Couldn't check")); }}>Check now</button>
          {alertMsg && <span className="muted">{alertMsg}</span>}
        </div>
      </section>

      <section className="panel" id="updates">
        <h2>Updates</h2>
        <div className="setting-line">
          <div>
            <strong>AbixCine {up.current || "(browser preview)"}</strong>
            <span className="muted">
              {up.status === "checking"
                ? "Checking for updates…"
                : up.status === "available"
                  ? `Version ${up.update?.version} is available.`
                  : up.status === "downloading"
                    ? `Downloading ${up.update?.version}…`
                    : up.status === "ready"
                      ? `${up.update?.version} is downloaded. It installs when you restart.`
                      : up.status === "error"
                        ? `Couldn't check: ${up.error}`
                        : up.status === "none"
                          ? "You're up to date."
                          : "Updates are checked at launch and every 6 hours."}
              {up.lastChecked ? ` Last checked ${fmtAgo(up.lastChecked)}.` : ""}
              {up.current && !up.canInstall && up.status !== "checking" ? " This build can't install updates itself, so new versions open the download page." : ""}
            </span>
          </div>
          <button className="btn btn-glass sm" disabled={up.status === "checking" || !isTauri()} onClick={() => { updateSettings({ skipVersion: "" }); void checkForUpdates(); }}>
            <Icon name="refresh" size={14} /> Check now
          </button>
        </div>
        <label className="setting-line toggle">
          <div><strong>Download updates automatically</strong><span className="muted">They install the next time you restart AbixCine. You always see what's new first.</span></div>
          <input type="checkbox" className="switch" checked={s.autoUpdate} onChange={(e) => updateSettings({ autoUpdate: e.target.checked })} />
        </label>
        {s.skipVersion && (
          <div className="setting-line">
            <div><strong>Skipped {s.skipVersion}</strong><span className="muted">You'll hear about the next version.</span></div>
            <button className="btn btn-glass sm" onClick={() => updateSettings({ skipVersion: "" })}>Undo</button>
          </div>
        )}
        <h3 className="sub-h">Changelog</h3>
        {relErr && <p className="muted">Couldn't load release notes ({relErr}).</p>}
        {releases?.length === 0 && <p className="muted">No releases published yet.</p>}
        <div className="changelog">
          {releases?.slice(0, 10).map((r) => (
            <div key={r.version} className={`rel ${r.version === up.current ? "cur" : ""}`}>
              <button className="rel-head" onClick={() => setOpenRel(openRel === r.version ? null : r.version)} aria-expanded={openRel === r.version}>
                <b>{r.version}</b>
                {r.prerelease && <span className="badge">beta</span>}
                {r.version === up.current && <span className="badge on">installed</span>}
                <span className="muted">{new Date(r.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</span>
                <Icon name={openRel === r.version ? "chevL" : "chevR"} size={14} />
              </button>
              {openRel === r.version && <Notes md={r.notes} />}
            </div>
          ))}
        </div>
        <button className="link-btn" onClick={() => openLink(RELEASES_URL)}><Icon name="arrowUR" size={13} /> All releases on GitHub</button>
      </section>

      <section className="panel">
        <h2>Catalog</h2>
        <p className="muted">
          {tmdbProxy ? "Movies and series come through your AbixCine server, no key needed. " : "Movies and series come from TMDB. "}
          Anime comes from AniList. You can use your own TMDB key instead (themoviedb.org → Settings → API).
        </p>
        <label className="field">
          <span>Personal TMDB key (optional)</span>
          <div className="field-row">
            <input type="password" value={tmdb} onChange={(e) => setTmdb(e.target.value)} placeholder="Paste key" />
            <button className="btn btn-glass sm" onClick={() => updateSettings({ tmdbKey: tmdb.trim() })}>Save</button>
          </div>
        </label>
      </section>
    </div>
  );
}
