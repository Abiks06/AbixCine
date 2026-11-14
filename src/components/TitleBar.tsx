import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { leaveGuest, signOut, useAuth } from "../lib/account";
import { useSettings, type Settings } from "../lib/settings";
import { availableSources } from "../sources/embeds";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { LogoMark, Wordmark } from "./Logo";

/** Last folder name of a path, e.g. "D:\\Media" stays "D:\\Media", "C:\\Users\\me\\Videos" becomes "Videos". */
export const folderLabel = (p: string) => {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length <= 2 ? p.replace(/[\\/]+$/, "") : parts[parts.length - 1];
};

const NAV = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/movies", label: "Films", icon: "film" },
  { to: "/series", label: "Series", icon: "tv" },
  { to: "/anime", label: "Anime", icon: "spark" },
  { to: "/library", label: "Your drive", icon: "drive" },
  { to: "/list", label: "My List", icon: "bookmark" },
];

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
    import("../sources/registry")
      .then((r) => live && setExact(r.PROVIDERS.filter((p) => p.isEnabled(s)).length))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [s]);
  return exact ?? quick;
}

/**
 * One bar for the whole shell: brand, a floating dock whose lit pill slides to the current
 * section, search, live server status, the account and the window buttons. Empty stretches of
 * the bar drag the (borderless) window.
 */
export function TitleBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { user } = useAuth();
  const s = useSettings();
  const [menu, setMenu] = useState(false);
  const w = useMemo(() => (isTauri() ? getCurrentWindow() : null), []);

  // The pill: measured from the active link, re-measured when the dock reflows (labels collapse on narrow windows).
  const dock = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const place = () => {
      const a = el.querySelector<HTMLElement>("a.active");
      setPill((p) => {
        const next = a ? { x: a.offsetLeft, w: a.offsetWidth } : null;
        return p?.x === next?.x && p?.w === next?.w ? p : next;
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    el.querySelectorAll("a").forEach((a) => ro.observe(a));
    return () => ro.disconnect();
  }, [loc.pathname]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const online = useServerCount(s);
  const own = s.libraryPaths.length + (s.jellyfin.enabled ? 1 : 0);
  const ready = online + own > 0;
  const status = ready ? [online ? `${online} server${online > 1 ? "s" : ""}` : null, own ? `${own} local` : null].filter(Boolean).join(" · ") : "Servers off";
  const go = (to: string) => {
    setMenu(false);
    nav(to, { viewTransition: true });
  };

  return (
    <header className="top" data-tauri-drag-region onDoubleClick={(e) => (e.target as HTMLElement).hasAttribute("data-tauri-drag-region") && w?.toggleMaximize()}>
      <Link to="/" className="brand" viewTransition aria-label="AbixCine home">
        <LogoMark size={28} />
        <Wordmark />
      </Link>

      <nav className="dock" ref={dock} aria-label="Sections">
        <span className="dock-pill" style={pill ? { transform: `translateX(${pill.x}px)`, width: pill.w } : { opacity: 0, width: 0 }} />
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} className="dock-link" aria-label={n.label} title={n.label} viewTransition>
            <Icon name={n.icon} size={17} />
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="top-end" data-tauri-drag-region>
        <button className="top-search" onClick={onOpenPalette} aria-label="Search and commands">
          <Icon name="search" size={15} />
          <span>Search</span>
          <span className="keys"><kbd>Ctrl</kbd><kbd>K</kbd></span>
        </button>
        <Link to="/settings#sources" className={`status ${ready ? "" : "off"}`} title={ready ? "Servers that answer when you press play" : "Every server is switched off"} viewTransition>
          <i className="dot" />
          <span>{status}</span>
        </Link>
        <NavLink to="/settings" className="top-icon" aria-label="Settings" title="Settings" viewTransition>
          <Icon name="gear" size={17} />
        </NavLink>
        {user ? (
          <div className="menu-wrap">
            <button className="avatar-btn" onClick={() => setMenu((m) => !m)} aria-label="Account" aria-haspopup="menu" aria-expanded={menu}>
              <Avatar user={user} size={30} />
            </button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="menu" role="menu">
                  <div className="menu-head">
                    <Avatar user={user} size={40} />
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
          <button className="btn glass sm" onClick={leaveGuest}>Sign in</button>
        )}
        {w ? (
          <div className="win">
            <button aria-label="Minimize" onClick={() => w.minimize()}><Icon name="min" size={14} /></button>
            <button aria-label="Maximize" onClick={() => w.toggleMaximize()}><Icon name="max" size={12} /></button>
            <button aria-label="Close" className="close" onClick={() => w.close()}><Icon name="x" size={14} /></button>
          </div>
        ) : (
          <span style={{ width: 14 }} />
        )}
      </div>
    </header>
  );
}
