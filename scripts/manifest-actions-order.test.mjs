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

// Case- and accent-insensitive alphabetical order on the user-facing display
// name — the order the host app should present. The uniqueness check below
// forbids two names that collide under this comparator, so the ordering is always
// unambiguous (no two distinct allowed names compare equal).
const byName = (a, b) => a.localeCompare(b, "en", { sensitivity: "base" });

// Dial actions are intentionally platform-specific — a plugin-drawable dial
// display isn't available on every host — so they ship on a subset of plugins
// (Fuel Dial on Stream Deck + Mirabox; Setup Brakes Dial on Stream Deck only;
// Ulanzi carries neither while its dial support is unbuilt). They're excluded
// from the cross-plugin same-set check below; every OTHER action must still
// appear on all plugins so a forgotten registration fails loudly.
const PLATFORM_SPECIFIC_ACTIONS = new Set(["Fuel Dial", "Setup Brakes Dial"]);

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
  // surviving list is still sorted. Assert uniqueness explicitly, using the same
  // case/accent-insensitive rule as the ordering so a doubled entry — or two
  // confusable names like "Chat" and "chat" — fails loudly instead of shipping.
  it.each(manifests)("has no duplicate or confusable action names: %s", (manifestRelPath) => {
    const sorted = [...actionNames(manifestRelPath)].sort(byName);
    const collisions = sorted.filter((name, i) => i > 0 && byName(sorted[i - 1], name) === 0);

    expect(collisions).toEqual([]);
  });

  // Every plugin must expose the same SHARED action set; adding an action to one
  // manifest but forgetting another (the documented cross-plugin sync rule) would
  // otherwise ship a device silently missing — or solely carrying — that action.
  // The intentionally platform-specific dial actions are excluded (see above).
  it.each(manifests)("exposes the same shared action set as the other plugin manifests: %s", (manifestRelPath) => {
    const sharedNames = (path) =>
      [...new Set(actionNames(path))].filter((name) => !PLATFORM_SPECIFIC_ACTIONS.has(name)).sort(byName);

    expect(sharedNames(manifestRelPath)).toEqual(sharedNames(manifests[0]));
  });
});
