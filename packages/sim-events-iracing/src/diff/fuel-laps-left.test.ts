/**
 * Unit tests for `diffFuelLapsLeft` (issue #838) — the mid-lap
 * laps-of-fuel-left crossing detector. The estimator and margin are stubbed
 * so every rule is exercised in isolation:
 *
 *   - silent seeding, rising-0.5-crossing sampling, once-per-lap guard
 *   - count math (raw − margin − remaining lap fraction, floored, clamped)
 *   - descending crossings only, once per stint, no stale burst
 *   - the 10-count ceiling and the count-0 box call
 *   - refuel re-arm (debounced) and jitter immunity
 *   - race / live-in-car / missing-stats / invalid-telemetry gates
 *   - race-coverage suppression (issue #866): the lap-limited remaining-laps
 *     comparison, the sticky final-lap latch, and the post-race gate
 *   - timed-race coverage (issue #880): the leader-aware remaining-laps
 *     estimate from `SessionTimeRemain` (checkered bound: expiry + up to two
 *     leader laps, or one once the white is up), its fallbacks, and dual
 *     time+lap limits
 *   - the enough-fuel confirmation (issue #880): fires once in the race
 *     endgame (≤ 10 laps to go, covered with a lap in hand), clears the
 *     warning floor, re-arms on refuel and after a real warning
 *   - margin sanitization (`sanitizeFuelCalloutMarginLaps`)
 */
import { Flags, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import {
  diffFuelLapsLeft,
  FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  FUEL_LAPS_LEFT_MAX_COUNT,
  sanitizeFuelCalloutMarginLaps,
} from "./fuel-laps-left.js";
import type { FuelStats } from "./fuel-laps.js";
import type { PendingEvent } from "./types.js";

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    OnPitRoad: false,
    Lap: 5,
    LapDistPct: 0.4,
    FuelLevel: 20,
    ...overrides,
  } as TelemetryData;
}

type RunOptions = {
  race?: boolean;
  avg?: number | null;
  margin?: number;
  avgLapTime?: number | null;
  leaderLap?: number | null;
};

function makeRunner(events: PendingEvent[], state: TranslatorState = createInitialState()) {
  return {
    state,
    run(
      t: TelemetryData,
      {
        race = true,
        avg = 2,
        margin = FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
        avgLapTime = null,
        leaderLap = null,
      }: RunOptions = {},
    ) {
      const stats: FuelStats =
        avg === null
          ? { lastLap: null, avg: null, avgLapTime: null, samples: 0 }
          : { lastLap: avg, avg, avgLapTime, samples: 5 };
      diffFuelLapsLeft(
        state,
        t,
        race,
        () => stats,
        () => margin,
        () => leaderLap,
        (e) => events.push(e),
      );
    },
  };
}

function counts(events: PendingEvent[]): number[] {
  return events.filter((e) => e.event === "fuel.lapsLeft.crossed").map((e) => (e.data as { count: number }).count);
}

/** Number of `fuel.lapsLeft.raceCovered` reassurance emissions (issue #880). */
function reassured(events: PendingEvent[]): number {
  return events.filter((e) => e.event === "fuel.lapsLeft.raceCovered").length;
}

function lapSample(
  run: ReturnType<typeof makeRunner>["run"],
  lap: number,
  fuel: number,
  options?: RunOptions,
  extra: Partial<TelemetryData> = {},
): void {
  run(tick({ Lap: lap, LapDistPct: 0.45, FuelLevel: fuel + 0.02, ...extra }), options);
  run(tick({ Lap: lap, LapDistPct: 0.55, FuelLevel: fuel, ...extra }), options);
  run(tick({ Lap: lap, LapDistPct: 0.95, FuelLevel: fuel - 0.02, ...extra }), options);
  run(tick({ Lap: lap + 1, LapDistPct: 0.05, FuelLevel: fuel - 0.04, ...extra }), options);
}

