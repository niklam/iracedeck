/**
 * Unit tests for the pit-service toggle diff's auto-fuel attribution
 * (issue #474).
 *
 * A settled `FuelFill` flip is announced as `pitService.autoFuelChanged`
 * when `dpFuelAutoFillActive` reads active on the tick the flip settles, and
 * as `pitService.toggled { service: "fuel" }` otherwise — exactly one of the
 * two per settled flip. The settling tick is the only read: what the flag
 * said when the flip began, or on the quiet ticks in between, does not count.
 * The silent seed paths (first tick, off track, in the pit stall) still
 * absorb every flip, and windshield and fast repair never read the flag.
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
  describe("a flip that settles with auto-fuel armed", () => {
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

    it("the captured takeover: auto-fuel re-arms and clears the driver's fuel request in the same tick", () => {
      // The driver had asked for fuel with auto-fuel off; at pit approach the
      // sim arms auto-fuel (0 → 1) and drops the request in that very tick,
      // and the flag then stays armed well past the window.
      const state = seeded(PitSvFlags.FuelFill, 0);

      expect(feed(state, T_ARM, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_ARM + 100, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: 0, auto: 1 })).toEqual([AUTO_NO_REFUEL]);
    });

    it("is auto-fuel's even when the flag came on only after the flip began", () => {
      const state = seeded(0, 0);

      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([AUTO_REFUEL]);
    });

    it("advances the baseline exactly as a manual toggle does — the settled state is not re-announced", () => {
      const state = seeded(0, 1);
      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });
      feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 });

      expect(state.lastPitSvFlags & PitSvFlags.FuelFill).toBe(PitSvFlags.FuelFill);
      expect(feed(state, T_SETTLE + 1_000, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    });

    it("announces each settled flip of a cycling bit once, as auto-fuel's", () => {
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

  describe("a flip that settles with auto-fuel not armed", () => {
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

    it("is the driver's toggle when auto-fuel was armed as the flip began but off when it settled", () => {
      const state = seeded(0, 1);

      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([MANUAL_FUEL_ON]);
    });

    it("ignores the flag on the quiet ticks inside the window", () => {
      const state = seeded(PitSvFlags.FuelFill, 0);

      feed(state, T_ARM, { flags: 0, auto: 0 });
      expect(feed(state, T_ARM + 100, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_ARM + 200, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: 0, auto: 0 })).toEqual([MANUAL_FUEL_OFF]);
    });
  });

  describe("flips that never settle, or are seeded", () => {
    it("a flip reverted inside the window emits nothing, and the next flip is judged on its own", () => {
      const state = seeded(0, 0);

      expect(feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_ARM + 100, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_ARM + 1_000, { flags: 0, auto: 0 })).toEqual([]);

      const t = T_ARM + 2_000;
      expect(feed(state, t, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([
        MANUAL_FUEL_ON,
      ]);
    });

    it("pit-stall ticks seed silently with auto-fuel armed, and a flip on the first tick back is judged fresh", () => {
      const state = seeded(0, 0);
      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });

      expect(feed(state, T_ARM + 100, { flags: PitSvFlags.FuelFill, auto: 1, inStall: true })).toEqual([]);
      expect(feed(state, T_ARM + 1_000, { flags: 0, auto: 1, inStall: true })).toEqual([]);
      expect(state.fuelDebounce).toEqual({ pendingAt: 0, lastSeen: false });

      const t = T_ARM + 5_000;
      feed(state, t, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([
        MANUAL_FUEL_ON,
      ]);
    });

    it("off-track ticks seed silently with auto-fuel armed, and a flip on the first tick back is judged fresh", () => {
      const state = seeded(0, 0);
      feed(state, T_ARM, { flags: PitSvFlags.FuelFill, auto: 1 });

      expect(feed(state, T_ARM + 100, { flags: PitSvFlags.FuelFill, auto: 1, onTrack: false })).toEqual([]);
      expect(feed(state, T_ARM + 1_000, { flags: 0, auto: 1, onTrack: false })).toEqual([]);
      expect(state.fuelDebounce).toEqual({ pendingAt: 0, lastSeen: false });

      const t = T_ARM + 5_000;
      feed(state, t, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([
        MANUAL_FUEL_ON,
      ]);
    });

    it("the first tick seeds silently with auto-fuel armed and the fuel bit set", () => {
      const state = createInitialState();

      expect(feed(state, 0, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(state.fuelDebounce).toEqual({ pendingAt: 0, lastSeen: true });
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
