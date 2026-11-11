# Player and source plugin API

How to open the AbixCine player in a given state, drive it from code, and add a new source.
Everything here is in-process: there is no network API and no `postMessage` listener, so a web
page can't control the player.

## 1. Watch links

Every Play button builds a `/watch` link with `watchHref()` (`src/lib/play.ts`). The router is a
hash router, so a full link looks like:

```
#/watch/tmdb%3Atv%3A1399?s=1&e=3&a=sub&t=12:34&speed=1.25&provider=jellyfin
```

| Param | Values | Default | What it does |
| --- | --- | --- | --- |
| `s`, `e` | numbers | – | Season and episode. |
| `a` | `sub` \| `dub` | per-show choice | Anime audio track. |
| `t` / `start` | `754`, `12:34`, `1:02:03`, `1h2m3s` | saved resume point | Start here. Wins over Continue watching. |
| `speed` | `0.5` `0.75` `1` `1.25` `1.5` `2` | `1` | Initial playback rate. Carries over to the next episode. |
| `provider` / `server` | a provider id (`local`, `jellyfin`, …) | `auto` | Prefer this source. The picker waits up to 2.5 s for it, then ranks it first if it has a playable copy. If it has none, ranking is as usual. |
| `controls` | `1` \| `0` | `1` | `0` hides the control bar (ambient mode). Press **C** to bring it back. |
| `autoplay` | `1` \| `0` | `1` | `0` loads paused. |
| `muted` | `1` \| `0` | `0` | Start muted. |
| `sub` | language code (`en`, `ja`, `pt-br`) or `off` | off | Turn on the first subtitle track in that language once it appears. |
| `title` | text | catalog title | Replace the title in the player header. |

Values that don't parse are ignored, never trusted. Parsing and building live in
`src/player/params.ts` (`parsePlayerParams`, `playerParamsToQuery`), and `watchHref()` takes them
as its last argument:

```ts
watchHref(media.key, 1, 3, "sub", { start: 754, speed: 1.25, provider: "jellyfin" });
```

## 2. Player command and event bus

`src/player/bus.ts` exports `playerBus`. The `<Player>` attaches itself while it is on screen.

```ts
import { playerBus, usePlayerEvent } from "../player/bus";

playerBus.send({ type: "seekBy", seconds: 85 });      // false if nothing is playing
playerBus.state();                                     // PlayerState snapshot or null
const off = playerBus.on("sourcechange", (e) => console.log(e.from?.providerName, "→", e.to.providerName, e.reason));

// In a component, auto-unsubscribed on unmount:
usePlayerEvent("ended", () => markWatched());
```

In dev builds the bus is also on `window.abix.player`, for the console.

**Commands** (`PlayerCommand`)

| Command | Fields |
| --- | --- |
| `play`, `pause`, `toggle` | – |
| `seek` | `time` seconds |
| `seekBy` | `seconds` (negative goes back) |
| `setVolume` | `volume` 0..1 |
| `mute` | `muted?` (omit to toggle) |
| `setSpeed` | `rate`, one of the speeds above |
| `setProvider` | `provider` id: best ready copy from that provider, keeps the playhead |
| `setSource` | `index` into `state.sources` |
| `setSubtitle` | `index` into `state.subtitles`, or `-1` for off |
| `setQuality` | `height` such as `1080`, or `-1` for auto (HLS only) |
| `fullscreen` | `on?` (omit to toggle) |
| `next`, `back` | – |

**Events** (`PlayerEventMap`): `attach`, `detach`, `ready`, `play`, `pause`, `timeupdate` (about
4 per second), `buffering`, `ended`, `volumechange`, `ratechange`, `sourcechange` (with
`reason: "user" | "failover" | "command"`), `error` (every source failed), `subtitlechange`,
`qualitychange`.

A listener that throws is logged and skipped; it can't break playback or other listeners.

The command palette (Ctrl+K) uses the bus while something is playing: pause, skip intro, switch
source, speed and subtitles.

## 3. Sources and fallback

A source is a `SourceProvider` (`src/sources/types.ts`) registered in `PROVIDERS`
(`src/sources/registry.ts`).

```ts
export const myServerProvider: SourceProvider = {
  id: "myserver",              // also what ?provider= and setProvider use
  name: "My server",
  category: "external",        // "local" = on this PC
  tier: 2,                     // label in the player: 1 on this PC, 2 your server, 3 licensed service
  priority: 20,                // tie-breaker; local files are 30
  isEnabled: (s) => !!s.myServer?.url,
  async find(req, s, signal) {
    // Look up req.media (+ season/episode/audio) and return playable streams.
    return [{ providerId: "myserver", providerName: "My server", label: "Episode 3 · 1080p", url, kind: "hls", quality: 1080 }];
  },
};
```

Rules for a provider:

- Return only streams the viewer has the right to play: their own files, their own media server,
  or a licensed API. Scrapers and unlicensed embed sites don't go in.
- Honour `signal`: the race aborts slow lookups.
- Don't throw for "not found"; return `[]`. Throw for real errors so health tracking counts them.
- Put subtitles in `subtitles: [{ lang, label, url }]` as WebVTT; the player adds them as tracks.

**What happens on Play.** Every enabled provider is asked at once. Each result is probed (HLS
manifest read, or a 2-byte range request for files) and scored on quality fit, speed, the
provider's track record, and what played this title last time (`score()` in `registry.ts`). The
picker commits once there is a confident winner and keeps slower sources racing as backups.

**Fallback.** If the playing source dies (network or decode error after two local recoveries), the
player moves to the next ready source in the list and resumes at the same time. The player's
source panel shows this chain in order, with each source's tier, its provider's health, and a log
of switches made during the episode.

**Health** (`src/sources/health.ts`) is kept per provider in localStorage: decayed success and
failure counts, average latency, and when it last failed. `providerStatus(id)` turns that into
`healthy`, `degraded` (often fails, or slower than 1.5 s), `down` (failed in the last 10 minutes
and not worked since) or `new`.

## 4. Tests

`npm test` runs Vitest. `src/__tests__/player.test.ts` covers link parsing, the bus, provider
preference, tiers and health. To try the race and fallback in a browser without real sources,
build with `VITE_MOCK_SOURCES=1` and serve a test video at `VITE_MOCK_MEDIA`
(see `src/sources/mock.ts`).
