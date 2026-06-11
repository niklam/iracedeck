/**
 * Unit tests for the start-light diff (issue #480).
 *
 * Covers the gantry rising edges (`start-set`, `start-go`), the first-tick
 * seed, and the numeric-countdown state machine: window-gating (GetInCar/Warmup,
 * no StartReady requirement — issue #666), ceiling seeding, smallest-of-many
 * emit, ceiling-seed suppression of a compressed window, and reset on window
 * exit. Two validated capture replays (standing AI 2056, rolling AI 2112) plus a
 * synthetic numeric countdown. Marks are 60/30/10 (15 and 5 dropped — #666).
 */
import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffStartLights } from "./start-lights.js";
import type { PendingEvent } from "./types.js";

// Flag bit shorthands (hex) for fixture sequences.
const StartHidden = Flags.StartHidden; // 0x10000000
const StartReady = Flags.StartReady; // 0x20000000
const StartSet = Flags.StartSet; // 0x40000000
const StartGo = Flags.StartGo; // 0x80000000
const Green = Flags.Green; // 0x4
const OneLapToGreen = Flags.OneLapToGreen; // 0x200
const Servicible = Flags.Servicible; // 0x40000

function tick(sessionFlags: number, sessionState: number, timeRemain: number): TelemetryData {
  return { SessionFlags: sessionFlags, SessionState: sessionState, SessionTimeRemain: timeRemain } as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

const STANDING_SESSION: Record<string, unknown> = {
  WeekendInfo: { WeekendOptions: { StandingStart: 1 } },
  DriverInfo: { Drivers: [{ CarIsAI: 0 }] },
};
const STANDING_AI_SESSION: Record<string, unknown> = {
  WeekendInfo: { WeekendOptions: { StandingStart: 1 } },
  DriverInfo: { Drivers: [{ CarIsAI: 0 }, { CarIsAI: 1 }] },
};
const ROLLING_AI_SESSION: Record<string, unknown> = {
  WeekendInfo: { WeekendOptions: { StandingStart: 0 } },
  DriverInfo: { Drivers: [{ CarIsAI: 0 }, { CarIsAI: 1 }] },
};

describe("diffStartLights — gantry rising edges", () => {
  it("seeds silently on the first tick", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffStartLights(state, tick(StartReady, SessionState.Warmup, -1), STANDING_SESSION, emit);

    expect(events).toEqual([]);
    expect(state.startLightInitialized).toBe(true);
  });

  it("fires start-set, start-go each once on their edge", () => {
    const state = createInitialState();
    diffStartLights(state, tick(0, SessionState.GetInCar, 5), STANDING_SESSION, () => {}); // seed

    const set = collect();
    diffStartLights(state, tick(StartSet, SessionState.Warmup, 0), STANDING_SESSION, set.emit);
    expect(set.events.map((e) => e.event)).toEqual(["startLight.start-set.raised"]);

    // Stable tick — no re-fire.
    const stable = collect();
    diffStartLights(state, tick(StartSet, SessionState.Warmup, 0), STANDING_SESSION, stable.emit);
    expect(stable.events).toEqual([]);

    const go = collect();
    diffStartLights(state, tick(StartGo | Green, SessionState.Racing, 86399), STANDING_SESSION, go.emit);
    expect(go.events.map((e) => e.event)).toEqual(["startLight.start-go.raised"]);
  });
});

