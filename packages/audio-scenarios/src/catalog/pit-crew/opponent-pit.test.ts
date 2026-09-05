/**
 * Unit tests for the opponent-pit scenarios (issue #622).
 *
 * Five scenarios fire off the single `opponentPit.entered` event and branch on
 * `relation`. None carries a `family`: the lines describe DIFFERENT cars, so
 * same-family preemption (which cuts regardless of `interrupt: false`) would
 * truncate a pit train's lines mid-sentence — they queue instead. The nearby
 * line's spoken number resolves from a module-scope stash written by the
 * nearby scenario's own `where:` (the #922 shape), live-read-preferred with
 * the emit-time payload as fallback.
 */
import type { OpponentPitRelation, SimEventOf } from "@iracedeck/event-bus";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { poolRef } from "../../dsl.js";
import type { Scenario } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  _resetOpponentPitPending,
  OPPONENT_PIT_ALERTS,
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  OPPONENT_PIT_POOL_NAMES,
  OPPONENT_PIT_SCENARIO_IDS,
  type OpponentPitPending,
  registerOpponentPitVars,
  SCENARIO_ID_TO_OPPONENT_PIT_ID,
} from "./opponent-pit.js";

const ALL_RELATIONS: readonly OpponentPitRelation[] = ["leader", "ahead", "behind", "nearby", "others"];

function scenario(id: string): Scenario {
  const s = OPPONENT_PIT_ALERTS.find((x) => x.id === id);

  if (!s) throw new Error(`scenario not found: ${id}`);

  return s;
}

function entered(
  relation: OpponentPitRelation,
  overrides: Partial<SimEventOf<"opponentPit.entered">["data"]> = {},
): SimEventOf<"opponentPit.entered"> {
  return {
    event: "opponentPit.entered",
    timestamp: 0,
    telemetry: null,
    data: relation === "others" ? { relation, ...overrides } : { relation, carIdx: 7, position: 4, ...overrides },
  };
}

function makeVarEngine(): { engine: IScenarioEngine; vars: Map<string, () => unknown> } {
  const vars = new Map<string, () => unknown>();
  const engine = {
    defineVar: vi.fn((name: string, fn: () => unknown) => vars.set(name, fn)),
  } as unknown as IScenarioEngine;

  return { engine, vars };
}

beforeEach(() => {
  _resetOpponentPitPending();
});

describe("opponent-pit scenarios", () => {
  it("exports the five scenario ids and six pool names", () => {
    expect(OPPONENT_PIT_SCENARIO_IDS).toEqual([
      "pit-crew.opponent-pit-leader",
      "pit-crew.opponent-pit-ahead",
      "pit-crew.opponent-pit-behind",
      "pit-crew.opponent-pit-nearby",
      "pit-crew.opponent-pit-others",
    ]);
    expect(OPPONENT_PIT_POOL_NAMES).toEqual([
      "opponent-pit-leader",
      "opponent-pit-ahead",
      "opponent-pit-behind",
      "opponent-pit-car-in",
      "opponent-pit-is-pitting",
      "opponent-pit-others",
    ]);
  });

  it("carries no family — different cars queue, they never preempt each other", () => {
    for (const s of OPPONENT_PIT_ALERTS) {
      expect(s.family).toBeUndefined();
    }
  });

  it("never interrupts but stays queueable, weighted between normal and flags", () => {
    for (const s of OPPONENT_PIT_ALERTS) {
      expect(s.interrupt).toBe(false);
      expect(s.queueable).toBe(true);
      expect(s.weight).toBe(65);
    }
  });

  it("each scenario fires only on its own relation", () => {
    for (const s of OPPONENT_PIT_ALERTS) {
      const own = s.id.replace("pit-crew.opponent-pit-", "") as OpponentPitRelation;

      for (const relation of ALL_RELATIONS) {
        expect(s.when?.where?.(entered(relation))).toBe(relation === own);
      }
    }
  });

  it("plays single-pool lines as their whole body, leaving the radio frame to the engine (issue #1064)", () => {
    for (const [id, pool] of [
      ["pit-crew.opponent-pit-leader", "pool:opponent-pit-leader"],
      ["pit-crew.opponent-pit-others", "pool:opponent-pit-others"],
    ] as const) {
      const s = scenario(id);

      expect(s.sequence).toEqual([pool]);
      // No `frame` → the engine's default (`radio`); the sequence never spells the ticks.
      expect(s.frame).toBeUndefined();
    }
  });

  it("composes the nearby line as car-in + number var + is-pitting", () => {
    expect(scenario("pit-crew.opponent-pit-nearby").sequence).toEqual([
      "pool:opponent-pit-car-in",
      { var: "opponentPit.number" },
      "pool:opponent-pit-is-pitting",
    ]);
  });

  it("nearby rejects events without a usable car or position", () => {
    const where = scenario("pit-crew.opponent-pit-nearby").when?.where;

    expect(where?.(entered("nearby", { carIdx: undefined }))).toBe(false);
    expect(where?.(entered("nearby", { position: undefined }))).toBe(false);
    expect(where?.(entered("nearby", { position: 0 }))).toBe(false);
    // Non-integer / negative values would build clip lookups with no clip
    // behind them (`position-number/4.5`) — reject them outright.
    expect(where?.(entered("nearby", { carIdx: -1 }))).toBe(false);
    expect(where?.(entered("nearby", { carIdx: 6.5 }))).toBe(false);
    expect(where?.(entered("nearby", { position: 4.5 }))).toBe(false);
  });
});

