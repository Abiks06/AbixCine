import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useSettings } from "../lib/settings";
import type { PlaybackRequest } from "../lib/types";
import { acquireSession, invalidateSessions, sessionKey, type SessionSnapshot, type SourceSession } from "./session";

const noSub = () => () => {};
const noSnap = (): SessionSnapshot | null => null;

/**
 * The shared source session for a request, started and kept alive while this component is
 * mounted. `want` is how many ready streams to aim for (1 to preview, 3 to play with backups).
 * `recheck()` throws the session away and looks again from scratch.
 */
export function useSourceSession(req: PlaybackRequest | null, want = 1) {
  const settings = useSettings();
  const [epoch, setEpoch] = useState(0);
  const key = req ? sessionKey(req, settings) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const session: SourceSession | null = useMemo(() => (req ? acquireSession(req) : null), [key, epoch]);

  useEffect(() => {
    if (!session) return;
    session.retain();
    session.start(want);
    return () => session.release();
  }, [session, want]);

  const snap = useSyncExternalStore(session?.subscribe ?? noSub, session?.getSnapshot ?? noSnap);
  const recheck = useCallback(() => {
    invalidateSessions();
    setEpoch((n) => n + 1);
  }, []);
  return { session, snap, recheck };
}
