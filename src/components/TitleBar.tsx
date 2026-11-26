import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { leaveGuest, signOut, useAuth } from "../lib/account";
import { useDownloadBadgeState } from "../lib/downloads";
import { useOnlineStatus } from "../lib/online";
import { updateSettings, useSettings, type Settings } from "../lib/settings";
import { THEMES, resolveTheme } from "../lib/themes";
import { availableSources } from "../sources/embeds";
import { Avatar } from "./Avatar";
import { DownloadsPopover } from "./DownloadsPopover";
import { Icon } from "./Icon";
import { LogoMark, Wordmark } from "./Logo";

/** Last folder name of a path, e.g. "D:\\Media" stays "D:\\Media", "C:\\Users\\me\\Videos" becomes "Videos". */
export const folderLabel = (p: string) => {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length <= 2 ? p.replace(/[\\/]+$/, "") : parts[parts.length - 1];
};

const NAV = [
  { to: "/", code: "01", label: "Home", full: "Programme", icon: "home" },
  { to: "/movies", code: "02", label: "Films", full: "Films", icon: "film" },
  { to: "/series", code: "03", label: "Series", full: "Series", icon: "tv" },
  { to: "/anime", code: "04", label: "Anime", full: "Anime", icon: "spark" },
  { to: "/library", code: "05", label: "Vault", full: "Vault", icon: "drive" },
  { to: "/list", code: "06", label: "List", full: "My List", icon: "bookmark" },
] as const;

function routeEdition(path: string): string {
  if (path === "/") return "PROGRAMME";
  if (path.startsWith("/movies")) return "FILMS · CATALOG";
  if (path.startsWith("/series")) return "SERIES · INDEX";
  if (path.startsWith("/anime")) return "ANIME · SIMULCAST";
  if (path.startsWith("/library")) return "VAULT · LOCAL FIRST";
  if (path.startsWith("/list")) return "MY LIST";
  if (path.startsWith("/search")) return "ARCHIVE SEARCH";
  if (path.startsWith("/settings")) return "PROJECTION CONSOLE";
  if (path.startsWith("/title/")) return "FILM MONOGRAPH";
  return "ABIXCINE";
}