describe("diffStartLights — numeric countdown", () => {
  it("window-gate: seeds ceiling and fires only thresholds <= ceiling", () => {
    const state = createInitialState();
    state.startLightInitialized = true; // skip the gantry first-tick seed
    // Window opening at 12 s → only the 10 mark is reachable.
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 12), STANDING_SESSION, () => {}); // first in-window seeds ceiling=12 (no candidate yet: 12<=10 false)
    expect(state.startCountdownCeiling).toBe(12);

    const at10 = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 9.5), STANDING_SESSION, at10.emit);
    expect(at10.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 10 } }]);

    // 60/30 never fire — above the ceiling — and nothing remains below 10.
    const after = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 2), STANDING_SESSION, after.emit);
    expect(after.events).toEqual([]);
  });

  it("fires during GetInCar without the StartReady gantry bit (issue #666)", () => {
    const state = createInitialState();
    state.startLightInitialized = true; // skip the gantry first-tick seed
    // Window opens in GetInCar — no StartReady flag set — and SessionTimeRemain
    // is already the real time-to-lights, so the early marks must fire here.
    diffStartLights(state, tick(0, SessionState.GetInCar, 62), STANDING_SESSION, () => {}); // ceiling=62

    const at60 = collect();
    diffStartLights(state, tick(0, SessionState.GetInCar, 58), STANDING_SESSION, at60.emit);
    expect(at60.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 60 } }]);

    const at30 = collect();
    diffStartLights(state, tick(0, SessionState.GetInCar, 28), STANDING_SESSION, at30.emit);
    expect(at30.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 30 } }]);
  });

  it("stops the countdown once StartSet lights — the gantry owns the final moment (issue #666)", () => {
    const state = createInitialState();
    state.startLightInitialized = true;
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 70), STANDING_SESSION, () => {}); // ceiling=70

    // StartSet raised at 6 s closes the window even though 5 hasn't fired yet.
    const ev = collect();
    diffStartLights(state, tick(StartSet, SessionState.Warmup, 6), STANDING_SESSION, ev.emit);

    expect(ev.events.some((e) => e.event === "startLight.countdown.raised")).toBe(false);
    expect(state.startCountdownCeiling).toBeNull();
  });

  it("a transient SessionTimeRemain<=0 blip across GetInCar→Warmup does not replay a fired mark (issue #666)", () => {
    const state = createInitialState();
    state.startLightInitialized = true;
    diffStartLights(state, tick(0, SessionState.GetInCar, 62), STANDING_SESSION, () => {}); // ceiling=62

    const ev = collect();
    diffStartLights(state, tick(0, SessionState.GetInCar, 58), STANDING_SESSION, ev.emit); // fires 60
    // Inter-state -1 on the GetInCar→Warmup boundary: window briefly exits + resets.
    diffStartLights(state, tick(StartReady, SessionState.Warmup, -1), STANDING_SESSION, ev.emit);
    // Resumes counting in Warmup; the re-seeded ceiling (45) is below 60, so 60
    // cannot replay — only 30 fires next.
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 45), STANDING_SESSION, ev.emit); // re-seed ceiling=45
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 28), STANDING_SESSION, ev.emit); // fires 30

    const seconds = ev.events
      .filter((e) => e.event === "startLight.countdown.raised")
      .map((e) => (e.data as { seconds: number }).seconds);
    expect(seconds).toEqual([60, 30]);
  });

  it("emits only the smallest threshold when several cross in one tick (dropped tick)", () => {
    const state = createInitialState();
    state.startLightInitialized = true;
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 70), STANDING_SESSION, () => {}); // ceiling=70

    const { events, emit } = collect();
    // Jump straight to 8 s — crosses 60,30,10 but only the smallest (10) is spoken.
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 8), STANDING_SESSION, emit);

    expect(events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 10 } }]);
    // Nothing remains below 10, so a later tick is silent.
    const at3 = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 3), STANDING_SESSION, at3.emit);
    expect(at3.events).toEqual([]);
  });

  it("fires countdown numbers in an AI race (no AI guard — issue #666)", () => {
    const state = createInitialState();
    state.startLightInitialized = true;
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 70), STANDING_AI_SESSION, () => {}); // ceiling=70

    const at30 = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 28), STANDING_AI_SESSION, at30.emit);
    expect(at30.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 30 } }]);

    const at10 = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 4), STANDING_AI_SESSION, at10.emit);
    expect(at10.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 10 } }]);
  });

  it("a window that opens below the smallest threshold speaks nothing (ceiling-seed, not an AI guard)", () => {
    const state = createInitialState();
    state.startLightInitialized = true;
    // Compressed pre-start window opening at 4.4 s — ceiling 4.4 < 10, so no mark
    // is reachable, even in an AI race. This is what keeps a compressed AI start
    // silent now that the explicit AI guard is gone (issue #666).
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 4.4), STANDING_AI_SESSION, () => {});

    const { events, emit } = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 3.1), STANDING_AI_SESSION, emit);
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 0.5), STANDING_AI_SESSION, emit);

    expect(events.some((e) => e.event === "startLight.countdown.raised")).toBe(false);
  });

  it("resets countdown state on window exit (StartGo / Racing)", () => {
    const state = createInitialState();
    state.startLightInitialized = true;
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 70), STANDING_SESSION, () => {}); // ceiling=70
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 28), STANDING_SESSION, () => {}); // fires 30

    expect(state.startCountdownCeiling).toBe(70);

    // Leave the window → reset.
    diffStartLights(state, tick(StartGo | Green, SessionState.Racing, 86399), STANDING_SESSION, () => {});
    expect(state.startCountdownCeiling).toBeNull();
    expect(state.startCountdownFired.size).toBe(0);
  });
});

