import { SWITCH_PROFILE_UUID } from "@iracedeck/iracing-actions";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SHARED_ACTIONS, STREAM_DECK_ACTIONS } from "./actions.js";

const packagesDir = join(import.meta.dirname, "..", "..");

/** The extras each plugin's shell passes through its extension. A host-only action is added here, in its extension, and in its manifest. */
const HOST_EXTRAS: Record<string, readonly { uuid: string }[]> = {
  "iracing-plugin-stream-deck": STREAM_DECK_ACTIONS,
  "iracing-plugin-mirabox": [],
  "iracing-plugin-ulanzi": [],
};

function pluginManifests(): { pkg: string; uuids: string[] }[] {
  return readdirSync(packagesDir)
    .filter((name) => name.startsWith("iracing-plugin-"))
    .map((pkg) => {
      const folder = readdirSync(join(packagesDir, pkg)).find((entry) =>
        existsSync(join(packagesDir, pkg, entry, "manifest.json")),
      );

      if (folder === undefined) throw new Error(`${pkg} has no plugin folder with a manifest.json`);

      const manifest = JSON.parse(readFileSync(join(packagesDir, pkg, folder, "manifest.json"), "utf-8")) as {
        Actions: { UUID: string }[];
      };

      return { pkg, uuids: manifest.Actions.map((action) => action.UUID).sort() };
    });
}

describe("the registered actions match every manifest (#1349)", () => {
  const manifests = pluginManifests();

  it("finds the three plugins, and has an extras entry for each", () => {
    expect(manifests.map((m) => m.pkg).sort()).toEqual(Object.keys(HOST_EXTRAS).sort());
  });

  it.each(manifests)("$pkg registers exactly what its manifest declares", ({ pkg, uuids }) => {
    expect([...SHARED_ACTIONS, ...HOST_EXTRAS[pkg]].map((action) => action.uuid).sort()).toEqual(uuids);
  });

  it("registers no UUID twice", () => {
    const all = [...SHARED_ACTIONS, ...STREAM_DECK_ACTIONS].map((action) => action.uuid);

    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps Switch Profile Stream Deck-only (#736)", () => {
    expect(SHARED_ACTIONS.map((a) => a.uuid)).not.toContain(SWITCH_PROFILE_UUID);
    expect(STREAM_DECK_ACTIONS.map((a) => a.uuid)).toEqual([SWITCH_PROFILE_UUID]);
  });

  it("keeps each logger scope the action always used", () => {
    expect(SHARED_ACTIONS.find((a) => a.uuid === "com.iracedeck.sd.core.camera-cycle")?.scope).toBe("CameraControls");
    expect(STREAM_DECK_ACTIONS[0].scope).toBe("SwitchProfile");
  });
});
