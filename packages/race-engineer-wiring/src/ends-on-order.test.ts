import {
  _resetAudioScenarios,
  type ContractReport,
  initializeAudioScenarios,
  type IScenarioEngine,
} from "@iracedeck/audio-scenarios";
import { _resetEventBus, initializeEventBus, type SimEventName } from "@iracedeck/event-bus";
import { silentLogger } from "@iracedeck/logger";
import {
  CONTROLLER_TICK_ORDER,
  type EndsOnOrderViolation,
  findEndsOnOrderViolations,
  type TickStage,
} from "@iracedeck/sim-events-iracing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createIracingSimRuntime } from "./sim-runtime.js";
import { wireRaceEngineer } from "./wire-race-engineer.js";

// An `endsOn` contract (#1407) drops its line once the end event arrives, which
// only works if the sim side never publishes the contract's trigger AFTER its
// end event within one tick (#1499). The iRacing side of that is
// `CONTROLLER_TICK_ORDER` and `findEndsOnOrderViolations` in
// `@iracedeck/sim-events-iracing`: every publish of one controller tick in bus
// order — the translator's `handleTick`, then the replay recorder that
// `initializeSimEventsIracing` subscribes after it (#1468) — proved against the
// code by its `tick-order.test.ts`. This is where the sim side meets the
// catalog, so the pairing is checked here: every contract the production
// registration (`wireRaceEngineer`) makes, read back through
// `engine.contracts()`, never a hand-picked list.
//
// A `same-stage` violation fails closed, and its message says what proof
// would justify an exemption: a test in the publishing module showing one call
// never emits the trigger after the end. A `trigger-after-end` violation is
// excused the same way, only where tests prove the end's stage leaves the
// trigger's nothing to publish on that tick (it resets the trigger's state, or
// the tick returns after it). Each exemption below names its pair, its stage
// or stages and those tests, and excuses nothing else — no other kind of
// violation, no other stage.

/** What the check reads of one contract. */
type EndsOnPair = Pick<ContractReport, "id" | "event" | "endsOnEvent">;

/** A trigger and end one stage publishes both of, proved in order by that module's own test. */
type SameStageExemption = {
  readonly trigger: SimEventName;
  readonly end: SimEventName;
  readonly stage: string;
  /** The test that proves the stage never publishes `trigger` after `end` in one call. */
  readonly proof: string;
};

const SAME_STAGE_EXEMPTIONS: readonly SameStageExemption[] = [
  {
    // #1113, amended 2026-11-20: a tow or a reset cuts a rejoin line. The
    // detector publishes the end on the tick a stop is taken off the track
    // and returns before any evaluation, so no `traffic.rejoin` follows it.
    trigger: "traffic.rejoin",
    end: "traffic.rejoinTowed",
    stage: "diffTrafficRejoin",
    proof:
      '@iracedeck/sim-events-iracing diff/traffic-rejoin.test.ts: "publishes the end alone on its tick, never a traffic.rejoin after it (the endsOn order, #1499)"',
  },
];

/**
 * A trigger whose stage comes after its end's in the table, where the end's
 * stage leaves the trigger's nothing to publish on that tick (it resets the
 * trigger's state, or the tick returns after it), proved by the tests named.
 */
type TriggerAfterEndExemption = {
  readonly trigger: SimEventName;
  readonly end: SimEventName;
  readonly triggerStage: string;
  readonly endStage: string;
  /** The tests that prove `triggerStage` never publishes `trigger` after `endStage`'s `end` on one tick. */
  readonly proof: string;
};

