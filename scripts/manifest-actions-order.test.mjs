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

// Actions intentionally shipped on a single ecosystem (e.g. Elgato-only profile
// switching, #736 — profiles are an Elgato SDK feature with no Mirabox/Ulanzi
// equivalent). Excluded from the cross-manifest parity check below so the shared
// action set is still enforced while a platform-specific action can exist.
const ECOSYSTEM_SPECIFIC_ACTIONS = new Set(["Switch Profile"]);

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

  // Every plugin must expose the same action set; adding an action to one manifest
  // but forgetting another (the documented cross-plugin sync rule) would otherwise
  // ship a device silently missing — or solely carrying — that action.
  it.each(manifests)("exposes the same shared action set as the other plugin manifests: %s", (manifestRelPath) => {
    const shared = (names) => [...new Set(names)].filter((n) => !ECOSYSTEM_SPECIFIC_ACTIONS.has(n)).sort(byName);
    const reference = shared(actionNames(manifests[0]));
    const names = shared(actionNames(manifestRelPath));

    expect(names).toEqual(reference);
  });
});

// Dial parity (#1013): every action that declares "Encoder" on Elgato declares
// "Knob" on Mirabox and vice versa, so a new dial surface cannot silently stay
// Elgato-only; and a Mirabox knob entry carries no config block, because the
// Stream Dock host has no layouts or trigger descriptions to configure.
const ELGATO_MANIFEST = "packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/manifest.json";
const MIRABOX_MANIFEST = "packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/manifest.json";

function actions(manifestRelPath) {
  return JSON.parse(readFileSync(join(repoRoot, manifestRelPath), "utf-8")).Actions;
}

function uuidsDeclaring(manifestRelPath, controller) {
  return actions(manifestRelPath)
    .filter((action) => (action.Controllers ?? []).includes(controller))
    .map((action) => action.UUID)
    .sort();
}

describe("dial controller parity between Elgato and Mirabox (#1013)", () => {
  it("declares Knob on Mirabox for exactly the actions that declare Encoder on Elgato", () => {
    const encoders = uuidsDeclaring(ELGATO_MANIFEST, "Encoder");

    expect(encoders.length).toBeGreaterThanOrEqual(16);
    expect(uuidsDeclaring(MIRABOX_MANIFEST, "Knob")).toEqual(encoders);
  });

  it("gives a Mirabox Knob action no Knob or Encoder config block", () => {
    const withBlock = actions(MIRABOX_MANIFEST)
      .filter((action) => (action.Controllers ?? []).includes("Knob"))
      .filter((action) => action.Knob !== undefined || action.Encoder !== undefined)
      .map((action) => action.Name);

    expect(withBlock).toEqual([]);
  });

  it("keeps Ulanzi Keypad-only until its dials are verified (out of scope in #1013)", () => {
    const ulanzi = manifests.find((rel) => rel.includes("iracing-plugin-ulanzi"));

    expect(ulanzi).toBeDefined();
    expect(uuidsDeclaring(ulanzi, "Encoder")).toEqual([]);
    expect(uuidsDeclaring(ulanzi, "Knob")).toEqual([]);
  });
});
