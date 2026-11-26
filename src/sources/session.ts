import { getSettings, type Settings } from "../lib/settings";
import { onDownloadsChanged } from "../lib/downloads";
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
import { checkStreamIdentity, expectedRuntime, identityApplies, judgeRuntime, type RuntimeExpectation } from "./identity";
import { isUrlTokenExpired, native, unwrapProxyUrl } from "./native";
import { clearLocalScanCache } from "./local";
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
import type { SourceProvider, StreamCandidate, StreamIdentity } from "./types";

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
  /** Ready streams whose length is being compared with the catalog runtime. */
  verifying: ReadonlySet<string>;
  lanes: Lane[];
  /** The stream the session committed to. Stable until it fails. */
  pick?: StreamCandidate;
  /** Ready streams that are this title as far as anyone can tell (probable mismatches excluded). */
  ready: number;
  /** Streams that play but are probably a different title (far off the catalog runtime). Never auto-picked. */
  suspect: number;
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
  /**
   * Is a ready stream really this title (its length against the catalog runtime)? Null: nothing to
   * compare. Defaults to the playlist-duration check when the request's runtime can be known.
   */
  identity?: (c: StreamCandidate, signal: AbortSignal) => Promise<StreamIdentity | null>;
}

/** Direct checks are plain HTTP: several at once is fine. */
const DIRECT_POOL = 6;
/** A provider (a Stremio addon, say) can return dozens of streams; check the best few, keep the rest on standby. */
const AUTO_DIRECT_CHECKS = 24;
/**
 * Automatic checks one provider gets while others still have candidates waiting, so one source
 * returning a dozen dead links can't use up the whole budget before anyone else is tried.
 */
const AUTO_DIRECT_PER_PROVIDER = 3;
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
/** Extra head start given to the user's local library before committing to an online stream. */
const LOCAL_GRACE_MS = 2500;
/** ...unless it is the server the viewer chose by hand for this show, which gets a real chance. */
const CHOICE_GRACE_MS = 9000;
/** The pick's first-segment check may not hold playback up longer than this. */
const CONFIRM_MS = 3500;
/** A session's stream links are trusted this long before a fresh session replaces it. */
const SESSION_FRESH_MS = 4 * 60_000;
/** Nobody watching: stop background captures after this, keep the results. */
const IDLE_STOP_MS = 1500;
/** How long the would-be pick's runtime check may hold the pick up; past it, "unknown". */
const IDENTITY_MS = 3000;
/**
 * Hard ceilings for one check. Every check has its own timeouts; these only make sure a check that
 * somehow never settles can't leave a server "Checking…" (and the session busy) forever.
 */
const DIRECT_CHECK_CAP_MS = 20_000;
const CAPTURE_CHECK_CAP_MS = 35_000;

/** Errors that mean "we stopped asking", not "the stream is broken". */
const SOFT_CONFIRM_ERRORS = /^(?:timeout|AbortError)$/i;

const isLocalProvider = (id?: string) => id === "local" || id === "downloads";
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const isEmbed = (c: StreamCandidate) => c.kind === "embed";
const isMagnet = (c: StreamCandidate) => /^magnet:/i.test(c.url);
/** Probably a different title: plays, but nowhere near the catalog runtime. */
const isSuspect = (c: StreamCandidate) => c.identity?.status === "mismatch";
/** Ready, not another title, and not already token-expired. */
const isUsable = (c: StreamCandidate) => !!c.probe?.ok && !isSuspect(c) && (isLocalProvider(c.providerId) || !isUrlTokenExpired(c.url));
/** The stream behind the proxy: two servers capturing the same CDN playlist are one stream. */
const streamOf = (c: StreamCandidate) => (c.kind === "embed" ? c.pageUrl ?? c.url : unwrapProxyUrl(c.url).url);
const isAbxsProxied = (url: string) => /^(?:https?:\/\/abxs\.localhost(?:[/:?]|$)|abxs:\/\/)/i.test(url);

const ANIME_ONLY_DIRECT_IDS = new Set(["hianime", "megaplay", "anizone", "kickassanime", "anikoto", "animeheaven"]);
/** TMDB-keyed movie/TV extractors that only carry the original audio, so never an anime dub. */
const NO_ANIME_DUB_DIRECT_IDS = new Set([
  "vixsrc", "castle", "flixnest", "hexa-direct", "cinejoy", "meowtv", "zxcstreams", "vidrock", "vidlink-direct",
]);
const ASIAN_DRAMA_DIRECT_IDS = new Set(["kisskh", "onetouchtv"]);
const ASIAN_DRAMA_LANGS = new Set(["ko", "zh", "cn", "ja", "th", "tw", "tl", "id", "vi"]);

