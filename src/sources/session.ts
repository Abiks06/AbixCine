import { getSettings, type Settings } from "../lib/settings";
import { reqKey, type PlaybackRequest } from "../lib/types";
import {
  isCircuitOpen,
  isStaleStreamUrl,
  lastPick,
  lookupTimeout,
  recentlyFailed,
  recordLookup,
  recordLookupFailure,
  recordPlayback,
  recordProbe,
} from "./health";
import { native } from "./native";
import {
  candKey,
  isAbortedProbe,
  learnedRank,
  linkSignal,
  manualCandidate,
  playCheck,
  probeCandidate,
  PROVIDER_TIMEOUT,
  PROVIDERS,
  recordWin,
  score,
  verifyEmbed,
  withTimeout,
} from "./registry";
import type { SourceProvider, StreamCandidate } from "./types";

/**
 * One source session per thing-to-play. The title page, the loading screen and the player all
 * read the same session, so there is exactly one list of servers, one pick, and one place where
 * a server's state changes. (Previously each screen kept and reconciled its own copy.)
 *
 * How a session finds a stream:
 *  1. Every enabled provider is asked at once. Lookups are cheap.
 *  2. Direct streams (files, media servers, API extractors) are checked as they arrive.
 *  3. Embed servers need a hidden browser page each (4-10 s, four at most), so they are held back
 *     briefly: if a direct stream is ready first, none is captured until a backup is wanted.
 *  4. The first ready stream becomes the pick as soon as nothing still in flight could beat it,
 *     after its first segment has been fetched for real (a playlist that answers isn't proof).
 *  5. Backups keep being checked quietly until `want` ready streams exist, so failover is instant.
 */

export type LaneStatus = "searching" | "found" | "empty" | "error" | "timeout";

export interface Lane {
  providerId: string;
  name: string;
  category: SourceProvider["category"];
  status: LaneStatus;
  /** Candidates this provider returned. */
  count: number;
  error?: string;
}

export type SessionPhase =
  /** Looking, nothing chosen yet. */
  | "racing"
  /** A stream is chosen; backups may still be checking. */
  | "picked"
  /** Everything answered and nothing is playable. */
  | "empty";

export interface SessionSnapshot {
  req: PlaybackRequest;
  phase: SessionPhase;
  /** Ready first (the pick, then by score), then being checked, then waiting, then failed. */
  candidates: StreamCandidate[];
  /** Keys (candKey) with a check in flight. */
  checking: ReadonlySet<string>;
  lanes: Lane[];
  /** The stream the session committed to. Stable until it fails. */
  pick?: StreamCandidate;
  ready: number;
  /** Found but not checked yet. */
  waiting: number;
  failed: number;
  /** Lookups or checks still running. */
  busy: boolean;
  /** ms from start to the pick. */
  pickMs?: number;
  /** A ready stream exists, but the server chosen by hand for this show is still coming: its provider id. */
  awaitingChoice?: string;
}

export interface SessionDeps {
  providers: SourceProvider[];
  settings: Settings;
  /** Check one candidate (captures embeds). */
  probe: (c: StreamCandidate, signal: AbortSignal) => Promise<StreamCandidate>;
  /** Segment-level proof that a stream plays, run on the would-be pick. */
  confirm: (c: StreamCandidate, signal: AbortSignal) => Promise<{ ok: boolean; quality?: number; error?: string }>;
  /** Re-capture an embed page (stream links expire). */
  capture: (c: StreamCandidate, signal: AbortSignal) => Promise<StreamCandidate>;
}

/** Direct checks are plain HTTP: several at once is fine. */
const DIRECT_POOL = 6;
/** A provider (a Stremio addon, say) can return dozens of streams; check the best few, keep the rest on standby. */
const AUTO_DIRECT_CHECKS = 12;
/** Hidden-browser captures before a pick, and while only filling backups. */
const CAPTURE_POOL = 3;
const CAPTURE_POOL_BACKUP = 2;
/** The native side allows four pages at once; the fourth is a hedge when the first three are slow. */
const CAPTURE_POOL_HEDGED = 4;
const HEDGE_DELAY_MS = 2500;
/** How long embeds wait for a direct stream to show up before any page is captured. */
const CAPTURE_HOLD_MS = 1500;
/** Once playing, let the stream start before spending bandwidth on backups. */
const BACKUP_DELAY_MS = 4000;
/** After the first ready stream, how long something better still in flight is given to land. */
const GRACE_MS = 350;
/** ...unless it is the server the viewer chose by hand for this show, which gets a real chance. */
const CHOICE_GRACE_MS = 9000;
/** The pick's first-segment check may not hold playback up longer than this. */
const CONFIRM_MS = 3500;
/** A session's stream links are trusted this long before a fresh session replaces it. */
const SESSION_FRESH_MS = 4 * 60_000;
/** Nobody watching: stop background captures after this, keep the results. */
const IDLE_STOP_MS = 1500;

