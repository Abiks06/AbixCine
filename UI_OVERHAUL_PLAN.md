# AbixCine UI Overhaul Plan — "Celluloid Archive v3" (Implemented)

**Date:** `2026-11-20`
**Baseline:** `abixcine@1.10.1` · **Celluloid Archive v2** → **Celluloid Archive v3 — Themes, 35mm Reel & Next-Watch Curator**
**Status:** `v3 Implemented (Smart Aspect Image Framing, Anamorphic Aperture Logo, 6-Theme Cinema Grading, Animated 35mm Simulcast Reel, Next-Watch Curator Engine)`
**Companion Audit:** [UI_NEXTGEN_AUDIT.md](UI_NEXTGEN_AUDIT.md)

---

## 1. Honest Diagnosis: Why AbixCine Currently Feels Like `iframe.tv`

AbixCine already has strong underlying engineering ([src/lib/light.ts](src/lib/light.ts) OKLCH color sampling, [src/lib/taste.ts](src/lib/taste.ts) decay-weighted mixing, [src/components/FitsTonight.tsx](src/components/FitsTonight.tsx), local-first [src/components/Drive.tsx](src/components/Drive.tsx), live server racing in [src/components/SmartSource.tsx](src/components/SmartSource.tsx), WebGPU Anime4K, and a high-contrast typography stack). Visually, however, the UI converges with `iframe.tv` and modern streaming clones because of **six shared template clichés**:

1. **Floating frosted pill navbar** ([src/components/TitleBar.tsx](src/components/TitleBar.tsx)): Centered translucent capsule dock plus a right-hand glass search/avatar pill floating over a hero backdrop — the default 2025–2026 streaming-site silhouette.
2. **Frosted glass materiality everywhere** ([src/styles/frost.css](src/styles/frost.css)): `backdrop-filter: blur(30px)` smoked glass, specular white pointer rims, rounded `22px`/`999px` capsules, and blurry colored wallpaper behind everything (`.light`).
3. **The 90vh full-bleed Hero Carousel + right-hand frosted "Up next" card** ([src/components/Hero.tsx](src/components/Hero.tsx)): Dark scrim on left, bottom-left title/synopsis/pill CTAs, bottom ticks, frosted vertical queue on right.
4. **Conveyor belt of identical horizontal carousels** ([src/pages/Home.tsx](src/pages/Home.tsx), [src/components/Row.tsx](src/components/Row.tsx)): 10+ consecutive `<Row>` shelves using the same `16:9` rounded cards, bottom shadow fade, uppercase title stamped over artwork, 3D hover tilt, and Netflix-style giant hollow Top 10 numerals.
5. **Carbon-copy Browse routes** ([src/pages/Browse.tsx](src/pages/Browse.tsx)): Home, Films, Series, and Anime all stamp out `<Hero />` + `<Row />` stacks.
6. **Passive information delivery**: AbixCine's most distinctive features (*Fits Tonight*, *Your Drive*, *Taste Mix*, *Live Server Readiness*) are flattened into generic rows, and inspecting any title forces a full page bounce to `/title/:key`.

---

## 2. Design Thesis: **"Archival Projection"**

*Private Repertory Cinematheque × Tactile Projection Desk*

Instead of looking like a frosted-glass web portal, AbixCine should feel like **a bespoke piece of cultural desktop hardware** — drawing inspiration from **Criterion / MUBI editorial cinema broadsheets** and **Braun / Leica / 35mm projection instruments**:

* **Retire frosted glass (`frost.css`) & pill soup.** Move to **matte archival obsidian & graphite surfaces** (`#08080A` ground, `#0E0E12` surface, `#15151B` raised, `#F2EFE9` warm archival alabaster ink) structured by crisp `1px` architectural hairlines and razor-sharp **`2px–4px` cinema-gate corners** instead of bubbly `16–30px` / `999px` pills.
* **Reinvent [src/lib/light.ts](src/lib/light.ts) from "blurry wallpaper" to "calibrated optical light."** Keep the OKLCH artwork sampler, but stop smearing blurred artwork across the entire page behind smoked glass. Use `--tone` / `--tone-ink` as **precision projection accents**: optical corner brackets (`⌜ ⌝ ⌞ ⌟`), illuminated index numbers, `2px` progress filaments, subtle edge slits, and active dossier rails.
* **Unleash the bundled typography.** Pair monumental tight-tracked `Bricolage Grotesque` display type directly with oversized italic `Instrument Serif` (*"TONIGHT'S / **Screening**"*), supported by `Geist` body copy and grounded by tabular `JetBrains Mono` DCP-style telemetry (`2025 · 2H 14M · 4K LOCAL · ★ 8.4`).
* **Separate art from metadata.** Never bury cinematography under heavy bottom gradients and giant overlaid text on every card. Show crisp, unobstructed frames with clean editorial captions beneath.

