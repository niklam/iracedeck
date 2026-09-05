/**
 * Unit tests for the pit-window scenarios (issue #655).
 *
 * Both scenarios fire off the single `pitsOpen.changed` event and branch on
 * `to`: `to === true` → opened, `to === false` → closed. They share the
 * `pit-window` family (so a rapid flurry preempts cleanly) and the same weight /
 * scheduling flags (above normal, below flags; never cut, but queueable).
 */
import type { SimEventOf } from "@iracedeck/event-bus";
import { describe, expect, it } from "vitest";

import type { Scenario } from "../../dsl.js";
import { PIT_WINDOW_ALERTS, PIT_WINDOW_POOL_NAMES, PIT_WINDOW_SCENARIO_IDS } from "./pit-window.js";

function scenario(id: string): Scenario {
  const s = PIT_WINDOW_ALERTS.find((x) => x.id === id);

  if (!s) throw new Error(`scenario not found: ${id}`);

  return s;
}

function changed(to: boolean): SimEventOf<"pitsOpen.changed"> {
  return {
    event: "pitsOpen.changed",
    timestamp: 0,
    telemetry: null,
    data: { from: !to, to },
  };
}

describe("pit-window scenarios", () => {
  it("exports both scenario ids and pool names", () => {
    expect(PIT_WINDOW_SCENARIO_IDS).toEqual(["pit-crew.pit-window-opened", "pit-crew.pit-window-closed"]);
    expect(PIT_WINDOW_POOL_NAMES).toEqual(["pit-window-opened", "pit-window-closed"]);
  });

  it("shares the pit-window family across both directions (preemption)", () => {
    expect(PIT_WINDOW_ALERTS.every((s) => s.family === "pit-window")).toBe(true);
  });

  it("never interrupts but stays queueable, weighted between normal and flags", () => {
    for (const s of PIT_WINDOW_ALERTS) {
      expect(s.interrupt).toBe(false);
      expect(s.queueable).toBe(true);
      expect(s.weight).toBe(65);
    }
  });

  it("opened fires only on to === true", () => {
    const where = scenario("pit-crew.pit-window-opened").when?.where;
    expect(where?.(changed(true))).toBe(true);
    expect(where?.(changed(false))).toBe(false);
  });

  it("closed fires only on to === false", () => {
    const where = scenario("pit-crew.pit-window-closed").when?.where;
    expect(where?.(changed(false))).toBe(true);
    expect(where?.(changed(true))).toBe(false);
  });

  it("plays each pool as its whole body, leaving the radio frame to the engine (issue #1064)", () => {
    for (const [id, pool] of [
      ["pit-crew.pit-window-opened", "pool:pit-window-opened"],
      ["pit-crew.pit-window-closed", "pool:pit-window-closed"],
    ] as const) {
      const s = scenario(id);

      expect(s.sequence).toEqual([pool]);
      // No `frame` → the engine's default (`radio`); the sequence never spells the ticks.
      expect(s.frame).toBeUndefined();
    }
  });
});
