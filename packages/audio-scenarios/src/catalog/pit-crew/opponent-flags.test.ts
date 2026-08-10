/**
 * Unit tests for the opponent-flag scenarios (issue #936).
 *
 * Thirteen scenarios fire off the single `opponentFlag.flagged` event and
 * branch on `relation` + `flag`: four penalty subjects (furled/black/
 * meatball/disqualify) × three per-car relations (ahead/behind/track-ahead),
 * plus the `others` aggregate. None carries a `family`: the lines describe
 * DIFFERENT cars, so same-family preemption (which cuts regardless of
 * `interrupt: false`) would truncate a burst of flag events mid-sentence —
 * they queue instead. `trigger` is deliberately ignored by every `where:`.
 * The `ahead` line's spoken number resolves from a module-scope stash
 * written by the firing `ahead` scenario's own `where:` (the #922 shape),
 * live-read-preferred with the emit-time payload as fallback.
 */
import type { OpponentFlagRelation, SimEventOf } from "@iracedeck/event-bus";
import { OpponentPenaltyFlag } from "@iracedeck/event-bus";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { poolRef, WEIGHT } from "../../dsl.js";
import type { Scenario } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  _resetOpponentFlagPending,
  OPPONENT_FLAG_ALERTS,
  OPPONENT_FLAG_CALLOUT_SETTING_KEYS,
  OPPONENT_FLAG_OTHERS_SCENARIO_ID,
  OPPONENT_FLAG_POOL_NAMES,
  OPPONENT_FLAG_SCENARIO_IDS,
  OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID,
  type OpponentFlagCalloutId,
  type OpponentFlagPending,
  registerOpponentFlagVars,
  SCENARIO_ID_TO_OPPONENT_FLAG_ID,
} from "./opponent-flags.js";
import { POOL_REGISTRY } from "./pools.js";

const SUBJECTS: readonly OpponentFlagCalloutId[] = ["furled", "black", "meatball", "disqualify"];
const RELATIONS: readonly OpponentFlagRelation[] = ["ahead", "behind", "track-ahead"];

const FLAG_OF: Record<OpponentFlagCalloutId, OpponentPenaltyFlag> = {
  furled: OpponentPenaltyFlag.Furled,
  black: OpponentPenaltyFlag.Black,
  meatball: OpponentPenaltyFlag.Repair,
  disqualify: OpponentPenaltyFlag.Disqualify,
};

function scenario(id: string): Scenario {
  const s = OPPONENT_FLAG_ALERTS.find((x) => x.id === id);

  if (!s) throw new Error(`scenario not found: ${id}`);

  return s;
}

function flagged(
  relation: OpponentFlagRelation,
  flag: OpponentPenaltyFlag | undefined,
  overrides: Partial<SimEventOf<"opponentFlag.flagged">["data"]> = {},
): SimEventOf<"opponentFlag.flagged"> {
  return {
    event: "opponentFlag.flagged",
    timestamp: 0,
    telemetry: null,
    data:
      relation === "others"
        ? { relation, ...overrides }
        : { relation, carIdx: 7, flag, trigger: "raised", position: 4, ...overrides },
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
  _resetOpponentFlagPending();
});

