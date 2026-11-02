import { describe, expect, it } from "vitest";

import {
  InTaskBroadcastReferenceAdapter,
  InTaskLivenessReferenceAdapter,
  LateAppearDropReferenceAdapter,
  OrderedReferenceAdapter,
  SerialReferenceAdapter,
  UnorderedReferenceAdapter,
} from "./context-event-order-reference-adapters.test-support.js";
import {
  CONTEXT_EVENT_ORDER_SCENARIOS,
  type ContextEventOrderHarness,
  type ContextEventOrderScenario,
} from "./testing.js";

/**
 * The suite's lasting positive controls (#1597, decision 6): every scenario is
 * run against the reference adapters and its outcome on each is pinned, so a
 * scenario edited into a no-op — one that passes on the unordered reference
 * too — turns this red, and the ordered references prove the suite is
 * passable at all, under both never-appeared policies.
 */

type Outcome = "pass" | "fail";

/** The references a scenario may fail on, each breaking one rule. */
const FAILING_REFERENCES = {
  unordered: () => new UnorderedReferenceAdapter(),
  serial: () => new SerialReferenceAdapter(),
  inTaskBroadcast: () => new InTaskBroadcastReferenceAdapter(),
  inTaskLiveness: () => new InTaskLivenessReferenceAdapter(),
  lateAppearDrop: () => new LateAppearDropReferenceAdapter(),
} as const;

type FailingReference = keyof typeof FAILING_REFERENCES;

type ExpectedOutcomes = Readonly<Record<FailingReference, Outcome>>;

const pass = "pass";
const fail = "fail";

/** Keyed by the start of the scenario's name, so a reworded tail does not silently drop a row. */
const EXPECTED: Record<string, ExpectedOutcomes> = {
  "a slow appear, then an early disappear": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: pass,
    inTaskLiveness: pass,
    lateAppearDrop: pass,
  },
  "no overtaking": { unordered: fail, serial: pass, inTaskBroadcast: pass, inTaskLiveness: pass, lateAppearDrop: pass },
  "input after a disappear is dropped": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: pass,
    inTaskLiveness: pass,
    lateAppearDrop: pass,
  },
  "input before any appear is dropped": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: pass,
    inTaskLiveness: pass,
    lateAppearDrop: pass,
  },
  "two inputs run concurrently": {
    unordered: pass,
    serial: fail,
    inTaskBroadcast: fail,
    inTaskLiveness: fail,
    lateAppearDrop: pass,
  },
  "broadcasts fire only for a live context": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: pass,
    inTaskLiveness: pass,
    lateAppearDrop: pass,
  },
  // The unordered reference fires at arrival but also runs the input ahead of the appear, which the scenario sees.
  "a broadcast fires at the input's arrival": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: fail,
    inTaskLiveness: pass,
    lateAppearDrop: pass,
  },
  "a disappear's arrival stops the broadcasts": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: pass,
    inTaskLiveness: fail,
    lateAppearDrop: pass,
  },
  "every supported input kind waits": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: pass,
    inTaskLiveness: pass,
    lateAppearDrop: pass,
  },
  "a settings change is exclusive": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: pass,
    inTaskLiveness: pass,
    lateAppearDrop: pass,
  },
  "a re-appear after a disappear": {
    unordered: fail,
    serial: pass,
    inTaskBroadcast: pass,
    inTaskLiveness: pass,
    lateAppearDrop: pass,
  },
  // Every drop-policy reference delivers the second appear; the appear-first one without the rule drops the settings.
  "a willAppear for a context that is already live": {
    unordered: fail,
    serial: fail,
    inTaskBroadcast: fail,
    inTaskLiveness: fail,
    lateAppearDrop: fail,
  },
};

function expectedFor(scenario: ContextEventOrderScenario): ExpectedOutcomes {
  const key = Object.keys(EXPECTED).find((prefix) => scenario.name.startsWith(prefix));

  if (key === undefined) throw new Error(`no expected outcomes for scenario "${scenario.name}"`);

  return EXPECTED[key];
}

