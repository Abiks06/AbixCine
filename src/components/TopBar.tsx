import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { signOut, useAuth } from "../lib/account";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { LogoMark, Wordmark } from "./Logo";

const NAV = [
  { to: "/", label: "Home" },
  { to: "/movies", label: "Movies" },
  { to: "/series", label: "Series" },
  { to: "/anime", label: "Anime" },
  { to: "/list", label: "My List" },
];

/**
 * Floating top bar: brand left, a pill nav with a sliding light indicator in the middle,
 * search/command + account right. The whole bar drags the frameless window.
 */
export function TopBar({ onOpenPalette, scrolled }: { onOpenPalette: () => void; scrolled: boolean }) {
  const loc = useLocation();
  const nav = useNavigate();
  const { user } = useAuth();
  const pill = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const w = isTauri() ? getCurrentWindow() : null;

  // Slide the indicator under the active tab.
  useLayoutEffect(() => {
    const el = pill.current?.querySelector<HTMLElement>("a.active");
    if (!el || !pill.current) return setInd(null);
    const p = pill.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setInd({ x: r.left - p.left, w: r.width });
  }, [loc.pathname]);

  return (
    <header className={`topbar ${scrolled ? "scrolled" : ""}`} data-tauri-drag-region onDoubleClick={(e) => e.target === e.currentTarget && w?.toggleMaximize()}>
      <Link to="/" className="brand" viewTransition>
        <LogoMark size={26} />
        <Wordmark />
      </Link>

      <nav className="pill-nav" ref={pill} aria-label="Main">
        {ind && <span className="pill-ind" style={{ transform: `translateX(${ind.x}px)`, width: ind.w }} />}
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} viewTransition>
            {n.label}
          </NavLink>
        ))}
      </nav>

      <div className="top-actions">
        <button className="cmd-btn" onClick={onOpenPalette} aria-label="Search and commands">
          <Icon name="search" size={16} />
          <span>Search</span>
          <kbd>Ctrl K</kbd>
        </button>
        {user && (
          <div className="menu-wrap">
            <button className="avatar-btn" onClick={() => setMenu((m) => !m)} aria-label="Account">
              <Avatar user={user} size={32} />
            </button>
            {menu && (
              <>
                <div className="menu-scrim" onClick={() => setMenu(false)} />
                <div className="menu">
                  <div className="menu-head">
                    <Avatar user={user} size={40} />
                    <div>
                      <strong>{user.name}</strong>
                      <span>{user.email}</span>
                    </div>
                  </div>
                  <button onClick={() => { setMenu(false); nav("/settings", { viewTransition: true }); }}><Icon name="gear" size={16} /> Settings</button>
                  <button onClick={() => { setMenu(false); nav("/list", { viewTransition: true }); }}><Icon name="bookmark" size={16} /> My List</button>
                  <button onClick={() => { setMenu(false); signOut(); }}><Icon name="logout" size={16} /> Sign out</button>
                </div>
              </>
            )}
          </div>
        )}
        {w && (
          <div className="win-btns">
            <button aria-label="Minimize" onClick={() => w.minimize()}><Icon name="min" size={14} /></button>
            <button aria-label="Maximize" onClick={() => w.toggleMaximize()}><Icon name="max" size={12} /></button>
            <button aria-label="Close" className="close" onClick={() => w.close()}><Icon name="x" size={14} /></button>
          </div>
        )}
      </div>
    </header>
  );
}