describe("opponent-flag scenarios", () => {
  it("exports thirteen scenario ids and fourteen pool names", () => {
    expect(OPPONENT_FLAG_SCENARIO_IDS).toHaveLength(13);
    expect(OPPONENT_FLAG_POOL_NAMES).toEqual([
      "opponent-flag-car-in",
      "opponent-flag-furled-ahead-tail",
      "opponent-flag-black-ahead-tail",
      "opponent-flag-meatball-ahead-tail",
      "opponent-flag-disqualify-ahead-tail",
      "opponent-flag-furled-behind",
      "opponent-flag-black-behind",
      "opponent-flag-meatball-behind",
      "opponent-flag-disqualify-behind",
      "opponent-flag-furled-track",
      "opponent-flag-black-track",
      "opponent-flag-meatball-track",
      "opponent-flag-disqualify-track",
      "opponent-flag-others",
    ]);
  });

  it("pool names match the registry entries exactly", () => {
    for (const name of OPPONENT_FLAG_POOL_NAMES) {
      expect(POOL_REGISTRY[name]).toBeDefined();
    }

    const registryOpponentFlagKeys = Object.keys(POOL_REGISTRY).filter((k) => k.startsWith("opponent-flag-"));

    expect([...OPPONENT_FLAG_POOL_NAMES].sort()).toEqual([...registryOpponentFlagKeys].sort());
  });

  it("carries no family — different cars queue, they never preempt each other", () => {
    for (const s of OPPONENT_FLAG_ALERTS) {
      expect(s.family).toBeUndefined();
    }
  });

  it("never interrupts but stays queueable, weighted by relation", () => {
    for (const s of OPPONENT_FLAG_ALERTS) {
      expect(s.interrupt).toBe(false);
      expect(s.queueable).toBe(true);

      if (s.id.endsWith("-track-ahead")) {
        expect(s.weight).toBe(WEIGHT.SAFETY);
      } else {
        expect(s.weight).toBe(WEIGHT.NORMAL);
      }
    }
  });

  it("routes on relation + flag — a subject's line fires only for its own subject and relation", () => {
    for (const relation of RELATIONS) {
      for (const subject of SUBJECTS) {
        const id = `pit-crew.opponent-flag-${subject}-${relation}`;
        const ev = flagged(relation, FLAG_OF[subject]);

        expect(scenario(id).when?.where?.(ev)).toBe(true);

        for (const otherSubject of SUBJECTS) {
          if (otherSubject === subject) continue;

          const otherId = `pit-crew.opponent-flag-${otherSubject}-${relation}`;

          expect(scenario(otherId).when?.where?.(ev)).toBe(false);
        }

        for (const otherRelation of RELATIONS) {
          if (otherRelation === relation) continue;

          const otherId = `pit-crew.opponent-flag-${subject}-${otherRelation}`;

          expect(scenario(otherId).when?.where?.(ev)).toBe(false);
        }
      }
    }
  });

  it("the aggregate fires only for the others relation, regardless of subject scenarios", () => {
    const where = scenario("pit-crew.opponent-flag-others").when?.where;

    expect(where?.(flagged("others", undefined))).toBe(true);

    for (const relation of RELATIONS) {
      expect(where?.(flagged(relation, OpponentPenaltyFlag.Black))).toBe(false);
    }
  });

  it("ignores the trigger field — both raised and entered-range pass", () => {
    for (const trigger of ["raised", "entered-range"] as const) {
      expect(
        scenario("pit-crew.opponent-flag-black-behind").when?.where?.(
          flagged("behind", OpponentPenaltyFlag.Black, { trigger }),
        ),
      ).toBe(true);
      expect(
        scenario("pit-crew.opponent-flag-black-track-ahead").when?.where?.(
          flagged("track-ahead", OpponentPenaltyFlag.Black, { trigger }),
        ),
      ).toBe(true);
    }
  });

  it("wraps single-pool lines in the shared radio frame", () => {
    expect(scenario("pit-crew.opponent-flag-black-behind").sequence).toEqual([
      "@pit-crew.radio-open",
      "pool:opponent-flag-black-behind",
      "@pit-crew.radio-close",
    ]);
    expect(scenario("pit-crew.opponent-flag-black-track-ahead").sequence).toEqual([
      "@pit-crew.radio-open",
      "pool:opponent-flag-black-track",
      "@pit-crew.radio-close",
    ]);
    expect(scenario("pit-crew.opponent-flag-others").sequence).toEqual([
      "@pit-crew.radio-open",
      "pool:opponent-flag-others",
      "@pit-crew.radio-close",
    ]);
  });

  it("composes the ahead line as car-in + number var + subject tail", () => {
    expect(scenario("pit-crew.opponent-flag-black-ahead").sequence).toEqual([
      "@pit-crew.radio-open",
      "pool:opponent-flag-car-in",
      { var: "opponentFlag.number" },
      "pool:opponent-flag-black-ahead-tail",
      "@pit-crew.radio-close",
    ]);
  });

  it("ahead rejects events without a usable car or position", () => {
    const where = scenario("pit-crew.opponent-flag-black-ahead").when?.where;

    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: undefined }))).toBe(false);
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { position: undefined }))).toBe(false);
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { position: 0 }))).toBe(false);
    // Non-integer / negative values would build clip lookups with no clip
    // behind them (`position-number/4.5`) — reject them outright.
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: -1 }))).toBe(false);
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: 6.5 }))).toBe(false);
    expect(where?.(flagged("ahead", OpponentPenaltyFlag.Black, { position: 4.5 }))).toBe(false);
  });
});

