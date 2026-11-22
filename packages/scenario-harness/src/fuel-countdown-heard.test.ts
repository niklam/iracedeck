/**
 * What the Fuel buttons are HEARD to do in each kind of session (issue #1702).
 *
 * The countdown's lines are gated on the kind of session the Race Engineer
 * reads from the translator (`getSessionClass()`) and on the four Speak in
 * toggles, a gate an event on the bus cannot see. So this runs the harness's
 * whole stack (`heard-rig.test-util.ts`: the real translator over the mock SDK,
 * the plugins' Race Engineer wiring over the seeded settings, the reference
 * voice's committed script) and asserts the clips handed to the Voice channel.
 */
import { CarLeftRight } from "@iracedeck/iracing-sdk";
import { setCalloutEnabled } from "@iracedeck/settings";
import { afterEach, describe, expect, it } from "vitest";

import { type ClipDurations, shortcutOf, useHeardRig } from "./heard-rig.test-util.js";

/** Every fuel clip is held long enough that the next one never cuts it, and shorter than a lap of the run. */
const CLIP_MS: ClipDurations = [[/\/fuel\//, 2000]];

/** What "Countdown through the translator" plays with the default per-count toggles: 5, 3, 2, 1, box. */
const DEFAULT_COUNTDOWN = [
  "fuel/laps-left-5",
  "fuel/laps-left-3",
  "fuel/laps-left-2",
  "fuel/laps-left-1",
  "fuel/laps-left-box",
];

/** The four Speak in toggles (issue #1702). */
const SPEAK_IN: Record<"race" | "practice" | "qualifying" | "test", Parameters<typeof setCalloutEnabled>[0]> = {
  race: "calloutEnabledFuelCountdownRace",
  practice: "calloutEnabledFuelCountdownPractice",
  qualifying: "calloutEnabledFuelCountdownQualifying",
  test: "calloutEnabledFuelCountdownTest",
};

/** Only the fuel lines: a voice line the run did not cause is not under test here. */
function fuelOnly(clips: readonly string[]): string[] {
  return clips.filter((clip) => clip.startsWith("fuel/"));
}

describe("what the Fuel buttons are heard to do in each kind of session (issue #1702)", () => {
  const { boot, apply, press, heard } = useHeardRig(CLIP_MS);

  afterEach(() => {
    for (const key of Object.values(SPEAK_IN)) setCalloutEnabled(key, true);
  });

  it.each(["practice", "testing"])("the translator's countdown is heard in %s with the default toggles", (preset) => {
    boot(preset);
    press("fuel-countdown-run");

    expect(heard()).toEqual(DEFAULT_COUNTDOWN);
  });

  it("is heard in full when an earlier button left a car alongside: the run clears the spotter itself", () => {
    boot("testing");
    apply([{ patch: { CarLeftRight: CarLeftRight.CarLeft }, holdMs: 500, tick: true }]);
    press("fuel-countdown-run");

    expect(fuelOnly(heard())).toEqual(DEFAULT_COUNTDOWN);
  });

  it("is silent in a test session with Test switched off, and heard again once it is back on", () => {
    boot("testing");
    setCalloutEnabled(SPEAK_IN.test, false);
    press("fuel-countdown-run");

    expect(fuelOnly(heard())).toEqual([]);

    setCalloutEnabled(SPEAK_IN.test, true);
    press("fuel-countdown-run");

    expect(heard()).toEqual(DEFAULT_COUNTDOWN);
  });

  it("is silent in practice with Practice switched off", () => {
    boot("practice");
    setCalloutEnabled(SPEAK_IN.practice, false);
    press("fuel-countdown-run");

    expect(fuelOnly(heard())).toEqual([]);
  });

  it("control: Practice off leaves a test session's countdown alone — the toggle is per kind", () => {
    boot("testing");
    setCalloutEnabled(SPEAK_IN.practice, false);
    press("fuel-countdown-run");

    expect(heard()).toEqual(DEFAULT_COUNTDOWN);
  });

  it("control: Test off leaves a practice session's countdown alone", () => {
    boot("practice");
    setCalloutEnabled(SPEAK_IN.test, false);
    press("fuel-countdown-run");

    expect(heard()).toEqual(DEFAULT_COUNTDOWN);
  });

  it("a per-count button is heard in a test session and silent with Test switched off", () => {
    boot("testing");
    press("fuel-laps-left-3");

    expect(heard()).toEqual(["fuel/laps-left-3"]);

    setCalloutEnabled(SPEAK_IN.test, false);
    press("fuel-laps-left-2");

    expect(heard()).toEqual(["fuel/laps-left-3"]);
  });

  it("a per-count button is silent in a session the Race Engineer cannot classify", () => {
    // The session number past the preset's one session: no session type, so
    // `getSessionClass()` is null — what the harness boots into. The
    // `session-classified` precondition refuses the press there; the gate is
    // what it gets ahead of.
    boot("practice");
    apply([{ patch: { SessionNum: 5 }, tick: true }]);
    press("fuel-laps-left-box");

    expect(fuelOnly(heard())).toEqual([]);

    apply([{ patch: { SessionNum: 0 }, tick: true }]);
    press("fuel-laps-left-box");

    expect(fuelOnly(heard())).toEqual(["fuel/laps-left-box"]);
  });

  it("Enough fuel to finish is heard in a race, and silent in a race with Race switched off", () => {
    boot("race");
    press("fuel-race-covered");

    expect(heard()).toEqual(["fuel/race-covered"]);

    setCalloutEnabled(SPEAK_IN.race, false);
    press("fuel-race-covered");

    expect(heard()).toEqual(["fuel/race-covered"]);
  });

  it("Enough fuel to finish is silent outside a race, every kind switched on", () => {
    // The `race-session` precondition refuses the button here; published
    // anyway, the line is refused by the gate it gets ahead of.
    boot("practice");

    const shortcut = shortcutOf("fuel-race-covered");

    expect(shortcut.event).toBe("fuel.lapsLeft.raceCovered");
    press("fuel-race-covered");

    expect(fuelOnly(heard())).toEqual([]);
  });
});
