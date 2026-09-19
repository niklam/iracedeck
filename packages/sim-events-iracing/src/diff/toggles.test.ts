/**
 * Unit tests for the pit-service toggle diff's auto-fuel attribution
 * (issue #474).
 *
 * A settled `FuelFill` flip is announced as `pitService.autoFuelChanged`
 * when `dpFuelAutoFillActive` read active on the tick the pending flip was
 * armed OR on the tick it settled, and as `pitService.toggled { service:
 * "fuel" }` otherwise — exactly one of the two per settled flip. The latch
 * belongs to the pending episode, so a reverted flip and the silent seed
 * paths (first tick, off track, in the pit stall) both clear it. Windshield
 * and fast-repair never read the flag.
 *
 * The broader toggle behaviour (tires, compound, car controls, the stall
 * seed) is covered end-to-end in `translator.test.ts`.
 */
import { PitSvFlags, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffToggles, PIT_SERVICE_DEBOUNCE_MS } from "./toggles.js";
import type { PendingEvent } from "./types.js";

type Tick = {
  flags?: number;
  /** `undefined` omits the field entirely — the older-telemetry case. */
  auto?: number;
  onTrack?: boolean;
  inStall?: boolean;
};

function feed(state: TranslatorState, now: number, { flags = 0, auto, onTrack = true, inStall = false }: Tick = {}) {
  const events: PendingEvent[] = [];
  const telemetry = {
    PitSvFlags: flags,
    IsOnTrack: onTrack,
    PlayerCarInPitStall: inStall,
    ...(auto === undefined ? {} : { dpFuelAutoFillActive: auto }),
  } as TelemetryData;
  diffToggles(state, telemetry, now, (e) => events.push(e));

  return events;
}

/** A state seeded on track with the given flags (and auto-fuel reading), at t=0. */
function seeded(flags = 0, auto?: number): TranslatorState {
  const state = createInitialState();
  expect(feed(state, 0, { flags, auto })).toEqual([]);

  return state;
}

const T_ARM = 1_000;
const T_SETTLE = T_ARM + PIT_SERVICE_DEBOUNCE_MS;

const AUTO_REFUEL = { event: "pitService.autoFuelChanged", data: { refuel: true } } as const;
const AUTO_NO_REFUEL = { event: "pitService.autoFuelChanged", data: { refuel: false } } as const;
const MANUAL_FUEL_ON = { event: "pitService.toggled", data: { service: "fuel", on: true } } as const;
const MANUAL_FUEL_OFF = { event: "pitService.toggled", data: { service: "fuel", on: false } } as const;

