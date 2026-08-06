/**
 * Unit tests for the opponent-pit scenarios (issue #622).
 *
 * Five scenarios fire off the single `opponentPit.entered` event and branch on
 * `relation`. The leader scenario carries its own family so the aggregate tail
 * emitted in the same flush can never preempt the leader line mid-sentence;
 * the other four share `opponent-pit` so a newer entry supersedes a stale
 * in-flight one.
 */
import type { OpponentPitRelation, SimEventOf } from "@iracedeck/event-bus";
import { describe, expect, it, vi } from "vitest";

import { poolRef } from "../../dsl.js";
import type { Scenario } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  OPPONENT_PIT_ALERTS,
  OPPONENT_PIT_CALLOUT_SETTING_KEYS,
  OPPONENT_PIT_POOL_NAMES,
  OPPONENT_PIT_SCENARIO_IDS,
  type OpponentPitSnapshot,
  registerOpponentPitVars,
  SCENARIO_ID_TO_OPPONENT_PIT_ID,
} from "./opponent-pit.js";

const ALL_RELATIONS: readonly OpponentPitRelation[] = ["leader", "ahead", "behind", "nearby", "others"];

function scenario(id: string): Scenario {
  const s = OPPONENT_PIT_ALERTS.find((x) => x.id === id);

  if (!s) throw new Error(`scenario not found: ${id}`);

  return s;
}

function entered(relation: OpponentPitRelation): SimEventOf<"opponentPit.entered"> {
  return {
    event: "opponentPit.entered",
    timestamp: 0,
    telemetry: null,
    data: relation === "others" ? { relation } : { relation, carIdx: 7, position: 4 },
  };
}

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

  it("keeps the leader in its own family so the aggregate can't cut it", () => {
    expect(scenario("pit-crew.opponent-pit-leader").family).toBe("opponent-pit-leader");

    for (const id of OPPONENT_PIT_SCENARIO_IDS.filter((x) => x !== "pit-crew.opponent-pit-leader")) {
      expect(scenario(id).family).toBe("opponent-pit");
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

  it("wraps single-pool lines in the shared radio frame", () => {
    expect(scenario("pit-crew.opponent-pit-leader").sequence).toEqual([
      "@pit-crew.radio-open",
      "pool:opponent-pit-leader",
      "@pit-crew.radio-close",
    ]);
    expect(scenario("pit-crew.opponent-pit-others").sequence).toEqual([
      "@pit-crew.radio-open",
      "pool:opponent-pit-others",
      "@pit-crew.radio-close",
    ]);
  });

  it("composes the nearby line as car-in + number var + is-pitting", () => {
    expect(scenario("pit-crew.opponent-pit-nearby").sequence).toEqual([
      "@pit-crew.radio-open",
      "pool:opponent-pit-car-in",
      { var: "opponentPit.number" },
      "pool:opponent-pit-is-pitting",
      "@pit-crew.radio-close",
    ]);
  });
});

describe("registerOpponentPitVars", () => {
  it("resolves opponentPit.number from the snapshot, null without one", () => {
    const vars = new Map<string, () => unknown>();
    const engine = {
      defineVar: vi.fn((name: string, fn: () => unknown) => vars.set(name, fn)),
    } as unknown as IScenarioEngine;
    let snapshot: OpponentPitSnapshot | null = null;

    registerOpponentPitVars(engine, () => snapshot);

    const resolve = vars.get("opponentPit.number");

    expect(resolve).toBeDefined();
    expect(resolve!()).toBeNull();

    snapshot = { position: 4 };
    expect(resolve!()).toEqual(poolRef("position-number", "4"));

    snapshot = { position: 0 };
    expect(resolve!()).toBeNull();
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
