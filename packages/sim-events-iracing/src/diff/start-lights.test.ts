/**
 * Unit tests for the start-light diffs (issues #480 / #673 / #829).
 *
 * Covers the gantry rising edges (`start-ready` standing-only, `start-go`;
 * `StartSet` emits nothing — #673), the gantry first-tick seed, and the
 * numeric-countdown state machine (`diffStartCountdown`, split out of
 * `diffStartLights` by #829 so the translator can run it before the replay
 * guard): window-gating (GetInCar/Warmup, no StartReady requirement — issue
 * #666), ceiling seeding, smallest-of-many emit, ceiling-seed suppression of a
 * compressed window, and reset on window exit. Two validated capture replays
 * (standing AI 2056, rolling AI 2112) plus a synthetic numeric countdown.
 * Marks are 90/60/30/10 (90 added — #673).
 */
import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffStartCountdown, diffStartLights } from "./start-lights.js";
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

  it("fires start-ready, start-go each once on their edge; StartSet emits nothing (issue #673)", () => {
    const state = createInitialState();
    diffStartLights(state, tick(0, SessionState.GetInCar, 5), STANDING_SESSION, () => {}); // seed

    const ready = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 4), STANDING_SESSION, ready.emit);
    expect(ready.events.map((e) => e.event)).toEqual(["startLight.start-ready.raised"]);

    // Stable tick — no re-fire.
    const stable = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, 3), STANDING_SESSION, stable.emit);
    expect(stable.events).toEqual([]);

    // StartSet lighting is the procedure's Set phase — too late for a heads-up,
    // so nothing is spoken (issue #673).
    const set = collect();
    diffStartLights(state, tick(StartSet, SessionState.Warmup, 0), STANDING_SESSION, set.emit);
    expect(set.events).toEqual([]);

    const go = collect();
    diffStartLights(state, tick(StartGo | Green, SessionState.Racing, 86399), STANDING_SESSION, go.emit);
    expect(go.events.map((e) => e.event)).toEqual(["startLight.start-go.raised"]);
  });

  it("does NOT fire start-ready in a rolling start (StartReady held through the formation)", () => {
    const state = createInitialState();
    diffStartLights(state, tick(0, SessionState.GetInCar, -1), ROLLING_AI_SESSION, () => {}); // seed

    const { events, emit } = collect();
    diffStartLights(state, tick(StartReady, SessionState.Warmup, -1), ROLLING_AI_SESSION, emit);

    expect(events).toEqual([]);
  });

  it("does not emit countdown events (the countdown lives in diffStartCountdown — issue #829)", () => {
    const state = createInitialState();
    diffStartLights(state, tick(0, SessionState.GetInCar, 95), STANDING_SESSION, () => {}); // seed

    const { events, emit } = collect();
    diffStartLights(state, tick(0, SessionState.GetInCar, 58), STANDING_SESSION, emit);

    expect(events.some((e) => e.event === "startLight.countdown.raised")).toBe(false);
  });
});

