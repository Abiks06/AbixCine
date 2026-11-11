#!/usr/bin/env node
// Keep the app version identical in package.json, tauri.conf.json and Cargo.toml.
//   node scripts/bump-version.mjs 1.0.1          set the version everywhere
//   node scripts/bump-version.mjs --check 1.0.1  fail unless all three already say 1.0.1 (used by CI)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args[0] === "--check";
const version = check ? args[1] : args[0];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bump-version.mjs [--check] <major.minor.patch>");
  process.exit(1);
}

const files = {
  "package.json": {
    get: (s) => JSON.parse(s).version,
    set: (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  "src-tauri/tauri.conf.json": {
    get: (s) => JSON.parse(s).version,
    set: (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  "src-tauri/Cargo.toml": {
    get: (s) => s.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1],
    set: (s) => s.replace(/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${version}$2`),
  },
};

let bad = 0;
for (const [rel, f] of Object.entries(files)) {
  const p = join(root, rel);
  const src = readFileSync(p, "utf8");
  const cur = f.get(src);
  if (check) {
    if (cur !== version) {
      console.error(`${rel} is ${cur}, expected ${version}`);
      bad++;
    }
  } else {
    writeFileSync(p, f.set(src));
    console.log(`${rel}: ${cur} -> ${version}`);
  }
}
if (bad) process.exit(1);
if (!check) console.log("\nNext: update Cargo.lock (cargo check), commit, then tag v" + version + " and push the tag.");
