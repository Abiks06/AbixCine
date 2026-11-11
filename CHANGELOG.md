# Changelog

What changed in each AbixCine release. The newest section becomes the release notes on GitHub
and the "What's new" card in the app, so write it for people who watch things, not for developers.

## Unreleased

### Playback
- New mpv player engine. It plays almost anything (MKV, HEVC, AV1, DTS, TrueHD, ASS subtitles, HDR) at full quality, inside the AbixCine window. The built-in player is still there, and AbixCine switches to mpv by itself when a file won't play.
- Choose the audio track, and pick the player per video from the player menu.
- Skip intro, recap and credits buttons, with an option to skip them automatically. Anime uses AniSkip timings; other files use their chapters.
- Jellyfin plays files directly at original quality, with surround sound, instead of always converting them.

### Library
- Full watch history: every episode you play, grouped by day, with Resume and Watch again.
- Mark episodes, seasons or whole shows as watched.
- Anime seasons and sequels are linked: a "Watch order" strip on each show, and Up next carries on into the next season.
- Smarter matching: TMDB, IMDb, TVDB and AniList IDs in file names and Jellyfin are used, and anime no longer shows up twice in search.

### Accounts
- Sign in with Google or Discord.
- Forgot password, email verification and changing your password.

### Updates and alerts
- AbixCine updates itself: it downloads new versions in the background and installs them on restart. Settings › Updates has the changelog.
- New-episode alerts for shows in My List and Continue watching, in the bell menu and as Windows notifications.

## 0.1.0
- First version.