describe("diffStartCountdown — numeric countdown", () => {
  it("consumes the first tick as a silent observation — a collapsing AI window fires nothing (issue #829)", () => {
    const state = createInitialState();
    // The countdown owns its own seed (no diffStartLights call needed): the
    // first tick is a silent observation because its SessionTimeRemain can be
    // a scheduled value the AI session collapses right after (capture 2056).
    const first = collect();
    diffStartCountdown(state, tick(0, SessionState.GetInCar, 262), STANDING_SESSION, first.emit);
    expect(first.events).toEqual([]);
    expect(state.startCountdownCeiling).toBeNull();
    expect(state.startLightInitialized).toBe(false); // gantry state untouched

    // The grid completes and the window collapses — the ceiling anchors here
    // (1.02), so no stale bottom mark fires off the 262 s reading.
    const collapsed = collect();
    diffStartCountdown(state, tick(0, SessionState.GetInCar, 1.02), STANDING_SESSION, collapsed.emit);
    expect(collapsed.events).toEqual([]);
    expect(state.startCountdownCeiling).toBe(1.02);
  });

  it("window-gate: seeds ceiling and fires only thresholds <= ceiling", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation
    // Window opening at 12 s → only the 10 mark is reachable.
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 12), STANDING_SESSION, () => {}); // first in-window seeds ceiling=12 (no candidate yet: 12<=10 false)
    expect(state.startCountdownCeiling).toBe(12);

    const at10 = collect();
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 9.5), STANDING_SESSION, at10.emit);
    expect(at10.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 10 } }]);

    // 90/60/30 never fire — above the ceiling — and nothing remains below 10.
    const after = collect();
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 2), STANDING_SESSION, after.emit);
    expect(after.events).toEqual([]);
  });

  it("fires during GetInCar without the StartReady gantry bit (issue #666)", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation
    // Window opens in GetInCar — no StartReady flag set — and SessionTimeRemain
    // is already the real time-to-lights, so the early marks must fire here.
    diffStartCountdown(state, tick(0, SessionState.GetInCar, 95), STANDING_SESSION, () => {}); // ceiling=95

    const at90 = collect();
    diffStartCountdown(state, tick(0, SessionState.GetInCar, 88), STANDING_SESSION, at90.emit);
    expect(at90.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 90 } }]);

    const at60 = collect();
    diffStartCountdown(state, tick(0, SessionState.GetInCar, 58), STANDING_SESSION, at60.emit);
    expect(at60.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 60 } }]);

    const at30 = collect();
    diffStartCountdown(state, tick(0, SessionState.GetInCar, 28), STANDING_SESSION, at30.emit);
    expect(at30.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 30 } }]);
  });

  it("stops the countdown once StartSet lights — the gantry owns the final moment (issue #666)", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 70), STANDING_SESSION, () => {}); // ceiling=70

    // StartSet raised at 6 s closes the window even though 10 hasn't fired yet.
    const ev = collect();
    diffStartCountdown(state, tick(StartSet, SessionState.Warmup, 6), STANDING_SESSION, ev.emit);

    expect(ev.events.some((e) => e.event === "startLight.countdown.raised")).toBe(false);
    expect(state.startCountdownCeiling).toBeNull();
  });

  it("a transient SessionTimeRemain<=0 blip across GetInCar→Warmup does not replay a fired mark (issue #666)", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation
    diffStartCountdown(state, tick(0, SessionState.GetInCar, 62), STANDING_SESSION, () => {}); // ceiling=62

    const ev = collect();
    diffStartCountdown(state, tick(0, SessionState.GetInCar, 58), STANDING_SESSION, ev.emit); // fires 60
    // Inter-state -1 on the GetInCar→Warmup boundary: window briefly exits + resets.
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, -1), STANDING_SESSION, ev.emit);
    // Resumes counting in Warmup; the re-seeded ceiling (45) is below 60, so 60
    // cannot replay — only 30 fires next.
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 45), STANDING_SESSION, ev.emit); // re-seed ceiling=45
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 28), STANDING_SESSION, ev.emit); // fires 30

    const seconds = ev.events
      .filter((e) => e.event === "startLight.countdown.raised")
      .map((e) => (e.data as { seconds: number }).seconds);
    expect(seconds).toEqual([60, 30]);
  });

  it("emits only the smallest threshold when several cross in one tick (dropped tick)", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 95), STANDING_SESSION, () => {}); // ceiling=95

    const { events, emit } = collect();
    // Jump straight to 8 s — crosses 90,60,30,10 but only the smallest (10) is spoken.
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 8), STANDING_SESSION, emit);

    expect(events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 10 } }]);
    // Nothing remains below 10, so a later tick is silent.
    const at3 = collect();
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 3), STANDING_SESSION, at3.emit);
    expect(at3.events).toEqual([]);
  });

  it("fires countdown numbers in an AI race (no AI guard — issue #666)", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 70), STANDING_AI_SESSION, () => {}); // ceiling=70

    const at30 = collect();
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 28), STANDING_AI_SESSION, at30.emit);
    expect(at30.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 30 } }]);

    const at10 = collect();
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 4), STANDING_AI_SESSION, at10.emit);
    expect(at10.events).toEqual([{ event: "startLight.countdown.raised", data: { seconds: 10 } }]);
  });

  it("a window that opens below the smallest threshold speaks nothing (ceiling-seed, not an AI guard)", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation
    // Compressed pre-start window opening at 4.4 s — ceiling 4.4 < 10, so no mark
    // is reachable, even in an AI race. This is what keeps a compressed AI start
    // silent now that the explicit AI guard is gone (issue #666).
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 4.4), STANDING_AI_SESSION, () => {});

    const { events, emit } = collect();
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 3.1), STANDING_AI_SESSION, emit);
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 0.5), STANDING_AI_SESSION, emit);

    expect(events.some((e) => e.event === "startLight.countdown.raised")).toBe(false);
  });

  it("resets countdown state on window exit (StartGo / Racing)", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 70), STANDING_SESSION, () => {}); // ceiling=70
    diffStartCountdown(state, tick(StartReady, SessionState.Warmup, 28), STANDING_SESSION, () => {}); // fires 30

    expect(state.startCountdownCeiling).toBe(70);

    // Leave the window → reset.
    diffStartCountdown(state, tick(StartGo | Green, SessionState.Racing, 86399), STANDING_SESSION, () => {});
    expect(state.startCountdownCeiling).toBeNull();
    expect(state.startCountdownFired.size).toBe(0);
  });
});

