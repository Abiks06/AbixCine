import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signOut, useAuth } from "../lib/account";
import { alertText, clearAlerts, markAllRead, useAlerts } from "../lib/alerts";
import { encodeKey } from "../lib/catalog";
import { watchHref } from "../lib/play";
import { audioFor } from "../lib/settings";
import { useSettings } from "../lib/settings";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { LogoMark, Wordmark } from "./Logo";

/** Last folder name of a path, e.g. "D:\\Media" stays "D:\\Media", "C:\\Users\\me\\Videos" becomes "Videos". */
export const folderLabel = (p: string) => {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length <= 2 ? p.replace(/[\\/]+$/, "") : parts[parts.length - 1];
};

/**
 * Slim borderless title bar: brand, one search field in the middle (opens the palette),
 * a live sources status, the account, and Windows caption buttons. The bar drags the window.
 */
export function TitleBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const s = useSettings();
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);
  const alerts = useAlerts();
  const unread = alerts.filter((a) => !a.read).length;
  const w = isTauri() ? getCurrentWindow() : null;

  const servers = s.jellyfin.enabled ? 1 : 0;
  const folders = s.libraryPaths.length;
  const ready = folders + servers > 0;
  const status = ready
    ? [folders ? (folders === 1 ? `${folderLabel(s.libraryPaths[0])} ready` : `${folders} folders ready`) : null, servers ? `${servers} server` : null].filter(Boolean).join(" · ")
    : "Add a source";

  return (
    <header className="bar" data-tauri-drag-region onDoubleClick={(e) => e.target === e.currentTarget && w?.toggleMaximize()}>
      <Link to="/" className="brand" viewTransition>
        <LogoMark size={26} />
        <Wordmark />
      </Link>
      <button className="search" onClick={onOpenPalette} aria-label="Search">
        <Icon name="search" size={16} />
        <span>Search films, shows, anime, or type a command</span>
        <kbd>Ctrl</kbd>
        <kbd>K</kbd>
      </button>
      <Link to="/settings#sources" className={`status ${ready ? "" : "off"}`} title="Sources" viewTransition>
        <i className="dot" />
        <span>{status}</span>
      </Link>
      <div className="menu-wrap">
        <button className="avatar-btn bell" onClick={() => { setBell((b) => !b); if (!bell) setTimeout(markAllRead, 1500); }} aria-label={unread ? `${unread} new episode alerts` : "Episode alerts"}>
          <Icon name="bell" size={18} />
          {unread > 0 && <span className="bell-n">{unread > 9 ? "9+" : unread}</span>}
        </button>
        {bell && (
          <>
            <div className="menu-scrim" onClick={() => setBell(false)} />
            <div className="menu glass alerts-menu">
              <div className="menu-head alerts-head">
                <strong>New episodes</strong>
                {alerts.length > 0 && <button className="link-btn" onClick={clearAlerts}>Clear</button>}
              </div>
              {alerts.length === 0 && <p className="muted alerts-empty">Shows in My List and Continue watching show up here when a new episode or season comes out.</p>}
              {alerts.slice(0, 12).map((a) => (
                <button
                  key={a.id}
                  className={`alert-row ${a.read ? "" : "new"}`}
                  onClick={() => {
                    setBell(false);
                    const anime = a.key.startsWith("anilist:");
                    nav(a.kind === "season" ? `/title/${encodeKey(a.key)}` : watchHref(a.key, a.season, a.episode, anime ? audioFor(a.key) : undefined), { viewTransition: true, state: { from: "app" } });
                  }}
                >
                  {a.poster ? <img src={a.poster} alt="" /> : <span className="alert-ph" />}
                  <span className="alert-txt">
                    <b>{a.title}</b>
                    <small>{alertText(a)}</small>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {user && (
        <div className="menu-wrap">
          <button className="avatar-btn" onClick={() => setMenu((m) => !m)} aria-label="Account">
            <Avatar user={user} size={28} />
          </button>
          {menu && (
            <>
              <div className="menu-scrim" onClick={() => setMenu(false)} />
              <div className="menu glass">
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
      {w ? (
        <div className="win">
          <button aria-label="Minimize" onClick={() => w.minimize()}><Icon name="min" size={14} /></button>
          <button aria-label="Maximize" onClick={() => w.toggleMaximize()}><Icon name="max" size={12} /></button>
          <button aria-label="Close" className="close" onClick={() => w.close()}><Icon name="x" size={14} /></button>
        </div>
      ) : (
        <span style={{ width: 8 }} />
      )}
    </header>
  );
}
