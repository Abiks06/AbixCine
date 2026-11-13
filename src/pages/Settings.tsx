import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { AudioToggle } from "../components/AudioToggle";
import { Avatar } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { SubtitleOverlay } from "../components/SubtitleOverlay";
import { errorMessage, getApiBase, leaveGuest, signOut, updateProfile, useAuth } from "../lib/account";
import { loadDebridConfig, saveDebridConfig, type DebridProvider } from "../lib/debrid";
import { toggleSource, updateSettings, useSettings } from "../lib/settings";
import { clearSubtitleSearchCache } from "../lib/subtitleProviders";
import {
  COMMON_SUB_LANGS,
  DEFAULT_SUB_PREF,
  SUB_PREF_EVENT,
  langLabel,
  loadSubPref,
  normalizeSubPref,
  saveSubPref,
  type CueSize,
  type SubBg,
  type SubEdge,
  type SubFont,
  type SubHIFilter,
  type SubMode,
  type SubPref,
  type SubtitleCue,
} from "../lib/subtitles";
import { circuitRemainingMs, getHealth, isCircuitHalfOpen, isCircuitOpen, reliability, resetHealth } from "../sources/health";
import { scanLibrary } from "../sources/local";
import { httpFetch } from "../sources/native";
import {
  installPlugin,
  listPlugins,
  removePlugin,
  togglePlugin,
  validatePluginFetchUrl,
  validatePluginManifest,
  type ProviderPluginManifest,
} from "../sources/pluginRunner";
import { availableSources, clearResolveCache, DIRECT_SOURCES, PROVIDERS } from "../sources/registry";
import {
  addStremioAddon,
  fetchStremioManifest,
  getStremioConfig,
  removeStremioAddon,
  toggleStremioAddon,
  updateStremioConfig,
  type StremioAddonConfig,
} from "../sources/stremio";
import { appVersion, checkForUpdates, installUpdate, useUpdate } from "../lib/updater";

const SUB_COLOR_SWATCHES = [
  { hex: "#ffffff", label: "White" },
  { hex: "#ffe88a", label: "Warm Gold" },
  { hex: "#98f5ff", label: "Cyan" },
  { hex: "#b8ff9e", label: "Mint" },
  { hex: "#e8eefc", label: "Ice Blue" },
] as const;

const PREVIEW_PRIMARY_CUES: SubtitleCue[] = [
  {
    id: "preview-primary",
    start: 0,
    end: 10,
    text: "We'll stay awake until the city lights fade.",
    spans: [
      { text: "We'll stay awake until " },
      { text: "the city lights", italic: true },
      { text: " fade." },
    ],
    align: 2,
  },
];

