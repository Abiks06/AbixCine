import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Art } from "../components/Art";
import { Icon } from "../components/Icon";
import { encodeKey } from "../lib/catalog";
import { fmtTime } from "../lib/format";
import { removeHistory, useHistory, type WatchRecord } from "../lib/history";
import { watchHref } from "../lib/play";
import { audioFor } from "../lib/settings";

const dayLabel = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
};

const epLabel = (r: WatchRecord) => (r.episode == null ? "Film" : `${r.season != null ? `S${r.season} · ` : ""}E${r.episode}`);

/** Everything you've played, newest first, grouped by day. */
export function History() {
  const all = useHistory();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return term ? all.filter((r) => r.media.title.toLowerCase().includes(term)) : all;
  }, [all, q]);
  const groups = useMemo(() => {
    const out: { day: string; items: WatchRecord[] }[] = [];
    for (const r of shown.slice(0, 600)) {
      const day = dayLabel(r.at);
      if (out.at(-1)?.day !== day) out.push({ day, items: [] });
      out.at(-1)!.items.push(r);
    }
    return out;
  }, [shown]);
  const watchedCount = all.filter((r) => r.watched).length;

  return (
    <div className="page history">
      <div className="page-head">
        <div>
          <h5>Watch history</h5>
          <h1 className="page-title">History</h1>
        </div>
        <span className="muted">{all.length ? `${watchedCount} finished · ${all.length} played · synced to your account` : ""}</span>
        <div className="grow" />
        {all.length > 0 && (
          <>
            <label className="in-field sm">
              <Icon name="search" size={14} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter history" />
            </label>
            {confirmClear ? (
              <>
                <button className="btn btn-ion sm" onClick={() => { removeHistory(); setConfirmClear(false); }}>Clear everything</button>
                <button className="btn glass sm" onClick={() => setConfirmClear(false)}>Keep it</button>
              </>
            ) : (
              <button className="btn glass sm" onClick={() => setConfirmClear(true)}><Icon name="x" size={14} /> Clear history</button>
            )}
          </>
        )}
      </div>
      {all.length === 0 ? (
        <div className="empty">
          <Icon name="clock" size={40} />
          <p>Nothing here yet. Everything you play shows up here, with where you stopped.</p>
          <Link to="/" className="btn btn-glass sm" viewTransition>Browse</Link>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.day} className="h-day">
            <h4>{g.day}</h4>
            <div className="h-list">
              {g.items.map((r, i) => {
                const pct = r.watched ? 100 : r.duration ? Math.min(100, (r.position / r.duration) * 100) : 0;
                const anime = r.key.startsWith("anilist:") || r.media.kind === "anime";
                return (
                  <div key={r.key + r.ep} className="h-row" style={{ ["--i" as any]: Math.min(i, 12) }}>
                    <button className="h-art" onClick={() => nav(`/title/${encodeKey(r.key)}`, { viewTransition: true })} aria-label={`Open ${r.media.title}`}>
                      <Art media={r.media} variant="backdrop" size="sm" />
                      <i style={{ width: `${pct}%` }} />
                    </button>
                    <div className="h-txt">
                      <b>{r.media.title}</b>
                      <span className="muted">
                        {epLabel(r)} · {r.watched ? "Watched" : `Stopped at ${fmtTime(r.position)} of ${fmtTime(r.duration)}`} · {new Date(r.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </span>
                    </div>
                    <button
                      className="btn glass sm"
                      onClick={() => nav(watchHref(r.key, r.season, r.episode, anime ? audioFor(r.key) : undefined, r.watched ? undefined : { start: r.position }), { state: { from: "app" } })}
                    >
                      <Icon name={r.watched ? "replay10" : "play"} size={14} /> {r.watched ? "Watch again" : "Resume"}
                    </button>
                    <button className="icon-btn" aria-label="Remove from history" title="Remove from history" onClick={() => removeHistory(r.key, r.ep)}>
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
