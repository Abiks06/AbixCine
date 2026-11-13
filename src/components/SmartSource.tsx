import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSettings } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import { candKey, candLine, clearResolveCache, PROVIDERS, resolveSources, type ResolveEvent } from "../sources/registry";
import type { StreamCandidate } from "../sources/types";
import { Icon } from "./Icon";

/**
 * Servers card on the title page: every enabled server is checked in the background before
 * you press play, ranked the way the player picks. Click any ready, standby, or retryable
 * server to play/check from it. The result is cached, so pressing Play reuses it instead of
 * asking every host again.
 */
export function SmartSource({ req, what, onPlay }: { req: PlaybackRequest; what: string; onPlay: (server?: string) => void }) {
  const s = useSettings();
  const enabled = PROVIDERS.filter((p) => p.isEnabled(s));
  const [events, setEvents] = useState<Record<string, ResolveEvent>>({});
  const [cands, setCands] = useState<StreamCandidate[] | null>(null);
  const [ranked, setRanked] = useState<StreamCandidate[]>([]);
  const [all, setAll] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!enabled.length) {
      setCands(null);
      setRanked([]);
      setEvents({});
      return;
    }
    let live = true;
    const ctl = new AbortController();
    setCands(null);
    setRanked([]);
    setEvents({});
    resolveSources(req, (e) => live && setEvents((x) => ({ ...x, [e.providerId]: e })), {
      signal: ctl.signal,
      verifyBudget: 1,
      record: false,
      onUpdate: (r) => live && setRanked(r),
    }).then((c) => live && setCands(c));
    return () => {
      live = false;
      ctl.abort();
    };
  }, [reqKey(req), s.libraryPaths, s.jellyfin, s.disabledSources, s.enabledExtras, refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    clearResolveCache();
    setRefreshTick((n) => n + 1);
  };

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
      const top = mine.find((c) => c.probe?.ok) ?? mine.find((c) => !c.probe) ?? mine[0];
      const ev = events[p.id];
      const isBusy = !ev || ev.status === "searching" || (ev.status === "done" && (ev.count ?? 0) > mine.length);
      const st: "ok" | "busy" | "standby" | "none" | "bad" = top?.probe?.ok
        ? "ok"
        : isBusy
          ? "busy"
          : top && !top.probe
            ? "standby"
            : top
              ? "bad"
              : ev?.status === "done"
                ? "none"
                : "bad";
      return { p, top, st };
    })
    // Ready first (best first), then still checking, then standby, then retryable/none.
    .sort((a, b) => {
      const o = { ok: 0, busy: 1, standby: 2, bad: 3, none: 4 };
      return o[a.st] - o[b.st] || (b.top?.score ?? -1e9) - (a.top?.score ?? -1e9);
    });
  const standbyCount = rows.filter((r) => r.st === "standby").length;
  const retryableCount = rows.filter((r) => r.st === "bad" && !!r.top).length;
  const shown = all ? rows : rows.slice(0, 5);

  return (
    <aside className="glass smart">
      <div className="h">
        <span><Icon name="layers" size={16} /> Servers</span>
        <span className="smart-acts">
          <span className="auto">
            {busy ? `${ready}/${enabled.length}` : ready > 0 ? `${ready} READY` : standbyCount > 0 ? `${standbyCount} STANDBY` : `${ready} READY`}
          </span>
          {enabled.length > 0 && (
            <button
              type="button"
              className={`smart-refresh ${busy ? "spinning" : ""}`}
              onClick={refresh}
              title="Refresh server check"
              aria-label="Refresh server check"
            >
              <Icon name="refresh" size={13} />
            </button>
          )}
        </span>
      </div>
      {enabled.length === 0 ? (
        <>
          <div className="smart-note">Every server is switched off.</div>
          <Link className="btn glass sm" to="/settings#sources" viewTransition><Icon name="gear" size={16} /> Choose servers</Link>
        </>
      ) : (
        <>
          <div className="smart-note">
            {best ? (
              <>Ready: <b>{what}</b> plays from <b>{best.providerName}</b>{best.probe?.quality ?? best.quality ? ` in ${best.probe?.quality ?? best.quality}p` : ""}{standbyCount > 0 ? ` · ${standbyCount} on standby` : ""}.</>
            ) : busy ? (
              `Checking ${enabled.length} servers for ${what}…`
            ) : standbyCount > 0 ? (
              <><b>{standbyCount}</b> standby {standbyCount === 1 ? "server is" : "servers are"} available to try for {what}.</>
            ) : retryableCount > 0 ? (
              <>Preflight couldn't confirm {what}, but <b>{retryableCount}</b> {retryableCount === 1 ? "server" : "servers"} can still be tried below.</>
            ) : (
              `No server has ${what} right now.`
            )}
          </div>
          <div className="srv-mini">
            {shown.map(({ p, top, st }, i) => {
              const isWin = !!best && !!top && candKey(top) === candKey(best);
              const disabled = st === "busy" || st === "none";
              const subText =
                st === "busy"
                  ? "checking…"
                  : st === "standby"
                    ? "try & check"
                    : st === "bad"
                      ? top
                        ? `${candLine(top)} · try anyway`
                        : `${events[p.id]?.status === "timeout" ? "timed out" : "no answer"} · retry`
                      : top
                        ? candLine(top)
                        : "doesn't have it";
              const title =
                st === "ok"
                  ? `Play from ${p.name}`
                  : st === "standby"
                    ? `Tap to check and play from ${p.name}`
                    : st === "bad"
                      ? top
                        ? `Preflight failed (${candLine(top)}) · Tap to check and play from ${p.name}`
                        : `Re-check ${p.name}`
                      : undefined;
              return (
                <button
                  key={p.id}
                  className={`sm-row ${st} ${isWin ? "win" : ""}`}
                  disabled={disabled}
                  onClick={() => {
                    if (top) onPlay(top.providerId);
                    else if (st === "bad") refresh();
                  }}
                  style={{ ["--i" as any]: i }}
                  title={title}
                >
                  <span className="sm-dot" />
                  <span className="sm-name">{p.name}</span>
                  <span className="sm-k">{subText}</span>
                  {st === "busy" ? (
                    <span className="mini-spin" />
                  ) : st === "bad" && !top ? (
                    <Icon name="refresh" size={11} />
                  ) : st !== "none" ? (
                    <Icon name="play" size={11} />
                  ) : null}
                </button>
              );
            })}
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
