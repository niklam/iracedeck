/**
 * The limiter-on beep (issue #1272) as the harness plays it: the "Limiter on
 * beep" button.
 *
 * The cue is code-owned and plays through `getAudio()` rather than the scenario
 * engine's injected audio, so the rig's own fake never sees it: this file hands
 * `getAudio()` a fake of its own and counts the Cue-channel plays of the tone.
 * Everything else is the harness's whole stack (`heard-rig.test-util.ts`): the
 * translator over the mock SDK, the plugins' Race Engineer wiring and the
 * seeded settings.
 */
import { LIMITER_ON_CLIP, PIT_EXIT_CLIP, readLimiterCueDebugState } from "@iracedeck/audio-scenarios/pit-crew";
import { AudioChannel } from "@iracedeck/audio-service";
import { setCalloutEnabled } from "@iracedeck/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { shortcutOf, useHeardRig } from "./heard-rig.test-util.js";

const mixer = await vi.hoisted(async () => {
  const { createFakeAudio } = await import("@iracedeck/audio-service/testing");

  return createFakeAudio();
});

vi.mock("@iracedeck/audio-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/audio-service")>()),
  getAudio: () => mixer,
}));

/** How many times the limiter-on tone was played on the Cue channel. */
function beeps(): number {
  return mixer._played.filter((p) => p.channel === AudioChannel.Cue && p.path === LIMITER_ON_CLIP).length;
}

describe("the limiter-on beep in the harness (issue #1272)", () => {
  const { boot, press } = useHeardRig([]);

  beforeEach(() => {
    mixer._reset();
  });

  it("is a Pit Limiter button publishing the on edge, with no telemetry patch that would add a second edge", () => {
    const shortcut = shortcutOf("limiter-on-beep");

    expect(shortcut).toMatchObject({
      category: "Pit Limiter",
      label: "Limiter on beep",
      event: "carControl.limiterToggled",
      data: { on: true },
    });
    expect(shortcut.telemetryPatch).toBeUndefined();
  });

  it("the Limiter on beep button plays the tone once on the Cue channel, on the boot telemetry", () => {
    boot("race");
    press("limiter-on-beep");

    expect(beeps()).toBe(1);
    expect(mixer._played.filter((p) => p.channel === AudioChannel.Cue)).toEqual([
      { channel: AudioChannel.Cue, path: LIMITER_ON_CLIP, loop: false },
    ]);
    // Its own tone, not the pit exit beep that shares the channel.
    expect(mixer._played.some((p) => p.path === PIT_EXIT_CLIP)).toBe(false);
  });

  it("each press beeps again", () => {
    boot("race");
    press("limiter-on-beep");
    press("limiter-on-beep");

    expect(beeps()).toBe(2);
  });

  it("is silent with the Limiter on beep switched off, and beeps again once it is back on", () => {
    boot("race");
    setCalloutEnabled("calloutEnabledLimiterEngagedCue", false);

    try {
      press("limiter-on-beep");

      expect(beeps()).toBe(0);
      // Positive control: the edge reached the engine and was refused there.
      expect(readLimiterCueDebugState().lastOutcome).toBe("cue-off");
    } finally {
      setCalloutEnabled("calloutEnabledLimiterEngagedCue", true);
    }

    press("limiter-on-beep");

    expect(beeps()).toBe(1);
  });
});
