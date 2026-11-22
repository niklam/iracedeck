/**
 * What the position buttons are HEARD to do once they put the car on track
 * (issue #1722).
 *
 * No position readout starts while the player is on pit road or out of the
 * car, and the mock boots out of it, so the position and race-status buttons
 * put the car on track first (`inCarOnTrack`). An event on the bus is not a
 * line on the radio — the check is asked again at speak time — so this runs
 * the harness's whole stack (`heard-rig.test-util.ts`) and asserts the clips
 * handed to the device.
 *
 * Every lap these buttons complete carries a lap time, so the every-lap call
 * reads it first; that call does not read pit road, which is what makes it
 * the control for the position line after it.
 */
import { describe, expect, it, vi } from "vitest";

import { type ClipDurations, shortcutOf, useHeardRig } from "./heard-rig.test-util.js";

/** Each readout clip is held long enough that the next one never cuts it. */
const CLIP_MS: ClipDurations = [[/\/(position|race-status|lap-time)[a-z-]*\//, 2000]];

/** The every-lap call for the buttons' 1:24.200 lap. */
const LAP_TIME = ["lap-time-last/intro", "lap-time-clock/1m24", "lap-time-thousandths/200"];

describe("what the position buttons are heard to do on track (issue #1722)", () => {
  const { boot, apply, publish, press, heard } = useHeardRig(CLIP_MS);

  it("a qualifying position change is read out after the lap time", () => {
    boot("qualifying");
    press("position-improved");

    expect(heard()).toEqual([...LAP_TIME, "position-intro-better/that-puts-us-to", "position-number/3"]);
  });

  it("a qualifying lap that held the place is read out as the status line", () => {
    boot("qualifying");
    press("position-unchanged-non-pb");

    expect(heard().slice(-2)).toEqual(["position-intro-worse/currently", "position-number/5"]);
  });

  it("control: the same position change is silent with the car parked on pit road — the step leaves pit road alone", () => {
    boot("qualifying");
    apply([{ patch: { OnPitRoad: true }, tick: true }]);
    press("position-improved");

    expect(heard()).toEqual(LAP_TIME);
  });

  it("a position line still being spoken when the car turns onto pit road is cut there — its number never said", () => {
    // The real path: the translator sees OnPitRoad turn true and publishes
    // pitLane.entered, which ends the readout mid-line (#1722).
    boot("qualifying");

    const shortcut = shortcutOf("position-improved");

    apply(shortcut.telemetrySequence);
    publish("lap.completed", shortcut.data);

    for (let ms = 0; ms < 20_000 && !heard().includes("position-intro-better/that-puts-us-to"); ms += 100) {
      vi.advanceTimersByTime(100);
    }

    expect(heard()).toEqual([...LAP_TIME, "position-intro-better/that-puts-us-to"]);

    apply([{ patch: { OnPitRoad: true }, tick: true }]);
    vi.advanceTimersByTime(10_000);

    expect(heard()).not.toContain("position-number/3");
  });

  it("a race status update stays mute, as its script says: the harness has no live position to read out", () => {
    // Not the pit-road check: the button puts the car on track, and the
    // position derivation in `position-pit-road-shortcuts.test.ts` shows its
    // publish reaches the race status once a live position is readable.
    boot("race");
    press("race-status-cadence-hit");

    expect(heard()).toEqual(LAP_TIME);
  });
});