describe("diffFuelLapsLeft — sampling", () => {
  it("seeds silently on the first valid tick, even past the mid-lap mark", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.6, FuelLevel: 3 }));

    expect(events).toEqual([]);
  });

  it("emits on the rising 0.5 crossing with the issue's worked example (3.05 raw → count 2)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // raw = 6.1 / 2 = 3.05; effective = 2.75; at 50% lap distance:
    // floor(3.05 − 0.3 − 0.5) = 2.
    run(tick({ LapDistPct: 0.45, FuelLevel: 6.12 }));
    run(tick({ LapDistPct: 0.5, FuelLevel: 6.1 }));

    expect(counts(events)).toEqual([2]);
    expect((events[0]!.data as { lapsLeft: number }).lapsLeft).toBeCloseTo(2.75);
  });

  it("does not sample without a crossing, and only once per lap on a back-and-forth wobble", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.1, FuelLevel: 6.2 }));
    run(tick({ LapDistPct: 0.3, FuelLevel: 6.15 }));
    expect(events).toEqual([]);

    run(tick({ LapDistPct: 0.55, FuelLevel: 6.1 }));
    expect(counts(events)).toEqual([2]); // floor(3.05 − 0.3 − 0.45) = floor(2.3)

    // Roll back below the mark and cross again on the same lap — no re-sample.
    run(tick({ LapDistPct: 0.45, FuelLevel: 6.0 }));
    run(tick({ LapDistPct: 0.55, FuelLevel: 5.9 }));
    expect(events).toHaveLength(1);
  });

  it("samples again on the next lap", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ Lap: 5, LapDistPct: 0.45, FuelLevel: 6.2 }));
    run(tick({ Lap: 5, LapDistPct: 0.55, FuelLevel: 6.1 }));
    run(tick({ Lap: 5, LapDistPct: 0.95, FuelLevel: 5.5 }));
    run(tick({ Lap: 6, LapDistPct: 0.05, FuelLevel: 5.4 }));
    run(tick({ Lap: 6, LapDistPct: 0.55, FuelLevel: 4.1 }));

    // Lap 5: floor(6.1/2 − 0.3 − 0.45) = 2. Lap 6: floor(4.1/2 − 0.3 − 0.45) = 1.
    expect(counts(events)).toEqual([2, 1]);
  });
});

describe("diffFuelLapsLeft — announcement rules", () => {
  it("never re-announces a higher or equal count (fuel saving raises the estimate)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 8.1); // floor(8.1/2 − 0.75) = 3
    expect(counts(events)).toEqual([3]);

    // Fuel saving: consumption (avg) drops, so the estimate RISES to count 4
    // even though the tank keeps draining — no re-announcement of 4.
    lapSample(run, 6, 7.6, { avg: 1.5 }); // floor(7.6/1.5 − 0.75) = 4 → silent
    lapSample(run, 7, 7.0, { avg: 1.75 }); // floor(7.0/1.75 − 0.75) = 3 — already spoken → silent
    expect(counts(events)).toEqual([3]);

    lapSample(run, 8, 5.4, { avg: 1.75 }); // floor(5.4/1.75 − 0.75) = 2 → new descending crossing
    expect(counts(events)).toEqual([3, 2]);
  });

  it("speaks only the current count when the estimate drops several counts between samples", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 12.1); // floor(6.05 − 0.75) = 5
    lapSample(run, 6, 6.1); // floor(3.05 − 0.75) = 2 — skips 4 and 3
    expect(counts(events)).toEqual([5, 2]);
  });

  it("stays silent above the 10-count ceiling without consuming the stint's floor", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 40); // raw 20 → count 19 → silent
    expect(events).toEqual([]);

    lapSample(run, 6, 22.6); // floor(11.3 − 0.75) = 10 → first announcement
    expect(counts(events)).toEqual([FUEL_LAPS_LEFT_MAX_COUNT]);
  });

  it("clamps a below-zero effective estimate to the count-0 box call", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 0.6); // raw 0.3 → effective 0 → floor(−0.45) = −1 → 0
    expect(counts(events)).toEqual([0]);
  });

  it("re-arms every count after a refuel; tiny jitter does not re-arm", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 6.1); // count 2
    expect(counts(events)).toEqual([2]);

    // +0.005 L jitter — below the debounce floor, stays armed as spoken.
    run(tick({ Lap: 6, LapDistPct: 0.2, FuelLevel: 6.065 }));
    lapSample(run, 6, 6.02); // count 2 again — still suppressed
    expect(counts(events)).toEqual([2]);

    // A real refuel (+10 L in one tick) re-arms the stint.
    run(tick({ Lap: 7, LapDistPct: 0.2, FuelLevel: 16 }));
    lapSample(run, 7, 6.1); // count 2 speaks again for the new stint
    expect(counts(events)).toEqual([2, 2]);
  });

  it("reads the margin live at every sample", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 6.1, { margin: 0 }); // floor(3.05 − 0.45) = 2
    lapSample(run, 6, 6.0, { margin: 1.5 }); // floor(3.0 − 1.5 − 0.45) = 1
    expect(counts(events)).toEqual([2, 1]);
  });
});

