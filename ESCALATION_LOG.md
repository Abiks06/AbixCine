# AbixCine Architectural Escalation Log (For Argon)

Items listed below require multi-file concurrency, `AbortController` / IPC cancellation, WebGPU resource synchronization, proxy/manifest rewriting, or cross-cutting state refactoring and were intentionally left untouched in code per triage policy.

---

### ESC-01: Multi-cour / multi-season AniList playback desync between `Title.tsx` and `Watch.tsx` [RESOLVED]
- **Status:** Resolved in `src/pages/Watch.tsx`, `src/lib/normalizer.ts`, `src/lib/catalog.ts`, `src/sources/embeds.ts`, `src/sources/anime-direct.ts`, and `src/__tests__/matching.test.ts`.
- **Severity:** High
- **Exact Locations:** `src/pages/Watch.tsx:53-65`, `src/pages/Watch.tsx:100-122`, `src/pages/Watch.tsx:200-216`
- **Root-Cause Hypothesis:** `Watch.tsx` still computes `season`, `episode`, `absolute`, `next`, and the drawer's `episodes` using raw `d.seasons`, `animeSeasons(key)`, and `animeEpisodes(key)` instead of the canonical multi-cour reconciliation helpers (`resolvePlaybackRequest` / `getSeasonEpisodes` from `src/lib/normalizer.ts` and `src/lib/catalog.ts`). For split-cour or reconciled AniList series (where one canonical season stitches multiple AniList entries with distinct `malId`s and `courEpisode` offsets), `Watch.tsx` sends season-relative episode numbers against the root entry's `malId` and cannot navigate seamlessly across stitched cours inside the player drawer or `UpNext`.
- **Constraints & Edge Cases:** Preserve backward-compatible routing (`/watch/:encodedKey?s=&e=&a=`) for direct links, TMDB TV shows (`tmdb:tv:<id>`), standalone AniList movies, offline/cached `MediaDetail` fallbacks from progress/watchlist (`savedEntry`), and all `ARCHITECTURE.md` source-resolver inputs (`PlaybackRequest.media`, `malId`, `season`, `episode`, `absolute`, `audio`).
- **Argon Handoff Prompt:**
  Refactor `src/pages/Watch.tsx` to derive the active season, episode, per-cour target `media`/`malId`, canonical episode count, and `next` navigation target via `resolvePlaybackRequest` and `getSeasonEpisodes` from `src/lib/normalizer.ts` and `src/lib/catalog.ts`, matching `src/pages/Title.tsx`. Update `episodes` (`EpisodeNav`) so multi-cour AniList shows use stitched season episodes cleanly without breaking TMDB series, standalone movies, or offline fallback metadata from `savedEntry`. Preserve existing URL query parameters (`s`, `e`, `a`, `srv`) and verify against `src/__tests__/matching.test.ts` plus new cour-handoff unit tests.

---

### ESC-02: WebGPU timestamp query buffer race under `MAX_INFLIGHT = 2` and GPU pipeline leaks on rebuild [RESOLVED]
- **Status:** Resolved in `src/lib/enhance.ts` and `src/lib/enhance.test.ts`.
- **Severity:** High
- **Exact Locations:** `src/lib/enhance.ts:232-275`, `src/lib/enhance.ts:608-622`, `src/lib/enhance.ts:715-770`
- **Root-Cause Hypothesis:** `enhance.ts` allows up to two command submissions in flight (`MAX_INFLIGHT = 2`), but allocates a single shared `qset`, `qbuf`, and `rbuf` for GPU timestamp measurement while setting `reading = true` only inside the async `.onSubmittedWorkDone()` callback. Frame N+1 can evaluate `!reading` and enqueue `resolveQuerySet`/`copyBufferToBuffer` onto `qbuf`/`rbuf` while Frame N is already mapping or about to map `rbuf`, causing WebGPU buffer-use conflicts or misattributed timings. Additionally, `buildChain()` inside `setup()` creates new `Anime4KPipeline` instances and an `input` `GPUTexture` on resize/downgrade without explicitly destroying the prior `pipes` resources or previous `input` texture first.
- **Constraints & Edge Cases:** Preserve graceful degradation from WebGPU Anime4K down to the WebGL2 CAS path (`startEnhancer`), keep performance governor downgrades and `"off"` fallback behavior intact, and maintain compatibility with all mocks and assertions in `src/lib/enhance.test.ts`.
- **Argon Handoff Prompt:**
  Audit GPU resource lifecycles and timestamp readback synchronization in `src/lib/enhance.ts`. Gate timestamp capture with an explicit in-flight stamp state before `enc.finish()` (or double-buffer `rbuf`/`qbuf` per stamped frame) so concurrent frames under `MAX_INFLIGHT = 2` never race on `rbuf.mapAsync`, and ensure `setup()` / `stop()` deterministically destroy prior `input` textures and any disposable `Anime4KPipeline` outputs before reallocating. Preserve the WebGL2 fallback path, governor step-downs, and passing behavior in `src/lib/enhance.test.ts`.

