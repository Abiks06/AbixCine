// Prints the CHANGELOG.md section for one version (used as the GitHub release body).
// Usage: node scripts/release-notes.mjs 0.2.0
import { readFileSync } from "node:fs";

const version = process.argv[2];
const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = md.split(/\r?\n/);
const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`).test(l));
if (start < 0) {
  console.log(`AbixCine ${version}`);
} else {
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  console.log(lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim());
}