describe("registerOpponentFlagVars + the pending stash", () => {
  it("resolves the number from the stash payload when no live read is wired", () => {
    const { engine, vars } = makeVarEngine();

    registerOpponentFlagVars(engine);

    const resolve = vars.get("opponentFlag.number");

    expect(resolve).toBeDefined();
    // No stash yet — an ahead fire hasn't passed its where: → abort (#835).
    expect(resolve!()).toBeNull();

    scenario("pit-crew.opponent-flag-black-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Black, { position: 4 }),
    );
    expect(resolve!()).toEqual(poolRef("position-number", "4"));
  });

  it("prefers the live read and hands it the stashed projection context", () => {
    const { engine, vars } = makeVarEngine();
    const seen: OpponentFlagPending[] = [];

    registerOpponentFlagVars(engine, (pending) => {
      seen.push(pending);

      return 6;
    });

    scenario("pit-crew.opponent-flag-black-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: 12, position: 4, isMultiClass: true }),
    );

    expect(vars.get("opponentFlag.number")!()).toEqual(poolRef("position-number", "6"));
    expect(seen).toEqual([{ carIdx: 12, position: 4, isMultiClass: true }]);
  });

  it("falls back to the payload position when the live read returns null", () => {
    const { engine, vars } = makeVarEngine();

    registerOpponentFlagVars(engine, () => null);

    scenario("pit-crew.opponent-flag-black-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Black, { position: 4 }),
    );
    expect(vars.get("opponentFlag.number")!()).toEqual(poolRef("position-number", "4"));
  });

  it("an event that fails its own scenario's gates never clobbers the stash (#922 shape)", () => {
    const { engine, vars } = makeVarEngine();

    registerOpponentFlagVars(engine);

    scenario("pit-crew.opponent-flag-black-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Black, { carIdx: 12, position: 4 }),
    );

    // An invalid furled-ahead event — its own scenario's validity check
    // rejects it (no carIdx) before ever reaching the stash write — must
    // not repoint what the deferred black-ahead line speaks.
    scenario("pit-crew.opponent-flag-furled-ahead").when?.where?.(
      flagged("ahead", OpponentPenaltyFlag.Furled, { carIdx: undefined, position: 1 }),
    );
    // Nor does a behind event for the same subject — its where: never
    // touches the ahead stash at all.
    scenario("pit-crew.opponent-flag-black-behind").when?.where?.(
      flagged("behind", OpponentPenaltyFlag.Black, { carIdx: 3, position: 9 }),
    );

    expect(vars.get("opponentFlag.number")!()).toEqual(poolRef("position-number", "4"));
  });
});

describe("family wiring", () => {
  it("maps every subject-relation scenario to its subject; the aggregate is deliberately unmapped (master-gated only)", () => {
    for (const subject of SUBJECTS) {
      for (const relation of RELATIONS) {
        expect(SCENARIO_ID_TO_OPPONENT_FLAG_ID[`pit-crew.opponent-flag-${subject}-${relation}`]).toBe(subject);
      }
    }

    // The translator diff enforces the per-flag opt-ins before anything can
    // feed the aggregation, so the aggregate only ever describes enabled
    // flags — mapping it to one subject's toggle (the earlier others →
    // black ride-along) let a disabled Black silence an aggregate built
    // from ENABLED subjects (#936 review).
    expect(SCENARIO_ID_TO_OPPONENT_FLAG_ID[OPPONENT_FLAG_OTHERS_SCENARIO_ID]).toBeUndefined();
  });

  it("maps every scenario id except the aggregate (which registers without the per-flag opt-in wrapper)", () => {
    for (const id of OPPONENT_FLAG_SCENARIO_IDS) {
      if (id === OPPONENT_FLAG_OTHERS_SCENARIO_ID) continue;

      expect(SCENARIO_ID_TO_OPPONENT_FLAG_ID[id]).toBeDefined();
    }
  });

  it("maps every bus enum value to its callout id (the translator-side opt-in resolver's table)", () => {
    expect(OPPONENT_PENALTY_FLAG_TO_CALLOUT_ID).toEqual({
      furled: "furled",
      black: "black",
      repair: "meatball",
      disqualify: "disqualify",
    });
  });

  it("exposes the canonical setting keys", () => {
    expect(OPPONENT_FLAG_CALLOUT_SETTING_KEYS).toEqual({
      furled: "calloutEnabledOpponentFlagFurled",
      black: "calloutEnabledOpponentFlagBlack",
      meatball: "calloutEnabledOpponentFlagMeatball",
      disqualify: "calloutEnabledOpponentFlagDisqualify",
    });
  });
});
