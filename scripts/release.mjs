// Bump the app version everywhere and date the changelog's "Unreleased" section.
// Usage: npm run release -- 0.2.0   then commit, tag v0.2.0 and push the tag.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version ?? "")) {
  console.error("Usage: npm run release -- <version>   e.g. 0.2.0 or 0.3.0-beta.1");
  process.exit(1);
}
const at = (p) => new URL(`../${p}`, import.meta.url);
const edit = (p, fn) => writeFileSync(at(p), fn(readFileSync(at(p), "utf8")));

edit("package.json", (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit("src-tauri/Cargo.toml", (s) => s.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`));
edit("CHANGELOG.md", (s) => {
  if (new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b`, "m").test(s)) return s;
  const today = new Date().toISOString().slice(0, 10);
  if (!/^## Unreleased/m.test(s)) throw new Error("CHANGELOG.md has no '## Unreleased' section to release.");
  return s.replace(/^## Unreleased.*$/m, `## Unreleased\n\n## ${version} (${today})`);
});

console.log(`Version set to ${version}. Next:
  git commit -am "Release ${version}" && git tag v${version} && git push && git push origin v${version}`);