describe("diffFuelLapsLeft — gates", () => {
  it("is silent outside race sessions", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.45, FuelLevel: 6.2 }), { race: false });
    run(tick({ LapDistPct: 0.55, FuelLevel: 6.1 }), { race: false });

    expect(events).toEqual([]);
  });

  it("is silent when the driver is not live in the car", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.45, FuelLevel: 6.2, IsOnTrack: false }));
    run(tick({ LapDistPct: 0.55, FuelLevel: 6.1, IsOnTrack: false }));

    expect(events).toEqual([]);
  });

  it("is silent until the estimator has valid samples", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.45, FuelLevel: 6.2 }), { avg: null });
    run(tick({ LapDistPct: 0.55, FuelLevel: 6.1 }), { avg: null });

    expect(events).toEqual([]);
  });

  it("skips invalid telemetry ticks entirely", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    run(tick({ LapDistPct: 0.45, FuelLevel: 6.2 }));
    run(tick({ LapDistPct: 0.55, FuelLevel: NaN }));
    run(tick({ LapDistPct: 0.55, FuelLevel: -1 }));
    run(tick({ LapDistPct: NaN, FuelLevel: 6.1 }));
    run(tick({ Lap: -1, LapDistPct: 0.55, FuelLevel: 6.1 }));

    expect(events).toEqual([]);
  });
});

