/**
 * Unit tests for the flag diff translator.
 *
 * The high-level translator integration tests cover the canonical raised /
 * cleared paths for green/yellow/blue/red/etc. These tests focus on the
 * branches that are *not* covered there — specifically the off→on
 * transitions for the debris and meatball (Repair) bits — and on the
 * "first tick seeds without firing" gate that all flag emission depends
 * on. The yellow-cleared hold window (issue #671) and the furled debounce +
 * paired cleared (issue #669) are covered in full here.
 */
import { Flags, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffFlags, FURLED_DEBOUNCE_MS, YELLOW_CLEARED_HOLD_MS } from "./flags.js";
import type { PendingEvent } from "./types.js";

const T0 = 1_000_000;

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
    diffFlags(state, tick(Flags.Debris), T0, emit);

    expect(events).toEqual([{ event: "flag.debris.raised", data: {} }]);
  });

  it("does not re-emit while the bit stays on", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.Debris), T0, () => {});

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Debris), T0 + 100, emit);

    expect(events).toEqual([]);
  });
});

describe("diffFlags — meatball (Flags.Repair)", () => {
  it("emits flag.meatball.raised on the off→on transition", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Repair), T0, emit);

    expect(events).toEqual([{ event: "flag.meatball.raised", data: {} }]);
  });

  it("does not fire when only unrelated bits change", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Green), T0, emit);

    expect(events.some((e) => e.event === "flag.meatball.raised")).toBe(false);
  });
});

describe("diffFlags — first-tick seeding", () => {
  it("does not fire any event on the first tick, even when bits are set", () => {
    const state = createInitialState();
    expect(state.flagStateInitialized).toBe(false);

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Debris | Flags.Repair | Flags.Green), T0, emit);

    expect(events).toEqual([]);
    expect(state.flagStateInitialized).toBe(true);
  });

  it("seeds with the bits already on, then a follow-up off→on is suppressed (still on)", () => {
    const state = createInitialState();
    diffFlags(state, tick(Flags.Debris), T0, () => {}); // seed

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Debris), T0 + 100, emit);

    expect(events).toEqual([]);
  });
});

describe("diffFlags — new rising-edge bits (issue #480)", () => {
  // NOTE: "furled" is absent — its rising edge is debounced and gets its own
  // describe block below (issue #669).
  const cases: Array<[string, number, string]> = [
    ["dq-scoring-invalid", Flags.DqScoringInvalid, "flag.dq-scoring-invalid.raised"],
    ["crossed", Flags.Crossed, "flag.crossed.raised"],
    ["green-held", Flags.GreenHeld, "flag.green-held.raised"],
    ["ten-to-go", Flags.TenToGo, "flag.ten-to-go.raised"],
    ["five-to-go", Flags.FiveToGo, "flag.five-to-go.raised"],
  ];

  for (const [, bit, event] of cases) {
    it(`emits ${event} on the off→on transition`, () => {
      const state = createInitialState();
      state.flagStateInitialized = true;

      const { events, emit } = collect();
      diffFlags(state, tick(bit), T0, emit);

      expect(events).toEqual([{ event, data: {} }]);
    });

    it(`does not re-emit ${event} while the bit stays on`, () => {
      const state = createInitialState();
      state.flagStateInitialized = true;
      diffFlags(state, tick(bit), T0, () => {}); // seed-on

      const { events, emit } = collect();
      diffFlags(state, tick(bit), T0 + 100, emit);

      expect(events).toEqual([]);
    });

    it(`does not fire ${event} on the first tick even when the bit is set`, () => {
      const state = createInitialState();

      const { events, emit } = collect();
      diffFlags(state, tick(bit), T0, emit);

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
    diffFlags(state, tick(Flags.Disqualify), T0, emit);

    expect(events).toEqual([{ event: "flag.disqualify.raised", data: {} }]);
    expect(events.some((e) => e.event === "flag.black.raised")).toBe(false);
  });

  it("still emits flag.black.raised when the Black bit is set", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Black), T0, emit);

    expect(events).toEqual([{ event: "flag.black.raised", data: {} }]);
  });

  it("emits only flag.disqualify.raised (not black) when Black AND Disqualify are both set", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Black | Flags.Disqualify), T0, emit);

    expect(events).toEqual([{ event: "flag.disqualify.raised", data: {} }]);
  });
});

describe("diffFlags — green suppression at race start (issue #480)", () => {
  it("suppresses flag.green.raised when StartGo is set", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Green | Flags.StartGo), T0, emit);

    expect(events.some((e) => e.event === "flag.green.raised")).toBe(false);
  });

  it("suppresses flag.green.raised when StartSet is set (green leading StartGo by a tick)", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Green | Flags.StartSet), T0, emit);

    expect(events.some((e) => e.event === "flag.green.raised")).toBe(false);
  });

  it("fires flag.green.raised at a restart (Green rising, no StartGo)", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Green), T0, emit);

    expect(events).toEqual([{ event: "flag.green.raised", data: {} }]);
  });
});