---

## 3. Shell & Navigation Overhaul (Breaking the Web-Portal Silhouette)

Replace the centered floating pill dock in [src/components/TitleBar.tsx](src/components/TitleBar.tsx) and [src/App.tsx](src/App.tsx) with a **Desktop Projection Shell**:

```text
+----+----------------------------------------------------------------------+
| A  | PROGRAMME · FRI 21:20 · 12 SERVERS · 1 LOCAL    [/ Search… Ctrl+K] –□×| <- 38px hairline utility & drag bar
+----+----------------------------------------------------------------------+
| 01 |                                                                      |
| 02 |   LEFT: Matte Editorial Plinth      |   RIGHT: Pure Un-Scrimmed      |
| 03 |   № 01/06 · TONIGHT'S PICK          |   Cinema-Scope Key Art         |
| 04 |   [TITLE ART / SERIF + DISPLAY]     |   ⌜                       ⌝    |
| 05 |   2025 | 2H 08M | ★ 8.4 | SCI-FI    |                                |
| 06 |   Synopsis…                         |                                |
|    |   [▶ PLAY NOW] [DOSSIER] [+ LIST]   |   ⌞                       ⌟    |
|    |   01 ━━━  02  03  04  05  06        |                                |
| -- +-------------------------------------+--------------------------------+
| ●  |   ACTIVE REEL (Continue Watching Hero + Compact Queue)               |
| ⚙  +----------------------------------------------------------------------+
| ◉  |   EVENING TIMETABLE · FITS TONIGHT (Proportional Runtime Timeline)   |
+----+----------------------------------------------------------------------+
```

* **Slim Left Architectural Index Rail (`60px` wide, `1px` right hairline):**
  * Top: AbixCine aperture mark.
  * Middle: Numbered / iconographic vertical section switches (`01 Programme`, `02 Films`, `03 Series`, `04 Anime`, `05 Vault`, `06 List`) with a crisp vertical hairline active indicator — zero floating glass pill blocking the hero art.
  * Bottom: Live Server LED + count indicator, Settings gear, Account avatar.
* **Ultra-Thin `38px` Top Utility & Drag Strip (`data-tauri-drag-region`):**
  * Left: Live context breadcrumb + evening clock + active server/local telemetry.
  * Right: Inline command bar trigger (`/ Search or jump… Ctrl K`) + Tauri native `WindowButtons`.
* **TV / Gamepad Mode** ([src/lib/tvMode.ts](src/lib/tvMode.ts)): High-contrast mechanical focus frame (`2px solid var(--tone-ink)`) and clean rail-to-canvas focus traversal.

---

## 4. Home Page Overhaul: *"The Living Programme"* (Zero Conveyor-Belt Carousels)

Instead of `<Hero />` followed by 10 identical horizontal `<Row>` shelves in [src/pages/Home.tsx](src/pages/Home.tsx), compose Home as **six distinct architectural movements**, each using the layout format that fits its content:

### Movement 1 — The Asymmetric Split Stage ([src/components/Hero.tsx](src/components/Hero.tsx))
* **Left (~38%, matte `#09090B` plinth bounded by a `1px` vertical rule):** Issue kicker (`PROGRAMME № 01/06`), crisp [TitleArt](src/components/TitleArt.tsx), hairline-ruled spec ledger (`YEAR · RUNTIME · SCORE · GENRE`), editorial synopsis, solid rectangular `[ ▶ PLAY ]` + `[ DOSSIER ]` + `[ + LIST ]` + `[ TRAILER ]` controls, and a compact horizontal **Filmstrip Programme Switcher** (`01`–`06` with a `2px` progress filament).
* **Right (~62%, pure widescreen viewport):** Unblurred, un-scrimmed key art with subtle 35mm optical corner ticks (`⌜ ⌝ ⌞ ⌟`) and gentle Ken Burns drift. Zero text or frosted widgets dumped over the frame.