/** Errors that mean "we stopped asking", not "the stream is broken". */
const SOFT_CONFIRM_ERRORS = /^(?:timeout|AbortError)$/i;

const isEmbed = (c: StreamCandidate) => c.kind === "embed";
const isMagnet = (c: StreamCandidate) => /^magnet:/i.test(c.url);

type Inflight = { ctl: AbortController; promise: Promise<StreamCandidate>; user: boolean; capture: boolean };

export class SourceSession {
  readonly req: PlaybackRequest;
  readonly createdAt = Date.now();
  private readonly s: Settings;
  private readonly providers: SourceProvider[];
  private readonly prio: Record<string, number>;
  private readonly deps: SessionDeps;

  private cands = new Map<string, StreamCandidate>();
  private lanes = new Map<string, Lane>();
  private inflight = new Map<string, Inflight>();
  private directQueue: string[] = [];
  private captureQueue: string[] = [];
  private autoDirect = 0;
  private lookupsPending = 0;
  private directLookupsPending = 0;

  private target = 1;
  private pickKey?: string;
  private pickMs?: number;
  private confirming?: string;
  private confirmed = new Set<string>();
  private recorded = new Set<string>();
  /** Keys the viewer chose by hand, so a successful play is remembered as their choice. */
  private manual = new Set<string>();

  private started = false;
  private disposed = false;
  private captureOpen = false;
  private hedged = false;
  private firstReadyAt?: number;
  private t0 = 0;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private hedgeTimer?: ReturnType<typeof setTimeout>;
  private backupTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private backupsHeld = false;
  private root = new AbortController();

  private refs = 0;
  private listeners = new Set<() => void>();
  private dirty = true;
  private notifyQueued = false;
  private snap!: SessionSnapshot;

  constructor(req: PlaybackRequest, deps: Partial<SessionDeps> = {}) {
    this.req = req;
    this.s = deps.settings ?? getSettings();
    this.deps = {
      settings: this.s,
      providers: deps.providers ?? PROVIDERS,
      probe: deps.probe ?? probeCandidate,
      confirm: deps.confirm ?? playCheck,
      capture: deps.capture ?? verifyEmbed,
    };
    this.providers = this.deps.providers.filter((p) => p.isEnabled(this.s));
    this.prio = Object.fromEntries(this.deps.providers.map((p) => [p.id, p.priority]));
    for (const p of this.providers) {
      this.lanes.set(p.id, { providerId: p.id, name: p.name, category: p.category, status: "searching", count: 0 });
    }
  }

