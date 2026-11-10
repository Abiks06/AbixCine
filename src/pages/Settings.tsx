import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { AudioToggle } from "../components/AudioToggle";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { errorMessage, getApiBase, signOut, updateProfile, useAuth } from "../lib/account";
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

      {user && (
        <section className="panel">
          <h2>Account</h2>
          <div className="account-row">
            <button className="avatar-cycle" title="Change color" onClick={() => updateProfile({ avatarHue: (user.avatarHue + 47) % 360 })}>
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
              <span className="muted">{user.email} · {online ? "synced" : "offline, will sync when back"} · {getApiBase().replace(/^https?:\/\//, "")}</span>
              {profileMsg && <span className="muted">{profileMsg}</span>}
            </div>
            <button className="btn btn-glass sm" onClick={signOut}><Icon name="logout" size={15} /> Sign out</button>
          </div>
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
        <label className="setting-line toggle">
          <div><strong>Autoplay next episode</strong></div>
          <input type="checkbox" className="switch" checked={s.autoplayNext} onChange={(e) => updateSettings({ autoplayNext: e.target.checked })} />
        </label>
        <label className="setting-line toggle">
          <div><strong>Reduce motion</strong><span className="muted">Turns off the intro, page morphs and card tilt.</span></div>
          <input type="checkbox" className="switch" checked={s.reduceMotion} onChange={(e) => updateSettings({ reduceMotion: e.target.checked })} />
        </label>
        <p className="muted kbd-help">Ctrl K anywhere: search and commands · Player: Space · ←/→ 5s · J/L 10s · ↑/↓ volume · M mute · F fullscreen · N next · Esc back</p>
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
