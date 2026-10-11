/**
 * What "Flags → Caution → catch-up" is HEARD to say (issue #1168).
 *
 * Both catch-up calls ask the translator at speak time whether the gap is
 * still open (`getCautionGap().warranted`), so the events reaching the bus —
 * which `caution-catch-up-shortcut.test.ts` pins — do not settle what plays.
 * This runs the harness's whole stack (`heard-rig.test-util.ts`) and asserts
 * the clips handed to the Voice channel.
 */
import { describe, expect, it } from "vitest";

import { type ClipDurations, shortcutOf, useHeardRig } from "./heard-rig.test-util.js";

const CATCH_UP = "flag-caution-catch-up";

/**
 * The longest take of each pool this button draws on in the reference voice,
 * measured from the committed clips on 2026-10-11 and rounded up.
 */
const CLIP_MS: ClipDurations = [
  [/\/car-number\//, 900],
  [/\/flags\/caution-waving/, 3300],
  [/\/caution\/follow-/, 1800],
  [/\/caution\/two-to-green/, 1300],
  [/\/caution\/catch-up-again/, 2600],
  [/\/caution\/catch-up/, 2000],
  [/\/caution\/restart/, 1700],
];

describe('what "Caution → catch-up" is heard to say (issue #1168)', () => {
  const { boot, apply, publish, press, heard, heardAndCleared } = useHeardRig(CLIP_MS);

  /**
   * The run's lines, by pool: the caution's own three, the catch-up call, its
   * reminder, and the restart. Car "11" is the one the player lines up behind.
   */
  const RUN = [
    "flags/caution-waving",
    // "…behind" + "car eleven".
    "caution/follow-behind",
    "car-number/11",
    // "Two to green." + its car-to-follow lead-in + "car eleven".
    "caution/two-to-green",
    "caution/restart-behind",
    "car-number/11",
    // "Close it up — catch" + "car eleven", thirteen seconds after the pickup.
    "caution/catch-up",
    "car-number/11",
    // "Still a gap. Close up on" + "car eleven", thirty seconds later.
    "caution/catch-up-again",
    "car-number/11",
    // Nothing as the gap closes; then the green.
    "caution/restart",
  ];

  it.each(["race", "race-oval"])("speaks the catch-up call and one reminder, naming car eleven, on %s", (preset) => {
    // Single file, so the oval changes nothing: no lane is involved.
    boot(preset);
    press(CATCH_UP);

    expect(heard()).toEqual(RUN);
  });

  it("is heard whole on a second press", () => {
    boot("race");
    press(CATCH_UP);

    expect(heardAndCleared()).toEqual(RUN);

    press(CATCH_UP);

    expect(heard()).toEqual(RUN);
  });

  it("control: the two events published by hand while the gap is closed are silent", () => {
    // The speak gate, isolated: the same run with the gap never opened — a
    // caution out, caught and settled, the player in place — and the two
    // events injected the way the raw injector would. They reach the bus and
    // their callouts' `where:` admits them; the gate refuses both, because
    // the translator does not judge the gap open.
    const steps = shortcutOf(CATCH_UP).telemetrySequence ?? [];
    const opens = steps.findIndex(
      (step, index) => index > 0 && Array.isArray(step.patch.CarIdxLapDistPct) && !("IsReplayPlaying" in step.patch),
    );

    expect(opens).toBeGreaterThan(0);

    boot("race");
    apply(steps.slice(0, opens));
    heardAndCleared();

    publish("caution.gapOpened");
    publish("caution.gapStillOpen");
    apply([{ patch: {}, holdMs: 10_000 }]);

    expect(heard()).toEqual([]);

    // ...and the first of them speaks once the gate would admit it, so the
    // silence above was the gate's and not the rig's. The gap is put at TWICE
    // the pack's spacing — a third of the way from in place to the button's
    // four — which is inside the band: past the multiple at which an open gap
    // counts as closed, so the gate admits, and short of the one at which the
    // translator opens a gap, so the only catch-up event is the published one.
    const inPlace = steps[0].patch.CarIdxLapDistPct as number[];
    const droppedBack = steps[opens].patch.CarIdxLapDistPct as number[];
    const inTheBand = inPlace.map((pct, carIdx) => pct + (droppedBack[carIdx] - pct) / 3);

    apply([{ patch: { CarIdxLapDistPct: inTheBand }, holdMs: 500 }]);
    publish("caution.gapOpened");
    apply([{ patch: {}, holdMs: 10_000 }]);

    expect(heard()).toEqual(["caution/catch-up", "car-number/11"]);
  });
});
