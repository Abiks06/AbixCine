import { useCallback, useEffect, useState } from "react";

/**
 * Run an async loader whenever `deps` change. Data from the previous deps is dropped right away,
 * so a page never renders title B with title A's details. `reload()` re-runs it (for Retry buttons).
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ loading: true });
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