### Movement 2 — Currently on the Reel *(New `src/components/ActiveReel.tsx`, replacing Continue Watching row)*
* Differentiates *"what you're actively watching"* from catalog browsing.
* **Lead Active Card (~45% width):** Wide still frame, exact monospace timecode (`48:12 / 1:54:00 · 66M LEFT`), episode code (`S02 · E07 · SUB`), perforated/segmented timecode progress bar, and instant `[ ▶ RESUME ]` / `[ DOSSIER ]` actions.
* **Secondary Queue Strip (~55% width):** Compact horizontal index tiles for the remaining in-progress items with one-click dismiss + undo toast.

### Movement 3 — Evening Timetable: *Fits Tonight* ([src/components/FitsTonight.tsx](src/components/FitsTonight.tsx))
* Elevate AbixCine's signature clock-aware feature into an **interactive screening schedule** instead of a plain row:
  * Top ruler displays the real evening clock axis (`NOW 21:20 ──────▶ 23:00 ────▶ 00:00`) alongside crisp cutoff switches (`BEFORE 23:00`, `BEFORE MIDNIGHT`, `ALL NIGHT`).
  * Each fitting film/episode renders as a **proportional horizontal timetable ticket** whose bar width visually represents its duration against your bedtime, stamped with `ENDS 23:02` in tabular mono plus quick Play / Quick Inspect buttons.

### Movement 4 — Interactive Split Chart Ledger *(New `src/components/ChartLedger.tsx`, retiring giant hollow Top 10 numerals)*
* Replaces Netflix-clone outlined numbers (`.rank-n`) and collapses three repetitive Top 10 / Trending rows into one interactive centerpiece:
  * Header includes an instant hairline tab switcher: **`FILMS` / `SERIES` / `ANIME`**.
  * **Left (~58%):** Scannable 10-row typographic chart ledger (`01`–`10`, movement delta `▲ 2` / `▼ 1` / `NEW`, title, year, genre, `★` score, quick play).
  * **Right (~42%):** **Synchronized Live Preview Plinth** — hovering or arrowing through rows `01 → 10` crossfades the right-hand artwork, synopsis, runtime, and ambient `--tone` accent in real time via `previewLight`.

### Movement 5 — Alternating Editorial Spreads & 35mm Contact Sheets *(New `src/components/EditorialSpread.tsx` + refactored [src/components/Card.tsx](src/components/Card.tsx))*
* **Asymmetric 1+4 Editorial Spread** (used for *"New Releases"*, *"Because You Watched"*): 1 monumental lead card (large frame + italic serif pullout/synopsis + Play) paired with a 2×2 grid of clean framed titles.
* **35mm Contact Sheet Strip** (used for *"Anime This Season"*, *"Coming Soon"*, *"Critically Acclaimed"*): Crisp **2:3 archival vertical posters** (`2px` radius, zero text stamped over art), subtle frame index (`F01 · SUB/DUB`), and clean structured caption blocks beneath.
* **Hover Interaction ("Projection Gate Focus"):** Retire mushy 3D mouse-tilt cards (`rotateX`/`rotateY` + glossy white sheen in [src/lib/pointerLight.ts](src/lib/pointerLight.ts)). On hover/focus, precision **optical corner brackets (`⌜ ⌝ ⌞ ⌟`)** snap around the artwork in `--tone`, the image zooms cleanly (`1.035×`) inside a crisp mat, and the caption rule lights up.

### Movement 6 — Your Vault ([src/components/Drive.tsx](src/components/Drive.tsx)) & Visible Taste Calibration
* **Physical Media Vault:** Framed as a hardware-grade local media bay with live drive telemetry (`LOCAL FIRST · ZERO LATENCY · N FILES`) and master-tape / archival spine cards showing resolution, HDR, audio, and file size (`4K · HDR10 · DUAL · 18.4 GB`).
* **Taste Mix Strip** (surfacing [src/lib/taste.ts](src/lib/taste.ts)): A razor-thin proportional hairline readout showing your active mix (`48% FILM · 32% SERIES · 20% ANIME`) with an optional one-click Home programme pivot (`ALL / FILM / SERIES / ANIME`).

