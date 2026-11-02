/**
 * What a pit pass is HEARD to say about the limiter (issue #1548).
 *
 * "Your pit limiter is on. Turn it off." (`pit-crew.limiter-on-track`) played
 * after a pit-out with the limiter never engaged. Its delayed re-check and
 * speak gate read `dcPitSpeedLimiterToggle`'s value, while the translator —
 * and every other limiter reader — takes the `EngineWarnings.PitSpeedLimiter`
 * bit as engaged; a car whose control read on while the bit was clear got the
 * warning. The gates now read the bit. This drives the translator through the
 * pits with the harness's whole stack (`heard-rig.test-util.ts`) and asserts
 * the clips handed to the Voice channel, because a line refused at its speak
 * gate is invisible to a test that stops at the bus.
 */
import { EngineWarnings, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { type ClipDurations, shortcutOf, useHeardRig } from "./heard-rig.test-util.js";
import type { TelemetryStep } from "./scenario-shortcuts.js";

/** No clip is given a length: every line drains at the rig's default, so a line has every chance to speak. */
const CLIP_MS: ClipDurations = [];

/** 79 km/h in m/s: over the `race` preset's 60 km/h pit limit, as in the run the issue reports. */
const SPEEDING_MPS = 79 / 3.6;

/** How long the car stays on pit road: long enough for the speeding cue and the 2.5 s missing re-check. */
const PIT_ROAD_MS = 6000;

/** The listen after the exit: past the on-track warning's 1.5 s re-check, with margin. */
const AFTER_EXIT_MS = 3000;

type LimiterSignals = {
  /** The `dcPitSpeedLimiterToggle` value, held throughout: the driver control, never the engaged state. */
  toggle: boolean;
  /** Whether the engaged bit is set on pit road. */
  bitOnPitRoad: boolean;
  /** Whether the engaged bit is still set after the pit exit. */
  bitAfterExit: boolean;
};

const bits = (engaged: boolean): number => (engaged ? EngineWarnings.PitSpeedLimiter : 0);

/**
 * One pass through the pits, driven through the translator: on the circuit,
 * the approach, pit road over the limit, then the exit and a listen.
 */
function pitPass({ toggle, bitOnPitRoad, bitAfterExit }: LimiterSignals): TelemetryStep[] {
  return [
    {
      patch: {
        IsOnTrack: true,
        OnPitRoad: false,
        PlayerCarInPitStall: false,
        PlayerTrackSurface: TrkLoc.OnTrack,
        EngineWarnings: 0,
        dcPitSpeedLimiterToggle: toggle,
        Speed: 40,
      },
      holdMs: 3000,
    },
    { patch: { PlayerTrackSurface: TrkLoc.AproachingPits, Speed: 30 }, holdMs: 1500 },
    { patch: { OnPitRoad: true, EngineWarnings: bits(bitOnPitRoad), Speed: SPEEDING_MPS }, holdMs: PIT_ROAD_MS },
    {
      patch: { OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack, EngineWarnings: bits(bitAfterExit), Speed: 30 },
      holdMs: AFTER_EXIT_MS,
    },
  ];
}

/**
 * A pit-out from the garage (the run the issue's log shows): in the car in
 * the stall, creeping out, pit road over the limit, then the exit.
 */
function garagePitOut({ toggle, bitOnPitRoad, bitAfterExit }: LimiterSignals): TelemetryStep[] {
  return [
    {
      patch: {
        IsOnTrack: true,
        OnPitRoad: true,
        PlayerCarInPitStall: true,
        PlayerTrackSurface: TrkLoc.InPitStall,
        EngineWarnings: bits(bitOnPitRoad),
        dcPitSpeedLimiterToggle: toggle,
        Speed: 0,
      },
      holdMs: 3000,
    },
    { patch: { PlayerCarInPitStall: false, PlayerTrackSurface: TrkLoc.AproachingPits, Speed: 3 }, holdMs: 1500 },
    { patch: { Speed: SPEEDING_MPS }, holdMs: PIT_ROAD_MS },
    {
      patch: { OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack, EngineWarnings: bits(bitAfterExit), Speed: 30 },
      holdMs: AFTER_EXIT_MS,
    },
  ];
}

const ON_TRACK = "pit-limiter/on-track";
const MISSING = "pit-limiter/missing";
const SPEEDING = "pit-limiter/speeding";

describe("what a pit pass is heard to say about the limiter (issue #1548)", () => {
  const { boot, apply, press, heard } = useHeardRig(CLIP_MS);

  // The case that fired before #1548. The speeding cue is asserted too, so a
  // run that never reached pit road over the limit cannot pass for the wrong
  // reason.
  it.each([
    { run: "a pass through the pits", steps: pitPass },
    { run: "a pit-out from the garage", steps: garagePitOut },
  ])("$run with the limiter never on, the toggle reading on, speeding: no on-track warning", ({ steps }) => {
    boot("race");
    apply(steps({ toggle: true, bitOnPitRoad: false, bitAfterExit: false }));

    expect(heard()).toContain(SPEEDING);
    expect(heard()).not.toContain(ON_TRACK);
  });

  // The second half of #1548: the translator emits `limiter.missing` for the
  // clear bit, and the gate that read the toggle refused it. (A pit-out from
  // the garage at a creep emits no `limiter.missing` at all, so only the pass
  // is asserted.)
  it("the same pass through the pits is warned the limiter is missing on pit road", () => {
    boot("race");
    apply(pitPass({ toggle: true, bitOnPitRoad: false, bitAfterExit: false }));

    expect(heard()).toContain(MISSING);
  });

  it.each([
    { run: "a pass through the pits", steps: pitPass },
    { run: "a pit-out from the garage", steps: garagePitOut },
  ])("control: $run with the limiter left engaged after the exit hears the on-track warning", ({ steps }) => {
    boot("race");
    apply(steps({ toggle: true, bitOnPitRoad: true, bitAfterExit: true }));

    expect(heard()).toContain(ON_TRACK);
    expect(heard()).not.toContain(MISSING);
  });

  it("control: the limiter left engaged with the toggle reading off — iRacing's pit-limiter helper — is still warned", () => {
    boot("race");
    apply(pitPass({ toggle: false, bitOnPitRoad: true, bitAfterExit: true }));

    expect(heard()).toContain(ON_TRACK);
    expect(heard()).not.toContain(MISSING);
  });

  // The two buttons that audition the delayed warnings by publishing their
  // event: each patch must put the engaged bit where the gate now reads it.
  // The UI posts a bus-event shortcut's `telemetryPatch` before the publish,
  // which the rig's `press` does not, so it is applied here first.
  it.each([
    { id: "limiter-on-track", line: ON_TRACK },
    { id: "limiter-missing", line: MISSING },
  ])("the $id button is heard to say its line", ({ id, line }) => {
    boot("race");
    apply([{ patch: shortcutOf(id).telemetryPatch ?? {} }]);
    press(id);

    expect(heard()).toEqual([line]);
  });

  // The missing re-check refuses in the pit stall, so the button pins the car
  // out of it: pressed after the "in-pit-stall" preset it must still speak.
  it("the limiter-missing button speaks after the car was left in its pit stall", () => {
    boot("race");
    apply([{ patch: { PlayerCarInPitStall: true, OnPitRoad: true } }]);
    apply([{ patch: shortcutOf("limiter-missing").telemetryPatch ?? {} }]);
    press("limiter-missing");

    expect(heard()).toEqual([MISSING]);
  });
});
