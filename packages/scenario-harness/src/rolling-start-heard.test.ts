/**
 * What the rolling-start buttons are HEARD to say (issue #1167).
 *
 * The other shortcut tests stop at the bus: they assert the events a button
 * makes the translator publish. That was not enough here. When the three
 * formation callouts gained a speak gate asking the translator whether a
 * formation is running, the two buttons that published their events by hand
 * went silent — and every test in the package stayed green, because the event
 * still reached the bus. An event on the bus is not a line on the radio.
 *
 * So this file runs the harness's whole stack the way `main.ts` boots it
 * (`heard-rig.test-util.ts`), with only the audio device replaced, and presses
 * each button the way the UI does. What is asserted is the clips the engine
 * hands the Voice channel, in order.
 */
import { SessionState } from "@iracedeck/iracing-sdk";
import { describe, expect, it, vi } from "vitest";

import { type ClipDurations, shortcutOf, useHeardRig } from "./heard-rig.test-util.js";

/**
 * The longest take of each pool these buttons draw on in the reference voice,
 * measured from the committed clips on 2026-10-11 and rounded up.
 */
const CLIP_MS: ClipDurations = [
  [/\/car-number\//, 900],
  [/\/rolling-start\//, 3600],
  [/\/caution\/one-to-go/, 2600],
  [/\/caution\/lineup-changed/, 1700],
  [/\/caution\/pace-car-off/, 1400],
  [/\/flags\/green-held/, 4800],
  [/\/start-lights\//, 1100],
];

describe("what the rolling-start buttons are heard to say (issue #1167)", () => {
  const { boot, apply, publish, press, heard, heardAndCleared } = useHeardRig(CLIP_MS);

  const PACE_CAR_INSIDE = ["rolling-start/pace-car-moving-inside", "car-number/8"];
  const ONE_LAP_INSIDE = ["caution/one-to-go-inside", "car-number/8"];
  const CHANGE_INSIDE = ["caution/lineup-changed-inside", "car-number/19"];

  it('"Formation (oval, two laps)" speaks the three formation calls with the lane and the car, then the three the start already had', () => {
    boot("race-oval");
    press("rolling-start-formation");

    expect(heard()).toEqual([
      // "Pace car's rolling. Inside line, behind" + "car eight".
      ...PACE_CAR_INSIDE,
      // "One lap to green. Take the inside line behind" + "car eight" — the real #773 decision.
      ...ONE_LAP_INSIDE,
      // "Change — you're on the inside behind" + "car nineteen": car eight was the one last named.
      ...CHANGE_INSIDE,
      "flags/green-held",
      "caution/pace-car-off",
      "start-lights/start-go",
    ]);
  });

  it('"Formation (oval, two laps)" is heard whole on a second press', () => {
    boot("race-oval");
    press("rolling-start-formation");

    const first = heardAndCleared();

    press("rolling-start-formation");

    expect(heard()).toEqual(first);
    expect(first).toHaveLength(9);
  });

  it.each([
    { preset: "race-oval", lane: "the lane", clips: PACE_CAR_INSIDE },
    { preset: "race", lane: "no lane", clips: ["rolling-start/pace-car-moving-behind", "car-number/8"] },
  ])('"Pace car moving" speaks the pace-car call with $lane on $preset', ({ preset, clips }) => {
    boot(preset);
    press("rolling-start-pace-car-moving");

    expect(heard()).toEqual(clips);
  });

  it.each([
    { preset: "race-oval", lane: "the lane", clips: CHANGE_INSIDE },
    { preset: "race", lane: "no lane", clips: ["caution/lineup-changed-plain", "car-number/19"] },
  ])('"Car ahead changed" speaks the change call with $lane on $preset', ({ preset, clips }) => {
    boot(preset);
    press("rolling-start-lineup-changed");

    expect(heard()).toEqual(clips);
  });

  it.each([
    { preset: "race-oval", lane: "the lane", clips: ONE_LAP_INSIDE },
    { preset: "race", lane: "no lane", clips: ["caution/one-to-go-plain", "car-number/8"] },
  ])('"One Lap to Green" speaks the one-lap-to-green call with $lane on $preset', ({ preset, clips }) => {
    boot(preset);
    press("flag-one-lap-to-green");

    expect(heard()).toEqual(clips);
  });

  it('"One Lap to Green" is heard with the tick loop paused — its setup ticks the formation in front of the publish', () => {
    // The #1349 rule: a step whose job is to put state in front of a publish
    // cannot rely on its hold, because the hold lets a tick through only while
    // the timer runs. Here the state is the translator's formation.
    boot("race-oval", { ticking: false });
    press("flag-one-lap-to-green");

    expect(heard()).toEqual(ONE_LAP_INSIDE);
  });

  it("speaks each button again when they are pressed one after another, whatever state the last one left", () => {
    boot("race-oval");

    for (const id of [
      "flag-one-lap-to-green",
      "rolling-start-lineup-changed",
      "rolling-start-pace-car-moving",
      "flag-one-lap-to-green",
    ]) {
      press(id);
    }

    expect(heardAndCleared()).toEqual([...ONE_LAP_INSIDE, ...CHANGE_INSIDE, ...PACE_CAR_INSIDE, ...ONE_LAP_INSIDE]);

    press("rolling-start-formation");

    expect(heard()).toHaveLength(9);
  });

  it("control: the same three events published by hand with NO formation running are silent — the old buttons", () => {
    // What the two pre-#1167 buttons did, and why they went quiet: the event
    // reaches the bus, the callout's `where:` admits it (a race, live in the
    // car), and the speak gate refuses it because the translator holds no
    // formation. If this ever speaks, the gate is gone and the buttons above
    // prove nothing about it.
    boot("race-oval");
    apply([{ patch: { IsOnTrack: true, SessionState: SessionState.Racing }, holdMs: 200, tick: true }]);

    publish("rollingStart.pace-car-moving.raised");
    publish("flag.one-pace-lap-to-go.raised");
    publish("rollingStart.lineup.changed");
    vi.advanceTimersByTime(10_000);

    expect(heard()).toEqual([]);

    // ...and the first of them speaks once a formation is in front of the
    // translator, so the silence above was the gate's and not the rig's.
    apply(shortcutOf("flag-one-lap-to-green").telemetrySequence);
    publish("rollingStart.pace-car-moving.raised");
    vi.advanceTimersByTime(10_000);

    expect(heard()).toEqual(PACE_CAR_INSIDE);
  });
});
