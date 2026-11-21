import { useCallback, useEffect, useState } from "react";

/**
 * Run an async loader whenever `deps` change. Data from the previous deps is dropped right away,
 * so a page never renders title B with title A's details (pass keepPrevious for refreshes of the
 * same view). `reload()` re-runs it (for Retry buttons).
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  opts: { keepPrevious?: boolean; initialData?: T } = {},
) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>(() =>
    opts.initialData !== undefined ? { data: opts.initialData, loading: true } : { loading: true },
  );
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

/**
 * Run multiple independent feed loaders concurrently and let each slot render as soon as it resolves
 * (coalescing same-frame cache hits) so one cold endpoint never stalls an entire browse page.
 */
export function useProgressiveFeeds<T>(
  loaders: (() => Promise<T>)[],
  deps: unknown[],
  opts: { keepPrevious?: boolean; initialItems?: (T | undefined)[] } = {},
) {
  const [state, setState] = useState<{ items: (T | undefined)[]; settled: boolean[] }>(() => ({
    items:
      opts.initialItems && opts.initialItems.length === loaders.length
        ? opts.initialItems
        : new Array<T | undefined>(loaders.length).fill(undefined),
    settled:
      opts.initialItems && opts.initialItems.length === loaders.length
        ? opts.initialItems.map((x) => x !== undefined)
        : new Array<boolean>(loaders.length).fill(false),
  }));
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    const count = loaders.length;
    setState((prev) => ({
      items:
        opts.keepPrevious && prev.items.length === count
          ? prev.items
          : new Array<T | undefined>(count).fill(undefined),
      settled:
        opts.keepPrevious && prev.items.some((x) => x !== undefined) && prev.settled.length === count
          ? prev.settled
          : new Array<boolean>(count).fill(false),
    }));
    if (count === 0) return;

    const pending = new Map<number, { hasValue: boolean; value?: T }>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!live || pending.size === 0) return;
      const batch = new Map(pending);
      pending.clear();
      setState((prev) => {
        const nextItems = prev.items.length === count ? [...prev.items] : new Array<T | undefined>(count).fill(undefined);
        const nextSettled = prev.settled.length === count ? [...prev.settled] : new Array<boolean>(count).fill(false);
        for (const [idx, entry] of batch) {
          if (entry.hasValue) nextItems[idx] = entry.value;
          nextSettled[idx] = true;
        }
        return { items: nextItems, settled: nextSettled };
      });
    };

    loaders.forEach((load, i) => {
      Promise.resolve()
        .then(() => load())
        .then(
          (value) => {
            if (!live) return;
            pending.set(i, { hasValue: true, value });
            flushTimer ??= setTimeout(flush, 16);
          },
          () => {
            if (!live) return;
            pending.set(i, { hasValue: false });
            flushTimer ??= setTimeout(flush, 16);
          },
        );
    });

    return () => {
      live = false;
      clearTimeout(flushTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const loading = state.settled.length !== loaders.length || state.settled.some((s) => !s);
  return { items: state.items, settled: state.settled, loading, reload };
}
