import { describe, expect, it } from "vitest";

import {
  OrderedReferenceAdapter,
  SerialReferenceAdapter,
  UnorderedReferenceAdapter,
} from "./context-event-order-reference-adapters.test-support.js";
import { CONTEXT_EVENT_ORDER_SCENARIOS, type ContextEventOrderScenario } from "./testing.js";

/**
 * The suite's lasting positive controls (#1597, decision 6): every scenario is
 * run against the three reference adapters and its outcome on each is pinned,
 * so a scenario edited into a no-op — one that passes on the unordered
 * reference too — turns this red, and the ordered reference proves the suite
 * is passable at all.
 */

type Outcome = "pass" | "fail";

interface ExpectedOutcomes {
  readonly unordered: Outcome;
  readonly serial: Outcome;
}

/** Keyed by the start of the scenario's name, so a reworded tail does not silently drop a row. */
const EXPECTED: Record<string, ExpectedOutcomes> = {
  "a slow appear, then an early disappear": { unordered: "fail", serial: "pass" },
  "no overtaking": { unordered: "fail", serial: "pass" },
  "input after a disappear is dropped": { unordered: "fail", serial: "pass" },
  "input before any appear is dropped": { unordered: "fail", serial: "pass" },
  "two inputs run concurrently": { unordered: "pass", serial: "fail" },
  "broadcasts fire only for a live context": { unordered: "fail", serial: "pass" },
};

function expectedFor(scenario: ContextEventOrderScenario): ExpectedOutcomes {
  const key = Object.keys(EXPECTED).find((prefix) => scenario.name.startsWith(prefix));

  if (key === undefined) throw new Error(`no expected outcomes for scenario "${scenario.name}"`);

  return EXPECTED[key];
}

async function outcome(
  scenario: ContextEventOrderScenario,
  adapter: { harness(): Parameters<ContextEventOrderScenario["run"]>[0] },
): Promise<Outcome> {
  try {
    await scenario.run(adapter.harness());

    return "pass";
  } catch {
    return "fail";
  }
}

describe("the ordering contract suite against the reference adapters", () => {
  it("has one expected row per scenario and no other", () => {
    expect(CONTEXT_EVENT_ORDER_SCENARIOS.map((scenario) => expectedFor(scenario))).toHaveLength(
      Object.keys(EXPECTED).length,
    );
    expect(new Set(CONTEXT_EVENT_ORDER_SCENARIOS.map((s) => s.name)).size).toBe(CONTEXT_EVENT_ORDER_SCENARIOS.length);
  });

  it("every scenario fails on at least one reference, so none can pass vacuously", () => {
    for (const scenario of CONTEXT_EVENT_ORDER_SCENARIOS) {
      const expected = expectedFor(scenario);

      expect([expected.unordered, expected.serial], scenario.name).toContain("fail");
    }
  });

  describe.each(CONTEXT_EVENT_ORDER_SCENARIOS)("$name", (scenario) => {
    it("passes on the reference built on ContextEventOrder", async () => {
      await expect(scenario.run(new OrderedReferenceAdapter().harness())).resolves.toBeUndefined();
    });

    it("has the pinned outcome on the unordered reference (handlers called at arrival)", async () => {
      await expect(outcome(scenario, new UnorderedReferenceAdapter())).resolves.toBe(expectedFor(scenario).unordered);
    });

    it("has the pinned outcome on the strictly serialising reference", async () => {
      await expect(outcome(scenario, new SerialReferenceAdapter())).resolves.toBe(expectedFor(scenario).serial);
    });
  });

  it("a failing scenario names the rule and the calls it saw", async () => {
    const [slowAppear] = CONTEXT_EVENT_ORDER_SCENARIOS;

    await expect(slowAppear.run(new UnorderedReferenceAdapter().harness())).rejects.toThrow(
      /a willDisappear waits for the willAppear of its context: expected handler calls \[willAppear\] but saw \[willAppear, willDisappear/,
    );
  });
});
