# AbixCine

A Windows desktop app for movies, series and anime. Tauri 2 (Rust) shell, React + TypeScript UI, and a small accounts API (`server/`) for Render.

## What's inside

- **Accounts from day one.** Sign up / sign in; watch progress, My List and playback preferences sync to your account. Library folders stay on each PC.
- **Catalog.** TMDB for movies and series (through your AbixCine server, or your own key), AniList for anime. Cached so browsing is instant.
- **Anime is one entry.** Each show has a Sub/Dub switch on its page, in the player, and as a default in Settings. Files tagged `Dub` / `Dual Audio` are matched to Dub.
- **Sources.** Local folders first. External servers (Jellyfin today) are an optional add-on, and new ones plug in through `src/sources/`. Every source is queried in parallel, probed for speed and resolution, ranked, and the player fails over to the next if one drops.
- **Two players.** The built-in player (hls.js) for streams, and mpv for everything else: MKV, HEVC, AV1, DTS/TrueHD, ASS subtitles and HDR at full quality, drawn inside the app window. Auto mode switches to mpv when a file won't play. Release builds bundle mpv; dev builds use one on PATH or set in Settings.
- **History and alerts.** Every episode you play is kept in History and synced. Shows in My List and Continue watching raise an alert when a new episode or season airs.
- **Updates.** Release builds update themselves from GitHub Releases. See [docs/releases.md](docs/releases.md).
- **Design.** Floating pill nav, launch intro, page morphs (View Transitions), ambient color from the featured artwork, Top 10 shelves, cinematic loading screen, Ctrl+K command palette.

## Run it locally (Windows)

Two terminals in this folder:

```powershell
# 1. accounts API (embedded database, nothing else to install)
cd server
npm install
npm run local          # http://localhost:8787

# 2. the app
npm install
npm run tauri dev
```

Optional: put `TMDB_KEY=...` in `server/.env` so everyone signed in gets the real catalog without their own key.

## Deploy the API to Render

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. `render.yaml` creates the web service and a Postgres database, and generates `JWT_SECRET`.
3. Set `TMDB_KEY` on the service (optional).
   - Email codes (verification, password reset): `RESEND_API_KEY` and `MAIL_FROM` from [Resend](https://resend.com). Without them, production hides those features.
   - Sign in with Google: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, redirect URI `https://abixcine-api.onrender.com/auth/oauth/google/callback`.
   - Sign in with Discord: `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`, redirect URI `https://abixcine-api.onrender.com/auth/oauth/discord/callback`.
4. The app talks to `https://abixcine-api.onrender.com` by default. To use another server, click **Server** on the sign-in screen, or build with `VITE_API_URL` set (e.g. `http://localhost:8787` for the local API).

Notes on Render's free plan: the web service sleeps after 15 minutes idle (first request then takes ~1 minute). `.github/workflows/keepalive.yml` keeps it awake from 05:00 to 23:00 UTC. Free Postgres databases expire 30 days after they're created, so move to a paid database (Basic, about $6 a month) before then or the accounts data is deleted.

## Build an installer

```powershell
npm run tauri build    # → src-tauri/target/release/bundle/{nsis,msi}/
```

Published releases are built by GitHub Actions, signed, and picked up by the in-app updater: [docs/releases.md](docs/releases.md).

## API

`POST /auth/signup|login|refresh|logout|forgot|reset|verify|verify/send|password`, `POST /auth/oauth/:provider/start`, `POST /auth/oauth/poll`, `GET|PATCH|DELETE /me`, `GET /sync`, `PUT|DELETE /progress/:key`, `PUT|DELETE /history/:key`, `GET /idmap/anilist/:id`, `GET /idmap/tmdb`, `PUT|DELETE /watchlist/:key`, `PUT /settings`, `GET /tmdb/*` (allow-listed TMDB proxy), `GET /health`.
Passwords are bcrypt-hashed; access tokens are 15-minute JWTs; refresh tokens are opaque, stored hashed, rotated on every use, and reuse of an old one revokes the session family.

Tests: `cd server && npm test` (uses the embedded database unless `DATABASE_URL` is set).

## Adding a source

Implement `SourceProvider` (`src/sources/types.ts`) and add it to `PROVIDERS` in `src/sources/registry.ts`. Set `category: "external"` for anything that isn't on this PC.

Watch links (`?t=12:34&speed=1.25&provider=jellyfin&controls=0`), the player command and event bus, tiers, health and fallback are documented in [docs/player-and-plugins.md](docs/player-and-plugins.md).
