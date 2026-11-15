/**
 * The limiter-on beep (issue #1272) driven the way the sim drives it: telemetry
 * ticks through the real translator into the plugins' Race Engineer wiring,
 * with the beep counted where it is heard, on the fake audio's Cue channel.
 * `limiter-on-beep-heard.test.ts` presses the harness button, which publishes
 * the event by hand; this file proves the translator publishes it, and keeps
 * quiet, where `docs/superpowers/specs/2026-09-27-issue-1272-limiter-on-beep.md`
 * says ("When it stays silent").
 *
 * The tick loop is paused (`boot(…, { ticking: false })`) so each step is
 * exactly one tick, and the translator's clock is `Date.now()` under the rig's
 * fake timers: a step's `holdMs` is how far the clock moves before the next
 * tick, which is what places a tick inside or past the 500 ms settle tail.
 */
import { LIMITER_ON_CLIP, readLimiterCueDebugState } from "@iracedeck/audio-scenarios/pit-crew";
import { AudioChannel } from "@iracedeck/audio-service";
import { EngineWarnings, TrkLoc } from "@iracedeck/iracing-sdk";
import { GlobalSettingsSchema, setCalloutEnabled } from "@iracedeck/settings";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { useHeardRig } from "./heard-rig.test-util.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import type { TelemetryStep } from "./scenario-shortcuts.js";

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

/** About one real poll apart. */
const TICK_MS = 16;

const LIMITER_ON = { EngineWarnings: EngineWarnings.PitSpeedLimiter } as const;
const LIMITER_OFF = { EngineWarnings: 0 } as const;

/** In the car at speed on the circuit, no service. */
const CIRCUIT: TelemetryPatch = {
  IsOnTrack: true,
  IsReplayPlaying: false,
  OnPitRoad: false,
  PlayerCarInPitStall: false,
  PlayerTrackSurface: TrkLoc.OnTrack,
  PitstopActive: false,
  Speed: 60,
};

/** On pit road short of the box, under the limit. */
const PIT_ROAD: TelemetryPatch = {
  ...CIRCUIT,
  OnPitRoad: true,
  PlayerTrackSurface: TrkLoc.AproachingPits,
  Speed: 15,
};

/** Stopped in the player's own pit stall, no service running. */
const STALL: TelemetryPatch = {
  ...CIRCUIT,
  OnPitRoad: true,
  PlayerCarInPitStall: true,
  PlayerTrackSurface: TrkLoc.InPitStall,
  Speed: 0,
};

/** The same stall with the crew at work. */
const SERVICE: TelemetryPatch = { ...STALL, PitstopActive: true };

/**
 * Out of the world with the driver still in the car, the one tick a tow or a
 * reset passes through before landing in the stall (`IsOnTrack` true, surface
 * −1, off pit road), as the committed captures show it.
 */
const OUT_OF_WORLD: TelemetryPatch = {
  ...CIRCUIT,
  OnPitRoad: false,
  PlayerTrackSurface: TrkLoc.NotInWorld,
  Speed: 0,
};

/** One tick of `patch`, then the clock moved `holdMs` before the next. */
function tick(patch: TelemetryPatch, holdMs = TICK_MS): TelemetryStep {
  return { patch, tick: true, holdMs };
}

/** `count` ticks of the same telemetry. */
function ticks(patch: TelemetryPatch, count: number, holdMs = TICK_MS): TelemetryStep[] {
  return Array.from({ length: count }, () => tick(patch, holdMs));
}

