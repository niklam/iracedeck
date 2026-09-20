/**
 * Unit tests for the auto-fuel half of the pit-service toggle diff
 * (issue #474).
 *
 * What is announced is auto-fuel being SWITCHED on or off
 * (`pitService.autoFuelSwitched { on, refuel }`), debounced in the same
 * 300 ms window the fuel bit uses. Both reads that decide what is said are of
 * SETTLED values: the fuel bit's silence asks the debounced armed state (plus
 * a switch settling on that very tick), and `refuel` is the settled fuel
 * request the switch leaves behind.
 *
 * What is NOT announced is the fuel bit moving while auto-fuel is armed, in
 * either direction: the sim writes that bit itself and telemetry carries no
 * source, so a confirmation there would be the phantom "got it" the issue was
 * filed about. Two settled changes still make two lines — a switch and a
 * press a few hundred ms later are two separate actions.
 *
 * A switch that ARMS on pit road is dropped and its baseline re-seeded (the
 * stop consumes auto-fuel itself); one that armed before pit road still
 * lands. The other silent paths — first tick, off track, in the stall — are
 * unchanged.
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
      // Auto-fuel had fueling on, so switching it off leaves the ordinary
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

    it("waits for a press that lags the switch, then says it in one line", () => {
      // Auto-fuel switched off at t0; the driver asks for fuel 120 ms later,
      // so at the switch's own settle the request is mid-window. Announcing
      // there would say "not refueling" about a plan 120 ms from being the
      // opposite.
      const state = seeded(0, 1);

      feed(state, T_EDGE, { flags: 0, auto: 0 });
      expect(feed(state, T_EDGE + 120, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, T_EDGE + 419, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);

      // The press settles: ONE line, carrying both facts. The fuel
      // confirmation is suppressed — it would land on this same tick, in the
      // same family, and be cut mid-word by this one.
      expect(feed(state, T_EDGE + 420, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([switched(false, true)]);
      expect(feed(state, T_EDGE + 1_000, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
    });

    it("releases the held line when the press is taken back, with the plan unchanged", () => {
      // Auto-fuel off at t0; a press at t0+280 is taken back at t0+310. The
      // line must still be said — releasing only on a SETTLE would lose it
      // altogether — and must report the request that actually stands.
      const state = seeded(0, 1);

      feed(state, T_EDGE, { flags: 0, auto: 0 });
      expect(feed(state, T_EDGE + 280, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);

      expect(feed(state, T_EDGE + 310, { flags: 0, auto: 0 })).toEqual([switched(false, false)]);
      expect(feed(state, T_EDGE + 1_000, { flags: 0, auto: 0 })).toEqual([]);
    });

    it("waits for a press that armed after the switch and settles after it too", () => {
      // Auto-fuel armed at t0, fuel pressed on at t0+100. The switch settles
      // at t0+300 with the request still reading its old value, and the press
      // that follows is silent because auto-fuel is armed by then — so a line
      // said at t0+300 would be the only line, and the opposite of the plan.
      const state = seeded(0, 0);

      expect(feed(state, T_EDGE, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_EDGE + 100, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);

      expect(feed(state, T_EDGE + 400, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([switched(true, true)]);
      expect(feed(state, T_EDGE + 1_000, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
    });

    it("says the same case with the press taken back, reporting no refuel", () => {
      const state = seeded(0, 0);

      feed(state, T_EDGE, { flags: 0, auto: 1 });
      feed(state, T_EDGE + 100, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);

      expect(feed(state, T_EDGE + 350, { flags: 0, auto: 1 })).toEqual([switched(true, false)]);
      expect(feed(state, T_EDGE + 1_000, { flags: 0, auto: 1 })).toEqual([]);
    });

    it("a later switch settling over a held one replaces it", () => {
      // Reachable only when ticks are sparse — a hitch, a paused sim. At a
      // steady 60 Hz the hold is always released before a second switch could
      // settle, since a hold lives only while the request is pending and the
      // request resolves within its own 300 ms. Here the 1400 → 1700 gap
      // delays the request's settle onto the tick the second switch lands on,
      // and what the driver is owed is where auto-fuel ENDED UP.
      const state = seeded(0, 0);

      feed(state, 1_000, { flags: 0, auto: 1 });
      expect(feed(state, 1_300, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(state.autoFuelSwitchHeld).toBe(true);

      // Auto-fuel back off while the request is still mid-window…
      expect(feed(state, 1_400, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);

      // …and both land on the same tick after the gap: the newer switch wins.
      expect(feed(state, 1_700, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([switched(false, true)]);
      expect(state.autoFuelSwitchHeld).toBeNull();
      expect(feed(state, 3_000, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
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

    it("still confirms the press when the armed flag only blips for one tick", () => {
      // Auto-fuel is off. The flag reads 1 on the very tick the driver's press
      // settles and is 0 again next tick — a blip ARMS a switch but settles
      // nothing, so it must not swallow the press: silencing it there would
      // leave the driver with no line at all, since no switch ever lands.
      const state = seeded(0, 0);

      feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([MANUAL_FUEL_ON]);
      expect(feed(state, T_SETTLE + 10, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
      expect(feed(state, T_SETTLE + 1_000, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([]);
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

    it("but a switch already HELD survives onto pit road and is announced there", () => {
      // It settled off pit road — the decision was made and confirmed there,
      // and the hold is only waiting for an accurate `refuel`. Dropping it
      // would silence a decision the driver made, which is the failure the
      // "where it started" rule exists to prevent.
      const state = seeded(0, 0);

      feed(state, T_EDGE, { flags: 0, auto: 1 });
      feed(state, T_EDGE + 100, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(state.autoFuelSwitchHeld).toBe(true);

      // Onto pit road with the press still mid-window, then it settles.
      expect(feed(state, T_SETTLE + 50, { flags: PitSvFlags.FuelFill, auto: 1, onPitRoad: true })).toEqual([]);
      expect(feed(state, T_EDGE + 400, { flags: PitSvFlags.FuelFill, auto: 1, onPitRoad: true })).toEqual([
        switched(true, true),
      ]);
      expect(state.autoFuelSwitchHeld).toBeNull();
    });

    it("in the pit stall, which also drops a held switch", () => {
      const state = seeded(0, 0);

      feed(state, T_EDGE, { flags: 0, auto: 1 });
      feed(state, T_EDGE + 100, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(state.autoFuelSwitchHeld).toBe(true);

      // The stall is a reset of the world, not a rule about one event.
      expect(feed(state, T_SETTLE + 10, { flags: PitSvFlags.FuelFill, auto: 1, inStall: true })).toEqual([]);
      expect(state.autoFuelSwitchHeld).toBeNull();
      expect(feed(state, T_EDGE + 400, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(feed(state, T_EDGE + 2_000, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
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

    it("but NOT one that armed before pit road — that one still lands", () => {
      // The gate is on where the change STARTED. Pit approach can be under
      // 300 ms from pit road on a short track, and on a dirt oval the approach
      // IS the drive-in edge, so a takeover that armed off pit road must still
      // be announced when it settles a few ticks later on pit road.
      const state = seeded(PitSvFlags.FuelFill, 0);

      expect(feed(state, T_EDGE, { flags: 0, auto: 1 })).toEqual([]);
      expect(feed(state, T_EDGE + 100, { flags: 0, auto: 1, onPitRoad: true })).toEqual([]);
      expect(state.autoFuelDebounce.pendingAt).toBe(T_EDGE);
      expect(feed(state, T_SETTLE, { flags: 0, auto: 1, onPitRoad: true })).toEqual([switched(true, false)]);

      // And once it has settled, the gate takes over again: the stop's own
      // consumption of auto-fuel on pit road stays silent.
      expect(feed(state, T_SETTLE + 1_000, { flags: 0, auto: 0, onPitRoad: true })).toEqual([]);
      expect(feed(state, T_SETTLE + 2_000, { flags: 0, auto: 0, onPitRoad: true })).toEqual([]);
      expect(state.autoFuelBaseline).toBe(false);
    });
  });

  describe("fuelPlanChangedThisTick — the recap's signal for a silent change", () => {
    it("is set on the tick a silenced fuel change settles, and only that tick", () => {
      const state = seeded(0, 1);

      feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(state.fuelPlanChangedThisTick).toBe(false);

      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 1 })).toEqual([]);
      expect(state.fuelPlanChangedThisTick).toBe(true);

      feed(state, T_SETTLE + 10, { flags: PitSvFlags.FuelFill, auto: 1 });
      expect(state.fuelPlanChangedThisTick).toBe(false);
    });

    it("is set for an announced fuel change too, and cleared by a seeding tick", () => {
      const state = seeded(0, 0);

      feed(state, T_EDGE, { flags: PitSvFlags.FuelFill, auto: 0 });
      expect(feed(state, T_SETTLE, { flags: PitSvFlags.FuelFill, auto: 0 })).toEqual([MANUAL_FUEL_ON]);
      expect(state.fuelPlanChangedThisTick).toBe(true);

      feed(state, T_SETTLE + 10, { flags: PitSvFlags.FuelFill, auto: 0, inStall: true });
      expect(state.fuelPlanChangedThisTick).toBe(false);
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
