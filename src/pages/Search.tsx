import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { encodeKey } from "../lib/catalog";
import { peekSearch, searchAll } from "../lib/search";
import { clearHistory, forgetQuery, rememberQuery, rememberTitle, useSearchHistory } from "../lib/history";
import type { Media } from "../lib/types";
import { Art } from "../components/Art";
import { Card, CardSkeleton, kindLabel, tagForMorph } from "../components/Card";
import { Icon } from "../components/Icon";

const TABS = [
  { id: "all", label: "All" },
  { id: "movie", label: "Films" },
  { id: "tv", label: "Series" },
  { id: "anime", label: "Anime" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function Search() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const [tab, setTab] = useState<Tab>("all");
  const [results, setResults] = useState<Media[] | null>(() => (urlQ ? peekSearch(urlQ) ?? null : null));
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const history = useSearchHistory();
  const nav = useNavigate();

  useEffect(() => {
    input.current?.focus();
  }, []);

  // The palette's "See all results" lands here with a new ?q= while this page is already open.
  useEffect(() => {
    setQ((cur) => (cur.trim() === urlQ ? cur : urlQ));
  }, [urlQ]);

  // Debounced search across both catalogs; the latest query wins.
  useEffect(() => {
    const term = q.trim();
    setParams(term ? { q: term } : {}, { replace: true });
    if (term.length < 2) {
      setBusy(false);
      return setResults(null);
    }
    const hit = peekSearch(term);
    if (hit) {
      setBusy(false);
      return setResults(hit);
    }
    let live = true;
    setBusy(true);
    const t = setTimeout(async () => {
      const r = await searchAll(term);
      if (!live) return;
      setResults(r);
      setBusy(false);
      // Settled on a query that found something: remember it.
      if (r.length) rememberQuery(term);
    }, 240);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, setParams]);

  const count = (t: Tab) => (t === "all" ? results?.length ?? 0 : results?.filter((m) => m.kind === t).length ?? 0);
  // A filter with nothing in it for this query falls back to All.
  const active: Tab = tab !== "all" && results && count(tab) === 0 ? "all" : tab;
  const shown = results?.filter((m) => active === "all" || m.kind === active) ?? [];
  const opened = (m: Media) => {
    rememberQuery(q);
    rememberTitle(m);
  };
  // The best match gets a banner of its own; the rest fill the grid.
  const top = shown[0];
  const rest = top?.backdrop ? shown.slice(1) : shown;

  return (
    <div className="page">
      <div className="search-box">
        <Icon name="search" size={22} />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && q) setQ("");
            else if (e.key === "Enter" && top) {
              opened(top);
              nav(`/title/${encodeKey(top.key)}`, { viewTransition: true });
            }
          }}
          placeholder="Search films, series and anime"
          spellCheck={false}
          aria-label="Search"
        />
        {busy && <span className="mini-spin" />}
        {q && <button className="search-clear" onClick={() => (setQ(""), input.current?.focus())} aria-label="Clear search"><Icon name="x" size={16} /></button>}
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`chip ${active === t.id ? "on" : ""}`} disabled={!!results && t.id !== "all" && count(t.id) === 0} onClick={() => setTab(t.id)}>
            {t.label}
            {results && <small>{count(t.id)}</small>}
          </button>
        ))}
      </div>
      {results === null ? (
        busy ? (
          <div className="grid">{Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}</div>
        ) : history.queries.length || history.titles.length ? (
          <div className="history">
            {history.queries.length > 0 && (
              <section className="history-block">
                <div className="history-head">
                  <span>Recent searches</span>
                  <button className="link-btn" onClick={clearHistory}>Clear history</button>
                </div>
                <div className="history-chips">
                  {history.queries.map((h) => (
                    <span key={h.q} className="history-chip">
                      <button onClick={() => setQ(h.q)}><Icon name="clock" size={13} /> {h.q}</button>
                      <button className="x" aria-label={`Forget ${h.q}`} onClick={() => forgetQuery(h.q)}><Icon name="x" size={12} /></button>
                    </span>
                  ))}
                </div>
              </section>
            )}
            {history.titles.length > 0 && (
              <section className="history-block">
                <div className="history-head"><span>Recently opened</span></div>
                <div className="grid">{history.titles.map((h, i) => <Card key={h.media.key} media={h.media} index={i} />)}</div>
              </section>
            )}
          </div>
        ) : (
          <div className="empty">
            <span className="empty-ic"><Icon name="search" size={26} /></span>
            <h3>Search every catalog at once</h3>
            <p>Films, series and anime in one box. Add a year to narrow it down, like “Dune 2021”.</p>
          </div>
        )
      ) : shown.length === 0 ? (
        busy ? null : (
          <div className="empty">
            <span className="empty-ic"><Icon name="search" size={26} /></span>
            <h3>No results for “{q.trim()}”</h3>
            <p>Check the spelling, try fewer words, or search the original title.</p>
          </div>
        )
      ) : (
        <div className={`results ${busy ? "stale" : ""}`}>
          {top?.backdrop && (
            <Link className="top-hit" to={`/title/${encodeKey(top.key)}`} viewTransition onClick={(e) => (tagForMorph(e), opened(top))} key={top.key}>
              <div className="art-wrap"><Art media={top} variant="backdrop" eager /></div>
              <div className="th-shade" />
              <div className="th-copy">
                <span className="th-eyebrow">Top result</span>
                <strong>{top.title}</strong>
                <span className="meta">
                  <span className="badge">{kindLabel(top.kind).toUpperCase()}</span>
                  {top.seasonCount ? "All seasons" : top.year}
                  {top.rating ? <span className="star">★ {top.rating.toFixed(1)}</span> : null}
                  {top.genres.slice(0, 2).join(" · ")}
                </span>
                {top.overview && <p>{top.overview}</p>}
              </div>
              <span className="th-go"><Icon name="arrowR" size={18} /></span>
            </Link>
          )}
          <div className="grid" key={`${active}`}>
            {rest.map((m, i) => (
              <div key={m.key} style={{ display: "contents" }} onClickCapture={() => opened(m)}>
                <Card media={m} index={i} sub={m.seasonCount ? <><span className="badge">SERIES</span>All seasons</> : undefined} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