type Inflight = {
  ctl: AbortController;
  promise: Promise<StreamCandidate>;
  user: boolean;
  capture: boolean;
  /** Started by `verify()` (not by `pump()`): only then may its callers cancel it. */
  ownedByVerify?: boolean;
  /** `verify()` callers still waiting with a signal; cancelled only when the last one leaves. */
  waiters?: number;
  /** A `verify()` caller without a signal is waiting: never cancel on another caller's abort. */
  pinned?: boolean;
};

/** Errors from a shared dependency (e.g. enc-dec.app) that say nothing about the provider itself. */
const isDependencyOutage = (e: unknown) => (e as { dependencyOutage?: unknown } | null)?.dependencyOutage === true;

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
  /** Providers looked up in warm (preview) mode, to be asked again for real when play is requested. */
  private warmLookups = new Set<string>();
  private autoByProvider = new Map<string, number>();
  private lookupsPending = 0;

  private target = 1;
  private pickKey?: string;
  private playedKey?: string;
  private pickMs?: number;
  private confirming?: string;
  private skippedCircuit = new Set<string>();
  private confirmCtl?: AbortController;
  private commitGen = 0;
  private failoverToken = 0;
  private confirmed = new Set<string>();
  private recorded = new Set<string>();
  /** Keys the viewer chose by hand, so a successful play is remembered as their choice. */
  private manual = new Set<string>();
  /** Runtime checks in flight, by candKey. */
  private identityInflight = new Map<string, AbortController>();
  private readonly identityCheck?: (c: StreamCandidate, signal: AbortSignal) => Promise<StreamIdentity | null>;
  private expected?: Promise<RuntimeExpectation | null>;
  /** "Play now": take the best ready stream as it is, without waiting on its runtime check. */
  private pickAny = false;

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
  /** Nobody is watching this session: nothing new starts until a screen comes back for it. */
  private backgroundStopped = false;
  /** Dropped from the session table while a screen still held it: disposed when that screen lets go. */
  private invalidated = false;
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
      identity: deps.identity,
    };
    // Without a runtime to compare with there is nothing to check, and the session runs as before.
    this.identityCheck =
      deps.identity ?? (identityApplies(req) ? (c, signal) => this.expectation().then((exp) => checkStreamIdentity(c, exp, signal)) : undefined);
    this.providers = this.deps.providers.filter((p) => p.isEnabled(this.s) && this.isProviderApplicable(p));
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
    const ready = all.filter(isUsable).length;
    const busy = this.isBusy();
    this.snap = {
      req: this.req,
      // Streams that are probably another title don't count: with nothing else, there is no stream
      // for this title (they stay listed, with a warning, for the viewer to choose deliberately).
      phase: pick?.probe?.ok ? "picked" : !busy && ready === 0 && this.started ? "empty" : "racing",
      candidates,
      checking,
      verifying: new Set(this.identityInflight.keys()),
      lanes: [...this.lanes.values()],
      pick: pick?.probe?.ok ? pick : undefined,
      ready,
      suspect: all.filter((c) => c.probe?.ok && isSuspect(c)).length,
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
    if (this.lookupsPending > 0 || this.inflight.size > 0 || this.confirming || this.identityInflight.size > 0) return true;
    if (this.backgroundStopped) return false;
    if (this.directQueue.length > 0 && this.autoDirect < AUTO_DIRECT_CHECKS && this.readyCount() < Math.max(this.target, 1)) return true;
    return this.captureQueue.length > 0 && this.readyCount() < this.target && !this.backupsHeld;
  }

  /* ------------------------------------------------------------- lifetime */

  retain() {
    this.refs++;
    clearTimeout(this.idleTimer);
    this.resume();
  }

  /** Lift a background stop (a screen is using the session again). */
  private resume() {
    if (!this.backgroundStopped) return;
    this.backgroundStopped = false;
    if (this.started && !this.disposed) {
      this.target = Math.max(this.target, 1);
      if (!this.captureOpen && !this.holdTimer) {
        const direct = this.providers.filter((p) => p.category !== "embed");
        const hold = this.holdMs(direct);
        if (hold <= 0 || this.directSettled()) this.captureOpen = true;
        else this.holdTimer = setTimeout(() => this.openCapture(), hold);
      }
      this.pump();
    }
  }

  /** The session table let go of it. In use: finish serving that screen, then clean up. */
  invalidate() {
    if (this.refs > 0) this.invalidated = true;
    else this.dispose();
  }

  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs > 0) return;
    clearTimeout(this.idleTimer);
    if (this.invalidated) return this.dispose();
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
    return ![...this.cands.values()].some((c) => c.probe?.ok && !isLocalProvider(c.providerId) && isStaleStreamUrl(c.url));
  }

  dispose() {
    this.disposed = true;
    this.cancelPendingCommit();
    this.root.abort();
    for (const t of [this.holdTimer, this.graceTimer, this.hedgeTimer, this.backupTimer, this.idleTimer]) clearTimeout(t);
    this.inflight.clear();
    this.identityInflight.clear();
    this.listeners.clear();
  }

  /* --------------------------------------------------------------- start */

  /** Begin (once). `want` is how many ready streams to aim for: 1 to preview, 3 to play with backups. */
  start(want = 1) {
    this.want(want);
    if (this.started || this.disposed) return this;
    this.backgroundStopped = false;
    this.started = true;
    this.t0 = performance.now();

    const pinned = lastPick(this.req);
    const offline = isOffline();
    const runnable: SourceProvider[] = [];
    this.skippedCircuit.clear();
    for (const p of this.providers) {
      if (offline && p.category !== "local" && p.id !== "jellyfin") {
        const lane = this.lanes.get(p.id);
        if (lane) this.lanes.set(p.id, { ...lane, status: "empty" });
        continue;
      }
      const bypassCircuit = isLocalProvider(p.id) || p.id === "jellyfin" || (pinned?.manual && pinned.providerId === p.id);
      if (!bypassCircuit && isCircuitOpen(p.id)) {
        this.skippedCircuit.add(p.id);
        const lane = this.lanes.get(p.id);
        if (lane) this.lanes.set(p.id, { ...lane, status: "error", error: "circuit open" });
        continue;
      }
      runnable.push(p);
    }

    const direct = runnable.filter((p) => p.category !== "embed");
    this.lookupsPending = runnable.length;

    const hold = this.holdMs(direct);
    if (hold <= 0) this.captureOpen = true;
    else this.holdTimer = setTimeout(() => this.openCapture(), hold);

    // A preview (want 1, the Title page) must not touch the user's accounts: providers with side
    // effects (Debrid magnets) are asked in warm mode until playback is requested.
    const warm = want <= 1;
    for (const p of runnable) void this.lookup(p, warm && !!p.sideEffectsOnLookup?.(this.s));
    if (!runnable.length) this.evaluate();
    this.changed();
    return this;
  }

  /** Raise the number of ready streams to aim for (never lowers it). */
  want(n: number) {
    this.resume();
    if (n > 1 && this.started && this.warmLookups.size) this.activateWarmLookups();
    if (n > this.target) {
      this.target = n;
      if (this.started) {
        const pickedIsLocal = !!(this.pickKey && isLocalProvider(this.cands.get(this.pickKey)?.providerId));
        if (pickedIsLocal && n < Number.MAX_SAFE_INTEGER) {
          this.cancelSurplus();
        } else {
          if (
            this.pickKey &&
            !pickedIsLocal &&
            !this.backgroundStopped &&
            this.readyCount() < this.target &&
            this.captureQueue.length &&
            !this.backupTimer &&
            !this.backupsHeld
          ) {
            this.backupsHeld = true;
            this.captureOpen = true;
            this.backupTimer = setTimeout(() => {
              this.backupTimer = undefined;
              this.backupsHeld = false;
              this.pump();
              this.changed();
            }, BACKUP_DELAY_MS);
          }
          this.pump();
        }
        this.changed();
      }
    }
    return this;
  }

  /** Check every server that hasn't been checked (including providers whose circuit breaker was open). */
  checkAll() {
    this.backgroundStopped = false;
    this.autoDirect = -Infinity;
    this.backupsHeld = false;
    this.captureOpen = true;
    if (this.skippedCircuit.size) {
      const skipped = [...this.skippedCircuit];
      this.skippedCircuit.clear();
      const warm = this.target <= 1;
      for (const id of skipped) {
        const p = this.providers.find((x) => x.id === id);
        if (!p || this.disposed) continue;
        const lane = this.lanes.get(id);
        if (lane) this.lanes.set(id, { ...lane, status: "searching", error: undefined });
        this.lookupsPending++;
        void this.lookup(p, warm && !!p.sideEffectsOnLookup?.(this.s));
      }
    }
    return this.want(Number.MAX_SAFE_INTEGER);
  }

  /** Stop background checks (ones the viewer asked for keep going). */
  stopBackground() {
    // The flag is what actually stops it. Lowering the target alone wasn't enough: with nothing
    // ready the target stayed at 1, every aborted check went back on its queue, and pump()
    // relaunched it at once, forever.
    this.backgroundStopped = true;
    this.target = this.readyCount();
    for (const t of [this.holdTimer, this.hedgeTimer, this.backupTimer]) clearTimeout(t);
    this.holdTimer = undefined;
    this.hedgeTimer = undefined;
    this.backupTimer = undefined;
    this.backupsHeld = false;
    for (const f of this.inflight.values()) if (!f.user) f.ctl.abort();
    this.changed();
  }

  private isProviderApplicable(p: SourceProvider): boolean {
    if (p.category === "embed") return true;
    return this.isApplicableDirect(p);
  }

  private isApplicableDirect(p: SourceProvider): boolean {
    if (p.category === "embed") return false;
    const isAnime = this.req.media.kind === "anime" || this.req.media.key.startsWith("anilist:");
    if (ANIME_ONLY_DIRECT_IDS.has(p.id)) return isAnime;
    if (ASIAN_DRAMA_DIRECT_IDS.has(p.id)) {
      if (isAnime) return false;
      const lang =
        "originalLanguage" in this.req.media && typeof this.req.media.originalLanguage === "string"
          ? this.req.media.originalLanguage.toLowerCase().split(/[-_]/)[0]
          : undefined;
      return !!lang && ASIAN_DRAMA_LANGS.has(lang);
    }
    if (NO_ANIME_DUB_DIRECT_IDS.has(p.id) && isAnime && (this.req.audio ?? "sub") === "dub") return false;
    return true;
  }

  private applicableDirectExhausted(direct: SourceProvider[]) {
    const anySearching = direct.some((p) => this.lanes.get(p.id)?.status === "searching");
    return !anySearching && this.running(false) === 0 && (!this.directQueue.length || this.autoDirect >= AUTO_DIRECT_CHECKS);
  }

  /**
   * How long embeds wait for direct sources. No applicable direct providers (or all exhausted
   * with zero ready candidates / circuit-open): don't wait. Direct providers that rarely deliver
   * this kind of title: barely wait. Otherwise give them a head start.
   */
  private holdMs(direct: SourceProvider[]) {
    if (!direct.length || !native) return 0;
    const applicable = direct.filter((p) => this.isApplicableDirect(p));
    if (!applicable.length) return 0;
    if (this.readyCount() === 0 && this.applicableDirectExhausted(applicable)) return 0;
    if (applicable.every((p) => isCircuitOpen(p.id))) return 0;
    const kind = this.req.media.kind;
    const best = Math.max(...applicable.map((p) => learnedRank(p.id, kind, 0)));
    // learnedRank(…, 0) is about -14 for a provider that keeps failing and +10 for a dependable one.
    return best < -6 ? 300 : CAPTURE_HOLD_MS;
  }

  private openCapture() {
    if (this.captureOpen) return;
    this.captureOpen = true;
    clearTimeout(this.holdTimer);
    this.pump();
  }

  /** Playback was requested: ask the providers that only previewed again, for real. */
  private activateWarmLookups() {
    const ids = [...this.warmLookups];
    this.warmLookups.clear();
    for (const id of ids) {
      const p = this.providers.find((x) => x.id === id);
      if (!p || this.disposed) continue;
      const lane = this.lanes.get(id);
      if (lane) this.lanes.set(id, { ...lane, status: "searching" });
      this.lookupsPending++;
      void this.lookup(p, false);
    }
  }

  private async lookup(p: SourceProvider, warm = false) {
    if (warm) this.warmLookups.add(p.id);
    const { ctl, cleanup } = linkSignal(this.root.signal);
    const t0 = performance.now();
    let found: StreamCandidate[] = [];
    let failure: { status: "timeout" | "error"; error?: string } | undefined;
    try {
      found = await withTimeout(p.find(this.req, this.s, ctl.signal, { warm }), lookupTimeout(p.id, p.timeoutMs ?? PROVIDER_TIMEOUT), ctl);
      // Learn the time a real search takes. A quick "not here" says nothing about it, and learning
      // from those shrank the timeout until the searches that do find something were cut off.
      if (found.length) recordLookup(p.id, performance.now() - t0);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : undefined;
      failure = { status: msg === "timeout" ? "timeout" : "error", error: msg };
      if (!this.root.signal.aborted && !isDependencyOutage(e)) recordLookupFailure(p.id, Math.round(performance.now() - t0));
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
    this.pump();
    this.evaluate();
    this.changed();
  }

  /* ----------------------------------------------------------- scheduler */

  /** Distinct ready streams that count: duplicate CDN mirrors or wrong titles do not inflate backups. */
  private readyCount() {
    const seen = new Set<string>();
    for (const c of this.cands.values()) {
      if (isUsable(c)) seen.add(streamOf(c));
    }
    return seen.size;
  }

  /** Order for checking: what has worked lately for this kind of title, and for this show. */
  private rankOf(c: StreamCandidate) {
    const pinned = lastPick(this.req);
    const affinity =
      pinned?.providerId === c.providerId && !isCircuitOpen(c.providerId) && !recentlyFailed(c.providerId) ? (pinned.manual ? 40 : 20) : 0;
    return learnedRank(c.providerId, this.req.media.kind, this.prio[c.providerId] ?? 0) + affinity;
  }

  private hasQueuedLocal() {
    return this.directQueue.some((k) => isLocalProvider(this.cands.get(k)?.providerId));
  }

  private takeBest(queue: string[], eligible?: (c: StreamCandidate) => boolean) {
    let bi = -1;
    let best = -Infinity;
    for (let i = 0; i < queue.length; i++) {
      const c = this.cands.get(queue[i]);
      const r = c && (!eligible || eligible(c)) ? this.rankOf(c) : -Infinity;
      if (r > best) {
        best = r;
        bi = i;
      }
    }
    return bi >= 0 ? queue.splice(bi, 1)[0] : undefined;
  }

  private running(capture: boolean) {
    let n = 0;
    for (const f of this.inflight.values()) if (f.capture === capture) n++;
    return n;
  }

  private pump() {
    if (this.disposed || !this.started || this.backgroundStopped) return;
    const wantMore = () => this.readyCount() < this.target;
    const needLocal = () => !this.playedKey && this.hasQueuedLocal();

    // Direct streams: cheap, so check them as they arrive, best first (and always check late local files).
    while (
      this.directQueue.length &&
      this.running(false) < DIRECT_POOL &&
      ((this.autoDirect < AUTO_DIRECT_CHECKS && (wantMore() || !this.pickKey)) || needLocal())
    ) {
      const onlyLocal = !(this.autoDirect < AUTO_DIRECT_CHECKS && (wantMore() || !this.pickKey));
      this.autoDirect++;
      // Round-robin-ish: prefer providers still under their share; past that, the best candidate wins.
      const underShare = (c: StreamCandidate) => (this.autoByProvider.get(c.providerId) ?? 0) < AUTO_DIRECT_PER_PROVIDER;
      const fair =
        !onlyLocal &&
        this.directQueue.some((k) => {
          const c = this.cands.get(k);
          return !!c && underShare(c);
        });
      const key = this.takeBest(
        this.directQueue,
        onlyLocal ? (c) => isLocalProvider(c.providerId) : fair ? underShare : undefined,
      );
      if (!key) break;
      const pid = this.cands.get(key)?.providerId;
      if (pid) this.autoByProvider.set(pid, (this.autoByProvider.get(pid) ?? 0) + 1);
      this.launch(key, false);
    }

    // Embeds: held until direct sources had their chance, or everything direct has answered.
    const fastLane = this.fastLaneKey();
    if (fastLane && wantMore() && this.running(true) === 0) {
      this.captureQueue.splice(this.captureQueue.indexOf(fastLane), 1);
      this.launch(fastLane, false);
    }
    // Before the pick, a ready stream means the pick is a moment away: capturing now would only
    // compete with it. After a Local pick, skip automatic embed backups completely.
    const ready = this.readyCount();
    if (!this.pickKey && ready > 0) return;
    if (this.pickKey && isLocalProvider(this.cands.get(this.pickKey)?.providerId) && this.target < Number.MAX_SAFE_INTEGER) return;
    if (!this.captureOpen && this.directSettled()) this.captureOpen = true;
    if (this.captureOpen && !this.backupsHeld) {
      // Racing for a first stream: several pages at once. Filling backups: no more than are still needed.
      const limit = this.pickKey ? Math.min(CAPTURE_POOL_BACKUP, this.target - ready) : this.hedged ? CAPTURE_POOL_HEDGED : CAPTURE_POOL;
      while (this.captureQueue.length && this.running(true) < limit && wantMore()) {
        const key = this.takeBest(this.captureQueue);
        if (!key) break;
        this.launch(key, false);
      }
      this.armHedge();
    }
  }

  /** The server this show last played from skips the hold (unless Local library is still scanning). */
  private fastLaneKey() {
    if (this.captureOpen || this.pickKey) return undefined;
    const pinned = lastPick(this.req);
    if (!pinned) return undefined;
    if ((this.lanes.get("local")?.status === "searching" || this.lanes.get("downloads")?.status === "searching") && !pinned.manual) return undefined;
    return this.captureQueue.find((k) => this.cands.get(k)?.providerId === pinned.providerId);
  }

  private directSettled() {
    const applicable = this.providers.filter((p) => this.isApplicableDirect(p));
    return this.applicableDirectExhausted(applicable);
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
    // A check that never settles (a hung native call) is a timed-out check, not one to retry.
    let timedOut = false;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const capMs = capture ? CAPTURE_CHECK_CAP_MS : DIRECT_CHECK_CAP_MS;
    const capped = new Promise<StreamCandidate>((resolve) => {
      capTimer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
        resolve({ ...c, probe: { ok: false, latencyMs: capMs, error: "timeout" } });
      }, capMs);
    });
    const promise = Promise.race([
      run.catch((e: unknown): StreamCandidate => ({ ...c, probe: { ok: false, latencyMs: 0, error: e instanceof Error ? e.message : "check failed" } })),
      capped,
    ])
      .then((r) => {
        clearTimeout(capTimer);
        cleanup();
        const mine = this.inflight.get(key);
        if (mine?.promise === promise) this.inflight.delete(key);
        if (this.disposed) return r;
        const cancelled = ctl.signal.aborted && !r.probe?.ok && !timedOut;
        if (cancelled) {
          // Stopped because enough streams were ready: it goes back to waiting, not to failed.
          const back = this.cands.get(key);
          if (back && !back.probe && isEmbed(back) && !this.captureQueue.includes(key)) this.captureQueue.unshift(key);
          else if (back && !back.probe && !isEmbed(back) && !this.directQueue.includes(key)) this.directQueue.unshift(key);
        } else {
          this.learn(r);
          this.put({ ...r, lookupMs: r.lookupMs ?? c.lookupMs });
          if (r.probe?.ok) this.startIdentity(key);
          if (r.probe?.ok && isLocalProvider(r.providerId)) {
            this.cancelSurplus();
            const confirmCand = this.confirming ? this.cands.get(this.confirming) : undefined;
            if (confirmCand && !isLocalProvider(confirmCand.providerId)) this.cancelPendingCommit();
            const curPick = this.pickKey ? this.cands.get(this.pickKey) : undefined;
            if (curPick && !isLocalProvider(curPick.providerId) && !this.playedKey && !this.manual.has(this.pickKey!)) {
              this.pickKey = undefined;
              this.setPick(key);
            }
          } else if (r.probe?.ok && this.pickKey && this.readyCount() >= this.target) {
            // Only once a pick exists: before that, a capture still running may be the better stream.
            this.cancelSurplus();
          }
        }
        this.evaluate();
        this.pump();
        this.changed();
        return this.cands.get(key) ?? r;
      });
    this.inflight.set(key, { ctl, promise, user, capture, ownedByVerify: user });
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
    // One vote per provider per session, however many files it returned. A success counts at once;
    // a failure only once none of the provider's other mirrors is still waiting or being checked,
    // so mirror #1 dying 50 ms before mirror #2 plays doesn't mark the provider as broken.
    if (this.recorded.has(r.providerId)) return;
    if (!r.probe.ok && this.hasPendingFor(r.providerId, candKey(r))) return;
    this.recorded.add(r.providerId);
    recordProbe(r);
  }

  private hasPendingFor(providerId: string, exceptKey: string) {
    const pending = (k: string) => k !== exceptKey && this.cands.get(k)?.providerId === providerId;
    if (this.directQueue.some(pending) || this.captureQueue.some(pending)) return true;
    for (const k of this.inflight.keys()) if (pending(k)) return true;
    return false;
  }

  private put(c: StreamCandidate) {
    const scored = score(c, this.s.preferredQuality, this.prio[c.providerId] ?? 0, this.req);
    this.cands.set(candKey(c), scored);
    this.dirty = true;
    return scored;
  }

  /* ------------------------------------------------------ is it this title? */

  private expectation() {
    return (this.expected ??= expectedRuntime(this.req).catch(() => null));
  }

  private wantsIdentity(c: StreamCandidate) {
    return (
      !!this.identityCheck &&
      !!c.probe?.ok &&
      !c.identity &&
      (c.kind === "hls" || c.kind === "dash") &&
      !isLocalProvider(c.providerId) &&
      c.providerId !== "manual" &&
      !isMagnet(c)
    );
  }

  /**
   * A stream is ready: compare its length with the catalog runtime. A probable mismatch is demoted,
   * never auto-picked and never used as a backup; the viewer can still choose it from the list.
   */
  private startIdentity(key: string) {
    const c = this.cands.get(key);
    if (!c || this.disposed || this.identityInflight.has(key) || !this.wantsIdentity(c)) return;
    const { ctl, cleanup } = linkSignal(this.root.signal);
    this.identityInflight.set(key, ctl);
    const timer = setTimeout(() => ctl.abort(), IDENTITY_MS);
    const url = c.url;
    void this.identityCheck!(c, ctl.signal)
      .catch(() => null)
      .then((verdict) => {
        clearTimeout(timer);
        cleanup();
        if (this.identityInflight.get(key) === ctl) this.identityInflight.delete(key);
        if (this.disposed) return;
        const cur = this.cands.get(key);
        // Nothing to compare, or a check cut short: "unknown", which never holds anything up again.
        if (cur && cur.url === url && !cur.identity) this.put({ ...cur, identity: verdict ?? { status: "unknown" } });
        this.evaluate();
        this.pump();
        this.changed();
      });
    this.changed();
  }

  /* ------------------------------------------------------------- picking */

  /** Best ready stream. A probable different title only with `any` (the viewer said "play now"). */
  private bestReady(except?: string, any = false) {
    let best: StreamCandidate | undefined;
    for (const c of this.cands.values()) {
      if (!c.probe?.ok || candKey(c) === except) continue;
      if (!any && isSuspect(c)) continue;
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

  /** Local library or saved downloads are still scanning or probing on this PC: hold off before locking an online stream. */
  private localPending(best: StreamCandidate) {
    if (isLocalProvider(best.providerId)) return false;
    if (this.lanes.get("local")?.status === "searching" || this.lanes.get("downloads")?.status === "searching") return true;
    for (const k of this.directQueue) if (isLocalProvider(this.cands.get(k)?.providerId)) return true;
    for (const k of this.inflight.keys()) if (isLocalProvider(this.cands.get(k)?.providerId)) return true;
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
    this.graceTimer = undefined;
    this.firstReadyAt = -Infinity;
    this.pickAny = true;
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
    const left = this.localPending(best)
      ? LOCAL_GRACE_MS - waited
      : this.chosenPending(best)
        ? CHOICE_GRACE_MS - waited
        : this.canBeBeaten(best)
          ? GRACE_MS - waited
          : 0;
    clearTimeout(this.graceTimer);
    if (left > 0) {
      this.graceTimer = setTimeout(() => this.commit(), left);
      return;
    }
    this.commit();
  }

  private cancelPendingCommit() {
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.commitGen++;
    if (this.confirmCtl) {
      this.confirmCtl.abort();
      this.confirmCtl = undefined;
    }
    this.confirming = undefined;
  }

  /** Does the would-be pick still need its first segment fetched for real? */
  private needsConfirm(c: StreamCandidate) {
    if (this.confirmed.has(candKey(c))) return false;
    if (isLocalProvider(c.providerId) || c.providerId === "manual" || isEmbed(c) || isMagnet(c)) return false;
    if (c.kind === "file") return false;
    if (c.via === "sniffed" && isAbxsProxied(c.url) && !isUrlTokenExpired(c.url)) return false;
    return c.kind === "hls";
  }

  private commit() {
    if (this.disposed || this.pickKey || this.confirming) return;
    const best = this.bestReady(undefined, this.pickAny);
    if (!best) return;
    const key = candKey(best);
    // Its runtime check finishing (or giving up) re-evaluates, and commits then.
    const identityPending = () => !this.pickAny && this.identityInflight.has(key);
    if (!this.needsConfirm(best)) {
      if (identityPending()) return;
      return this.setPick(key);
    }

    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    const gen = ++this.commitGen;
    this.confirming = key;
    const { ctl, cleanup } = linkSignal(this.root.signal);
    this.confirmCtl = ctl;
    this.changed();
    const timer = setTimeout(() => ctl.abort(), CONFIRM_MS);
    this.deps
      .confirm(best, ctl.signal)
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : "timeout" }) as { ok: boolean; quality?: number; error?: string })
      .then((res) => {
        clearTimeout(timer);
        cleanup();
        if (this.disposed || gen !== this.commitGen) return;
        this.confirmCtl = undefined;
        this.confirming = undefined;
        this.confirmed.add(key);
        if (this.pickKey) return;
        const cur = this.cands.get(key);
        if (!cur?.probe?.ok || (isSuspect(cur) && !this.pickAny)) return this.evaluate();
        // Too slow to say is not a no: the player's own watchdog is the last word.
        if (res.ok || SOFT_CONFIRM_ERRORS.test(res.error ?? "") || ctl.signal.aborted) {
          if (res.ok && res.quality && !cur.probe.quality) this.put({ ...cur, quality: res.quality, probe: { ...cur.probe, quality: res.quality } });
          if (identityPending()) {
            this.changed();
            return;
          }
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
    if (this.disposed || this.pickKey === key) return;
    this.pickKey = key;
    this.pickAny = false;
    this.pickMs ??= Math.round(performance.now() - this.t0);
    clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    clearTimeout(this.hedgeTimer);
    this.hedgeTimer = undefined;
    // Backups wait a moment so the stream that's about to start gets the bandwidth.
    // Local files play directly from disk, so never spin up background embed captures for them.
    const pickedIsLocal = isLocalProvider(this.cands.get(key)?.providerId);
    if (!pickedIsLocal && !this.backgroundStopped && this.readyCount() < this.target && this.captureQueue.length) {
      this.backupsHeld = true;
      this.captureOpen = true;
      clearTimeout(this.backupTimer);
      this.backupTimer = setTimeout(() => {
        this.backupTimer = undefined;
        this.backupsHeld = false;
        this.pump();
        this.changed();
      }, BACKUP_DELAY_MS);
    }
    if (pickedIsLocal || this.readyCount() >= this.target) this.cancelSurplus();
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
      // A failed stream that was captured from a page is re-captured from that page, not
      // re-fetched. Only captured ones: a direct extractor's `pageUrl` is just its site address.
      const recapture = !isEmbed(c) && c.via === "sniffed" && !!c.pageUrl && !!c.probe && !c.probe.ok;
      if (c.probe && !c.probe.ok) this.put({ ...c, probe: undefined });
      void this.launch(key, true, recapture);
      f = this.inflight.get(key)!;
    }
    const mine = f;
    if (!signal) {
      mine.pinned = true;
      return mine.promise;
    }
    mine.waiters = (mine.waiters ?? 0) + 1;
    return new Promise((resolve) => {
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        mine.waiters = Math.max(0, (mine.waiters ?? 1) - 1);
      };
      const onAbort = () => {
        leave();
        // Cancel only a check `verify()` started, and only once nobody else is waiting on it.
        if (mine.ownedByVerify && !mine.pinned && mine.waiters === 0) mine.ctl.abort();
        resolve(null);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      void mine.promise.then((r) => {
        signal.removeEventListener("abort", onAbort);
        leave();
        resolve(signal.aborted ? null : r);
      });
    });
  }

  /**
   * A sniffed stream's link expired mid-play: capture its page again. A direct extractor's
   * `pageUrl` is an API or site address, not a player page, so it is never captured: the stream is
   * reported expired and the player fails over to the next ready candidate.
   */
  async refresh(key: string, signal?: AbortSignal): Promise<StreamCandidate | null> {
    const c = this.cands.get(key);
    if (!c?.pageUrl) return null;
    if (!isEmbed(c) && c.via !== "sniffed") {
      return { ...c, probe: { ok: false, latencyMs: c.probe?.latencyMs ?? 0, error: "expired stream" } };
    }
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
  report(key: string, ok: boolean, info: { latencyMs?: number; quality?: number; error?: string; durationSec?: number } = {}) {
    const c = this.cands.get(key);
    if (!c) return;
    if (ok) {
      const quality = c.probe?.quality ?? info.quality ?? c.quality;
      const latencyMs = c.probe?.ok && c.probe.latencyMs > 0 ? c.probe.latencyMs : (info.latencyMs ?? 0);
      const live = this.put({ ...c, quality, probe: { ok: true, latencyMs, quality } });
      // The player's own duration is the best evidence of what is really playing.
      if (this.identityCheck && info.durationSec && Number.isFinite(info.durationSec) && info.durationSec > 0) {
        const durationSec = info.durationSec;
        void this.expectation().then((exp) => {
          const cur = this.cands.get(key);
          if (!exp || !cur || this.disposed) return;
          this.put({ ...cur, identity: judgeRuntime(durationSec, exp) });
          this.changed();
        });
      }
      this.confirmed.add(key);
      this.playedKey = key;
      if (!this.pickKey) {
        this.cancelPendingCommit();
        this.pickKey = key;
      }
      recordPlayback(this.req, live, true, this.manual.has(key) ? { manual: true } : {});
      recordWin(live.providerId, this.req.media.kind, true);
    } else {
      if (this.confirming === key) this.cancelPendingCommit();
      this.put({ ...c, probe: { ok: false, latencyMs: c.probe?.latencyMs ?? 0, error: info.error || "won't play" } });
      this.manual.delete(key);
      if (this.playedKey === key) this.playedKey = undefined;
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
    if (this.disposed || signal?.aborted) return null;
    const token = ++this.failoverToken;
    // Two servers often capture the very same CDN playlist: when it dies, its twin is no backup.
    const dead = this.cands.get(deadKey);
    const deadStream = dead && !isEmbed(dead) ? streamOf(dead) : undefined;
    const usable = () =>
      [...this.cands.values()]
        .filter((c) => candKey(c) !== deadKey && isUsable(c) && !isEmbed(c) && (!deadStream || streamOf(c) !== deadStream))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    const accept = (winner: StreamCandidate) => {
      this.cancelPendingCommit();
      const winKey = candKey(winner);
      if (this.pickKey !== winKey) {
        this.pickKey = undefined;
        this.setPick(winKey);
      }
      return winner;
    };
    const now = usable();
    if (now) return accept(now);
    this.backgroundStopped = false;
    this.backupsHeld = false;
    clearTimeout(this.backupTimer);
    this.backupTimer = undefined;
    this.captureOpen = true;
    this.hedged = false;
    this.autoDirect = Math.min(this.autoDirect, AUTO_DIRECT_CHECKS - DIRECT_POOL);
    this.target = Math.max(this.target, this.readyCount() + 1);
    this.pump();
    this.changed();
    return this.until((s) => {
      if (token !== this.failoverToken) return null;
      const w = usable();
      if (w) return accept(w);
      return s.busy ? undefined : null;
    }, signal).then((v) => v ?? null);
  }

  /** A stream link the viewer pasted. */
  addManual(url: string) {
    this.cancelPendingCommit();
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
    this.cancelPendingCommit();
    let first: StreamCandidate | undefined;
    for (const c of [...this.cands.values()]) {
      // Only real player pages: a direct extractor's site address is not something to play in a frame.
      if (!c.pageUrl || c.probe?.ok || !(isEmbed(c) || c.via === "sniffed")) continue;
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
  // The resolved request (cour episode, absolute number, mapped ids) is part of the identity: a
  // session started from the provisional request must not be reused once the real one is known.
  `${reqKey(req)}|${JSON.stringify([req.courEpisode ?? null, req.absolute ?? null, req.media.malId ?? null, req.media.anilistId ?? null, req.media.tmdbId ?? null])}|${JSON.stringify([s.downloadsPath ?? "", s.libraryPaths, s.jellyfin.enabled && s.jellyfin.url, s.disabledSources, s.enabledExtras, s.preferredQuality])}|${epoch}`;

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
  clearLocalScanCache();
  for (const [k, s] of sessions) {
    s.invalidate();
    sessions.delete(k);
  }
}

if (typeof window !== "undefined") {
  onDownloadsChanged(() => invalidateSessions());
}
