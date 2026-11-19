# AbixCine Bug, Use-Case, Smoothness & Distribution Audit

**Audit Baseline:** `abixcine@1.9.0` (`b8c53b8`)
**Scope:** Full end-to-end investigation of functional bugs, edge-case flows, player/navigation UX gaps, UI smoothness bottlenecks, and Windows external-user installer/execution blocks.
**Legend:**
- `[x] Fixed` — Resolved and verified in this audit cycle.
- `[ ] Open` — Left intentionally open (heavy architectural rewrite or external code-signing/distribution infrastructure required).

---

## 1. Unreleased Movies & Unaired / Non-Existent Episodes (`BUG-01` – `BUG-08`)

### `[x] Fixed` `BUG-01`: Unreleased films trigger full server searches and render as playable
- **Severity:** High
- **Locations:** [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts#L647-L657), [src/pages/Title.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Title.tsx#L146-L173)
- **Root Cause:** `resolvePlaybackRequest()` short-circuits `if (isFilm(detail)) return { media: detail, audio };` without inspecting `releaseDate` or `status` (`NOT_YET_RELEASED`, `Planned`, `In Production`, `Post Production`, `Rumored`). `Title.tsx` sets `canPlay = ready && (film || hasPlayableEps)` and renders both the Play button and `<SmartSource>`, immediately querying 20+ servers for films that have not been released yet.
- **Fix Plan:** Add `isUnreleasedMedia()` checking unreleased statuses and future `releaseDate`; return `null` from `resolvePlaybackRequest()` for unreleased films; hide Play and show release date notice in `Title.tsx` instead of `<SmartSource>`.
- **Resolution:** Added `isUnreleasedMedia()`, updated `resolvePlaybackRequest()` to return `null` for unreleased films, and gated `Title.tsx` Play CTA and `<SmartSource>` server lookup behind `!unreleasedFilm`.

### `[x] Fixed` `BUG-02`: Currently airing AniList anime exposes unaired future episodes as playable
- **Severity:** High
- **Locations:** [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts#L110-L121), [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts#L782-L836)
- **Root Cause:** `resolveAnilistEpisodeCount()` detects `nextAiringEpisode` (`const aired = Math.max(0, node.nextAiringEpisode.episode - 1)`), but when `node.episodes > 0` (which is the planned total season count, e.g., 12 or 24), it immediately returns `node.episodes` instead of the aired count! Consequently, an airing anime at Episode 4 of 12 renders Episodes 5–12 as playable, allows `resolveNextEpisode()` to advance to Episode 5, saves `upNext` progress to Episode 5, and probes all servers for episodes that haven't aired.
- **Fix Plan:** Clamp `resolveAnilistEpisodeCount()` using `nextAiringEpisode.episode - 1` (or `nextAiringEpisode.episode` once `airingAt * 1000 <= now`), and guard `RELEASING` shows whose `startDate` is strictly in the future.
- **Resolution:** Fixed `resolveAnilistEpisodeCount()` and `resolveNextEpisode()` in [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts) and prevented stale planned episode counts from leaking in [src/lib/catalog.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/catalog.ts).

### `[x] Fixed` `BUG-03`: TMDB future seasons and unaired episodes inside airing seasons leak into playable seasons
- **Severity:** High
- **Locations:** [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts#L135-L217), [src/lib/tmdb.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/tmdb.ts#L259-L260)
- **Root Cause:**
  1. `normalizeTmdbSeasons()` flags `isUpcoming = !!airDate && airDate > nowIso`, yet pushes `epCount > 0` future seasons into playable `seasons` with `status: "upcoming"` instead of `upcomingSeasons`.
  2. `tmdbDetail()` never passes `last_episode_to_air`, `next_episode_to_air`, or `status` into `normalizeTmdbSeasons()`, so an ongoing season with `episode_count: 10` where only 4 episodes have aired exposes Episodes 5–10 as playable and advances into unaired episodes.
- **Fix Plan:** Move future-dated / unreleased / post-`lastEpisode` seasons into `upcomingSeasons` (recording `plannedEpisodeCount`); clamp airing season `episodeCount` via `nextEpisode`/`lastEpisode` and pass `{ lastEpisode, nextEpisode, status }` from `tmdbDetail()`.
- **Resolution:** Implemented in [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts), [src/lib/types.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/types.ts), and [src/lib/tmdb.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/tmdb.ts) (detail cache bumped to `tmdb:detail:v4:`).

### `[x] Fixed` `BUG-04`: `Watch.tsx` falls back to querying servers even when `resolvePlaybackRequest` returns `null` or URL params request a nonexistent/unaired episode
- **Severity:** High
- **Locations:** [src/pages/Watch.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx#L78-L88)
- **Root Cause:** `const req = resolvedReq ?? (d ? { media: d, season, episode, absolute, audio } : null);` overrides a `null` return from `resolvePlaybackRequest()` with a synthetic fallback `PlaybackRequest` built from raw URL `s`/`e` params, causing `useSourceSession(req, 3)` to race every server for unaired shows, unreleased movies, or nonexistent `?s=99&e=99` URLs.
- **Fix Plan:** Add `checkEpisodeAvailability(detail, rawSeason, rawEpisode)` and only build `req` when `availability.playable` (or strictly offline with `detail.error && !detail.data`); otherwise render an explicit unavailable state with direct links to Title Details, Back, or Latest Aired Episode.
- **Resolution:** Added `checkEpisodeAvailability()` in [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts) and gated server session lookups + added an explicit unavailable screen in [src/pages/Watch.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx).

### `[x] Fixed` `BUG-05`: Episode lists, jump-to-episode, and in-player `EpisodeSheet` allow triggering unaired episodes
- **Severity:** Medium
- **Locations:** [src/pages/Title.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Title.tsx#L402-L448), [src/components/Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L4052-L4100)
- **Root Cause:** TMDB season payloads can contain placeholder rows for upcoming episodes with future `air_date` or numbers beyond `airedCount`. `Title.tsx` renders all rows in `epList` as clickable buttons and allows `ep-jump` beyond aired episodes, while `EpisodeSheet` in `Player.tsx` lists every returned row.
- **Fix Plan:** Add `isUnairedEpisode()`; render unaired rows in `Title.tsx` and `Player.tsx` `EpisodeSheet` as disabled non-clickable rows with upcoming air-date/status indicators; clamp/warn in `ep-jump` against `airedCount`; guard `validProgress` against unaired `upNext` entries.
- **Resolution:** Implemented across [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts), [src/pages/Title.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Title.tsx), [src/components/Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx), [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css), and [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css).

### `[x] Fixed` `BUG-06`: Card quick-play, Hero Play, and Command Palette `Ctrl+Enter` trigger playback on unreleased titles
- **Severity:** Medium
- **Locations:** [src/components/Card.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Card.tsx#L157-L167), [src/components/Hero.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Hero.tsx#L135), [src/components/CommandPalette.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/CommandPalette.tsx#L158)
- **Root Cause:** `Card`, `Hero`, and `CommandPalette` render Play / quick-play / `Ctrl+Enter` actions on every item regardless of `isUnreleasedMedia()` (even on the "Coming soon" shelf).
- **Fix Plan:** Suppress quick-play / Play / `Ctrl+Enter` play callbacks when `isUnreleasedMedia(media)` is true, leaving Info/Details and My List active.
- **Resolution:** Updated [src/components/Card.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Card.tsx) (`Coming soon` badge + hidden `.act.play`), [src/components/Hero.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Hero.tsx) (hidden Play button + primary `Details`), and [src/components/CommandPalette.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/CommandPalette.tsx) (omitted `play` shortcut).

### `[x] Fixed` `BUG-07`: Catalog feeds for "released / out now" shelves leak unreleased movies and unaired shows
- **Severity:** High
- **Locations:** [src/lib/tmdb.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/tmdb.ts#L117-L196), [src/lib/anilist.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/anilist.ts#L87-L133), [src/components/FitsTonight.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/FitsTonight.tsx#L61-L69), [src/lib/types.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/types.ts#L4-L34)
- **Root Cause:**
  1. `Media` drops `releaseDate` and `status`, making list-level date checks impossible.
  2. `tmdb.ts` `liveParams()` only adds `primary_release_date.lte` / `first_air_date.lte` for `new-movies` and `new-tv`, leaving genre `discover/movie`, `discover/tv`, `popular`, `trending`, `now_playing`, and `on_the_air` unfiltered for future dates, and `daysFromNow()` uses UTC `.toISOString().slice(0, 10)` instead of local calendar date.
  3. `anilist.ts` `ANIME_FEEDS` omits `status_not_in: [NOT_YET_RELEASED, CANCELLED]` and `startDate` in `FIELDS`, allowing announced/unaired titles into "Airing this season" / "Trending now" / "All-time popular".
  4. `FitsTonight.tsx` recommends unreleased titles fetched from `Home` pools.
- **Fix Plan:** Carry `releaseDate` and `status` on `Media`; add release-date ceilings on TMDB discover feeds and client-side feed filtering (`!isFutureIsoDate` for released shelves, `isFutureIsoDate` for `soon`); filter `NOT_YET_RELEASED` / `CANCELLED` on `ANIME_FEEDS`; filter unreleased items out of `FitsTonight`.
- **Resolution:** Fixed in [src/lib/types.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/types.ts), [src/lib/tmdb.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/tmdb.ts), [src/lib/anilist.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/anilist.ts), and [src/components/FitsTonight.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/FitsTonight.tsx).

### `[x] Fixed` `BUG-08`: Regional theatrical/festival vs. digital/streaming release availability
- **Severity:** Medium
- **Locations:** [src/lib/tmdb.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/tmdb.ts), [src/lib/normalizer.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/normalizer.ts), [src/pages/Title.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Title.tsx), [server/src/tmdb.js](file:///c:/Users/Ayomide/Documents/abixcine/server/src/tmdb.js)
- **Root Cause:** TMDB's top-level `release_date` reflects the earliest theatrical or film-festival premiere worldwide (which can precede digital/streaming availability by weeks or months). Accurate digital-availability gating requires evaluating TMDB `release_dates.results` release `type: 4` (Digital) / `type: 5` (Physical) per region and/or enriching catalog feed items beyond list endpoints.
- **Resolution:**
  1. Film detail now parses `release_dates` into `theatricalReleaseDate` (types 1–3) and `digitalReleaseDate` (types 4–6, earliest in any region) via `tmdbReleaseWindows()` (detail cache bumped to `tmdb:detail:v5:`).
  2. `isTheatricalOnly()` flags a released film whose digital date is still in the future, or (with no digital date at all) whose premiere is within `THEATRICAL_WINDOW_DAYS` (45). It is a *soft* gate: the Title page shows "In cinemas now · streaming from …", skips the automatic 20-server race, and offers **Check servers anyway** (local files, Jellyfin, early rips). The Details tab lists the cinema and digital dates. AniList records are never flagged.
  3. The **New releases** shelf now uses `discover/movie` with `with_release_type=4|5|6` and a 60-day `release_date` window (any region), so it lists films that are new *to watch at home*, not festival premieres. (Params were already allow-listed by the server proxy.) Popular/trending list endpoints carry no release types; those titles are handled by the Title-page gate.
  4. Tests: `theatrical vs digital release windows (BUG-08)` in [src/__tests__/matching.test.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/__tests__/matching.test.ts).

---

## 2. Player & Navigation Use Cases (`BUG-09` – `BUG-11`)

### `[x] Fixed` `BUG-09`: No reliable direct route from the Player or Server Race screen to the Title Info page
- **Severity:** High
- **Locations:** [src/components/Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L3452-L3484), [src/pages/Watch.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx#L206-L209), [src/pages/Home.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Home.tsx#L64-L78), [src/lib/playerControls.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/playerControls.ts#L53)
- **Root Cause:** `Watch.tsx`'s `back()` executes `nav(-1)` whenever `loc.state?.from === "app"`, which returns to `Home`, `Browse`, `Search`, or `MyList` instead of `/title/:key` whenever the user launched playback from Continue Watching, Card quick-play, Hero Play, or Command Palette `Ctrl+Enter`. Inside `Player.tsx`, `.ptitle` is non-clickable, there is no Info button in `.ptop-actions` or `.perr-acts`, there is no `I` shortcut, and `.race-page` has only a `Back` button.
- **Fix Plan:** Pass `onInfo` from `Watch.tsx` to `Player.tsx` navigating to `/title/${encodeKey(canonicalKey)}`, make `.ptitle` and `.race-page` title art clickable, add an Info button in `.ptop-actions`, `.perr-acts`, and `.race-nav`, bind `I` shortcut (including in `EMBED_KEYS`), and add an Info action button (`infoTo`) on `Home.tsx` Continue Watching cards.
- **Resolution:** Fixed across [src/pages/Watch.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx), [src/components/Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx), [src/lib/playerControls.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/playerControls.ts), [src/components/Card.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Card.tsx), [src/pages/Home.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Home.tsx), and [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css).

### `[x] Fixed` `BUG-10`: `Player.tsx` `EpisodeSheet` decodes full `original` backdrop URLs as episode stills
- **Severity:** Medium
- **Locations:** [src/pages/Watch.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx#L235)
- **Root Cause:** `Title.tsx:426` downsizes fallback backdrops to `w300`, whereas `Watch.tsx:235` passes `fallbackStill: d.backdrop` (`original` up to 4K), forcing WebView2 to decode up to 50 full-res backdrops inside the player drawer over active video playback.
- **Fix Plan:** Use `sized(d.backdrop, "w300")` for `fallbackStill`.
- **Resolution:** Updated [src/pages/Watch.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx) to pass `sized(d.backdrop, "w300")` for `fallbackStill`.

### `[x] Fixed` `BUG-11`: Minor UI flow defects (`Auth` error persistence on tab switch, `UpdateToast` raw external anchor)
- **Severity:** Low
- **Locations:** [src/pages/Auth.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Auth.tsx#L116-L117), [src/components/UpdateToast.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/UpdateToast.tsx#L37)
- **Root Cause:** Switching between "Sign up" and "Sign in" in `Auth.tsx` preserves stale validation/login errors from the other tab; `UpdateToast.tsx` uses `<a target="_blank">` instead of `openExternal(RELEASES_URL)`.
- **Fix Plan:** Clear `err` on tab toggle in `Auth.tsx`; route `UpdateToast` release link through `openExternal(RELEASES_URL)`.
- **Resolution:** Fixed in [src/pages/Auth.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Auth.tsx) and [src/components/UpdateToast.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/UpdateToast.tsx).

---

## 3. Smoothness & Performance (`PERF-01` – `PERF-07`)

### `[x] Fixed` `PERF-01`: Heavy continuous GPU re-blurring and runtime SVG filter rasterization
- **Severity:** High
- **Locations:** [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L41), [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L246-L359)
- **Root Cause:**
  1. `--frost-grain` embeds a runtime SVG `<feTurbulence>` filter on dozens of panes instead of a static raster noise texture.
  2. `.hero-copy::before` and `.tp-info::before` apply high-radius `backdrop-filter: blur(30px)` over animated 4K backdrops.
  3. `.top::before` applies `backdrop-filter: blur(22px)` on scroll across the full top strip.
- **Fix Plan:** Replace runtime SVG `<feTurbulence>` with a pre-baked pure-white tiled PNG matching the original frost noise alpha, and tune stage/top-bar blur radii while keeping the frosted glass design intact.
- **Resolution:** Generated pre-baked pure-white `180×180` tiled [src/assets/frost-grain.png](file:///c:/Users/Ayomide/Documents/abixcine/src/assets/frost-grain.png) (`R=G=B=255`, `avgA=11.06`, `maxA=22`) replacing runtime SVG `<feTurbulence>` in [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css); dialed `.top::before` to `blur(16px)` and `.hero-copy::before` / `.tp-info::before` to `blur(18px)` with their feathered masks preserved, and kept `--glass-thick` on `.palette` and `.auth-card`.

### `[x] Fixed` `PERF-02`: Hover-induced full-viewport blurred wallpaper swaps & heavy pseudo-element blur
- **Severity:** Medium
- **Locations:** [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L118-L127), [src/lib/light.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/light.ts#L282)
- **Root Cause:** `previewLight()` triggers `paintArt(artOf(m))` on every 160ms card hover, firing new image fetches and crossfading two `blur(46px)` full-screen pseudo-elements while sweeping across cards.
- **Fix Plan:** Keep smooth `--l1`/`--l2` accent color-pool transitions on `.light` with `contain: strict` and lower wallpaper blur (`36px` + `will-change: opacity`), while stopping `previewLight` from swapping full-screen room wallpaper on transient card hover.
- **Resolution:** Fixed in [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css) (`contain: strict`, `blur(36px)`, `will-change: opacity`, preserved `--l1`/`--l2` transition) and [src/lib/light.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/light.ts) (removed hover `paintArt` swaps).

### `[x] Fixed` `PERF-03`: Unthrottled/layout-thrashing event handlers & offscreen Ken Burns animations
- **Severity:** Medium
- **Locations:** [src/lib/pointerLight.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/pointerLight.ts#L38-L81), [src/App.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/App.tsx#L149-L158), [src/components/Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx#L2629-L2654), [src/components/Hero.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Hero.tsx#L94)
- **Root Cause:** `pointerLight.ts` runs `.closest()` and synchronous `getBoundingClientRect()` on every `pointermove` frame (even during video playback); `App.tsx` updates scroll memory & toggles `data-scrolled` on every scroll event without rAF/threshold check; `Player.tsx` tears down/re-arms `idleTimer` on every mouse pixel; `Hero` continues animating Ken Burns `drift` while scrolled offscreen or window hidden.
- **Fix Plan:** Cache bounding rects per hovered pane/card in `pointerLight.ts` (invalidated on scroll/resize) and bail early while `.app.is-watching` is active; rAF-coalesce `App.tsx` scroll state checks; throttle `Player.tsx` `poke()` timer resets while controls are already shown; pause `.hero-bg.on .art img.in` when `.hero.away` is set.
- **Resolution:** Fixed across [src/lib/pointerLight.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/pointerLight.ts), [src/App.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/App.tsx), [src/components/Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx), [src/components/Hero.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Hero.tsx), and [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css).

### `[x] Fixed` `PERF-04`: Global `optimizeLegibility`, missing layout containment, and shelf offscreen rendering overhead
- **Severity:** Medium
- **Locations:** [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L80), [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L72-L96)
- **Root Cause:** `text-rendering: optimizeLegibility` on `body` disables Chromium's fast text layout path across thousands of glyphs; offscreen shelves and cards lack `content-visibility: auto` / `contain: layout style`.
- **Fix Plan:** Remove `text-rendering: optimizeLegibility` from `body`; add `content-visibility: auto; contain-intrinsic-size: auto 340px;` to `.shelf` and `contain: layout style;` to `.card`.
- **Resolution:** Fixed in [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css) and [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css).

### `[x] Fixed` `PERF-05`: `Promise.all` waterfall on Home/Browse feeds, slow stale-while-revalidate wait, and Hero logo re-render cascade
- **Severity:** High
- **Locations:** [src/pages/Home.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Home.tsx#L26-L30), [src/pages/Browse.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Browse.tsx#L47-L74), [src/lib/cache.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/cache.ts#L18), [src/lib/useLogos.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/useLogos.ts#L14-L36)
- **Root Cause:** `Home` and `Browse` wait for `Promise.all(...)` across up to 9 TMDB feeds before rendering the Hero or any single row — so one cold/slow endpoint stalls the entire page. `cache.ts` waits `1500ms` before serving a stale cached entry. `useFeatured` calls `setExtra` individually for all 6 slides.
- **Fix Plan:** Add `useProgressiveFeeds` in `src/lib/useAsync.ts` so each shelf (and Hero) paints as soon as its own feed resolves while batching same-frame hits; lower `STALE_WAIT_MS` to `250ms`; batch `useFeatured` updates on a `100ms` timer + final flush.
- **Resolution:** Implemented in [src/lib/useAsync.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/useAsync.ts), [src/pages/Home.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Home.tsx), [src/pages/Browse.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Browse.tsx), [src/lib/cache.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/cache.ts), and [src/lib/useLogos.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/useLogos.ts).

### `[x] Fixed` `PERF-06`: Decompose monolithic `Player.tsx` (4,183 → 1,685 lines)
- **Severity:** Medium
- **Locations:** [src/components/Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx), [src/components/player/](file:///c:/Users/Ayomide/Documents/abixcine/src/components/player/)
- **Root Cause:** `Player.tsx` concentrates HLS/Shaka/HTML5 attachment, failover, subtitle parsing/timing/online search, Anime4K lifecycle, Trickplay thumbnails, AudioFX, shortcuts, and all drawer UIs in a single 4,141-line component, complicating maintenance and increasing closure/effect coupling.
- **Resolution:** Split into `src/components/player/`:
  - `useStreamEngine.ts` (attach for hls.js / Shaka / files / torrents / local FFmpeg audio, audio tracks, start/stall watchdog) and `useSubtitles.ts` (all track sources, dual selection + memory, offsets, cue engine, online search). Both were lifted **verbatim as whole blocks at their original call position**, so every hook runs in the same order with the same dependencies; their inputs/outputs were derived from the compiler (free / dangling identifiers) and typed from the TypeScript checker, not by hand.
  - `useEnhance.ts` (Anime4K lifecycle, compare line, vivid), `useChrome.ts` (`useIdleChrome`, `useFullscreen`, `usePip`), `useTrickplay.ts`, `useMediaSession.ts`, `shortcuts.ts` (`usePlayerShortcuts` + a pure, unit-tested `handlePlayerKey`), `sheets.tsx` (`ServerSheet`, `EpisodeSheet`, `UpNext`), `shared.ts` (constants, cue conversion, embed messages).
  - Verified with `tsc`, the full vitest suite, new [shortcuts.test.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/components/player/shortcuts.test.ts), and an in-app run (debug harness) that opens a watch page, attaches and plays an HLS stream, and toggles pause from the keyboard.
  - Further splitting (e.g. the render tree's drawer panels) is possible but no longer blocking.

### `[x] Fixed` `PERF-07`: Replace `abxs:` `Vec<u8>` custom-protocol buffering with zero-copy loopback `hyper` streaming gateway
- **Severity:** Medium
- **Locations:** [src-tauri/src/gateway.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/gateway.rs), [src-tauri/src/stream.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/stream.rs), [src/sources/native.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/native.ts), [src/components/player/useStreamEngine.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/components/player/useStreamEngine.ts)
- **Root Cause:** Tauri's `register_asynchronous_uri_scheme_protocol` buffers each HTTP response segment into a full `Vec<u8>` before returning it to WebView2, raising peak memory and latency on high-bitrate 4K streams or torrent seeks.
- **Resolution:**
  1. `gateway.rs`: a hyper HTTP/1.1 server on `127.0.0.1:<random port>`. Every path needs a random 128-bit per-launch token (only the `main` webview can read it, via `stream_gateway`), the `Host` must be the literal loopback address (no DNS rebinding), and any `Origin` must be the app's.
  2. `stream::handle_with(req, base, streaming)` is the one proxy behind both transports. In streaming mode media bodies come back as `Proxied::Stream` after an 8 KiB sniff, so bytes go upstream → WebView2 as they arrive; the player's own `Range` (including open-ended `bytes=N-`) goes upstream unchanged; a seek drops the connection and the upstream request with it. Playlists/MPDs, image-disguised TS segments and upstreams that ignore `Range` still take the buffered path. Rewritten playlists point at the gateway, so segments stay on it.
  3. Candidates keep their canonical `abxs:` URLs (keys, health memory, caches). Only the player's actual load goes through `playbackUrl()`; the frontend pings the gateway at startup and stays on `abxs:` if it isn't reachable. `unwrapProxyUrl` / token-expiry checks understand both forms.
  4. Tests: `streaming_mode_passes_media_through_and_rewrites_playlists_to_gateway_base` (3 MB ranged body, chunked upstream with no Content-Length, playlist rewrite) and gateway auth tests. In-app checks in WebView2: HLS master → variant → segment, a 206 range, a `<video>` element, and a token-less request refused; A/B playback of a live anime server matched `abxs:` (this caught and fixed a chunked-upstream `Content-Length: 0` bug).
  5. `librqbit` torrents already play from their own local HTTP server and are unchanged.

---

## 4. Windows Installer & External User Installation Blocks (`DIST-01` – `DIST-05`)

### `[ ]` `DIST-01` (**CI wired — awaiting signing credentials**): Unsigned Windows binaries & installer trigger Smart App Control hard blocks, SmartScreen, and AV false positives
- **Severity:** Critical
- **Locations:** [src-tauri/tauri.conf.json](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/tauri.conf.json#L65-L76), [.github/workflows/release.yml](file:///c:/Users/Ayomide/Documents/abixcine/.github/workflows/release.yml#L50-L69)
- **Root Cause:** `TAURI_SIGNING_PRIVATE_KEY` only generates a Minisign `.sig` for Tauri's in-app updater; `bundle.windows.signCommand` is unconfigured, so `AbixCine_*_x64-setup.exe`, `abixcine.exe`, and `uninstall.exe` carry **no Windows Authenticode digital signature**. When external users download the `.exe` from GitHub, Windows attaches Mark of the Web (`Zone.Identifier=3`), causing:
  1. **Windows 11 Smart App Control (SAC):** Clean Windows 11 installs (22H2–24H2) with SAC enabled **hard-block** unsigned executables downloaded from the internet with *"Smart App Control blocked an app that may be unsafe"* — there is **no "Run anyway" button** at all unless SAC is permanently disabled in Windows Security.
  2. **Windows Defender SmartScreen:** Blocks execution behind *"Windows protected your PC"* until the binary accumulates reputation or is signed.
  3. **Browser download blocks (Edge / Chrome):** Flags low-reputation unsigned `.exe` downloads as *"AbixCine_..._x64-setup.exe isn't commonly downloaded"*, sometimes failing silently or quarantining before the user notices.
  4. **Antivirus ML / Behavioral Quarantine:** Microsoft Defender (`Trojan:Win32/Wacatac.B!ml` / `PUA`) and third-party AVs routinely quarantine unsigned Rust/NSIS binaries, blocking the installer from launching or deleting `abixcine.exe` right after install.
- **Code side done — needs credentials:** [.github/workflows/release.yml](file:///c:/Users/Ayomide/Documents/abixcine/.github/workflows/release.yml) now signs every binary Tauri produces (`abixcine.exe`, NSIS setup + uninstaller, MSI) whenever credentials exist, through a `--config` overlay: **Azure Trusted Signing** (`trusted-signing-cli` as `bundle.windows.signCommand`; secrets `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID`, vars `TRUSTED_SIGNING_ENDPOINT` / `_ACCOUNT` / `_PROFILE`) or a **`.pfx` certificate** (secrets `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`, imported and used by thumbprint with SHA-256 + timestamping). The release is created as a draft, `Get-AuthenticodeSignature` must report `Valid` for every file, and only then is it published. Without credentials the build is unchanged (unsigned) and the run shows a warning.
- **Still open (external):** provision the signing account / certificate and add the secrets. Until then Smart App Control will keep blocking downloads.

### `[x] Fixed` `DIST-02`: NSIS installer hooks spawn `taskkill /F` unconditionally on every install (including fresh installs)
- **Severity:** High
- **Locations:** [src-tauri/windows/hooks.nsh](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/windows/hooks.nsh#L1-L23)
- **Root Cause:** `NSIS_HOOK_PREINSTALL` and `NSIS_HOOK_PREUNINSTALL` execute `nsExec::ExecToStack 'taskkill /F /IM abixcine.exe'` and `'taskkill /F /IM ffmpeg.exe /IM ffprobe.exe'` unconditionally — even on a clean external user's laptop where AbixCine has never been installed! Calling `taskkill.exe /F` from an unsigned NSIS installer is a classic behavioral heuristic trigger for Defender/AV quarantine and can also forcibly kill unrelated apps' `ffmpeg.exe` processes (OBS, video editors). Tauri's generated `installer.nsi` already uses Windows Restart Manager (`CheckIfAppIsRunning`) for `$INSTDIR\abixcine.exe`.
- **Fix Plan:** Replace `taskkill /F` in `hooks.nsh` with native Windows Restart Manager (`RestartManager_ShutdownFile`) guarded by `${If} ${FileExists} "$INSTDIR\resources\ffmpeg\..."` so fresh installs execute zero process-killing calls and updates/uninstalls only release locks on AbixCine's own bundled FFmpeg tools.
- **Resolution:** Fixed in [src-tauri/windows/hooks.nsh](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/windows/hooks.nsh) and syntax-verified with `makensis.exe`.

### `[x] Fixed` `DIST-03`: `abixcine.exe` embeds and invokes `taskkill /F /IM ffmpeg.exe /IM ffprobe.exe` on exit
- **Severity:** High
- **Locations:** [src-tauri/src/lib.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs#L1592-L1603), [src-tauri/Cargo.toml](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/Cargo.toml#L44-L46)
- **Root Cause:** `cleanup_before_exit()` spawns `taskkill /F /IM ffmpeg.exe /IM ffprobe.exe` with `CREATE_NO_WINDOW`. Embedding `"taskkill"` + `"/F"` in an unsigned GUI binary raises AV heuristic suspicion and kills unrelated system `ffmpeg` processes.
- **Fix Plan:** Track exact spawned child PIDs in `ACTIVE_MEDIA_PIDS` and terminate only AbixCine's active child processes on exit via Win32 `OpenProcess` / `TerminateProcess`.
- **Resolution:** Fixed in [src-tauri/Cargo.toml](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/Cargo.toml) (`Win32_System_Threading`) and [src-tauri/src/lib.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs) (`ACTIVE_MEDIA_PIDS`, `ActivePidGuard`, `run_background_output`, Win32 `OpenProcess`/`TerminateProcess` in `cleanup_before_exit`), covered by `local_media_tests::active_pid_guard_registers_and_cleans_up_on_drop`.

### `[x] Fixed` `DIST-04`: NSIS solid LZMA archive compression & incomplete external user install guidance
- **Severity:** Medium
- **Locations:** [src-tauri/tauri.conf.json](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/tauri.conf.json#L70-L76), [.github/workflows/release.yml](file:///c:/Users/Ayomide/Documents/abixcine/.github/workflows/release.yml#L60-L64), [README.md](file:///c:/Users/Ayomide/Documents/abixcine/README.md#L48)
- **Root Cause:** Tauri's default `/SOLID lzma` NSIS compression (60 MB solid blob wrapping `abixcine.exe` + FFmpeg DLLs + WebView2 bootstrapper) frequently increases AV ML false-positive scores compared to standard `zlib` compression; release notes also omit Edge/Chrome "Keep anyway" and Windows 11 Smart App Control explanations for external testers.
- **Fix Plan:** Switch `bundle.windows.nsis.compression` to `"zlib"` (verified in `@tauri-apps/cli` schema) and clarify browser download unblock, SmartScreen, and Windows 11 Smart App Control instructions in `release.yml` and `README.md`.
- **Resolution:** Configured `"compression": "zlib"` in [src-tauri/tauri.conf.json](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/tauri.conf.json) and updated [.github/workflows/release.yml](file:///c:/Users/Ayomide/Documents/abixcine/.github/workflows/release.yml) and [README.md](file:///c:/Users/Ayomide/Documents/abixcine/README.md).

### `[x] Fixed` `DIST-05`: Missing non-NSIS distribution alternatives (MSI / portable `.zip` / Winget) & native startup crash diagnostics
- **Severity:** Medium
- **Locations:** [src-tauri/tauri.conf.json](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/tauri.conf.json#L53-L70), [.github/workflows/release.yml](file:///c:/Users/Ayomide/Documents/abixcine/.github/workflows/release.yml), [src-tauri/src/lib.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/lib.rs)
- **Root Cause:**
  1. Only NSIS (`*-setup.exe`) is published; some enterprise/locked-down laptops block `.exe` installers from Downloads or offline networks (where `embedBootstrapper` for WebView2 also needs internet to download ~160 MB runtime if WebView2 is absent on Windows 10). Publishing an `.msi` (WiX), portable `.zip`, or offline WebView2 bundle gives external users fallback paths.
  2. When WebView2 or GPU initialization fails silently on an external laptop, `abixcine.exe` exits without writing a user-readable crash/startup log (`%LOCALAPPDATA%\app.abixcine.desktop\startup.log`) or automatically retrying with WebView2 software rendering if GPU composition crashes.
- **Resolution:**
  1. CI builds `--bundles nsis,msi` and attaches `AbixCine_<v>_x64-portable.zip` (`abixcine.exe` + `resources/ffmpeg`, the installed layout). `updaterJsonPreferNsis: true` keeps the updater on the per-user NSIS build. Release notes and README explain each option.
  2. [src-tauri/src/diagnostics.rs](file:///c:/Users/Ayomide/Documents/abixcine/src-tauri/src/diagnostics.rs): `%LOCALAPPDATA%\app.abixcine.desktop\startup.log` (version, OS, WebView2 version, setup, ready, panics with backtraces, renderer errors via `log_frontend_error`; rotated at 256 KiB). Missing WebView2 or a failed window build shows a native message box (and opens the WebView2 download) instead of exiting silently.
  3. Safe graphics mode: a launch that never reaches the first render (the frontend calls `app_ready`) makes the next one start with `--disable-gpu --disable-gpu-compositing`, applied to the main window *and* sniff windows (WebView2 needs identical args per data folder). It persists until the in-app toast's **Use GPU again**; `--safe-mode` / `ABIXCINE_SAFE_MODE` force it for one launch. Debug builds only honour the flag.
  4. Not done: Winget manifest (needs a signed, stable release URL first) and an offline WebView2 installer bundle (+~160 MB; the portable zip and MSI cover the blocked-installer cases).

---

## 5. Server System & Local Library Priority (`SRV-01` – `SRV-05`)

### `[x] Fixed` `SRV-01`: Local library files no longer beat fast online 1080p streams or promote after slow disk scans
- **Severity:** High
- **Locations:** [src/sources/local.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/local.ts#L192-L250), [src/sources/registry.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/registry.ts#L667-L712), [src/sources/session.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/session.ts), [src/sources/health.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/health.ts)
- **Root Cause:**
  1. `localProvider` had `priority: 30` (barely above extractors `26`), `registry.ts` defaulted unknown resolution on untagged local files (e.g., `Film.mkv`) to `720p` (losing `10` quality points to `1080p` online streams), and `score()` had no strong local-first bonus, so an online `1080p` stream with prior history (`memory: +8`, `rel: +8`) outscored a local file.
  2. `SourceSession.evaluate()` only waited `GRACE_MS` (`350ms`) instead of waiting briefly (`LOCAL_GRACE_MS`) for a local disk scan / FFprobe subtitle check, so a `50ms` online stream locked `pickKey` first; and once `want = 1` locked `pickKey`, `pump()` refused to probe late-arriving `local` candidates or promote them.
  3. Playing a local file (`want = 3`) unnecessarily scheduled background embed captures, and transient local errors could trip the health circuit breaker.
- **Resolution:** Raised `localProvider.priority` to `60`, added `localBonus` (`+50`) + `preferred` default resolution + `"on this PC"` badge in [src/sources/registry.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/registry.ts), exempted `"local"` from circuit breaking in [src/sources/health.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/health.ts), added `LOCAL_GRACE_MS` (`2500ms`), late local `pump()`/`launch()` auto-promotion over unplayed online auto-picks, and embed-backup suppression when a local file is picked in [src/sources/session.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/session.ts).

### `[x] Fixed` `SRV-02`: Personal Jellyfin server priority too close to public extractors
- **Severity:** Medium
- **Locations:** [src/sources/jellyfin.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/jellyfin.ts#L106-L165), [src/sources/registry.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/registry.ts#L697-L702)
- **Root Cause:** `jellyfinProvider.priority` was `20` — lower than almost every direct public extractor (`21..26`) and missing `via: "direct"`.
- **Resolution:** Raised `jellyfinProvider.priority` to `32` (`below local 60`, `above online extractors 21..26`) and stamped `via: "direct"` and `"your server"` badge.

### `[x] Fixed` `SRV-03`: Uncached local subtitle FFprobe stalls & strict anime dub exclusion of untagged local MKVs
- **Severity:** Medium
- **Locations:** [src/sources/local.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/local.ts#L29-L250)
- **Root Cause:** Every episode lookup invoked synchronous FFprobe subtitle scanning with no timeout or cache, and requesting `dub` filtered out dual/English-track MKVs whose filenames simply lacked `[Dub]` tags, while `invalidateSessions()` left the 5-minute directory scan cache stale on "Look again".
- **Resolution:** Added bounded `SUB_PROBE_CACHE` (500 entries, keyed by `path|size`) with a `1500ms` timeout, exported `clearLocalScanCache()` invoked by `invalidateSessions()`, and added untagged fallback matching for `dub` requests without admitting explicitly `[Sub]`-tagged files.

### `[x] Fixed` `SRV-04`: Inapplicable direct extractors, circuit-open providers, and redundant file confirm checks waste lookup/probe budget
- **Severity:** Medium
- **Locations:** [src/sources/session.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/session.ts), [src/components/SourceBoard.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SourceBoard.tsx#L63-L70)
- **Root Cause:** `SourceSession` queried all enabled direct providers (e.g., anime extractors on movies) and already circuit-open providers on every session start; and `needsConfirm()` re-ran `playCheck()` on `kind === "file"` right after `probeCandidate()` -> `quickCheck()` had already completed `playCheck()`.
- **Resolution:** Filtered clearly inapplicable direct providers up front via `isProviderApplicable()`, skipped circuit-open external providers automatically (retrying them on `checkAll()`, labelled `"Resting after recent errors"` in [src/components/SourceBoard.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/SourceBoard.tsx)), and skipped redundant second `playCheck()` on `kind === "file"`.

### `[x] Fixed` `SRV-05`: Duplicate CDN mirrors inflate backup count & token-expired backups picked on failover
- **Severity:** Medium
- **Locations:** [src/sources/session.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/sources/session.ts#L159-L161)
- **Root Cause:** `readyCount()` counted raw candidates even when multiple embeds resolved to the exact same CDN URL, causing the scheduler to stop before finding a genuinely distinct backup; and `isUsable()` did not check `isUrlTokenExpired()`.
- **Resolution:** Updated `readyCount()` to deduplicate via `streamOf(c)` and added `!isUrlTokenExpired(c.url)` (for non-local candidates) to `isUsable()` so `failover()` skips stale backups.

---

## 6. Verification Summary

Second cycle (BUG-08, PERF-06, PERF-07, DIST-01 wiring, DIST-05):

- `tsc --noEmit` -> exit 0; `vitest run` -> 30 files, 377 tests passed; `npm run build` -> exit 0
- `cargo test` -> 62 passed, 1 ignored (release-only safe-mode test); `cargo check --features torrent` -> exit 0; `cargo clippy` -> no new findings
- `npm --prefix server test` -> 14 passed
- In-app (debug build + `ABX_JS_TEST`, WebView2 157): gateway HLS/range/`<video>`/token checks, startup.log + `app_ready`, and A/B playback of a live anime server through the gateway vs `abxs:`

First cycle:

- `.\node_modules\.bin\tsc.cmd --noEmit` -> exit 0
- `.\node_modules\.bin\vitest.cmd run` -> exit 0 (29 test files passed, 367 tests passed)
- `npm run build` -> exit 0 (`tsc --noEmit && vite build`, 184 modules transformed)
- `cargo test --manifest-path src-tauri/Cargo.toml` -> exit 0 (56 passed, 0 failed)
- `cargo check --manifest-path src-tauri/Cargo.toml --features torrent` -> exit 0
- `npm --prefix server test` -> exit 0 (14 passed, 0 failed)
- `makensis.exe` on `hooks.nsh` (preinstall + preuninstall sections) -> exit 0