const TRIGGER_AFTER_END_EXEMPTIONS: readonly TriggerAfterEndExemption[] = [
  {
    // #1113: a session change wipes a running stop. The teardown resets the
    // episode before it publishes the end, `resetPerSessionState` recreates
    // the state, and a fresh episode publishes nothing on its first tick.
    trigger: "traffic.rejoin",
    end: "traffic.rejoinTowed",
    triggerStage: "diffTrafficRejoin",
    endStage: "publishActiveStateTeardown (session change)",
    proof:
      '@iracedeck/sim-events-iracing diff/traffic-rejoin.test.ts: "publishes nothing on a fresh episode\'s first tick, so no traffic.rejoin follows the translator\'s teardown end (#1499)"; traffic.translator.test.ts: "on a session change, before session.changed, with no traffic.rejoin on that tick"',
  },
  {
    // #1113: entering a replay view (the garage, on leaving the car) wipes a
    // running stop. The replay guard returns right after the teardown, so no
    // live diff runs on that tick, and the replay recorder publishes no
    // `traffic.rejoin`.
    trigger: "traffic.rejoin",
    end: "traffic.rejoinTowed",
    triggerStage: "diffTrafficRejoin",
    endStage: "publishActiveStateTeardown (replay entry)",
    proof:
      '@iracedeck/sim-events-iracing traffic.translator.test.ts: "on leaving the car for the garage, whose ticks the replay guard swallows: once, and nothing after it"; tick-order.test.ts: "places the replay-entry teardown directly before the live diffs"',
  },
];

/** The exemptions a check applies, one list per kind of violation they may excuse. */
type OrderExemptions = {
  readonly sameStage: readonly SameStageExemption[];
  readonly triggerAfterEnd: readonly TriggerAfterEndExemption[];
};

const ORDER_EXEMPTIONS: OrderExemptions = {
  sameStage: SAME_STAGE_EXEMPTIONS,
  triggerAfterEnd: TRIGGER_AFTER_END_EXEMPTIONS,
};

/** Whether `exemptions` excuse `violation` of `trigger` before `end`: of its own kind, pair and stages only. */
function exempt(
  exemptions: OrderExemptions,
  trigger: SimEventName,
  end: SimEventName,
  violation: EndsOnOrderViolation,
): boolean {
  if (violation.kind === "same-stage") {
    return exemptions.sameStage.some((e) => e.trigger === trigger && e.end === end && e.stage === violation.stage);
  }

  if (violation.kind === "trigger-after-end") {
    return exemptions.triggerAfterEnd.some(
      (e) =>
        e.trigger === trigger &&
        e.end === end &&
        e.triggerStage === violation.triggerStage &&
        e.endStage === violation.endStage,
    );
  }

  return false;
}

/**
 * One failure message per `endsOn` contract in `contracts` that the
 * translator could publish in the wrong order (or that cannot be checked);
 * empty when every pairing holds. Contracts without `endsOn` are skipped, and
 * a violation `exemptions` name, kind and stages alike, is excused.
 */
function endsOnOrderFailures(
  contracts: readonly EndsOnPair[],
  order: readonly TickStage[],
  exemptions: OrderExemptions = ORDER_EXEMPTIONS,
): string[] {
  const failures: string[] = [];

  for (const { id, event, endsOnEvent } of contracts) {
    if (endsOnEvent === null) continue;

    if (event === null) {
      failures.push(
        `${id}: carries endsOn \`${endsOnEvent}\` (#1407) but no \`when.event\`, so whether the sim side publishes its trigger before \`${endsOnEvent}\` cannot be checked against CONTROLLER_TICK_ORDER (#1499). Give it a \`when\`, or drop the \`endsOn\`.`,
      );
      continue;
    }

    const violations = findEndsOnOrderViolations(order, event, endsOnEvent).filter(
      (v) => !exempt(exemptions, event, endsOnEvent, v),
    );

    if (violations.length > 0) {
      failures.push(
        `${id}: endsOn (#1407) needs its trigger published before its end event within one tick, and CONTROLLER_TICK_ORDER allows otherwise (#1499):\n` +
          violations.map((v) => `  - [${v.kind}] ${v.message}`).join("\n"),
      );
    }
  }

  return failures;
}

/** Nothing here fires a callout, so an audio service whose every method does nothing is all registration needs. */
const silentAudio = new Proxy({}, { get: () => vi.fn() }) as unknown as Parameters<typeof initializeAudioScenarios>[1];

const EMPTY_MANIFEST: Parameters<typeof initializeAudioScenarios>[2] = {
  clips: [],
  ambientLoop: "",
  ticks: { open: "", close: "" },
};

