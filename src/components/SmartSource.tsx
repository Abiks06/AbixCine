import { useState } from "react";
import { Link } from "react-router-dom";
import type { PlaybackRequest } from "../lib/types";
import { candKey } from "../sources/registry";
import { useSourceSession } from "../sources/useSourceSession";
import { Icon } from "./Icon";
import { boardRows, qualityLabel, SourceBoard } from "./SourceBoard";

/**
 * Servers card on the title page. It previews the same source session the player will use, so
 * by the time you press Play the stream is usually already found, and nothing is looked up twice.
 */
export function SmartSource({ req, what, onPlay }: { req: PlaybackRequest; what: string; onPlay: (server?: string) => void }) {
  const { snap, recheck } = useSourceSession(req, 1);
  const [all, setAll] = useState(false);
  if (!snap) return null;

  const enabled = snap.lanes.length;
  const rows = boardRows(snap);
  const pick = snap.pick;
  const q = pick ? qualityLabel(pick) : null;

  return (
    <aside className="glass smart">
      <div className="h">
        <span><Icon name="layers" size={16} /> Servers</span>
        <span className="smart-acts">
          <span className={`auto ${pick ? "ok" : ""}`}>
            {pick ? `${snap.ready} READY` : snap.busy ? "SCANNING" : snap.waiting ? `${snap.waiting} STANDBY` : "NONE"}
          </span>
          {enabled > 0 && (
            <button type="button" className={`smart-refresh ${snap.busy && !pick ? "spinning" : ""}`} onClick={recheck} title="Look again" aria-label="Look for servers again">
              <Icon name="refresh" size={13} />
            </button>
          )}
        </span>
      </div>
      {enabled === 0 ? (
        <>
          <div className="smart-note">Every server is switched off.</div>
          <Link className="btn glass sm" to="/settings#sources" viewTransition><Icon name="gear" size={16} /> Choose servers</Link>
        </>
      ) : (
        <>
          <div className="smart-note">
            {pick ? (
              <>Ready: <b>{what}</b> plays from <b>{pick.providerName}</b>{q ? ` in ${q}` : ""}{snap.waiting > 0 ? ` · ${snap.waiting} more on standby` : ""}.</>
            ) : snap.busy ? (
              `Finding ${what}…`
            ) : snap.waiting > 0 ? (
              <><b>{snap.waiting}</b> {snap.waiting === 1 ? "server is" : "servers are"} on standby for {what}. Pick one to check it.</>
            ) : (
              `No server has ${what} right now.`
            )}
          </div>
          <SourceBoard snap={snap} grouped={false} limit={all ? undefined : 5} onPick={(c) => onPlay(candKey(c))} />
          {rows.length > 5 && (
            <button className="smart-more" onClick={() => setAll((x) => !x)}>
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          )}
        </>
      )}
    </aside>
  );
}
