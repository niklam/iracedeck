/**
 * The shared `where:` gate (issue #1702) and the four wrappers built on it:
 * the Race Engineer master gate, the pit-action cooldown, the pit-service
 * request opt-in and the fuel countdown's session-kind gate. Each wrapper is
 * one call to `wrapWhereGate` with its own debug label, so this pins both the
 * shared behaviour and each wrapper's label. The pit-action and pit-service
 * wrappers answer a declared `settle` as ready while closed since #1702; no
 * contract of theirs declares one today, so only a test contract shows it.
 */
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { SimEventOf } from "@iracedeck/event-bus";
import { describe, expect, it, vi } from "vitest";

import type { ScenarioContext, ScenarioContract } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import {
  wrapFuelCountdownSessionScenario,
  wrapPitActionScenario,
  wrapPitServiceRequestsScenario,
  wrapRaceEngineerMasterGate,
  wrapWhereGate,
} from "./index.js";

type Gate = (s: ScenarioContract, isOpen: () => boolean, logger: { debug: (m: string) => void }) => ScenarioContract;

const WRAPPERS: readonly (readonly [string, Gate, string])[] = [
  [
    "the master gate",
    (s, o, l) => wrapRaceEngineerMasterGate(s, o, l as never),
    "race engineer master gate suppressed",
  ],
  [
    "the pit-action cooldown",
    (s, o, l) => wrapPitActionScenario(s, o, l as never),
    "pit-action suppressed (cooldown active)",
  ],
  [
    "the pit-service request opt-in",
    (s, o, l) => wrapPitServiceRequestsScenario(s, o, l as never),
    "pit service request suppressed",
  ],
  [
    "the fuel countdown session gate",
    (s, o, l) => wrapFuelCountdownSessionScenario(s, o, l as never),
    "fuel countdown suppressed in this session kind",
  ],
  [
    "wrapWhereGate itself",
    (s, o, l) => wrapWhereGate(s, o, "test gate suppressed", l as never),
    "test gate suppressed",
  ],
];

const EVENT = { event: "fuel.lapsLeft.crossed", timestamp: 0, telemetry: null, data: { count: 3, lapsLeft: 3.4 } };
const CTX = {} as ScenarioContext;

function contract(overrides: Partial<ScenarioContract> = {}): ScenarioContract {
  return {
    id: "test.gated",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    weight: WEIGHT.NORMAL,
    when: { event: "fuel.lapsLeft.crossed" },
    ...overrides,
  };
}

function where(s: ScenarioContract): (ev: SimEventOf<"fuel.lapsLeft.crossed">) => boolean {
  const fn = s.when?.where;

  if (!fn) throw new Error("the gate left no where:");

  return fn as (ev: SimEventOf<"fuel.lapsLeft.crossed">) => boolean;
}

describe.each(WRAPPERS)("%s", (_, wrap, label) => {
  it("refuses an event while closed, logging its label and the scenario id at debug", () => {
    const logger = { debug: vi.fn() };
    const own = vi.fn(() => true);
    const gated = wrap(contract({ when: { event: "fuel.lapsLeft.crossed", where: own } }), () => false, logger);

    expect(where(gated)(EVENT as never)).toBe(false);
    expect(own).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(`${label}: test.gated`);
  });

  it("defers to the scenario's own where: while open, and logs nothing", () => {
    const logger = { debug: vi.fn() };
    const gated = wrap(contract({ when: { event: "fuel.lapsLeft.crossed", where: () => false } }), () => true, logger);

    expect(where(gated)(EVENT as never)).toBe(false);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("answers true while open when the scenario has no where: of its own", () => {
    expect(where(wrap(contract(), () => true, { debug: vi.fn() }))(EVENT as never)).toBe(true);
  });

  it("reads the gate on every event, so a flip takes the next one", () => {
    let open = false;
    const gated = wrap(contract(), () => open, { debug: vi.fn() });

    expect(where(gated)(EVENT as never)).toBe(false);
    open = true;
    expect(where(gated)(EVENT as never)).toBe(true);
  });

  it("answers a declared settle as ready while closed, and asks the scenario's own while open", () => {
    let open = false;
    const pending = vi.fn(() => "the brief");
    const gated = wrap(contract({ settle: { pending, maxWaitMs: 500, pollMs: 50 } }), () => open, { debug: vi.fn() });

    expect(gated.settle?.pending(CTX)).toBeNull();
    expect(pending).not.toHaveBeenCalled();

    open = true;
    expect(gated.settle?.pending(CTX)).toBe("the brief");
    expect(gated.settle).toMatchObject({ maxWaitMs: 500, pollMs: 50 });
  });

  it("adds no settle to a scenario that declares none", () => {
    expect("settle" in wrap(contract(), () => false, { debug: vi.fn() })).toBe(false);
  });

  it("returns a scenario with no when: unchanged", () => {
    const fragment = contract({ when: undefined });

    expect(wrap(fragment, () => false, { debug: vi.fn() })).toBe(fragment);
  });
});