---

## 5. Rethinking How Information Is Delivered

### Zero Page-Bounce Quick Dossier Drawer *(New `src/components/QuickDossier.tsx`)*
* Triggered via a subtle corner `Inspect` action, right-click, or pressing `I` on any focused card — slides a `440px` solid matte architectural drawer over the right edge without leaving Home/Browse.
* Leverages `Card.tsx`'s existing hover-prefetch cache (`getDetail()` in [src/lib/catalog.ts](src/lib/catalog.ts)) so it opens immediately with: un-scrimmed backdrop still, `TitleArt`, full synopsis, Director/Studio, runtime + **"Ends at HH:MM"** clock calculation, `Sub/Dub` switch, Trailer modal button, **live `SmartSource` stream readiness**, `[ ▶ PLAY NOW ]`, and `[ FULL DOSSIER → ]`.

### Differentiated Route Archetypes
* **Films (`/movies`)** ([src/pages/Browse.tsx](src/pages/Browse.tsx)): *The Screening Catalog* — editorial lead feature + interactive hairline **Filter Bar** (Genre / Era / Sort) + crisp 2:3 Poster Archive Grid mixed with curated spreads.
* **Series (`/series`)**: *The Television Index* — highlights season counts, Returning/Ended status, and episodic widescreen stills.
* **Anime (`/anime`)**: *The Simulcast Board* — seasonal marquee (`FALL 2026 SIMULCAST`), airing cadence, studio credits, Sub/Dub visual badges, and 2:3 key-visual wall.
* **Title Page (`/title/:key`)** ([src/pages/Title.tsx](src/pages/Title.tsx)): *The Film Monograph* — asymmetric split masthead; [src/components/SmartSource.tsx](src/components/SmartSource.tsx) redesigned as a crisp **Signal Patchbay Rack** (latency bars, `LOCAL / DIRECT / 4K` telemetry, zero foggy blur); episodes as a **Broadcast Cue Sheet**; cast upgraded from circles to **`3:4` sharp-cornered editorial portraits**; Details styled as a **Criterion-style technical colophon**.
* **Command Palette (`Ctrl+K`)** ([src/components/CommandPalette.tsx](src/components/CommandPalette.tsx)): Matte high-speed projection indexer with a `1px` `--pal-tone` hairline border and instant right-hand dossier preview.
* **Auth** ([src/pages/Auth.tsx](src/pages/Auth.tsx)): Replaces the scrolling poster wall + frosted box with a **Split Editorial Theater Lobby** (monumental curated still + italic serif manifesto left; crisp matte check-in console right).
* **Watch Race & Player HUD** ([src/pages/Watch.tsx](src/pages/Watch.tsx), [src/styles/player.css](src/styles/player.css)): Retains every performance win (WebGPU Anime4K split-wipe, Ambilight, JASSUB subtitles, custom sliders) while aligning geometry from bubbly pills to razor-clean cinema letterbox telemetry controls.

---

## 6. Phased Implementation Plan & Codebase Map