describe("diffToggles — auto-fuel attribution (issue #474)", () => {
  describe("a sim flip with auto-fuel armed at both ticks", () => {
    it("announces a flip on as autoFuelChanged { refuel: true } and no fuel toggle", () => {
      const state = seeded(0, 1);

      expect(feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([AUTO_REFUEL]);
    });

    it("announces a flip off as autoFuelChanged { refuel: false } and no fuel toggle", () => {
      const state = seeded(PitSvFlags.FuelFill, 1);

      expect(feed(state, T_ARM, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: 0, auto: 1 })).toEqual([AUTO_NO_REFUEL]);
    });

    it("advances the baseline exactly as a manual toggle does — the settled state is not re-announced", () => {
      const state = seeded(0, 1);
      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });
      feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 });

      expect(state.lastPitSvFlags & PitSvFlags.FuelFill).toBe(PitSvFlags.FuelFill);
      expect(state.fuelDebounce.autoFuelArmed).toBe(false);
      expect(feed(state, T_SETTLE + 1_000, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    });

    it("announces each settled flip of a cycling bit once, as auto", () => {
      const state = seeded(0, 1);
      const events: PendingEvent[] = [];
      let t = T_ARM;

      for (const flags of [PitSvFlags.FuelFill, 0, PitSvFlags.FuelFill]) {
        events.push(...feed(state, t, { flags, auto: 1 }));
        events.push(...feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags, auto: 1 }));
        t += 5_000;
      }

      expect(events).toEqual([AUTO_REFUEL, AUTO_NO_REFUEL, AUTO_REFUEL]);
    });
  });

  describe("a manual flip with auto-fuel not armed", () => {
    it("announces a flip on as the fuel toggle and no autoFuelChanged", () => {
      const state = seeded(0, 0);

      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([MANUAL_FUEL_ON]);
    });

    it("announces a flip off as the fuel toggle and no autoFuelChanged", () => {
      const state = seeded(PitSvFlags.FuelFill, 0);

      feed(state, T_ARM, { flags: 0, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: 0, auto: 0 })).toEqual([MANUAL_FUEL_OFF]);
    });

    it("reads an absent dpFuelAutoFillActive field as not armed", () => {
      const state = seeded(0);

      feed(state, T_ARM, { flags: PitSvFlags.FuelFill });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill })).toEqual([MANUAL_FUEL_ON]);
    });
  });

  describe("auto-fuel armed at only one of the two ticks — ties fail towards auto", () => {
    it("is auto when the flag was set only on the arming tick (flip on)", () => {
      const state = seeded(0, 0);

      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(state.fuelDebounce.autoFuelArmed).toBe(true);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([AUTO_REFUEL]);
    });

    it("is auto when the flag was set only on the settling tick (flip on)", () => {
      const state = seeded(0, 0);

      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(state.fuelDebounce.autoFuelArmed).toBe(false);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([AUTO_REFUEL]);
    });

    it("is auto when the flag was set only on the arming tick (flip off)", () => {
      const state = seeded(PitSvFlags.FuelFill, 0);

      feed(state, T_ARM, { flags: 0, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: 0, auto: 0 })).toEqual([AUTO_NO_REFUEL]);
    });

    it("is auto when the flag was set only on the settling tick (flip off)", () => {
      const state = seeded(PitSvFlags.FuelFill, 0);

      feed(state, T_ARM, { flags: 0, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: 0, auto: 1 })).toEqual([AUTO_NO_REFUEL]);
    });

    it("keeps the arming tick's reading across the quiet ticks of the window", () => {
      const state = seeded(0, 0);

      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(feed(state, T_ARM + 100, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, T_ARM + 200, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([AUTO_REFUEL]);
    });
  });

  describe("the latch belongs to its pending episode", () => {
    it("a flip reverted inside the window emits nothing and its latch does not attribute the next, manual flip", () => {
      const state = seeded(0, 0);

      // Auto-armed flip, cancelled before it settles.
      expect(feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_ARM + 100, { flags: 0, auto: 0 })).toEqual([]);
      expect(state.fuelDebounce.autoFuelArmed).toBe(false);
      expect(feed(state, T_ARM + 1_000, { flags: 0, auto: 0 })).toEqual([]);

      // A clean manual flip afterwards is the driver's.
      const t = T_ARM + 2_000;
      expect(feed(state, t, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([
        MANUAL_FUEL_ON,
      ]);
    });

    it("clears after the settled emit, so the very next flip is judged on its own ticks", () => {
      const state = seeded(0, 1);
      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([AUTO_REFUEL]);
      expect(state.fuelDebounce.autoFuelArmed).toBe(false);

      // Auto-fuel disarmed and the driver clears fuel on the very next tick —
      // no stable tick in between that would clear the latch on its own.
      const t = T_SETTLE + 100;
      expect(feed(state, t, { flags: 0, auto: 0 })).toEqual([]);
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: 0, auto: 0 })).toEqual([MANUAL_FUEL_OFF]);
    });

    it("a pit-stall tick seeds silently, even with auto-fuel armed, and clears the latch", () => {
      const state = seeded(0, 0);
      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(state.fuelDebounce.autoFuelArmed).toBe(true);

      // Into the stall: the crew's and the sim's bit changes are absorbed.
      expect(feed(state, T_ARM + 100, { flags: PitSvFlags.FuelFill, auto: 1, inStall: true })).toEqual([]);
      expect(feed(state, T_ARM + 1_000, { flags: 0, auto: 1, inStall: true })).toEqual([]);
      expect(state.fuelDebounce).toEqual({ pendingAt: 0, lastSeen: false, autoFuelArmed: false });

      // Out of the stall, a manual flip on the first tick back is the
      // driver's — the pre-stall latch is gone (no stable tick in between).
      const t = T_ARM + 5_000;
      feed(state, t, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([
        MANUAL_FUEL_ON,
      ]);
    });

    it("an off-track tick seeds silently, even with auto-fuel armed, and clears the latch", () => {
      const state = seeded(0, 0);
      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });

      expect(feed(state, T_ARM + 100, { flags: PitSvFlags.FuelFill, auto: 1, onTrack: false })).toEqual([]);
      expect(feed(state, T_ARM + 1_000, { flags: 0, auto: 1, onTrack: false })).toEqual([]);
      expect(state.fuelDebounce.autoFuelArmed).toBe(false);

      // Back on track, flipping on the first tick.
      const t = T_ARM + 5_000;
      feed(state, t, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([
        MANUAL_FUEL_ON,
      ]);
    });

    it("the first tick seeds silently with auto-fuel armed and the fuel bit set", () => {
      const state = createInitialState();

      expect(feed(state, 0, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(state.fuelDebounce).toEqual({ pendingAt: 0, lastSeen: true, autoFuelArmed: false });
      expect(feed(state, 1_000, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    });
  });

  it("arming or disarming auto-fuel with the fuel bit unchanged publishes nothing", () => {
    const state = seeded(PitSvFlags.FuelFill, 0);

    expect(feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    expect(feed(state, T_SETTLE + 1_000, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
    expect(feed(state, T_SETTLE + 2_000, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
  });

  describe("windshield and fast repair ignore auto-fuel", () => {
    it("a windshield flip with auto-fuel armed is still the driver's toggle", () => {
      const state = seeded(0, 1);

      feed(state, T_ARM, { flags: PitSvFlags.WindshieldTearoff, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.WindshieldTearoff, auto: 1 })).toEqual([
        { event: "pitService.toggled", data: { service: "windshield", on: true } },
      ]);
    });

    it("a fast-repair flip with auto-fuel armed is still the driver's toggle", () => {
      const state = seeded(PitSvFlags.FastRepair, 1);

      feed(state, T_ARM, { flags: 0, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: 0, auto: 1 })).toEqual([
        { event: "pitService.toggled", data: { service: "fastRepair", on: false } },
      ]);
    });

    it("fuel and windshield settling together with auto-fuel armed: one auto-fuel event, one windshield toggle", () => {
      const state = seeded(0, 1);
      const both = PitSvFlags.FuelFill | PitSvFlags.WindshieldTearoff;

      feed(state, T_ARM, { flags: both, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: both, auto: 1 })).toEqual([
        AUTO_REFUEL,
        { event: "pitService.toggled", data: { service: "windshield", on: true } },
      ]);
    });
  });
});
