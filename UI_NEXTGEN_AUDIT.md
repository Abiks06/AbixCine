# AbixCine Next-Gen UI, Motion, Color & Effects Audit

**Date:** `2026-11-19`
**Audit Baseline:** `abixcine@1.9.0` (`b8c53b8`) · **Projection + Frost v3** design system
**Scope:** Deep inspection of stylesheets ([base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css), [frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css), [browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css), [player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css)), lighting/pointer engines ([light.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/light.ts), [pointerLight.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/pointerLight.ts)), and primary shell/browsing/player components.
**Legend:**
- `[ ] Open` — Identified improvement / fix ready for implementation.
- `[x] Fixed` — Implemented and verified.

> **Frost v3 Performance & Accessibility Invariants (Must Preserve)**
> 1. **Never** put `backdrop-filter` on repeating items inside scrollers (cards, episode tiles, list rows, settings buttons) — reserve real blurs (`smoke` / `thin`) for static floating chrome and hover-only accents.
> 2. **Never** animate `backdrop-filter` blur radii — reveal glass via opacity, masks, and transforms/scale only.
> 3. **Never** break `:root.reduce-motion`, `@media (prefers-reduced-motion: reduce)`, `@media (prefers-reduced-transparency: reduce)`, or `@media (prefers-contrast: more)` fallbacks in [base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L398-L413) and [frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L500-L655).

---

## 1. Critical Visual Bug (`UI-01`)

