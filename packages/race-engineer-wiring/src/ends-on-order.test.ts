import {
  _resetAudioScenarios,
  type ContractReport,
  initializeAudioScenarios,
  type IScenarioEngine,
} from "@iracedeck/audio-scenarios";
import { _resetEventBus, initializeEventBus, type SimEventName } from "@iracedeck/event-bus";
import { silentLogger } from "@iracedeck/logger";
import { findEndsOnOrderViolations, TICK_ORDER, type TickStage } from "@iracedeck/sim-events-iracing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createIracingSimRuntime } from "./sim-runtime.js";
import { wireRaceEngineer } from "./wire-race-engineer.js";

// An `endsOn` contract (#1407) drops its line once the end event arrives, which
// only works if the translator never publishes the contract's trigger AFTER its
// end event within one tick (#1499). The translator side of that is
// `TICK_ORDER` and `findEndsOnOrderViolations` in `@iracedeck/sim-events-iracing`,
// proved against `handleTick` by its `tick-order.test.ts`. This is where the
// translator meets the catalog, so the pairing is checked here: every contract
// the production registration (`wireRaceEngineer`) makes, read back through
// `engine.contracts()`, never a hand-picked list.
//
// No exemption list: a `same-stage` violation fails closed, and its message
// says what proof would justify one. None is needed today.

/** What the check reads of one contract. */
type EndsOnPair = Pick<ContractReport, "id" | "event" | "endsOnEvent">;

/**
 * One failure message per `endsOn` contract in `contracts` that the
 * translator could publish in the wrong order (or that cannot be checked);
 * empty when every pairing holds. Contracts without `endsOn` are skipped.
 */
function endsOnOrderFailures(contracts: readonly EndsOnPair[], order: readonly TickStage[]): string[] {
  const failures: string[] = [];

  for (const { id, event, endsOnEvent } of contracts) {
    if (endsOnEvent === null) continue;

    if (event === null) {
      failures.push(
        `${id}: carries endsOn \`${endsOnEvent}\` (#1407) but no \`when.event\`, so whether the translator publishes its trigger before \`${endsOnEvent}\` cannot be checked against TICK_ORDER (#1499). Give it a \`when\`, or drop the \`endsOn\`.`,
      );
      continue;
    }

    const violations = findEndsOnOrderViolations(order, event, endsOnEvent);

    if (violations.length > 0) {
      failures.push(
        `${id}: endsOn (#1407) needs its trigger published before its end event within one tick, and TICK_ORDER allows otherwise (#1499):\n` +
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

describe("endsOn trigger/end order against the translator's tick (#1407, #1499)", () => {
  let engine: IScenarioEngine;
  let endsOnContracts: readonly ContractReport[];

  beforeAll(() => {
    // The plugins' own sequence (plugin-runtime's race-engineer phase): the
    // bus, the engine, then the wiring, which runs `registerPitCrew`.
    const bus = initializeEventBus(silentLogger);
    engine = initializeAudioScenarios(bus, silentAudio, EMPTY_MANIFEST, silentLogger);
    wireRaceEngineer(bus, { logger: silentLogger, sim: createIracingSimRuntime(), voice: { driverNames: [] } });
    endsOnContracts = engine.contracts().filter((c) => c.endsOnEvent !== null);
  });

  afterAll(() => {
    _resetAudioScenarios();
    _resetEventBus();
  });

  it("finds the endsOn contracts the production registration makes, so the check cannot pass on none", () => {
    // Today that is pit-crew.limiter-dropped alone (ended by pitLane.exited).
    expect(engine.contracts().length).toBeGreaterThan(0);
    expect(endsOnContracts.length, "endsOn contracts registered by wireRaceEngineer").toBeGreaterThanOrEqual(1);
  });

  it("never lets the translator publish a contract's trigger after its endsOn event within one tick", () => {
    expect(endsOnOrderFailures(endsOnContracts, TICK_ORDER)).toEqual([]);
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
        TICK_ORDER,
      ),
    ).toEqual([]);
  });

  it("reports a reversed pair, naming the contract, both issues and the stages", () => {
    const [failure, ...rest] = endsOnOrderFailures(
      [{ id: "test.reversed", event: "pitLane.exited", endsOnEvent: "limiter.dropped" }],
      TICK_ORDER,
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
      TICK_ORDER,
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

  it("reports an endsOn contract with no trigger event, which cannot be checked", () => {
    const failures = endsOnOrderFailures(
      [{ id: "test.fire-only", event: null, endsOnEvent: "pitLane.exited" }],
      TICK_ORDER,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("test.fire-only");
    expect(failures[0]).toContain("no `when.event`");
    expect(failures[0]).toContain("#1499");
  });
});
