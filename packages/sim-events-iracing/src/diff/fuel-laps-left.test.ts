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
 *   - timed-race coverage (issue #880, #1405): the player's laps until the
 *     leader's predicted chequered flag, the fallback bound (expiry + two
 *     leader laps) when it cannot be predicted, and dual time+lap limits
 *   - the coverage verdict on the tank (issue #1405, `isFuelRaceCovered`)
 *     and the two driver reports it fixes, with a genuine shortage still loud
 *   - the enough-fuel confirmation (issue #880): fires once in the race
 *     endgame (≤ 10 laps to go, covered with a lap in hand), clears the
 *     warning floor, re-arms on refuel and after a real warning
 *   - margin sanitization (`sanitizeFuelCalloutMarginLaps`)
 *   - the two pure functions the diff and the Telemetry Snapshot's state
 *     reader share (issue #1387): `estimateFuelLapsLeft` and
 *     `resolveFuelRaceCoverage`
 */
import {
  Flags,
  IRSDK_UNLIMITED_LAPS,
  IRSDK_UNLIMITED_TIME,
  SessionState,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import { describe, expect, it, vi } from "vitest";

import { type LeaderFinish, predictLeaderChequeredS } from "../leader-finish.js";
import { createInitialState, type TranslatorState } from "../state.js";
import {
  diffFuelLapsLeft,
  estimateFuelLapsLeft,
  FUEL_CALLOUT_DEFAULT_MARGIN_LAPS,
  FUEL_COVERAGE_ERROR,
  FUEL_LAPS_LEFT_MAX_COUNT,
  isFuelRaceCovered,
  resolveFuelRaceCoverage,
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
  /** The translator's prediction of the leader's chequered flag (s), `null` when it cannot be made. */
  chequeredInS?: number | null;
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
        chequeredInS = null,
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
        (): LeaderFinish => ({ lapTimeS: leaderLap, chequeredInS }),
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
  it("suppresses the box call on the last lap of a lap-limited race the tank finishes — with NO reassurance for a clamped count", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // SessionLapsRemainEx 1 → 0 full laps needed after the current one. Raw
    // 0.5 laps of fuel covers the 0.45 lap left with 5 % to spare (0.4725),
    // so the box call is noise. The count-0 clamp hides that the post-margin
    // estimate does not finish this lap (effective 0.2 < 0.45), so the
    // enough-fuel reassurance must NOT fire.
    lapSample(run, 5, 1.0, {}, { SessionLapsRemainEx: 1 });

    expect(events).toEqual([]);
  });

  it("warns when the tank will not finish the last lap of a lap-limited race (issue #1405)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Raw 0.3 laps of fuel against the 0.45 lap left: the verdict is on the
    // tank, so the count-0 box call speaks. Before #1405 the clamped count 0
    // "covered" the 0 laps needed after this one and the call was dropped.
    lapSample(run, 5, 0.6, {}, { SessionLapsRemainEx: 1 });

    expect(counts(events)).toEqual([0]);
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

describe("diffFuelLapsLeft — timed-race coverage (issue #880, #1405)", () => {
  // The worked numbers: player avg lap 100 s, sample lands at LapDistPct 0.55.
  // With the leader's chequered flag T s from now, the player takes it at
  // their first crossing at or after it, so the full laps after the current
  // one are ceil(T / 100 + 0.55 + ε) − 1, with ε = 0.03 + 0.01 × (clock /
  // leader lap). T is the translator's prediction (`chequeredInS`), or the
  // bound SessionTimeRemain + 2 × leaderLap when there is none (white at the
  // leader's first crossing after expiry — up to one lap away — plus the
  // white lap itself).
  const TIMED = { SessionLapsRemainEx: 32767 };

  it("suppresses on the leader's white lap when the tank covers the player's last lap (the field repro)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Clock expired, the leader on their white lap half a lap from the line:
    // chequered in 50 s → ceil(0.5 + 0.55 + 0.03) − 1 = 1 lap still to run.
    // Raw 2.05 laps of fuel covers 1.45 × 1.05 → silent (no "plan to box",
    // and no reassurance either without a lap in hand: unclamped 1 < 2).
    lapSample(run, 5, 4.1, { avgLapTime: 100, leaderLap: 100, chequeredInS: 50 }, { SessionTimeRemain: -30, ...TIMED });

    expect(events).toEqual([]);
  });

  it("uses the predicted chequered flag rather than the bound", () => {
    // 100 s on the clock with the leader predicted to take the chequered in
    // 140 s: ceil(1.4 + 0.55 + 0.04) − 1 = 1 lap to run, which 2.05 covers.
    const predicted: PendingEvent[] = [];
    const predictedRunner = makeRunner(predicted);
    lapSample(
      predictedRunner.run,
      5,
      4.1,
      { avgLapTime: 100, leaderLap: 100, chequeredInS: 140 },
      { SessionTimeRemain: 100, ...TIMED },
    );
    expect(predicted).toEqual([]);

    // The same tick without a prediction: the bound 100 + 200 s gives
    // ceil(3 + 0.59) − 1 = 3 laps, which it does not.
    const bound: PendingEvent[] = [];
    const boundRunner = makeRunner(bound);
    lapSample(boundRunner.run, 5, 4.1, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: 100, ...TIMED });
    expect(counts(bound)).toEqual([1]);
  });

  it("counts the later crossing at a near-tie with the leader's chequered flag", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Chequered in 145 s, exactly when the player crosses at the end of their
    // next lap (1.45 + 0.55 = 2): the tolerance counts one lap more, 2 to
    // run, and 2.05 laps of fuel do not cover 2.45 × 1.05.
    lapSample(
      run,
      5,
      4.1,
      { avgLapTime: 100, leaderLap: 100, chequeredInS: 145 },
      { SessionTimeRemain: 100, ...TIMED },
    );

    expect(counts(events)).toEqual([1]);
  });

  it("does not read the White bit on the timed side — it is per car (issue #1405)", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // White up with the clock at 0 and no prediction: the bound 0 + 2 × 100 s
    // gives ceil(2 + 0.55 + 0.03) − 1 = 2 laps, which 2.05 does not cover.
    // Before #1405 the White bit cut the bound to one leader lap → silent.
    lapSample(
      run,
      5,
      4.1,
      { avgLapTime: 100, leaderLap: 100 },
      { SessionTimeRemain: 0, SessionFlags: Flags.White, ...TIMED },
    );

    expect(counts(events)).toEqual([1]);
  });

  it("keeps announcing on an expired clock when the leader's finish cannot be predicted", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // A negative clock is no duration to bound by, and there is no
    // prediction: the timed side is unknown, never a short race.
    lapSample(run, 5, 4.1, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: -30, ...TIMED });

    expect(counts(events)).toEqual([1]);
  });

  it("falls back to the clock plus two leader laps when the leader's finish cannot be predicted", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 10 s on the clock and no prediction (an unknown leader lap fraction, say)
    // — the leader might have just missed the line, making the chequered land
    // at ~10 + 2 × 100 s. That is ceil(2.1 + 0.55 + 0.031) − 1 = 2 laps still
    // to run; 2.05 laps of fuel fall short and the warning must fire.
    lapSample(run, 5, 4.1, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: 10, ...TIMED });

    expect(counts(events)).toEqual([1]);
  });

  it("still announces when the timed estimate says more laps remain than the tank covers", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // ceil(6 + 0.55 + 0.07) − 1 = 6 laps to run; count 1 falls short.
    lapSample(run, 5, 4.1, { avgLapTime: 100, leaderLap: 100 }, { SessionTimeRemain: 400, ...TIMED });

    expect(counts(events)).toEqual([1]);
  });

  it("falls back to the player's own pace when the leader's lap time is unknown", () => {
    // Leader pace unknown → bound 30 + 2 × 100 s (the PLAYER's lap):
    // ceil(2.3 + 0.55 + 0.033) − 1 = 2 laps, which 3.05 covers → silent.
    const unknown: PendingEvent[] = [];
    const unknownRunner = makeRunner(unknown);
    lapSample(unknownRunner.run, 5, 6.1, { avgLapTime: 100, leaderLap: null }, { SessionTimeRemain: 30, ...TIMED });
    expect(unknown).toEqual([]);

    // A known 200 s leader lap stretches it to ceil(4.3 + 0.58) − 1 = 4 laps.
    const slow: PendingEvent[] = [];
    const slowRunner = makeRunner(slow);
    lapSample(slowRunner.run, 5, 6.1, { avgLapTime: 100, leaderLap: 200 }, { SessionTimeRemain: 30, ...TIMED });
    expect(counts(slow)).toEqual([2]);
  });

  it("a faster overall leader (multiclass) shortens the estimate", () => {
    // Same clock, same player pace — only the leader lap time differs.
    // leaderLap 60: ceil(2.2 + 0.55 + 0.047) − 1 = 2 → 3.05 covers 2.45 × 1.05.
    const fast: PendingEvent[] = [];
    const fastRunner = makeRunner(fast);
    lapSample(fastRunner.run, 5, 6.1, { avgLapTime: 100, leaderLap: 60 }, { SessionTimeRemain: 100, ...TIMED });
    expect(counts(fast)).toEqual([]);

    // leaderLap 100: ceil(3 + 0.55 + 0.04) − 1 = 3 → 3.05 falls short of 3.45 × 1.05.
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
    // clock ends the race within ceil(2.3 + 0.55 + 0.033) − 1 = 2 laps →
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

    // ceil(10 + 0.55 + 0.11) − 1 = 10 laps to run — the endgame edge.
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

describe("estimateFuelLapsLeft (issue #1387)", () => {
  it("returns every step of the count: raw, margin, effective, lap fraction, floored and clamped", () => {
    const estimate = estimateFuelLapsLeft(10, 0.5, 2, 0.3);

    expect(estimate.rawLapsLeft).toBe(5);
    expect(estimate.marginLaps).toBe(0.3);
    expect(estimate.effective).toBeCloseTo(4.7, 10);
    expect(estimate.lapFractionRemaining).toBe(0.5);
    expect(estimate.unclampedCount).toBe(4);
    expect(estimate.count).toBe(4);
  });

  it("keeps the negative unclamped count the clamp hides", () => {
    // raw 0.25 − margin 0.3 − half a lap still to run → floor(−0.55) = −1:
    // the tank will not finish the current lap, and `count` alone reads 0.
    const estimate = estimateFuelLapsLeft(0.5, 0.5, 2, 0.3);

    expect(estimate.unclampedCount).toBe(-1);
    expect(estimate.count).toBe(0);
  });
});

describe("resolveFuelRaceCoverage (issue #1387)", () => {
  const NO_LAPS: FuelStats = { lastLap: 2, avg: 2, avgLapTime: null, samples: 5 };
  const TIMED_STATS: FuelStats = { lastLap: 2, avg: 2, avgLapTime: 100, samples: 5 };
  const UNLIMITED = { SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS, SessionTimeRemain: IRSDK_UNLIMITED_TIME };
  const NO_LEADER = (): LeaderFinish => ({ lapTimeS: null, chequeredInS: null });
  const leader =
    (lapTimeS: number | null, chequeredInS: number | null = null) =>
    (): LeaderFinish => ({ lapTimeS, chequeredInS });

  it("bridges the lap counter to laps needed after the current one", () => {
    const coverage = resolveFuelRaceCoverage(
      tick({ SessionLapsRemainEx: 5, SessionTimeRemain: IRSDK_UNLIMITED_TIME }),
      NO_LAPS,
      0.45,
      NO_LEADER,
    );

    expect(coverage).toEqual({ lapsNeededAfterCurrent: 4, timedLapsAfterCurrent: null, remainingLaps: 4 });
  });

  it("clamps the lap side to one while the white flag flies over a raw counter of 1", () => {
    const coverage = resolveFuelRaceCoverage(
      tick({ SessionLapsRemainEx: 1, SessionTimeRemain: IRSDK_UNLIMITED_TIME, SessionFlags: Flags.White }),
      NO_LAPS,
      0.45,
      NO_LEADER,
    );

    expect(coverage.lapsNeededAfterCurrent).toBe(1);
    expect(coverage.remainingLaps).toBe(1);
  });

  it("reads a raw counter of 1 without the white flag as nothing left after the current lap", () => {
    const coverage = resolveFuelRaceCoverage(
      tick({ SessionLapsRemainEx: 1, SessionTimeRemain: IRSDK_UNLIMITED_TIME }),
      NO_LAPS,
      0.45,
      NO_LEADER,
    );

    expect(coverage.lapsNeededAfterCurrent).toBe(0);
  });

  it("reports both sides unknown and an infinite distance when neither limit is set", () => {
    const coverage = resolveFuelRaceCoverage(tick(UNLIMITED), TIMED_STATS, 0.45, leader(100));

    expect(coverage).toEqual({
      lapsNeededAfterCurrent: null,
      timedLapsAfterCurrent: null,
      remainingLaps: Number.POSITIVE_INFINITY,
    });
  });

  it("does not ask about the leader when the clock is unlimited", () => {
    const getLeaderFinish = vi.fn(leader(100));

    resolveFuelRaceCoverage(tick(UNLIMITED), TIMED_STATS, 0.45, getLeaderFinish);
    resolveFuelRaceCoverage(tick({ ...UNLIMITED, SessionLapsRemainEx: 5 }), TIMED_STATS, 0.45, getLeaderFinish);

    expect(getLeaderFinish).not.toHaveBeenCalled();
  });

  it("does not ask about the leader without a validated player lap time", () => {
    const getLeaderFinish = vi.fn(leader(100));

    const coverage = resolveFuelRaceCoverage(
      tick({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS, SessionTimeRemain: 400 }),
      NO_LAPS,
      0.45,
      getLeaderFinish,
    );

    expect(getLeaderFinish).not.toHaveBeenCalled();
    expect(coverage.timedLapsAfterCurrent).toBeNull();
  });

  it("asks once and counts the timed side from the clock plus two leader laps without a prediction", () => {
    const getLeaderFinish = vi.fn(leader(100));

    // The diff suite's worked numbers: ceil(600 / 100 + 0.55 + 0.07) − 1 = 6.
    const coverage = resolveFuelRaceCoverage(
      tick({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS, SessionTimeRemain: 400 }),
      TIMED_STATS,
      0.45,
      getLeaderFinish,
    );

    expect(getLeaderFinish).toHaveBeenCalledTimes(1);
    expect(coverage).toEqual({ lapsNeededAfterCurrent: null, timedLapsAfterCurrent: 6, remainingLaps: 6 });
  });

  it("takes whichever limit ends the race sooner when a session carries both", () => {
    const coverage = resolveFuelRaceCoverage(
      tick({ SessionLapsRemainEx: 3, SessionTimeRemain: 400 }),
      TIMED_STATS,
      0.45,
      leader(100),
    );

    expect(coverage).toEqual({ lapsNeededAfterCurrent: 2, timedLapsAfterCurrent: 6, remainingLaps: 2 });
  });

  it("counts the player's crossings up to the leader's predicted chequered flag (issue #1405)", () => {
    // Chequered in 140 s, the player 55 % round a 100 s lap with 100 s on the
    // clock: ceil(1.4 + 0.55 + 0.04) − 1 = 1.
    const coverage = resolveFuelRaceCoverage(
      tick({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS, SessionTimeRemain: 100 }),
      TIMED_STATS,
      0.45,
      leader(100, 140),
    );

    expect(coverage.timedLapsAfterCurrent).toBe(1);
  });

  it("reads a prediction on an expired clock, and nothing without one", () => {
    const expired = tick({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS, SessionTimeRemain: -30 });

    // ε is the fixed 0.03 once expired: ceil(0.5 + 0.55 + 0.03) − 1 = 1.
    expect(resolveFuelRaceCoverage(expired, TIMED_STATS, 0.45, leader(100, 50)).timedLapsAfterCurrent).toBe(1);
    expect(resolveFuelRaceCoverage(expired, TIMED_STATS, 0.45, leader(100)).timedLapsAfterCurrent).toBeNull();
  });

  it("bounds a clock at exactly zero by two leader laps when there is no prediction", () => {
    const coverage = resolveFuelRaceCoverage(
      tick({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS, SessionTimeRemain: 0, SessionFlags: Flags.White }),
      TIMED_STATS,
      0.45,
      leader(100),
    );

    // ceil(200 / 100 + 0.55 + 0.03) − 1 = 2, the White bit notwithstanding.
    expect(coverage.timedLapsAfterCurrent).toBe(2);
  });

  it("ignores a prediction that is not a duration", () => {
    for (const chequeredInS of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const coverage = resolveFuelRaceCoverage(
        tick({ SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS, SessionTimeRemain: 400 }),
        TIMED_STATS,
        0.45,
        leader(100, chequeredInS),
      );

      // The bound, as without one: 6.
      expect(coverage.timedLapsAfterCurrent).toBe(6);
    }
  });
});

describe("isFuelRaceCovered (issue #1405)", () => {
  // Half of this lap plus one more: 1.5 laps of fuel needed, 1.575 with the allowance.
  const halfLapLeft = (rawLapsLeft: number) => ({ rawLapsLeft, lapFractionRemaining: 0.5 });

  it("keeps a 5 % allowance on the distance left", () => {
    expect(FUEL_COVERAGE_ERROR).toBe(0.05);
    expect(isFuelRaceCovered(halfLapLeft(1.5 * 1.04), 1)).toBe(false);
    expect(isFuelRaceCovered(halfLapLeft(1.5 * 1.06), 1)).toBe(true);
    expect(isFuelRaceCovered(halfLapLeft(1.5), 1)).toBe(false);
  });

  it("judges the raw tank, so a margin that empties the count does not matter", () => {
    // 1.7 laps of fuel with a 1.5-lap margin counts 0 full laps after this
    // one, but the tank covers the half lap left and one more.
    const estimate = estimateFuelLapsLeft(3.4, 0.5, 2, 1.5);

    expect(estimate.count).toBe(0);
    expect(isFuelRaceCovered(estimate, 1)).toBe(true);
  });

  it("grows with the distance left", () => {
    // Ten laps after this one: 10.5 laps needed, 11.025 with the allowance.
    expect(isFuelRaceCovered(halfLapLeft(11), 10)).toBe(false);
    expect(isFuelRaceCovered(halfLapLeft(11.03), 10)).toBe(true);
  });

  it("covers only the rest of the current lap when nothing is left after it", () => {
    expect(isFuelRaceCovered(halfLapLeft(0.5), 0)).toBe(false);
    expect(isFuelRaceCovered(halfLapLeft(0.53), 0)).toBe(true);
  });

  it("never covers an unknown distance", () => {
    expect(isFuelRaceCovered(halfLapLeft(1000), Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("diffFuelLapsLeft — the race-end reports (issue #1405)", () => {
  // Player car 0 runs second to the leader, car 1, at a 100 s average and
  // 2 L a lap; the mid-lap sample lands at LapDistPct 0.55.
  const ORDER = [2, 1];
  const field = (leaderPct: number): Partial<TelemetryData> => ({
    SessionLapsRemainEx: IRSDK_UNLIMITED_LAPS,
    CarIdxLapDistPct: [0.55, leaderPct],
    CarIdxTrackSurface: [TrkLoc.OnTrack, TrkLoc.OnTrack],
  });

  // Driver A, the leader's white still to come: 40 s on the clock and the
  // 85 s leader 35 % round, so they take the white at their first crossing
  // (55 s from now, after expiry) and the chequered one lap later.
  const clockRunning = { ...field(0.35), SessionTimeRemain: 40 };
  const chequeredRunning = predictLeaderChequeredS(tick({ LapDistPct: 0.55, ...clockRunning }), ORDER, 85, false);

  // Driver A, the leader already on the white lap: the clock ran out a lap
  // ago, and the 90 s leader is 40 % round their last lap.
  const clockExpired = { ...field(0.4), SessionTimeRemain: -45 };
  const chequeredExpired = predictLeaderChequeredS(tick({ LapDistPct: 0.55, ...clockExpired }), ORDER, 90, true);

  it("predicts the chequered flag the reports rest on", () => {
    // (2 − 0.35) × 85 and (1 − 0.4) × 90: in both, the player crosses the
    // line at the end of this lap (45 s) before it, and at the end of the
    // next one after it — one lap to run after this one.
    expect(chequeredRunning).toBeCloseTo(140.25, 9);
    expect(chequeredExpired).toBeCloseTo(54, 9);
  });

  it("driver A: margin 0, the tank covers the one lap left before the leader's white — silent", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 1.7 laps of fuel: count 1 ("1 more lap") against the bound's two laps
    // before #1405; the prediction leaves one, which the tank covers.
    lapSample(
      run,
      34,
      3.4,
      { margin: 0, avgLapTime: 100, leaderLap: 85, chequeredInS: chequeredRunning },
      clockRunning,
    );

    expect(events).toEqual([]);
  });

  it("driver A: margin 0, the leader already on the white lap — silent", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Before #1405 an expired clock left the timed side unknown and warned.
    lapSample(
      run,
      34,
      3.4,
      { margin: 0, avgLapTime: 100, leaderLap: 90, chequeredInS: chequeredExpired },
      clockExpired,
    );

    expect(events).toEqual([]);
  });

  it("driver B: margin 0.4, one lap to go and the tank enough — silent", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // Two laps on the counter: one after this one. 1.7 laps of fuel less the
    // 0.4 margin counts 0 ("box this lap") before #1405; the tank covers the
    // 1.45 laps left with 5 % to spare.
    lapSample(run, 33, 3.4, { margin: 0.4 }, { SessionLapsRemainEx: 2 });

    expect(events).toEqual([]);
  });

  it("a genuine shortage still warns: the tank runs out half a lap before the flag", () => {
    const events: PendingEvent[] = [];
    const { run } = makeRunner(events);

    // 0.95 laps of fuel against the 1.45 to the leader's chequered: box now.
    lapSample(
      run,
      34,
      1.9,
      { margin: 0, avgLapTime: 100, leaderLap: 85, chequeredInS: chequeredRunning },
      clockRunning,
    );

    expect(counts(events)).toEqual([0]);
  });
});
