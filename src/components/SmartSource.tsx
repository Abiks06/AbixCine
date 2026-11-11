import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSettings } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import { candLine, PROVIDERS, resolveSources, type ResolveEvent } from "../sources/registry";
import type { StreamCandidate } from "../sources/types";
import { Icon } from "./Icon";

/**
 * Servers card on the title page: every enabled server is checked in the background before
 * you press play, ranked the way the player picks. Click a ready one to play from it.
 * The result is cached, so pressing Play reuses it instead of asking every host again.
 */
export function SmartSource({ req, what, onPlay }: { req: PlaybackRequest; what: string; onPlay: (server?: string) => void }) {
  const s = useSettings();
  const enabled = PROVIDERS.filter((p) => p.isEnabled(s));
  const [events, setEvents] = useState<Record<string, ResolveEvent>>({});
  const [cands, setCands] = useState<StreamCandidate[] | null>(null);
  const [ranked, setRanked] = useState<StreamCandidate[]>([]);
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!enabled.length) return;
    let live = true;
    const ctl = new AbortController();
    setCands(null);
    setRanked([]);
    setEvents({});
    resolveSources(req, (e) => live && setEvents((x) => ({ ...x, [e.providerId]: e })), { signal: ctl.signal, verifyBudget: 1, record: false, onUpdate: (r) => live && setRanked(r) }).then(
      (c) => live && setCands(c),
    );
    return () => {
      live = false;
      ctl.abort();
    };
  }, [reqKey(req), s.libraryPaths, s.jellyfin, s.disabledSources, s.enabledExtras]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = cands ?? ranked;
  const best = list.find((c) => c.probe?.ok);
  const ready = list.filter((c) => c.probe?.ok).length;
  const busy = enabled.filter((p) => {
    const ev = events[p.id];
    return !ev || ev.status === "searching" || (ev.status === "done" && (ev.count ?? 0) > ranked.filter((c) => c.providerId === p.id).length);
  }).length;

  const rows = enabled
    .map((p) => {
      const mine = ranked.filter((c) => c.providerId === p.id);
      const top = mine.find((c) => c.probe?.ok) ?? mine[0];
      const ev = events[p.id];
      const isBusy = !ev || ev.status === "searching" || (ev.status === "done" && (ev.count ?? 0) > mine.length);
      const st: "ok" | "busy" | "standby" | "none" | "bad" = top?.probe?.ok ? "ok" : isBusy ? "busy" : top && !top.probe ? "standby" : ev?.status === "done" ? "none" : "bad";
      return { p, top, st };
    })
    // Ready first (best first), then still checking, then the rest.
    .sort((a, b) => {
      const o = { ok: 0, busy: 1, standby: 2, none: 3, bad: 4 };
      return o[a.st] - o[b.st] || (b.top?.score ?? -1e9) - (a.top?.score ?? -1e9);
    });
  const shown = all ? rows : rows.slice(0, 5);

  return (
    <aside className="glass smart">
      <div className="h">
        <span><Icon name="layers" size={16} /> Servers</span>
        <span className="auto">{busy ? `${ready}/${enabled.length}` : `${ready} READY`}</span>
      </div>
      {enabled.length === 0 ? (
        <>
          <div className="smart-note">Every server is switched off.</div>
          <Link className="btn glass sm" to="/settings#sources" viewTransition><Icon name="gear" size={16} /> Choose servers</Link>
        </>
      ) : (
        <>
          <div className="smart-note">
            {best
              ? <>Ready: <b>{what}</b> plays from <b>{best.providerName}</b>{best.probe?.quality ?? best.quality ? ` in ${best.probe?.quality ?? best.quality}p` : ""}.</>
              : busy
                ? `Checking ${enabled.length} servers for ${what}…`
                : `No server has ${what} right now.`}
          </div>
          <div className="srv-mini">
            {shown.map(({ p, top, st }, i) => (
              <button
                key={p.id}
                className={`sm-row ${st} ${best && top?.url === best.url ? "win" : ""}`}
                disabled={st !== "ok"}
                onClick={() => onPlay(top!.url)}
                style={{ ["--i" as any]: i }}
                title={st === "ok" ? `Play from ${p.name}` : undefined}
              >
                <span className="sm-dot" />
                <span className="sm-name">{p.name}</span>
                <span className="sm-k">{st === "busy" ? "checking…" : st === "standby" ? "on standby" : top ? candLine(top) : events[p.id]?.status === "done" ? "doesn't have it" : "no answer"}</span>
                {st === "ok" && <Icon name="play" size={11} />}
              </button>
            ))}
          </div>
          {rows.length > 5 && (
            <button className="smart-more" onClick={() => setAll((x) => !x)}>
              {all ? "Show fewer" : `Show all ${rows.length} servers`}
            </button>
          )}
        </>
      )}
    </aside>
  );
}