function fmtClock(d: Date) {
  const day = d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} ${time}`;
}

/**
 * How many servers will answer a Play press. The registry (every extractor) is a large module the
 * shell shouldn't pull into the startup bundle, so it is counted lazily; until it arrives the
 * embed list gives a close first answer. Settings shows the same number from the same rule.
 */
function useServerCount(s: Settings) {
  const quick = availableSources.filter((x) => !s.disabledSources?.includes(x.id) && (!x.extra || s.enabledExtras == null || s.enabledExtras.includes(x.id))).length;
  const [exact, setExact] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const count = () =>
      import("../sources/registry")
        .then((r) => live && setExact(r.PROVIDERS.filter((p) => p.isEnabled(s)).length))
        .catch(() => {});
    if (exact !== null) {
      void count();
      return () => {
        live = false;
      };
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    const idle = w.requestIdleCallback ? w.requestIdleCallback(() => void count(), { timeout: 5000 }) : undefined;
    const timer = idle === undefined ? window.setTimeout(() => void count(), 3000) : undefined;
    return () => {
      live = false;
      if (idle !== undefined) w.cancelIdleCallback?.(idle);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  return exact ?? quick;
}

const appWindow = () => (isTauri() ? getCurrentWindow() : null);
const showWindowButtons = () => isTauri() || (import.meta.env.DEV && location.search.includes("preview"));

/** Minimise / maximise / close for the borderless window. Shared by the utility bar and sign-in. */
export function WindowButtons() {
  const w = useMemo(appWindow, []);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!w) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let timer: number | undefined;

    const sync = () => {
      void w
        .isMaximized()
        .then((m) => {
          if (!cancelled) setMaximized(m);
        })
        .catch(() => {});
    };

    sync();
    void w
      .onResized(() => {
        window.clearTimeout(timer);
        timer = window.setTimeout(sync, 60);
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unlisten?.();
    };
  }, [w]);

  if (!showWindowButtons()) return null;
  return (
    <div className="win">
      <button aria-label="Minimize" onClick={() => w?.minimize()}><Icon name="min" size={14} /></button>
      <button
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        aria-pressed={maximized}
        onClick={() => w?.toggleMaximize()}
      >
        <Icon name="max" size={12} />
      </button>
      <button aria-label="Close" className="close" onClick={() => w?.close()}><Icon name="x" size={14} /></button>
    </div>
  );
}

/**
 * Desktop Projection Shell:
 *   1. Left Architectural Index Rail (68px): aperture mark, numbered section switches (01–06),
 *      server status telemetry, settings, and account console.
 *   2. Top 40px Hairline Utility & Drag Bar: edition stamp, live evening clock, server readiness,
 *      instant Command Indexer trigger, and native Tauri window controls.
 */
export function TitleBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { user } = useAuth();
  const s = useSettings();
  const isOnline = useOnlineStatus();
  const [activePop, setActivePop] = useState<"menu" | "themes" | "downloads" | null>(null);
  const menu = activePop === "menu";
  const themesOpen = activePop === "themes";
  const downloadsOpen = activePop === "downloads";
  const setMenu = (next: boolean | ((v: boolean) => boolean)) =>
    setActivePop((cur) => {
      const want = typeof next === "function" ? next(cur === "menu") : next;
      return want ? "menu" : cur === "menu" ? null : cur;
    });
  const setThemesOpen = (next: boolean | ((v: boolean) => boolean)) =>
    setActivePop((cur) => {
      const want = typeof next === "function" ? next(cur === "themes") : next;
      return want ? "themes" : cur === "themes" ? null : cur;
    });
  const [now, setNow] = useState(() => new Date());
  const w = useMemo(appWindow, []);
  const showWin = showWindowButtons();
  const activeTheme = resolveTheme(s.theme);
  const dynamicLight = s.dynamicLight !== false;

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!activePop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActivePop(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activePop]);

  const online = useServerCount(s);
  const { active: activeDownloads, awaiting: awaitingDownloads } = useDownloadBadgeState();
  const own = s.libraryPaths.length + (s.downloadsPath ? 1 : 0) + (s.jellyfin.enabled ? 1 : 0);
  const ready = isOnline ? online + own > 0 : own > 0;
  const status = !isOnline
    ? own > 0
      ? "OFFLINE · LOCAL VAULT"
      : "OFFLINE"
    : ready
      ? [online ? `${online} SERVER${online > 1 ? "S" : ""}` : null, own ? `${own} LOCAL` : null].filter(Boolean).join(" · ")
      : "SERVERS OFF";
  const go = (to: string) => {
    setActivePop(null);
    nav(to, { viewTransition: true });
  };

  return (
    <>
      <aside className="rail" aria-label="Primary navigation">
        <Link to="/" className="rail-brand" viewTransition aria-label="AbixCine home" title="AbixCine">
          <LogoMark size={28} />
        </Link>

        <nav className="rail-nav" aria-label="Sections">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className="rail-link"
              aria-label={n.full}
              title={`${n.code} · ${n.full}`}
              viewTransition
            >
              <span className="rail-idx">{n.code}</span>
              <Icon name={n.icon} size={16} />
              <span className="rail-lbl">{n.label}</span>
              {n.to === "/library" && (activeDownloads > 0 || awaitingDownloads > 0) && (
                <span
                  className={`rail-badge ${activeDownloads === 0 && awaitingDownloads > 0 ? "warn" : ""}`}
                  aria-label={
                    activeDownloads > 0
                      ? `${activeDownloads} active download${activeDownloads === 1 ? "" : "s"}`
                      : `${awaitingDownloads} download${awaitingDownloads === 1 ? "" : "s"} awaiting quality choice`
                  }
                  title={
                    activeDownloads > 0
                      ? `${activeDownloads} active download${activeDownloads === 1 ? "" : "s"}`
                      : `${awaitingDownloads} download${awaitingDownloads === 1 ? "" : "s"} awaiting quality choice`
                  }
                >
                  {(() => {
                    const count = activeDownloads > 0 ? activeDownloads : awaitingDownloads;
                    return count > 99 ? "99+" : count;
                  })()}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="rail-foot">
          <Link
            to="/settings#sources"
            className={`rail-status ${ready ? "" : "off"}`}
            title={ready ? `${status} — configure sources` : "Every server is switched off"}
            viewTransition
          >
            <i className="dot" />
            <span>{online + own}</span>
          </Link>
          <NavLink to="/settings" className="rail-icon" aria-label="Settings" title="Settings" viewTransition>
            <Icon name="gear" size={17} />
          </NavLink>
          {user ? (
            <div className="menu-wrap">
              <button
                className="avatar-btn"
                onClick={() => {
                  setMenu((m) => !m);
                  setThemesOpen(false);
                }}
                aria-label="Account"
                aria-haspopup="menu"
                aria-expanded={menu}
              >
                <Avatar user={user} size={30} />
              </button>
              {menu && (
                <>
                  <div className="menu-scrim" onClick={() => setMenu(false)} />
                  <div className="menu" role="menu">
                    <div className="menu-head">
                      <Avatar user={user} size={38} />
                      <div>
                        <strong>{user.name}</strong>
                        <span>{user.email}</span>
                      </div>
                    </div>
                    <button role="menuitem" onClick={() => go("/list")}><Icon name="bookmark" size={16} /> My List</button>
                    <button role="menuitem" onClick={() => go("/settings")}><Icon name="gear" size={16} /> Settings</button>
                    <button role="menuitem" onClick={() => { setMenu(false); void signOut(); }}><Icon name="logout" size={16} /> Sign out</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button className="rail-signin" onClick={leaveGuest} title="Sign in" aria-label="Sign in">
              <Icon name="user" size={16} />
            </button>
          )}
        </div>
      </aside>

      <header
        className="topbar"
        data-tauri-drag-region
        onDoubleClick={(e) => (e.target as HTMLElement).hasAttribute("data-tauri-drag-region") && w?.toggleMaximize()}
      >
        <div className="topbar-left" data-tauri-drag-region>
          <Link to="/" viewTransition aria-label="AbixCine">
            <Wordmark />
          </Link>
          <span className="topbar-sep" />
          <span className="topbar-edition">{routeEdition(loc.pathname)}</span>
          {!isOnline && (
            <Link
              to="/library"
              className="topbar-offline"
              title="No internet connection — local files and Downloads Vault still play"
              viewTransition
            >
              <i aria-hidden /> OFFLINE
            </Link>
          )}
          <span className="topbar-meta">
            <span>·</span>
            <span>{fmtClock(now)}</span>
            <span>·</span>
            <Link to="/settings#sources" className={`topbar-status ${ready ? "" : "off"}`} viewTransition>
              <i className="dot" />
              <span>{status}</span>
            </Link>
          </span>
        </div>

        <div className="topbar-right" data-tauri-drag-region>
          <DownloadsPopover
            open={downloadsOpen}
            onOpenChange={(next) => setActivePop((cur) => (next ? "downloads" : cur === "downloads" ? null : cur))}
          />
          <div className="theme-studio">
            <button
              type="button"
              className={`topbar-theme ${themesOpen ? "on" : ""}`}
              onClick={() => {
                setThemesOpen((o) => !o);
                setMenu(false);
              }}
              aria-haspopup="dialog"
              aria-expanded={themesOpen}
              aria-label="Theme studio"
              title="Color theme & ambient lighting"
            >
              <i className="tt-dot" aria-hidden />
              <Icon name="palette" size={14} />
            </button>
            {themesOpen && (
              <>
                <div className="menu-scrim" onClick={() => setThemesOpen(false)} />
                <div className="theme-popover" role="dialog" aria-label="Color theme studio">
                  <div className="tp-pop-head">
                    <span>ARCHIVE THEME</span>
                    <button type="button" className="link-btn" onClick={() => go("/settings#appearance")}>
                      All options
                    </button>
                  </div>
                  <div className="tp-pop-list">
                    {THEMES.map((t) => {
                      const on = activeTheme === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className={`theme-opt ${on ? "on" : ""}`}
                          onClick={() => updateSettings({ theme: t.id })}
                        >
                          <span className="theme-dots" aria-hidden>
                            <i style={{ background: t.swatches[0] }} />
                            <i style={{ background: t.swatches[1] }} />
                            <i style={{ background: t.swatches[2] }} />
                          </span>
                          <span className="theme-copy">
                            <strong>{t.name}</strong>
                            <small>{t.tagline}</small>
                          </span>
                          {on && <Icon name="check" size={14} className="theme-chk" />}
                        </button>
                      );
                    })}
                  </div>
                  <label className="theme-dyn">
                    <span>Dynamic poster accent</span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={dynamicLight}
                      onChange={(e) => updateSettings({ dynamicLight: e.target.checked })}
                    />
                  </label>
                </div>
              </>
            )}
          </div>
          <button className="topbar-search" onClick={onOpenPalette} aria-label="Search and commands">
            <Icon name="search" size={14} />
            <span>Search or jump…</span>
            <span className="keys"><kbd>Ctrl</kbd><kbd>K</kbd></span>
          </button>
          {showWin ? <WindowButtons /> : <span style={{ width: 14 }} />}
        </div>
      </header>
    </>
  );
}
