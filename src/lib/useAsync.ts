import { useCallback, useEffect, useState } from "react";

/**
 * Run an async loader whenever `deps` change. Data from the previous deps is dropped right away,
 * so a page never renders title B with title A's details (pass keepPrevious for refreshes of the
 * same view). `reload()` re-runs it (for Retry buttons).
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], opts: { keepPrevious?: boolean } = {}) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    // Background refreshes (same page, newer data) keep showing what's there instead of flashing a skeleton.
    setState((s) => (opts.keepPrevious ? { data: s.data, loading: true } : { loading: true }));
    fn().then(
      (data) => live && setState({ data, loading: false }),
      (error: unknown) => live && setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
