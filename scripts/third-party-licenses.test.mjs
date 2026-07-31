import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allPluginManifestRelPaths } from "./lib/version-discovery.mjs";

// scripts/third-party-licenses.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const NOTICES_FILE = "THIRD-PARTY-LICENSES.md";

/**
 * [plugin package dir, shipped artifact folder name] pairs, discovered from the
 * committed plugin manifests (the same source the release bump uses) so a new
 * deck ecosystem is covered automatically instead of needing to be added to a
 * parallel hardcoded list here.
 */
const PLUGINS = allPluginManifestRelPaths(repoRoot).map((relPath) => {
  const [, pkg, artifact] = relPath.split("/");
  return [pkg, artifact];
});

/**
 * Third-party components that ship inside plugin artifacts without a license
 * text of their own in the artifact (vendored sources compiled into the native
 * addons, dependencies bundled into bin/plugin.js, vendored browser assets,
 * fonts, and data). Not every entry ships in every artifact (e.g.
 * @elgato/streamdeck is Elgato-only), but each must have a section in
 * THIRD-PARTY-LICENSES.md. The list is hand-maintained: when a new third-party
 * component is bundled (rather than added to a rollup `external` array, which
 * is checked automatically below), add it here and to the notices file.
 */
const VENDORED_COMPONENTS = [
  "iRacing SDK",
  "miniaudio",
  "node-addon-api",
  "sdpi-components",
  "Lit",
  "zod",
  "semver",
  "@elgato/streamdeck",
  "Arimo",
  "Lovely Sim Racing",
];

const notices = readFileSync(join(repoRoot, NOTICES_FILE), "utf-8");

/** Extract the package names from a rollup config's `external: [...]` array. */
function rollupExternals(configSource) {
  const match = configSource.match(/external:\s*\[([^\]]*)\]/);
  expect(match, "rollup config must declare an external array").not.toBeNull();
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/**
 * A `## <name>` section heading in the notices file, anchored so incidental
 * substrings elsewhere in the document (e.g. "ws" inside "Windows") can never
 * satisfy the check. `\b` (not `$`) so descriptive heading suffixes like
 * "## Arimo fonts" still match their component name.
 */
function noticesSectionPattern(name) {
  return new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m");
}

/**
 * Whether a single .sdignore pattern line matches a file at the artifact root.
 * Supports the pattern shapes the .sdignore files actually use: exact names,
 * `*.ext` globs, an optional leading double-star-slash prefix, and directory
 * patterns (trailing `/`, which can never match a file).
 */
function sdignorePatternMatchesRootFile(pattern, fileName) {
  if (pattern.endsWith("/")) return false; // directory pattern
  const stripped = pattern.replace(/^\*\*\//, "");
  if (stripped.includes("/")) return false; // nested path — cannot match a root-level file
  const regex = new RegExp(`^${stripped.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  return regex.test(fileName);
}

describe("shipped license files (#905)", () => {
  it("the repo root has LICENSE and THIRD-PARTY-LICENSES.md", () => {
    expect(existsSync(join(repoRoot, "LICENSE"))).toBe(true);
    expect(existsSync(join(repoRoot, NOTICES_FILE))).toBe(true);
  });

  it("discovers every plugin artifact (an empty list would silently skip all per-plugin checks)", () => {
    expect(PLUGINS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(VENDORED_COMPONENTS)("THIRD-PARTY-LICENSES.md covers vendored/bundled component: %s", (component) => {
    expect(notices).toMatch(noticesSectionPattern(component));
  });

  describe.each(PLUGINS)("%s", (pkg, artifact) => {
    const configPath = join(repoRoot, "packages", pkg, "rollup.config.mjs");
    const configSource = readFileSync(configPath, "utf-8");

    it("every non-workspace rollup external has an entry in THIRD-PARTY-LICENSES.md", () => {
      const thirdParty = rollupExternals(configSource).filter((name) => !name.startsWith("@iracedeck/"));
      expect(thirdParty.length).toBeGreaterThan(0);
      for (const name of thirdParty) {
        expect(notices, `missing ${NOTICES_FILE} section for rollup external "${name}" (${pkg})`).toMatch(
          noticesSectionPattern(name),
        );
      }
    });

    it("the rollup config copies LICENSE and THIRD-PARTY-LICENSES.md into the artifact", () => {
      expect(configSource).toContain("copy-license-files");
      expect(configSource).toContain(`"${NOTICES_FILE}"`);
      expect(configSource).toContain('"LICENSE"');
    });

    it(".sdignore does not strip the license files from the packed plugin", () => {
      const sdignore = readFileSync(join(repoRoot, "packages", pkg, artifact, ".sdignore"), "utf-8");
      const patterns = sdignore
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      for (const pattern of patterns) {
        for (const file of ["LICENSE", NOTICES_FILE]) {
          expect(
            sdignorePatternMatchesRootFile(pattern, file),
            `.sdignore pattern "${pattern}" (${pkg}) would exclude ${file}`,
          ).toBe(false);
        }
      }
    });
  });
});
