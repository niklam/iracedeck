import { describe, expect, it } from "vitest";

import * as barrel from "./index.js";
import * as testing from "./testing.js";

/**
 * The testing entry is for tests (#1597): the main barrel is the production
 * surface, and `@iracedeck/deck-core/testing` carries the ordering contract
 * suite and its harness types, which no production source may import — an
 * adapter imports `ContextEventOrder` from the barrel and runs the suite from
 * its tests. It also re-exports the real dial-gesture helpers and icon
 * throttle, for tests that mock the barrel (#1375). This file holds the two
 * surfaces apart; that no production source imports the entry is the root
 * guard's, `scripts/testing-entries-test-only.test.mjs`, which holds every
 * package's `./testing` entry to it (#1375).
 */

/** The real implementations the entry re-exports for tests that mock the barrel (#1375). */
const REAL_IMPLEMENTATIONS = [
  "IconUpdateThrottle",
  "NOOP_HOLD_PREVIEW",
  "classifyDialRelease",
  "createHoldPreview",
] as const;

describe("deck-core's testing entry (#1597)", () => {
  it("carries the suite and its harness types, and the barrel carries none of them", () => {
    const suite = Object.keys(testing).filter((name) => !(REAL_IMPLEMENTATIONS as readonly string[]).includes(name));

    expect(suite.sort()).toEqual([
      "CONTEXT_EVENT_ORDER_ACTION_UUID",
      "CONTEXT_EVENT_ORDER_HOST_EVENTS",
      "CONTEXT_EVENT_ORDER_INPUT_EVENTS",
      "CONTEXT_EVENT_ORDER_SCENARIOS",
    ]);
    expect(testing.CONTEXT_EVENT_ORDER_SCENARIOS.length).toBeGreaterThanOrEqual(11);

    for (const name of suite) expect(barrel, name).not.toHaveProperty(name);

    // The references beside the suite are test support, reachable from neither entry.
    for (const name of [
      "UnorderedReferenceAdapter",
      "SerialReferenceAdapter",
      "InTaskBroadcastReferenceAdapter",
      "InTaskLivenessReferenceAdapter",
      "LateAppearDropReferenceAdapter",
      "OrderedReferenceAdapter",
    ]) {
      expect(barrel).not.toHaveProperty(name);
      expect(testing).not.toHaveProperty(name);
    }
  });

  it("re-exports the very implementations the barrel ships, for tests that mock the barrel (#1375)", () => {
    for (const name of REAL_IMPLEMENTATIONS) {
      expect(testing, name).toHaveProperty(name);
      expect(testing[name], name).toBe(barrel[name]);
    }
  });

  it("the barrel exports the primitive the adapters build on", () => {
    expect(typeof barrel.ContextEventOrder).toBe("function");
    expect(barrel.CONTEXT_EVENT_WAIT_LIMIT_MS).toBe(10_000);
  });
});
