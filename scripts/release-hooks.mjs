import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node release-hooks.mjs <version>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

// Packages that intentionally track their own versions and must NOT be bumped
// by the release process. Empty today — add the package name here if a
// package ever decouples from the monorepo's shared version.
const SKIPPED_PACKAGES = new Set();

// Discover every workspace package under packages/* that declares a `version`.
// Replaces the previous hardcoded list which silently skipped new packages
// (see issue #435 — eight packages had drifted multiple minors behind because
// they were never added to the static array).
const packagesDir = join(root, "packages");
const packageJsonPaths = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}/package.json`)
  .filter((rel) => {
    const filePath = join(root, rel);
    if (!existsSync(filePath)) return false;
    const pkg = JSON.parse(readFileSync(filePath, "utf-8"));
    if (!pkg.version) return false;
    if (SKIPPED_PACKAGES.has(pkg.name)) {
      console.log(`  Skipping ${pkg.name} (opted out via SKIPPED_PACKAGES)`);
      return false;
    }
    return true;
  })
  .sort();

// Bump Version in manifest.json files. Discovered dynamically — the same way as
// the package.json files above — rather than a hardcoded list: scan every
// `packages/*/<plugin-folder>/manifest.json` that declares a `Version`. The old
// static array silently skipped the Ulanzi plugin's manifest (it stayed at
// 1.22.0.0 while the others advanced), exactly the drift issue #435 fixed for
// package.json; auto-discovery picks up any current or future plugin manifest
// (`.sdPlugin` / `.ulanziPlugin`) automatically.
//
// Elgato's manifest schema requires a strict 4-part numeric format
// `{major}.{minor}.{patch}.{build}` (^(0|[1-9]\d*)(\.(0|[1-9]\d*)){3}$), so
// semver pre-release / build metadata suffixes must be stripped. The build slot
// is populated from `git rev-list --count HEAD` so each release (pre or final
// alike) gets a unique 4-part version; the final naturally outranks its
// preceding pre-releases because release-it commits the version bump between
// runs, which advances the commit count.
const manifestPaths = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((pkgEntry) => {
    const pkgDir = join(packagesDir, pkgEntry.name);
    return readdirSync(pkgDir, { withFileTypes: true })
      .filter((sub) => sub.isDirectory())
      .map((sub) => `packages/${pkgEntry.name}/${sub.name}/manifest.json`);
  })
  .filter((rel) => {
    const filePath = join(root, rel);
    if (!existsSync(filePath)) return false;
    try {
      const manifest = JSON.parse(readFileSync(filePath, "utf-8"));
      return typeof manifest.Version === "string";
    } catch {
      return false;
    }
  })
  .sort();

const numericVersion = version.replace(/[-+].*$/, "");
const buildNumber = execFileSync("git", ["rev-list", "--count", "HEAD"], {
  cwd: root,
  encoding: "utf-8",
}).trim();
const manifestVersion = `${numericVersion}.${buildNumber}`;

// release-it runs before:bump hooks even in dry-run mode, which would otherwise
// modify real package.json / manifest.json files and stage them with `git add`.
// `scripts/release.mjs` sets RELEASE_IT_DRY_RUN=1 when --dry-run is passed.
if (process.env.RELEASE_IT_DRY_RUN === "1") {
  console.log(`  [dry-run] Would bump ${packageJsonPaths.length} package.json files to version ${version}:`);
  for (const rel of packageJsonPaths) console.log(`    - ${rel}`);
  console.log(`  [dry-run] Would bump ${manifestPaths.length} manifest.json files to version ${manifestVersion}:`);
  for (const rel of manifestPaths) console.log(`    - ${rel}`);
  process.exit(0);
}

for (const rel of packageJsonPaths) {
  const filePath = join(root, rel);
  const pkg = JSON.parse(readFileSync(filePath, "utf-8"));
  pkg.version = version;
  writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${version}`);
}

for (const rel of manifestPaths) {
  const filePath = join(root, rel);
  const manifest = JSON.parse(readFileSync(filePath, "utf-8"));
  manifest.Version = manifestVersion;
  writeFileSync(filePath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`  Updated ${rel} → ${manifestVersion}`);
}

// Stage all modified files. Use argv form (no shell) so package directory
// names containing spaces or shell metacharacters can't break or inject into
// the git invocation.
const allPaths = [...packageJsonPaths, ...manifestPaths];
execFileSync("git", ["add", "--", ...allPaths], { cwd: root, stdio: "inherit" });
