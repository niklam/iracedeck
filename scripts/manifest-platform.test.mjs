import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { allPluginManifestRelPaths } from "./lib/version-discovery.mjs";

// scripts/manifest-platform.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Discover every plugin folder's manifest dynamically (the same source the
// release bump uses), so a new deck ecosystem is covered automatically instead
// of needing to be added to a parallel hardcoded list here.
const manifests = allPluginManifestRelPaths(repoRoot);

function readManifest(manifestRelPath) {
  return JSON.parse(readFileSync(join(repoRoot, manifestRelPath), "utf-8"));
}

// iRaceDeck ships Windows-only (#994): every control ultimately drives iRacing,
// which has no macOS build, and the keyboard/window/audio addons are
// Windows-native. The `@iracedeck/iracing-native` / `@iracedeck/audio-native`
// mocks exist so the repo can be installed, built, and tested on a Mac or Linux
// machine (see the `cross-platform-development` skill) — they are NOT a reason
// to advertise the plugin there. A `mac` entry would offer host users an install
// that can do nothing, so guard the claim mechanically rather than by prose.
describe("plugin manifest supported operating systems", () => {
  it("discovers every plugin manifest", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  // One assertion covers both halves of the invariant: the only platform is
  // Windows, and the floor stays at 10. Pinning the version means a bump to
  // Windows 11 has to be a deliberate edit here rather than a silent narrowing
  // of who is offered the plugin.
  it.each(manifests)("declares Windows 10 and nothing else: %s", (manifestRelPath) => {
    expect(readManifest(manifestRelPath).OS).toEqual([{ Platform: "windows", MinimumVersion: "10" }]);
  });

  // The Elgato schema also allows a per-action `OS` list, which could re-introduce
  // the same claim one action at a time without touching the plugin-level array.
  it.each(manifests)("declares no non-Windows action platforms: %s", (manifestRelPath) => {
    const offenders = readManifest(manifestRelPath)
      .Actions.filter((action) => Array.isArray(action.OS) && action.OS.some((os) => os !== "windows"))
      .map((action) => action.Name);

    expect(offenders).toEqual([]);
  });
});
