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
 * Every third-party component shipped in the plugin artifacts → a distinctive
 * phrase from its license notice that must appear inside the component's
 * `## <name>` section of THIRD-PARTY-LICENSES.md, so an empty or mislabeled
 * section fails the guard, not just a missing heading. Covers the rollup
 * `external` dependencies (cross-checked against this map below) and the
 * vendored/bundled components (sources compiled into the native addons,
 * dependencies bundled into bin/plugin.js, vendored browser assets, fonts, and
 * data). Not every entry ships in every artifact (e.g. @elgato/streamdeck is
 * Elgato-only). The map is hand-maintained: when a new third-party component
 * is shipped, add it here and to the notices file.
 */
const COMPONENT_LICENSE_MARKERS = {
  "iRacing SDK": "Redistribution and use in source and binary forms",
  miniaudio: "MIT No Attribution",
  "@resvg/resvg-js": "Mozilla Public License",
  keysender: "MIT License",
  yaml: "Permission to use, copy, modify, and/or distribute this software",
  ws: "Permission is hereby granted, free of charge",
  "node-addon-api": "The MIT License (MIT)",
  zod: "MIT License",
  semver: "The ISC License",
  "@elgato/streamdeck": "MIT License",
  "sdpi-components": "MIT License",
  Lit: "BSD 3-Clause License",
  Arimo: "SIL Open Font License",
  "Lovely Sim Racing": "CC BY-NC-SA 4.0",
};

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

/** The body of a component's `## <name>` section (up to the next `## `), or null. */
function noticesSection(name) {
  const match = notices.match(noticesSectionPattern(name));
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextHeading = notices.slice(start).search(/^## /m);
  return nextHeading === -1 ? notices.slice(start) : notices.slice(start, start + nextHeading);
}

describe("shipped license files (#905)", () => {
  it("the repo root has LICENSE and THIRD-PARTY-LICENSES.md", () => {
    expect(existsSync(join(repoRoot, "LICENSE"))).toBe(true);
    expect(existsSync(join(repoRoot, NOTICES_FILE))).toBe(true);
  });

  it("discovers every plugin artifact (an empty list would silently skip all per-plugin checks)", () => {
    expect(PLUGINS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(Object.keys(COMPONENT_LICENSE_MARKERS))(
    "THIRD-PARTY-LICENSES.md has a substantive section for: %s",
    (component) => {
      const section = noticesSection(component);
      expect(section, `missing "## ${component}" section in ${NOTICES_FILE}`).not.toBeNull();
      expect(section, `"## ${component}" section must carry its license notice`).toContain(
        COMPONENT_LICENSE_MARKERS[component],
      );
    },
  );

  describe.each(PLUGINS)("%s", (pkg, artifact) => {
    const configPath = join(repoRoot, "packages", pkg, "rollup.config.mjs");
    const configSource = readFileSync(configPath, "utf-8");

    it("every non-workspace rollup external is a guarded component", () => {
      const thirdParty = rollupExternals(configSource).filter((name) => !name.startsWith("@iracedeck/"));
      expect(thirdParty.length).toBeGreaterThan(0);
      for (const name of thirdParty) {
        expect(
          Object.keys(COMPONENT_LICENSE_MARKERS),
          `rollup external "${name}" (${pkg}) must be added to COMPONENT_LICENSE_MARKERS and ${NOTICES_FILE}`,
        ).toContain(name);
      }
    });

    it("the rollup config copies LICENSE and THIRD-PARTY-LICENSES.md from the repo root to the artifact root", () => {
      expect(configSource).toContain('name: "copy-license-files"');
      // Assert the actual copy invocation — source anchored to the repo root,
      // destination to the artifact root — not just the filenames appearing
      // somewhere in the config.
      expect(configSource).toMatch(/for \(const file of \["LICENSE", "THIRD-PARTY-LICENSES\.md"\]\)/);
      expect(configSource).toMatch(
        /copyFileSync\(path\.resolve\(__dirname, "\.\.\/\.\.", file\), path\.join\(sdPlugin, file\)\)/,
      );
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