async function outcome(scenario: ContextEventOrderScenario, harness: ContextEventOrderHarness): Promise<Outcome> {
  try {
    await scenario.run(harness);

    return pass;
  } catch {
    return fail;
  }
}

describe("the ordering contract suite against the reference adapters", () => {
  it("has one expected row per scenario and no other", () => {
    expect(CONTEXT_EVENT_ORDER_SCENARIOS.map((scenario) => expectedFor(scenario))).toHaveLength(
      Object.keys(EXPECTED).length,
    );
    expect(new Set(CONTEXT_EVENT_ORDER_SCENARIOS.map((s) => s.name)).size).toBe(CONTEXT_EVENT_ORDER_SCENARIOS.length);
    expect(CONTEXT_EVENT_ORDER_SCENARIOS).toHaveLength(12);
  });

  it("every scenario fails on at least one reference, so none can pass vacuously", () => {
    for (const scenario of CONTEXT_EVENT_ORDER_SCENARIOS) {
      expect(Object.values(expectedFor(scenario)), scenario.name).toContain(fail);
    }
  });

  it("every failing reference fails at least one scenario, so each stands for a rule", () => {
    for (const reference of Object.keys(FAILING_REFERENCES) as FailingReference[]) {
      const failures = CONTEXT_EVENT_ORDER_SCENARIOS.filter((scenario) => expectedFor(scenario)[reference] === fail);

      expect(failures.length, reference).toBeGreaterThan(0);
    }
  });

  describe.each(CONTEXT_EVENT_ORDER_SCENARIOS)("$name", (scenario) => {
    it("passes on the reference built on ContextEventOrder (drop policy)", async () => {
      await expect(scenario.run(new OrderedReferenceAdapter("drop").harness())).resolves.toBeUndefined();
    });

    it("passes on the reference built on ContextEventOrder (appear-first policy)", async () => {
      await expect(scenario.run(new OrderedReferenceAdapter("appear-first").harness())).resolves.toBeUndefined();
    });

    it.each(Object.keys(FAILING_REFERENCES) as FailingReference[])(
      "has the pinned outcome on the %s reference",
      async (reference) => {
        await expect(outcome(scenario, FAILING_REFERENCES[reference]().harness())).resolves.toBe(
          expectedFor(scenario)[reference],
        );
      },
    );
  });

  it("a failing scenario names the rule and the calls it saw", async () => {
    const [slowAppear] = CONTEXT_EVENT_ORDER_SCENARIOS;

    await expect(slowAppear.run(new UnorderedReferenceAdapter().harness())).rejects.toThrow(
      /a willDisappear waits for the willAppear of its context: expected handler calls \[willAppear\] but saw \[willAppear, willDisappear/,
    );
  });

  it("a harness whose emit reaches nothing fails the delivery check, not the drop check", async () => {
    const dropped = CONTEXT_EVENT_ORDER_SCENARIOS.find((s) => s.name.startsWith("input after a disappear"));
    const real = new OrderedReferenceAdapter().harness();
    const deaf: ContextEventOrderHarness = { ...real, emit: () => undefined };

    await expect(dropped?.run(deaf)).rejects.toThrow(/delivery check before a drop check/);
  });

  it("the never-appeared scenario fails on an adapter that declares the other policy", async () => {
    const before = CONTEXT_EVENT_ORDER_SCENARIOS.find((s) => s.name.startsWith("input before any appear"));
    const dropsButSaysAppearFirst = {
      ...new OrderedReferenceAdapter("drop").harness(),
      neverAppeared: "appear-first" as const,
    };
    const appearsButSaysDrop = {
      ...new OrderedReferenceAdapter("appear-first").harness(),
      neverAppeared: "drop" as const,
    };

    await expect(before?.run(dropsButSaysAppearFirst)).rejects.toThrow(/appear-first/);
    await expect(before?.run(appearsButSaysDrop)).rejects.toThrow(/never reaches the handler/);
  });
});
