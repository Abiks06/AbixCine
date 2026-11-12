import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archiveName = "ffmpeg-n8.1.3-35-gf1acb0a266-win64-lgpl-shared-8.1.zip";
const archiveUrl = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-11-11-12-39/${archiveName}`;
const archiveSha256 = "f7697c270197c04bf72759c65ada64fcaea663bcb80767c390752d2412ea2dcf";
const licenseSha256 = "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118";
const sourceUrl = "https://github.com/FFmpeg/FFmpeg/tree/n8.1.3";
const cacheDir = path.join(root, "node_modules", ".cache", "abixcine-ffmpeg");
const archivePath = path.join(cacheDir, archiveName);
const targetDir = path.join(root, "src-tauri", "resources", "ffmpeg");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The bundled FFmpeg build currently supports Windows x64 only.");
}

await mkdir(cacheDir, { recursive: true });

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
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

  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(targetDir)) {
    if (entry !== ".keep") await rm(path.join(targetDir, entry), { recursive: true, force: true });
  }
  for (const file of [...executables, ...libraries]) {
    await copyFile(file, path.join(targetDir, path.basename(file)));
  }

  const licenseUrl = "https://www.gnu.org/licenses/lgpl-3.0.txt";
  const licensePath = path.join(targetDir, "COPYING.LGPLv3");
  execFileSync(
    "curl.exe",
    ["--fail", "--location", "--retry", "5", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "30", "--output", licensePath, licenseUrl],
    { stdio: "inherit" },
  );
  if ((await sha256(licensePath)) !== licenseSha256) {
    throw new Error("The LGPLv3 text checksum did not match the pinned license.");
  }
  await writeFile(
    path.join(targetDir, "NOTICE.txt"),
    `AbixCine bundles FFmpeg 8.1.3 (LGPL shared build) from BtbN/FFmpeg-Builds.\n` +
      `FFmpeg source: ${sourceUrl}\n` +
      `Build archive: ${archiveUrl}\n` +
      "The bundled FFmpeg programs and libraries are licensed under LGPL version 3 or later; see COPYING.LGPLv3.\n",
    "utf8",
  );
  await access(path.join(targetDir, "ffmpeg.exe"));
  console.log("Prepared the pinned LGPL FFmpeg tools and runtime libraries.");
} finally {
  await rm(workDir, { recursive: true, force: true });
}