describe("start-light diffs — validated capture replays", () => {
  // Drive both diffs per tick, mirroring the translator (countdown pre-guard,
  // gantry post-guard — both see every live tick here).
  function driveBoth(
    state: ReturnType<typeof createInitialState>,
    telemetry: TelemetryData,
    sessionInfo: Record<string, unknown>,
    emit: (e: PendingEvent) => void,
  ): void {
    diffStartCountdown(state, telemetry, sessionInfo, emit);
    diffStartLights(state, telemetry, sessionInfo, emit);
  }

  it("STANDING AI 2056: gantry ready→go fire (set silent), NO numeric countdown", () => {
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
      driveBoth(state, tick(flags, st, t), STANDING_AI_SESSION, emit);
    }

    const names = events.map((e) => e.event);
    expect(names.filter((n) => n === "startLight.start-ready.raised")).toHaveLength(1);
    expect(names.filter((n) => n === "startLight.start-go.raised")).toHaveLength(1);
    expect(names.some((n) => n === "startLight.countdown.raised")).toBe(false);
  });

  it("ROLLING AI 2112: no start-ready (standing-only gate), no countdown", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    const seq: Array<[number, number, number]> = [
      [StartHidden | OneLapToGreen, SessionState.GetInCar, -1],
      [StartReady | Servicible | OneLapToGreen, SessionState.Warmup, -1],
      [StartReady | Servicible | OneLapToGreen, SessionState.ParadeLaps, -1],
    ];

    for (const [flags, st, t] of seq) {
      driveBoth(state, tick(flags, st, t), ROLLING_AI_SESSION, emit);
    }

    const names = events.map((e) => e.event);
    expect(names.some((n) => n === "startLight.start-ready.raised")).toBe(false);
    expect(names.some((n) => n === "startLight.countdown.raised")).toBe(false);
  });

  it("SYNTHETIC non-AI countdown: 90/60/30/10 fire in order, each once", () => {
    const state = createInitialState();
    state.startCountdownObserved = true; // skip the first-tick observation so ceiling=95 admits all four
    const { events, emit } = collect();

    // First in-window tick (95) seeds ceiling=95 — admits all four; one
    // crossing per subsequent tick.
    const remains = [95, 88, 55, 28, 14, 9, 4];

    for (const t of remains) {
      driveBoth(state, tick(StartReady, SessionState.Warmup, t), STANDING_SESSION, emit);
    }

    const seconds = events
      .filter((e) => e.event === "startLight.countdown.raised")
      .map((e) => (e.data as { seconds: number }).seconds);

    expect(seconds).toEqual([90, 60, 30, 10]);
  });
});
