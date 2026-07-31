import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// scripts/third-party-licenses.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const NOTICES_FILE = "THIRD-PARTY-LICENSES.md";

/** Plugin package dir → shipped artifact folder name. */
const PLUGINS = [
  ["iracing-plugin-stream-deck", "com.iracedeck.sd.core.sdPlugin"],
  ["iracing-plugin-mirabox", "com.iracedeck.sd.core.sdPlugin"],
  ["iracing-plugin-ulanzi", "com.ulanzi.iracedeck.ulanziPlugin"],
];

/**
 * Third-party components that ship inside every artifact without carrying a
 * license text of their own (vendored sources compiled into the native addons,
 * dependencies bundled into bin/plugin.js, vendored browser assets, fonts, and
 * data). Each must have an entry in THIRD-PARTY-LICENSES.md.
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

  it.each(VENDORED_COMPONENTS)("THIRD-PARTY-LICENSES.md covers vendored/bundled component: %s", (component) => {
    expect(notices).toContain(component);
  });

  describe.each(PLUGINS)("%s", (pkg, artifact) => {
    const configPath = join(repoRoot, "packages", pkg, "rollup.config.mjs");
    const configSource = readFileSync(configPath, "utf-8");

    it("every non-workspace rollup external has an entry in THIRD-PARTY-LICENSES.md", () => {
      const thirdParty = rollupExternals(configSource).filter((name) => !name.startsWith("@iracedeck/"));
      expect(thirdParty.length).toBeGreaterThan(0);
      for (const name of thirdParty) {
        expect(notices, `missing ${NOTICES_FILE} entry for rollup external "${name}" (${pkg})`).toContain(name);
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
