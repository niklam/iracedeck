/**
 * The pit exit beep (issue #1161) as the harness plays it: the "Pit exit beep"
 * button, and a drive-out through the real translator.
 *
 * The cue is code-owned and plays through `getAudio()` rather than the scenario
 * engine's injected audio, so the rig's own fake never sees it: this file hands
 * `getAudio()` a fake of its own and counts the Cue-channel plays of the tone.
 * Everything else is the harness's whole stack (`heard-rig.test-util.ts`): the
 * translator over the mock SDK, the plugins' Race Engineer wiring and the
 * seeded settings.
 */
import { PIT_EXIT_CLIP } from "@iracedeck/audio-scenarios/pit-crew";
import { AudioChannel } from "@iracedeck/audio-service";
import { TrkLoc } from "@iracedeck/iracing-sdk";
import { setCalloutEnabled } from "@iracedeck/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { shortcutOf, useHeardRig } from "./heard-rig.test-util.js";
import type { TelemetryStep } from "./scenario-shortcuts.js";

const mixer = await vi.hoisted(async () => {
  const { createFakeAudio } = await import("@iracedeck/audio-service/testing");

  return createFakeAudio();
});

vi.mock("@iracedeck/audio-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/audio-service")>()),
  getAudio: () => mixer,
}));

/** How many times the pit exit tone was played on the Cue channel. */
function beeps(): number {
  return mixer._played.filter((p) => p.channel === AudioChannel.Cue && p.path === PIT_EXIT_CLIP).length;
}

/** In the car on pit road under the `race` preset's 60 km/h limit, then over the exit line. */
const DRIVE_OUT: TelemetryStep[] = [
  {
    patch: {
      IsOnTrack: true,
      IsReplayPlaying: false,
      OnPitRoad: true,
      PlayerCarInPitStall: false,
      PlayerTrackSurface: TrkLoc.AproachingPits,
      Speed: 15,
    },
    holdMs: 1000,
  },
  { patch: { OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack, Speed: 16 }, holdMs: 1000 },
];

/** The same car on pit road, then towed: out of the car on the tick pit road clears. */
const TOWED: TelemetryStep[] = [
  DRIVE_OUT[0],
  { patch: { OnPitRoad: false, IsOnTrack: false, PlayerTrackSurface: TrkLoc.NotInWorld, Speed: 0 }, holdMs: 1000 },
];

describe("the pit exit beep in the harness (issue #1161)", () => {
  const { boot, apply, press } = useHeardRig([]);

  beforeEach(() => {
    mixer._reset();
  });

  it("the Pit exit beep button plays the tone once on the Cue channel", () => {
    boot("race");
    // The UI posts a bus-event shortcut's `telemetryPatch` before the publish,
    // which the rig's `press` does not, so it is applied here first.
    apply([{ patch: shortcutOf("pit-exit-beep").telemetryPatch ?? {} }]);
    mixer._reset();
    press("pit-exit-beep");

    expect(beeps()).toBe(1);
  });

  it("control: Exited Pit Lane on the boot telemetry, out of the car in the garage, is silent", () => {
    boot("race");
    press("pit-exited");

    expect(beeps()).toBe(0);
  });

  it("a drive-out through the translator beeps once, at the exit line", () => {
    boot("race");
    apply(DRIVE_OUT.slice(0, 1));

    expect(beeps()).toBe(0);

    apply(DRIVE_OUT.slice(1));

    expect(beeps()).toBe(1);
  });

  it("a tow off pit road is silent", () => {
    boot("race");
    apply(TOWED);

    expect(beeps()).toBe(0);
  });

  it("the same drive-out is silent with the Pit exit beep switched off", () => {
    boot("race");
    setCalloutEnabled("calloutEnabledPitExitCue", false);

    try {
      apply(DRIVE_OUT);

      expect(beeps()).toBe(0);
    } finally {
      setCalloutEnabled("calloutEnabledPitExitCue", true);
    }
  });
});