describe("diffStartLights — validated capture replays", () => {
  it("STANDING AI 2056: gantry set→go fire, NO numeric countdown", () => {
    // The compressed pre-start window (SessionTimeRemain peaks at ~4.4 s here)
    // keeps every number above the seeded ceiling, so nothing is spoken — the
    // ceiling-seed, not an AI guard (removed in #666), is what stays quiet.
    const state = createInitialState();
    const { events, emit } = collect();

    const seq: Array<[number, number, number]> = [
      [StartHidden | OneLapToGreen, SessionState.GetInCar, 262],
      [StartHidden | Servicible | OneLapToGreen, SessionState.GetInCar, 1.02],
      [StartReady | Servicible | OneLapToGreen, SessionState.Warmup, -1],
      [StartReady | Servicible | OneLapToGreen, SessionState.Warmup, 4.38],
      [StartReady | Servicible | OneLapToGreen, SessionState.Warmup, 3.13],
      [StartReady | Servicible | OneLapToGreen, SessionState.Warmup, 1.83],
      [StartReady | Servicible | OneLapToGreen, SessionState.Warmup, 0.48],
      [StartSet | Servicible | OneLapToGreen, SessionState.Warmup, 0],
      [StartSet | Servicible | OneLapToGreen, SessionState.Warmup, 0],
      [StartGo | Servicible | Green, SessionState.Racing, 86399],
    ];

    for (const [flags, st, t] of seq) {
      diffStartLights(state, tick(flags, st, t), STANDING_AI_SESSION, emit);
    }

    const names = events.map((e) => e.event);
    expect(names.filter((n) => n === "startLight.start-set.raised")).toHaveLength(1);
    expect(names.filter((n) => n === "startLight.start-go.raised")).toHaveLength(1);
    expect(names.some((n) => n === "startLight.countdown.raised")).toBe(false);
  });

  it("ROLLING AI 2112: no StartSet, no countdown", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    const seq: Array<[number, number, number]> = [
      [StartHidden | OneLapToGreen, SessionState.GetInCar, -1],
      [StartReady | Servicible | OneLapToGreen, SessionState.Warmup, -1],
      [StartReady | Servicible | OneLapToGreen, SessionState.ParadeLaps, -1],
    ];

    for (const [flags, st, t] of seq) {
      diffStartLights(state, tick(flags, st, t), ROLLING_AI_SESSION, emit);
    }

    const names = events.map((e) => e.event);
    expect(names.some((n) => n === "startLight.start-set.raised")).toBe(false);
    expect(names.some((n) => n === "startLight.countdown.raised")).toBe(false);
  });

  it("SYNTHETIC non-AI countdown: 60/30/10 fire in order, each once", () => {
    const state = createInitialState();
    state.startLightInitialized = true; // skip the gantry first-tick seed
    const { events, emit } = collect();

    // First in-window tick (70) seeds ceiling=70 — admits all three; one
    // crossing per subsequent tick.
    const remains = [70, 55, 28, 14, 9, 4];

    for (const t of remains) {
      diffStartLights(state, tick(StartReady, SessionState.Warmup, t), STANDING_SESSION, emit);
    }

    const seconds = events
      .filter((e) => e.event === "startLight.countdown.raised")
      .map((e) => (e.data as { seconds: number }).seconds);

    expect(seconds).toEqual([60, 30, 10]);
  });
});
