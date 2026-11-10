import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSettings } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import { candLine, displayScore, PROVIDERS, resolveSources, type ResolveEvent } from "../sources/registry";
import type { StreamCandidate } from "../sources/types";
import { Icon } from "./Icon";

/**
 * Smart Source: before you press play, the title page already knows where the best copy is.
 * Every enabled source is checked in the background and ranked the same way the player picks.
 */
export function SmartSource({ req, what }: { req: PlaybackRequest; what: string }) {
  const s = useSettings();
  const enabled = PROVIDERS.filter((p) => p.isEnabled(s));
  const [events, setEvents] = useState<Record<string, ResolveEvent>>({});
  const [cands, setCands] = useState<StreamCandidate[] | null>(null);
  const [ranked, setRanked] = useState<StreamCandidate[]>([]);

  useEffect(() => {
    if (!enabled.length) return;
    let live = true;
    const ctl = new AbortController();
    setCands(null);
    setRanked([]);
    setEvents({});
    resolveSources(req, (e) => live && setEvents((x) => ({ ...x, [e.providerId]: e })), { signal: ctl.signal, record: false, onUpdate: (r) => live && setRanked(r) }).then(
      (c) => live && setCands(c),
    );
    return () => {
      live = false;
      ctl.abort();
    };
  }, [reqKey(req), s.libraryPaths, s.jellyfin]); // eslint-disable-line react-hooks/exhaustive-deps

  const best = (cands ?? ranked).find((c) => c.probe?.ok);
  return (
    <aside className="glass smart">
      <div className="h">
        <span><Icon name="layers" size={16} /> Smart Source</span>
        <span className="auto">AUTO</span>
      </div>
      {enabled.length === 0 ? (
        <>
          <div className="smart-note">No sources yet. Add the folder where your movies and shows live, and AbixCine checks it before you press play.</div>
          <Link className="btn glass sm" to="/settings#sources" viewTransition><Icon name="folder" size={16} /> Add a media folder</Link>
        </>
      ) : (
        <>
          <div className="smart-note">
            {!cands && !best ? `Checking ${enabled.length} source${enabled.length > 1 ? "s" : ""} for ${what}…` : best ? `Ready: ${what} plays from ${best.providerName}${best.probe?.quality ?? best.quality ? ` in ${best.probe?.quality ?? best.quality}p` : ""}.` : `None of your sources has ${what} yet.`}
          </div>
          {enabled.map((p) => {
            const mine = ranked.filter((c) => c.providerId === p.id);
            const top = mine.find((c) => c.probe?.ok) ?? mine[0];
            const ev = events[p.id];
            const busy = !ev || ev.status === "searching" || (ev.status === "done" && (ev.count ?? 0) > mine.length);
            const st = top?.probe?.ok ? "ok" : busy ? "busy" : top ? "bad" : ev?.status === "done" ? "none" : "bad";
            const pct = top ? displayScore(top) : 0;
            return (
              <div key={p.id} className={`lane ${st} ${best && top?.url === best.url ? "win" : ""}`}>
                <span className="lane-n">{p.name}{best && top?.url === best.url && <em>PICK</em>}</span>
                <span className="k">{st === "busy" ? "probing…" : top ? candLine(top) : ev?.status === "done" ? "not found" : ev?.status ?? ""}</span>
                <div className="bar2"><i style={{ width: `${st === "busy" ? 35 : pct}%` }} /></div>
              </div>
            );
          })}
        </>
      )}
    </aside>
  );
}