describe("endsOn trigger/end order against one controller tick (#1407, #1499, #1468)", () => {
  let engine: IScenarioEngine;
  let endsOnContracts: readonly ContractReport[];

  beforeAll(() => {
    // The plugins' own sequence (plugin-runtime's race-engineer phase): the
    // bus, the engine, then the wiring, which runs `registerPitCrew`.
    const bus = initializeEventBus(silentLogger);
    engine = initializeAudioScenarios(bus, silentAudio, EMPTY_MANIFEST, silentLogger);
    // The rejoin lines' development flag on (#1113): their endsOn order is checked like any other.
    wireRaceEngineer(bus, {
      logger: silentLogger,
      sim: createIracingSimRuntime(),
      voice: { driverNames: [] },
      trafficRejoin: true,
    });
    endsOnContracts = engine.contracts().filter((c) => c.endsOnEvent !== null);
  });

  afterAll(() => {
    _resetAudioScenarios();
    _resetEventBus();
  });

  it("finds the endsOn contracts the production registration makes, so the check cannot pass on none", () => {
    // Today that is pit-crew.limiter-dropped (ended by pitLane.exited) and the
    // four rejoin lines (ended by traffic.rejoinTowed, #1113).
    expect(engine.contracts().length).toBeGreaterThan(0);
    expect(endsOnContracts.length, "endsOn contracts registered by wireRaceEngineer").toBeGreaterThanOrEqual(5);
    expect(endsOnContracts.map((c) => c.id)).toEqual(
      expect.arrayContaining(["pit-crew.limiter-dropped", "pit-crew.traffic-rejoin-near-first"]),
    );
  });

  it("never lets one controller tick publish a contract's trigger after its endsOn event", () => {
    expect(endsOnOrderFailures(endsOnContracts, CONTROLLER_TICK_ORDER)).toEqual([]);
  });

  it("uses every exemption: each names a pair a registered contract has, so none outlives its contract", () => {
    for (const e of [...SAME_STAGE_EXEMPTIONS, ...TRIGGER_AFTER_END_EXEMPTIONS]) {
      expect(
        endsOnContracts.some((c) => c.event === e.trigger && c.endsOnEvent === e.end),
        `${e.trigger} → ${e.end}`,
      ).toBe(true);
      expect(e.proof).toMatch(/\.test\.ts: /);
    }
  });
});

