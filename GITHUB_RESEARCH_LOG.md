# AbixCine GitHub Research & Adoption Log

**Date:** 2026-11-13  
**Baseline Audited:** AbixCine `v1.4.0` (`d5b28bd`) — Windows Tauri 2 (Rust + WebView2) + React 18 / TypeScript + Render Fastify 5 (`server/`).

---

## 1. Baseline Audit & Gaps Identified

### What AbixCine Had at Baseline
- **Local & Media Servers:** `src/sources/local.ts` (`scan_library`, `ffprobe`/`ffmpeg` audio remux/transcode to cached `.mp4`) and `src/sources/jellyfin.ts` (Jellyfin/Emby).
- **Movie/TV Embeds (`src/sources/embeds.ts`):** 14 embed servers (`vidfast`, `vidnest`, `vidlink`, `vidsrcsu`, `vidrift`, `aether`, `smashystream`, plus 7 `extra`: `vidsrccc`, `vidsrcto`, `2embed`, `multiembed`, `embedsu`, `vidsrcrip`, `frembed`), **all** captured via off-screen WebView2 `sniff()` (4–10s per probe).
- **Anime (`src/sources/anime-direct.ts`):** Single direct source (`hianime` via `zokoanime.video` XOR `"otaku-embed-v1"`) with string-search `malIdFor()` on AniList.
- **Asian Drama (`src/sources/kisskh.ts`):** `kisskh.co` API search + slow WebView2 `sniff()`.
- **Core Pipeline:** `probeHedged` + `health.ts` circuit breaker, `abxs:` Rust proxy (`src-tauri/src/stream.rs`) with `.m3u8` + `.mpd` rewriting, `shield.rs` static ~100-domain blocklist, `anime4k-webgpu` upscaler, Wyzie + OpenSubtitles v3 Stremio subtitle search.

### Key Gaps Found
1. **Zero direct Movie/TV extractors** (100% WebView2 sniff dependency).
2. **DASH `.mpd` dead-end:** `stream.rs` and `registry.ts` supported `.mpd`, but `Player.tsx` lacked a DASH player (`shaka-player`/`dash.js`).
3. **Single-point-of-failure Anime & Drama:** Only 1 direct anime backend (`zokoanime.video`), heuristic TMDB→MAL/cour mapping, and 1 sniffed drama source (`kisskh` lacking AES-128-CBC decryption for `.txt`/`.txt1` subs).
4. **No Addon / Plugin / Debrid / Torrent ecosystem.**
5. **Subtitle, Skip & Anti-bot ceilings:** Simplified HTML-span ASS/SSA rendering, no OpenSubtitles `OSHash` or SubDL, skip segments limited to `hianime`, static blocklist in `shield.rs`, default `rustls` TLS fingerprint in `reqwest`, and no native `libmpv` / Trakt-SIMKL scrobbling / Watch Party.

---

## 2. GitHub Repositories Researched