---

### ESC-03: Uncancelled Rust `sniff_media` WebView2 instances and `AbortSignal` listener leaks [RESOLVED]
- **Status:** Resolved in `src/sources/native.ts`, `src-tauri/src/shield.rs`, `src-tauri/src/lib.rs`, and `src/sources/registry.ts`.
- **Severity:** High
- **Exact Locations:** `src/sources/native.ts:150-168`, `src-tauri/src/shield.rs:404-420`, `src/sources/registry.ts:320-326`, `src/sources/registry.ts:514-518`, `src/sources/registry.ts:758-762`
- **Root-Cause Hypothesis:** Aborting a JS `sniff()` call immediately resolves `null` on the JS Promise wrapper, but the underlying Tauri IPC `sniff_media` command continues executing its off-screen WebView2 load, CDP click loop, and ad/network capture until Rust's 20s timeout expires, tying up the Rust concurrency `Semaphore(4)`. Inside `src/sources/registry.ts`, `fetchRetry` performs an un-cancellable 1.2s `setTimeout` backoff that ignores `init.signal` if aborted mid-sleep, and `resolveSources` attaches an `abort` listener to `opts.signal` without `{ once: true }` or removal in `finish()`.
- **Constraints & Edge Cases:** Preserve `ARCHITECTURE.md` Section 1 guarantees (`sniff_media` semaphore throttling, HTTP `>= 400` suppression, redirect-aware manifest validation) and keep `probeHedged` early-abort cancellation tests in `src/sources/registry.test.ts` green.
- **Argon Handoff Prompt:**
  Add cooperative IPC cancellation for `sniff_media` across `src/sources/native.ts` and `src-tauri/src/shield.rs` (passing a cancellation token/request ID from JS `AbortSignal` to a Rust `cancel_sniff` command that drops the active task and destroys the `sniff-*` WebView2 window immediately). Also update `fetchRetry` (`src/sources/registry.ts:320-326`) to abort its retry delay cleanly when `init.signal` fires, and ensure `resolveSources` / `probeHedged` remove their `opts.signal` `abort` listeners on completion.

---