describe("registerOpponentPitVars + the pending stash", () => {
  it("resolves the number from the stash payload when no live read is wired", () => {
    const { engine, vars } = makeVarEngine();

    registerOpponentPitVars(engine);

    const resolve = vars.get("opponentPit.number");

    expect(resolve).toBeDefined();
    // No stash yet — a nearby fire hasn't passed its where: → abort (#835).
    expect(resolve!()).toBeNull();

    scenario("pit-crew.opponent-pit-nearby").when?.where?.(entered("nearby", { position: 4 }));
    expect(resolve!()).toEqual(poolRef("position-number", "4"));
  });

  it("prefers the live read and hands it the stashed projection context", () => {
    const { engine, vars } = makeVarEngine();
    const seen: OpponentPitPending[] = [];

    registerOpponentPitVars(engine, (pending) => {
      seen.push(pending);

      return 6;
    });

    scenario("pit-crew.opponent-pit-nearby").when?.where?.(
      entered("nearby", { carIdx: 12, position: 4, isMultiClass: true }),
    );

    expect(vars.get("opponentPit.number")!()).toEqual(poolRef("position-number", "6"));
    expect(seen).toEqual([{ carIdx: 12, position: 4, isMultiClass: true }]);
  });

  it("falls back to the payload position when the live read returns null", () => {
    const { engine, vars } = makeVarEngine();

    registerOpponentPitVars(engine, () => null);

    scenario("pit-crew.opponent-pit-nearby").when?.where?.(entered("nearby", { position: 4 }));
    expect(vars.get("opponentPit.number")!()).toEqual(poolRef("position-number", "4"));
  });

  it("ignores non-nearby events — they never repoint the stash (#922 shape)", () => {
    const { engine, vars } = makeVarEngine();

    registerOpponentPitVars(engine);

    scenario("pit-crew.opponent-pit-nearby").when?.where?.(entered("nearby", { carIdx: 12, position: 4 }));
    // A later leader event (its own scenario may even be opt-in-suppressed)
    // must not overwrite what the deferred nearby line speaks.
    scenario("pit-crew.opponent-pit-leader").when?.where?.(entered("leader", { carIdx: 2, position: 1 }));

    expect(vars.get("opponentPit.number")!()).toEqual(poolRef("position-number", "4"));
  });
});

describe("family wiring", () => {
  it("maps leader to the leader opt-in and everything else to nearby", () => {
    expect(SCENARIO_ID_TO_OPPONENT_PIT_ID["pit-crew.opponent-pit-leader"]).toBe("leader");

    for (const id of OPPONENT_PIT_SCENARIO_IDS.filter((x) => x !== "pit-crew.opponent-pit-leader")) {
      expect(SCENARIO_ID_TO_OPPONENT_PIT_ID[id]).toBe("nearby");
    }
  });

  it("exposes the canonical setting keys", () => {
    expect(OPPONENT_PIT_CALLOUT_SETTING_KEYS).toEqual({
      leader: "calloutEnabledOpponentPitLeader",
      nearby: "calloutEnabledOpponentPitNearby",
    });
  });
});