  /* ------------------------------------------------------------ observing */

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): SessionSnapshot => {
    if (this.dirty) this.rebuild();
    return this.snap;
  };

  private changed() {
    this.dirty = true;
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      for (const fn of [...this.listeners]) fn();
    });
  }

  private rebuild() {
    this.dirty = false;
    const all = [...this.cands.values()];
    const checking = new Set(this.inflight.keys());
    if (this.confirming) checking.add(this.confirming);
    const pick = this.pickKey ? this.cands.get(this.pickKey) : undefined;
    const group = (c: StreamCandidate) =>
      c.probe?.ok ? (candKey(c) === this.pickKey ? 0 : 1) : checking.has(candKey(c)) ? 2 : !c.probe ? 3 : 4;
    const rank = (c: StreamCandidate) => (c.probe?.ok ? (c.score ?? 0) : this.rankOf(c));
    const candidates = all.sort((a, b) => group(a) - group(b) || rank(b) - rank(a));
    const ready = all.filter((c) => c.probe?.ok).length;
    const busy = this.isBusy();
    this.snap = {
      req: this.req,
      phase: pick?.probe?.ok ? "picked" : !busy && ready === 0 && this.started ? "empty" : "racing",
      candidates,
      checking,
      lanes: [...this.lanes.values()],
      pick: pick?.probe?.ok ? pick : undefined,
      ready,
      waiting: all.filter((c) => !c.probe && !checking.has(candKey(c))).length,
      failed: all.filter((c) => c.probe && !c.probe.ok).length,
      busy,
      pickMs: this.pickMs,
      awaitingChoice: this.awaitingChoice,
    };
  }

  /** Is anything running, or about to be started by the scheduler? */
  private isBusy() {
    if (!this.started) return true;
    if (this.lookupsPending > 0 || this.inflight.size > 0 || this.confirming) return true;
    if (this.directQueue.length > 0 && this.autoDirect < AUTO_DIRECT_CHECKS && this.readyCount() < Math.max(this.target, 1)) return true;
    return this.captureQueue.length > 0 && this.readyCount() < this.target && !this.backupsHeld;
  }

  /* ------------------------------------------------------------- lifetime */

  retain() {
    this.refs++;
    clearTimeout(this.idleTimer);
  }

  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    clearTimeout(this.idleTimer);
    // Leaving a page and arriving on the next releases then retains within a frame; only a
    // session nobody came back to stops working.
    this.idleTimer = setTimeout(() => this.refs === 0 && this.stopBackground(), IDLE_STOP_MS);
  }

  get inUse() {
    return this.refs > 0;
  }

  /** Still good to hand to a new screen: recent, and no ready stream has gone stale. */
  isFresh() {
    if (this.disposed) return false;
    if (Date.now() - this.createdAt > SESSION_FRESH_MS) return false;
    return ![...this.cands.values()].some((c) => c.probe?.ok && c.providerId !== "local" && isStaleStreamUrl(c.url));
  }

  dispose() {
    this.disposed = true;
    this.root.abort();
    for (const t of [this.holdTimer, this.graceTimer, this.hedgeTimer, this.backupTimer, this.idleTimer]) clearTimeout(t);
    this.inflight.clear();
    this.listeners.clear();
  }

  /* --------------------------------------------------------------- start */

  /** Begin (once). `want` is how many ready streams to aim for: 1 to preview, 3 to play with backups. */
  start(want = 1) {
    this.want(want);
    if (this.started || this.disposed) return this;
    this.started = true;
    this.t0 = performance.now();

    const direct = this.providers.filter((p) => p.category !== "embed");
    this.lookupsPending = this.providers.length;
    this.directLookupsPending = direct.length;

    const hold = this.holdMs(direct);
    if (hold <= 0) this.captureOpen = true;
    else this.holdTimer = setTimeout(() => this.openCapture(), hold);

    for (const p of this.providers) void this.lookup(p);
    if (!this.providers.length) this.evaluate();
    this.changed();
    return this;
  }

  /** Raise the number of ready streams to aim for (never lowers it). */
  want(n: number) {
    if (n > this.target) {
      this.target = n;
      if (this.started) {
        this.pump();
        this.changed();
      }
    }
    return this;
  }

  /** Check every server that hasn't been checked. */
  checkAll() {
    this.autoDirect = -Infinity;
    this.backupsHeld = false;
    this.captureOpen = true;
    return this.want(Number.MAX_SAFE_INTEGER);
  }

  /** Stop background checks (ones the viewer asked for keep going). */
  stopBackground() {
    this.target = Math.max(1, this.readyCount());
    for (const f of this.inflight.values()) if (!f.user) f.ctl.abort();
    this.changed();
  }

  /**
   * How long embeds wait for direct sources. No direct providers: don't wait. Direct providers
   * that rarely deliver this kind of title: barely wait. Otherwise give them a head start.
   */
  private holdMs(direct: SourceProvider[]) {
    if (!direct.length || !native) return 0;
    const kind = this.req.media.kind;
    const best = Math.max(...direct.map((p) => learnedRank(p.id, kind, 0)));
    // learnedRank(…, 0) is about -14 for a provider that keeps failing and +10 for a dependable one.
    return best < -6 ? 300 : CAPTURE_HOLD_MS;
  }

  private openCapture() {
    if (this.captureOpen) return;
    this.captureOpen = true;
    clearTimeout(this.holdTimer);
    this.pump();
  }

  private async lookup(p: SourceProvider) {
    const { ctl, cleanup } = linkSignal(this.root.signal);
    const t0 = performance.now();
    let found: StreamCandidate[] = [];
    let failure: { status: "timeout" | "error"; error?: string } | undefined;
    try {
      found = await withTimeout(p.find(this.req, this.s, ctl.signal), lookupTimeout(p.id, p.timeoutMs ?? PROVIDER_TIMEOUT), ctl);
      recordLookup(p.id, performance.now() - t0);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : undefined;
      failure = { status: msg === "timeout" ? "timeout" : "error", error: msg };
      if (!this.root.signal.aborted) recordLookupFailure(p.id, Math.round(performance.now() - t0));
    } finally {
      cleanup();
    }
    if (this.disposed) return;

    const lookupMs = Math.round(performance.now() - t0);
    let added = 0;
    for (const raw of found) {
      const key = candKey(raw);
      if (this.cands.has(key)) continue;
      added++;
      const c = this.put({ ...raw, lookupMs });
      if (isEmbed(c)) this.captureQueue.push(key);
      else this.directQueue.push(key);
    }
    const lane = this.lanes.get(p.id)!;
    this.lanes.set(p.id, failure ? { ...lane, ...failure } : { ...lane, status: added ? "found" : "empty", count: added });

    this.lookupsPending--;
    if (p.category !== "embed") this.directLookupsPending--;
    this.pump();
    this.evaluate();
    this.changed();
  }

  /* ----------------------------------------------------------- scheduler */

  private readyCount() {
    let n = 0;
    for (const c of this.cands.values()) if (c.probe?.ok) n++;
    return n;
  }

  /** Order for checking: what has worked lately for this kind of title, and for this show. */
  private rankOf(c: StreamCandidate) {
    const pinned = lastPick(this.req);
    const affinity =
      pinned?.providerId === c.providerId && !isCircuitOpen(c.providerId) && !recentlyFailed(c.providerId) ? (pinned.manual ? 40 : 20) : 0;
    return learnedRank(c.providerId, this.req.media.kind, this.prio[c.providerId] ?? 0) + affinity;
  }

  private takeBest(queue: string[]) {
    let bi = 0;
    let best = -Infinity;
    for (let i = 0; i < queue.length; i++) {
      const c = this.cands.get(queue[i]);
      const r = c ? this.rankOf(c) : -Infinity;
      if (r > best) {
        best = r;
        bi = i;
      }
    }
    return queue.splice(bi, 1)[0];
  }

  private running(capture: boolean) {
    let n = 0;
    for (const f of this.inflight.values()) if (f.capture === capture) n++;
    return n;
  }

  private pump() {
    if (this.disposed || !this.started) return;
    const wantMore = () => this.readyCount() < this.target;

    // Direct streams: cheap, so check them as they arrive, best first.
    while (this.directQueue.length && this.running(false) < DIRECT_POOL && this.autoDirect < AUTO_DIRECT_CHECKS && (wantMore() || !this.pickKey)) {
      this.autoDirect++;
      this.launch(this.takeBest(this.directQueue), false);
    }

    // Embeds: held until direct sources had their chance, or everything direct has answered.
    const fastLane = this.fastLaneKey();
    if (fastLane && wantMore() && this.running(true) === 0) {
      this.captureQueue.splice(this.captureQueue.indexOf(fastLane), 1);
      this.launch(fastLane, false);
    }
    // Before the pick, a ready stream means the pick is a moment away: capturing now would only
    // compete with it. After the pick, captures are backups and start once the stream is under way.
    const ready = this.readyCount();
    if (!this.pickKey && ready > 0) return;
    if (!this.captureOpen && this.directSettled()) this.captureOpen = true;
    if (this.captureOpen && !this.backupsHeld) {
      // Racing for a first stream: several pages at once. Filling backups: no more than are still needed.
      const limit = this.pickKey ? Math.min(CAPTURE_POOL_BACKUP, this.target - ready) : this.hedged ? CAPTURE_POOL_HEDGED : CAPTURE_POOL;
      while (this.captureQueue.length && this.running(true) < limit && wantMore()) {
        this.launch(this.takeBest(this.captureQueue), false);
      }
      this.armHedge();
    }
  }

  /** The server this show last played from skips the hold: capture it straight away. */
  private fastLaneKey() {
    if (this.captureOpen || this.pickKey) return undefined;
    const pinned = lastPick(this.req);
    if (!pinned) return undefined;
    return this.captureQueue.find((k) => this.cands.get(k)?.providerId === pinned.providerId);
  }

  private directSettled() {
    return this.directLookupsPending <= 0 && this.running(false) === 0 && (!this.directQueue.length || this.autoDirect >= AUTO_DIRECT_CHECKS);
  }

  private armHedge() {
    clearTimeout(this.hedgeTimer);
    if (this.hedged || this.pickKey || this.readyCount() > 0 || !this.captureQueue.length || this.running(true) < CAPTURE_POOL) return;
    this.hedgeTimer = setTimeout(() => {
      if (this.disposed || this.readyCount() > 0) return;
      this.hedged = true;
      this.pump();
    }, HEDGE_DELAY_MS);
  }

  /**
   * Check one candidate. `recapture` is for a stream that came from a page and has gone bad:
   * its page is captured again instead of re-fetching the dead link.
   */
  private launch(key: string, user: boolean, recapture = false): Promise<StreamCandidate> {
    const c = this.cands.get(key)!;
    const capture = isEmbed(c) || recapture;
    const { ctl, cleanup } = linkSignal(this.root.signal);
    const run = recapture ? this.deps.capture(c, ctl.signal) : this.deps.probe(c, ctl.signal);
    const promise = run
      .catch((e: unknown): StreamCandidate => ({ ...c, probe: { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : "check failed" } }))
      .then((r) => {
        cleanup();
        const mine = this.inflight.get(key);
        if (mine?.promise === promise) this.inflight.delete(key);
        if (this.disposed) return r;
        const cancelled = ctl.signal.aborted && !r.probe?.ok;
        if (cancelled) {
          // Stopped because enough streams were ready: it goes back to waiting, not to failed.
          const back = this.cands.get(key);
          if (back && !back.probe && isEmbed(back) && !this.captureQueue.includes(key)) this.captureQueue.unshift(key);
          else if (back && !back.probe && !isEmbed(back) && !this.directQueue.includes(key)) this.directQueue.unshift(key);
        } else {
          this.learn(r);
          this.put({ ...r, lookupMs: r.lookupMs ?? c.lookupMs });
          // Only once a pick exists: before that, a capture still running may be the better stream.
          if (r.probe?.ok && this.pickKey && this.readyCount() >= this.target) this.cancelSurplus();
        }
        this.evaluate();
        this.pump();
        this.changed();
        return this.cands.get(key) ?? r;
      });
    this.inflight.set(key, { ctl, promise, user, capture });
    this.changed();
    return promise;
  }

  /** Enough streams are ready: stop captures nobody asked for by hand. */
  private cancelSurplus() {
    for (const f of this.inflight.values()) if (f.capture && !f.user) f.ctl.abort();
  }

  private learn(r: StreamCandidate) {
    if (!r.probe || r.providerId === "manual" || isAbortedProbe(r, this.root.signal)) return;
    recordWin(r.providerId, this.req.media.kind, r.probe.ok);
    // One vote per provider per session, however many files it returned.
    if (this.recorded.has(r.providerId)) return;
    this.recorded.add(r.providerId);
    recordProbe(r);
  }

  private put(c: StreamCandidate) {
    const scored = score(c, this.s.preferredQuality, this.prio[c.providerId] ?? 0, this.req);
    this.cands.set(candKey(c), scored);
    this.dirty = true;
    return scored;
  }

  /* ------------------------------------------------------------- picking */

  private bestReady(except?: string) {
    let best: StreamCandidate | undefined;
    for (const c of this.cands.values()) {
      if (!c.probe?.ok || candKey(c) === except) continue;
      if (!best || (c.score ?? 0) > (best.score ?? 0)) best = c;
    }
    return best;
  }

  /** Could anything still running plausibly outrank `best`? Then it's worth a short wait. */
  private canBeBeaten(best: StreamCandidate) {
    const bar = (best.score ?? 0) + 3;
    const hope = (c: StreamCandidate) =>
      score({ ...c, probe: { ok: true, latencyMs: 600, quality: c.quality ?? this.s.preferredQuality } }, this.s.preferredQuality, this.prio[c.providerId] ?? 0, this.req).score ?? 0;
    for (const key of this.inflight.keys()) {
      const c = this.cands.get(key);
      if (c && hope(isEmbed(c) ? { ...c, via: "sniffed", kind: "hls" } : c) > bar) return true;
    }
    for (const lane of this.lanes.values()) {
      if (lane.status !== "searching" || lane.category === "embed") continue;
      const ghost: StreamCandidate = { providerId: lane.providerId, providerName: lane.name, label: lane.name, url: "pending:", kind: "hls", via: "direct" };
      if (hope(ghost) > bar) return true;
    }
    return false;
  }

  /**
   * The server the viewer chose by hand for this show is still being looked up or captured.
   * It gets real time to arrive (a capture takes seconds), where a merely better-scoring stream
   * gets a moment.
   */
  private chosenPending(best: StreamCandidate) {
    const pinned = lastPick(this.req);
    if (!pinned?.manual || pinned.providerId === best.providerId) return false;
    if (this.lanes.get(pinned.providerId)?.status === "searching") return true;
    for (const key of this.inflight.keys()) if (this.cands.get(key)?.providerId === pinned.providerId) return true;
    return false;
  }

  /** The provider being waited for because the viewer chose it for this show, if any. */
  get awaitingChoice(): string | undefined {
    if (this.pickKey) return undefined;
    const best = this.bestReady();
    return best && this.chosenPending(best) ? lastPick(this.req)?.providerId : undefined;
  }

  /** Stop waiting for anything better: play the best ready stream now. */
  pickNow() {
    clearTimeout(this.graceTimer);
    this.firstReadyAt = -Infinity;
    this.commit();
  }

  private evaluate() {
    if (this.disposed || !this.started) return;
    if (this.pickKey && !this.cands.get(this.pickKey)?.probe?.ok) this.pickKey = undefined;
    if (this.pickKey || this.confirming) return;
    const best = this.bestReady();
    if (!best) return;
    this.firstReadyAt ??= performance.now();
    const waited = performance.now() - this.firstReadyAt;
    const left = this.chosenPending(best) ? CHOICE_GRACE_MS - waited : this.canBeBeaten(best) ? GRACE_MS - waited : 0;
    clearTimeout(this.graceTimer);
    if (left > 0) {
      this.graceTimer = setTimeout(() => this.commit(), left);
      return;
    }
    this.commit();
  }

  /** Does the would-be pick still need its first segment fetched for real? */
  private needsConfirm(c: StreamCandidate) {
    if (this.confirmed.has(candKey(c))) return false;
    if (c.providerId === "local" || c.providerId === "manual" || isEmbed(c) || isMagnet(c)) return false;
    return c.kind === "hls" || c.kind === "file";
  }

  private commit() {
    if (this.disposed || this.pickKey || this.confirming) return;
    const best = this.bestReady();
    if (!best) return;
    const key = candKey(best);
    if (!this.needsConfirm(best)) return this.setPick(key);

    this.confirming = key;
    this.changed();
    const { ctl, cleanup } = linkSignal(this.root.signal);
    const timer = setTimeout(() => ctl.abort(), CONFIRM_MS);
    this.deps
      .confirm(best, ctl.signal)
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : "timeout" }) as { ok: boolean; quality?: number; error?: string })
      .then((res) => {
        clearTimeout(timer);
        cleanup();
        if (this.disposed) return;
        this.confirming = undefined;
        this.confirmed.add(key);
        const cur = this.cands.get(key);
        if (!cur?.probe?.ok) return this.evaluate();
        // Too slow to say is not a no: the player's own watchdog is the last word.
        if (res.ok || SOFT_CONFIRM_ERRORS.test(res.error ?? "") || ctl.signal.aborted) {
          if (res.ok && res.quality && !cur.probe.quality) this.put({ ...cur, quality: res.quality, probe: { ...cur.probe, quality: res.quality } });
          return this.setPick(key);
        }
        const dead = { ...cur, probe: { ok: false, latencyMs: cur.probe.latencyMs, error: res.error ?? "won't play" } };
        recordWin(dead.providerId, this.req.media.kind, false);
        recordProbe(dead);
        this.put(dead);
        this.pump();
        this.evaluate();
        this.changed();
      });
  }

  private setPick(key: string) {
    this.pickKey = key;
    this.pickMs ??= Math.round(performance.now() - this.t0);
    clearTimeout(this.graceTimer);
    clearTimeout(this.hedgeTimer);
    // Backups wait a moment so the stream that's about to start gets the bandwidth.
    if (this.readyCount() < this.target && this.captureQueue.length) {
      this.backupsHeld = true;
      this.captureOpen = true;
      this.backupTimer = setTimeout(() => {
        this.backupsHeld = false;
        this.pump();
        this.changed();
      }, BACKUP_DELAY_MS);
    }
    if (this.readyCount() >= this.target) this.cancelSurplus();
    this.changed();
  }

  /* ----------------------------------------------------- used by screens */

  get(key: string) {
    return this.cands.get(key);
  }

  /** Find by key, stream URL, page URL or provider id (how other screens name a server). */
  find(ref?: string) {
    if (!ref) return undefined;
    const direct = this.cands.get(ref);
    if (direct) return direct;
    const all = [...this.cands.values()];
    return (
      all.find((c) => c.url === ref || c.pageUrl === ref) ??
      all.filter((c) => c.providerId === ref).sort((a, b) => Number(!!b.probe?.ok) - Number(!!a.probe?.ok) || (b.score ?? 0) - (a.score ?? 0))[0]
    );
  }

  /** Resolves with the pick, or null once everything answered and nothing plays. */
  picked(signal?: AbortSignal): Promise<StreamCandidate | null> {
    return this.until((s) => (s.pick ? s.pick : s.phase === "empty" ? null : undefined), signal);
  }

  private until<T>(test: (s: SessionSnapshot) => T | undefined, signal?: AbortSignal): Promise<T | null> {
    return new Promise((resolve) => {
      const check = () => {
        if (signal?.aborted || this.disposed) return done(null);
        const v = test(this.getSnapshot());
        if (v !== undefined) done(v);
      };
      const done = (v: T | null) => {
        off();
        signal?.removeEventListener("abort", check);
        resolve(v);
      };
      const off = this.subscribe(check);
      signal?.addEventListener("abort", check, { once: true });
      check();
    });
  }

  /**
   * Check one server now because the viewer asked for it. Embeds are captured; a server whose
   * check failed earlier is tried again.
   */
  verify(key: string, signal?: AbortSignal): Promise<StreamCandidate | null> {
    const c = this.cands.get(key);
    if (!c || this.disposed) return Promise.resolve(null);
    this.start();
    let f = this.inflight.get(key);
    if (f) f.user = true;
    else {
      for (const q of [this.captureQueue, this.directQueue]) {
        const i = q.indexOf(key);
        if (i >= 0) q.splice(i, 1);
      }
      // A failed stream that came from a page is re-captured from the page, not re-fetched.
      const recapture = !isEmbed(c) && !!c.pageUrl && !!c.probe && !c.probe.ok;
      if (c.probe && !c.probe.ok) this.put({ ...c, probe: undefined });
      void this.launch(key, true, recapture);
      f = this.inflight.get(key)!;
    }
    const mine = f;
    if (!signal) return mine.promise;
    return new Promise((resolve) => {
      const onAbort = () => {
        mine.ctl.abort();
        resolve(null);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      void mine.promise.then((r) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? null : r);
      });
    });
  }

  /** A sniffed stream's link expired mid-play: capture its page again. */
  async refresh(key: string, signal?: AbortSignal): Promise<StreamCandidate | null> {
    const c = this.cands.get(key);
    if (!c?.pageUrl) return null;
    const { ctl, cleanup } = linkSignal(signal ?? this.root.signal);
    try {
      const r = await this.deps.capture(c, ctl.signal);
      if (ctl.signal.aborted || this.disposed) return null;
      this.confirmed.delete(key);
      return this.put({ ...r, lookupMs: c.lookupMs });
    } finally {
      cleanup();
      this.changed();
    }
  }

  /** The viewer chose this server by hand: if it plays, it becomes this show's server. */
  choose(key: string) {
    this.manual.add(key);
  }

  /**
   * What the player saw: the strongest signal there is. A stream that started is ready whatever
   * its check said; one that died is failed, and the pick moves on.
   */
  report(key: string, ok: boolean, info: { latencyMs?: number; quality?: number; error?: string } = {}) {
    const c = this.cands.get(key);
    if (!c) return;
    if (ok) {
      const quality = c.probe?.quality ?? info.quality ?? c.quality;
      const latencyMs = c.probe?.ok && c.probe.latencyMs > 0 ? c.probe.latencyMs : (info.latencyMs ?? 0);
      const live = this.put({ ...c, quality, probe: { ok: true, latencyMs, quality } });
      this.confirmed.add(key);
      this.pickKey ??= key;
      recordPlayback(this.req, live, true, this.manual.has(key) ? { manual: true } : {});
      recordWin(live.providerId, this.req.media.kind, true);
    } else {
      this.put({ ...c, probe: { ok: false, latencyMs: c.probe?.latencyMs ?? 0, error: info.error || "won't play" } });
      this.manual.delete(key);
      recordPlayback(this.req, c, false);
      recordWin(c.providerId, this.req.media.kind, false);
      if (this.pickKey === key) {
        this.pickKey = undefined;
        this.firstReadyAt = undefined;
      }
      this.evaluate();
    }
    this.changed();
  }

  /**
   * The stream that was playing died. Returns the next one to play: the best ready stream that
   * plays in AbixCine's own player, checking waiting servers if none is ready. Null when out of options.
   */
  async failover(deadKey: string, signal?: AbortSignal): Promise<StreamCandidate | null> {
    const usable = () =>
      [...this.cands.values()]
        .filter((c) => candKey(c) !== deadKey && c.probe?.ok && !isEmbed(c))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    const now = usable();
    if (now) return now;
    this.backupsHeld = false;
    clearTimeout(this.backupTimer);
    this.captureOpen = true;
    this.hedged = false;
    this.autoDirect = Math.min(this.autoDirect, AUTO_DIRECT_CHECKS - DIRECT_POOL);
    this.target = Math.max(this.target, this.readyCount() + 1);
    this.pump();
    this.changed();
    return this.until((s) => usable() ?? (s.busy ? undefined : null), signal).then((v) => v ?? null);
  }

  /** A stream link the viewer pasted. */
  addManual(url: string) {
    const c = this.put({ ...manualCandidate(url), probe: { ok: true, latencyMs: 0 } });
    this.started = true;
    this.pickKey = candKey(c);
    this.changed();
    return c;
  }

  /**
   * Last resort: play the servers' own pages in a shielded frame. Every server with a page
   * becomes a "web" stream.
   */
  useWebPlayers() {
    let first: StreamCandidate | undefined;
    for (const c of [...this.cands.values()]) {
      if (!c.pageUrl || c.probe?.ok) continue;
      const web = this.put({ ...c, url: c.pageUrl, kind: "embed", via: "embed", probe: { ok: true, latencyMs: 0 } });
      this.confirmed.add(candKey(web));
      first ??= web;
    }
    this.captureQueue = [];
    for (const f of this.inflight.values()) f.ctl.abort();
    if (first) this.pickKey ??= candKey(first);
    this.changed();
    return first;
  }
}

/* -------------------------------------------------------------- registry */

const sessions = new Map<string, SourceSession>();
let epoch = 0;

/** Same title, episode, audio and source settings share a session. */
export const sessionKey = (req: PlaybackRequest, s: Settings = getSettings()) =>
  `${reqKey(req)}|${JSON.stringify([s.libraryPaths, s.jellyfin.enabled && s.jellyfin.url, s.disabledSources, s.enabledExtras, s.preferredQuality])}|${epoch}`;

/** The live session for a request, or a new one when there is none or it has gone stale. */
export function acquireSession(req: PlaybackRequest): SourceSession {
  const key = sessionKey(req);
  const hit = sessions.get(key);
  if (hit && (hit.inUse || hit.isFresh())) return hit;
  hit?.dispose();
  for (const [k, s] of sessions) {
    if (!s.inUse && !s.isFresh()) {
      s.dispose();
      sessions.delete(k);
    }
  }
  const session = new SourceSession(req);
  sessions.set(key, session);
  return session;
}

/** Forget every session nobody is using: sources changed, or the viewer asked to look again. */
export function invalidateSessions() {
  epoch++;
  for (const [k, s] of sessions) {
    if (!s.inUse) s.dispose();
    sessions.delete(k);
  }
}