### ESC-04: `Player.tsx` failover, server-switch, and token-refresh concurrency without shared `AbortController` lifecycles [RESOLVED]
- **Status:** Resolved in `src/components/Player.tsx`.
- **Severity:** High
- **Exact Locations:** `src/components/Player.tsx:228-273`, `src/components/Player.tsx:724-734`, `src/components/Player.tsx:992-1008`
- **Root-Cause Hypothesis:** Multiple async flows in `Player.tsx` (`failover`'s `probeHedged(standbys)`, `switchTo`'s `await verifyEmbed(c)`, and stream attachment's `verifyEmbed(c)` when `isUrlTokenExpired` triggers) launch unlinked async verification without a per-attempt or component-unmount `AbortController`. Rapidly clicking servers in `ServerList`, navigating episodes, or triggering back-to-back playback failures allows an earlier `verifyEmbed` or `probeHedged` resolution to overwrite `patched`, `checking`, or `idx` out of order.
- **Constraints & Edge Cases:** Preserve `ARCHITECTURE.md` hedged failover semantics (`probeHedged`, standby verification only on demand, `isUrlTokenExpired` refresh before playback) and keep `onSourceResult` reporting accurate for `health.ts`.
- **Argon Handoff Prompt:**
  Introduce explicit `AbortController` and generation/request guards for `failover`, `switchTo`, and expired-token `verifyEmbed` refreshes inside `src/components/Player.tsx`. Cancel in-flight standby probes and embed verifications when the user picks another server, switches episodes, or unmounts the player, and discard stale `setPatched` / `setIdx` / `setChecking` updates cleanly while preserving `ARCHITECTURE.md` failover and health reporting behavior.

---

### ESC-05: Rust `stream.rs` HLS multi-URI tag rewriting and DASH `.mpd` manifest proxying gaps [RESOLVED]
- **Status:** Resolved in `src-tauri/src/stream.rs`.
- **Severity:** Medium
- **Exact Locations:** `src-tauri/src/stream.rs:154-184`, `src-tauri/src/stream.rs:231-282`
- **Root-Cause Hypothesis:** `rewrite_playlist` uses `l.find("URI=\"")` once per `#` tag line, so HLS lines containing more than one `URI="..."` attribute (e.g., `#EXT-X-SESSION-KEY` or custom multi-URI tags) only have their first URI rewritten through the header-injecting local `abxs://` proxy. Furthermore, while `src/sources/types.ts` supports `StreamKind` `"dash"` and `ARCHITECTURE.md` documents `.mpd` manifest validation, `stream.rs` only inspects `.m3u8` / `#EXTM3U` responses and passes `.mpd` XML through verbatim, meaning relative `<BaseURL>` / `<SegmentTemplate>` / `<SegmentURL>` paths fail when a CDN requires `Referer`/`Origin` headers or redirects.
- **Constraints & Edge Cases:** Preserve `ARCHITECTURE.md` Section 1 post-redirect `PLAYLISTS` base-URL resolution, disguised-segment PNG/WebP unwrapping, and range-capped progressive streaming behavior in `src-tauri/src/stream.rs`.
- **Argon Handoff Prompt:**
  Extend manifest rewriting in `src-tauri/src/stream.rs` so `rewrite_playlist` iteratively rewrites all `URI="..."` attributes on every `#` tag line rather than stopping after the first match, and add `.mpd` DASH manifest detection and XML URL rewriting (`BaseURL`, `initialization`, `media`) through `proxied()` using the post-redirect `final_url`. Verify existing HLS proxy caching (`PLAYLISTS`), disguised TS unwrapping, and byte-range handling remain unchanged.

---

### ESC-06: `ARCHITECTURE.md` vs `src/sources/health.ts` scoring formula and field naming drift [RESOLVED]
- **Status:** Resolved in `src/sources/health.ts` and `ARCHITECTURE.md`.
- **Severity:** Low
- **Exact Locations:** `src/sources/health.ts:18`, `src/sources/health.ts:231-240`, `ARCHITECTURE.md:10-12`
- **Root-Cause Hypothesis:** `ARCHITECTURE.md` documents `ProviderHealth.latencyMs`, a circuit penalty of `-45`, and a latency term `max(-8, 12 - latencyMs/400)` plus show-level `picks`/`wins` contributions inside `serverHealthScore`, whereas `src/sources/health.ts` stores `latency` (not `latencyMs`), applies `-35` for open circuits and `Math.max(-8, Math.min(6, (2500 - rtt) / 400))` for speed, and handles `picks`/`wins` externally in `registry.ts`. Because `health.ts`, `registry.ts`, `Settings.tsx`, and `registry.test.ts` all depend on the current schema and score weights, reconciling them is a cross-file design decision.
- **Constraints & Edge Cases:** Keep persisted `localStorage` `ProviderHealth` data backward-compatible across app updates (`latency` vs `latencyMs`), and keep `src/sources/registry.test.ts` circuit-breaker and ranking invariants intact.
- **Argon Handoff Prompt:**
  Reconcile the documented `ProviderHealth` and `serverHealthScore` specification in `ARCHITECTURE.md` with the runtime implementation in `src/sources/health.ts` and `src/sources/registry.ts` (either updating `ARCHITECTURE.md` to reflect the tuned `-35` / `(2500 - rtt) / 400` weights and `latency` field, or migrating `health.ts` with a `localStorage` backward-compatibility read while updating `src/sources/registry.test.ts`).

---

### ESC-07: Unbounded `tmdbResolutionMap` cache and year/signal-unaware TMDB lookup in `embeds.ts` [RESOLVED]
- **Status:** Resolved in `src/sources/embeds.ts`.
- **Severity:** Medium
- **Exact Locations:** `src/sources/embeds.ts:179`, `src/sources/embeds.ts:188-246`
- **Root-Cause Hypothesis:** `tmdbResolutionMap` in `src/sources/embeds.ts` grows without bound across a session and caches resolved IDs by `req.media.key` without considering `req.media.year` during `searchTmdb(q)` matching or accepting an `AbortSignal`. Remakes or homonymous titles can resolve to the wrong TMDB ID and remain pinned for the lifetime of the app session, and cancelled embed lookups still run up to three sequential `searchTmdb` calls to completion.
- **Constraints & Edge Cases:** Preserve `ARCHITECTURE.md` Section 3 behavior ("transient-safe TMDB ID caching" so `null` results never stay cached on network failures) and keep multi-provider deduplication in `createEmbedProvider` fast.
- **Argon Handoff Prompt:**
  Update `resolveTmdbId` in `src/sources/embeds.ts` to accept an optional `AbortSignal`, score/prefer `searchTmdb` candidates matching `req.media.year` and `kind` (avoiding remake collisions), and bound `tmdbResolutionMap` (e.g., LRU cap) while preserving transient-null eviction on failed lookups. Ensure concurrent providers sharing `resolveTmdbId` handle individual caller aborts safely without poisoning shared lookups.

---

### ESC-08: `Auth.tsx` async unmount cancellation and `wakeServer` abort lifecycle [RESOLVED]
- **Status:** Resolved in `src/pages/Auth.tsx` and `src/lib/account.ts`.
- **Severity:** Low
- **Exact Locations:** `src/pages/Auth.tsx:22-54`, `src/lib/account.ts:214-222`
- **Root-Cause Hypothesis:** Navigating away from `Auth.tsx` while `loadAnimeFeed` or the Render wake-up polling loop (`wakeServer`) is active leaves the 3-second polling interval/sleep loop running or triggers React state setters after unmount (a Bucket A unmount patch hit a `wakeServer(onTick, maxMs, signal)` signature mismatch under the One-Strike Rule and was reverted).
- **Constraints & Edge Cases:** Preserve `account.ts` Render cold-start wake UX (`wakeServer` elapsed seconds display and auto-retry once `/health` responds) and avoid breaking callers of `wakeServer`.
- **Argon Handoff Prompt:**
  Clean up async lifecycles in `src/pages/Auth.tsx` and `src/lib/account.ts`: pass `undefined` for `maxMs` plus an `AbortSignal` (`wakeServer(onTick, undefined, signal)`) or refactor `wakeServer` options so `Auth.tsx` cleanly aborts polling and guards `setPosters`/`setWaking`/`setBusy`/`setErr` on unmount, while letting its `setTimeout(..., 3000)` wake loop resolve early on `signal.abort`.

---

## Audit Pass 2 — New Escalations (`ESC-09` to `ESC-11`)

### ESC-09: DASH `.mpd` manifest rewriting breaks `<SegmentTemplate>` tokens & `<BaseURL>` scope — **RESOLVED**
- **Severity:** High
- **Exact Locations:** `src-tauri/src/stream.rs:150-355`
- **Resolution:** Refactored `rewrite_mpd` into a hierarchical XML tag scanner that tracks `<MPD>`, `<Period>`, `<AdaptationSet>`, and `<Representation>` scopes on a stack, matches `<BaseURL>` tags with or without attributes (e.g. `serviceLocation="..."`), and preserves unexpanded `<SegmentTemplate>` tokens (`$Number$`, `$Time$`, `$RepresentationID$`, `$Bandwidth$`) outside Base64 via `&t=` query parameters resolved in `handle()`. Updated `cached_playlist` handling in `handle()` to rewrite cached `.mpd` manifests via `rewrite_mpd` (`application/dash+xml`). Added Rust unit test `rewrites_dash_mpd_scoped_base_urls_and_segment_templates`.

---

### ESC-10: Multi-cour anime `audioFor` preference & progress key fragmentation across cour keys — **RESOLVED**
- **Severity:** Medium
- **Exact Locations:** `src/lib/settings.ts:81-97`, `src/lib/progress.ts:51-120`, `src/lib/play.ts:18-40`, `src/pages/Title.tsx:101-188`, `src/pages/Watch.tsx:46-165`
- **Resolution:** Unified `audioFor`/`setAudioFor`, `saveProgress`, `getProgress`, `getEntry`, and `playTarget` around `canonicalKey` while accepting fallback/alias cour keys so multi-cour AniList entries persist and read sub/dub preferences and watch progress consistently across cour transitions and legacy `localStorage` entries.

---

### ESC-11: WebGL2 fallback nullable resource creation without context-loss guard — **RESOLVED**
- **Severity:** Low
- **Exact Locations:** `src/lib/enhance.ts:360-405`
- **Resolution:** Removed the `gl.createProgram()!` non-null assertion, added `gl.isContextLost()` and null checks for `createShader()`, `createProgram()`, `createVertexArray()`, and `createTexture()`, and cleaned up allocated WebGL resources before rejecting cleanly. Added unit test coverage in `src/lib/enhance.test.ts`.

---

## Audit Pass 3 — New Escalations (`ESC-12` to `ESC-13`)

### ESC-12: Rust `stream.rs` `rewrite_mpd` emits unescaped `&` in XML attributes / `<BaseURL>` text, omits `&amp;` unescaping, and limits `.mpd` sniffing to 512 bytes — **RESOLVED**
- **Severity:** High
- **Exact Locations:** `src-tauri/src/stream.rs:149-181`, `src-tauri/src/stream.rs:325-345`, `src-tauri/src/stream.rs:390-445`, `src-tauri/src/stream.rs:484-490`, `src-tauri/src/stream.rs:584-638`
- **Resolution:** Added `xml_unescape` and `xml_escape` in `src-tauri/src/stream.rs` so incoming XML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`) in `<BaseURL>` text and segment attributes are unescaped before URL resolution/Base64 encoding, rewritten proxy URLs emitted into `.mpd` XML escape `&` as `&amp;` (leaving HLS `#EXTM3U` rewriting untouched), and `<MPD` body sniffing scans an 8 KB window (`MPD_SNIFF_WINDOW = 8192`). Updated Rust unit tests `rewrites_dash_mpd_urls` and `rewrites_dash_mpd_scoped_base_urls_and_segment_templates`.

---

### ESC-13: `account.ts` `raw()` overwrites `init.signal`, `syncCache` caches failed promises, and outbox `push()` pops before completion — **RESOLVED**
- **Severity:** Medium
- **Exact Locations:** `src/lib/account.ts:117-159`, `src/lib/account.ts:281-300`, `src/lib/account.ts:326-341`
- **Resolution:** Updated `raw()` in `src/lib/account.ts` to compose caller `init.signal` with its timeout `AbortController`, clean up the abort listener in `finally`, and avoid flipping `state.online` or reporting `"timeout"` on caller aborts. Updated `fetchSync()` to evict `syncCache` immediately on rejection, and updated `push()` to persist pending mutations in `OUTBOX` before `api()` and remove them only after `api()` resolves or fails with a non-retryable 4xx error.

---

## Audit Pass 4 — New Escalations (`ESC-14`)

### ESC-14: Expired-token refresh in `Player.tsx` can hang playback or trigger unhandled rejection — **RESOLVED**
- **Severity:** High
- **Exact Locations:** `src/components/Player.tsx:641`, `src/components/Player.tsx:692-795`
- **Resolution:** Updated the expired-token pre-attach refresh flow in `src/components/Player.tsx` to catch `verifyEmbed` rejections and route them to `failover`, track refreshed candidates via `refreshedUrlsRef` to prevent infinite re-refresh loops when a refreshed URL still carries an expired timestamp, and invoke `attachStream(refreshed)` directly when `refreshed.url === c.url`.

---

## Audit Pass 5 — New Escalations (`ESC-15` to `ESC-16`)

### ESC-15: WebGPU `enhance.ts` mid-stream `setup()` destroys active resources while `inflight > 0` and `govern()` `"off"` omits `stop()` — **RESOLVED**
- **Severity:** Medium
- **Exact Locations:** `src/lib/enhance.ts:644-715`, `src/lib/enhance.ts:831-870`, `src/lib/enhance.ts:920-930`, `src/lib/enhance.ts:1005-1015`
- **Resolution:** Added `releaseResources` and `flushRetired` in `src/lib/enhance.ts` to queue prior `input` textures and `Anime4KPipeline` chains in `retired` whenever `inflight > 0` and destroy them once in-flight GPU work completes, guarded `!built.pipes.length` in `setup()`, and called `stop()` inside `govern()` when stepping down to `"off"`. Verified in `src/lib/enhance.test.ts`.

---

### ESC-16: Cross-cutting schema alignment for `Media.originalLanguage` and `Settings.enabledExtras` — **RESOLVED**
- **Severity:** Low
- **Exact Locations:** `src/lib/types.ts:28-32`, `src/lib/tmdb.ts:126-130`, `src/lib/watchlist.ts:38-48`, `src/lib/progress.ts:64-66`, `src/lib/settings.ts:44-90`, `src/sources/embeds.ts:329-332`, `src/pages/Settings.tsx:196-200`
- **Resolution:** Added optional `originalLanguage?: string` to `Media` in `src/lib/types.ts` and populated it in `tmdb.ts` `toMedia()`. Standardized `Settings.enabledExtras` and `Settings.disabledSources` via `normalizeSourceToggles` in `src/lib/settings.ts` and enforced both consistently in `createEmbedProvider.isEnabled` (`src/sources/embeds.ts`), `isSourceEnabled`, and `src/pages/Settings.tsx`.
