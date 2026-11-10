import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { signOut, useAuth } from "../lib/account";
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