describe("diffFuelLapsLeft — race-coverage suppression (issue #866)", () => {
  it("suppresses the box call on the final lap of a lap-limited race — with NO reassurance for a clamped count", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // SessionLapsRemainEx 1 → 0 full laps needed after the current one; even
    // the count-0 box call is noise when the race ends with this lap. The
    // clamp hides that the tank may not even finish THIS lap (effective 0 <
    // the 0.45 lap remaining), so the enough-fuel reassurance must NOT fire.
    lapSample(run, 5, 0.6, {}, { SessionLapsRemainEx: 1 });

    expect(events).toEqual([]);
  });

  it("suppresses silently at exact coverage — the reassurance needs a lap in hand", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 3 laps remain including the current one → 2 full laps needed after it;
    // count 2 covers exactly → no warning, but at the estimator's precision
    // an exact-coverage "enough fuel" promise is a coin flip, so the
    // confirmation stays quiet too (hysteresis, #880 review).
    lapSample(run, 5, 6.1, {}, { SessionLapsRemainEx: 3 });

    expect(events).toEqual([]);
  });

  it("speaks the reassurance when the tank covers the race with a lap to spare", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 2 needed after the current lap; count 3 (unclamped 3 ≥ 2 + 1) → one
    // enough-fuel confirmation, no warning.
    lapSample(run, 5, 8.1, {}, { SessionLapsRemainEx: 3 });

    expect(counts(events)).toEqual([]);
    expect(reassured(events)).toBe(1);
  });

  it("still announces when the estimate falls short of the remaining laps", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 4 laps remain including the current one → 3 needed; count 2 falls short.
    lapSample(run, 5, 6.1, {}, { SessionLapsRemainEx: 4 });

    expect(counts(events)).toEqual([2]);
  });

  it("keeps announcing when laps remaining is unknown (timed sentinel, invalid reading)", () => {
    // Timed race: the 32767 unlimited sentinel is not a lap count.
    const sentinelEvents: PendingEvent[] = [];
    const sentinel = makeRunner(sentinelEvents);
    lapSample(sentinel.run, 5, 6.1, {}, { SessionLapsRemainEx: 32767 });
    expect(counts(sentinelEvents)).toEqual([2]);

    // A negative reading is invalid, not a coverage determination.
    const invalidEvents: PendingEvent[] = [];
    const invalid = makeRunner(invalidEvents);
    lapSample(invalid.run, 5, 0.6, {}, { SessionLapsRemainEx: -1 });
    expect(counts(invalidEvents)).toEqual([0]);
  });

  it("suppresses the family on the player's own final lap (sticky latch, issue #880)", () => {
    const events: PendingEvent[] = [];
    const runner = makeRunner(events);
    runner.state.playerFinalLapStarted = true;

    // Timed race (no usable lap counter) — the sticky latch is the signal.
    lapSample(runner.run, 5, 0.6, {}, { SessionLapsRemainEx: 32767 });

    expect(events).toEqual([]);
  });

  it("keeps suppressing after a caution replaces the white mid-final-lap (issue #880 limitation 3)", () => {
    const events: PendingEvent[] = [];
    const runner = makeRunner(events);

    // The #772 two-stage latch re-arms when the White bit drops; the sticky
    // latch does not — a caution on the final lap of a timed race must not
    // resurrect the box call.
    runner.state.playerFinalLapStarted = true;
    runner.state.whiteLastLapFired = false;

    lapSample(runner.run, 5, 0.6, {}, { SessionLapsRemainEx: 32767 });

    expect(events).toEqual([]);
  });

  it("goes silent post-race (checkered / cool-down)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 0.6, {}, { SessionState: SessionState.Checkered });
    lapSample(run, 6, 0.5, {}, { SessionState: SessionState.CoolDown });

    expect(events).toEqual([]);
  });

  it("does not suppress while racing", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 0.6, {}, { SessionState: SessionState.Racing });

    expect(counts(events)).toEqual([0]);
  });

  it("leaves the dedup floor untouched on suppression so a later drop still announces", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Count 2 covers the 2 laps needed exactly → suppressed silently, floor
    // NOT advanced.
    lapSample(run, 5, 6.1, {}, { SessionLapsRemainEx: 3 });
    expect(events).toEqual([]);

    // Next lap the counter reading is unavailable — coverage is unknown, so
    // the same count 2 must still announce (an advanced floor would eat it).
    lapSample(run, 6, 5.9);
    expect(counts(events)).toEqual([2]);
  });

  it("clamps the lap counter to at least 1 needed while the white flag flies before the player's own crossing", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // The leader is on THEIR final lap (raw 1 → 0 needed), but a player who
    // has not yet crossed under the white still runs current lap + their own
    // full white lap. The clamp keeps a current-lap-only tank from drawing
    // an "enough fuel" promise…
    lapSample(run, 5, 4.1, {}, { SessionLapsRemainEx: 1, SessionFlags: Flags.White });
    expect(events).toEqual([]); // count 1 covers the clamped 1 — silent, no reassurance without a lap in hand

    // …while a genuinely short tank (count 0 < 1 needed) still warns: the
    // box call before the final lap starts is actionable.
    const short: PendingEvent[] = [];
    const shortRunner = makeRunner(short);
    lapSample(shortRunner.run, 5, 0.6, {}, { SessionLapsRemainEx: 1, SessionFlags: Flags.White });
    expect(counts(short)).toEqual([0]);
  });
});

