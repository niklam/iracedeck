/**
 * What the refused-lap buttons are HEARD to do (issue #1582).
 *
 * A lap iRacing did not count reaches the bus as a `lap.completed` with
 * `lapIsValid: false` and no lap time. In qualifying the position readout
 * says "That lap didn't count." (#572), alone when the lap left no position;
 * no lap-time call speaks for it anywhere. Runs the harness's whole stack
 * (`heard-rig.test-util.ts`) and asserts the clips handed to the device.
 */
import { describe, expect, it } from "vitest";

import { type ClipDurations, useHeardRig } from "./heard-rig.test-util.js";

/** Each readout clip is held long enough that the next one never cuts it. */
const CLIP_MS: ClipDurations = [[/\/(position|lap-time)[a-z-]*\//, 2000]];

describe("what the refused-lap buttons are heard to do (issue #1582)", () => {
  const { boot, press, heard } = useHeardRig(CLIP_MS);

  it("a refused first qualifying lap says only that it didn't count", () => {
    boot("qualifying");
    press("position-invalid-first-lap");

    expect(heard()).toEqual(["position-invalid-lap/that-lap-didnt-count"]);
  });

  it("a refused qualifying lap with a position says it didn't count, then the position", () => {
    boot("qualifying");
    press("position-invalid-unchanged");

    expect(heard()).toEqual([
      "position-invalid-lap/that-lap-didnt-count",
      "position-intro-worse/currently",
      "position-number/5",
    ]);
  });

  it("a refused race lap is silent: no lap-time call speaks for it", () => {
    boot("race");
    press("lap-refused-silent");

    expect(heard()).toEqual([]);
  });

  it("control: a counted best lap in the same race is read out", () => {
    boot("race");
    press("lap-best-1m-03s");

    expect(heard()[0]).toMatch(/^lap-time-intro\//);
  });
});