describe("diffFlags — yellow rework (issue #480)", () => {
  it("static local yellow emits flag.yellow.raised {local}", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Yellow), T0, emit);

    expect(events).toEqual([{ event: "flag.yellow.raised", data: { scope: "local" } }]);
  });

  it("static full caution emits flag.yellow.raised {full}", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Caution), T0, emit);

    expect(events).toEqual([{ event: "flag.yellow.raised", data: { scope: "full" } }]);
  });

  it("YellowWaving emits flag.yellow-waving.raised and NOT a static yellow{local}", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.YellowWaving), T0, emit);

    expect(events).toEqual([{ event: "flag.yellow-waving.raised", data: {} }]);
    expect(events.some((e) => e.event === "flag.yellow.raised")).toBe(false);
  });

  it("CautionWaving emits flag.caution-waving.raised and NOT a static yellow{full}", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.CautionWaving), T0, emit);

    expect(events).toEqual([{ event: "flag.caution-waving.raised", data: {} }]);
    expect(events.some((e) => e.event === "flag.yellow.raised")).toBe(false);
  });

  it("static→waving escalation fires the waving line and does NOT fire yellow.cleared", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.Yellow), T0, () => {}); // static local established

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.YellowWaving), T0 + 100, emit);

    expect(events.some((e) => e.event === "flag.yellow-waving.raised")).toBe(true);
    expect(events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);

    // Even well past the hold window the escalated caution must not clear.
    const later = collect();
    diffFlags(state, tick(Flags.YellowWaving), T0 + 100 + YELLOW_CLEARED_HOLD_MS, later.emit);
    expect(later.events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);
  });
});

describe("diffFlags — yellow.cleared hold window (issue #671)", () => {
  it("does NOT emit cleared on the drop tick itself", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.YellowWaving), T0, () => {}); // caution up

    const { events, emit } = collect();
    diffFlags(state, tick(0), T0 + 100, emit);

    expect(events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);
  });

  it("emits cleared exactly once when the all-clear has held for YELLOW_CLEARED_HOLD_MS (boundary, >=)", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.YellowWaving), T0, () => {}); // caution up
    diffFlags(state, tick(0), T0 + 100, () => {}); // drop edge — hold starts

    // Mid-hold tick stays silent.
    const mid = collect();
    diffFlags(state, tick(0), T0 + 100 + YELLOW_CLEARED_HOLD_MS - 1, mid.emit);
    expect(mid.events).toEqual([]);

    // Exactly at the boundary (>=) it fires once.
    const { events, emit } = collect();
    diffFlags(state, tick(0), T0 + 100 + YELLOW_CLEARED_HOLD_MS, emit);
    expect(events.filter((e) => e.event === "flag.yellow.cleared")).toHaveLength(1);

    // A further all-clear tick does not re-fire.
    const after = collect();
    diffFlags(state, tick(0), T0 + 100 + YELLOW_CLEARED_HOLD_MS + 5000, after.emit);
    expect(after.events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);
  });

  it("a yellow-ish re-raise within the hold cancels the pending clear (and still fires raised)", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.YellowWaving), T0, () => {}); // caution up
    diffFlags(state, tick(0), T0 + 100, () => {}); // drop edge — hold starts

    // Re-raise inside the hold window — the flag left activeFlags on the drop,
    // so the rising edge fires a fresh raised AND cancels the pending clear.
    const reRaise = collect();
    diffFlags(state, tick(Flags.YellowWaving), T0 + 1000, reRaise.emit);
    expect(reRaise.events.some((e) => e.event === "flag.yellow-waving.raised")).toBe(true);
    expect(reRaise.events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);

    // Even after the original hold deadline, no cleared while the flag is up.
    const held = collect();
    diffFlags(state, tick(Flags.YellowWaving), T0 + 100 + YELLOW_CLEARED_HOLD_MS + 1000, held.emit);
    expect(held.events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);

    // Only the NEXT sustained drop clears.
    diffFlags(state, tick(0), T0 + 10_000, () => {}); // second drop edge
    const cleared = collect();
    diffFlags(state, tick(0), T0 + 10_000 + YELLOW_CLEARED_HOLD_MS, cleared.emit);
    expect(cleared.events.filter((e) => e.event === "flag.yellow.cleared")).toHaveLength(1);
  });

  it("waving-only sequence: YellowWaving → 0 → hold elapses → cleared (issue #671 regression)", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.YellowWaving), T0, () => {}); // waving up, no static bit
    diffFlags(state, tick(0), T0 + 100, () => {}); // zone passed — bit drops

    const { events, emit } = collect();
    diffFlags(state, tick(0), T0 + 100 + YELLOW_CLEARED_HOLD_MS, emit);

    expect(events).toEqual([{ event: "flag.yellow.cleared", data: {} }]);
  });

  it("first-tick seeding with yellow bits set does not schedule a phantom clear", () => {
    const state = createInitialState();
    expect(state.flagStateInitialized).toBe(false);

    diffFlags(state, tick(Flags.YellowWaving), T0, () => {}); // seed
    expect(state.yellowClearPendingSince).toBeNull();

    // Bits drop on the next tick — that's a real drop edge, hold starts there.
    diffFlags(state, tick(0), T0 + 100, () => {});

    // First-tick seeding WITHOUT yellow bits never pends either.
    const fresh = createInitialState();
    diffFlags(fresh, tick(0), T0, () => {}); // seed all-clear
    expect(fresh.yellowClearPendingSince).toBeNull();

    const { events, emit } = collect();
    diffFlags(fresh, tick(0), T0 + YELLOW_CLEARED_HOLD_MS, emit);
    expect(events.some((e) => e.event === "flag.yellow.cleared")).toBe(false);
  });
});

