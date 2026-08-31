import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// scripts/typecheck-script-coverage.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Packages that deliberately have no `typecheck` script, and why. An entry here
// is a decision on the record; an absence from the list is a failure. That is the
// difference between an exclusion and a hole — a new package cannot join this
// list by being forgotten.
const NO_TYPECHECK_SCRIPT = new Map([
  [
    "website",
    "Astro project: plain `tsc` cannot check it (23 errors, all inside node_modules — " +
      "Starlight sources, `?raw` vite imports, two colliding copies of satteri). " +
      "It needs `astro check` via @astrojs/check, which is not installed.",
  ],
]);

// Guards one invariant (#987): every package with a `tsconfig.json` has a
// `typecheck` script, so `pnpm typecheck` actually covers it.
//
// Why it is worth a test. `turbo run typecheck` skips a package with no such
// script **silently** — no error, no warning, exit 0. So coverage can shrink to
// nothing while the gate still reports success, which is the same class of defect
// #987 exists to close: a green signal that means less than it appears to. The
// natural way to add a package is to copy an existing one, and copying the
// tsconfig without the script is exactly how a package slips out of the gate.
//
// This asserts presence, not the command's text. A package needing a different
// checker (as `website` would) is a decision for the allow-list above, not a
// reason to loosen the rule for everyone.
function readJson(relPath) {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf-8"));
}

const packagesWithTsconfig = readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, "packages", entry.name, "tsconfig.json")))
  .map((entry) => entry.name)
  .sort();

describe("every package with a tsconfig is covered by pnpm typecheck", () => {
  it("finds the packages to check", () => {
    expect(packagesWithTsconfig.length).toBeGreaterThan(0);
  });

  it.each(packagesWithTsconfig)("has a typecheck script: %s", (name) => {
    const scripts = readJson(`packages/${name}/package.json`).scripts ?? {};
    const excused = NO_TYPECHECK_SCRIPT.get(name);

    if (excused) {
      // Guard the exclusion in both directions: once the package can be checked,
      // this should fail so the allow-list entry is removed rather than outliving
      // the reason it was added.
      expect(
        scripts.typecheck,
        `${name} is listed in NO_TYPECHECK_SCRIPT (${excused}) but now HAS a typecheck ` +
          `script. Remove it from the allow-list — the exclusion has outlived its reason.`,
      ).toBeUndefined();
      return;
    }

    expect(
      scripts.typecheck,
      `packages/${name} has a tsconfig.json but no "typecheck" script, so \`pnpm typecheck\` ` +
        `skips it silently and it is not covered by the gate (#987). Add ` +
        `"typecheck": "tsc --noEmit -p tsconfig.json", or add it to NO_TYPECHECK_SCRIPT ` +
        `with a reason if it genuinely cannot be checked that way.`,
    ).toBeDefined();
  });
});
