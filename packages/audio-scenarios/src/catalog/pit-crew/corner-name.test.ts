import type { SimEventOf } from "@iracedeck/event-bus";
import { describe, expect, it, vi } from "vitest";

import { poolRef } from "../../dsl.js";
import type { IScenarioEngine } from "../../interpreter.js";
import {
  buildCornerNameScenario,
  CORNER_NAME_SCENARIO_IDS,
  type CornerNameSnapshot,
  registerCornerNameVars,
  SCENARIO_ID_TO_CORNER_NAME_ID,
} from "./corner-name.js";

function cornerEvent(data: { name: string; slug: string }): SimEventOf<"cornerName.approaching"> {
  return { event: "cornerName.approaching", data } as SimEventOf<"cornerName.approaching">;
}

describe("buildCornerNameScenario", () => {
  it("has the terse non-queueable corner-name shape", () => {
    const s = buildCornerNameScenario(() => null);

    expect(s.id).toBe("pit-crew.corner-name-approaching");
    expect(s.family).toBe("corner-name");
    expect(s.queueable).toBe(false);
    // Single var step — bare name, no radio open/close frame.
    expect(s.sequence).toEqual([{ var: "cornerName.clip" }]);
  });

  it("where: requires a usable slug and a populated snapshot", () => {
    let snapshot: CornerNameSnapshot | null = null;
    const s = buildCornerNameScenario(() => snapshot);
    const good = cornerEvent({ name: "Eau Rouge", slug: "eau-rouge" });

    expect(s.when?.where?.(good)).toBe(false); // snapshot not populated yet

    snapshot = { name: "Eau Rouge", slug: "eau-rouge" };
    expect(s.when?.where?.(good)).toBe(true);
    expect(s.when?.where?.(cornerEvent({ name: "", slug: "" }))).toBe(false);
  });
});

describe("registerCornerNameVars", () => {
  it("resolves cornerName.clip to the group/slug pool, null without a snapshot", () => {
    const vars = new Map<string, () => unknown>();
    const engine = {
      defineVar: vi.fn((name: string, fn: () => unknown) => vars.set(name, fn)),
    } as unknown as IScenarioEngine;
    let snapshot: CornerNameSnapshot | null = null;

    registerCornerNameVars(engine, () => snapshot);

    const resolve = vars.get("cornerName.clip");

    expect(resolve).toBeDefined();
    expect(resolve!()).toBeNull();

    snapshot = { name: "Eau Rouge", slug: "eau-rouge" };
    expect(resolve!()).toEqual(poolRef("corner-names", "eau-rouge"));
  });
});

describe("family wiring", () => {
  it("maps every scenario id to the corner-names opt-in", () => {
    expect(CORNER_NAME_SCENARIO_IDS.length).toBeGreaterThan(0);

    for (const id of CORNER_NAME_SCENARIO_IDS) {
      expect(SCENARIO_ID_TO_CORNER_NAME_ID[id]).toBe("corner-names");
    }
  });
});
