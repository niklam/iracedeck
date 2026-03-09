import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node release-hooks.mjs <version>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

// Bump version in all packages/*/package.json
const packageJsonPaths = [
  "packages/logger/package.json",
  "packages/iracing-native/package.json",
  "packages/iracing-sdk/package.json",
  "packages/stream-deck-plugin/package.json",
  "packages/website/package.json",
];

for (const rel of packageJsonPaths) {
  const filePath = join(root, rel);
  const pkg = JSON.parse(readFileSync(filePath, "utf-8"));
  pkg.version = version;
  writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${version}`);
}

// Bump Version in Stream Deck manifest.json (4-part format: x.y.z.0)
const manifestPath = join(
  root,
  "packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
manifest.Version = `${version}.0`;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`  Updated manifest.json → ${version}.0`);

// Stage all modified files
const allPaths = [
  ...packageJsonPaths,
  "packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json",
];
execSync(`git add ${allPaths.join(" ")}`, { cwd: root, stdio: "inherit" });
