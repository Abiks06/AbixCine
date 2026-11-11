# Releases and app updates

AbixCine updates itself. Each release is a signed Windows installer on GitHub Releases, plus a
`latest.json` that the app reads every 6 hours (and on Settings › Updates › Check now). When a
newer version is out, the app downloads it in the background, shows "AbixCine 0.x is ready", and
installs on restart. After the restart it shows that version's notes once.

The updater only installs files signed with the project's private key. The matching public key is
baked into release builds, so a tampered download is refused.

## One-time setup

1. Make a signing key on your PC (keep the password; you can't recover it):

   ```powershell
   npx tauri signer generate -w $HOME\.tauri\abixcine.key
   ```

   This writes `abixcine.key` (private, never commit it or share it) and `abixcine.key.pub`.
   Back both up somewhere safe. If the private key is lost, installed copies can't be updated
   any more and people have to reinstall by hand.

2. In GitHub: **Settings › Secrets and variables › Actions**
   - **Secrets** tab → `TAURI_SIGNING_PRIVATE_KEY`: the whole contents of `abixcine.key`
   - **Secrets** tab → `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password you chose
   - **Variables** tab → `TAURI_UPDATER_PUBKEY`: the whole contents of `abixcine.key.pub`

The release workflow stops with a clear error until all three are set.

## Shipping a release

1. Add what changed under `## Unreleased` in `CHANGELOG.md`. Write it for viewers: it becomes the
   GitHub release notes and the in-app "What's new" card.
2. `npm run release -- 0.2.0` sets the version in `package.json`, `tauri.conf.json` and
   `Cargo.toml`, and moves the Unreleased notes under `## 0.2.0 (date)`.
3. Commit, tag and push:

   ```powershell
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push; git push origin v0.2.0
   ```

`.github/workflows/release.yml` then builds on Windows, bundles mpv, signs, and publishes the
release with `latest.json`. A tag with a dash (`v0.3.0-beta.1`) is published as a pre-release,
which the updater skips.

## Builds without a key

`npm run tauri build` on your PC has no public key, so that build can't install updates. It still
checks GitHub for newer releases and offers a "Get it" button that opens the download page.

## Other workflows

- `ci.yml` runs on pull requests: type check, web build, Vitest, server tests, and `cargo test`
  on Windows.
- `keepalive.yml` pings the Render API every 10 minutes from 05:00 to 23:00 UTC so it doesn't
  fall asleep during the day, while staying inside the free plan's monthly hours.
