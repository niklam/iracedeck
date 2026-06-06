/**
 * Unit tests for the flag diff translator.
 *
 * The high-level translator integration tests cover the canonical raised /
 * cleared paths for green/yellow/blue/red/etc. These tests focus on the
 * branches that are *not* covered there — specifically the off→on
 * transitions for the debris and meatball (Repair) bits — and on the
 * "first tick seeds without firing" gate that all flag emission depends
 * on.
 */
import { Flags, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffFlags } from "./flags.js";
import type { PendingEvent } from "./types.js";

function tick(sessionFlags: number): TelemetryData {
  return { SessionFlags: sessionFlags } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

describe("diffFlags — debris", () => {
  it("emits flag.debris.raised on the off→on transition", () => {
    const state = createInitialState();
    state.flagStateInitialized = true; // skip seed gate

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Debris), emit);

    expect(events).toEqual([{ event: "flag.debris.raised", data: {} }]);
  });

  it("does not re-emit while the bit stays on", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.Debris), () => {});

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Debris), emit);

    expect(events).toEqual([]);
  });
});

describe("diffFlags — meatball (Flags.Repair)", () => {
  it("emits flag.meatball.raised on the off→on transition", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Repair), emit);

    expect(events).toEqual([{ event: "flag.meatball.raised", data: {} }]);
  });

  it("does not fire when only unrelated bits change", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Green), emit);

    expect(events.some((e) => e.event === "flag.meatball.raised")).toBe(false);
  });
});

describe("diffFlags — first-tick seeding", () => {
  it("does not fire any event on the first tick, even when bits are set", () => {
    const state = createInitialState();
    expect(state.flagStateInitialized).toBe(false);

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Debris | Flags.Repair | Flags.Green), emit);

    expect(events).toEqual([]);
    expect(state.flagStateInitialized).toBe(true);
  });

  it("seeds with the bits already on, then a follow-up off→on is suppressed (still on)", () => {
    const state = createInitialState();
    diffFlags(state, tick(Flags.Debris), () => {}); // seed

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Debris), emit);

    expect(events).toEqual([]);
  });
});

describe("diffFlags — new rising-edge bits (issue #480)", () => {
  const cases: Array<[string, number, string]> = [
    ["furled", Flags.Furled, "flag.furled.raised"],
    ["dq-scoring-invalid", Flags.DqScoringInvalid, "flag.dq-scoring-invalid.raised"],
    ["crossed", Flags.Crossed, "flag.crossed.raised"],
    ["one-lap-to-green", Flags.OneLapToGreen, "flag.one-lap-to-green.raised"],
    ["green-held", Flags.GreenHeld, "flag.green-held.raised"],
    ["ten-to-go", Flags.TenToGo, "flag.ten-to-go.raised"],
    ["five-to-go", Flags.FiveToGo, "flag.five-to-go.raised"],
  ];

  for (const [, bit, event] of cases) {
    it(`emits ${event} on the off→on transition`, () => {
      const state = createInitialState();
      state.flagStateInitialized = true;

      const { events, emit } = collect();
      diffFlags(state, tick(bit), emit);

      expect(events).toEqual([{ event, data: {} }]);
    });

    it(`does not re-emit ${event} while the bit stays on`, () => {
      const state = createInitialState();
      state.flagStateInitialized = true;
      diffFlags(state, tick(bit), () => {}); // seed-on

      const { events, emit } = collect();
      diffFlags(state, tick(bit), emit);

      expect(events).toEqual([]);
    });

    it(`does not fire ${event} on the first tick even when the bit is set`, () => {
      const state = createInitialState();

      const { events, emit } = collect();
      diffFlags(state, tick(bit), emit);

      expect(events).toEqual([]);
      expect(state.flagStateInitialized).toBe(true);
    });
  }
});

describe("diffFlags — disqualify split (issue #480)", () => {
  it("emits flag.disqualify.raised and NOT flag.black.raised when only Disqualify is set", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Disqualify), emit);

    expect(events).toEqual([{ event: "flag.disqualify.raised", data: {} }]);
    expect(events.some((e) => e.event === "flag.black.raised")).toBe(false);
  });

  it("still emits flag.black.raised when the Black bit is set", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Black), emit);

    expect(events).toEqual([{ event: "flag.black.raised", data: {} }]);
  });
});

describe("diffFlags — green suppression at race start (issue #480)", () => {
  it("suppresses flag.green.raised when StartGo is set", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Green | Flags.StartGo), emit);

    expect(events.some((e) => e.event === "flag.green.raised")).toBe(false);
  });

  it("fires flag.green.raised at a restart (Green rising, no StartGo)", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Green), emit);

    expect(events).toEqual([{ event: "flag.green.raised", data: {} }]);
  });
});

describe("diffFlags — yellow rework (issue #480)", () => {
  it("static local yellow emits flag.yellow.raised {local}", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Yellow), emit);

    expect(events).toEqual([{ event: "flag.yellow.raised", data: { scope: "local" } }]);
  });

  it("static full caution emits flag.yellow.raised {full}", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Caution), emit);

    expect(events).toEqual([{ event: "flag.yellow.raised", data: { scope: "full" } }]);
  });

  it("YellowWaving emits flag.yellow-waving.raised and NOT a static yellow{local}", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.YellowWaving), emit);

    expect(events).toEqual([{ event: "flag.yellow-waving.raised", data: {} }]);
    expect(events.some((e) => e.event === "flag.yellow.raised")).toBe(false);
  });

  it("CautionWaving emits flag.caution-waving.raised and NOT a static yellow{full}", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.CautionWaving), emit);

    expect(events).toEqual([{ event: "flag.caution-waving.raised", data: {} }]);
    expect(events.some((e) => e.event === "flag.yellow.raised")).toBe(false);
  });

  it("static→waving escalation fires the waving line and does NOT fire yellow.cleared", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.Yellow), () => {}); // static local established

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.YellowWaving), emit);

    expect(events.some((e) => e.event === "flag.yellow-waving.raised")).toBe(true);
    expect(events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);
  });

  it("clearing all yellow bits fires flag.yellow.cleared exactly once", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.YellowWaving), () => {}); // caution up

    const { events, emit } = collect();
    diffFlags(state, tick(0), emit);

    expect(events.filter((e) => e.event === "flag.yellow.cleared")).toHaveLength(1);

    // A subsequent all-clear tick does not re-fire.
    const second = collect();
    diffFlags(state, tick(0), second.emit);
    expect(second.events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);
  });
});
