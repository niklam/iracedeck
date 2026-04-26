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