### A. Movies & TV Sources / Direct Extractors
*(Dead/DMCA'd/archived repos excluded: `p-stream/p-stream`, `sussy-code/smov`, `sussy-code/providers`, `Ciarands/vidsrc-keys`, `consumet/consumet.ts`, `cool-dev-guy/vidsrc.ts`, `lestwastaken/lestresolver`.)*

| Repository | Stats / License / Activity | Key Sources & Extraction Patterns | Notes & Caveats |
|---|---|---|---|
| [`Inside4ndroid/TMDB-Embed-API`](https://github.com/Inside4ndroid/TMDB-Embed-API) | 150★ · MIT · `2026-08-19` | `ZXCStreams` (local SHA-512 signing across `icarus/berkas/orion/athena`), `VixSrc`, `StreamFlix` (MP4), `DahmerMovies` (1080p/MKV), `CastleTV` (AES-128), `OneTouchTV` (AES-256), `VaPlayer`, `4KHDHub`, `Showbox` | Unobfuscated MIT JS; clean port to TS + `httpFetch` + `abxs:`. |
| [`itsmeadarsh2008/Streamline`](https://github.com/itsmeadarsh2008/Streamline) | 18★ · AGPL-3.0 · `2026-10-17` | `Vidrock` (local AES-256-GCM), `VaPlayer` (`streamdata.vaplayer.ru`), `PrimeSrc`, `MovieBox`, `Hexa`, `Vidzee`, `Vidcore`, `AllMovieLand`, `Cinejoy`, `hubcloud.js` mirrors (`4KHDHub`, `UHDMovies`, `MoviesMod`, etc.), `Videasy` (`api.speedracelight.com/seed`) | AGPL-3.0 (reference only or external plugin); `vidlink`/`vidfast`/`videasy`/`hexa` call `enc-dec.app/api` (external SPOF). |
| [`walterwhite-69/Vidlink.pro-Decryptor`](https://github.com/walterwhite-69/Vidlink.pro-Decryptor) & [`walterwhite-69/Vidsrc.cc-Decryptor`](https://github.com/walterwhite-69/Vidsrc.cc-Decryptor) | 17★ / 11★ · `2026-03` | Local `XSalsa20-Poly1305` (`SecretBox`) token for `vidlink.pro/api/b/...` and local VRF token for `vidsrc.cc` | Zero `enc-dec.app`, `<500ms` vs 4–10s sniff; keep `sniff()` fallback for CF/TLS blocks. |
| [`qwertyuiop8899/streamvix`](https://github.com/qwertyuiop8899/streamvix) & [`webstreamr/webstreamr`](https://github.com/webstreamr/webstreamr) | 92★ GPL-3.0 (`2026-11-10`) / 167★ MIT (archived `2026-03` + active forks) | `VixSrc`, `RgShows` (works better on residential desktop IPs than VPS), `FourKHDHub`, `HDHub4u`, multilingual ES/DE/IT/FR/AL scrapers, file hosters | AbixCine's `abxs:` proxy solves Stremio's `Referer`/IP-binding limitation natively. |
| [`NuvioPlugin/All-in-One-Nuvio`](https://github.com/NuvioPlugin/All-in-One-Nuvio) & [`yoruix/nuvio-providers`](https://github.com/yoruix/nuvio-providers) | 200★ / 256★ GPL-3.0 · `2026-10` | `Mapple`, `Peachify`, `1Shows`, `Cineby`, `YFlix`, `Vidnest` (direct AES-GCM), `VidLove`, `XPass`, `Movix`/`Purstream` (FR) | Bundled/minified JS; best consumed via sandboxed JS plugin runner. |

### B. Anime, Asian Drama & Metadata Sources
*(DMCA'd HTTP 451 repos excluded: `consumet/consumet.ts`, `ghoshRitesh12/aniwatch-api`, `ThaUnknown/miru`, `itzzzme/anime-api`. `pystardust/ani-cli` duplicates `anime-direct.ts`'s `zokoanime.video`.)*

| Repository | Stats / License / Activity | What It Provides | Integration Fit |
|---|---|---|---|
| [`Seanime-contributions/Seanime-Providers`](https://github.com/Seanime-contributions/Seanime-Providers), [`aquaryuo/seanime`](https://github.com/aquaryuo/seanime), [`Bas1874/Seanime-Marketplace`](https://github.com/Bas1874/Seanime-Marketplace) | 76★ MIT / 5★ MIT / 117★ · `2026-11-12..13` | Direct TS/JS anime providers (`.m3u8` + softsubs + sub/dub): `AniZone` (`anizone.to`), `KickAssAnime` (`kaa.lt`), `Anikoto`, `MKissa`/`AllManga`, `MegaPlay`/`MegaVid` (AniList/MAL ID keyed), `AniTVPlus`, `Shiro`, `Animeya` | Clean TypeScript `fetch` extractors; `Seanime-Marketplace` tracks live `workingTag`/`brokenTag` health. |
| [`anibridge/anibridge-mappings`](https://github.com/anibridge/anibridge-mappings) & [`Fribb/anime-lists`](https://github.com/Fribb/anime-lists) | 38★ MIT / 280★ · `2026-11` | 1:1 `themoviedb_id ↔ anilist_id ↔ mal_id ↔ imdb_id` + explicit season/episode cour range rules (`111k+` nodes) | Replaces heuristic `malIdFor()` string matching and cour guessing. |
| [`debakarr/kisskh-dl`](https://github.com/debakarr/kisskh-dl) | 71★ · `2026-09-04` | Documents KissKH AES-128-CBC subtitle decryption (`.txt`/`.txt1` subs; key `8056483646328763`, IV `6852612370185273`) | Immediate fix for encrypted KissKH subtitles in `kisskh.ts`. |
| [`phisher98/cloudstream-extensions-phisher`](https://github.com/phisher98/cloudstream-extensions-phisher) & [`yuzono/anime-repo`](https://github.com/yuzono/anime-repo) | 544★ / 75★ · `2026-11-13` | `OneTouchTV` (K/C/J/Thai drama, EN subs), `OHLI24` (Korean), `Idlix`/`LayarKaca`, `AnimePahe`, `Donghuastream` | Fixes single-source `kisskh.ts` drama bottleneck; `plugins.json` tracks live domains. |
| [`Wraient/curd`](https://github.com/Wraient/curd) & [`hexxt-git/anime-sdk`](https://github.com/hexxt-git/anime-sdk) | 337★ GPL-3.0 / 48★ · `2026-06..09` | Cookie-jar persistence for `AnimePahe` (DDoS-Guard), `AllAnime` GraphQL+AES-CTR, Jikan v4 filler episode flagging | Useful patterns for anti-bot cookie jars and filler badges. |
| [`aniskip/aniskip-api`](https://github.com/aniskip/aniskip-api) & [`TheIntroDB`](https://github.com/TheIntroDB) | 20★ MIT / Active org | `GET /v2/skip-times/{malId}/{ep}` + `api.theintrodb.org/v4` (`intro`/`recap`/`credits`/`preview`) | Universal skip timestamps for movies, TV, dramas, local, Jellyfin, and all anime. |

### C. Streaming Systems & Architecture
| System / Repo | Stars / License | Capability | Status for AbixCine |
|---|---|---|---|
| [`brave/adblock-rust`](https://github.com/brave/adblock-rust) | 2,936★ · MPL-2.0 | EasyList/uBlock network + cosmetic/scriptlet engine (`adblock 0.13.5`) | **Adopted** in `src-tauri/src/shield.rs`. |
| [`shaka-project/shaka-player`](https://github.com/shaka-project/shaka-player) | 8,278★ · Apache-2.0 | MSE/EME MPEG-DASH (`.mpd`) + HLS playback | **Adopted** in `src/components/Player.tsx`. |
| [`ThaUnknown/jassub`](https://github.com/ThaUnknown/jassub) | 211★ · MIT | Full `libass` WASM ASS/SSA subtitle renderer | **Adopted** in `src/components/SubtitleOverlay.tsx`. |
| [`TheIntroDB`](https://github.com/TheIntroDB) + [`aniskip-api`](https://github.com/aniskip/aniskip-api) | Active / MIT | Universal intro/outro/recap timestamps | **Adopted** in `src/lib/skipSegments.ts`. |
| [`wyziedevs/wyzie-subs`](https://github.com/wyziedevs/wyzie-subs) + OSHash + SubDL | 75★ | `sub.wyzie.io` + `.ru` fallback, OpenSubtitles 64-bit `OSHash`, SubDL API | **Adopted** in `src/lib/subtitleProviders.ts` & `src-tauri/src/lib.rs`. |
| [`Stremio/stremio-core`](https://github.com/Stremio/stremio-core) + [`MunifTanjim/stremthru`](https://github.com/MunifTanjim/stremthru) + [`Viren070/AIOStreams`](https://github.com/Viren070/AIOStreams) | 2.5k★ MIT / 562★ MIT / 3.1k★ AGPL | Stremio `manifest.json` addon protocol + unified Real-Debrid/TorBox/AllDebrid resolution | **Adopted** (clean-room TS) in `src/sources/stremio.ts` & `src/lib/debrid.ts`. |
| [`5rahim/seanime`](https://github.com/5rahim/seanime) (plugin architecture) | 4,327★ · GPL-3.0 | Hot-updatable sandboxed JS provider scripts | **Adopted** (WebWorker + capability-locked `host.httpFetch` + SSRF protection) in `src/sources/pluginRunner.ts`. |
| [`ikatson/rqbit`](https://github.com/ikatson/rqbit) (`librqbit`) | 1,990★ · Apache-2.0 | Pure-Rust BitTorrent streaming (`rustls` + `ring`, HTTP `Range` seeking) | **In Progress (Phase 3)** behind Cargo feature `torrent` in `src-tauri/src/torrent.rs`. |
| [`nini22P/tauri-plugin-libmpv`](https://github.com/nini22P/tauri-plugin-libmpv) | 24★ · MPL-2.0 | Optional native `libmpv` backend for MKV/HEVC-10bit/DoVi/PGS without transcoding | **Deferred to Phase 4** (requires bundling `libmpv-2.dll` + HWND layering). |
| [`0x676e67/wreq`](https://github.com/0x676e67/wreq) | 1,106★ · Apache-2.0 | Browser JA3/JA4 TLS + HTTP/2 impersonation (`btls-sys`) | **Deferred to Phase 4** (requires BoringSSL + `rustc 1.98` toolchain check). |
| [`cenodude/CrossWatch`](https://github.com/cenodude/CrossWatch) & [`Syncplay/syncplay`](https://github.com/Syncplay/syncplay) | 1k★ AGPL / 2.7k★ Apache-2.0 | Two-way Trakt/SIMKL/AniList scrobbling + Watch Party WebSocket drift-correction | **Deferred to Phase 4** (`server/` Fastify 5 WebSocket relay + OAuth device flow). |

---

## 3. Implementation Progress

### Merged & Verified on Main
- **Phase 1 — Player & Core Media (`e9d021c`, `b190da8`, `1e72a3f`):**
  - `shaka-player` dynamic `.mpd` DASH playback in `src/components/Player.tsx`
  - `ThaUnknown/jassub` WASM `libass` ASS/SSA rendering in `src/components/SubtitleOverlay.tsx` + `vite.config.ts`
  - `src/lib/skipSegments.ts` (`TheIntroDB` v4 + `AniSkip` v2) wired into `Player.tsx`
  - `src/lib/animeMapping.ts` (`Fribb/anime-lists` + `anibridge-mappings`) integrated into `anime-direct.ts` & `normalizer.ts`
  - `src/sources/kisskh.ts` AES-128-CBC subtitle decryption
  - `src-tauri/src/lib.rs` `compute_oshash` + `src/lib/subtitleProviders.ts` Wyzie `.io`/`.ru`, OSHash, SubDL, and ZIP extraction
- **Phase 2 — Adblock & Direct Extractors (`ddd603c`, `0882455`, `f4f4c99`):**
  - `brave/adblock-rust` (`adblock 0.13.5`) network + cosmetic/scriptlet shield in `src-tauri/src/shield.rs`
  - 10 direct TypeScript extractors in `src/sources/extractors/` (`zxcstreams`, `vaplayer`, `primesrc`, `vixsrc`, `vidlink`, `vidrock`, `anizone`, `kickassanime`, `anikoto`, `onetouchtv`) wired into `src/sources/registry.ts` ahead of `embedProviders`
  - `localPath` + `subdlApiKey` wired into `Player.tsx` subtitle searches
- **Phase 3 — Extensibility Modules & Wiring (`8b3f55c`, `9232d61`, `a63b140`, `c877baf`):**
  - `src/lib/debrid.ts` (Real-Debrid, TorBox, AllDebrid)
  - `src/sources/stremio.ts` (`StremioAddonProvider` + subtitle query helper)
  - `src/sources/pluginRunner.ts` (sandboxed WebWorker JS provider runner with SSRF protection)
  - `src/sources/registry.ts`, `src/lib/settings.ts`, `src/pages/Settings.tsx`, `src/components/Player.tsx`: Registered `stremioProvider` and `pluginProvidersSource`, added `#extensions` Settings UI (Stremio Addons, Debrid, JS Provider Plugins, SubDL API key), and wired `magnet:` torrent playback in `Player.tsx`
  - `src-tauri/src/torrent.rs` + `src-tauri/Cargo.toml` + `src-tauri/src/lib.rs`: Feature-gated `librqbit` Rust BitTorrent streaming backend (`--features torrent`, local `127.0.0.1:0` HTTP `Range`-seeking server, plus lean default stubs)

- **Phase 4 — Live-Probe Findings Implemented (2026-11-15):**
  - New direct extractors in `src/sources/extractors/`: `hexa.ts` (`hexa-direct`, cap-token cached for 18 uses), `vidup.ts` (2-stage token, ≤3 servers in parallel, stage URLs pinned to `vidup.to`), `cinejoy.ts` (binary `/g` envelope; Nebula/Lisbon/Light in parallel, MKV-only Orion as fallback), `meowtv.ts` (single-use ticket per request, subtitles fetched in parallel and capped at 2 per language / 48 total), `megaplay.ts` (standalone MAL/AniList-keyed anime extractor with local AES-256-CBC + intro/outro).
  - `encdec.ts`: shared `enc-dec.app` client with a 60 s outage cooldown so one outage fails all dependent extractors fast instead of each burning its timeout.
  - `anikoto.ts` now scrapes mirrors only and reuses `resolveMegaPlayEmbed` (no duplicate MegaPlay requests).
  - `http_fetch_bytes` (`stream.rs`) + `httpFetchBytes` (`native.ts`) accept a binary request body (`bodyB64`).
  - Settings → `#extensions`: one-click "Public HTTP stream addons" button (`installPublicHttpStremioPresets`), shown only while presets are missing.
  - Live-verified through the real extractor code (TMDB `550`, `1399` S1E1, MAL `40748` sub/dub): every candidate returned `200/206 #EXTM3U` with the proxy's exact headers.

---

## Live Probe & Protocol Refresh (2026-11-15)

### Repositories Audited
- `Inside4ndroid/TMDB-Embed-API`: `hdghartv.cc` returned "Service Closed"; `a.111477.xyz` (`dahmermovies`) listed Fight Club directory but returned 403 on file & `p.111477.xyz/bulk` and 404 on GoT TV; `bb.streamflixserver.site` DNS failed.
- `itsmeadarsh2008/Streamline`: active provider implementations (`moviebox.js`, `vidfast.js`, `vidcore.js`, `cinejoy.js`, `hexa.js`, `vidlink.js`, `anizone.js`). Note `api.speedracelight.com` (old Videasy) returned 404.
- `smy778/EncDecEndpoints` (`https://enc-dec.app`): live `200` crypto/parse microservice & updated Python samples (`vidlink.py`, `vidfast.py`, `vidup.py`, `videasy.py`, `hexa.py`, `cinejoy.py`, `meowtv.py`, `animekai.py`, `kisskh.py`, `onetouchtv.py`, `nexa.py`).
- `SA7ANI/cb-providers` (`Nuvio` ES2020 plugins): `castle.js` (`api.hlowb.com`), `redflix.js` (`redflix.biz`), `kurage.js` (`kurage.live`).
- `Seanime-contributions/Seanime-Providers` & `Bas1874/Seanime-Marketplace`: `zokoanime`, `animeheaven`, `donghuastream`, `animegg`.
- `debakarr/kisskh-dl` & `dramabosapi/dramabos-api`: KissKH `kkey` token mechanics & Asian drama ecosystem checks.

### Direct Extractors — Live Test Matrix (TMDB `550`, TMDB `1399` S1E1, MAL `40748`/`38000`, KissKH)

| Source | Status | Verified Details & Headers |
| --- | --- | --- |
| **ZXCStreams** (`zxcstreams.ts`) | **FIXED (200)** | Moved from `.xyz` (DNS dead) to `https://zxcstream.cc` / `https://zxcstream.com`. New protocol: `POST /backend/andromeda` + `GET /backend_/sources/{srv}` using module `78863` `FIELD_MAP`, decrypted with OpenSSL AES-256-CBC (`Salted__`, passphrase `7f4c9e2a81d63b05c4f7a9e8126d3b50e1a8c7f23d9465ab0c6e9f1d4a7b832c`). Servers `valstrax` (DASH), `ursa` (HLS), `alatreon` (HLS) on `vidstuck.cc` need `Referer: https://zxcstream.cc/` + `Origin: https://zxcstream.cc`. Server `orion` on `bcdnt.hakunaymatata.com` returns 429 with `Referer`, **200 without Referer/Origin**. (`atlas` 427, `daedalus` empty.) |
| **Vidrock** (`vidrock.ts`) | **FIXED (200)** | Moved from `vidrock.ru` (DNS dead) to `https://vidrock.net`. Endpoints: `/api/movie/${tmdbId}` and `/api/tv/${tmdbId}/${season}/${episode}` (slashes, **no trailing slash**). Existing `VIDROCK_KEY_HEX` AES-256-GCM decrypts `Atlas`, `Astra`, `Orion` to `200 #EXTM3U`. |
| **Castle** (`api.hlowb.com`) | **NEW — 206** | Self-contained local AES-128-CBC (zero external decrypt API): `GET /v0.1/system/getSecurityKey/1` -> `searchByKeyword` -> `/film-api/v1.9.9/movie` -> `POST /film-api/v2.0.1/movie/getVideo2` (`User-Agent: okhttp/4.9.3`, `Referer: https://api.hlowb.com`). Key = `concat(b64decode(secKey), "T!BgJB")` truncated/padded to 16B, `iv = key`. Verified 10 streams on `550`, 3 on `1399/1/1` (`img1.hscow.com`, `206 application/vnd.apple.mpegurl`). |
| **VixSrc** (`vixsrc.ts`) | **LIVE (200)** | Returns `200 application/vnd.apple.mpegurl #EXTM3U` via `/playlist/{id}` (extensionless audio segments). |
| **Vidlink** (`vidlink.ts`) | **UPDATED (206)** | Bare XSalsa20 token currently returns `200 null` (site added `/fu.wasm` `window.getAdv(id)`). `enc-dec.app/api/enc-vidlink?text=${tmdbId}` produces valid token returning `200` `mwVault` MP4s (`bcdn.hakunaymatata.com`) on `550` & `1399/1/1`. **Header rule:** `*.hakunaymatata.com` returns `429` with `Referer`, `428` with desktop Chrome `User-Agent`, and **`206 video/mp4` with no `Referer` and empty/non-browser `User-Agent`** (`""`, `Lavf/60.3.100`, `curl/8.0`). |
| **Hexa** (`cap.hexa.su` + `theemoviedb.hexa.su`) | **NEW — 206** | `enc-hexa` / `dec-hexa` (`enc-dec.app`). Extensionless `#EXTM3U` (`206 application/x-mpegurl`) verified on both `550` & `1399/1/1` (with or without Referer). |
| **Vidup** (`vidup.to`) | **NEW — 200** | 2-stage `enc-vidup` / `dec-vidup` (`enc-dec.app`). Extensionless `/master.m` returns `200 #EXTM3U` on `550` & `1399/1/1` with **`Referer: https://vidup.to/`** (`403` without). |
| **Cinejoy [Nebula]** (`api.wing.st`) | **NEW — 200/206** | Moved from `api.shegu.st`. `enc-cinejoy` / `dec-cinejoy`. Server `Nebula` returns `#EXTM3U` (`200`/`206` with disguised **`Content-Type: image/jpeg`**) on `550` & `1399/1/1`. (`Light`, `Lisbon`, `Orion` returned `404`.) |
| **MeowTV** (`api.meowtv.ru`) | **NEW — 206** | `POST /streams/ticket` -> `GET /streams/{movie|tv}/...?s=english` + `dec-meowtv` -> `206 #EXTM3U` on `550` & `1399/1/1`, plus `GET /subs/...` `200` VTTs (`rezesubs.com`). |
| **MovieBox** (`h5-api.aoneroom.com`) | **PARTIAL (429)** | `/wefeed-h5api-bff/subject/search` + `x-user` header token from `get-latest-app-pkgs` + `fmoviesunblocked.net` Referer yields Fight Club downloads, but `bcdnw.hakunaymatata.com` returned `429` in direct probes and "Game of Thrones" was absent from search results. |
| **PrimeSrc** (`primesrc.ts`) | **BLOCKED (403)** | `/api/v1/s` works, `/api/v1/l` gated behind Cloudflare Managed Challenge (403 HTML). Embeds available at `/embed/movie?tmdb=...` & `/embed/tv?tmdb=...`. |
| **VaPlayer** (`vaplayer.ts`) | **DEAD (403)** | `streamdata.vaplayer.ru/api.php` strips `stream_urls`; `nextgencloudfabric.com` returns `403`. |
| **VidRift** (`embeds.ts`) | **IFRAME-ONLY** | Direct GET returns `403 "Embed this page in an iframe."` (must stay embed/WebView only). |
| **VidFast** (`vidfast.vc`) / **Videasy** (`api.wecollege.net`) / **Nexa** | **BLOCKED / FAILED** | `vidfast.vc` stage1 POST returned `500` under Node `fetch` (`curl_cffi` TLS expected in upstream); `api.wecollege.net/seed` returned Cloudflare `403`; `nexa.mov` decrypted empty string. |
| **MegaPlay** (`megaplay.buzz`) | **NEW ANIME (200)** | `GET /stream/mal/${malId}/${ep}/${sub|dub}` -> `data-id` -> `/stream/getSourcesNew?id=...` -> decrypt `enc` (base64url -> AES-256-CBC, key `"i?LMTAx0Q6,:}50U"` zero-padded to 32B, IV `"W0;27ToaUpl_P%'c"`) -> `master.m3u8` + `tracks` VTTs + `intro`/`outro`. **Requires `Referer: https://megaplay.buzz/`** (`403` without; `200 #EXTM3U` & `0x47` TS segments verified on MAL `40748` sub/dub & `38000` sub). |
| **AniZone** (`anizone.ts`) | **FIXED (200)** | Search moved to Alpine `x-data="{ items: JSON.parse('...') }"`; episode pages `/anime/{slug}/{ep}` moved to `x-data="vidstackPlayer(JSON.parse('...'))"`. Returns `200 #EXTM3U` (`seiryuu.vid-cdn.xyz`, no Referer needed) + `200` `.ass` subtitles on JJK (`tcqul04r`) & Demon Slayer (`knw0pvgz`). |
| **ZokoAnime** (`zokoanime.video`) | **NEW ANIME (200)** | `GET /stream/mal/${malId}/${ep}/${sub|dub}` -> `/window\.__P\s*=\s*["']([^"']+)["']/` -> base64 decode -> bytewise XOR `"otaku-embed-v1"` -> `{ src, subtitles }`. **Requires `Referer: https://zokoanime.video/`** (`200 #EXTM3U` verified on `40748` sub [9 subs]/dub & `38000` sub). |
| **AnimeHeaven** (`animeheaven.me`) | **NEW ANIME (206)** | `search.php?s=` -> `anime.php?{id}` -> `<a id="${gateKey}">` + `.watch2` -> `gate.php` (`Cookie: key=${gateKey}`, `Referer: https://animeheaven.me/anime.php`) -> direct `.mp4` (`206 video/mp4` with or without Referer, verified on JJK & Demon Slayer). |
| **KickAssAnime** (`kickassanime.ts`) | **LIVE (200)** | `POST https://kaa.lt/api/fsearch` (skip PVs without `locales`), `/episodes`, `/episode/...` -> `VidStreaming` (`krussdomi.com/cat-player/player` `<astro-island props>` `manifest[1]`). **Requires `Referer: https://krussdomi.com/`** (`403` without; `200 #EXTM3U` on JJK & Demon Slayer). `BirdStream` (`//bl.krussdomi.com/mpd/...`) returns `404`. |
| **Anikoto** (`anikoto.ts`) | **MIRROR** | `anikototv.to` redirects to `https://anikototv.bz`. |
| **AnimeKai** (`animekai.to`) | **UNREACHABLE** | All tested mirrors (`animekai.{to,fi,fo,gs,la}`, `anikai.to`) threw `fetch failed` from current network. |
| **KissKH** (`kisskh.co`) | **LIVE (200)** | `/api/DramaList/Episode/${id}.png` returns `403` without `kkey`; `enc-dec.app/api/enc-kisskh?text=${id}&type=vid` (`&type=sub`) produces valid `kkey` -> `200 #EXTM3U` (`hls.cdnvideo11.shop`) + 5 SRT tracks (`Lovely Runner` ep 16). |
| **OneTouchTV** (`onetouchtv.ts`) | **LIVE (200)** | `api3.devcorp.me` -> `kisscloud.online` `master.m3u8` returns `200 #EXTM3U`. |

### Public Stremio HTTP-Stream Addons (Live-Probed)
- **Working Direct HTTP/HTTPS Streams:**
  - `https://cinema.debrid.in/manifest.json` (`Absolute Cinema`): Movie `tt0137523` (4 HTTP streams, MovieBox `206 video/mp4`, VixSrc) + Series `tt0944947:1:1` (6 HTTP streams, 4KHDHub `206 video/x-matroska`).
  - `https://free.flixnest.app/manifest.json` (`Flix-Streams`): Movie (6 HTTP) + Series (17 HTTP, `200/206 video/x-matroska` on live HubCloud/HubDrive mirrors; some links `500`/`502`).
  - `https://motchillv.q-1208.fun/manifest.json` (`Motchill Direct Stream`): Movie `tt0137523` (2 HTTP streams, `206 application/vnd.apple.mpegurl #EXTM3U`; Series returned 0).
  - `https://hyper.stravo.site/local/manifest.json` (`Hyper`) & `https://v2.stravo.site/local/manifest.json` (`Stravo II`): Movie `tt0137523` (`206 video/mp4` / DASH `.mpd`; Series returned `404`).
- **Dead / Deprecated / Auth-Blocked:** `webstreamr.hayd.uk` (deprecated HTML), `nuviostreams.hayd.uk` (deprecated HTML), `streamvix.hayd.uk` & `stremify.hayd.uk` (HTML guides), `nodebrid.fly.dev` & `torrentless.strem.fun` (DNS failed), `87d6a6ef6b58-webstreamrmbg.baby-beamup.club` (timeout), `addon.notorrent2.workers.dev` (timeout), `lat-add.lzid.me` (`401`), `froststream.cloutteam.com` (unauthenticated stub), `pengu.uk` (`signin.mp4` stub).

### Embed Players (`embeds.ts`) Probe Summary (TMDB `550`)
- **Timeout / Dead:** `vidsrc.cc`, `embed.su`, `frembed.uno`.
- **Verified `200` (no `X-Frame-Options` block, no CF challenge):** `https://vidsrcme.ru/embed/movie/550` (replacement for `vidsrc.cc`), `https://vidrock.net/movie/550`, `https://zxcstream.cc/player/movie/550`, `https://primesrc.me/embed/movie?tmdb=550` (`frame-ancestors *`), `https://hexa.su/watch/movie/550`, `vidlink.pro`, `vidfast.vc`, `vidnest.fun`, `vidsrc.su`, `aether.ist`, `vidsrc.to`, `vidsrc.rip`, `2embed.cc`.