describe("endsOnOrderFailures (positive controls)", () => {
  it("passes a pair published in the right order and ignores a contract without endsOn", () => {
    expect(
      endsOnOrderFailures(
        [
          { id: "test.ok", event: "limiter.dropped", endsOnEvent: "pitLane.exited" },
          { id: "test.plain", event: "pitLane.exited", endsOnEvent: null },
        ],
        CONTROLLER_TICK_ORDER,
      ),
    ).toEqual([]);
  });

  it("reports a reversed pair, naming the contract, both issues and the stages", () => {
    const [failure, ...rest] = endsOnOrderFailures(
      [{ id: "test.reversed", event: "pitLane.exited", endsOnEvent: "limiter.dropped" }],
      CONTROLLER_TICK_ORDER,
    );

    expect(rest).toEqual([]);
    expect(failure).toContain("test.reversed");
    expect(failure).toContain("#1407");
    expect(failure).toContain("#1499");
    expect(failure).toContain("[trigger-after-end]");
    expect(failure).toContain("`diffPitLane`");
    expect(failure).toContain("`diffLimiter`");
  });

  it("reports an end event no stage publishes, rather than passing vacuously", () => {
    const [failure] = endsOnOrderFailures(
      [{ id: "test.misspelt", event: "limiter.dropped", endsOnEvent: "pitLane.exitted" as SimEventName }],
      CONTROLLER_TICK_ORDER,
    );

    expect(failure).toContain("test.misspelt");
    expect(failure).toContain("[never-published]");
    expect(failure).toContain("`pitLane.exitted`");
  });

  it("reports a trigger and end published by one stage, failing closed", () => {
    const order: readonly TickStage[] = [
      { stage: "diffBoth", source: "diff/both.ts", via: "pending", events: ["limiter.dropped", "pitLane.exited"] },
    ];
    const [failure] = endsOnOrderFailures(
      [{ id: "test.same", event: "limiter.dropped", endsOnEvent: "pitLane.exited" }],
      order,
    );

    expect(failure).toContain("test.same");
    expect(failure).toContain("[same-stage]");
  });

  it("excuses the rejoin lines' same-stage pair only through its exemption", () => {
    const rejoin = [{ id: "test.rejoin", event: "traffic.rejoin", endsOnEvent: "traffic.rejoinTowed" }] as const;

    expect(endsOnOrderFailures(rejoin, CONTROLLER_TICK_ORDER)).toEqual([]);

    const [failure] = endsOnOrderFailures(rejoin, CONTROLLER_TICK_ORDER, { ...ORDER_EXEMPTIONS, sameStage: [] });

    expect(failure).toContain("[same-stage]");
    expect(failure).toContain("`diffTrafficRejoin`");
    expect(failure).not.toContain("[trigger-after-end]");
  });

  it("excuses the translator's teardown end before the rejoin detector only through each row's own exemption", () => {
    const rejoin = [{ id: "test.rejoin", event: "traffic.rejoin", endsOnEvent: "traffic.rejoinTowed" }] as const;

    for (const row of ["publishActiveStateTeardown (session change)", "publishActiveStateTeardown (replay entry)"]) {
      const [failure, ...rest] = endsOnOrderFailures(rejoin, CONTROLLER_TICK_ORDER, {
        ...ORDER_EXEMPTIONS,
        triggerAfterEnd: TRIGGER_AFTER_END_EXEMPTIONS.filter((e) => e.endStage !== row),
      });

      expect(rest).toEqual([]);
      expect(failure).toContain("[trigger-after-end]");
      expect(failure).toContain(`\`${row}\``);
      expect(failure).not.toContain("[same-stage]");
    }
  });

  it("never lets an exemption excuse its pair from another stage, or another kind of violation", () => {
    const otherStage: readonly TickStage[] = [
      { stage: "diffBoth", source: "diff/both.ts", via: "pending", events: ["traffic.rejoin", "traffic.rejoinTowed"] },
    ];
    const reversed: readonly TickStage[] = [
      { stage: "diffEnd", source: "diff/end.ts", via: "pending", events: ["traffic.rejoinTowed"] },
      { stage: "diffTrafficRejoin", source: "diff/traffic-rejoin.ts", via: "pending", events: ["traffic.rejoin"] },
    ];
    // An exempted teardown row's name on another pair: excuses nothing there.
    const otherPair: readonly TickStage[] = [
      {
        stage: "publishActiveStateTeardown (session change)",
        source: "translator.ts",
        via: "direct",
        events: ["pitLane.exited"],
      },
      { stage: "diffTrafficRejoin", source: "diff/traffic-rejoin.ts", via: "pending", events: ["limiter.dropped"] },
    ];
    const rejoin = [{ id: "test.rejoin", event: "traffic.rejoin", endsOnEvent: "traffic.rejoinTowed" }] as const;

    expect(endsOnOrderFailures(rejoin, otherStage)[0]).toContain("[same-stage]");
    expect(endsOnOrderFailures(rejoin, reversed)[0]).toContain("[trigger-after-end]");
    expect(
      endsOnOrderFailures(
        [{ id: "test.other", event: "limiter.dropped", endsOnEvent: "pitLane.exited" }],
        otherPair,
      )[0],
    ).toContain("[trigger-after-end]");
  });

  it("reports an endsOn contract with no trigger event, which cannot be checked", () => {
    const failures = endsOnOrderFailures(
      [{ id: "test.fire-only", event: null, endsOnEvent: "pitLane.exited" }],
      CONTROLLER_TICK_ORDER,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("test.fire-only");
    expect(failures[0]).toContain("no `when.event`");
    expect(failures[0]).toContain("#1499");
  });
});