describe("diffFuelLapsLeft — timed-race coverage (issue #880)", () => {
  // The worked numbers: player avg lap 100 s, sample lands at LapDistPct 0.55
  // → 45 s left in the current lap. The leader's checkered upper bound is
  // SessionTimeRemain + 2 × leaderLap (white at their first crossing AFTER
  // expiry — up to one lap away — plus the white lap itself), or one leader
  // lap once the White flag is already up. timedRemaining =
  // ceil((bound − 45) / 100), full laps after the current one.
  const TIMED = { SessionLapsRemainEx: 32767 };

  it("suppresses the warning when the white flag is up and the tank covers the final lap (the field repro)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // White up: the leader's checkered is at most one leader lap away →
    // ceil((100 − 45) / 100) = 1 lap still to run. count 1 (fuel 4.1 / avg 2
    // → floor(2.05 − 0.75) = 1) covers it exactly → silent (no "plan to
    // box", and no reassurance either without a lap in hand).
    lapSample(
      run,
      5,
      4.1,
      { avgLapTime: 100, leaderLap: 100 },
      { SessionTimeRemain: 0, SessionFlags: Flags.White, ...TIMED },
    );

    expect(events).toEqual([]);
  });

  it("does NOT trust the pre-white clock alone: the leader may cross up to a full lap after expiry", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 10 s on the clock but no white yet — the leader might have just missed
    // the line, making the checkered land at ~10 + 2 × 100 s. That is
    // ceil((210 − 45) / 100) = 2 laps still to run; count 1 falls short and
    // the warning must fire (a tighter bound would falsely reassure here).
    lapSample(run, 5, 4.1, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: 10, ...TIMED });

    expect(counts(events)).toEqual([1]);
  });

  it("still announces when the timed estimate says more laps remain than the tank covers", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // ceil((400 + 200 − 45) / 100) = 6 laps to run; count 1 falls short.
    lapSample(run, 5, 4.1, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: 400, ...TIMED });

    expect(counts(events)).toEqual([1]);
  });

  it("falls back to the player's own pace when the leader's lap time is unknown", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // White up, leader pace unknown → bound = one PLAYER lap; count 1
    // covers the 1 lap to run → silent.
    lapSample(
      run,
      5,
      4.1,
      { avgLapTime: 100, leaderLap: null },
      { SessionTimeRemain: 0, SessionFlags: Flags.White, ...TIMED },
    );

    expect(events).toEqual([]);
  });

  it("a faster overall leader (multiclass) shortens the estimate", () => {
    // Same clock, same player pace — only the leader lap time differs.
    // leaderLap 60: ceil((100 + 120 − 45) / 100) = 2 → count 2 covers.
    const fast: PendingEvent[] = [];
    const fastRunner = makeRunner(fast);
    lapSample(fastRunner.run, 5, 6.1, { avgLapTime: 100, leaderLap: 60 }, { SessionTimeRemain: 100, ...TIMED });
    expect(counts(fast)).toEqual([]);

    // leaderLap 100: ceil((100 + 200 − 45) / 100) = 3 → count 2 falls short.
    const slow: PendingEvent[] = [];
    const slowRunner = makeRunner(slow);
    lapSample(slowRunner.run, 5, 6.1, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: 100, ...TIMED });
    expect(counts(slow)).toEqual([2]);
  });

  it("keeps announcing on the unlimited-time sentinel or when the pace average is missing", () => {
    // A lap-limited-only race reads SessionTimeRemain as the 604800 sentinel.
    const sentinel: PendingEvent[] = [];
    const sentinelRunner = makeRunner(sentinel);
    lapSample(sentinelRunner.run, 5, 4.1, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: 604800, ...TIMED });
    expect(counts(sentinel)).toEqual([1]);

    // No validated lap times yet — never a guess.
    const noPace: PendingEvent[] = [];
    const noPaceRunner = makeRunner(noPace);
    lapSample(noPaceRunner.run, 5, 4.1, { avgLapTime: null, leaderLap: 100 }, { SessionTimeRemain: 30, ...TIMED });
    expect(counts(noPace)).toEqual([1]);
  });

  it("dual time+lap limits: whichever limit ends the race sooner binds (issue #866 limitation 1)", () => {
    // Lap counter says 10 laps remain (count 2 falls far short), but the
    // clock ends the race within ceil((30 + 200 − 45) / 100) = 2 laps →
    // covered by time → suppressed.
    const timeBinds: PendingEvent[] = [];
    const timeRunner = makeRunner(timeBinds);
    lapSample(
      timeRunner.run,
      5,
      6.1,
      { avgLapTime: 100, leaderLap: 100 },
      { SessionTimeRemain: 30, SessionLapsRemainEx: 10 },
    );
    expect(counts(timeBinds)).toEqual([]);

    // Clock says ~22 laps, but only 3 counted laps remain → covered by laps.
    const lapsBind: PendingEvent[] = [];
    const lapsRunner = makeRunner(lapsBind);
    lapSample(
      lapsRunner.run,
      5,
      6.1,
      { avgLapTime: 100, leaderLap: 100 },
      { SessionTimeRemain: 2000, SessionLapsRemainEx: 3 },
    );
    expect(counts(lapsBind)).toEqual([]);
  });
});

