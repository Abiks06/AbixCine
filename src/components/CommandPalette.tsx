import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { signOut } from "../lib/account";
import { encodeKey } from "../lib/catalog";
import { matchParts, peekSearch, searchAll } from "../lib/search";
import { rememberQuery, rememberTitle, useSearchHistory } from "../lib/history";
import { getSettings, updateSettings } from "../lib/settings";
import type { Media } from "../lib/types";
import { kindLabel } from "./Card";
import { Icon } from "./Icon";

interface Item {
  id: string;
  group: "Recent" | "Titles" | "Actions";
  label: string;
  hint?: string;
  icon?: string;
  media?: Media;
  run: () => void;
  /** Ctrl+Enter: start playing instead of opening the title page. */
  play?: () => void;
  /** Keep the palette open after running (e.g. a recent search fills the box). */
  keep?: boolean;
}

const MAX_TITLES = 7;
const CLOSE_MS = 130;
/** Palette thumbnails are 40px wide: ask the CDN for its smallest poster, not the card-size one. */
const thumb = (src: string) => src.replace("/t/p/w500/", "/t/p/w92/").replace("/t/p/w342/", "/t/p/w92/");

/** Ctrl+K (or /): one box to jump anywhere, search everything, or run an action. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Media[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  // Stays mounted for a beat after closing so it can animate out.
  const [shown, setShown] = useState(open);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const history = useSearchHistory();

  useEffect(() => {
    if (open) {
      setShown(true);
      setQ("");
      setResults([]);
      setBusy(false);
      setSel(0);
      const t = setTimeout(() => input.current?.focus(), 10);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShown(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setBusy(false);
      return setResults([]);
    }
    // Already answered this session: show it on this keystroke, no debounce.
    const hit = peekSearch(term);
    if (hit) {
      setBusy(false);
      return setResults(hit);
    }
    let live = true;
    setBusy(true);
    const t = setTimeout(
      () =>
        searchAll(term).then((r) => {
          if (!live) return;
          setResults(r);
          setBusy(false);
        }),
      180,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const term = q.trim();
  const low = term.toLowerCase();
  const items: Item[] = useMemo(() => {
    const go = (to: string) => () => nav(to, { viewTransition: true });
    const s = getSettings();
    const actions: Item[] = [
      { id: "home", group: "Actions", label: "Go to Home", icon: "home", run: go("/") },
      { id: "movies", group: "Actions", label: "Go to Films", icon: "film", run: go("/movies") },
      { id: "series", group: "Actions", label: "Go to Series", icon: "tv", run: go("/series") },
      { id: "anime", group: "Actions", label: "Go to Anime", icon: "spark", run: go("/anime") },
      { id: "drive", group: "Actions", label: "Open your drive", icon: "drive", run: go("/library") },
      { id: "list", group: "Actions", label: "Open My List", icon: "bookmark", run: go("/list") },
      { id: "settings", group: "Actions", label: "Settings", icon: "gear", run: go("/settings") },
      { id: "sources", group: "Actions", label: "Add a media folder", icon: "folder", run: go("/settings#sources") },
      { id: "dub", group: "Actions", label: `Default anime audio: switch to ${s.animeAudio === "sub" ? "Dub" : "Sub"}`, icon: "cc", run: () => updateSettings({ animeAudio: s.animeAudio === "sub" ? "dub" : "sub" }) },
      { id: "autoplay", group: "Actions", label: `Autoplay next episode: turn ${s.autoplayNext ? "off" : "on"}`, icon: "next", run: () => updateSettings({ autoplayNext: !s.autoplayNext }) },
      { id: "motion", group: "Actions", label: `${s.reduceMotion ? "Enable" : "Reduce"} motion`, icon: "spark", run: () => updateSettings({ reduceMotion: !s.reduceMotion }) },
      { id: "signout", group: "Actions", label: "Sign out", icon: "logout", run: () => signOut() },
    ];
    const title = (m: Media, hint: string, remember: boolean): Item => ({
      id: `m:${m.key}`,
      group: remember ? "Titles" : "Recent",
      label: m.title,
      hint,
      media: m,
      run: () => {
        if (remember) rememberQuery(term);
        rememberTitle(m);
        nav(`/title/${encodeKey(m.key)}`, { viewTransition: true });
      },
      play: () => {
        if (remember) rememberQuery(term);
        rememberTitle(m);
        nav(`/watch/${encodeKey(m.key)}`, { viewTransition: true });
      },
    });
    // Empty box: recent searches (fill the box) and titles you opened from search.
    if (!low) {
      return [
        ...history.queries.slice(0, 5).map((h): Item => ({ id: `q:${h.q}`, group: "Recent", label: h.q, hint: "Recent search", icon: "clock", keep: true, run: () => setQ(h.q) })),
        ...history.titles.slice(0, 4).map((h) => title(h.media, [kindLabel(h.media.kind), h.media.year].filter(Boolean).join(" · "), false)),
        ...actions,
      ];
    }
    return [
      ...results.slice(0, MAX_TITLES).map((m) => title(m, [kindLabel(m.kind), m.seasonCount ? "All seasons" : m.year, m.rating ? `★ ${m.rating.toFixed(1)}` : null].filter(Boolean).join(" · "), true)),
      ...(results.length > 0
        ? [{ id: "all", group: "Titles", label: `See all ${results.length} results for “${term}”`, icon: "search", run: () => (rememberQuery(term), nav(`/search?q=${encodeURIComponent(term)}`, { viewTransition: true })) } satisfies Item]
        : []),
      ...actions.filter((a) => a.label.toLowerCase().includes(low)),
    ];
    // `shown` refreshes the action labels (they read settings) each time the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [low, results, history, shown]);

  useEffect(() => setSel(0), [q, results]);
  useEffect(() => {
    listRef.current?.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!shown) return null;
  const run = (i: Item, play = false) => {
    if (!i.keep) onClose();
    (play && i.play ? i.play : i.run)();
  };
  const searching = busy && results.length === 0;
  const cur = items[sel];

  return (
    <div className={`palette-scrim ${open ? "" : "closing"}`} onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Search and commands">
        <div className="pal-input">
          {busy ? <span className="mini-spin" /> : <Icon name="search" size={20} />}
          <input
            ref={input}
            value={q}
            placeholder="Search films, series and anime, or type a command"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls="pal-list"
            aria-activedescendant={cur ? `pal-${sel}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              const last = items.length - 1;
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s >= last ? 0 : s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s <= 0 ? last : s - 1)); }
              else if (e.key === "Home" && !q) { e.preventDefault(); setSel(0); }
              else if (e.key === "End" && !q) { e.preventDefault(); setSel(last); }
              else if (e.key === "Enter" && cur) { e.preventDefault(); run(cur, e.ctrlKey || e.metaKey); }
              else if (e.key === "Escape") { e.preventDefault(); q ? setQ("") : onClose(); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={listRef} id="pal-list" role="listbox">
          {items.map((it, i) => {
            const parts = it.media && low ? matchParts(it.label, term) : null;
            return (
              <div key={it.id} style={{ display: "contents" }}>
                {(i === 0 || items[i - 1].group !== it.group) && <div className="pal-sep">{it.group}</div>}
                <button id={`pal-${i}`} role="option" aria-selected={i === sel} className={`pal-item ${i === sel ? "on" : ""}`} onMouseMove={() => i !== sel && setSel(i)} onClick={(e) => run(it, e.ctrlKey || e.metaKey)}>
                  {it.media ? (
                    <span className="pal-thumb" style={it.media.poster ? { backgroundImage: `url(${thumb(it.media.poster)})` } : { ["--h" as any]: it.media.hue ?? 260 }} />
                  ) : (
                    <span className="pal-icon"><Icon name={it.icon!} size={16} /></span>
                  )}
                  <span className="pal-label">{parts ? <>{parts[0]}<mark>{parts[1]}</mark>{parts[2]}</> : it.label}</span>
                  {it.hint && <span className="pal-hint">{it.hint}</span>}
                  <Icon name="arrowR" size={14} className="pal-go" />
                </button>
              </div>
            );
          })}
          {searching && Array.from({ length: 3 }, (_, i) => <div key={i} className="pal-item pal-skel"><span className="pal-thumb" /><span className="sk-line" /></div>)}
          {items.length === 0 && !busy && <div className="pal-empty">Nothing matches “{q}”. Check the spelling, or try the original title.</div>}
        </div>
        <div className="pal-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          {cur && <span><kbd>Enter</kbd> {cur.media ? "open" : "select"}</span>}
          {cur?.play && <span><kbd>Ctrl</kbd><kbd>Enter</kbd> play</span>}
          <span className="grow" />
          <span><kbd>/</kbd> or <kbd>Ctrl</kbd><kbd>K</kbd> anywhere</span>
        </div>
      </div>
    </div>
  );
}
