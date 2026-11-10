import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { searchAll } from "../lib/search";
import type { Media } from "../lib/types";
import { Card } from "../components/Card";
import { Icon } from "../components/Icon";

const TABS = [
  { id: "all", label: "All" },
  { id: "movie", label: "Movies" },
  { id: "tv", label: "Series" },
  { id: "anime", label: "Anime" },
] as const;

export function Search() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("all");
  const [results, setResults] = useState<Media[] | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Debounced search across both catalogs; the latest query wins.
  useEffect(() => {
    const term = q.trim();
    setParams(term ? { q: term } : {}, { replace: true });
    if (term.length < 2) return setResults(null);
    let live = true;
    setBusy(true);
    const t = setTimeout(async () => {
      const r = await searchAll(term);
      if (!live) return;
      setResults(r);
      setBusy(false);
    }, 280);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, setParams]);

  const shown = results?.filter((m) => tab === "all" || m.kind === tab) ?? [];

  return (
    <div className="page">
      <div className="search-box">
        <Icon name="search" size={22} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search movies, series and anime" spellCheck={false} />
        {busy && <span className="mini-spin" />}
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`chip ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {results && <small>{t.id === "all" ? results.length : results.filter((m) => m.kind === t.id).length}</small>}
          </button>
        ))}
      </div>
      {results === null ? (
        <div className="empty"><Icon name="search" size={40} /><p>Start typing to search every catalog at once.</p></div>
      ) : shown.length === 0 && !busy ? (
        <div className="empty"><p>No results for “{q}”.</p></div>
      ) : (
        <div className="grid">{shown.map((m, i) => <Card key={m.key} media={m} index={i} />)}</div>
      )}
    </div>
  );
}