describe("diffFuelLapsLeft — enough-fuel reassurance (issue #880)", () => {
  it("fires exactly once — a later covered sample stays silent", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 8.1, {}, { SessionLapsRemainEx: 3 }); // count 3 covers 2 with a lap in hand
    lapSample(run, 6, 6.02, {}, { SessionLapsRemainEx: 2 }); // count 2 covers 1 with a lap in hand — latched

    expect(counts(events)).toEqual([]);
    expect(reassured(events)).toBe(1);
  });

  it("fires at the race endgame (≤10 laps to go) even with a huge surplus", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // count 19 — far above the spoken band — but only 2 laps are needed and
    // the tank covers them: the endgame confirmation speaks.
    lapSample(run, 5, 40, {}, { SessionLapsRemainEx: 3 });

    expect(counts(events)).toEqual([]);
    expect(reassured(events)).toBe(1);
  });

  it("fires at the timed-race endgame with a huge surplus", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // ceil((800 + 200 − 45) / 100) = 10 laps to run — the endgame edge.
    lapSample(run, 5, 40, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: 800, SessionLapsRemainEx: 32767 });

    expect(counts(events)).toEqual([]);
    expect(reassured(events)).toBe(1);
  });

  it("stays silent while more than 10 laps remain, however big the surplus", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 15 laps remain (14 needed after this one), count 19 covers them — but
    // the endgame hasn't started; the confirmation waits for 10-to-go.
    lapSample(run, 5, 40, {}, { SessionLapsRemainEx: 15 });

    expect(events).toEqual([]);
  });

  it("retracts a spoken warning once coverage turns positive with a lap in hand, even at the same count", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Coverage unknown → count 2 announces (floor 2).
    lapSample(run, 5, 6.1);
    expect(counts(events)).toEqual([2]);

    // The race got shorter: the same count 2 now covers the 1 lap left with
    // a lap to spare. The driver was told to plan a stop — retract it.
    lapSample(run, 6, 6.02, {}, { SessionLapsRemainEx: 2 });
    expect(reassured(events)).toBe(1);
  });

  it("clears the warning floor on the reassurance so a later coverage flip re-warns at any count", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Warning at count 2 (floor 2), then the retraction.
    lapSample(run, 5, 6.1);
    lapSample(run, 6, 6.02, {}, { SessionLapsRemainEx: 2 });
    expect(counts(events)).toEqual([2]);
    expect(reassured(events)).toBe(1);

    // Coverage flips back to unknown with the count still at 2 — the
    // all-clear was retracted the moment it was spoken, so the SAME count
    // must warn again (a kept floor would silence the rest of the stint).
    lapSample(run, 7, 5.9);
    expect(counts(events)).toEqual([2, 2]);
  });

  it("reassures a marginal final lap only with a full lap in hand", () => {
    // Exact coverage (effective 0.75 laps vs 0.45 lap remaining, unclamped
    // 0 = the 0 needed): suppressed, but too tight to promise — silent.
    const exact: PendingEvent[] = [];
    const exactRunner = makeRunner(exact);
    lapSample(exactRunner.run, 5, 2.1, {}, { SessionLapsRemainEx: 1 });
    expect(exact).toEqual([]);

    // A lap in hand (unclamped 1 ≥ 0 + 1): the confirmation speaks.
    const spare: PendingEvent[] = [];
    const spareRunner = makeRunner(spare);
    lapSample(spareRunner.run, 5, 4.1, {}, { SessionLapsRemainEx: 1 });
    expect(counts(spare)).toEqual([]);
    expect(reassured(spare)).toBe(1);
  });

  it("re-arms after a refuel (new stint)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 8.1, {}, { SessionLapsRemainEx: 3 });
    expect(reassured(events)).toBe(1);

    // A real refuel (+10 L in one tick) starts a new stint.
    run(tick({ Lap: 6, LapDistPct: 0.2, FuelLevel: 18 }));
    lapSample(run, 6, 8.1, {}, { SessionLapsRemainEx: 3 });

    expect(reassured(events)).toBe(2);
  });

  it("re-arms after a real warning (burn-spike arc: reassurance → spike warning → reassurance)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    lapSample(run, 5, 8.1, {}, { SessionLapsRemainEx: 3 });
    expect(reassured(events)).toBe(1);

    // Burn-rate spike: the estimate shrinks below the race distance → a real
    // warning fires and re-arms the reassurance.
    lapSample(run, 6, 4.1, { avg: 3 }, { SessionLapsRemainEx: 3 }); // raw 1.37 → count 0, needs 2
    expect(counts(events)).toEqual([0]);

    // Fuel save restores coverage with a lap in hand (raw 4.05/1.2 = 3.375
    // → unclamped 2 ≥ 1 + 1) → the reassurance speaks again.
    lapSample(run, 7, 4.05, { avg: 1.2 }, { SessionLapsRemainEx: 2 });
    expect(reassured(events)).toBe(2);
  });
});

describe("sanitizeFuelCalloutMarginLaps", () => {
  it("passes valid values through and parses numeric strings", () => {
    expect(sanitizeFuelCalloutMarginLaps(0)).toBe(0);
    expect(sanitizeFuelCalloutMarginLaps(0.7)).toBe(0.7);
    expect(sanitizeFuelCalloutMarginLaps("1.5")).toBe(1.5);
  });

  it("falls back to the default on missing or malformed values", () => {
    expect(sanitizeFuelCalloutMarginLaps(undefined)).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
    expect(sanitizeFuelCalloutMarginLaps(null)).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
    expect(sanitizeFuelCalloutMarginLaps("")).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
    expect(sanitizeFuelCalloutMarginLaps("abc")).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
    expect(sanitizeFuelCalloutMarginLaps(NaN)).toBe(FUEL_CALLOUT_DEFAULT_MARGIN_LAPS);
  });

  it("clamps to the slider bounds", () => {
    expect(sanitizeFuelCalloutMarginLaps(-1)).toBe(0);
    expect(sanitizeFuelCalloutMarginLaps(99)).toBe(3);
  });
});
