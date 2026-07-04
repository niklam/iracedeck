/**
 * Pit-box count-in scheduling tests (issue #758).
 *
 * Pins the scheduling contract that reverses #646: the count-in outranks the
 * CHATTER-band pit-service readback and cuts it immediately, stays below the
 * NORMAL band (pit-status, flags, and fuel-critical still win), is never
 * deferred/replayed itself, and holds the bus's pending replay between marks
 * so an interrupted readback doesn't stutter back in the gaps.
 */
import { describe, expect, it } from "vitest";

import { WEIGHT } from "../../dsl.js";
import {
  PIT_BOX_ALERTS,
  PIT_BOX_COUNT_IN_WEIGHT,
  PIT_BOX_PENDING_HOLD_MS,
  PIT_BOX_POOL_NAMES,
  PIT_BOX_SCENARIO_IDS,
} from "./pit-box.js";

describe("pit-box count-in scheduling (issue #758)", () => {
  it("outranks the CHATTER-band readback but stays below NORMAL", () => {
    expect(PIT_BOX_COUNT_IN_WEIGHT).toBeGreaterThan(WEIGHT.CHATTER);
    expect(PIT_BOX_COUNT_IN_WEIGHT).toBeLessThan(WEIGHT.NORMAL);
  });

  it("holds the pending replay long enough to bridge the ~1 s gaps between marks", () => {
    expect(PIT_BOX_PENDING_HOLD_MS).toBeGreaterThan(1000);
  });

  it.each(PIT_BOX_ALERTS.map((s) => [s.id, s] as const))("%s carries the count-in scheduling fields", (_id, s) => {
    expect(s.weight).toBe(PIT_BOX_COUNT_IN_WEIGHT);
    expect(s.interrupt).toBe(true);
    expect(s.queueable).toBe(false);
    expect(s.pendingHoldMs).toBe(PIT_BOX_PENDING_HOLD_MS);
    expect(s.family).toBe("pit-box");
  });

  it("covers all six marks", () => {
    expect(PIT_BOX_SCENARIO_IDS).toEqual([
      "pit-crew.pit-box-five",
      "pit-crew.pit-box-four",
      "pit-crew.pit-box-three",
      "pit-crew.pit-box-two",
      "pit-crew.pit-box-one",
      "pit-crew.pit-box-pit-now",
    ]);
    expect(PIT_BOX_POOL_NAMES).toHaveLength(6);
  });
});
