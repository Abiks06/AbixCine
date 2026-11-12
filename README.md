# AbixCine

A Windows desktop app for movies, series and anime. Tauri 2 (Rust) shell, React + TypeScript UI, and a small accounts API (`server/`) for Render.

## What's inside

- **Accounts from day one.** Sign up / sign in; watch progress, My List and playback preferences sync to your account. Library folders stay on each PC.
- **Catalog.** TMDB for movies and series (through your AbixCine server, or your own key), AniList for anime. Cached so browsing is instant.
- **Anime is one entry.** Each show has a Sub/Dub switch on its page, in the player, and as a default in Settings. Files tagged `Dub` / `Dual Audio` are matched to Dub.
- **Sources.** Local folders first. Unsupported local audio/container formats are prepared with the bundled LGPL FFmpeg tools and cached for playback; no separate FFmpeg install is required. External servers (Jellyfin today) are an optional add-on, and new ones plug in through `src/sources/`. Every source is queried in parallel, probed for speed and resolution, ranked, and the player fails over to the next if one drops.
- **Design.** Floating pill nav, launch intro, page morphs (View Transitions), ambient color from the featured artwork, Top 10 shelves that rise in as you scroll, cinematic loading screen, undoable toasts.
- **Search.** Ctrl+K or `/` opens the command palette from anywhere (Ctrl+Enter plays a result straight away). Both catalogs are searched at once, a typo is forgiven ("jujutu kaisen"), and a trailing year narrows it ("Dune 2021").
- **Player.** Press `?` for every shortcut: 0–9 to jump, Shift+arrows for 30s, mouse wheel for volume, `<` `>` for speed, `P` for picture-in-picture. Hardware media keys work, and intro/credits are marked on the timeline when the server knows them.

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

The Tauri dev and release commands prepare a pinned, checksum-verified LGPL FFmpeg build in
`src-tauri/resources/ffmpeg`. Local files that need audio/container compatibility are converted
to cached MP4 copies on first play; the original video stream is copied and audio is converted to AAC.
The installer includes FFmpeg and its license notice, so end users do not need to install it separately.

Optional: put `TMDB_KEY=...` in `server/.env` so everyone signed in gets the real catalog without their own key.

## Deploy the API to Render

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. `render.yaml` creates the web service and a Postgres database, and generates `JWT_SECRET`.
3. Set `TMDB_KEY` on the service (optional).
4. The app talks to `https://abixcine-api.onrender.com` by default. To use another server, click **Server** on the sign-in screen, or build with `VITE_API_URL` set (e.g. `http://localhost:8787` for the local API).

Notes on Render's free plan: the web service sleeps after 15 minutes idle (first request then takes ~1 minute), and free Postgres databases expire after 30 days. The paid starter tiers remove both.

## Install, release and updates

**Install:** download `AbixCine_<version>_x64-setup.exe` from the [latest release](https://github.com/Abiks06/AbixCine/releases/latest) and run it. It installs per-user (no admin prompt), adds Start menu and desktop shortcuts, and fetches the WebView2 runtime if the PC lacks it.

**Updates:** the app checks the latest GitHub release on launch and every six hours. When a newer signed build exists, a prompt offers *Update and restart*; Settings → About has a manual check. Updates are verified against the public key in `src-tauri/tauri.conf.json`, so only builds signed with the project key install.

**Build locally** (signed, with the updater artifacts):

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME/.tauri/abixcine.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Get-Content -Raw "$HOME/.tauri/abixcine.key.password"
npm run package        # → src-tauri/target/release/bundle/nsis/AbixCine_<version>_x64-setup.exe (+ .sig)
```

**Publish a release** (GitHub Actions builds, signs and uploads it, including `latest.json` for the updater):

```powershell
npm run version:bump -- 1.0.1
cd src-tauri; cargo check; cd ..        # refreshes Cargo.lock
git commit -am "v1.0.1"; git tag v1.0.1; git push; git push --tags
```

The workflow needs two repository secrets: `TAURI_SIGNING_PRIVATE_KEY` (the contents of `~/.tauri/abixcine.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep the key safe: losing it means existing installs can't verify future updates.

## API

`POST /auth/signup|login|refresh|logout`, `GET|PATCH|DELETE /me`, `GET /sync`, `PUT|DELETE /progress/:key`, `PUT|DELETE /watchlist/:key`, `PUT /settings`, `GET /tmdb/*` (allow-listed TMDB proxy), `GET /health`.
Passwords are bcrypt-hashed; access tokens are 15-minute JWTs; refresh tokens are opaque, stored hashed, rotated on every use, and reuse of an old one revokes the session family.

Tests: `cd server && npm test` (uses the embedded database unless `DATABASE_URL` is set).

## Picture enhancement

The player's Picture panel runs [Anime4K](https://github.com/bloc97/Anime4K) through its WebGPU port on streams AbixCine decodes itself (local files, Jellyfin, direct links): Clarity for films and series, Modes A/B/C and A+A for anime. Online servers play in their own cross-origin player, so they get a colour/contrast "Vivid" look instead.

## Adding a source

Implement `SourceProvider` (`src/sources/types.ts`) and add it to `PROVIDERS` in `src/sources/registry.ts`. Set `category: "external"` for anything that isn't on this PC.
