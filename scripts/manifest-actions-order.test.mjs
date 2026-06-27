import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { allPluginManifestRelPaths } from "./lib/version-discovery.mjs";

// scripts/manifest-actions-order.test.mjs lives in scripts/, so the repo root is one up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Discover every plugin folder's manifest dynamically (the same source the
// release bump uses), so a new deck ecosystem is covered automatically instead
// of needing to be added to a parallel hardcoded list here.
const manifests = allPluginManifestRelPaths(repoRoot);

// Case-insensitive alphabetical order on the user-facing display name, with a
// deterministic tiebreak so two names differing only in case/accent still have a
// defined order — otherwise the guard would silently accept either ordering for
// such a pair.
const byName = (a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || a.localeCompare(b, "en");

function actionNames(manifestRelPath) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, manifestRelPath), "utf-8"));

  return manifest.Actions.map((action) => action.Name);
}

describe("plugin manifest action lists", () => {
  it("discovers every plugin manifest", () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  // The action list in each host app renders in the order of the manifest's
  // `Actions` array. Keep it alphabetical by display `Name` so the action is easy
  // to find. Hidden actions (`VisibleInActionsList: false`) are sorted in like the
  // rest — their position is irrelevant to the UI, and a uniform rule keeps this
  // guard simple. On failure, the diff prints the expected order to copy from.
  it.each(manifests)("lists actions alphabetically by display name: %s", (manifestRelPath) => {
    const names = actionNames(manifestRelPath);

    expect(names).toEqual([...names].sort(byName));
  });

  // Ordering alone can't catch a reorder that drops or duplicates an action — the
  // surviving list is still sorted. Assert uniqueness explicitly so a doubled
  // entry fails loudly instead of silently shipping a duplicate.
  it.each(manifests)("has no duplicate action names: %s", (manifestRelPath) => {
    const names = actionNames(manifestRelPath);

    expect(names).toEqual([...new Set(names)]);
  });

  // Every plugin must expose the same action set; adding an action to one manifest
  // but forgetting another (the documented cross-plugin sync rule) would otherwise
  // ship a device silently missing — or solely carrying — that action.
  it.each(manifests)("exposes the same action set as the other plugin manifests: %s", (manifestRelPath) => {
    const reference = [...new Set(actionNames(manifests[0]))].sort(byName);
    const names = [...new Set(actionNames(manifestRelPath))].sort(byName);

    expect(names).toEqual(reference);
  });
});