describe("the limiter-on beep through the real translator (issue #1272)", () => {
  const { boot, apply } = useHeardRig([]);

  beforeEach(() => {
    mixer._reset();
  });

  describe("on the circuit", () => {
    it("a press beeps once; switching it off is silent; a second press beeps again", () => {
      boot("race", { ticking: false });
      apply(ticks({ ...CIRCUIT, ...LIMITER_OFF }, 3));

      expect(beeps()).toBe(0);

      apply([tick({ ...CIRCUIT, ...LIMITER_ON }), ...ticks({ ...CIRCUIT, ...LIMITER_ON }, 5)]);

      expect(beeps()).toBe(1);

      apply(ticks({ ...CIRCUIT, ...LIMITER_OFF }, 5));

      expect(beeps()).toBe(1);
      // Positive control: the off edge reached the engine, which played nothing
      // and left the engagement's outcome standing.
      expect(readLimiterCueDebugState()).toMatchObject({ lastEdge: "off", lastOutcome: "played" });

      apply(ticks({ ...CIRCUIT, ...LIMITER_ON }, 3));

      expect(beeps()).toBe(2);
    });
  });

  describe("in the pit stall", () => {
    it("a press while stopped in the stall, no service, beeps once", () => {
      boot("race", { ticking: false });
      apply(ticks({ ...STALL, ...LIMITER_OFF }, 3));

      expect(beeps()).toBe(0);

      apply(ticks({ ...STALL, ...LIMITER_ON }, 5));

      expect(beeps()).toBe(1);
    });

    it("a serviced stop is silent while the crew works, on the tick service ends and inside the 500 ms tail; a press after the tail beeps", () => {
      boot("race", { ticking: false });
      apply(ticks({ ...PIT_ROAD, ...LIMITER_OFF }, 3));
      // The press on the approach is a real engagement.
      apply(ticks({ ...PIT_ROAD, ...LIMITER_ON }, 3));

      expect(beeps()).toBe(1);

      // Into the box, then the crew at work with the bit moving under it.
      apply([
        ...ticks({ ...STALL, ...LIMITER_ON }, 2),
        tick({ ...SERVICE, ...LIMITER_ON }, 100),
        tick({ ...SERVICE, ...LIMITER_OFF }, 100),
        tick({ ...SERVICE, ...LIMITER_ON }, 100),
        tick({ ...SERVICE, ...LIMITER_OFF }, 100),
      ]);

      expect(beeps()).toBe(1);

      // Service ends, and the bit comes on on that very tick (T).
      apply([tick({ ...STALL, ...LIMITER_ON }, 200)]);

      expect(beeps()).toBe(1);

      // Inside the tail: off at T+200, back on at T+300 — still silent.
      apply([tick({ ...STALL, ...LIMITER_OFF }, 100), tick({ ...STALL, ...LIMITER_ON }, 100)]);

      expect(beeps()).toBe(1);

      // Off at T+400, held past the tail, then pressed at T+600: an engagement.
      apply([tick({ ...STALL, ...LIMITER_OFF }, 200), ...ticks({ ...STALL, ...LIMITER_ON }, 3)]);

      expect(beeps()).toBe(2);
    });
  });

  describe("a tow or a reset", () => {
    it("is silent when the bit comes on on the landing tick in the stall, and a press after the tail beeps", () => {
      boot("race", { ticking: false });
      apply(ticks({ ...CIRCUIT, ...LIMITER_OFF }, 3));
      apply([
        tick({ ...OUT_OF_WORLD, ...LIMITER_OFF }, 50),
        // The landing tick, with the bit changing on it.
        tick({ ...STALL, ...LIMITER_ON }, 100),
        tick({ ...STALL, ...LIMITER_ON }, 100),
      ]);

      expect(beeps()).toBe(0);

      // Inside the tail (landing + 200, + 300): off, then on — still silent.
      apply([tick({ ...STALL, ...LIMITER_OFF }, 100), tick({ ...STALL, ...LIMITER_ON }, 100)]);

      expect(beeps()).toBe(0);

      // Off, held past the tail, then a press in the box the car was placed in.
      apply([tick({ ...STALL, ...LIMITER_OFF }, 400), ...ticks({ ...STALL, ...LIMITER_ON }, 3)]);

      expect(beeps()).toBe(1);
    });

    it("is silent when the bit comes on on the out-of-world tick itself", () => {
      boot("race", { ticking: false });
      apply(ticks({ ...CIRCUIT, ...LIMITER_OFF }, 3));
      apply([
        tick({ ...OUT_OF_WORLD, ...LIMITER_ON }, 50),
        ...ticks({ ...STALL, ...LIMITER_ON }, 5),
      ]);

      expect(beeps()).toBe(0);
    });
  });

  describe("connecting", () => {
    let setConnected: MockInstance<MockSDKController["setConnected"]> | null = null;

    afterEach(() => {
      setConnected?.mockRestore();
      setConnected = null;
    });

    it("with the limiter already on, on the circuit, is silent; a later press beeps", () => {
      // The rig keeps its controller to itself; the spy hands this test the
      // instance `boot` connects, so it can drop and restore the connection.
      setConnected = vi.spyOn(MockSDKController.prototype, "setConnected");
      boot("race", { ticking: false });

      const controller = setConnected.mock.contexts[0] as MockSDKController;

      apply(ticks({ ...CIRCUIT, ...LIMITER_OFF }, 3));

      // The sim goes away; the driver engages the limiter while the plugin is
      // not listening; the connection comes back on a tick with it on.
      controller.setConnected(false);
      controller.mutateTelemetry({ ...CIRCUIT, ...LIMITER_ON });
      controller.setConnected(true);
      apply(ticks({ ...CIRCUIT, ...LIMITER_ON }, 5));

      expect(beeps()).toBe(0);

      // Positive control: the translator is live again, and a real press is heard.
      apply([...ticks({ ...CIRCUIT, ...LIMITER_OFF }, 2), ...ticks({ ...CIRCUIT, ...LIMITER_ON }, 2)]);

      expect(beeps()).toBe(1);
    });
  });

  describe("the Limiter on beep switch", () => {
    it("defaults to off for users", () => {
      expect(GlobalSettingsSchema.parse({}).calloutEnabledLimiterEngagedCue).toBe(false);
    });

    it("off, a press on the circuit is silent; on again, the next press beeps", () => {
      boot("race", { ticking: false });
      setCalloutEnabled("calloutEnabledLimiterEngagedCue", false);

      try {
        apply([...ticks({ ...CIRCUIT, ...LIMITER_OFF }, 3), ...ticks({ ...CIRCUIT, ...LIMITER_ON }, 3)]);

        expect(beeps()).toBe(0);
        // Positive control: the translator published the edge and the engine refused it.
        expect(readLimiterCueDebugState().lastOutcome).toBe("cue-off");
      } finally {
        setCalloutEnabled("calloutEnabledLimiterEngagedCue", true);
      }

      apply([...ticks({ ...CIRCUIT, ...LIMITER_OFF }, 2), ...ticks({ ...CIRCUIT, ...LIMITER_ON }, 2)]);

      expect(beeps()).toBe(1);
    });
  });
});
