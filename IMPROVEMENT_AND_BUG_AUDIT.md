# AbixCine v1.7.0+ Comprehensive Security, Bug, Performance & Next-Gen UI Audit

**Target Baseline:** `abixcine@1.7.0+` (`7e698c7` + `2026-11-15` Live Server/Extractor/Capture Upgrade)  
**Stack:** Tauri v2 Desktop (Rust + WebView2 + `adblock-rust` + `librqbit`) · React 18.3 / TypeScript 5.6 / Vite 5.4 ("Projection" UI) · Fastify 5 / PostgreSQL (`pg` + `@electric-sql/pglite`) Sync & TMDB Proxy API  
**Audit Scope:** Full read-only verification across all 5 core subsystems:
1. **Rust / Tauri Backend & Build Layer:** [lib.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs), [stream.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/stream.rs), [shield.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/shield.rs), [torrent.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/torrent.rs), [Cargo.toml](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/Cargo.toml), [tauri.conf.json](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/tauri.conf.json), [prepare-ffmpeg.mjs](file:///c:/Users/Ayomide/Documents/abixcine/scripts/prepare-ffmpeg.mjs), [release.yml](file:///c:/Users/Ayomide/Documents/abixcine/.github/workflows/release.yml)
2. **Source Resolution, 17 Direct Extractors, Plugins, Debrid & Stremio:** [registry.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/registry.ts), [session.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/session.ts), [health.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/health.ts), [native.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/native.ts), [embeds.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/embeds.ts), [stremio.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/stremio.ts), [pluginRunner.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/pluginRunner.ts), [debrid.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/debrid.ts), [local.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/local.ts), [jellyfin.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/jellyfin.ts), [kisskh.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/kisskh.ts), [anime-direct.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/anime-direct.ts), and all 19 files in [src/sources/extractors/](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/index.ts)
3. **Video Player, WebGPU/WebGL2 Anime4K, Subtitles, JASSUB & Skip Segments:** [Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx), [Watch.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx), [enhance.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/enhance.ts), [SubtitleOverlay.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SubtitleOverlay.tsx), [SubtitleSheet.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SubtitleSheet.tsx), [subtitles.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/subtitles.ts), [subtitleProviders.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/subtitleProviders.ts), [skipSegments.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/skipSegments.ts), [SourceBoard.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SourceBoard.tsx), [SmartSource.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SmartSource.tsx)
4. **Catalog, Multi-Cour Mapping, IndexedDB/Cache, Account Sync & Fastify API:** [idb.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/idb.ts), [cache.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/cache.ts), [animeMapping.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/animeMapping.ts), [normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts), [anilist.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/anilist.ts), [tmdb.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/tmdb.ts), [account.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/account.ts), [progress.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/progress.ts), [watchlist.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/watchlist.ts), [settings.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/settings.ts), [server/src/app.js](file:///c:/Users/Ayomide/Documents/abixcine/server/src/app.js), [server/src/auth.js](file:///c:/Users/Ayomide/Documents/abixcine/server/src/auth.js), [server/src/db.js](file:///c:/Users/Ayomide/Documents/abixcine/server/src/db.js), [server/src/tmdb.js](file:///c:/Users/Ayomide/Documents/abixcine/server/src/tmdb.js), [render.yaml](file:///c:/Users/Ayomide/Documents/abixcine/render.yaml)
5. **"Projection" UI, CSS Architecture, Accessibility & Build Config:** [base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css), [browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css), [player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css), [App.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/App.tsx), [TitleBar.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/TitleBar.tsx), [CommandPalette.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/CommandPalette.tsx), [Hero.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Hero.tsx), [FitsTonight.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/FitsTonight.tsx), [Card.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Card.tsx), [Title.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Title.tsx), [Settings.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Settings.tsx), [vite.config.ts](file:///c:/Users/Ayomide/Documents/abixcine/vite.config.ts)

---

## 0. Resolution Status (v1.8.0 – v1.8.1)

All 21 Section 3 clusters were worked through. Items marked **Disputed** were checked against the code or live data and found not to be bugs; **Not done** items were left on purpose, with the reason.

| # | Status | Notes |
| --- | --- | --- |
| 1 | Fixed | `abxs:` main-window only; SSRF guard on every request, redirect hop and DNS answer (link-local/metadata never; LAN only when the URL names it; no public→LAN pivots or rebinding); proxy refuses loopback. |
| 2 | Fixed | librqbit reader permits above the connection cap; every 206 capped to the window; level-triggered stop flag; open/seek/write/metadata timeouts; stale `torrents/` swept at startup. |
| 3 | Fixed | `abxNoWoiF` returns a fake window; header map evicts oldest; fMP4 init/fragments no longer arm early exit; verification capped (6 s each, 8 s total); cancel tombstones expire; clicker aborts on every exit path. |
| 4 | Fixed (one item not done) | Sniffer windows and child frames restricted to the open web; new-window check uses `is_app_navigation`; test env switches debug-only. **Not done:** `.incognito(true)` — app data is already origin-isolated, and per-sniff private profiles would drop Cloudflare clearance cookies and slow capture. |
| 5 | Fixed | Suffix ranges; buffered bodies capped (overflow served as a 206 window); playlist cache keyed by Referer/Origin, 200-only, expiry checked outside the lock; `data:`/`skd:`/`blob:` keys untouched; MPD templates in query strings and `%` round-trip fixed. **Disputed:** case-insensitive `URI=` (HLS attribute names are case-sensitive). |
| 6 | Fixed / partly disputed | `0:V:0` mapping (cache key bumped), file cap inside folders, `unwrap_or(false)`, `CON .srt`, sample clips no longer void `Subs/`. **Disputed:** `mov_text` crash (only text codecs are ever mapped). **Not done:** forcing 5.1 AAC to stereo re-encode (turns a seconds-long remux into minutes; Chromium downmixes 5.1 correctly). |
| 7 | Fixed / disputed | Language region tags and episode 0.5 fixed. **Disputed:** the `/-_\./g` regex is correct — OneTouchTV encodes `/` as the literal `-_.` (verified on live payloads; the suggested fix breaks every decryption). |
| 8 | Fixed (policy kept) | Network/RPC members stripped from the worker prototype chain; GET/HEAD/POST only; routing headers dropped. Empty `allowedHosts` still means "any public site" (private/loopback always blocked); Settings now labels such plugins. |
| 9 | Fixed | Title-page previews never add magnets (warm lookups); 3 resolutions per play; RD's disabled cache endpoint reported as "unknown"; season packs matched by filename / SxxEyy. |
| 10 | Fixed | AnimeHeaven ranking; Hexa token mint coalesced, retry fixed; PrimeSrc/VaPlayer use `isMovieRequest`. |
| 11 | Fixed | Direct streams never re-captured; `verify()` waiters ref-counted; per-provider probe fairness; mirror health; dub skip list completed. |
| 12 | Fixed | enc-dec.app: 3-slot queue, 429 retry, 3-failure cooldown, outages kept out of circuit breakers, VidLink/KissKH routed through it; Jellyfin `api_key` redacted from stored health data (old data scrubbed). |
| 13 | Fixed (library item not done) | WebGL2 probe cached; GPU timing; background-tab downgrades. **Not done:** `ClampHighlights` texture leak lives inside `anime4k-webgpu`. |
| 14 | Fixed | Token refresh keeps subtitle/audio/pause state; HLS repair budget recovers after 15 s. **Not done:** native-HLS `onError` refresh (WebView2 always uses hls.js). |
| 15 | Partly fixed | JASSUB kept alive across `C` and renders while paused; boundary-scheduled cue sync; OSHash file size sent; season-pack ZIP episode matching; outage reported as an error. **Not done (features):** independent dual-sub offsets, simultaneous dual HLS subtitle tracks, Shaka DASH text bridge, MKV audio track switching. **Disputed:** passing `languages` to Wyzie would drop useful fallback results. |
| 16 | Fixed | IndexedDB retries after failure; hydration starts at load and detail pages await it (capped); epoch-guarded downloads; cour selection and offset dedup. |
| 17 | Fixed | `isFilm` / `isMovieRequest` used everywhere a film is meant; search dedups TMDB/AniList films. |
| 18 | Fixed (deployment items not done) | Soft-delete tombstones; subtitle memory cleared on sign-out; refresh rotation in one statement; token-version cache. **Not done:** `render.yaml` plan upgrade (cost decision); DB certificate checks are opt-in (`PGSSL_VERIFY=1`) to avoid breaking the live deployment. |
| 19 | Fixed | Palette owns Escape (capture phase); `aria-modal` only while open; preview not `aria-hidden`; shortcuts dialog modal. |
| 20 | Fixed | Registry counted at idle; legacy JASSUB engine removed from the build; unused Sora dependency removed. **Disputed:** font subsets (only downloaded per unicode-range; removing them degrades non-Latin titles). |
| 21 | Fixed (one item not done) | Reduced-motion selectors; addon tile layout; preset URL normalization and failure names; interval churn; FitsTonight streams results; episode stills sized; dead CSS removed. **Not done:** `Title` progress-store re-render (only fires on sync while the page is open). |

**Section 4–6 (optimizations / roadmap):** done — startup registry deferral, legacy WASM removal, lazy KissKH subtitle decryption, boundary cue timer, enc-dec concurrency. Already covered — `resolveMediaIds` coalescing (`resolveTmdbId` and `cached()` both dedupe in flight). Deliberately not done — skipping the commit-time `playCheck` for direct HLS (it catches "master OK, segments 403"). Not started — architectural rewrites (hyper gateway, IndexedDB catalog, batch sync, Player decomposition) and the Section 5 product features.

---

## 1. Executive Summary & Current Verified Baseline (`v1.7.0+`)

### 1.1 Automated Workspace Verification Results

All automated checks were executed cleanly against the current `v1.7.0+` working tree:

| Suite / Command | Scope | Verified Result | Notes |
| --- | --- | --- | --- |
| `npx tsc --noEmit` | Strict TypeScript typecheck | **PASS (`EXIT 0`)** | Zero compile errors across `src/` & new `2026-11-15` extractors |
| `npx vitest run` | Frontend unit & integration suites | **15 files / 245 passed (`0 failed`)** | Includes new `encdec-extractors.test.ts` (10) & `pipeline-and-extractors.test.ts` (13) |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust backend unit tests (default) | **48 passed / 0 failed / 0 ignored** | Up from 36 in `v1.5.0`; covers `stream`, `shield`, `local_media_tests`, `torrent` |
| `cargo check --manifest-path src-tauri/Cargo.toml --features torrent` | Rust torrent-enabled build check | **PASS (`EXIT 0`)** | Also verified `cargo test --features torrent`: **48 passed / 0 failed** |
| `npm --prefix server test` | Fastify 5 + Embedded PGlite API suite | **12 passed / 0 failed / 0 skipped** | Up from 9 in `v1.5.0`; covers per-account login rate-limit, title validation, settings sync |
| `npx vite build` | Production frontend bundle (`chrome110`) | **PASS (`52 assets`, `10.45 MB` raw)** | Route-split + vendor-chunked (`react`, `tauri`, `hls`, `shaka`, `anime4k`) |

### 1.2 Production Bundle Footprint Snapshot (`dist/assets/`)

| Asset / Chunk | Exact Bytes | Vite kB (gzip kB) | Loading Behavior & Audit Notes |
| --- | ---: | ---: | --- |
| `anime4k-saoqMgEU.js` | `3,450,609 B` | `3,450.61 kB` (`925.57 kB` gz) | Lazy (`enhance.ts:55`); monolithic UMD bundle ships unused GAN/UL weights |
| `jassub-worker-modern-fB_B5_2M.wasm` | `2,191,920 B` | `2,191.92 kB` | Lazy (`SubtitleOverlay.tsx:128`); SIMD WebAssembly `libass` engine |
| `jassub-worker-ei4KTFIf.wasm` | `2,048,179 B` | `2,048.18 kB` | **Redundant legacy non-SIMD WASM** statically referenced alongside `chrome110` modern build |
| `shaka-CFyoIav1.js` | `879,259 B` | `878.21 kB` (`293.54 kB` gz) | Lazy (`Player.tsx:1945`); loaded only on `.mpd` DASH streams |
| `hls-DheivIM5.js` | `596,633 B` | `596.63 kB` (`186.65 kB` gz) | Lazy (`Player.tsx:1937`); loaded on `.m3u8` HLS streams |
| `react-iZcKVIi7.js` | `207,958 B` | `207.96 kB` (`67.77 kB` gz) | Eager vendor chunk (`react`, `react-dom`, `react-router-dom`) |
| `registry-LAPyOYCZ.js` | `166,678 B` | `166.61 kB` (`54.91 kB` gz) | **Pulled eagerly on mount** by `TitleBar.tsx:37` (`useServerCount`) |
| `index-kIdDZKRz.js` | `158,298 B` | `158.20 kB` (`54.10 kB` gz) | Eager shell entry (down from `595,510 B` in `v1.5.0`) |
| `default-jVcJgvWm.woff2` + fonts | `575,672 B` | `575.67 kB` | Includes `default.woff2` (`145.97 kB`), `bricolage-grotesque`, `geist`, `jetbrains-mono`, `instrument-serif` (incl. unused `.woff` & `vietnamese`/`cyrillic` subsets) |
| `index-CEswxoOK.css` | `119,485 B` | `119.49 kB` (`25.50 kB` gz) | Unified `base.css` + `browse.css` + `player.css` + 16 `@font-face` rules |
| `Watch-ByKICaJ0.js` | `110,192 B` | `110.07 kB` (`36.86 kB` gz) | Lazy route chunk (fetched at 4s idle by `App.tsx:29` `preloadPages()`) |
| `jassub-worker*.js` + `fonts` + `worker` | `254,394 B` | `254.39 kB` | JASSUB worker glue (`83.15 kB` modern + `80.42 kB` legacy + `48.54 kB` fonts + `41.88 kB` worker) |
| `Settings` / `Title` / `tauri` / `session` / `subtitleProviders` | `108,968 B` | `108.81 kB` | `Settings` (`35.92 kB`), `Title` (`18.70 kB`), `tauri` (`18.27 kB`), `session` (`17.98 kB`), `subtitleProviders` (`17.94 kB`) |

### 1.3 Summary of Fixes Already Landed in `v1.6.0`, `v1.7.0` & the `2026-11-15` Upgrade

To prevent stale reporting, the following issues from the `v1.5.0` audit were **verified as resolved** in the current codebase:
- **Rebuilt "Projection" UI (`v1.6.0` `713f863` & `v1.7.0` `7e698c7`):** Replaced legacy `src/styles.css` and `src/aurora.css` with modular [base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css), [browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css), and [player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css); added OKLCH palette extraction ([light.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/light.ts)), pre-baked `noise.png`, route-level `React.lazy` splitting + Vite `manualChunks`, fixed `Art.tsx` `hd` `srcSet` resolution, and refined `Drive`, `Hero`, `Title`, `MyList`, and `Settings` layouts.
- **Server & Account Hardening (`v1.6.0`):** Fixed `/auth/login` global lockout via `preHandler` IP+email rate-limiting ([server/src/app.js:149-163](file:///c:/Users/Ayomide/Documents/abixcine/server/src/app.js#L149-L163)); added TMDB date-window parameters, `/collection/\d+`, and in-flight coalescing ([server/src/tmdb.js:1-38](file:///c:/Users/Ayomide/Documents/abixcine/server/src/tmdb.js#L1-L38)); aligned all 8 `SYNCED_SETTINGS` keys with strict validation and atomic `MAX_WATCHLIST` enforcement; added `navigator.locks` (`abx.auth.refresh`) + cross-tab `storage` adoption in [account.ts:199-211](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/account.ts#L199-L211); moved Fribb/Anibridge storage to IndexedDB ([idb.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/idb.ts)).
- **Desktop Rust & Proxy Hardening (`v1.6.0` & `2026-11-15`):** Locked main-window navigation via `is_app_navigation` ([shield.rs:395-407](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/shield.rs#L395-L407)); released sniffer `Semaphore(4)` permit via `slot` before HTTP playlist verification ([shield.rs:1553-1556, 1732](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/shield.rs#L1553-L1556)); added `floor_char_boundary`, `HEAD` handling, active-document MIME stripping, BOM-aware `#EXTM3U` detection, `KEYURI` boundary checks, and scoped MPD `<BaseURL>` rewriting ([stream.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/stream.rs)); switched cache keys from `DefaultHasher` to 64-bit FNV-1a `stable_hash` ([lib.rs:486-495](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L486-L495)); added dotfile deny rules and `'wasm-unsafe-eval'` in [tauri.conf.json:32, 47-48](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/tauri.conf.json#L32); enabled `--features torrent` in [release.yml:67](file:///c:/Users/Ayomide/Documents/abixcine/.github/workflows/release.yml#L67); made [prepare-ffmpeg.mjs](file:///c:/Users/Ayomide/Documents/abixcine/scripts/prepare-ffmpeg.mjs) atomic and offline-safe.
- **Player & Upscaler Fixes (`v1.6.0`):** Bound `startState` to `{ session, key }` in [Watch.tsx:98-103](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx#L98-L103); fixed `enhance.ts` `rawW`/`rawH` clamp loop and `2×` playback-speed false downgrade ([enhance.ts:930-933](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/enhance.ts#L930-L933)); fixed `UpNext` dismiss auto-advance, `saveNow()` on Next, double-click fullscreen debounce, and `skipSegments.ts` partial cache poisoning.
- **2026-11-15 Live Extractor, Sniffer & Stremio Upgrade:** Added 7 new direct extractors ([castle.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/castle.ts), [hexa.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/hexa.ts), [vidup.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/vidup.ts), [cinejoy.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/cinejoy.ts), [meowtv.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/meowtv.ts), [megaplay.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/megaplay.ts), [animeheaven.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/animeheaven.ts)) plus shared `enc-dec.app` client ([encdec.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/encdec.ts)); refreshed [zxcstreams.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/zxcstreams.ts), [vidrock.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/vidrock.ts), [vidlink.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/vidlink.ts), [anizone.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/anizone.ts), [anikoto.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/anikoto.ts), and [kisskh.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/kisskh.ts); added `build_player_hook_script` iframe/referrer spoofing in [shield.rs:566-654](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/shield.rs#L566-L654); added `PUBLIC_HTTP_STREMIO_PRESETS` and one-click batch loader in [stremio.ts:417-470](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/stremio.ts#L417-L470) and [Settings.tsx:247-274, 771-788](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Settings.tsx#L247-L274).

---

## 2. Prioritized Impact Matrix

| Category | Item | Measurable Impact | Effort | Primary Targets |
| --- | --- | --- | --- | --- |
| **Quick Win (P0)** | Fix `onetouchtv.ts:73` broken regex `/-_\./g`, `animeheaven.ts:166,186` search/sort bugs, and `hexa.ts:58,148` `capToken`/retry bugs | Immediately restores OneTouchTV decryption, AnimeHeaven fallback & Hexa retries | < 2 hrs | `onetouchtv.ts`, `animeheaven.ts`, `hexa.ts` |
| **Quick Win (P0)** | Lock WebWorker prototype chains + RPC nonce (`pluginRunner.ts`) & enforce Rust DNS/redirect SSRF blocking + `main`-only `abxs:` (`stream.rs`, `lib.rs`) | Closes critical worker sandbox escape, RPC spoofing & localhost/LAN SSRF | 1 day | `pluginRunner.ts`, `stream.rs`, `lib.rs`, `shield.rs` |
| **Quick Win (P0)** | Fix `abxNoWoiF` clobbering `build_player_hook_script` `window.open` + `.incognito(true)` in `shield.rs` | Restores anti-popup embed capture & isolates main WebView2 profile cookies/storage | 3–4 hrs | `src-tauri/src/shield.rs` |
| **Quick Win (P0)** | Memoize `webgl2Available()` (`enhance.ts:39-49`) & fix `gpuEma` `stamp === false` / background-tab false downgrades (`enhance.ts:856,926`) | Stops 4 Hz WebGL2 context leak on Picture sheet & eliminates false Anime4K drops | 3–4 hrs | `src/lib/enhance.ts` |
| **Quick Win (P1)** | Defer Debrid magnet creation until `commit()` + handle RD `instantAvailability` 403 gracefully (`stremio.ts`, `debrid.ts`, `SmartSource.tsx`) | Stops Title page visits from filling RD/TorBox slots & restores RD playback | 1 day | `stremio.ts`, `debrid.ts`, `session.ts` |
| **Quick Win (P1)** | Cut `TitleBar.tsx:37` eager `import("../sources/registry")` + drop legacy `2.05 MB` `jassub-worker.wasm` & unused `@fontsource-variable/sora` | Saves **166.7 KB** startup JS (`-30%`) and **2.21 MB** bundle assets immediately | < 4 hrs | `TitleBar.tsx`, `SubtitleOverlay.tsx`, `main.tsx`, `package.json` |
| **High-Impact Optimization** | Unify `isFilm(media)` across `normalizer.ts`, `Title.tsx`, `Watch.tsx`, `local.ts`, `search.ts`, `embeds.ts`, and all extractors | Fixes AniList anime movies playing as TV `S1E1` or failing local/direct lookup | 1 day | `normalizer.ts`, `Title.tsx`, `Watch.tsx`, `local.ts`, `extractors/*` |
| **High-Impact Optimization** | Coalesce `resolveMediaIds`, add `enc-dec.app` concurrency queue (2–3), per-provider `AUTO_DIRECT_CHECKS`, and skip redundant `playCheck` on verified direct HLS | Cuts TTFF by **350–900 ms**, eliminates `enc-dec.app` 429 cascades & probe starvation | 1–2 days | `session.ts`, `registry.ts`, `common.ts`, `encdec.ts`, `kisskh.ts` |
| **High-Impact Optimization** | Decompose `Player.tsx` (`<PlayerScrubber>`, `<TimeReadout>`), preserve state across same-server token refresh, and replace 60ms cue polling with boundary timers | Eliminates 4–16 Hz full-Player React reconciliations & subtitle/audio wipes on refresh | 2–3 days | `Player.tsx`, `SubtitleOverlay.tsx`, `subtitles.ts` |
| **Architectural Upgrade** | Replace `abxs:` `Vec<u8>` custom protocol + `assetProtocol` + raw torrent TCP with a **Unified Loopback `hyper` Streaming Gateway** + per-file fMP4 remux | Zero-copy streaming (~64 KiB RAM vs multi-MB copies), fixes `librqbit` 8-permit deadlock | 4–6 days | `src-tauri/src/{stream,lib,torrent}.rs` |
| **Architectural Upgrade** | Migrate `cache.ts` to IndexedDB + fix `idb.ts` error latching + WebWorker Fribb/Anibridge indexing + `POST /sync/batch` + `deleted_at` tombstones | Eliminates synchronous `localStorage` boot scan, startup unsplit-cour race & delete resurrection | 3–5 days | `idb.ts`, `cache.ts`, `animeMapping.ts`, `server/src/{app,auth,db}.js` |
| **UI / UX Craft** | Upgrade Settings Stremio Preset & Addon Diagnostics Studio + Live Anime4K A/B split-wipe + Trickplay thumbnails + Dual-Lang Transcript + Web Audio DSP | Elevates "Projection" into a reference-grade desktop theater experience | 1–2 wks | `Settings.tsx`, `Player.tsx`, `enhance.ts`, `SubtitleSheet.tsx` |

---

## 3. Part 1: Confirmed Bugs, Edge Cases & Security Vulnerabilities in `v1.7.0+`

### 3.1 Subsystem 1 — Rust Tauri Backend, `abxs:` Proxy, Adblock Shield, Local Media & BitTorrent

#### 1. `[CRITICAL]` Unauthenticated `abxs:` Scheme Exposed to Sniffer Webviews + Open SSRF / Redirect Bypass in `stream::handle` & `http_fetch`
- **Location:** [src-tauri/src/lib.rs:1358-1360](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L1358-L1360), [src-tauri/src/stream.rs:307-324, 877-984, 1164-1278](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/stream.rs#L307-L324)
- **Root Cause:**
  1. `lib.rs:1358-1360` ignores `_ctx` in `.register_asynchronous_uri_scheme_protocol("abxs", |_ctx, req, responder| ...)`, allowing untrusted third-party embeds loaded inside `sniff-*` windows (or child iframes) to issue arbitrary requests through `http://abxs.localhost/p?u=...`.
  2. `stream::handle` (`stream.rs:877-984`) never calls `validate_http_url` and performs zero private/loopback/link-local IP checks on `target`, while returning raw internal `reqwest` errors via `fail(StatusCode::BAD_GATEWAY, &e.to_string())` (`L945, 977`).
  3. `http_fetch` and `http_fetch_bytes` (`stream.rs:1164-1278`) check only the URL scheme (`http`/`https`) with no DNS resolution or private-IP filter (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`), and `client()` (`L307-324`) follows up to 8 redirects to any `http`/`https` destination without checking target hosts or resolved IPs. Furthermore, `build_http_request` (`L1175-1197`) accepts arbitrary HTTP methods and sensitive headers (`Host`, `Cookie`), and `http_fetch` (`L1212-1236`) neither caps request body size nor streams/caps response bytes before `res.text().await` (`L1234`).
- **Concrete Fix:**
```rust
// 1. src-tauri/src/lib.rs:1358 — restrict abxs: protocol to the main window
.register_asynchronous_uri_scheme_protocol("abxs", |ctx, req, responder| {
    if ctx.webview_label() != "main" {
        responder.respond(
            tauri::http::Response::builder()
                .status(tauri::http::StatusCode::FORBIDDEN)
                .body(Vec::new())
                .unwrap(),
        );
        return;
    }
    tauri::async_runtime::spawn(async move { responder.respond(stream::handle(req).await) });
})

// 2. src-tauri/src/stream.rs — validate scheme, host, and resolved socket IPs on initial URL and every redirect hop
fn is_forbidden_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local()
                || v4.is_broadcast() || v4.is_documentation() || v4.is_unspecified()
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // Unique Local (fc00::/7)
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // Link-Local (fe80::/10)
                || v6.to_ipv4_mapped().is_some_and(|v4| is_forbidden_ip(std::net::IpAddr::V4(v4)))
        }
    }
}
```
Disable automatic redirects in `client()` (`reqwest::redirect::Policy::none()`) and follow up to 5 hops manually after validating each `Location` target against `validate_http_url` + DNS IP resolution + optional caller `allowed_hosts`. Stream `http_fetch` responses with `MAX_FETCH_BYTES` enforcement.

#### 2. `[CRITICAL]` `librqbit` `BlockingSpawner` 8-Permit Deadlock, Uncapped Bounded Ranges & Missed `Notify` Wakeups
- **Location:** [src-tauri/src/torrent.rs:280, 283-287, 300-303, 317-327, 373-385, 525, 543-641, 653, 767](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/torrent.rs#L280), [src-tauri/src/lib.rs:1483](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L1483)
- **Root Cause:**
  1. `torrent.rs:280` allows `MAX_CONNECTIONS = 24`, while `SessionOptions` (`L317-327`) leaves `runtime_worker_threads: None`, which defaults in `librqbit 9.1.0` (`session.rs:690-694`) to **8** `BlockingSpawner` semaphore permits. Because every `FileStream` (`handle.stream(file_idx).await` at `L551`) holds an `OwnedSemaphorePermit` for its lifetime and `Session::add_torrent` (`L653`) also acquires permits from the same `BlockingSpawner`, 8 concurrent or stalled HTTP range readers exhaust all permits and deadlock torrent piece I/O and subsequent `add_torrent` calls.
  2. Line `525` (`let e = if r.trim_end().ends_with('-') { e.min(s.saturating_add(MAX_WINDOW - 1)) } else { e };`) only caps open-ended `Range: bytes=N-` requests to `MAX_WINDOW` (`16 MiB`). Explicit large ranges (`Range: bytes=0-2147483647`) and non-`Range` `GET` requests (`L546`) hold a `FileStream` permit across the entire multi-GB file.
  3. `stop_signal` (`L283-287, 601, 767`) uses an edge-triggered `Arc<Notify>` stored in a `HashMap` that is never pruned: if `stop()` calls `notify_waiters()` while a connection is still inside `handle.stream(file_idx).await` (`L551`) or `stream.seek(...)` (`L565`) before reaching `stopped.notified()` (`L612`), the wakeup is lost!
  4. `watch_client` (`L604, 613-619`) permanently sets `watch_client = false` if pipelined bytes arrive on the keep-alive socket, never detecting subsequent client disconnects; `socket.write_all` (`L630`) has no write timeout; `add_torrent` (`L653`) has no metadata timeout on dead magnets; and `lib.rs:1483` never stops `librqbit` or sweeps `torrents/` on exit/startup.
- **Concrete Fix:**
  - Set `runtime_worker_threads: Some(32)` (exceeding `MAX_CONNECTIONS = 24`) in `SessionOptions` (`torrent.rs:317-327`).
  - Cap **all** `206` range spans to `MAX_WINDOW` (`e.min(s.saturating_add(MAX_WINDOW - 1))`), and wrap `handle.stream()`, `stream.seek()`, and `socket.write_all()` in `tokio::time::timeout` + stateful cancellation (using a `tokio::sync::watch::channel(false)` per `torrent_id` instead of edge-triggered `Notify`, cleaned up on `stop()`).
  - Bound `add_torrent` metadata resolution with a 45s timeout and add a `RunEvent::Exit` hook in `lib.rs:1483` plus startup temp cleanup.

#### 3. `[HIGH]` `shield.rs` `abxNoWoiF` Overwrites `build_player_hook_script` `window.open` Stub + `headers_by_uri.clear()` Drops Live Headers + Sequential Verifier Starvation
- **Location:** [src-tauri/src/shield.rs:170-184, 566-654, 760-850, 953, 966, 1131, 1148, 1437-1440, 1488, 1618-1743, 1858](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/shield.rs#L170-L184)
- **Root Cause:**
  1. **Scriptlet clobber (`L170-184` vs `L566-654`):** The `2026-11-15` upgrade added `build_player_hook_script` (registered via `AddScriptToExecuteOnDocumentCreated` at `L1119`), which installs a rich `safeWinOpen` stub returning `{ closed: false, opener: window, ... }` so embeds probing popup blockers don't abort playback. However, `ContentLoading` (`L953, 1131`) and `DOMContentLoaded` (`L966, 1148`) subsequently inject `SCRIPTLETS_JS`, whose `abxNoWoiF` (`L170-184`) overwrites `window.open` with `function(){return null}`!
  2. **Header map wipe (`L820-822`):** When `SniffCapture.headers_by_uri` reaches 512 entries on ad/segment-heavy pages, `self.headers_by_uri.clear()` wipes **all** captured request headers, causing a manifest response arriving right afterward to lose its `Referer`/`Origin`/`User-Agent`.
  3. **Premature fMP4 segment classification (`L760-804`):** `classify_response_media` classifies any `video/mp4` or `.mp4` response (including small DASH/HLS `init.mp4` or fragment `.mp4` requests) as a primary `"mp4"` candidate, arming the 900ms early-exit countdown (`L1659`) before the real manifest is captured, while missing `.webm`/`video/webm` and `application/xml` MPDs.
  4. **Sequential verification budget starvation (`L1551, 1743, 1858`):** Although the WebView2 `Semaphore(4)` permit is now released via `slot` at `L1732`, `select_verified_candidate` (`L1743`) still runs inside the outer `timeout(budget, ...)` (`L1551`, `timeout_ms + 6_000`) and verifies up to 6 candidates **sequentially** (`verify_playlist` does up to `2 × 10s` fetches + `1.2s` delay per candidate), timing out the entire sniff if candidate #1 stalls.
  5. **Cancel tombstone & clicker leaks (`L1437-1440, 1488, 1618, 1635`):** `cancel_sniff` on an unknown/completed ID inserts a permanent `label: None` entry into `cancel_map`; `sniff_inner` ignores `ready_rx.await` errors (`L1618`) and never aborts the spawned 13s `clicker` task (`L1635`) on early exit.
- **Concrete Fix:**
  - Update `abxNoWoiF` in `shield.rs:170-184` to return the `{ closed: false, focus(){}, blur(){}, close(){ this.closed = true; } }` mock object instead of `null`, and inject `SCRIPTLETS_JS` once via `AddScriptToExecuteOnDocumentCreated` rather than twice on `ContentLoading` + `DOMContentLoaded`.
  - Evict the oldest half (or FIFO ring) of `headers_by_uri` instead of `.clear()`.
  - Exclude URLs matching `/\b(init|seg|frag|chunk|part)[-_0-9]*\.mp4\b/i` from `classify_response_media` when HLS/DASH requests are active.
  - Run `select_verified_candidate` under its own independent `8_000 ms` timeout outside `sniff_inner`, probing top 2 candidates with bounded concurrency (`2`), and abort `clicker`'s `JoinHandle` on exit.

#### 4. `[HIGH]` Unrestricted `sniff-*` Navigation, `NewWindowRequested` `.localhost` Bypass, Shared WebView2 Profile & Release Test Bypasses
- **Location:** [src-tauri/src/shield.rs:284-285, 932, 1186, 1206, 1579-1594](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/shield.rs#L932), [src-tauri/src/lib.rs:1345](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L1345)
- **Root Cause:**
  1. `NavigationStarting` (`shield.rs:1206`) is gated behind `if main`, leaving `sniff-*` windows and child frames (`hook_frame_cosmetics` at `L932`) free to navigate to `http://tauri.localhost`, `http://abxs.localhost`, `http://asset.localhost`, `file://`, or custom OS URI schemes.
  2. `NewWindowRequested` (`shield.rs:1186`) checks `from_app = main && host_of(&src).is_some_and(|h| h == "localhost" || h.ends_with(".localhost"))`—which matches `abxs.localhost` and `asset.localhost`—and spawns `Command::new("explorer").arg(&uri)` (`L1194`).
  3. `WebviewWindowBuilder::new` (`shield.rs:1579-1594`) omits `.incognito(true)`, sharing cookies, IndexedDB, LocalStorage, and Service Workers with the `main` WebView2 profile.
  4. `lib.rs:1345` (`ABX_SNIFF_TEST` / `ABX_JS_TEST`) and `shield.rs:284-285` (`ABX_NO_FILTER_UPDATE`) are active in release builds without `#[cfg(debug_assertions)]`.
- **Concrete Fix:** Attach `NavigationStarting` to both `main` (`is_app_navigation`) and `sniff-*` / child frames (allowing only external `http:`/`https:` where `!is_app_navigation(&uri)` and host is not `*.localhost`/`127.0.0.1`); use `is_app_navigation(&src)` in `NewWindowRequested`; pass `.incognito(true)` on `sniff-*` windows; and gate test env vars behind `#[cfg(debug_assertions)]`.

#### 5. `[HIGH]` `stream.rs` Unbounded `200` Buffering, Suffix Range Rejection, Unkeyed `PLAYLISTS` Cache & HLS/MPD Edge Cases
- **Location:** [src-tauri/src/stream.rs:98-108, 146, 159-165, 222, 395-601, 693-730, 804-824, 848-856, 889, 1011-1099, 1131-1145](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/stream.rs#L98-L108)
- **Root Cause:**
  - `parse_byte_range` (`L693-711`) rejects RFC 9110 suffix ranges (`bytes=-65536`), returning `None` (`L730`).
  - `should_guard_range_200` (`L804-824`) returns `false` when an extensionless video URL responds with `Content-Type: application/octet-stream`, causing `res.bytes().await` (`L1063`) to buffer multi-GB streams into RAM. Conversely, when `requested_range == None` and `upstream_cl == None` on `video/*`, `plan_range_200_body` emits an unsolicited `206 Partial Content` (`bytes 0-6291455/*`) and returns `502` on seeks past `24 MiB`.
  - `PLAYLISTS` cache (`L146, 222`) keys solely on `url` (ignoring custom `Hdrs` `h`), caches any `2xx` status (`L1070`: e.g. accidental `206`), and runs `playlist_body_has_expired_token` while holding the global `PLAYLISTS` mutex (`L159-165`).
  - `find_next_uri_attr` (`L98-108`) is case-sensitive (`URI="`), and `rewrite_playlist` (`L409-449`) rewrites `data:`, `skd://`, and `blob:` key URIs into broken `abxs:` URLs.
  - `proxied_mpd_attr` (`L395-401`) runs `rfind('/')` across the entire string including query params (`?path=/...$Number$`), and `handle` (`L889`) runs `.replace("%26", "&").replace("%23", "#")`, corrupting double-escaped upstream tokens.
- **Concrete Fix:** Support `ByteRange::Suffix(u64)`; cap all non-streaming `abxs:` reads with `read_body_capped`; key `PLAYLISTS` on `(url, stable_hash(h))` for `200 OK` only and check token expiry outside the mutex; skip `data:`/`skd:`/`blob:` in `rewrite_playlist`; split MPD URLs before `?` when locating path slashes; and use proper percent-encoding for `t=`.

#### 6. `[HIGH]` `lib.rs` Local Media Multi-Channel Audio, Cover-Art Stream Mapping, Bitmap Subtitle Crash & `Subs/` Folder Bug
- **Location:** [src-tauri/src/lib.rs:56-70, 130-147, 200-262, 467-508, 900-965, 1010-1015, 1226](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L130-L147)
- **Root Cause:**
  - `mp4_audio_compatible` (`L498-508`) checks only `["aac", "mp3"].contains(c)` without checking `channels > 2` (5.1/7.1 AAC in MKV frequently fails or drops center dialogue channel in WebView2 without stereo downmix) or incompatible video codecs (`mpeg2video`, `vc1`).
  - `prepare_local_media_file` (`L917-935`) passes `-map 0:v:0` (which can select an embedded JPEG cover art stream `attached_pic` instead of `-map 0:V:0` non-attached video) and `-c:s mov_text` (which crashes FFmpeg when an MKV contains bitmap `hdmv_pgs_subtitle` / `dvd_subtitle` streams alongside text tracks).
  - `collect_sub_folder` (`L130-147`) returns `Vec::new()` (discarding **all** subtitles in `Subs/`) if a single sample video file exists in that subfolder (`L135-137`).
  - `walk` (`L201`) checks `out.len() >= MAX_FILES` only at recursion entry rather than inside the directory loop; `parse_ffprobe_subtitles` (`L1010-1015`) defaults missing `codec_type` with `.unwrap_or(true)`; `validate_sidecar_filename` (`L1226`) misses trailing spaces before `.` on Windows reserved names (`"CON .srt"`).
- **Concrete Fix:** Use `-map 0:V:0` and `-sn` (since subtitles are extracted separately via `open_subtitle`); check `channels <= 2` in `mp4_audio_compatible`; skip non-subtitle files inside `collect_sub_folder` instead of aborting the folder; check `out.len() >= MAX_FILES` inside `walk`'s loop; change `.unwrap_or(true)` to `.unwrap_or(false)`; and trim stem spaces before checking Windows reserved device names.

---

### 3.2 Subsystem 2 — Source Session, 17 Direct Extractors, Native Bridge, Plugins, Debrid & Stremio

#### 7. `[CRITICAL]` `onetouchtv.ts` Broken Base64url Regex, Region-Tag Rejection & `0.5` Episode Rounding
- **Location:** [src/sources/extractors/onetouchtv.ts:73, 170, 203](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/onetouchtv.ts#L73)
- **Root Cause:**
  1. Line `73` writes `.replace(/-_\./g, "/")` **without square brackets** (`[...]`), matching only the literal 3-character sequence `"-_."` instead of `-`, `_`, or `.`, and replacing `-` with `/` instead of `+`! Any ciphertext containing `-` or `_` throws `InvalidCharacterError` in `atob()`.
  2. Line `170` checks `ASIAN_LANGUAGES.has(lang)` on raw `originalLanguage?.toLowerCase()` without `.split(/[-_]/)[0]`, rejecting `"zh-CN"`, `"ko-KR"`, and `"ja-JP"`.
  3. Line `203` matches episodes via `Math.round(Number(e.episode)) === episode`, which rounds `0.5` special/recap entries up to `1` (`Math.round(0.5) === 1`) and plays Episode 0.5 instead of Episode 1.
- **Concrete Fix:**
```ts
// src/sources/extractors/onetouchtv.ts:71-75
const clean = trimmed
  .replace(/\s+/g, "")
  .replace(/-/g, "+")
  .replace(/[_.]/g, "/");

// L170:
const lang = (req.media as MediaDetail).originalLanguage?.toLowerCase().split(/[-_]/)[0];

// L203:
: detail.episodes.find((e) => Number(e.episode) === episode) ?? null;
```

#### 8. `[CRITICAL]` WebWorker Sandbox Escape via Prototype Chain, Same-Origin Blob Worker & Unauthenticated RPC
- **Location:** [src/sources/pluginRunner.ts:19, 223-258, 516-545, 558-599, 630-669, 752-763, 797, 872-876, 914, 1026-1037](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/pluginRunner.ts#L516-L599), [src/pages/Settings.tsx:328, 355, 366, 391-394](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Settings.tsx#L328)
- **Root Cause:**
  1. `lockDownWorkerGlobals()` (`pluginRunner.ts:558-599`) only defines `undefined` own properties on `self` (`__global`) and `self.navigator`. Prototype objects (`WorkerGlobalScope.prototype`, `DedicatedWorkerGlobalScope.prototype`, `EventTarget.prototype`, `Navigator.prototype`) remain untouched! Any plugin can call `Object.getPrototypeOf(self).fetch(...)` (running on the app's own origin because `new Blob([wrappedScript])` at `L914` inherits `tauri.localhost`) or `DedicatedWorkerGlobalScope.prototype.postMessage.call(self, { type: "result", ... })` to spoof RPC messages and bypass `host.httpFetch` rate/host checks.
  2. `matchesAllowedHost` (`L256-258`) returns `true` whenever `allowedHosts.length === 0`, and `Settings.tsx:328, 355, 366` defaults plugins without `@allowedHosts` to `allowedHosts: []` (unrestricted SSRF).
  3. `SAFE_HTTP_METHODS` (`L19`) allows state-mutating `PUT`, `DELETE`, and `PATCH`, while `sanitizePluginHeaders` (`L752-763`) forwards `Cookie`, `Authorization`, and `Host`.
- **Concrete Fix:** Walk the prototype chain of `self` and `self.navigator` inside `lockDownWorkerGlobals()` deleting/poisoning blocked descriptors before freezing prototypes; generate a closure-private per-invocation random `rpcToken` required on all worker `postMessage` payloads; reject empty `allowedHosts` (requiring explicit domains); and restrict plugin HTTP methods to `GET`/`HEAD`/`POST` with safe headers only.

#### 9. `[CRITICAL]` Eager Pre-Play Debrid Magnet Additions on Title Page Mount + Account Slot Leaks + RD `instantAvailability` 403 Failure
- **Location:** [src/sources/stremio.ts:27-28, 883-944](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/stremio.ts#L883-L944), [src/lib/debrid.ts:195-197, 281, 286-290, 323-356, 370-379, 427, 447-482, 803, 825-832](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/debrid.ts#L323-L379), [src/components/SmartSource.tsx:14](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SmartSource.tsx#L14)
- **Root Cause:**
  1. `SmartSource.tsx:14` calls `useSourceSession(req, 1)` as soon as a user opens `Title.tsx` (before clicking Play). `stremioProvider.find()` (`stremio.ts:886-904`) immediately resolves up to `DEBRID_MAX_CANDIDATES = 8` magnets (`DEBRID_RESOLVE_CONCURRENCY = 4`) via `resolveDebridStream`—calling `addMagnet` / `createtorrent` / `magnet/upload` on the user's Real-Debrid/TorBox/AllDebrid account.
  2. `withCleanup` (`debrid.ts:370-379`) only deletes torrents inside `catch (err)`. Every resolved candidate that isn't played (up to 8 per Title page viewed!) stays permanently in the user's Debrid cloud, immediately exhausting TorBox's 3-active-slot limit.
  3. `rdCheckCache` (`debrid.ts:336`) calls Real-Debrid's disabled `/torrents/instantAvailability/...` endpoint: when RD returns HTTP `403`, `requestJson` (`L195-197`) throws `DebridError("INVALID_KEY")`, aborting all RD resolution in `stremio.ts:911-912`; if it returns `{}`, `cachedItems` is empty and zero RD streams are returned.
  4. In `adResolve` (`debrid.ts:825-832`), `files` is built with 0-based `id: index` after filtering `rawLinks` to video extensions, whereas Stremio `fileIdx` indexes the unfiltered torrent file list (off-by-one whenever `.nfo`/`.srt` files precede the video), and `adResolve` cleanup (`L803`) uses HTTP `GET` without checking response errors.
- **Concrete Fix:**
  - Do not call `addMagnet`/`resolveDebridStream` during `stremioProvider.find()`. Emit Stremio Debrid candidates with a lazy resolver (or `debridPending` metadata) that resolves and unrestricts the single chosen magnet inside `session.commit()` / `playCheck()`.
  - Treat HTTP `403`/`404` on RD `/torrents/instantAvailability` as `unknown` cache state (falling back to lazy single-magnet resolution on commit with `deleteTorrent` on uncached status) instead of `INVALID_KEY`.
  - Pass `season` and `episode` into `selectBestFile` (`debrid.ts:269-299`) so season packs without `fileIdx` match `S01E02` filename patterns instead of picking the largest file in the season pack.

#### 10. `[HIGH]` `animeheaven.ts` Early Search Break, `hexa.ts` `capToken` Race & Broken Retry Loop, and `primesrc`/`vaplayer` Dead Exports
- **Location:** [src/sources/extractors/animeheaven.ts:166, 170, 186](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/animeheaven.ts#L166), [src/sources/extractors/hexa.ts:53-88, 142, 148](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/hexa.ts#L53-L88), [src/sources/extractors/index.ts:28-29, 36-64](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/index.ts#L28-L64), [src/sources/registry.ts:36-56](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/registry.ts#L36-L56)
- **Root Cause:**
  1. **`animeheaven.ts`:** Line `166` (`if (cards.length > 0) break;`) breaks out of the `[media.title, media.originalTitle]` search loop as soon as `search.php` returns *any* card—even if `eligibleCards` (`L170-177`) filters all of them out due to title/year/audio mismatch, never trying `originalTitle`! Then line `186` slices `eligibleCards.slice(0, 3)` **before** sorting by `scoreCard` (`rankedCards` at `L179` is only used when `eligibleCards.length === 0`).
  2. **`hexa.ts`:** `fetchCapToken` (`L53-88`) has no in-flight promise deduplication and sets `capToken = null` (`L58`) on entry, causing concurrent movie/TV checks to race PoW token requests. Worse, in `hexaExtractor.find()` (`L123-155`), when `encDec("dec-hexa")` returns `null`, line `148` sets `sources = []` (truthy!), which causes the retry loop `for (let attempt = 0; attempt < 2 && !sources; attempt++)` (`L123`) to exit after attempt `0` without ever retrying!
  3. **`primesrc.ts` & `vaplayer.ts`:** Exported in `extractors/index.ts:28-29` but omitted from `MOVIE_TV_EXTRACTORS`, `DIRECT_EXTRACTORS`, and `registry.ts:36-56`, leaving dead code in the bundle while both still check `req.media.kind !== "movie"` instead of `!isMovieRequest(req)`.
- **Concrete Fix:**
  - In `animeheaven.ts:166-186`, rank `eligibleCards` by `scoreCard` *first*, break from the query loop only if `rankedEligible[0].score >= 0.65`, and iterate `rankedEligible.slice(0, 3)`.
  - In `hexa.ts:53-88, 148`, coalesce `fetchCapToken` onto an `inflightCapToken` promise, and set `sources = Array.isArray(decrypted?.sources) && decrypted.sources.length > 0 ? decrypted.sources : null` so attempt `1` actually runs when attempt `0` fails.

#### 11. `[HIGH]` `session.ts` `refresh()` Triggers WebView Sniff on Direct Extractors, `verify()` Shared Abort & `AUTO_DIRECT_CHECKS` Starvation
- **Location:** [src/sources/session.ts:103, 134, 458-459, 607-614, 750, 826-874, 992-995](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/session.ts#L826-L874), [src/sources/registry.ts:78-79](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/registry.ts#L78-L79), [src/sources/health.ts:153-162, 310-315](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/health.ts#L153-L162)
- **Root Cause:**
  1. **`refresh()` WebView misfire (`session.ts:861-874`):** `Player.tsx:1683, 2031` calls `session.refresh(key)` whenever a stream with `c.pageUrl` fails or expires. `refresh()` only checks `if (!c?.pageUrl) return null;` without checking `c.via === "sniffed"`. Direct extractors that attach `pageUrl` (`vixsrc.ts:217`, `anime-direct.ts:180`, `anizone.ts:264`, `kickassanime.ts:279`) get passed to `capture(c, ...)` (`L866`), spawning a hidden WebView2 window on an API/watch URL and overwriting the candidate with `probe.ok = false` (`L869`)!
  2. **`verify()` shared abort (`session.ts:826-858`):** When `verify(key, signal)` attaches to an existing `this.inflight` entry, `onAbort` (`L848`) calls `mine.ctl.abort()` unconditionally—so one aborted caller cancels an active verification awaited by `Watch.tsx:123` or `pump()`.
  3. **Global `AUTO_DIRECT_CHECKS = 12` starvation (`session.ts:103, 515`):** A single multi-stream provider (`stremio`, `zxcstreams`, `castle`, `vidlink-direct`, `vidup`) returning 12 unplayable/dead links consumes all 12 `this.autoDirect` slots, starving all remaining direct extractors and prematurely triggering `applicableDirectExhausted()` (`L403`).
  4. **`NO_ANIME_DUB_DIRECT_IDS` (`session.ts:134`):** Lists `["vixsrc", "castle", "hexa-direct", "vidup", "cinejoy", "meowtv"]` but omits `"zxcstreams"`, `"vidrock"`, and `"vidlink-direct"`, which also hardcode `audio: "sub"`, causing anime dub sessions to hold embed capture for `1500ms` unnecessarily.
  5. **Multi-mirror health distortion (`session.ts:607-614, 750`):** `this.recorded.add(r.providerId)` records health on the **first** mirror of a provider that finishes probing. If mirror #1 fails and mirror #2 succeeds 50ms later, the provider is penalized with `recordProbe(..., false)` and its winning mirror's success is ignored! Meanwhile `commit()` (`L750`) calls `recordProbe` again without checking `this.recorded`.
- **Concrete Fix:**
  - In `session.ts:refresh()`, branch on `c.via === "sniffed"` (use `capture`) vs `c.via === "direct"` (re-invoke the owning provider's `find()` and update `c` only when `r.probe?.ok`).
  - Refcount active waiters on `Inflight` before calling `mine.ctl.abort()`.
  - Cap auto-probes at `3` per `providerId` (round-robin across providers) alongside a raised global cap (`24`), add `"zxcstreams"`, `"vidrock"`, and `"vidlink-direct"` to `NO_ANIME_DUB_DIRECT_IDS`, and defer `recordProbe` failure until all queued mirrors for `providerId` have failed.

#### 12. `[HIGH]` `encdec.ts` 60-Second Global Cooldown Blast Radius, Swallowed Extractor Errors & Plaintext Jellyfin `api_key` Persistence
- **Location:** [src/sources/extractors/encdec.ts:11-76](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/encdec.ts#L11-L76), [src/sources/jellyfin.ts:50, 90](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/jellyfin.ts#L50), [src/sources/health.ts:224, 252](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/health.ts#L224)
- **Root Cause:**
  1. When `session.ts` fires all direct extractors in parallel, `hexa`, `vidup`, `cinejoy`, `meowtv`, `vidlink`, and `kisskh` burst ~15 concurrent requests at `https://enc-dec.app/api/...`. Any single HTTP `429` or `7s` timeout in `encdec.ts:45-68` sets global `downUntil = Date.now() + 60_000` (`OUTAGE_COOLDOWN_MS`), immediately failing `hexa`, `vidup`, `cinejoy`, and `meowtv` with `EncDecUnavailableError`—which `session.ts:360` records as `recordLookup(p.id, false)`, tripping the circuit breaker on all 4 providers! Meanwhile `vidlink.ts:76` and `kisskh.ts:215` call `enc-dec.app` directly without sharing the limiter.
  2. Conversely, 16 extractors (`vidlink`, `vidrock`, `meowtv`, `vidup`, `kickassanime`, `castle`, `vixsrc`, `anizone`, `anikoto`, `animeheaven`, `onetouchtv`, `megaplay`, `anime-direct`, `kisskh`) catch HTTP `403`/`429`/`5xx` and return `[]` instead of throwing when all mirrors fail, so `health.ts` records `recordEmpty` (which never opens the circuit breaker).
  3. `jellyfin.ts:50, 90` appends `?api_key=${encodeURIComponent(apiKey)}` to stream and subtitle URLs, which `health.ts:224, 252` persists in plaintext inside `localStorage` (`abx.picks.v1`, `abx.badurls.v1`).
- **Concrete Fix:** Route all `enc-dec.app` calls (including `vidlink` and `kisskh`) through a 3-slot concurrency queue in `encdec.ts` with 1 jittered retry on `429`, only set `downUntil` after 3 consecutive network/5xx failures, and do not trip provider circuit breakers on `EncDecUnavailableError`; redact `api_key`/`token` query params in `normalizeMediaUrl` (`health.ts`) and pass Jellyfin's token via `X-Emby-Token` proxy header.

---

### 3.3 Subsystem 3 — Video Player, Anime4K Upscaler, Subtitles, JASSUB & Skip Segments

#### 13. `[HIGH]` `enhance.ts` 4 Hz WebGL2 Context Leak on Picture Sheet, `gpuEma` IPC Inflation & Background-Tab False Downgrades
- **Location:** [src/lib/enhance.ts:39-49, 165-197, 824-885, 915-989](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/enhance.ts#L39-L49), [src/components/Player.tsx:3097](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L3097)
- **Root Cause:**
  1. **Unmemoized `webgl2Available()` (`enhance.ts:39-49`, `Player.tsx:3097`):** While `sheet === "picture"` is open, `Player.tsx:3097` calls `upscalerAvailable()` on every render (~4×/sec from `timeupdate` + hover), which calls `document.createElement("canvas").getContext("webgl2")` when WebGPU is absent—allocating a brand-new WebGL2 context 4 times per second until Chromium hits the 16-context limit and evicts active canvases (`WARNING: Too many active WebGL contexts`).
  2. **`gpuEma` polluted by wall-clock IPC round-trip (`enhance.ts:824-885`):** With `MAX_INFLIGHT = 2`, whenever `reading === true` (frame $N$ is mapping `rbuf`), frame $N+1$ sets `stamp = false` (`L824`). Inside `onSubmittedWorkDone().then(...)` (`L853-885`), `let ms = performance.now() - t0` (`L856`) is **always** folded into `gpuEma` (`L884`) when `stamp === false`, measuring CPU/GPU-process IPC queue latency (~12–25 ms) instead of shader execution time (~2 ms) and triggering false `gpuOver` downgrades (`L939`)!
  3. **3–30s background tabbing triggers immediate downgrade (`enhance.ts:926-971`):** While `document.hidden` is true, `frame()` skips `process()` (`L970-971`) while media playback continues. If the user returns after 3–30 seconds (`span >= 3 && span <= 30` at `L926`), `winFrames` is near `0` while `expected = (span * 1000) / mediaFrame` is `72–720`, so `ratio < 0.72` fires and downgrades Anime4K!
  4. **`ClampHighlights` anonymous texture leak (`enhance.ts:165-197, 293`):** In `anime4k-webgpu`, `ClampHighlights` allocates two full-resolution `rgba16float` `statsmax_texture` objects stored only inside `this.bindGroups`, which `destroyPipe()` (`L165-197`) cannot reach (~33 MB VRAM per 1080p rebuild until GC), and `startEnhancer` (`L984-989`) attaches a permanent `device.lost.then(...)` closure on every enhancer restart.
- **Concrete Fix:**
```ts
// src/lib/enhance.ts:39-49 — cache WebGL2 probe once per session
let cachedWebgl2: boolean | null = null;
export const webgl2Available = () => {
  if (cachedWebgl2 !== null) return cachedWebgl2;
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    cachedWebgl2 = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return cachedWebgl2;
  } catch {
    return (cachedWebgl2 = false);
  }
};
```
In `enhance.ts:853-885`, update `gpuEma` from `performance.now() - t0` **only** when `!canTimestamp` (never on `stamp === false` when hardware timestamps are supported). Reset `winStart = 0; winFrames = 0; winSkips = 0;` whenever `document.hidden` is true in `frame()` (`L970`) or on `visibilitychange`.

#### 14. `[HIGH]` Same-Server Token Refresh Wipes Audio/Subtitle State & Unpauses Video + Missing `file`/Native-HLS Error Recovery
- **Location:** [src/components/Player.tsx:206, 800-837, 1628-1630, 1656-1660, 1702-1715, 1727, 1782-1814, 2074, 2784-2788](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L800-L837)
- **Root Cause:**
  1. When `refreshExpiredStream` updates `cur.url` with a fresh CDN token for the same server (`activeKey = candKey(cur)` unchanged), `activeCurUrl` changes (`L800`), wiping `manualSub.current`, `manualSecondary.current`, `onlineSubsState`, `loadedOnlineMap`, `selectedSub`, and `secondarySub`. Simultaneously, the stream-attach `useEffect` (`L2074`, keyed on `cur?.url`) resets `manualAudio.current = false` and `audioTracks` (`L1628-1630`), and `seekAndPlay()` (`L1656-1660`) calls `v.play()` unconditionally even if the user had paused playback.
  2. `<video onError>` (`L2784-2788`) only handles `cur?.kind === "file"` (leaving native HLS `!H.isSupported()` at `L1711` with no error listener) and immediately calls `failover()` without attempting `refreshExpiredStream` when `cur.pageUrl` is present.
  3. In `attachHls` (`L1727, 1782-1785`), `recoveries` never resets after sustained healthy playback, so 3 isolated buffer/codec hiccups across a 2.5-hour film trigger fatal failover.
- **Concrete Fix:** Key subtitle/online-sub/audio resets on `${mediaKey}::${activeKey}::${cur?.localPath ?? ""}` instead of `cur?.url`; capture `const wasPaused = v.paused` before refresh and only call `v.play()` if `!wasPaused`; reset `recoveries = 0` after 15 seconds of continuous `FRAG_LOADED` playback; and route `<video onError>` through `refreshExpiredStream` when `cur?.pageUrl && isUrlTokenExpired(cur.url)`.

#### 15. `[HIGH]` 60ms Subtitle Cue Polling Waste, Single Shared Dual-Sub Offset, HLS/DASH Track Gaps, JASSUB Paused Blankness & Online ZIP/Error Bugs
- **Location:** [src/components/Player.tsx:149-204, 625, 722-732, 1268-1412, 1835](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L149-L204), [src/components/SubtitleOverlay.tsx:91-183](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SubtitleOverlay.tsx#L91-L183), [src/lib/subtitleProviders.ts:275-280, 321-323, 650-665, 717-789](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/subtitleProviders.ts#L650-L665), [src-tauri/src/lib.rs:917](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L917)
- **Root Cause & Concrete Fixes:**
  - **60ms `evaluateCues` polling (`Player.tsx:155-177, 1401-1407`):** Runs every 60ms even when JASSUB is rendering `primTrack` with no secondary sub; `textTrackToCues` (`L162-164`) bypasses `trackCueMemo` whenever `activeFallback` is used and invokes full `parseSubtitles("WEBVTT\n\n...", "vtt")` per `<`-containing cue (`L176-177`). Schedule a single `setTimeout` to the next cue boundary and memoize inline VTT span parsing per cue text.
  - **HLS Dual-Subs & Shaka DASH (`Player.tsx:725-731, 1835`):** `hls.subtitleTrack` only loads segments for one HLS subtitle track at a time (starving `secondarySub` when both are HLS tracks), and `attachDash` (`L1835`) installs `StubTextDisplayer()` without bridging `player.getTextTracks()` into `UnifiedSubTrack`.
  - **JASSUB paused render & `C` toggle teardown (`SubtitleOverlay.tsx:91-183`):** `instance.resize(true)` (`L156, 180`) is a no-op in `jassub.js:146` when `_lastDemandTime` is unset while paused—call `instance.renderer?.manualRender(...)` when paused; remove `subEnabled` from `isAssTrack` (`L91`) and hide the canvas via CSS when toggled off (`C`) instead of calling `active.destroy()` and tearing down the 2.19 MB WASM worker.
  - **Shared offset & `langBase` (`Player.tsx:625, 1293-1305`):** Split `offset` into `primaryOffset` and `secondaryOffset`, and replace `langBase` with `normalizeSubLang` across `Player.tsx` and `SubtitleSheet.tsx` so `pt-BR` and `zh-TW` remain distinct.
  - **Online subtitle providers (`subtitleProviders.ts:275-280, 321-323, 650-665, 717-789`):** Return `{ hash, fileSize }` from `compute_oshash` so OpenSubtitles v3 receives `videoSize`; score filenames in `extractFirstSubtitleFromZip` (`L717-789`) against `SxxEyy` / episode number before format priority so season-pack ZIPs don't always extract Episode 1; pass `query.languages` to `queryWyzie` (`L275-280`); and throw when all queried providers reject in `searchOnlineSubtitles` (`L650-665`) so `SubtitleSheet` displays the error instead of `"No online subtitles matched"`.
  - **MKV multi-audio in WebView2 (`lib.rs:917`, `Player.tsx:1496-1525`):** Because `HTMLVideoElement.audioTracks` is disabled in default Chromium/WebView2, expose audio stream metadata via `ffprobe` in Rust and pass a selected `audioStreamIndex` (`-map 0:a:<idx>`) to local media preparation.

---

### 3.4 Subsystem 4 — Catalog, Multi-Cour Mapping, IndexedDB/Cache, Account Sync & Fastify API

#### 16. `[HIGH]` `idb.ts` Permanent Null Latching, Deferred Hydration Race & `animeMapping.ts` `loadEpoch` / `tmdbOffset` Bugs
- **Location:** [src/lib/idb.ts:14-38](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/idb.ts#L14-L38), [src/lib/animeMapping.ts:442-474, 587, 607-642, 682-690, 907-925, 997-1037, 1214-1231](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/animeMapping.ts#L442-L474), [src/lib/normalizer.ts:222-226, 331](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts#L222-L226)
- **Root Cause:**
  1. **`idb.ts` & `hydrateFromIdb` error latching:** In `idb.ts:16-36`, if `indexedDB.open` hits `onerror`, `onblocked`, or throws transiently, `opening` resolves to `null` and is **never reset** (`opening = null` only runs on `onversionchange`), permanently disabling IndexedDB for the session. Similarly, `hydrateFromIdb()` (`animeMapping.ts:445-465`) swallows errors via `.catch(() => {})` without resetting `hydrating = null`.
  2. **Startup unsplit-cour cache poisoning (`animeMapping.ts:470-474`, `tmdb.ts:251`, `anilist.ts:296`):** `hydrateFromIdb()` is deferred via `requestIdleCallback(..., { timeout: 3000 })` / `setTimeout(..., 500)`. Any `getDetail()` call during the first 0.5–3s reads an empty `memIndex` synchronously via `getOrHydrateMemIndex()`, fails to split multi-cour seasons, and caches the unsplit `MediaDetail` in `cache.ts` (`localStorage`) for **3–6 hours**!
  3. **`loadEpoch` & `clearAnimeMappingCache` races (`animeMapping.ts:607-642, 682-690`):** Fribb (`L607-615`) and Anibridge (`L623-631`) `.then()` callbacks mutate `idx`, write to IDB (`writeStorageJson`), and reset `fribbFailedAt = 0` without checking `epoch === loadEpoch`, and `.finally(() => { inflightLoad = null; })` (`L640-642`) wipes a newer call's `inflightLoad` if `clearAnimeMappingCache()` ran mid-flight.
  4. **Missing `tmdbOffset` deduplication & blind `[0]` fallbacks (`animeMapping.ts:907-925, 997-1008, 1214-1231`):** Line `1214` has the comment `// Deduplicate by offset, keeping entries within [0, episodeCount)` with **no deduplication code** (`valid` is only `.filter(r => r.tmdbOffset < episodeCount)`), so duplicate `tmdbOffset` rows produce `endEpisode < startEpisode` (`L1231`) and drop Cour 1! In `resolveWithIndex` (`L907-920`), `best = fribbSeasonList[0]` assigns Cour 2's IDs even when `ep <= best.tmdbOffset`, and lines `997-1008` pick `abByImdb[0]` before running Fribb season/offset matching (`L1011-1037`).
  5. **Unused `tmdbSeasons` parameter (`normalizer.ts:222, 331`):** `reconcileAnimeSeasons` supports a `tmdbSeasons` cross-check, but no caller in `anilist.ts:207, 296` or `catalog.ts:70` ever passes it, and `L331` indexes `validTmdbSeasons[prevSeason.number - 1]` positionally instead of `.find(s => s.seasonNumber === prevSeason.number)`.
- **Concrete Fix:** Reset `opening = null` in `idb.ts:31-35` when open resolves `null`; start `hydrateFromIdb()` immediately at module load (0ms delay) and await it in `getDetail()` before `normalizeTmdbSeasons` / `reconcileAnimeSeasons`; guard `writeStorageJson` and `inflightLoad = null` with `if (epoch === loadEpoch)`; deduplicate `valid` by `tmdbOffset` at `animeMapping.ts:1215`; and guard `ep > best.tmdbOffset` at `L907`.

#### 17. `[HIGH]` Anime `MOVIE` vs TV Representation Mismatch Across `Title`, `Watch`, `local.ts`, `search.ts` & Extractors
- **Location:** [src/lib/anilist.ts:90-105](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/anilist.ts#L90-L105), [src/lib/normalizer.ts:654, 787](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts#L654), [src/pages/Title.tsx:155, 163, 165, 500-515](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Title.tsx#L155-L165), [src/pages/Watch.tsx:71, 74, 210](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx#L71-L74), [src/sources/local.ts:208-215](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/local.ts#L208-L215), [src/lib/search.ts:56, 79](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/search.ts#L56-L79), [src/sources/extractors/anizone.ts:136](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/anizone.ts#L136), [src/sources/extractors/anikoto.ts:140](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/anikoto.ts#L140)
- **Root Cause:** TMDB anime films have `kind: "movie"`, whereas AniList anime films (`format: "MOVIE"`) have `kind: "anime", format: "MOVIE"`. Although `isFilm(m)` was added in `v1.6.0`, multiple call sites still branch on `kind === "movie"` / `kind !== "movie"`:
  - `Title.tsx:155, 163, 165` sets `startS = 1, startE = 1` on AniList movies, appending `?e=1` to the Watch URL and rendering `"First aired"` / `"min per episode"` in `Details` (`L500-515`).
  - `Watch.tsx:71, 74, 210` sets `isEpisodicAnime = true` and mounts the Episode switcher drawer for anime films.
  - `sources/local.ts:208-215` skips local movie files whenever `req.episode != null`—so passing `?e=1` from `Title.tsx` breaks local drive playback of AniList anime movies!
  - `normalizer.ts:654, 787` (`resolvePlaybackRequest`, `resolveNextEpisode`), `play.ts:25`, `progress.ts:83`, `anizone.ts:136`, and `anikoto.ts:140` treat AniList movies as episodic TV.
  - `search.ts:56, 79` fails to deduplicate a TMDB anime movie (`kind: "movie"`) against the same AniList anime movie (`kind: "anime"`), showing duplicate cards in search results.
- **Concrete Fix:** Export a shared `isFilm(m: { kind: MediaKind; format?: string })` helper from `src/lib/types.ts` (`m.kind === "movie" || m.format === "MOVIE"`) and use it uniformly across `Title.tsx`, `Watch.tsx`, `normalizer.ts`, `local.ts`, `play.ts`, `progress.ts`, `search.ts`, `Hero.tsx`, and all extractors.

#### 18. `[HIGH]` Cross-Device Delete Resurrection, Sign-Out Subtitle/Settings Leakage, Non-Transactional Refresh Rotation & Render Free-Tier Risks
- **Location:** [src/lib/progress.ts:203-217](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/progress.ts#L203-L217), [src/lib/watchlist.ts:82-88](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/watchlist.ts#L82-L88), [src/lib/settings.ts:92-119, 172, 242-246](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/settings.ts#L242-L246), [src/lib/subtitles.ts:1391-1435](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/subtitles.ts#L1391-L1435), [server/src/auth.js:50-69, 85-98](file:///c:/Users/Ayomide/Documents/abixcine/server/src/auth.js#L50-L98), [server/src/db.js:14-15, 31-84](file:///c:/Users/Ayomide/Documents/abixcine/server/src/db.js#L14-L15), [render.yaml:7, 30](file:///c:/Users/Ayomide/Documents/abixcine/render.yaml#L7)
- **Root Cause:**
  1. **Cross-device delete resurrection:** `DELETE /progress/:key` and `DELETE /watchlist/:key` ([server/src/app.js:271-274, 293-296](file:///c:/Users/Ayomide/Documents/abixcine/server/src/app.js#L271-L296)) hard-delete rows without storing `deleted_at` tombstones. When Device B runs `pull()`, `watchlist.ts:82-88` re-pushes all `localOnly` items back to the server and `progress.ts:203-217` merges `{ ...store }`, resurrecting items deleted on Device A!
  2. **Sign-out data bleed:** `settings.ts:246` clears only `audioByTitle: {}` while `mirrorSubtitlePref` (`L92-119, 172`) merges `{ ...existing, ...clean }` from `abx.subs.v1`, and `subtitles.ts:1391-1435` (`abx.submem.v1`, up to 120 per-title subtitle choices) has no `registerSync({ clear })` hook—leaking Account A's per-title subtitle memory into Account B.
  3. **Watchlist `canonicalKey` inconsistency:** `Title.tsx:100, 315` uses `d.canonicalKey ?? key`, whereas `Card.tsx:99, 169`, `Hero.tsx:40, 134`, and `CommandPalette.tsx:280, 302` pass `m.key` directly to `useSaved`/`toggleList`.
  4. **Server auth/DB & Render deployment:** `rotateRefresh` (`server/src/auth.js:50-69`) executes `UPDATE refresh_tokens`, `SELECT * FROM users`, and `INSERT INTO refresh_tokens` outside a SQL transaction (`BEGIN`/`COMMIT`); `requireUser` (`L95`) runs `SELECT token_version FROM users WHERE id = $1` on every single API request; `db.js:15` sets `ssl: { rejectUnauthorized: false }`; and `render.yaml:7, 30` uses Render `plan: free` web + Postgres (which sleeps after 15m idle—causing `account.ts:266` 10s `checkServer` timeout to skip `resync()`—and deletes the free Postgres database after 30 days).
- **Concrete Fix:** Add `deleted_at timestamptz` soft-delete tombstones to `progress` and `watchlist`; register a `clear()` hook in `subtitles.ts` for `abx.submem.v1`; use `m.canonicalKey ?? m.key` in `watchlist.ts:has/toggleList`; wrap `rotateRefresh` in a single SQL CTE or transaction; cache `token_version` in a short-TTL server Map invalidated on `revokeAll`/`DELETE /me`; and upgrade `render.yaml` database/web plans + cold-start retry backoff.

---

### 3.5 Subsystem 5 — "Projection" UI, CSS Architecture, Accessibility, Responsive Layout & Build Config

#### 19. `[HIGH]` `CommandPalette` vs `Watch`/`Player` `Escape` Leak, 130ms Hotkey Lockout & `aria-hidden` Focus Violation
- **Location:** [src/components/CommandPalette.tsx:30, 63, 180-187, 205-206, 256, 296-305](file:///c:/Users/Ayomide/Documents/abixcine/src/components/CommandPalette.tsx#L180-L305), [src/pages/Watch.tsx:201-206](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx#L201-L206), [src/components/Player.tsx:2444, 2505, 3188-3197](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L2444)
- **Root Cause:**
  1. `Watch.tsx:201-206` attaches `window.addEventListener("keydown", e => e.key === "Escape" && back())` on the source race screen (`!start`) **without checking `document.querySelector('[aria-modal="true"]')`**.
  2. `CommandPalette.tsx:180` binds `onKeyDown` on `.palette` (React root delegation) rather than a capture-phase `window` listener. If the user clicks non-focusable whitespace inside `.palette`, focus drops to `document.body`; pressing `Escape` then bypasses `.palette`'s `onKeyDown` and fires `Watch.tsx:203` (`back()`, aborting source resolution) or `Player.tsx:2505` (`leave()`)! Conversely, during the `CLOSE_MS = 130` exit animation (`CommandPalette.tsx:30, 63`), `.palette[aria-modal="true"]` remains in the DOM and blocks `Player.tsx:2444` hotkeys.
  3. `CommandPalette.tsx:256` marks `<aside className="pal-preview" aria-hidden>` while rendering an interactive `<button type="button" className="link-btn" onClick={() => toggleList(m)}>` inside it (`L296-305`), violating WCAG 4.1.2 (`aria-hidden-focus`).
  4. In `Player.tsx:3188-3197`, `.pkeys` (Keyboard Shortcuts dialog) has `role="dialog"` without `aria-modal="true"` or focus trapping, and when `isEmbed` is true (`L2460-2491`), keys `0-9`, `m`, `c`, `[`/`]`, and `<`/`>` still fire `<video>` state mutations and toasts.
- **Concrete Fix:** Handle `Escape` in `CommandPalette` via a capture-phase `window` listener (`e.stopImmediatePropagation()`), guard `Watch.tsx:203` with `if (document.querySelector('[aria-modal="true"]')) return;`, omit `aria-modal="true"` when `!open` (during `closing`), remove `aria-hidden` from `.pal-preview`, and add `aria-modal="true"` to `.pkeys`.

#### 20. `[MEDIUM]` `TitleBar.tsx` Eagerly Pulls `166.7 KB` `registry.js` on Startup + `App.tsx` Eager Idle Preload + Redundant WASM/Font Assets
- **Location:** [src/components/TitleBar.tsx:32-45](file:///c:/Users/Ayomide/Documents/abixcine/src/components/TitleBar.tsx#L32-L45), [src/App.tsx:20-33, 105-107](file:///c:/Users/Ayomide/Documents/abixcine/src/App.tsx#L20-L33), [src/components/SubtitleOverlay.tsx:127-130](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SubtitleOverlay.tsx#L127-L130), [src/main.tsx:1-5](file:///c:/Users/Ayomide/Documents/abixcine/src/main.tsx#L1-L5), [package.json:20](file:///c:/Users/Ayomide/Documents/abixcine/package.json#L20)
- **Root Cause:**
  1. `TitleBar.tsx:28-30` states *"The registry (every extractor) is a large module the shell shouldn't pull into the startup bundle"*, yet `useServerCount` (`L35-43`) runs `import("../sources/registry")` inside `useEffect(..., [s])` immediately on first mount! This forces the browser to download and evaluate `registry-LAPyOYCZ.js` (`166,678 B` / `54.91 kB` gz) during initial page load.
  2. `SubtitleOverlay.tsx:127-130` statically imports both `jassub-worker-modern.wasm?url` (`2,191,920 B`) and legacy non-SIMD `jassub-worker.wasm?url` (`2,048,179 B`) + `jassub-worker.js?url` (`80,424 B`), even though `vite.config.ts:18` targets `chrome110` where WebAssembly SIMD is universally supported.
  3. `package.json:20` lists unused `@fontsource-variable/sora`, and `main.tsx:1-5` imports all script subsets (`vietnamese`, `cyrillic`, `greek`) plus legacy `.woff` files for `instrument-serif` (`37.6 kB`).
- **Concrete Fix:** Compute the enabled server count from lightweight provider metadata (`embeds.ts` + `stremio` + `plugins` + static direct extractor IDs in `settings.ts`) without importing `registry.ts`; remove legacy `jassub-worker.wasm?url` and `jassub-worker.js?url` imports (passing `modernWasmUrl` for both or gating behind runtime SIMD check); remove `@fontsource-variable/sora` and import only `latin`/`latin-ext` `.woff2` font subsets.

#### 21. `[MEDIUM]` Broken `:root.reduce-motion .hud` Selector, Compact Window Overflows, `FitsTonight` CLS & Unvirtualized Grids
- **Location:** [src/styles/base.css:143, 150, 199-203, 353-374](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L353-L374), [src/styles/browse.css:57, 210, 224, 456-461](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L456-L461), [src/styles/player.css:142-186, 216, 271-272, 321, 385, 414](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css#L142-L186), [src/components/FitsTonight.tsx:50, 62-69, 90-91](file:///c:/Users/Ayomide/Documents/abixcine/src/components/FitsTonight.tsx#L50), [src/pages/Title.tsx:71, 327-363, 418-430](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Title.tsx#L418-L430), [src/pages/Settings.tsx:143-148, 247-274, 771-820, 938-962](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Settings.tsx#L771-L820)
- **Root Cause & Concrete Fixes:**
  - **Broken `.reduce-motion` glass rule (`base.css:369-374`, `player.css:153`):** `base.css:369` targets `.hud` (which does not exist in JSX) instead of `.ptop-actions`, `.pbot`, `.cc-btn`, `.smart`, and `.race-grid-wrap`, and `@media (prefers-reduced-motion: reduce)` (`L370-374`) omits `backdrop-filter: none`.
  - **`.source-tile` layout wrap (`browse.css:456, 461`, `Settings.tsx:794-818, 938-962`):** `.source-tile` has `flex-direction: column`, pushing the trash/remove `<button className="icon-btn">` onto a broken second row underneath the toggle label. Wrap the label and delete action in a horizontal flex row.
  - **Settings Stremio presets & `healthTick` churn (`Settings.tsx:143-148, 247-274, 771-788`):** `installedManifestUrls` (`L247`) compares raw strings instead of `normalizeManifestUrl()`; `handleInstallStremioPresets` (`L263-267`) hides which preset failed; and `useEffect(..., [hasOpenCircuit, healthTick])` (`L143-148`) tears down and recreates `setInterval(..., 15_000)` on every tick.
  - **`FitsTonight.tsx` CLS & head-of-line stall (`L50, 68-69, 90-91`):** `Promise.all(pool.slice(0, 18).map(getDetail))` blocks the entire shelf on the slowest of 18 requests, and returning `null` at `L69` collapses ~300px of skeleton height. Stream results progressively via `Promise.allSettled` and keep a stable container height.
  - **`Title.tsx` full-page progress re-renders & un-resized `original` backdrops (`L71, 418-430`):** Calling `useProgressStore()` at top of `Title.tsx` re-renders the entire 553-line page on progress updates, and `const still = e.still ?? d.backdrop` (`L422`) passes `original`-sized `d.backdrop` URLs to 50 episode `<img loading="lazy">` tiles instead of `sized(d.backdrop, "w300")`.
  - **Dead/conflicting CSS:** Remove unused `.top-drag` (`base.css:150`), `.btn-primary` (`base.css:199`), `.smart-play` (`browse.css:224`), duplicate `.ptop` (`player.css:142`), and reconcile `.sub-select` height (`player.css:385` `34px` vs `player.css:414` `38px`).

---

## 4. Part 2: Comprehensive Optimization Blueprint

### 4.1 Time-to-First-Frame (TTFF), Extractor Concurrency & Resilience (`src/sources/`)

1. **Eliminate 3×–4× Redundant `.m3u8` Fetches (`vixsrc.ts:188`, `anizone.ts:244`, `registry.ts:390, 489-511`, `session.ts:708-713`, `stream.rs:150-173`):**
   - Currently, extractors like `vixsrc` and `anizone` fetch the master `.m3u8` in `find()`, `quickCheck` fetches it a second time, `commit()` -> `playCheck` fetches the master + media playlist + 64 KiB of segment 0 (`needsConfirm` at `session.ts:708-713` only skips `via === "sniffed"` `abxs:` URLs, not `via === "direct"`), and `hls.js` fetches master + media + segment 0 a fourth time.
   - **Optimization:** Route all direct HLS candidates through `proxyUrl` (`abxs:`) so `quickCheck` warms `stream.rs`'s `PLAYLISTS` cache and populates `probe.quality`; extend `needsConfirm` (`session.ts:711`) to skip redundant `playCheck` on verified `via === "direct"` `abxs:` HLS manifests (or cache the 64 KiB segment-0 pre-read in Rust so `hls.js` hits warm bytes in `0 ms`), cutting **300–700 ms** off TTFF.
2. **Coalesce `resolveMediaIds` & Bound `enc-dec.app` / Extractor Concurrency (`common.ts:182-209`, `encdec.ts:11-76`, `session.ts:347, 515`):**
   - Deduplicate in-flight `resolveMediaIds(req)` calls per `reqKey(req)` so 17 parallel extractors share a single TMDB/AniList/Fribb ID lookup.
   - Add a 3-slot semaphore + jittered `429` retry inside `encdec.ts` (shared by `hexa`, `vidup`, `cinejoy`, `meowtv`, `vidlink`, and `kisskh`) and switch `session.ts` `directQueue` from global FIFO (`AUTO_DIRECT_CHECKS = 12`) to round-robin per `providerId` sorted by EWMA latency.
3. **Side-Effect-Free Hover / Title-Mount Warming (`SmartSource.tsx:14`, `Card.tsx:84-95`, `session.ts:345`, `stremio.ts:886-904`):**
   - Introduce a `mode: "warm" | "active"` flag on `SourceSession`: on `Title.tsx` mount (`SmartSource`), run read-only direct extractors and cache checks without creating Debrid magnets or spawning off-screen WebView2 `sniff-*` windows; upgrade to `"active"` immediately on Play click.
4. **Lazy KissKH Subtitle Decryption (`kisskh.ts:326-364, 447-466`):**
   - Emit the video `StreamCandidate` as soon as the `.m3u8` URL resolves; defer fetching and AES-128-CBC decrypting `.txt`/`.txt1` subtitle files until the user selects that subtitle track (or route through an `abxs:` subtitle decrypt parameter), saving **400–1,200 ms** on Asian drama startup and unlocking all subtitle languages beyond `MAX_DECRYPT_SUBS = 3`.

### 4.2 Bundle Size, Startup JS & WASM Diet (`vite.config.ts`, `TitleBar.tsx`, `enhance.ts`, `SubtitleOverlay.tsx`)

1. **Remove `registry.js` from Initial Startup Path (`TitleBar.tsx:32-45`):**
   - Replace `import("../sources/registry")` in `useServerCount` with a lightweight helper in `settings.ts` counting enabled static direct extractors + enabled embeds + configured Stremio/Jellyfin/Local/Plugin lanes, cutting **`166.7 KB` (`54.9 KB` gz)** from initial page boot.
2. **Drop Redundant Non-SIMD JASSUB WASM & Unused Fonts (`SubtitleOverlay.tsx:127-130`, `main.tsx:1-5`, `package.json:20`):**
   - Because `vite.config.ts:18` targets `chrome110`, remove static `?url` imports of legacy `jassub-worker.wasm` (`2,048,179 B`) and `jassub-worker.js` (`80,424 B`), remove unused `@fontsource-variable/sora` from `package.json`, and import only `latin`/`latin-ext` `.woff2` subsets—saving **`~2.21 MB`** in build output.
3. **Modularize `anime4k-webgpu` (`3.45 MB` -> `~15–150 KB` per tier) (`enhance.ts:54-55, 270-313`):**
   - `anime4k-webgpu/lib/index.js` bundles unused `GANx4UUL`, `GANx3L`, `GANUUL`, `CNNUL`, `CNNx2UL`, `CNNSoftVL`, and `DenoiseCNNx2VL` weight matrices as inline JS arrays. Extract only the 7 WGSL pipelines used by `buildChain` (`DoG`, `ClampHighlights` with tracked textures, `CNNM`, `CNNSoftM`, `CNNx2M`, `CNNVL`, `CNNx2VL`) into lazy per-tier modules so `clarity` loads ~5 KB and `fast` loads ~45 KB instead of `3.45 MB`.

### 4.3 Player Render Isolation, WebGPU Pipeline Caching & Cue Scheduling (`Player.tsx`, `enhance.ts`, `subtitles.ts`)

1. **Isolate `<PlayerScrubber>` & `<TimeReadout>` (`Player.tsx:254, 2577, 2761-2776, 2883-2895`):**
   - Move `time`, `buffered`, `hover`, and `dragging` out of the top-level 3,414-line `Player` component into dedicated leaf components subscribed to a lightweight playback clock store, driving the progress fill via CSS `transform: scaleX(var(--p))` on a compositor layer.
2. **Cache `GPUComputePipeline` Objects & Use `importExternalTexture` (`enhance.ts:703, 749, 808`):**
   - Cache compiled `GPUShaderModule` and `GPUComputePipeline` instances in a `WeakMap<GPUDevice, Map<string, GPUComputePipeline>>` so resolution/ABR switches don't recompile 18–35 WGSL shaders, and use `device.importExternalTexture({ source: video })` when supported to eliminate per-frame texture copy overhead.
3. **Boundary-Driven Subtitle Cue Timer (`Player.tsx:1401-1407`, `subtitles.ts:1264-1294`):**
   - Replace `window.setInterval(evaluateCues, 60)` with a single `setTimeout` scheduled for `(nextBoundarySec - video.currentTime) * 1000 / video.playbackRate` (re-armed on `seeked`, `ratechange`, `play`, and `offset` change), reducing subtitle CPU wakeups from `16.7 Hz` to `~0.3 Hz`.

### 4.4 Rust Zero-Copy Loopback Streaming Gateway, FFmpeg fMP4 & Binary IPC (`src-tauri/`)

1. **Unified `127.0.0.1` `hyper` Streaming Gateway (`stream.rs`, `torrent.rs`, `lib.rs`):**
   - `wry-0.57.2` buffers entire `Response<Vec<u8>>` bodies in RAM, copies them into COM `SHCreateMemStream`, and marshals across the WebView2 UI thread (`webview2/mod.rs:1111, 1227`).
   - Using `hyper` (already compiled in `Cargo.lock` via `librqbit`), bind a single loopback HTTP server on `127.0.0.1:0` authenticated by a per-launch 128-bit path token (`/s/<token>/...`) and strict `Origin` checks. Stream `reqwest::Response::bytes_stream()`, local library files, and `librqbit` `FileStream` chunks zero-copy in 64 KiB buffers off the UI thread, while eliminating `abxs.localhost` custom-scheme quirks and cumulative `assetProtocol` scope leaks.
2. **Progressive fMP4 Local Remux & Single-Pass Subtitle Extraction (`lib.rs:12, 917-965, 1110-1155`):**
   - Replace the global `MEDIA_PREPARE_LOCK` and blocking 2-pass `-movflags +faststart` remux with per-file `OnceCell` locks and progressive fragmented MP4 (`-movflags +frag_keyframe+empty_moov+default_base_moof`), and extract all text subtitle tracks in one multi-output `ffmpeg` invocation (`-map 0:s:0 out0.vtt -map 0:s:1 out1.vtt ...`).
3. **Binary IPC, Serialized Adblock Engine & HTTP/2 Adaptive Windows (`stream.rs:297-324, 1243-1278`, `shield.rs:291-335`):**
   - Return `tauri::ipc::Response` raw binary payloads from `http_fetch_bytes` (eliminating 33% Base64 JSON overhead); persist `adblock::Engine::serialize()` to `app_cache_dir()` for `<5 ms` cold startup; and enable `.http2_adaptive_window(true)` + `.tcp_nodelay(true)` on `stream::client()`.

### 4.5 IndexedDB Catalog Migration, 0ms SWR & Batch/Delta Sync (`src/lib/`, `server/`)

1. **True `0 ms` Stale-While-Revalidate (`cache.ts:9, 156-171`) & Full IndexedDB Storage (`idb.ts`):**
   - Set `STALE_WAIT_MS = 0` so stale cached shelves return synchronously in `0 ms` while revalidating in the background, and move `abx.cache.*` entries out of synchronous `localStorage` into `idb.ts` with true `lastAccessedAt` LRU eviction.
2. **WebWorker Mapping/Search Index (`animeMapping.ts`, `search.ts`, `library.ts`):**
   - Parse Fribb/Anibridge JSON and build an in-memory trigram title index inside a dedicated ES WebWorker so `Search`, `CommandPalette`, and `library.ts` `matchDrive` resolve local/anime title matches in `<5 ms` without main-thread jank or `searchAll` network bursts.
3. **Batch Outbox & Delta Sync (`account.ts`, `progress.ts`, `server/src/app.js`):**
   - Add `POST /sync/batch` (draining queued progress/watchlist/settings writes in one transaction), `GET /sync?since=<ms>` delta pulls backed by `deleted_at` tombstones, and `<link rel="preconnect">` hints in `index.html` for `image.tmdb.org`, `api.themoviedb.org`, `graphql.anilist.co`, and `s4.anilist.co`.

---

## 5. Part 3: Next-Gen Product, UX & "Projection" UI Evolution

1. **Stremio Public HTTP Preset Cards & Per-Addon Telemetry Studio ([Settings.tsx:693-820](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Settings.tsx#L693-L820), [stremio.ts:408-470](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/stremio.ts#L408-L470)):**
   - Upgrade the batch-only `"Load all"` row in `Settings.tsx:771-788` into a curated grid of individual `PUBLIC_HTTP_STREMIO_PRESETS` cards (`Absolute Cinema`, `Flix-Streams Free`, `Motchill Direct Stream`, `Stravo II`, `Hyper`) displaying supported content types (`movie` / `series`), description notes, normalized install status (`normalizeManifestUrl`), one-click individual install/remove, and exact error diagnostics when a preset is unreachable.
   - Expand `.health-list` (`Settings.tsx:693-736`) to show per-addon and per-plugin latency (ms), circuit-breaker state, and a one-click *"Test / Refresh Manifest"* button.
2. **Interactive Live Anime4K A/B Split-Wipe Comparison ([Player.tsx:3085-3150](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L3085-L3150), [enhance.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/enhance.ts)):**
   - Add a `"Compare"` toggle in the Picture sheet that keeps the native `<video>` visible beneath `.enhance-canvas` and renders a draggable vertical split-wipe handle (`clip-path: inset(0 0 0 var(--wipe-x))` on `.enhance-canvas` or `uSplitX` in the final shader pass) plus a hold-`B` instant bypass key, showing live `Original` vs `Enhanced (Anime4K + CAS)` output and GPU frametime telemetry.
3. **Frame-Accurate Trickplay Scrub Previews & Visual Chapters ([Player.tsx:2868-2896](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L2868-L2896), [skipSegments.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/skipSegments.ts)):**
   - Parse HLS `#EXT-X-IMAGE-MEDIA`, DASH thumbnail tracks, and WebVTT `#xywh=` sprite sheets (with a throttled offscreen seek-preview `<video>` / local FFmpeg sprite fallback) to display `160×90` frame previews above `.scrub-tip`, paired with color-coded `Intro`, `Recap`, `Outro`, and `Preview` chapter segments on the scrub bar.
4. **Web Audio Studio Dynamics, Night Mode & Dialogue Boost ([Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx)):**
   - Route CORS-safe `<video>` playback through an optional Web Audio API graph: `BiquadFilterNode` (3-band *Dialogue Clarity* vocal presence boost) -> `DynamicsCompressorNode` (*Night Mode* dynamic range compression) -> `GainNode` (safe pre-amp up to `200%` / `+6 dB` with brickwall limiting) -> `DelayNode` (`-500ms..+500ms` Bluetooth A/V sync offset).
5. **Interactive Dual-Language Transcript Drawer & One-Tap Line Sync ([SubtitleSheet.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SubtitleSheet.tsx), [subtitles.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/subtitles.ts)):**
   - Render a virtualized, searchable transcript timeline inside `SubtitleSheet` from loaded `SubtitleCue[]` tracks supporting click-to-seek, side-by-side primary/secondary cues, A–B phrase looping, and a one-click *"Sync to line just spoken"* button (`offset = video.currentTime - cue.start`).
6. **Two-Way PKCE Scrobbling (AniList / Trakt / SIMKL) & Household Profiles (`server/`, `account.ts`, `Title.tsx`):**
   - Add PKCE OAuth scrobbling using `animeMapping.ts` (`anilistId`, `malId`, `courEpisode`) so multi-cour anime progress syncs to the exact AniList cour entry, render TMDB Movie Collections (`/collection/\d+` is already enabled in `server/src/tmdb.js:1`) and AniList Franchise Watch-Order timelines on `Title.tsx`, and support multi-profile household accounts with optional Kids maturity filter + PIN lock.
7. **10-Foot TV Mode & 2D Spatial Gamepad Navigation (`App.tsx`, `TitleBar.tsx`, `Hero.tsx`, `Title.tsx`):**
   - Add a `navigator.getGamepads()` + arrow-key 2D spatial focus engine across shelves, complete WAI-ARIA roving tabindex on `TitleBar` menus and `Title` tablists, and expose accessible slide switcher + pause controls on `Hero` below `1180px`.

---

## 6. Part 4: Phased Implementation Roadmap (`P0`–`P3`)

### Phase 0 (`P0`): Critical Security, Extractor & Stability Hotfixes (Days 1–3)
- **Rust Security & Torrent Stability:**
  - Gate `abxs:` to `ctx.webview_label() == "main"` ([lib.rs:1358](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L1358)); add private/loopback/link-local IP + redirect hop validation to `stream::handle`, `http_fetch`, and `http_fetch_bytes` ([stream.rs:307-324, 877-984, 1164-1278](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/stream.rs#L307-L324)).
  - Fix `abxNoWoiF` clobbering `build_player_hook_script` `window.open` ([shield.rs:170-184, 566-654](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/shield.rs#L170-L184)), replace `headers_by_uri.clear()` with bounded FIFO eviction (`L820`), add `.incognito(true)` (`L1579`), enforce `NavigationStarting` on `sniff-*` windows (`L1206`), and guard test env vars with `#[cfg(debug_assertions)]` ([lib.rs:1345](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L1345)).
  - Set `runtime_worker_threads: Some(32)` in [torrent.rs:317-327](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/torrent.rs#L317-L327), cap all range windows to `MAX_WINDOW` (`L525`), and replace `Notify` with stateful cancellation (`L601`).
- **Extractor, Sandbox & Upscaler Hotfixes:**
  - Lock WebWorker prototype chains + RPC nonce + non-empty `allowedHosts` in [pluginRunner.ts:256, 558-599](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/pluginRunner.ts#L558-L599).
  - Fix [onetouchtv.ts:73, 170, 203](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/onetouchtv.ts#L73) base64url regex/lang/episode bugs, [animeheaven.ts:166, 186](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/animeheaven.ts#L166) early break & unranked slice, and [hexa.ts:58, 148](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/extractors/hexa.ts#L58) `capToken` dedup & retry loop.
  - Memoize `webgl2Available()` ([enhance.ts:39-49](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/enhance.ts#L39-L49)) and fix `gpuEma` `stamp === false` / background-tab false downgrades (`L856, 926`).
- **Verification Gate:** `npx tsc --noEmit`, `npx vitest run`, `cargo test --manifest-path src-tauri/Cargo.toml --features torrent`, and `npm --prefix server test` all pass with regression tests for `onetouchtv` base64url, `hexa` retry, `abxNoWoiF`, and `webgl2Available` memoization.

### Phase 1 (`P1`): Source Session, Debrid/Stremio, Player Lifecycle & Catalog Correctness (Week 1–2)
- **Sources & Debrid:** Defer Debrid magnet creation until `commit()` ([stremio.ts:886-904](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/stremio.ts#L886-L904), [debrid.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/debrid.ts)), handle RD `instantAvailability` 403 gracefully, guard `session.refresh()` on `via === "sniffed"` ([session.ts:862](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/session.ts#L862)), refcount `verify()` aborts (`L848`), add per-provider `AUTO_DIRECT_CHECKS` + 3-slot `encdec.ts` queue, and wire `createPluginProviders()`.
- **Player & Subtitles:** Preserve audio/subtitle selections and `paused` state across same-server token refreshes ([Player.tsx:800, 1628, 1656](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L800)); fix JASSUB paused `manualRender` + keep worker alive on `C` toggle ([SubtitleOverlay.tsx:91, 156](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SubtitleOverlay.tsx#L91)); split primary/secondary subtitle offsets; fix season-pack ZIP episode matching and OSHash `fileSize` ([subtitleProviders.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/subtitleProviders.ts)); and fix `CommandPalette` / `Watch` `Escape` collision ([CommandPalette.tsx:180](file:///c:/Users/Ayomide/Documents/abixcine/src/components/CommandPalette.tsx#L180), [Watch.tsx:203](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx#L203)).
- **Catalog & Sync:** Unify `isFilm()` across all 10 movie/anime call sites; fix `idb.ts:16` error latching, immediate `hydrateFromIdb()`, and `animeMapping.ts:1215` `tmdbOffset` deduplication; add `deleted_at` sync tombstones, `abx.submem.v1` sign-out clear, and transactional `rotateRefresh` ([server/src/auth.js:50](file:///c:/Users/Ayomide/Documents/abixcine/server/src/auth.js#L50)).
- **Verification Gate:** Zero unrequested Debrid magnets added on `Title` mount; anime movies (`format: "MOVIE"`) resolve movie endpoints across local/direct/embed lanes; cross-device deletes do not resurrect on `pull()`.

### Phase 2 (`P2`): Speed, Bundle Diet, Zero-Copy Streaming Gateway & Render Isolation (Weeks 3–4)
- **Bundle & Startup:** Remove `TitleBar.tsx:37` `import("../sources/registry")` (`-166.7 KB` startup JS), drop legacy `jassub-worker.wasm` (`-2.13 MB`) and unused fonts, and modularize `anime4k-webgpu` into lazy WGSL pass chunks (`3.45 MB` -> `~15–150 KB`).
- **Player & TTFF:** Extract `<PlayerScrubber>` / `<TimeReadout>`, switch subtitle cues to boundary `setTimeout` scheduling, cache WebGPU `GPUComputePipeline`s, coalesce `resolveMediaIds`, and skip redundant `playCheck` on verified `abxs:` HLS manifests.
- **Rust & Storage Architecture:** Replace `abxs:` `Vec<u8>` buffering + `assetProtocol` + torrent TCP with the unified loopback `hyper` streaming server; add progressive fMP4 local remuxing, single-pass multi-track subtitle extraction, binary IPC for `http_fetch_bytes`, IndexedDB migration for `cache.ts` (`STALE_WAIT_MS = 0`), WebWorker trigram search, and `POST /sync/batch`.
- **Verification Gate:** `npx vite build` initial JS shell `< 385 KB` with zero eager `registry.js` load; `<Player>` re-renders `0` times on `timeupdate`/scrub hover; Rust streaming memory footprint `< 2 MiB` per active 4K stream.

### Phase 3 (`P3`): Next-Gen "Projection" Theater Craft & Ecosystem Features (Weeks 5–6)
- Ship individual `PUBLIC_HTTP_STREMIO_PRESETS` cards + per-addon health diagnostics in `Settings.tsx`, interactive Anime4K live A/B split-wipe comparison in `Player.tsx`, trickplay scrub thumbnails + `recap`/`preview` chapter markers, Web Audio 3-band EQ / Night Mode / 200% boost, searchable dual-language transcript drawer with one-tap line sync, TMDB Collections + AniList Franchise timelines, two-way PKCE scrobbling, multi-profile support, and 10-ft Gamepad spatial navigation.