| Phase | Goal | Key Files Touched / Created |
| :--- | :--- | :--- |
| **Phase 1: Tokens & Material Reset** | Retire frosted glass & pill tokens; install matte archival palette, hairline grid tokens, `2px–4px` cinema-gate geometry, and optical `--tone` light rules while preserving all a11y/reduced-motion/high-contrast contracts. | [src/styles/base.css](src/styles/base.css), [src/styles/frost.css](src/styles/frost.css) → `src/styles/surfaces.css`, [src/lib/light.ts](src/lib/light.ts), [src/lib/pointerLight.ts](src/lib/pointerLight.ts), [src/main.tsx](src/main.tsx) |
| **Phase 2: Architectural Shell** | Replace floating pill `TitleBar` with slim Left Index Rail + `38px` top utility/drag bar; update `CommandPalette` to matte indexer style; verify Tauri drag regions & `tvMode`. | [src/App.tsx](src/App.tsx), [src/components/TitleBar.tsx](src/components/TitleBar.tsx), [src/components/CommandPalette.tsx](src/components/CommandPalette.tsx), [src/lib/tvMode.ts](src/lib/tvMode.ts) |
| **Phase 3: Home ("Living Programme") & Quick Dossier** | Build Split-Frame `Hero`, `ActiveReel`, Timetable `FitsTonight`, Interactive `ChartLedger`, `EditorialSpread`, Contact-Sheet `Card` (corner-bracket focus), Hardware-Bay `Drive`, Taste Mix strip, and slide-over `QuickDossier` drawer. | [src/pages/Home.tsx](src/pages/Home.tsx), [src/components/Hero.tsx](src/components/Hero.tsx), [src/components/FitsTonight.tsx](src/components/FitsTonight.tsx), [src/components/Card.tsx](src/components/Card.tsx), [src/components/Row.tsx](src/components/Row.tsx), [src/components/Drive.tsx](src/components/Drive.tsx), [src/styles/browse.css](src/styles/browse.css) + new `ActiveReel.tsx`, `ChartLedger.tsx`, `EditorialSpread.tsx`, `QuickDossier.tsx` |
| **Phase 4: Differentiated Pages** | Give Films, Series, and Anime distinct archive layouts + filtering; upgrade Title page to Monograph + Patchbay `SmartSource` + Cue Sheet episodes + 3:4 cast portraits; align Search, My List, and Library. | [src/pages/Browse.tsx](src/pages/Browse.tsx), [src/pages/Title.tsx](src/pages/Title.tsx), [src/components/SmartSource.tsx](src/components/SmartSource.tsx), [src/components/SourceBoard.tsx](src/components/SourceBoard.tsx), [src/pages/Search.tsx](src/pages/Search.tsx), [src/pages/MyList.tsx](src/pages/MyList.tsx), [src/pages/Library.tsx](src/pages/Library.tsx) |
| **Phase 5: Auth, Settings & Player Cohesion** | Editorial Theater Lobby for Auth; hairline hardware control desk for Settings; align Signal Race console & Player HUD geometry with Archival Projection without touching playback engine performance. | [src/pages/Auth.tsx](src/pages/Auth.tsx), [src/pages/Settings.tsx](src/pages/Settings.tsx), [src/pages/Watch.tsx](src/pages/Watch.tsx), [src/styles/player.css](src/styles/player.css) |
| **Phase 6: Verification & Polish** | `npm run build`, `npm test`, live dev-preview audit across `960×600` → 4K viewports, gamepad/`tvMode` traversal, `reduce-motion` & `prefers-contrast: more` checks, and View Transition morph checks (`tagForMorph` + `hero-title`). | Full verification across all routes |

---

## 7. Non-Negotiable Invariants Preserved

* Zero `backdrop-filter` on scrolling or repeating elements (retiring Frost makes GPU frame pacing faster).
* All accessibility contracts (`:root.reduce-motion`, `prefers-reduced-motion`, `prefers-reduced-transparency`, `prefers-contrast: more`, `gamepad-active`, keyboard focus order) remain first-class.
* All learned codebase invariants remain intact:
  * Memoized `useSlidingIndicator` ref callbacks ([src/lib/useSlidingIndicator.ts](src/lib/useSlidingIndicator.ts))
  * `tagForMorph` 700ms cleanup ([src/components/Card.tsx](src/components/Card.tsx)) & click-only `hero-title` tagging ([src/components/Hero.tsx](src/components/Hero.tsx))
  * Non-animated Anime4K `compareAt` split line
  * `Home` cold-launch grace (`CATALOG_GRACE_MS`) & stable taste-weighted mix

---

## 8. Celluloid Archive v2 — Modern Luxury & Artistry Refinement

