/**
 * What the pit-exit traffic buttons (issue #1113), the merge warning's
 * included (amended 2026-11-20), are HEARD to say.
 *
 * `traffic-telemetry.test.ts` drives the same buttons' telemetry through the
 * translator and checks the speak gate's input by restating it, which stops
 * short of the radio: the pit-exit lines ask the translator at speak time
 * whether the car is still leaving the pits, and a line that gate drops still
 * reached the bus. So this file presses each button on the harness's whole
 * stack (`heard-rig.test-util.ts`), after an on-track button has left the car
 * at racing speed, and asserts the clips the engine hands the Voice channel.
 */
import { getEventBus } from "@iracedeck/event-bus";
import { Flags } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { type ClipDurations, shortcutOf, useHeardRig } from "./heard-rig.test-util.js";
import { AT_RACING_SPEED } from "./scenario-shortcuts.js";

/** Racing under green with no flag shown, the caution shortcuts' resting `SessionFlags`. */
const RACING_NO_FLAG = Flags.Servicible | Flags.StartHidden;

/**
 * The longest take of each pool these buttons draw on in the reference voice,
 * measured from the committed clips on 2026-11-18 and rounded up.
 */
const CLIP_MS: ClipDurations = [
  [/\/traffic\/pit-exit-traffic/, 3300],
  [/\/traffic\/pit-exit-clear/, 2200],
  // "Watch for cars.", measured at 1.31 s on 2026-11-20 and rounded up.
  [/\/traffic\/pit-exit-merge/, 1400],
  // A stand-in for a long critical line holding the bus: far longer than the
  // real take, so the clear line waits past the traffic line's queue window.
  [/\/flags\/meatball/, 6000],
];

describe("what the pit-exit traffic buttons are heard to say (issue #1113)", () => {
  const { boot, apply, publish, press, heard, heardAndCleared } = useHeardRig(CLIP_MS);

  it.each([
    { id: "traffic-pit-exit-traffic", clip: "traffic/pit-exit-traffic" },
    { id: "traffic-pit-exit-clear", clip: "traffic/pit-exit-clear" },
    { id: "traffic-pit-exit-merge", clip: "traffic/pit-exit-merge" },
  ])("$id speaks its line after an on-track button left the car at racing speed", ({ id, clip }) => {
    boot("race");
    // An overtake or gap button pressed first: on track at racing speed.
    apply([AT_RACING_SPEED]);
    heardAndCleared();

    press(id);

    expect(heard()).toEqual([clip]);
  });

  it("traffic-pit-exit-clear is still heard after waiting six seconds behind a critical line", () => {
    const shortcut = shortcutOf("traffic-pit-exit-clear");

    boot("race");
    apply([AT_RACING_SPEED]);
    heardAndCleared();

    // The button's own steps, with a meatball call taking the bus just before
    // its publish: the clear line (SAFETY) queues behind it, inside its own
    // queue window, and must still find the car on the pit lane when it plays.
    apply(shortcut.telemetrySequence);
    publish("flag.meatball.raised");
    publish(shortcut.event as "traffic.pitExit", shortcut.data);
    apply(shortcut.teardownSequence);
    apply([{ patch: {}, holdMs: 10_000 }]);

    expect(heard()).toEqual(["flags/meatball", "traffic/pit-exit-clear"]);
  });

  it.each(["traffic-pit-exit-traffic", "traffic-pit-exit-clear", "traffic-pit-exit-merge"])(
    "%s is heard again on a second press, the car handed back to the circuit in between",
    (id) => {
      boot("race");
      apply([AT_RACING_SPEED]);
      press(id);

      const first = heardAndCleared();

      press(id);

      expect(heard()).toEqual(first);
      expect(first).toHaveLength(1);
    },
  );

  it.each(["traffic-pit-exit-traffic", "traffic-pit-exit-clear", "traffic-pit-exit-merge"])(
    "%s hands the next button a live translator with the tick loop paused: that button's first edge is announced",
    (id) => {
      boot("race", { ticking: false });
      apply([{ patch: { SessionFlags: RACING_NO_FLAG }, tick: true }, AT_RACING_SPEED]);
      press(id);

      const published: string[] = [];
      const unsubscribe = getEventBus().subscribe("flag.caution-waving.raised", (ev) => published.push(ev.event));

      try {
        // The next button's first step, ticked as a paused loop ticks it: a
        // caution thrown. Were the tick after the replay exit grace still to
        // come, it would re-seed on this patch and take the flag for its
        // baseline.
        apply([{ patch: { SessionFlags: RACING_NO_FLAG | Flags.CautionWaving }, tick: true, holdMs: 100 }]);
      } finally {
        unsubscribe();
      }

      expect(published).toEqual(["flag.caution-waving.raised"]);
    },
  );

  it.each(["traffic-pit-exit-traffic", "traffic-pit-exit-clear", "traffic-pit-exit-merge"])(
    "control: %s's event published on track at racing speed, without the button's pit-lane steps, is silent",
    (id) => {
      const shortcut = shortcutOf(id);

      boot("race");
      apply([AT_RACING_SPEED]);
      heardAndCleared();

      // The bus publish alone, as the button would without its sequence: the
      // speak gate reads the car on the racing surface and drops the line.
      publish(shortcut.event as "traffic.pitExit", shortcut.data);
      apply([{ patch: {}, holdMs: 10_000 }]);

      expect(heard()).toEqual([]);
    },
  );
});
