import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Art, sized } from "./Art";
import { getAuth, leaveGuest, signOut } from "../lib/account";
import { encodeKey, isUnreleasedMedia } from "../lib/catalog";
import { playHref } from "../lib/play";
import { matchParts, peekSearch, searchAll } from "../lib/search";
import { rememberQuery, rememberTitle, useSearchHistory } from "../lib/history";
import { previewLight, tonesFor } from "../lib/light";
import { getSettings, updateSettings } from "../lib/settings";
import { useSlidingIndicator } from "../lib/useSlidingIndicator";
import type { Media } from "../lib/types";
import { toggleList, useSaved } from "../lib/watchlist";
import { kindLabel, seedState } from "./Card";
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

const MAX_TITLES = 8;
const CLOSE_MS = 130;

/**
 * Ctrl+K (or /): one box to jump anywhere, search everything, or run an action. The list is on
 * the left; the right-hand pane shows the thing itself, so you can tell two same-named titles
 * apart before you open one. It is a real modal: focus stays inside, Escape closes only it, and
 * focus returns to wherever it came from.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Media[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  // Stays mounted for a beat after closing so it can animate out.
  const [shown, setShown] = useState(open);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const history = useSearchHistory();
  const qRef = useRef(q);
  qRef.current = q;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape belongs to the palette while it is open, wherever focus is: a click on its blank space
  // drops focus to <body>, and the key then reached Watch (abandoning the source race) or the player.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (qRef.current) setQ("");
      else onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setShown(true);
      setQ("");
      setResults([]);
      setBusy(false);
      setSel(0);
      const t = setTimeout(() => input.current?.focus(), 10);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShown(false), CLOSE_MS);
    // Hand focus back, unless the palette navigated somewhere and that element is gone.
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
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
        searchAll(term)
          .then((r) => {
            if (!live) return;
            setResults(r);
            setBusy(false);
          })
          .catch(() => {
            if (!live) return;
            setResults([]);
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
      { id: "subs", group: "Actions", label: "Subtitle style", icon: "subtitles", run: go("/settings#subtitles") },
      { id: "dub", group: "Actions", label: `Default anime audio: switch to ${s.animeAudio === "sub" ? "Dub" : "Sub"}`, icon: "cc", run: () => updateSettings({ animeAudio: s.animeAudio === "sub" ? "dub" : "sub" }) },
      { id: "autoplay", group: "Actions", label: `Autoplay next episode: turn ${s.autoplayNext ? "off" : "on"}`, icon: "next", run: () => updateSettings({ autoplayNext: !s.autoplayNext }) },
      { id: "motion", group: "Actions", label: `${s.reduceMotion ? "Enable" : "Reduce"} motion`, icon: "spark", run: () => updateSettings({ reduceMotion: !s.reduceMotion }) },
      getAuth().user
        ? { id: "signout", group: "Actions", label: "Sign out", icon: "logout", run: () => void signOut() }
        : { id: "signin", group: "Actions", label: "Sign in to sync", icon: "user", run: () => leaveGuest() },
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
        nav(`/title/${encodeKey(m.key)}`, { viewTransition: true, state: seedState(m) });
      },
      play: isUnreleasedMedia(m)
        ? undefined
        : () => {
            if (remember) rememberQuery(term);
            rememberTitle(m);
            nav(playHref(m), { viewTransition: true, state: { from: "app" } });
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
      ...results.slice(0, MAX_TITLES).map((m) => title(m, [kindLabel(m.kind), m.seasonCount ? "All seasons" : m.year].filter(Boolean).join(" · "), true)),
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

  // The selected title lights the palette: the room behind the glass borrows its light (debounced
  // in lib/light.ts, so a held arrow key doesn't sample every row), and the pane's own bloom and
  // preview wash take its tone. Closing hands both back to the page.
  const curMedia = open ? items[Math.min(sel, items.length - 1)]?.media : undefined;
  useEffect(() => {
    if (!open) return;
    previewLight(curMedia ?? null);
    const el = box.current;
    if (!curMedia) {
      el?.style.removeProperty("--pal-tone");
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      tonesFor(curMedia).then((tones) => live && el?.style.setProperty("--pal-tone", tones.tone)).catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, curMedia]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) return void (wasOpen.current = true);
    if (!wasOpen.current) return;
    wasOpen.current = false;
    previewLight(null);
    box.current?.style.removeProperty("--pal-tone");
  }, [open]);

  // One stable ref callback: the list keeps its own ref for scrolling, the indicator gets the same
  // node. (A fresh callback each render would detach and re-attach it, and it would never glide.)
  const listInd = useSlidingIndicator(".pal-item.on");
  const setList = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      listInd(el);
    },
    [listInd],
  );

  if (!shown) return null;
  const run = (i: Item, play = false) => {
    if (!i.keep) onClose();
    (play && i.play ? i.play : i.run)();
  };
  const searching = busy && results.length === 0;
  const cur: Item | undefined = items[Math.min(sel, items.length - 1)];
  const last = items.length - 1;

  // One key handler for the whole dialog, so the keys behave the same wherever focus is inside it,
  // and nothing leaks to the page (or the player) underneath.
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (q) setQ("");
      else onClose();
      return;
    }
    if (e.key === "Tab") {
      // Focus trap: the input is the only tab stop (rows are driven by the arrow keys).
      e.preventDefault();
      input.current?.focus();
      return;
    }
    if (!items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s >= last ? 0 : s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s <= 0 ? last : s - 1)); }
    else if (e.key === "Home" && !q) { e.preventDefault(); setSel(0); }
    else if (e.key === "End" && !q) { e.preventDefault(); setSel(last); }
    else if (e.key === "PageDown") { e.preventDefault(); setSel((s) => Math.min(last, s + 5)); }
    else if (e.key === "PageUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 5)); }
    else if (e.key === "Enter" && cur) { e.preventDefault(); run(cur, e.ctrlKey || e.metaKey); }
  };

  return (
    <div className={`palette-scrim ${open ? "" : "closing"}`} onMouseDown={onClose}>
      <div
        className="palette"
        ref={box}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        // Only while open: during the close animation it must not block the player's hotkeys.
        aria-modal={open ? "true" : undefined}
        aria-label="Search and commands"
      >
        <div className="pal-input">
          {busy ? <span className="mini-spin" /> : <Icon name="search" size={21} />}
          <input
            ref={input}
            value={q}
            placeholder="Search films, series and anime, or type a command"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls="pal-list"
            aria-autocomplete="list"
            aria-activedescendant={cur ? `pal-${sel}` : undefined}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-body">
          <div className="pal-list" ref={setList} id="pal-list" role="listbox" aria-label="Results">
            {items.map((it, i) => {
              const parts = it.media && low ? matchParts(it.label, term) : null;
              return (
                <div key={it.id} style={{ display: "contents" }}>
                  {(i === 0 || items[i - 1].group !== it.group) && <div className="pal-sep" role="presentation">{it.group}</div>}
                  <button
                    id={`pal-${i}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === sel}
                    className={`pal-item ${i === sel ? "on" : ""}`}
                    onMouseMove={() => i !== sel && setSel(i)}
                    // Keep the caret in the box: clicking a row must not steal focus from typing.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => run(it, e.ctrlKey || e.metaKey)}
                  >
                    {it.media ? (
                      <span className="pal-thumb" style={it.media.poster ? { backgroundImage: `url(${sized(it.media.poster, "w92")})` } : { ["--h" as string]: it.media.hue ?? 260 }} />
                    ) : (
                      <span className="pal-icon"><Icon name={it.icon ?? "arrowR"} size={16} /></span>
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
          <aside className="pal-preview" aria-label="Preview">
            {cur?.media ? <Preview key={cur.media.key} m={cur.media} /> : (
              <div className="pp-idle">
                <span className="pp-glyph"><Icon name={cur?.icon ?? "search"} size={30} /></span>
                <strong>{cur ? cur.label : "Search every catalog at once"}</strong>
                <span>{cur ? (cur.keep ? "Enter fills the box with this search." : "Enter runs this.") : "Films, series and anime in one box. Add a year to narrow it down."}</span>
              </div>
            )}
          </aside>
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

/** The selected title, shown rather than described. */
function Preview({ m }: { m: Media }) {
  const saved = useSaved(m.key);
  return (
    <>
      <div className="pp-art"><Art media={m} variant="backdrop" size="md" eager /></div>
      <div className="pp-body">
        <div className="pp-title">{m.title}</div>
        <div className="specs">
          {m.rating ? <span className="star">★ {m.rating.toFixed(1)}</span> : null}
          <span>{kindLabel(m.kind)}</span>
          {m.seasonCount ? <span>All seasons</span> : m.year ? <span>{m.year}</span> : null}
          {m.genres[0] && <span>{m.genres[0]}</span>}
        </div>
        {m.overview && <p>{m.overview}</p>}
        <div className="pp-keys">
          <span><kbd>Enter</kbd> Open the title page</span>
          {!isUnreleasedMedia(m) && <span><kbd>Ctrl</kbd><kbd>Enter</kbd> Play straight away</span>}
          <button
            type="button"
            className="link-btn"
            tabIndex={-1}
            style={{ alignSelf: "flex-start", pointerEvents: "auto" }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => toggleList(m)}
          >
            <Icon name={saved ? "check" : "plus"} size={13} /> {saved ? "In My List" : "Add to My List"}
          </button>
        </div>
      </div>
    </>
  );
}