1. **HiDPI Optical Image Pipeline (`src/components/Art.tsx`, `src/styles/base.css`):** Upgraded TMDB image tiering (`w342`/`w500`/`w780` posters, `w780`/`w1280` backdrops) with responsive `srcSet` + `sizes`, portrait `50% 15%` focal framing, subtle brightness/contrast calibration, and studio catch-light rim tokens (`--plate`, `--rim`, `--frame-rim`, `--card-shadow`, `--card-hover-shadow`).
2. **Darkroom Hover Detail Curtain (`src/components/Card.tsx`, `src/styles/browse.css`):** Hovering or focusing any card smoothly lifts the sculpted frame (`-4px`), glides a bottom darkroom veil revealing genre/year micro-metadata and a 2–3 line synopsis teaser, and docks quick actions horizontally without nesting buttons inside links.
3. **Hero & Top-10 Ledger Artistry (`src/components/Hero.tsx`, `src/components/ChartLedger.tsx`, `src/styles/browse.css`):** Added a chromatic projection seam bleeding `--tone` across the split hero boundary, `24×16` micro-thumbnails in filmstrip tabs, `28×40` poster swatches inside Top-10 ledger rows, and a translucent italic serif rank watermark in the spotlight preview card.
4. **Interactive Film Monograph Info Page (`src/pages/Title.tsx`, `src/styles/browse.css`):** Re-architected `/title/:key` into a 3-zone gallery masthead (framed `2:3` physical poster column + telemetry bar with SVG score gauge, live finish-time stamp, and `SmartSource` deck), an always-visible **Monograph Editorial Spread** (full synopsis, director/writer/DP/composer slate, Box Office ROI bar chart, and release/studio timeline), and a `"showcase"` Cast & Related default view for films (keeping Cue Sheet episodes default for series and anime).


---

## 9. Celluloid Archive v3 — Image Pipeline Fix, Aperture Brand, 6 Themes, 35mm Reel & Home Curator

1. **Image Rendering & Aspect Framing Fix ([src/components/Art.tsx](src/components/Art.tsx), [src/styles/browse.css](src/styles/browse.css), [src/styles/base.css](src/styles/base.css)):** Removed `content-visibility: auto` on `.shelf`, replaced invalid `border: 1px solid var(--frame-rim)` rules with `--frame-edge` and separate `background-color` + `background-image: var(--plate)` layers, dropped `3840w` `original` TMDB `srcSet` candidates, added automatic portrait-in-wide and ultrawide (`1900×400` AniList banner) ambient stage framing, and added poster fallback on failed backdrops.
2. **Anamorphic Aperture A Brand & Favicon ([src/components/Logo.tsx](src/components/Logo.tsx), [index.html](index.html)):** Multi-part metallic geometric "A" blades with optical play-prism & lens-flare crossbar (`useId()`-scoped gradients) plus `ABIX · Cine` editorial wordmark and matching SVG app icon.
3. **6-Theme Cinema Grading System ([src/lib/themes.ts](src/lib/themes.ts), [src/lib/light.ts](src/lib/light.ts), [src/components/TitleBar.tsx](src/components/TitleBar.tsx), [src/pages/Settings.tsx](src/pages/Settings.tsx)):** Added *Celluloid Gold* (new default), *Grand Premiere*, *Midnight Tokyo*, *Criterion Jade*, *A24 Dusk*, and *Daylight Print* (light mode with dark-lightbox Hero/Title plinths), plus topbar Theme Studio popover and Settings Appearance panel with a `dynamicLight` lock toggle.
4. **Animated 35mm Film Reel & Flywheel Gesture Transport ([src/components/FilmReel.tsx](src/components/FilmReel.tsx), [src/lib/reelPhysics.ts](src/lib/reelPhysics.ts), [src/lib/anilist.ts](src/lib/anilist.ts), [src/pages/Browse.tsx](src/pages/Browse.tsx)):** Expanded weekly simulcast query to merge seasonal airing + `RELEASING` titles (`perPage: 36`) with next-episode countdown chips, driven by a 60/120fps `requestAnimationFrame` flywheel physics engine with weighted hover/pause deceleration, 1:1 synchronized moving sprocket perforations, a live rotating spool gear indicator, inertial step glides, and full gesture scrubbing (two-finger trackpad swipe, Shift+wheel, touch swipe, and mouse click-and-drag with momentum coasting) plus reduced-motion snap-strip fallback across Home, Anime, Films, and Series.
5. **Next-Watch Curator Engine ([src/lib/recommend.ts](src/lib/recommend.ts), [src/components/NextWatchDeck.tsx](src/components/NextWatchDeck.tsx), [src/pages/Home.tsx](src/pages/Home.tsx), [src/lib/progress.ts](src/lib/progress.ts)):** Preserved genre tags in watch progress, extracted recency-weighted genre + lane taste profiles + multi-seed related recommendations + unwatched My List surfacing into an explainable 1+4 spotlight deck (`For you` / `My List` / `Like {Title}` / `Acclaimed` / `Surprise` + Shuffle & Skip), while feeding personalized picks directly into `FitsTonight`.