describe("diffFlags — furled debounce + paired cleared (issue #669)", () => {
  it("a flicker shorter than the debounce fires neither raised nor cleared", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Furled), T0, emit); // rising edge — arms only
    diffFlags(state, tick(0), T0 + 500, emit); // off-track flicker — bit drops inside the window
    diffFlags(state, tick(0), T0 + 500 + FURLED_DEBOUNCE_MS, emit); // well past the window

    expect(events).toEqual([]);
  });

  it("emits flag.furled.raised exactly once when the bit has stayed set for FURLED_DEBOUNCE_MS (boundary, >=)", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.Furled), T0, () => {}); // rising edge — arms

    // Mid-window tick stays silent.
    const mid = collect();
    diffFlags(state, tick(Flags.Furled), T0 + FURLED_DEBOUNCE_MS - 1, mid.emit);
    expect(mid.events).toEqual([]);

    // Exactly at the boundary (>=) it fires once.
    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Furled), T0 + FURLED_DEBOUNCE_MS, emit);
    expect(events).toEqual([{ event: "flag.furled.raised", data: {} }]);

    // Further ticks with the bit still set emit nothing more.
    const after = collect();
    diffFlags(state, tick(Flags.Furled), T0 + FURLED_DEBOUNCE_MS + 5000, after.emit);
    expect(after.events).toEqual([]);
  });

  it("emits flag.furled.cleared exactly once when an announced furled is withdrawn", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.Furled), T0, () => {}); // arm
    diffFlags(state, tick(Flags.Furled), T0 + FURLED_DEBOUNCE_MS, () => {}); // announce

    const { events, emit } = collect();
    diffFlags(state, tick(0), T0 + 5000, emit); // falling edge
    expect(events).toEqual([{ event: "flag.furled.cleared", data: {} }]);

    // A further all-clear tick does not re-fire.
    const after = collect();
    diffFlags(state, tick(0), T0 + 10_000, after.emit);
    expect(after.events).toEqual([]);
  });

  it("a clear during the debounce window drops the pending announce — the falling edge emits no cleared", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.Furled), T0, () => {}); // arm

    const { events, emit } = collect();
    diffFlags(state, tick(0), T0 + 500, emit); // falling edge inside the window
    expect(events).toEqual([]);
    expect(state.furledPendingAt).toBe(0);
    expect(state.furledAnnounced).toBe(false);

    // Nothing fires later either — the episode never announced.
    const later = collect();
    diffFlags(state, tick(0), T0 + 500 + FURLED_DEBOUNCE_MS, later.emit);
    expect(later.events).toEqual([]);
  });

  it("announces again after cleared → re-raise with a fresh debounce window (fresh episode)", () => {
    const state = createInitialState();
    state.flagStateInitialized = true;
    diffFlags(state, tick(Flags.Furled), T0, () => {}); // arm
    diffFlags(state, tick(Flags.Furled), T0 + FURLED_DEBOUNCE_MS, () => {}); // announce
    diffFlags(state, tick(0), T0 + 5000, () => {}); // falling edge — cleared fires

    // Re-raise — the fresh episode needs a fresh debounce window.
    diffFlags(state, tick(Flags.Furled), T0 + 10_000, () => {}); // re-arm
    const mid = collect();
    diffFlags(state, tick(Flags.Furled), T0 + 10_000 + FURLED_DEBOUNCE_MS - 1, mid.emit);
    expect(mid.events).toEqual([]);

    const raised = collect();
    diffFlags(state, tick(Flags.Furled), T0 + 10_000 + FURLED_DEBOUNCE_MS, raised.emit);
    expect(raised.events).toEqual([{ event: "flag.furled.raised", data: {} }]);

    // ...and a second cleared after that.
    const cleared = collect();
    diffFlags(state, tick(0), T0 + 20_000, cleared.emit);
    expect(cleared.events).toEqual([{ event: "flag.furled.cleared", data: {} }]);
  });

  it("connecting mid-furled seeds silently — no raised after the debounce, no cleared on the later drop", () => {
    const state = createInitialState();
    expect(state.flagStateInitialized).toBe(false);

    const { events, emit } = collect();
    diffFlags(state, tick(Flags.Furled), T0, emit); // first tick — seed without firing
    diffFlags(state, tick(Flags.Furled), T0 + FURLED_DEBOUNCE_MS, emit);
    diffFlags(state, tick(Flags.Furled), T0 + FURLED_DEBOUNCE_MS + 5000, emit);
    diffFlags(state, tick(0), T0 + 20_000, emit); // later falling edge

    expect(events).toEqual([]);
  });
});
