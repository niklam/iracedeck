import { SWITCH_PROFILE_UUID } from "@iracedeck/iracing-actions";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SHARED_ACTIONS, STREAM_DECK_ACTIONS } from "./actions.js";

const packagesDir = join(import.meta.dirname, "..", "..");

/**
 * The logger scope each action always logged under, as plugin.ts:1655-1701
 * registered it before #1349 (UUID values written out, so a renamed constant
 * cannot move a scope silently). A support log is searched by these names.
 */
const SHARED_SCOPES: readonly (readonly [string, string])[] = [
  ["com.iracedeck.sd.core.ai-spotter-controls", "AiSpotterControls"],
  ["com.iracedeck.sd.core.audio-controls", "AudioControls"],
  ["com.iracedeck.sd.core.black-box-selector", "BlackBoxSelector"],
  ["com.iracedeck.sd.core.camera-focus", "CameraControls"],
  // Legacy UUID — existing Camera Cycle buttons continue to work after merge into Camera Controls
  ["com.iracedeck.sd.core.camera-cycle", "CameraControls"],
  ["com.iracedeck.sd.core.camera-editor-adjustments", "CameraEditorAdjustments"],
  ["com.iracedeck.sd.core.camera-editor-controls", "CameraEditorControls"],
  ["com.iracedeck.sd.core.car-control", "CarControl"],
  ["com.iracedeck.sd.core.chat", "Chat"],
  ["com.iracedeck.sd.core.cockpit-misc", "CockpitMisc"],
  ["com.iracedeck.sd.core.force-feedback", "ForceFeedback"],
  ["com.iracedeck.sd.core.fuel-service", "FuelService"],
  ["com.iracedeck.sd.core.look-direction", "LookDirection"],
  ["com.iracedeck.sd.core.media-capture", "MediaCapture"],
  ["com.iracedeck.sd.core.pit-crew", "PitCrew"],
  ["com.iracedeck.sd.core.pit-quick-actions", "PitQuickActions"],
  ["com.iracedeck.sd.core.race-admin", "RaceAdmin"],
  ["com.iracedeck.sd.core.replay-control", "ReplayControl"],
  ["com.iracedeck.sd.core.replay-markers", "ReplayMarkers"],
  ["com.iracedeck.sd.core.replay-navigation", "ReplayNavigation"],
  ["com.iracedeck.sd.core.replay-speed", "ReplaySpeed"],
  ["com.iracedeck.sd.core.replay-transport", "ReplayTransport"],
  ["com.iracedeck.sd.core.session-info", "SessionInfo"],
  ["com.iracedeck.sd.core.setup-aero", "SetupAero"],
  ["com.iracedeck.sd.core.setup-brakes", "SetupBrakes"],
  ["com.iracedeck.sd.core.setup-chassis", "SetupChassis"],
  ["com.iracedeck.sd.core.setup-engine", "SetupEngine"],
  ["com.iracedeck.sd.core.setup-fuel", "SetupFuel"],
  ["com.iracedeck.sd.core.setup-hybrid", "SetupHybrid"],
  ["com.iracedeck.sd.core.setup-traction", "SetupTraction"],
  ["com.iracedeck.sd.core.splits-delta-cycle", "SplitsDeltaCycle"],
  ["com.iracedeck.sd.core.telemetry-control", "TelemetryControl"],
  ["com.iracedeck.sd.core.telemetry-display", "TelemetryDisplay"],
  ["com.iracedeck.sd.core.tire-service", "TireService"],
  ["com.iracedeck.sd.core.toggle-ui-elements", "ToggleUiElements"],
  ["com.iracedeck.sd.core.view-adjustment", "ViewAdjustment"],
];

const STREAM_DECK_SCOPES: readonly (readonly [string, string])[] = [
  ["com.iracedeck.sd.core.switch-profile", "SwitchProfile"],
];

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

  it("keeps the logger scope every action always used", () => {
    expect(SHARED_ACTIONS).toHaveLength(SHARED_SCOPES.length);
    expect(Object.fromEntries(SHARED_ACTIONS.map((a) => [a.uuid, a.scope]))).toEqual(Object.fromEntries(SHARED_SCOPES));
    expect(STREAM_DECK_ACTIONS.map((a) => [a.uuid, a.scope])).toEqual(STREAM_DECK_SCOPES);
  });
});
