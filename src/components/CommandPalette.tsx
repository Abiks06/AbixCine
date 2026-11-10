import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sized } from "./Art";
import { getAuth, leaveGuest, signOut } from "../lib/account";
import { encodeKey } from "../lib/catalog";
import { searchAll } from "../lib/search";
import { getSettings, updateSettings } from "../lib/settings";
import type { Media } from "../lib/types";
import { kindLabel } from "./Card";
import { Icon } from "./Icon";

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  media?: Media;
  run: () => void;
}

/** Ctrl+K: one box to jump anywhere, search everything, or run an action. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Media[]>([]);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setResults([]);
      setSel(0);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setResults([]);
    let live = true;
    const t = setTimeout(() => searchAll(term).then((r) => live && setResults(r.slice(0, 8))), 220);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const go = (to: string) => () => nav(to, { viewTransition: true });
  const actions: Item[] = useMemo(
    () => [
      { id: "home", label: "Go to Home", icon: "home", run: go("/") },
      { id: "movies", label: "Go to Movies", icon: "film", run: go("/movies") },
      { id: "series", label: "Go to Series", icon: "tv", run: go("/series") },
      { id: "anime", label: "Go to Anime", icon: "spark", run: go("/anime") },
      { id: "list", label: "Open My List", icon: "bookmark", run: go("/list") },
      { id: "search", label: "Full search page", icon: "search", run: go("/search") },
      { id: "settings", label: "Settings", icon: "gear", run: go("/settings") },
      { id: "sources", label: "Add a media folder", icon: "folder", run: go("/settings#sources") },
      { id: "dub", label: `Default anime audio: switch to ${getSettings().animeAudio === "sub" ? "Dub" : "Sub"}`, icon: "cc", run: () => updateSettings({ animeAudio: getSettings().animeAudio === "sub" ? "dub" : "sub" }) },
      { id: "motion", label: `${getSettings().reduceMotion ? "Enable" : "Reduce"} motion`, icon: "spark", run: () => updateSettings({ reduceMotion: !getSettings().reduceMotion }) },
      getAuth().user
        ? { id: "signout", label: "Sign out", icon: "logout", run: () => signOut() }
        : { id: "signin", label: "Sign in to sync", icon: "user", run: () => leaveGuest() },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  const term = q.trim().toLowerCase();
  const items: Item[] = [
    ...results.map((m) => ({ id: m.key, label: m.title, hint: [kindLabel(m.kind), m.year].filter(Boolean).join(" · "), media: m, run: go(`/title/${encodeKey(m.key)}`) })),
    ...actions.filter((a) => !term || a.label.toLowerCase().includes(term)),
  ];

  useEffect(() => setSel(0), [q, results.length]);
  useEffect(() => {
    listRef.current?.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const run = (i: Item) => {
    onClose();
    i.run();
  };

  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="pal-input">
          <Icon name="search" size={20} />
          <input
            ref={input}
            value={q}
            placeholder="Search titles or type a command"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === "Enter" && items[sel]) run(items[sel]);
              else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {results.length > 0 && <div className="pal-sep">Titles</div>}
          {items.map((it, i) => (
            <Fragment key={it.id}>
              {i === results.length && <div className="pal-sep">Actions</div>}
              <button className={`pal-item ${i === sel ? "on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => run(it)}>
                {it.media ? (
                  <span className="pal-thumb" style={it.media.poster ? { backgroundImage: `url(${sized(it.media.poster, "w92")})` } : { ["--h" as any]: it.media.hue ?? 260 }} />
                ) : (
                  <span className="pal-icon"><Icon name={it.icon!} size={16} /></span>
                )}
                <span className="pal-label">{it.label}</span>
                {it.hint && <span className="pal-hint">{it.hint}</span>}
                <Icon name="arrowR" size={14} className="pal-go" />
              </button>
            </Fragment>
          ))}
          {items.length === 0 && <div className="pal-empty">Nothing matches “{q}”.</div>}
        </div>
      </div>
    </div>
  );
}