const PREVIEW_SECONDARY_CUES: SubtitleCue[] = [
  {
    id: "preview-secondary",
    start: 0,
    end: 10,
    text: "街の灯りが消えるまで、起きていよう。",
    spans: [{ text: "街の灯りが消えるまで、起きていよう。" }],
    align: 2,
  },
];

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
  const [healthTick, setHealthTick] = useState(0);
  const enabledProviders = PROVIDERS.filter((p) => p.isEnabled(s));
  const hasOpenCircuit = enabledProviders.some((p) => isCircuitOpen(p.id));
  useEffect(() => {
    if (!hasOpenCircuit) return;
    const t = window.setInterval(() => setHealthTick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, [hasOpenCircuit, healthTick]);
  const formatCooldown = (ms: number) => (ms >= 60_000 ? `${Math.ceil(ms / 60_000)}m` : `${Math.max(1, Math.ceil(ms / 1000))}s`);
  const [subPref, setSubPref] = useState<SubPref>(() =>
    normalizeSubPref({ ...loadSubPref(), ...(s.subtitlePref ?? {}) }),
  );
  const [previewDual, setPreviewDual] = useState(false);
  const upd = useUpdate();
  const [version, setVersion] = useState("");
  const mountedRef = useRef(true);
  const jfCtlRef = useRef<AbortController | null>(null);
  const stremioCtlRef = useRef<AbortController | null>(null);
  const pluginCtlRef = useRef<AbortController | null>(null);

  const [stremioAddons, setStremioAddons] = useState<StremioAddonConfig[]>(() => getStremioConfig().addons);
  const [torrentMode, setTorrentMode] = useState<boolean>(() => Boolean(getStremioConfig().torrentMode));
  const [torrentSupported, setTorrentSupported] = useState(false);
  const [stremioUrl, setStremioUrl] = useState("");
  const [stremioBusy, setStremioBusy] = useState(false);
  const [stremioMsg, setStremioMsg] = useState("");

  const [debridProvider, setDebridProvider] = useState<DebridProvider | "none">(() => {
    const cfg = loadDebridConfig();
    return cfg && cfg.enabled !== false ? cfg.provider : "none";
  });
  const [debridKey, setDebridKey] = useState(() => loadDebridConfig()?.apiKey ?? "");
  const [debridMsg, setDebridMsg] = useState("");

  const [plugins, setPlugins] = useState<ProviderPluginManifest[]>(() => listPlugins());
  const [pluginUrl, setPluginUrl] = useState("");
  const [pluginPaste, setPluginPaste] = useState("");
  const [pluginBusy, setPluginBusy] = useState(false);
  const [pluginMsg, setPluginMsg] = useState("");

  const [subdlKey, setSubdlKey] = useState(s.subdlApiKey ?? "");
  const [subdlMsg, setSubdlMsg] = useState("");

  useEffect(() => {
    mountedRef.current = true;
    void appVersion().then((v) => mountedRef.current && setVersion(v));
    if (isTauri()) {
      void invoke<boolean>("torrent_is_supported")
        .then((ok) => mountedRef.current && setTorrentSupported(Boolean(ok)))
        .catch(() => mountedRef.current && setTorrentSupported(false));
    }
    const syncSub = () => setSubPref(loadSubPref());
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key === "abx.subs.v1") syncSub();
    };
    window.addEventListener(SUB_PREF_EVENT, syncSub);
    window.addEventListener("storage", onStorage);
    return () => {
      mountedRef.current = false;
      jfCtlRef.current?.abort();
      stremioCtlRef.current?.abort();
      pluginCtlRef.current?.abort();
      window.removeEventListener(SUB_PREF_EVENT, syncSub);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useEffect(() => {
    if (s.subtitlePref) {
      setSubPref((prev) => normalizeSubPref({ ...prev, ...s.subtitlePref }));
    }
  }, [s.subtitlePref]);
  useEffect(() => {
    setSubdlKey(s.subdlApiKey ?? "");
  }, [s.subdlApiKey]);

  const refreshStremioState = () => {
    const cfg = getStremioConfig();
    setStremioAddons(cfg.addons);
    setTorrentMode(Boolean(cfg.torrentMode));
  };

  const handleAddStremioAddon = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = stremioUrl.trim();
    if (!raw || stremioBusy) return;
    stremioCtlRef.current?.abort();
    const ctl = new AbortController();
    stremioCtlRef.current = ctl;
    setStremioBusy(true);
    setStremioMsg("Fetching addon manifest...");
    try {
      await fetchStremioManifest(raw, ctl.signal);
      const addon = await addStremioAddon(raw, ctl.signal);
      clearResolveCache();
      if (!mountedRef.current || ctl.signal.aborted) return;
      refreshStremioState();
      setStremioUrl("");
      setStremioMsg(`Added ${addon.name} (v${addon.version})`);
    } catch (err) {
      if (!mountedRef.current || ctl.signal.aborted) return;
      setStremioMsg(err instanceof Error ? err.message : "Could not add Stremio addon");
    } finally {
      if (mountedRef.current) setStremioBusy(false);
    }
  };

  const handleToggleStremioAddon = (addon: StremioAddonConfig, enabled: boolean) => {
    toggleStremioAddon(addon.id, enabled);
    clearResolveCache();
    refreshStremioState();
  };

  const handleRemoveStremioAddon = (addon: StremioAddonConfig) => {
    removeStremioAddon(addon.id);
    clearResolveCache();
    refreshStremioState();
    setStremioMsg(`Removed ${addon.name}`);
  };

  const handleTorrentModeToggle = (enabled: boolean) => {
    updateStremioConfig({ torrentMode: enabled });
    clearResolveCache();
    refreshStremioState();
    setStremioMsg(enabled ? "Torrent P2P mode enabled for Stremio addons." : "Torrent P2P mode disabled.");
  };

  const handleSaveDebrid = (e: React.FormEvent) => {
    e.preventDefault();
    if (debridProvider === "none") {
      saveDebridConfig(null);
      clearResolveCache();
      setDebridMsg("Debrid disabled on this device.");
      return;
    }
    const key = debridKey.trim();
    if (!key) {
      setDebridMsg("Enter your Debrid API key first.");
      return;
    }
    saveDebridConfig({ provider: debridProvider, apiKey: key, enabled: true });
    clearResolveCache();
    setDebridMsg(`Saved ${debridProvider} API key locally.`);
  };

  const handleClearDebrid = () => {
    saveDebridConfig(null);
    clearResolveCache();
    setDebridProvider("none");
    setDebridKey("");
    setDebridMsg("Cleared local Debrid credentials.");
  };

  const buildManifestFromInput = (rawText: string, sourceUrl?: string): ProviderPluginManifest => {
    const trimmed = rawText.trim();
    if (trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const withDefaults: Record<string, unknown> = {
        mediaTypes: ["movie", "tv", "anime"],
        allowedHosts: [],
        enabled: true,
        priority: 30,
        ...parsed,
      };
      if (!withDefaults.script && !withDefaults.scriptUrl && sourceUrl) {
        withDefaults.scriptUrl = sourceUrl;
      }
      return validatePluginManifest(withDefaults);
    }

    const tag = (name: string): string | undefined => {
      const m = trimmed.match(new RegExp(`^\\s*//\\s*@${name}\\s+(.+)$`, "mi"));
      return m?.[1]?.trim() || undefined;
    };
    const slugBase = (tag("id") ?? tag("name") ?? (sourceUrl ? new URL(sourceUrl).hostname.replace(/\./g, "-") : "custom-plugin"))
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    const id = slugBase || `plugin-${Date.now().toString(36)}`;
    const name = tag("name") || id;
    const version = tag("version") || "1.0.0";
    const mediaTypesRaw = (tag("mediaTypes") || "movie,tv,anime")
      .split(/[\s,]+/)
      .map((v) => v.trim().toLowerCase())
      .filter((v): v is "movie" | "tv" | "anime" => v === "movie" || v === "tv" || v === "anime");
    const allowedHosts = (tag("allowedHosts") || "")
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter(Boolean);

    const candidate: Record<string, unknown> = {
      id,
      name,
      version,
      description: tag("description"),
      mediaTypes: mediaTypesRaw.length ? mediaTypesRaw : ["movie", "tv", "anime"],
      allowedHosts,
      script: trimmed,
      enabled: true,
      priority: 30,
    };
    return validatePluginManifest(candidate);
  };

  const handleInstallPluginFromUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = pluginUrl.trim();
    if (!raw || pluginBusy) return;
    let safeUrl: string;
    try {
      safeUrl = validatePluginFetchUrl(raw);
    } catch (err) {
      setPluginMsg(err instanceof Error ? err.message : "Invalid plugin URL");
      return;
    }
    pluginCtlRef.current?.abort();
    const ctl = new AbortController();
    pluginCtlRef.current = ctl;
    setPluginBusy(true);
    setPluginMsg("Fetching plugin...");
    try {
      const res = await httpFetch(safeUrl);
      if (!mountedRef.current || ctl.signal.aborted) return;
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} loading plugin`);
      const manifest = buildManifestFromInput(res.body, safeUrl);
      const installed = installPlugin(manifest);
      clearResolveCache();
      if (!mountedRef.current || ctl.signal.aborted) return;
      setPlugins(listPlugins());
      setPluginUrl("");
      setPluginMsg(`Installed ${installed.name} (v${installed.version})`);
    } catch (err) {
      if (!mountedRef.current || ctl.signal.aborted) return;
      setPluginMsg(err instanceof Error ? err.message : "Could not install plugin from URL");
    } finally {
      if (mountedRef.current) setPluginBusy(false);
    }
  };

  const handleInstallPluginFromPaste = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = pluginPaste.trim();
    if (!raw || pluginBusy) return;
    try {
      const manifest = buildManifestFromInput(raw);
      const installed = installPlugin(manifest);
      clearResolveCache();
      setPlugins(listPlugins());
      setPluginPaste("");
      setPluginMsg(`Installed ${installed.name} (v${installed.version})`);
    } catch (err) {
      setPluginMsg(err instanceof Error ? err.message : "Could not install pasted plugin");
    }
  };

  const handleTogglePlugin = (plugin: ProviderPluginManifest, enabled: boolean) => {
    togglePlugin(plugin.id, enabled);
    clearResolveCache();
    setPlugins(listPlugins());
  };

  const handleRemovePlugin = (plugin: ProviderPluginManifest) => {
    removePlugin(plugin.id);
    clearResolveCache();
    setPlugins(listPlugins());
    setPluginMsg(`Removed ${plugin.name}`);
  };

  const handleSaveSubdlKey = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = subdlKey.trim();
    updateSettings({ subdlApiKey: trimmed || undefined });
    clearSubtitleSearchCache();
    setSubdlMsg(trimmed ? "SubDL API key saved locally." : "SubDL API key cleared.");
  };

  const patchSubPref = (patch: Partial<SubPref>) => {
    const next = saveSubPref({
      ...subPref,
      ...patch,
      ...(patch.mode !== undefined
        ? { on: patch.mode === "on" ? true : patch.mode === "off" ? false : undefined }
        : {}),
    });
    setSubPref(next);
    updateSettings({ subtitlePref: next });
  };
  const resetSubPref = () => {
    const next = saveSubPref(DEFAULT_SUB_PREF);
    setSubPref(next);
    updateSettings({ subtitlePref: next });
  };

  useEffect(() => {
    if (loc.hash === "#sources") sourcesRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loc.hash]);

  const addFolder = async () => {
    try {
      const dir = await open({ directory: true, multiple: false, title: "Add a media folder" });
      if (!mountedRef.current) return;
      if (typeof dir === "string" && !s.libraryPaths.includes(dir)) {
        const paths = [...s.libraryPaths, dir];
        updateSettings({ libraryPaths: paths });
        rescan(paths);
      }
    } catch (e: unknown) {
      if (mountedRef.current) setScan(`Couldn't open folder picker: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const rescan = async (paths = s.libraryPaths) => {
    setScan("Scanning…");
    try {
      const files = await scanLibrary(paths, true);
      if (mountedRef.current) setScan(`${files.length} video files indexed`);
    } catch (e: unknown) {
      if (mountedRef.current) setScan(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const testJellyfin = async () => {
    const snap = jf;
    const base = snap.url.trim().replace(/\/$/, "");
    if (!/^https?:\/\//i.test(base)) {
      setJfTest("Enter an http:// or https:// server address.");
      return;
    }
    jfCtlRef.current?.abort();
    const ctl = new AbortController();
    jfCtlRef.current = ctl;
    setJfTest("Testing…");
    try {
      const r = await fetch(base + "/System/Info", { headers: { "X-Emby-Token": snap.apiKey }, signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!mountedRef.current || ctl.signal.aborted) return;
      setJfTest(`Connected to ${j.ServerName} (v${j.Version})`);
      const next = { ...snap, url: base, enabled: true };
      updateSettings({ jellyfin: next });
      setJf(next);
    } catch (e: unknown) {
      if (!mountedRef.current || ctl.signal.aborted) return;
      setJfTest(`Couldn't connect: ${e instanceof Error ? e.message : String(e)}`);
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
            <button className="avatar-cycle" title="Change color" onClick={() => updateProfile({ avatarHue: (user.avatarHue + 47) % 360 }).catch((e) => mountedRef.current && setProfileMsg(errorMessage(e)))}>
              <Avatar user={user} size={56} />
            </button>
            <div className="account-info">
              <div className="field-row">
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
                <button
                  className="btn btn-glass sm"
                  disabled={!name.trim() || name.trim() === user.name}
                  onClick={() => updateProfile({ name: name.trim() }).then(() => mountedRef.current && setProfileMsg("Saved"), (e) => mountedRef.current && setProfileMsg(errorMessage(e)))}
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
        <h2>Servers</h2>
        <p className="muted">When you press play, AbixCine asks every server at once and plays the fastest good copy. If a stream drops, it moves to the next server and keeps your place. You can always pick a server yourself from the player.</p>

        <div className="source-block primary">
          <div className="source-head">
            <Icon name="layers" />
            <strong>Online servers</strong>
            <span className="badge on">
              {PROVIDERS.filter((p) => p.isEnabled(s)).length} on
            </span>
          </div>
          <p className="muted">
            Direct sources hand AbixCine the stream itself. Online players are opened off-screen and their stream is captured,
            so everything plays in AbixCine's own player with no ads. A server only counts as having a title once its stream is
            found. SUB/DUB servers play anime with the audio you picked.
          </p>
          <div className="field-row" style={{ marginBottom: "12px" }}>
            <button
              className="btn btn-glass sm"
              onClick={() => updateSettings({ disabledSources: [], enabledExtras: availableSources.filter((x) => x.extra).map((x) => x.id) })}
            >
              Enable all
            </button>
            <button
              className="btn btn-glass sm"
              onClick={() => updateSettings({ disabledSources: [...DIRECT_SOURCES.map((x) => x.id), ...availableSources.map((x) => x.id)], enabledExtras: [] })}
            >
              Disable all
            </button>
          </div>
          <div className="source-grid">
            {DIRECT_SOURCES.map((src) => {
              const on = !s.disabledSources?.includes(src.id);
              return (
                <label key={src.id} className={`source-chip-toggle ${on ? "active" : ""}`} title={src.note}>
                  <input type="checkbox" checked={on} onChange={(e) => toggleSource(src.id, e.target.checked)} />
                  <span>{src.name}</span>
                  <small className="badge">DIRECT</small>
                </label>
              );
            })}
            {availableSources.filter((src) => !src.extra).map((src) => {
              const on = !s.disabledSources?.includes(src.id);
              return (
                <label key={src.id} className={`source-chip-toggle ${on ? "active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => toggleSource(src.id, e.target.checked)}
                  />
                  <span>{src.name}</span>
                  {src.isFrench && <small className="badge">FR</small>}
                  {src.urls.anime && <small className="badge" title="Plays anime by AniList id with a real sub/dub switch">SUB/DUB</small>}
                </label>
              );
            })}
          </div>
          <p className="muted extras-note">
            Additional servers: automatically ranked by latency and reliability, with slow or unreachable hosts deprioritized by the circuit breaker.
          </p>
          <div className="source-grid">
            {availableSources.filter((src) => src.extra).map((src) => {
              const on = !s.disabledSources?.includes(src.id) && (s.enabledExtras == null || s.enabledExtras.includes(src.id));
              return (
                <label key={src.id} className={`source-chip-toggle ${on ? "active" : ""}`}>
                  <input type="checkbox" checked={on} onChange={(e) => toggleSource(src.id, e.target.checked, true)} />
                  <span>{src.name}</span>
                  {src.isFrench && <small className="badge">FR</small>}
                  <small className="badge">EXTRA</small>
                </label>
              );
            })}
          </div>
        </div>

        <h3 className="settings-sub">Your own media <span className="muted">optional</span></h3>
        <div className="source-block">
          <div className="source-head"><Icon name="folder" /><strong>Media folders on this PC</strong><span className={`badge ${s.libraryPaths.length ? "on" : ""}`}>{s.libraryPaths.length ? `${s.libraryPaths.length} folder${s.libraryPaths.length > 1 ? "s" : ""}` : "Not set up"}</span></div>
          <p className="muted">Names like “Show S01E02 1080p.mp4”, “Anime - 05 [Dub].mkv” or “Movie (2021).mp4” are matched automatically. Files tagged Dub or Dual Audio show up under the Dub toggle.</p>
          {s.libraryPaths.map((p) => (
            <div key={p} className="path-row">
              <code>{p}</code>
              <button className="icon-btn" aria-label="Remove folder" onClick={() => { setScan(null); updateSettings({ libraryPaths: s.libraryPaths.filter((x) => x !== p) }); }}><Icon name="x" size={14} /></button>
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
              <strong>Server picker</strong>
              <span className="muted">Every source is asked at once. The pick weighs quality, speed, each source's track record and what played this show last time. The rest stay on standby as backup servers.</span>
            </div>
            <button className="btn btn-glass sm" onClick={() => { resetHealth(); setHealthTick((n) => n + 1); }}>Reset history</button>
          </div>
          <div className="health-list">
            {enabledProviders.map((p) => {
              const h = getHealth(p.id);
              const seen = h.ok + h.fail > 0.5;
              const relPct = Math.round(reliability(p.id) * 100);
              const avgLat = h.latencyMs ?? h.latency;
              const open = isCircuitOpen(p.id);
              const remainMs = open ? circuitRemainingMs(p.id) : 0;
              const halfOpen = !open && isCircuitHalfOpen(p.id);
              const hasData = seen || avgLat != null || h.lookupMs != null || open || (h.streak ?? 0) > 0;
              return (
                <div key={p.id} className={`health ${open ? "tripped" : halfOpen ? "half-open" : ""}`}>
                  <div className="health-main">
                    <span className="health-name">{p.name}</span>
                    {open && (
                      <button
                        type="button"
                        className="health-cool"
                        onClick={() => { resetHealth(p.id); setHealthTick((n) => n + 1); }}
                        title={`Reset cooldown and failure streak for ${p.name}`}
                      >
                        Cooldown {formatCooldown(remainMs)} · tap to reset
                      </button>
                    )}
                    {halfOpen && (
                      <span className="health-half" title="Cooldown elapsed; next request tests recovery">
                        Recovering
                      </span>
                    )}
                  </div>
                  <div className="health-right">
                    <span className="health-stats">
                      {seen ? `${relPct}% reliable` : "no history yet"}
                      {avgLat != null ? ` · ~${Math.round(avgLat)} ms` : ""}
                    </span>
                    <button
                      type="button"
                      className="health-reset"
                      disabled={!hasData}
                      onClick={() => { resetHealth(p.id); setHealthTick((n) => n + 1); }}
                      title={`Reset history for ${p.name}`}
                    >
                      Reset
                    </button>
                  </div>
                  <i style={{ ["--w" as any]: `${seen ? relPct : 0}%` }} />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="panel" id="extensions">
        <h2>Addons, Debrid &amp; Plugins</h2>
        <p className="muted">Configure external Stremio addons, Debrid unrestricting, and sandboxed JS providers on this device.</p>

        <div className="source-block">
          <div className="source-head">
            <div>
              <strong>Stremio Addons</strong>
              <p className="muted">Install Stremio HTTP or Debrid-backed addon manifests by URL.</p>
            </div>
            <span className="badge">{stremioAddons.filter((a) => a.enabled).length} active</span>
          </div>

          <form className="field-row" onSubmit={handleAddStremioAddon} style={{ marginTop: 12 }}>
            <input
              type="url"
              value={stremioUrl}
              onChange={(e) => setStremioUrl(e.target.value)}
              placeholder="https://addon.example/manifest.json"
              disabled={stremioBusy}
            />
            <button type="submit" className="btn btn-glass sm" disabled={stremioBusy || !stremioUrl.trim()}>
              <Icon name="plus" size={14} /> {stremioBusy ? "Adding..." : "Add addon"}
            </button>
          </form>
          {stremioMsg && <p className="muted" style={{ marginTop: 8 }}>{stremioMsg}</p>}

          {stremioAddons.length > 0 && (
            <div className="source-grid" style={{ marginTop: 12 }}>
              {stremioAddons.map((addon) => (
                <div className="source-tile" key={addon.id}>
                  <label className="setting-line toggle" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ minWidth: 0 }}>
                      <strong>{addon.name}</strong>
                      <span className="muted">
                        v{addon.version} · {(addon.types ?? []).join(", ") || "streams"}
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={addon.enabled}
                      onChange={(e) => handleToggleStremioAddon(addon, e.target.checked)}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleRemoveStremioAddon(addon)}
                    aria-label={`Remove ${addon.name}`}
                    style={{ marginLeft: 8 }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <label className="setting-line toggle" style={{ marginTop: 14 }}>
            <div>
              <strong>Allow P2P torrent streams</strong>
              <span className="muted">
                {torrentSupported
                  ? "Allow Stremio addons to return magnet streams when Debrid or HTTP is unavailable."
                  : "Requires desktop torrent support (unavailable in this runtime)."}
              </span>
            </div>
            <input
              type="checkbox"
              className="switch"
              checked={torrentMode}
              disabled={!torrentSupported && !torrentMode}
              onChange={(e) => handleTorrentModeToggle(e.target.checked)}
            />
          </label>
        </div>

        <div className="source-block">
          <div className="source-head">
            <div>
              <strong>Debrid</strong>
              <p className="muted">Stored locally on this device only — never synced to your account.</p>
            </div>
            <span className="badge">{debridProvider === "none" ? "Off" : debridProvider}</span>
          </div>

          <form className="field-grid" onSubmit={handleSaveDebrid} style={{ marginTop: 12 }}>
            <label className="field">
              <span>Service</span>
              <select
                className="sub-select"
                value={debridProvider}
                onChange={(e) => {
                  const next = e.target.value as DebridProvider | "none";
                  setDebridProvider(next);
                  setDebridMsg("");
                }}
              >
                <option value="none">None (disabled)</option>
                <option value="realdebrid">Real-Debrid</option>
                <option value="torbox">TorBox</option>
                <option value="alldebrid">AllDebrid</option>
              </select>
            </label>
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                value={debridKey}
                onChange={(e) => setDebridKey(e.target.value)}
                placeholder={debridProvider === "none" ? "Select a Debrid service first" : "Paste your Debrid API key"}
                disabled={debridProvider === "none"}
              />
            </label>
            <div className="btn-row">
              <button type="submit" className="btn btn-glass sm">Save Debrid</button>
              <button type="button" className="btn btn-glass sm" onClick={handleClearDebrid}>Clear</button>
            </div>
            {debridMsg && <p className="muted">{debridMsg}</p>}
          </form>
        </div>

        <div className="source-block">
          <div className="source-head">
            <div>
              <strong>JS Provider Plugins</strong>
              <p className="muted">Install sandboxed JavaScript stream providers from a URL, manifest JSON, or script.</p>
            </div>
            <span className="badge">{plugins.filter((p) => p.enabled).length} active</span>
          </div>

          <form className="field-row" onSubmit={handleInstallPluginFromUrl} style={{ marginTop: 12 }}>
            <input
              type="url"
              value={pluginUrl}
              onChange={(e) => setPluginUrl(e.target.value)}
              placeholder="https://example.com/plugin.json or plugin.js"
              disabled={pluginBusy}
            />
            <button type="submit" className="btn btn-glass sm" disabled={pluginBusy || !pluginUrl.trim()}>
              <Icon name="link" size={14} /> {pluginBusy ? "Installing..." : "Install URL"}
            </button>
          </form>

          <form onSubmit={handleInstallPluginFromPaste} style={{ marginTop: 10 }}>
            <textarea
              value={pluginPaste}
              onChange={(e) => setPluginPaste(e.target.value)}
              placeholder='Paste JSON manifest or JS script (optional headers: // @id my-plugin, // @name My Plugin)'
              rows={4}
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: 11,
                background: "rgba(0, 0, 0, 0.35)",
                border: "1px solid var(--line-2)",
                color: "var(--fg)",
                fontFamily: "monospace",
                fontSize: 12,
                resize: "vertical",
              }}
            />
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button type="submit" className="btn btn-glass sm" disabled={pluginBusy || !pluginPaste.trim()}>
                <Icon name="plus" size={14} /> Install pasted plugin
              </button>
            </div>
          </form>
          {pluginMsg && <p className="muted" style={{ marginTop: 8 }}>{pluginMsg}</p>}

          {plugins.length > 0 && (
            <div className="source-grid" style={{ marginTop: 12 }}>
              {plugins.map((plugin) => (
                <div className="source-tile" key={plugin.id}>
                  <label className="setting-line toggle" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ minWidth: 0 }}>
                      <strong>{plugin.name}</strong>
                      <span className="muted">
                        v{plugin.version} · {plugin.mediaTypes.join(", ")}
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={plugin.enabled}
                      onChange={(e) => handleTogglePlugin(plugin, e.target.checked)}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => handleRemovePlugin(plugin)}
                    aria-label={`Remove ${plugin.name}`}
                    style={{ marginLeft: 8 }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
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
        <p className="muted kbd-help">Ctrl K or / anywhere: search and commands · Player: Space · ←/→ 5s (Shift 30s) · J/L 10s · 0–9 jump · ↑/↓ or wheel volume · M mute · &lt; &gt; speed · C subtitles (Shift + C cycle) · [ ] subtitle timing (Shift ±0.1s) · S servers · E episodes · F fullscreen · P picture-in-picture · N next · ? all shortcuts · Esc back</p>
      </section>

      <section className="panel" id="subtitles">
        <div className="sub-sheet-head-row" style={{ marginBottom: 6 }}>
          <h2>Subtitles</h2>
          <button className="btn btn-glass sm" onClick={resetSubPref}>
            <Icon name="refresh" size={14} /> Reset to Defaults
          </button>
        </div>
        <p className="muted">Configure default language matching, online subtitle auto-fetch, dual subtitles, and cinema typography across every source.</p>

        <div className="sub-preview-stage" aria-label="Live subtitle preview">
          <div className="sub-preview-bg" aria-hidden />
          <div className="sub-preview-bar">
            <span className="sub-preview-badge">Live Preview</span>
            <button
              className={`chip ${previewDual || !!subPref.secondaryLang ? "on" : ""}`}
              onClick={() => setPreviewDual((x) => !x)}
            >
              <Icon name="dual" size={13} /> {previewDual || subPref.secondaryLang ? "Dual on" : "Preview dual"}
            </button>
          </div>
          <SubtitleOverlay
            preview
            cues={PREVIEW_PRIMARY_CUES}
            secondaryCues={previewDual || subPref.secondaryLang ? PREVIEW_SECONDARY_CUES : undefined}
            subPref={subPref}
            controlsVisible={false}
          />
        </div>

        <div className="setting-line">
          <div>
            <strong>Default mode</strong>
            <span className="muted">Auto turns subtitles on for foreign-language audio and subbed anime.</span>
          </div>
          <div className="sub-seg">
            {(
              [
                { id: "auto", label: "Auto" },
                { id: "on", label: "Always On" },
                { id: "off", label: "Always Off" },
              ] as { id: SubMode; label: string }[]
            ).map((m) => (
              <button key={m.id} className={subPref.mode === m.id ? "on" : ""} onClick={() => patchSubPref({ mode: m.id })}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-line">
          <div>
            <strong>Primary language</strong>
            <span className="muted">Preferred track and default online search language.</span>
          </div>
          <select
            className="sub-select"
            aria-label="Primary subtitle language"
            value={subPref.lang}
            onChange={(e) => patchSubPref({ lang: e.target.value })}
          >
            {subPref.lang && !COMMON_SUB_LANGS.some((l) => l.code === subPref.lang) && (
              <option value={subPref.lang}>{langLabel(subPref.lang)}</option>
            )}
            {COMMON_SUB_LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        <div className="setting-line">
          <div>
            <strong>Secondary (dual) language</strong>
            <span className="muted">Optional second track displayed at top-center for bilingual viewing.</span>
          </div>
          <select
            className="sub-select"
            aria-label="Secondary subtitle language"
            value={subPref.secondaryLang}
            onChange={(e) => patchSubPref({ secondaryLang: e.target.value })}
          >
            <option value="">Off</option>
            {subPref.secondaryLang && !COMMON_SUB_LANGS.some((l) => l.code === subPref.secondaryLang) && (
              <option value={subPref.secondaryLang}>{langLabel(subPref.secondaryLang)}</option>
            )}
            {COMMON_SUB_LANGS.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        <div className="setting-line">
          <div>
            <strong>Hearing impaired (SDH)</strong>
            <span className="muted">Preference when picking embedded, sidecar, or online tracks.</span>
          </div>
          <div className="sub-seg">
            {(
              [
                { id: "any", label: "Any" },
                { id: "avoid", label: "Avoid SDH" },
                { id: "prefer", label: "Prefer SDH" },
              ] as { id: SubHIFilter; label: string }[]
            ).map((f) => (
              <button
                key={f.id}
                className={subPref.preferHearingImpaired === f.id ? "on" : ""}
                onClick={() => patchSubPref({ preferHearingImpaired: f.id })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <label className="setting-line toggle">
          <div>
            <strong>Auto-fetch online subtitles</strong>
            <span className="muted">Search Wyzie, OpenSubtitles &amp; SubDL automatically when no track matches your primary language.</span>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={subPref.autoFetchOnline}
            onChange={(e) => patchSubPref({ autoFetchOnline: e.target.checked })}
          />
        </label>

        <form className="field" onSubmit={handleSaveSubdlKey} style={{ marginTop: 14 }}>
          <span>SubDL API key (optional · device-only)</span>
          <div className="field-row">
            <input
              type="password"
              value={subdlKey}
              onChange={(e) => setSubdlKey(e.target.value)}
              placeholder="Paste your SubDL API key"
            />
            <button type="submit" className="btn btn-glass sm">Save</button>
            <button
              type="button"
              className="btn btn-glass sm"
              onClick={() => {
                setSubdlKey("");
                updateSettings({ subdlApiKey: undefined });
                clearSubtitleSearchCache();
                setSubdlMsg("SubDL API key cleared.");
              }}
            >
              Clear
            </button>
          </div>
          {subdlMsg && <span className="muted">{subdlMsg}</span>}
        </form>

        <div className="setting-line">
          <div><strong>Font size</strong></div>
          <div className="sub-seg">
            {(["xs", "s", "m", "l", "xl"] as CueSize[]).map((sz) => (
              <button key={sz} className={subPref.size === sz ? "on" : ""} onClick={() => patchSubPref({ size: sz })}>
                {sz.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-line">
          <div><strong>Font family</strong></div>
          <div className="sub-seg">
            {(
              [
                { id: "sans", label: "Sans" },
                { id: "serif", label: "Serif" },
                { id: "mono", label: "Mono" },
                { id: "rounded", label: "Rounded" },
              ] as { id: SubFont; label: string }[]
            ).map((fn) => (
              <button key={fn.id} className={subPref.font === fn.id ? "on" : ""} onClick={() => patchSubPref({ font: fn.id })}>
                {fn.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-line">
          <div><strong>Text color</strong></div>
          <div className="sub-swatches" role="radiogroup" aria-label="Subtitle text color">
            {SUB_COLOR_SWATCHES.map((sw) => (
              <button
                key={sw.hex}
                type="button"
                role="radio"
                aria-checked={subPref.color.toLowerCase() === sw.hex}
                aria-label={sw.label}
                title={sw.label}
                className={`sub-swatch ${subPref.color.toLowerCase() === sw.hex ? "on" : ""}`}
                style={{ backgroundColor: sw.hex }}
                onClick={() => patchSubPref({ color: sw.hex })}
              />
            ))}
          </div>
        </div>

        <div className="setting-line">
          <div><strong>Background</strong></div>
          <div className="sub-seg">
            {(
              [
                { id: "glass", label: "Glass" },
                { id: "box", label: "Box" },
                { id: "none", label: "None" },
              ] as { id: SubBg; label: string }[]
            ).map((bg) => (
              <button key={bg.id} className={subPref.bg === bg.id ? "on" : ""} onClick={() => patchSubPref({ bg: bg.id })}>
                {bg.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-line">
          <div>
            <strong>Background opacity</strong>
            <span className="muted">Applies to Glass and Box styles.</span>
          </div>
          <div className="sub-range-ctrl">
            <input
              type="range"
              aria-label="Subtitle background opacity"
              min={0}
              max={1}
              step={0.05}
              disabled={subPref.bg === "none"}
              value={subPref.bgOpacity}
              onChange={(e) => patchSubPref({ bgOpacity: Number(e.target.value) })}
            />
            <code>{Math.round(subPref.bgOpacity * 100)}%</code>
          </div>
        </div>

        <div className="setting-line">
          <div><strong>Text edge</strong></div>
          <div className="sub-seg">
            {(
              [
                { id: "shadow", label: "Shadow" },
                { id: "outline", label: "Outline" },
                { id: "raised", label: "Raised" },
                { id: "none", label: "None" },
              ] as { id: SubEdge; label: string }[]
            ).map((edge) => (
              <button key={edge.id} className={subPref.edge === edge.id ? "on" : ""} onClick={() => patchSubPref({ edge: edge.id })}>
                {edge.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-line">
          <div>
            <strong>Bottom offset</strong>
            <span className="muted">Vertical margin when player controls are hidden.</span>
          </div>
          <div className="sub-range-ctrl">
            <input
              type="range"
              aria-label="Subtitle bottom offset"
              min={2}
              max={45}
              step={1}
              value={subPref.bottomPct}
              onChange={(e) => patchSubPref({ bottomPct: Number(e.target.value) })}
            />
            <code>{subPref.bottomPct}%</code>
          </div>
        </div>

        <div className="setting-line">
          <div><strong>Line height</strong></div>
          <div className="sub-range-ctrl">
            <input
              type="range"
              aria-label="Subtitle line height"
              min={1}
              max={2.2}
              step={0.05}
              value={subPref.lineHeight}
              onChange={(e) => patchSubPref({ lineHeight: Number(e.target.value) })}
            />
            <code>{subPref.lineHeight.toFixed(2)}</code>
          </div>
        </div>
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
      <section className="panel">
        <h2>About</h2>
        <div className="setting-line">
          <div>
            <strong>AbixCine {version}</strong>
            <span className="muted">
              {upd.status === "checking" ? "Checking for updates…"
                : upd.status === "current" ? "You're on the latest version."
                : upd.status === "available" ? `Version ${upd.version} is available.`
                : upd.status === "downloading" ? `Downloading ${upd.version}… ${Math.round(upd.progress * 100)}%`
                : upd.status === "ready" ? "Installing, AbixCine will restart."
                : upd.status === "error" ? `Couldn't check for updates: ${upd.message}`
                : upd.status === "unsupported" ? "Updates install automatically in the desktop app."
                : "Updates are checked automatically when the app starts."}
            </span>
          </div>
          {upd.status === "available" ? (
            <button className="btn btn-ion sm" onClick={installUpdate}>Update and restart</button>
          ) : (
            <button className="btn btn-glass sm" disabled={upd.status === "unsupported" || upd.status === "checking" || upd.status === "downloading"} onClick={() => checkForUpdates()}>
              <Icon name="refresh" size={14} /> Check for updates
            </button>
          )}
        </div>
        <p className="muted">Picture enhancement uses <a href="https://github.com/bloc97/Anime4K" target="_blank" rel="noreferrer">Anime4K</a> by bloc97 (MIT), through its WebGPU port.</p>
      </section>
    </div>
  );
}