### `[x] Fixed` `UI-01`: Global `@property --glow` Syntax Collision Silently Disables 21 Optical Blooms & Shadows
- **Severity:** Critical (Visual Regression Across Whole App)
- **Locations:**
  - Declaration conflict: [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L40) vs. [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L37)
  - Pointer-rim consumers: [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L166-L198)
  - Broken `box-shadow` consumers (21 total across stylesheets):
    - [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L138-L416) (`L138` `.mark::after`, `L169` `.dock-pill`, `L230` `.btn.play:hover`, `L237` `.btn-ion`, `L238` `.btn-ion:hover`, `L289` `.sd .th2`, `L416` `:root.gamepad-active :focus-visible`)
    - [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L111-L393) (`L111` `.card:hover .art-wrap`, `L173` `a.file:hover`, `L282` `.ep-card:hover .ec-th`, `L298` `.ep-card.cur .ec-th`, `L329` `.person:hover .person-img`, `L393` `.palette`)
    - [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L252-L459) (`L252` `.palette`, `L298` `.dock-pill`, `L379` `.btn.glass.on`, `L438` `a.file:hover`, `L459` `.empty-ic` / `.pp-idle .pp-glyph`)
    - [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css#L220-L352) (`L220` `.pbtn.big`, `L247` `.cc-btn.main`, `L352` `.skip-btn`)
- **Root Cause:**
  - `base.css:40` defines `--glow: color-mix(in oklab, var(--tone) 42%, transparent);` on `:root` as a `<color>` used for OKLCH title-tinted glow shadows.
  - `frost.css:37` (loaded last) registers **`@property --glow { syntax: "<number>"; inherits: false; initial-value: 0; }`** for the pointer-light rim multiplier (`0` → `1` on `.glow`).
  - Because CSS `@property` registrations apply document-wide, `:root`'s `color-mix(...)` fails `<number>` syntax validation and falls back to `0`. Every `box-shadow` declaration referencing `var(--glow)` then receives a `<number>` where `<color>` is required, making the **entire `box-shadow` property invalid at computed-value time** (IACVT) — silently dropping colored blooms, elevation shadows, and even `var(--rim)` glass bevels on compound shadows like `.palette`.
- **Fix Plan:** Rename the Frost pointer-intensity custom property in [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L37) (`L37`, `L167`, `L173-L197`) from `--glow` to `--p-glow`, restoring all 21 `<color>` `--glow` shadows immediately without altering [src/lib/pointerLight.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/pointerLight.ts).

---

## 2. Color, Light & Optical Atmosphere (`UI-02` – `UI-05`)

### `[x] Fixed` `UI-02`: Interpolate `--tone`, `--tone-ink`, and `--tone-deep` So Chrome Breathes With `.light`
- **Impact:** High (Color Continuity) · **Tier 1**
- **Locations:** [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L13-L40), [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L118-L120), [src/lib/light.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/light.ts#L208-L213)
- **Gap:** Only `--l1` and `--l2` are registered with `@property <color>` and transitioned (`1100ms var(--ease)`). `--tone`, `--tone-ink`, and `--tone-deep` are plain unregistered properties set via `document.documentElement.style.setProperty(...)`. Whenever Hero advances slides or a user enters a Title page, the room background glides over `1.1s` while buttons, active Hero ticks, wordmark accents, eyebrow rules, and progress bars hard-snap to the new OKLCH hue in a single frame.
- **Upgrade Plan:** Register `@property --tone`, `--tone-ink`, and `--tone-deep` (`syntax: "<color>"; inherits: true; initial-value: ...`) in [base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L13-L15) and transition them on `:root` (`720ms var(--ease)`), honoring `:root.reduce-motion` / `prefers-reduced-motion` (`1ms`). Note: verify CPU/paint cost during slide switches since `inherits: true` triggers root cascade; at one transition per `9000ms` slide change or route navigation it stays well off hot scroll/pointer paths.

### `[x] Fixed` `UI-03`: Chromatic Specular Rim & Card Edge Dispersion
- **Impact:** Medium–High (Glass Material Realism) · **Tier 1 / 2**
- **Locations:** [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L166-L198), [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L106-L114)
- **Gap:** Pointer-following highlights on glass rims (`frost.css:174-176`) and tilting card surfaces (`browse.css:108-109`) are neutral white (`rgb(255 255 255 / ...)`), whereas real cinema glass and optical lenses refract ambient light in the scene's dominant hue.
- **Upgrade Plan:**
  - In `frost.css`, layer a subtle offset radial stop tinted with `color-mix(in oklab, var(--tone) 34%, transparent)` into the pointer rim gradient alongside the crisp white core.
  - On `.card .art-wrap::before` (`browse.css:112`), add a soft title-tinted inner highlight glow weighted toward the pointer-driven top rim.

### `[x] Fixed` `UI-04`: Live Ambient Tinting Inside the Command Palette (`Ctrl+K`)
- **Impact:** High (Signature AbixCine Moment) · **Tier 2**
- **Locations:** [src/components/CommandPalette.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/CommandPalette.tsx#L196), [src/components/CommandPalette.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/CommandPalette.tsx#L286-L294), [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L392-L429), [src/lib/light.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/light.ts#L271-L283)
- **Gap:** Moving the selection cursor through media items swaps the `<Preview />` panel, while `.palette` and `.pal-preview` remain locked to the underlying page's hue.
- **Upgrade Plan:** When `cur?.media` changes, sample/apply localized OKLCH preview light (`previewLight(cur.media)` or local `--pal-l1` / `--pal-l2` behind `.pal-preview` + rim glow on `.palette`) and restore cleanly on close (`onClose`), making keyboard navigation visibly illuminate the glass palette with each film's color mood.

### `[x] Fixed` `UI-05`: Opt-In Cinema Bias Lighting (Ambilight) Behind Player Video
- **Impact:** High (Theater Immersion) · **Tier 3**
- **Locations:** [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L130), [src/pages/Watch.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/pages/Watch.tsx), [src/components/Player.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Player.tsx), [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css)
- **Gap:** `.is-watching .light` is `display: none` (`base.css:130`), leaving pitch-black letterbox/pillarbox regions around `2.39:1` cinema frames and `4:3` anime.
- **Upgrade Plan:** Add an opt-in **"Cinema glow"** player toggle that draws the active `<video>` (when CORS-clean / local / proxied via loopback gateway) onto a `16×9` offscreen canvas throttled to ~5–8 fps and drives CSS ambient radial color stops behind the video surface (respecting reduced-motion and idle/paused performance budgets).

---

## 3. Motion, Transitions & Spatial Choreography (`UI-06` – `UI-09`)

### `[x] Fixed (tagForMorph keeps its 700ms timeout: router does not expose transition.finished)` `UI-06`: Pinned TopBar, Directional Root Transitions & `TitleArt` Shared Morph
- **Impact:** High (Spatial Continuity) · **Tier 1 (Pinned TopBar) + Tier 3 (Directional + Title Morph)**
- **Locations:** [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L382-L386), [src/components/TitleBar.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/TitleBar.tsx#L132), [src/components/Card.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Card.tsx#L19-L30), [src/components/Hero.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Hero.tsx#L109-L125)
- **Gap:**
  - Every route change crossfades the entire `root` snapshot, causing the floating `.top` glass bar and `.dock` to flash/fade instead of holding position while `.dock-pill` glides.
  - `tagForMorph()` in `Card.tsx:19-30` restores `viewTransitionName` with a hardcoded `setTimeout(..., 700)` rather than tying cleanup to View Transition completion (`transition.finished`), and only morphs `.art-wrap` -> `.hero` backdrop (not Hero -> Title title treatment or directional forward/back depth).
- **Upgrade Plan:**
  - Assign `view-transition-name: topbar` to `.top` on non-watch routes (`base.css`), keeping chrome anchored while content transitions underneath.
  - Use `useNavigationType()` / route direction attributes on `<html>` (`vt-forward` vs `vt-back`) for subtle depth push/pop (`scale(0.985) -> 1` forward, `scale(1.015) -> 1` receding back).
  - Morph `.hero-copy .title-art` (`view-transition-name: hero-title`) from Hero into Title (`Title.tsx:308`) and coordinate `tagForMorph` cleanup deterministically so rapid back/forward navigation never leaves orphaned `view-transition-name` styles.

### `[x] Fixed` `UI-07`: Hero Slide Exit Dissolve, Scroll-Driven Stage Parallax & Compact Programme Pill
- **Impact:** High (Flagship Landing Feel) · **Tier 2**
- **Locations:** [src/components/Hero.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Hero.tsx#L109-L170), [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L12-L68)
- **Gap:**
  - `.hero-copy` uses `key={m.key}` (`Hero.tsx:119`), unmounting outgoing copy in `0ms` while `.hero-bg` crossfades over `1000ms` (`browse.css:15`), producing a jarring snap on the foreground typography.
  - Scrolling down from the Hero simply translates the page vertically with zero stage depth recession.
  - Below `1180px` width or `720px` height, `.hero-queue` disappears completely (`browse.css:66`), hiding slide previews on standard laptop viewports (`960–1180px`).
- **Upgrade Plan:**
  - Keep the exiting slide copy mounted briefly (~`220–260ms`) for a smooth upward opacity dissolve overlapping incoming copy rise.
  - Drive `.hero-stage` scale/translate/brightness gently via CSS `animation-timeline: scroll()` (on `.main`) so the backdrop recedes smoothly in Z-space as shelves scroll over its feathered base.
  - Replace hard hiding below `1180px` width with a sleek 1-line compact "Next · <title>" glass pill aligned beside `.hero-ticks`.

### `[x] Fixed` `UI-08`: Unified Spring Sliding Indicators Across All Tab Bars & Selectors
- **Impact:** High (Cohesive Tactile Craft) · **Tier 2**
- **Locations:**
  - Already sliding well: [src/components/TitleBar.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/TitleBar.tsx#L96-L113) (`.dock-pill`), [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L286-L297) (`.sd .th2`, `.seg-thumb`)
  - Currently snapping without a sliding thumb/bar:
    - [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L241-L254) (`.tabbar > button`, `.season-pick`, `.view-pick`)
    - [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css#L304-L307) (`.ps-tabs`)
    - [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L401-L402) & [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L269-L272) (`.pal-item.on`)
    - [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L435-L439) & [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L485-L489) (`.set-nav button.on`)
    - [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L277-L284) (`.seg-pills`, `.seg3`, `.sub-seg`)
- **Gap:** Only `.dock`, `.sd`, and `.seg` glide with animated indicators; every other selector snaps backgrounds/underlines in place. `.tabbar` (`browse.css:245`) scales individual `::after` underlines from the left edge instead of gliding continuously between tabs.
- **Upgrade Plan:** Extract a lightweight shared `useSlidingIndicator(containerRef, selector, deps)` hook using `ResizeObserver` + `offsetLeft`/`offsetTop`/`offsetWidth`/`offsetHeight` (identical pattern to `TitleBar.tsx:96-113`) to drive sliding glass pills / glowing underlines across `.tabbar`, `.season-pick`, `.view-pick`, `.ps-tabs`, `.pal-list` (Raycast-style sliding highlight bar), `.set-nav`, and `.seg-pills`/`.seg3`/`.sub-seg`.

### `[x] Fixed (.track mask REJECTED: breaks hover .act backdrop-filter, frost rule 3)` `UI-09`: Shelf Edge Feathering, VisionOS Spotlight Focus Dimming & Scroll-Synced Reveals
- **Impact:** High (Browsing Polish) · **Tier 1 (`track` feather + `:has()` focus) + Tier 3 (`view()` reveal)**
- **Locations:** [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L90-L118), [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L264-L267)
- **Gap:**
  - `.season-strip` already demonstrates clean CSS scroll-driven left/right edge feathering (`browse.css:264-267`), yet horizontal `.track` shelves clip sharply at viewport bounds.
  - Hovering a card elevates and tilts it, but adjacent sibling cards remain at full luminance instead of subtly stepping back.
  - `.card` (`browse.css:97`) triggers `animation: rise` immediately on mount even when rows sit far below the fold (paired with `content-visibility: auto` on `.shelf`, `browse.css:73`, offscreen reveals never get seen).
- **Upgrade Plan:**
  - Apply scroll-driven `--fl`/`--fr` mask edges to `.track` (`browse.css:90`) so overflow edges dissolve organically into the lit room.
  - Add pure-CSS sibling dimming `.track:has(.card:hover, .card:focus-within) .card:not(:hover):not(:focus-within)` -> subtle `opacity: 0.72` / `filter: saturate(0.84)` transition (`browse.css`, respecting reduced motion) for instant poster spotlight focus with zero JS overhead.
  - Gate below-the-fold `.shelf` card entrance reveals on `animation-timeline: view()` (`animation-range: entry 0% entry 26%`, keeping initial first-fold shelves immediate so LCP stays instant).

---

## 4. Tactile Effects, Materials & Player Micro-Craft (`UI-10` – `UI-13`)

### `[x] Fixed` `UI-10`: Pointer-Light Specular Rim Coverage on Modals & Paused Player HUD
- **Impact:** Medium–High (Frost v3 Consistency) · **Tier 1**
- **Locations:** [src/lib/pointerLight.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/pointerLight.ts#L17), [src/lib/pointerLight.ts](file:///c:/Users/Ayomide/Documents/abixcine/src/lib/pointerLight.ts#L52), [src/styles/frost.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/frost.css#L166-L198)
- **Gap:**
  - `PANES` in `pointerLight.ts:17` omits `.palette`, `.trailer-pane`, `.race-grid-wrap`, `.pbot`, `.ptop-actions`, and `.psheet`.
  - `pointerLight.ts:52` short-circuits whenever `appEl?.classList.contains("is-watching")` is true, which disables rim lighting even on the Source Race screen (`SourceBoard` inside `.race-grid-wrap`) and when the player is paused or the side sheet (`.psheet`) is open.
- **Upgrade Plan:** Add `.palette`, `.trailer-pane`, `.race-grid-wrap`, `.pbot`, `.ptop-actions`, `.psheet` (plus `.upnext`, `.pkeys`) to `PANES` and `frost.css` `.glow` selectors; in `pointerLight.ts:52`, skip only during unpaused/idle video (`is-watching` without active `.psheet.open` / `.is-paused` / `.race` / open palette), keeping idle playback CPU cost at `0`.

### `[x] Fixed` `UI-11`: Custom Glass Range Sliders Replacing Native Browser Controls
- **Impact:** High (Visual Coherence in Player & Subtitle Studio) · **Tier 1**
- **Locations:** [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css#L285-L287), [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css#L511-L529)
- **Gap:** While the main seek bar ([Playhead.tsx](file:///c:/Users/Ayomide/Documents/abixcine/src/components/Playhead.tsx#L133-L171)) is custom-crafted, the volume slider (`.vol input` with `accent-color: #fff`) and Subtitle Studio sliders (`.sub-slider-row input[type="range"]`, `.sub-range-ctrl input[type="range"]` with `accent-color: var(--tone)`) fall back to generic Chromium range widgets that clash with Frost v3 glass.
- **Upgrade Plan:** Author shared custom range slider styling (`-webkit-appearance: none`) with a recessed glass track, active `--tone` progress fill gradient up to `--val`, a glowing `.knob`-matched thumb that scales smoothly on hover/active, and a subtle `100%` unity notch/marker on the `0–200%` volume boost slider.

### `[x] Fixed` `UI-12`: Editorial Depth & Counter-Parallax on Top 10 Ranked Numerals
- **Impact:** Medium–High (Shelf Signature Detail) · **Tier 2**
- **Locations:** [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L153-L158)
- **Gap:** `.rank-n` uses a flat `2px rgb(255 255 255 / 0.46)` outline stroke behind leaning posters, missing depth separation and optical shading.
- **Upgrade Plan:** Add a lower edge mask fade (`mask-image: linear-gradient(180deg, #000 58%, transparent 100%)`), tone-tinted drop-glow and inner gradient fill on `.rank:hover .rank-n`, and subtle counter-parallax translation (`transform: translateX(-6px) scale(1.03)`) opposing the tilting poster card.

### `[x] Fixed` `UI-13`: Player Micro-Interactions (Seek Arcs, Anime4K Wipe Polish, Magnetic CTAs & Live Meters)
- **Impact:** High (Delight & Craft) · **Tier 2 / 3**
- **Locations:** [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css#L373-L386), [src/styles/player.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/player.css#L533-L545), [src/styles/base.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/base.css#L226-L231), [src/styles/browse.css](file:///c:/Users/Ayomide/Documents/abixcine/src/styles/browse.css#L136-L144)
- **Gaps & Upgrades:**
  - **`.seek-bump` (`player.css:381-386`):** Upgrade from a flat dark disk to frosted HUD glass (`backdrop-filter: var(--hud-blur)` + specular rim) with cascading chevron motion and a crisp re-pop impulse when accumulating seeks (`+10s -> +20s -> +30s`).
  - **Anime4K `.compare` (`player.css:533-545`):** Add active-drag glow on the vertical split line, spring scale on `.compare-handle`, and double-click snap-to-`50%` convenience.
  - **Live `.ptoast` Meters (`player.css:373-380`):** Include a compact animated capsule meter bar inside `.ptoast` for continuous adjustments (volume `0–200%`, speed, subtitle timing offset) instead of text-only updates.
  - **Magnetic Play CTAs & Bookmark Burst:** Subtle `3–5px` pointer-magnet translation on Hero `.btn.play` and paused `.cc-btn.main`, plus an expanding halo ring pulse when adding/removing **My List**.

---

## 5. Prioritized Rollout Roadmap

| Tier | Items | Summary |
| :--- | :--- | :--- |
| **Tier 1 — Immediate Wins** | `UI-01`, `UI-02`, `UI-03` (part 1), `UI-06` (`topbar`), `UI-09` (`.track` fade + focus), `UI-10`, `UI-11` | Fix `--glow` collision restoring 21 glows; interpolate `--tone*` tokens; pin `.top` across routes; extend `pointerLight` to modals/paused HUD; custom glass sliders; `.track` scroll feathering & sibling focus dim. |
| **Tier 2 — Signature Motion** | `UI-04`, `UI-07`, `UI-08`, `UI-12`, `UI-13` (seek & compare) | Unified `useSlidingIndicator` hook across `.tabbar`, `.season-pick`, `.view-pick`, `.ps-tabs`, `.pal-item`, `.set-nav`, `.seg*`; Command Palette live ambient tinting; Hero exit dissolve & scroll parallax; Top 10 depth parallax; frosted seek arcs & Anime4K wipe handle polish. |
| **Tier 3 — Flagship Showstoppers** | `UI-03` (card dispersion), `UI-05`, `UI-06` (directional + title morph), `UI-09` (`view()` reveals), `UI-13` (magnetic + toast meters) | Directional root transitions + Hero→Title `TitleArt` morph; `animation-timeline: view()` shelf reveals; opt-in Cinema Bias Lighting in Player; magnetic Play CTAs & live `.ptoast` meters. |
