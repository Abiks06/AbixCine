import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Pin an end-of-month BtbN autobuild: daily mid-month releases are pruned after ~14 days,
// while last-day-of-month archives are retained long-term.
const archiveName = "ffmpeg-n8.1.3-27-g8dca1586f4-win64-lgpl-shared-8.1.zip";
const archiveUrl = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/${archiveName}`;
const archiveSha256 = "5cef7bc48e513f3cee7c881e8b2999d835541edb1846c3e89443a67f8f8556ab";
const licenseSha256 = "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118";
const sourceUrl = "https://github.com/FFmpeg/FFmpeg/tree/n8.1.3";
const cacheDir = path.join(root, "node_modules", ".cache", "abixcine-ffmpeg");
const archivePath = path.join(cacheDir, archiveName);
const targetDir = path.join(root, "src-tauri", "resources", "ffmpeg");

if (process.platform !== "win32" || process.arch !== "x64") {
  // Not fatal: the app falls back to an FFmpeg on PATH. Builds elsewhere just skip bundling.
  console.warn("Skipping bundled FFmpeg: the pinned build is Windows x64 only (the app will use FFmpeg from PATH).");
  process.exit(0);
}

await mkdir(cacheDir, { recursive: true });

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

const licenseCache = path.join(cacheDir, "COPYING.LGPLv3");
const stampPath = path.join(targetDir, ".prepared");
const stamp = `${archiveSha256}\n`;

// Already prepared from this exact archive: nothing to do (this used to re-extract on every start).
try {
  if ((await readFile(stampPath, "utf8")) === stamp) {
    await access(path.join(targetDir, "ffmpeg.exe"));
    await access(path.join(targetDir, "ffprobe.exe"));
    console.log("Bundled FFmpeg is already prepared.");
    process.exit(0);
  }
} catch {
  // Not prepared yet, or incomplete: build it below.
}

let archiveReady = false;
try {
  archiveReady = (await sha256(archivePath)) === archiveSha256;
} catch {
  // Download the pinned archive below.
}

if (!archiveReady) {
  const temporaryArchive = `${archivePath}.download`;
  execFileSync(
    "curl.exe",
    ["--fail", "--location", "--continue-at", "-", "--retry", "5", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "30", "--output", temporaryArchive, archiveUrl],
    { stdio: "inherit" },
  );
  if ((await sha256(temporaryArchive)) !== archiveSha256) {
    await rm(temporaryArchive, { force: true });
    throw new Error("The FFmpeg archive checksum did not match the pinned build.");
  }
  await rm(archivePath, { force: true });
  await rename(temporaryArchive, archivePath);
}

const workDir = await mkdtemp(path.join(tmpdir(), "abixcine-ffmpeg-"));
try {
  const extractionDir = path.join(workDir, "unpacked");
  await mkdir(extractionDir);
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const script = `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(extractionDir)} -Force`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "inherit" });

  const allFiles = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else allFiles.push(file);
    }
  }
  await visit(extractionDir);

  const ffmpeg = allFiles.find((file) => path.basename(file).toLowerCase() === "ffmpeg.exe");
  const ffprobe = allFiles.find((file) => path.basename(file).toLowerCase() === "ffprobe.exe");
  if (!ffmpeg || !ffprobe) throw new Error("The FFmpeg archive is missing ffmpeg.exe or ffprobe.exe.");
  const binDir = path.dirname(ffmpeg);
  const executables = [ffmpeg, ffprobe];
  const libraries = allFiles.filter((file) => path.dirname(file) === binDir && path.extname(file).toLowerCase() === ".dll");

  // Everything that can fail (the license download included) happens before the working copy
  // is touched: running this offline used to delete a good FFmpeg and then fail to replace it.
  let licenseOk = false;
  try {
    licenseOk = (await sha256(licenseCache)) === licenseSha256;
  } catch {
    /* not cached yet */
  }
  if (!licenseOk) {
    const licenseUrl = "https://www.gnu.org/licenses/lgpl-3.0.txt";
    const pending = `${licenseCache}.download`;
    execFileSync(
      "curl.exe",
      ["--fail", "--location", "--retry", "5", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "30", "--output", pending, licenseUrl],
      { stdio: "inherit" },
    );
    if ((await sha256(pending)) !== licenseSha256) {
      await rm(pending, { force: true });
      throw new Error("The LGPLv3 text checksum did not match the pinned license.");
    }
    await rm(licenseCache, { force: true });
    await rename(pending, licenseCache);
  }

  // Assemble the new folder next to the old one, then swap them.
  const staging = `${targetDir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, ".keep"), "");
  for (const file of [...executables, ...libraries]) {
    await copyFile(file, path.join(staging, path.basename(file)));
  }
  await copyFile(licenseCache, path.join(staging, "COPYING.LGPLv3"));
  await writeFile(
    path.join(staging, "NOTICE.txt"),
    `AbixCine bundles FFmpeg 8.1.3 (LGPL shared build) from BtbN/FFmpeg-Builds.\n` +
      `FFmpeg source: ${sourceUrl}\n` +
      `Build archive: ${archiveUrl}\n` +
      "The bundled FFmpeg programs and libraries are licensed under LGPL version 3 or later; see COPYING.LGPLv3.\n",
    "utf8",
  );
  await writeFile(path.join(staging, ".prepared"), stamp);
  const previous = `${targetDir}.previous`;
  await rm(previous, { recursive: true, force: true });
  try {
    await rename(targetDir, previous);
  } catch {
    /* no previous copy */
  }
  await rename(staging, targetDir);
  await rm(previous, { recursive: true, force: true });
  await access(path.join(targetDir, "ffmpeg.exe"));
  console.log("Prepared the pinned LGPL FFmpeg tools and runtime libraries.");
} finally {
  await rm(workDir, { recursive: true, force: true });
}
