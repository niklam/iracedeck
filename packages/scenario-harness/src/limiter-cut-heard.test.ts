/**
 * What the two limiter-cut buttons are HEARD to do (issue #1407).
 *
 * `pit-crew.limiter-dropped` ends on `pitLane.exited`, and what an end sounds
 * like depends on where the line is when the exit lands: cut mid-word and
 * abandoned through the voice's `cut` tail, or stopped silently inside the
 * open click. The events reaching the bus — which `scenario-shortcuts.test.ts`
 * pins — are the same two either way, so this runs the harness's whole stack
 * (`heard-rig.test-util.ts`) and asserts the clips handed to the device.
 */
import { describe, expect, it } from "vitest";

import { type ClipDurations, shortcutOf, useHeardRig } from "./heard-rig.test-util.js";

const MID_LINE = "limiter-dropped-exit";
const EARLY = "limiter-dropped-exit-early";

/**
 * Clip lengths measured from the committed first-party clips on 2026-10-25.
 * The warning is given its SHORTEST take across both voices (`shawn`'s
 * 1.25 s; `default`'s run 2.35–2.51 s), rounded down: here the risk is the
 * opposite of the rig's usual one — the mid-line button must cross the exit
 * line BEFORE the words end, so the shortest take is the one that binds. The
 * never-mind is given its longest (0.91 s), rounded up, so the listen after
 * the exit is shown to cover it. The two ticks keep the rig's 300 ms (0.29 s).
 */
const CLIP_MS: ClipDurations = [
  [/\/pit-limiter\/dropped/, 1250],
  [/\/radio\/never-mind/, 1000],
];

describe("what the two limiter-cut buttons are heard to do (issue #1407)", () => {
  const { boot, apply, press, heard, radio } = useHeardRig(CLIP_MS);

  it("cut mid-line: the warning starts, is cut, and is abandoned with a never-mind and the close click", () => {
    boot("race");
    press(MID_LINE);

    // The never-mind is spoken at voice volume after the cut warning; only the
    // two clicks are sound effects.
    expect(heard()).toEqual(["pit-limiter/dropped", "radio/never-mind"]);
    expect(radio()).toEqual(["sfx/IRD-tick-open", "sfx/IRD-tick-close"]);
  });

  it("cut before words: only the open click, and nothing after it", () => {
    boot("race");
    press(EARLY);

    expect(heard()).toEqual([]);
    expect(radio()).toEqual(["sfx/IRD-tick-open"]);
  });

  it("control: the same run crossing the exit line after the warning has finished hears it whole, with the plain close", () => {
    // So the never-mind above is the end's doing, placed by the button's hold,
    // and not something the frame plays anyway.
    const steps = shortcutOf(MID_LINE).telemetrySequence ?? [];
    const drop = steps.findIndex((s) => s.patch.dcPitSpeedLimiterToggle === false);

    expect(drop).toBeGreaterThan(0);

    boot("race");
    apply(steps.map((s, i) => (i === drop ? { ...s, holdMs: 4000 } : s)));
    apply([{ patch: {}, holdMs: 10_000 }]);

    expect(heard()).toEqual(["pit-limiter/dropped"]);
    expect(radio()).toEqual(["sfx/IRD-tick-open", "sfx/IRD-tick-close"]);
  });
});
