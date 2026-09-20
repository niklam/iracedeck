/**
 * Unit tests for the auto-fuel half of the pit-service toggle diff
 * (issue #474).
 *
 * What is announced is auto-fuel being SWITCHED on or off
 * (`pitService.autoFuelSwitched { on, refuel }`), debounced in the same
 * 300 ms window the fuel bit uses so a fuel flip settling inside it is folded
 * into that one line. What is NOT announced is the fuel bit moving while
 * auto-fuel is armed, in either direction: the sim writes that bit itself and
 * telemetry carries no source, so a confirmation there would be the phantom
 * "got it" the issue was filed about. A switch is ignored (and its baseline
 * re-seeded) from pit road onward, where the stop consumes auto-fuel itself,
 * as well as on the existing silent paths — first tick, off track, in the
 * stall.
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
  onPitRoad?: boolean;
};

function feed(
  state: TranslatorState,
  now: number,
  { flags = 0, auto, onTrack = true, inStall = false, onPitRoad = false }: Tick = {},
) {
  const events: PendingEvent[] = [];
  const telemetry = {
    PitSvFlags: flags,
    IsOnTrack: onTrack,
    PlayerCarInPitStall: inStall,
    OnPitRoad: onPitRoad,
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

const T_EDGE = 1_000;
const T_SETTLE = T_EDGE + PIT_SERVICE_DEBOUNCE_MS;

const switched = (on: boolean, refuel: boolean) =>
  ({ event: "pitService.autoFuelSwitched", data: { on, refuel } }) as const;
const MANUAL_FUEL_ON = { event: "pitService.toggled", data: { service: "fuel", on: true } } as const;
const MANUAL_FUEL_OFF = { event: "pitService.toggled", data: { service: "fuel", on: false } } as const;

describe("diffToggles — auto-fuel (issue #474)", () => {
  describe("auto-fuel switched on or off", () => {
    it("announces the switch on with the fuel request it leaves set", () => {
      const state = seeded(PitSvFlags.FuelFill, 0);

      expect(feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([switched(true, true)]);
    });

    it("the captured takeover: auto-fuel arms and clears the driver's request in one tick", () => {
      // Pit approach, still off pit road: the sim arms auto-fuel (0 → 1) and
      // drops the manual fuel request in that very tick. Exactly one event —
      // the fuel flip is folded into it, not announced on its own.
      const state = seeded(PitSvFlags.FuelFill, 0);

      expect(feed(state, T_EDGE, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_EDGE + 100, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: 0, auto: 1 })).toEqual([switched(true, false)]);
    });

    it("announces the switch off with the fuel request left SET", () => {
      // Auto-fuel had fuelling on, so switching it off leaves the ordinary
      // request standing — the whole reason `refuel` rides on this event.
      const state = seeded(PitSvFlags.FuelFill, 1);

      feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([switched(false, true)]);
    });

    it("announces the switch off with the fuel request left CLEAR", () => {
      const state = seeded(0, 1);

      feed(state, T_EDGE, { flags: 0, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: 0, auto: 0 })).toEqual([switched(false, false)]);
    });

    it("reads `refuel` as the request stands when the switch settles, not when it began", () => {
      const state = seeded(0, 1);

      // Switching off; the request comes up while the switch is still pending.
      feed(state, T_EDGE, { flags: 0, auto: 0 });
      expect(feed(state, T_EDGE + 100, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([switched(false, true)]);
    });

    it("says nothing for a switch that reverts inside the window, and the next one still lands", () => {
      const state = seeded(0, 0);

      expect(feed(state, T_EDGE, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_EDGE + 100, { flags: 0, auto: 0 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: 0, auto: 0 })).toEqual([]);

      const t = T_EDGE + 5_000;
      expect(feed(state, t, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: 0, auto: 1 })).toEqual([switched(true, false)]);
    });

    it("announces each settled switch of a cycling flag once", () => {
      const state = seeded(0, 0);
      const events: PendingEvent[] = [];
      let t = T_EDGE;

      for (const auto of [1, 0, 1]) {
        events.push(...feed(state, t, { auto }));
        events.push(...feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { auto }));
        t += 5_000;
      }

      expect(events).toEqual([switched(true, false), switched(false, false), switched(true, false)]);
    });

    it("says nothing while the flag holds steady, armed or not", () => {
      const state = seeded(PitSvFlags.FuelFill, 1);

      expect(feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE + 5_000, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    });
  });

  describe("the fuel bit while auto-fuel is armed", () => {
    it("says nothing when the request comes on", () => {
      const state = seeded(0, 1);

      expect(feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    });

    it("says nothing when the request goes off", () => {
      const state = seeded(PitSvFlags.FuelFill, 1);

      expect(feed(state, T_EDGE, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: 0, auto: 1 })).toEqual([]);
    });

    it("advances the baseline through the silence, so the flip is not announced later", () => {
      const state = seeded(0, 1);
      feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 1 });
      feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 });

      expect(state.lastPitSvFlags & PitSvFlags.FuelFill).toBe(PitSvFlags.FuelFill);

      // Auto-fuel goes off later; the request it leaves set is reported by the
      // switch, and the bit that moved while armed is never re-announced.
      const t = T_SETTLE + 5_000;
      feed(state, t, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, t + PIT_SERVICE_DEBOUNCE_MS, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([
        switched(false, true),
      ]);
    });

    it("still announces a fuel flip made with auto-fuel never armed", () => {
      const state = seeded(0, 0);

      feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([MANUAL_FUEL_ON]);
    });

    it("still announces a fuel flip when the field is absent entirely", () => {
      const state = seeded(PitSvFlags.FuelFill);

      feed(state, T_EDGE, { flags: 0 });
      expect(feed(state, T_SETTLE, { flags: 0 })).toEqual([MANUAL_FUEL_OFF]);
    });

    it("folds a fuel flip that settles inside a switch-off window into the one line", () => {
      // Auto-fuel goes off and the request is cleared in the same tick: one
      // event, not a switch plus a fuel toggle.
      const state = seeded(PitSvFlags.FuelFill, 1);

      expect(feed(state, T_EDGE, { flags: 0, auto: 0 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: 0, auto: 0 })).toEqual([switched(false, false)]);
      expect(feed(state, T_SETTLE + 1_000, { flags: 0, auto: 0 })).toEqual([]);
    });
  });

  describe("gates: the switch is ignored and its baseline re-seeded", () => {
    it("on pit road, and leaving pit road afterwards does not fire it", () => {
      const state = seeded(PitSvFlags.FuelFill, 1);

      // The stop consumes auto-fuel: the flag drops while on pit road.
      expect(feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 0, onPitRoad: true })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0, onPitRoad: true })).toEqual([]);

      // Back out on track with the flag still down — the drop is gone, not deferred.
      expect(feed(state, T_SETTLE + 5_000, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, T_SETTLE + 6_000, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
    });

    it("but a fuel toggle on pit road is still the driver's, when auto-fuel is not armed", () => {
      const state = seeded(0, 0);

      feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 0, onPitRoad: true });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0, onPitRoad: true })).toEqual([
        MANUAL_FUEL_ON,
      ]);
    });

    it("in the pit stall", () => {
      const state = seeded(0, 1);

      expect(feed(state, T_EDGE, { auto: 0, inStall: true })).toEqual([]);
      expect(feed(state, T_SETTLE, { auto: 0, inStall: true })).toEqual([]);
      expect(state.autoFuelBaseline).toBe(false);
      expect(feed(state, T_SETTLE + 5_000, { auto: 0 })).toEqual([]);
    });

    it("off track", () => {
      const state = seeded(0, 1);

      expect(feed(state, T_EDGE, { auto: 0, onTrack: false })).toEqual([]);
      expect(feed(state, T_SETTLE, { auto: 0, onTrack: false })).toEqual([]);
      expect(state.autoFuelBaseline).toBe(false);
      expect(feed(state, T_SETTLE + 5_000, { auto: 0 })).toEqual([]);
    });

    it("on the first tick, armed", () => {
      const state = createInitialState();

      expect(feed(state, 0, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(state.autoFuelBaseline).toBe(true);
      expect(feed(state, 1_000, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    });

    it("mid-switch, dropping the pending change", () => {
      const state = seeded(0, 0);

      expect(feed(state, T_EDGE, { auto: 1 })).toEqual([]);
      expect(feed(state, T_EDGE + 100, { auto: 1, onPitRoad: true })).toEqual([]);
      expect(state.autoFuelDebounce.pendingAt).toBe(0);
      expect(feed(state, T_SETTLE, { auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE + 5_000, { auto: 1 })).toEqual([]);
    });
  });

  describe("windshield and fast repair ignore auto-fuel", () => {
    it("a windshield flip with auto-fuel armed is still the driver's toggle", () => {
      const state = seeded(0, 1);

      feed(state, T_EDGE, { flags: PitSvFlags.WindshieldTearoff, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.WindshieldTearoff, auto: 1 })).toEqual([
        { event: "pitService.toggled", data: { service: "windshield", on: true } },
      ]);
    });

    it("a fast-repair flip settling inside a switch window is still the driver's toggle", () => {
      const state = seeded(PitSvFlags.FastRepair, 0);

      feed(state, T_EDGE, { flags: 0, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: 0, auto: 1 })).toEqual([
        switched(true, false),
        { event: "pitService.toggled", data: { service: "fastRepair", on: false } },
      ]);
    });
  });
});
