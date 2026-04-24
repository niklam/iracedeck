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
  "packages/iracing-actions/package.json",
  "packages/deck-adapter-elgato/package.json",
  "packages/deck-adapter-mirabox/package.json",
  "packages/deck-core/package.json",
  "packages/icons/package.json",
  "packages/iracing-native/package.json",
  "packages/iracing-sdk/package.json",
  "packages/logger/package.json",
  "packages/iracing-plugin-stream-deck/package.json",
  "packages/iracing-plugin-mirabox/package.json",
  "packages/website/package.json",
];

for (const rel of packageJsonPaths) {
  const filePath = join(root, rel);
  const pkg = JSON.parse(readFileSync(filePath, "utf-8"));
  pkg.version = version;
  writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${version}`);
}

// Bump Version in manifest.json files. Elgato's manifest schema requires a
// strict 4-part numeric format `{major}.{minor}.{patch}.{build}`
// (^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$), so semver pre-release / build metadata
// suffixes must be stripped. Every 1.15.0 pre-release and the final 1.15.0
// therefore ship with the same manifest Version "1.15.0.0".
const manifestPaths = [
  "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json",
  "packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/manifest.json",
];

const numericVersion = version.replace(/[-+].*$/, "");

for (const rel of manifestPaths) {
  const filePath = join(root, rel);
  const manifest = JSON.parse(readFileSync(filePath, "utf-8"));
  manifest.Version = `${numericVersion}.0`;
  writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${numericVersion}.0`);
}

// Stage all modified files
const allPaths = [...packageJsonPaths, ...manifestPaths];
execSync(`git add ${allPaths.join(" ")}`, { cwd: root, stdio: "inherit" });
