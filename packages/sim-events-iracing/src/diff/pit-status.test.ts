/**
 * Unit tests for the pit-service status diff translator (issue #479).
 *
 * Pins:
 *   - first-tick seeding (no fire when connecting mid-stop)
 *   - off-track / in-pit-stall re-seeding (no phantom callouts on garage
 *     return or replay scrubs)
 *   - one event per non-`None` target, with correct `from` / `to`
 *   - `* → None` closing transitions are silent (baseline still advances)
 *   - positioning corrections (`TooFarLeft → TooFarRight`) emit with the
 *     direct from/to pair
 *   - re-emit on subsequent transitions after a closing-to-`None`
 *   - the positioning-error repeat cadence, its movement hold, and its
 *     cycle reset (issue #951)
 */
import { PitSvStatus, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import {
  diffPitStatus,
  PIT_STATUS_MOVEMENT_SPEED_MPS,
  PIT_STATUS_REPEAT_INTERVAL_MS,
  PIT_STATUS_REST_SETTLE_MS,
} from "./pit-status.js";
import type { PendingEvent } from "./types.js";

/** Arbitrary epoch-ish base so the tests read as absolute timestamps. */
const T0 = 1_700_000_000_000;

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    PlayerCarInPitStall: false,
    PlayerCarPitSvStatus: PitSvStatus.None,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function statusEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "pitService.statusChanged");
}

function repeatEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "pitService.positioningRepeat");
}

describe("diffPitStatus — seeding", () => {
  it("does not emit on the first tick when idle", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), T0, emit);

    expect(statusEvents(events)).toHaveLength(0);
    expect(state.pitStatusInitialized).toBe(true);
    expect(state.lastPitSvStatus).toBe(PitSvStatus.None);
  });

  it("does not emit when connecting mid-stop (status already InProgress)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0, emit);

    expect(statusEvents(events)).toHaveLength(0);
    expect(state.lastPitSvStatus).toBe(PitSvStatus.InProgress);
  });

  it("does not emit while off-track (garage / replay scrub)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick({ IsOnTrack: false, PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0, emit);
    diffPitStatus(state, tick({ IsOnTrack: false, PlayerCarPitSvStatus: PitSvStatus.Complete }), T0 + 100, emit);

    expect(statusEvents(events)).toHaveLength(0);
  });
});

describe("diffPitStatus — emission inside pit stall (production case)", () => {
  // Every one of the eight callouts only fires while parked in the stall.
  // Production-captured telemetry confirms `IsOnTrack: true,
  // PlayerCarInPitStall: true, PlayerCarPitSvStatus: 1` (InProgress) during
  // an active stop. The diff must NOT re-seed silently on `inPitStall`.
  it("emits InProgress and Complete during a normal stop", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    // Seed: idle on pit road, just before the stall.
    diffPitStatus(state, tick(), T0, emit);
    // Crew starts working.
    diffPitStatus(
      state,
      tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: PitSvStatus.InProgress }),
      T0 + 100,
      emit,
    );
    // Crew finishes.
    diffPitStatus(
      state,
      tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: PitSvStatus.Complete }),
      T0 + 200,
      emit,
    );

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[0].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.InProgress });
    expect(fired[1].data).toEqual({ from: PitSvStatus.InProgress, to: PitSvStatus.Complete });
  });

  it("matches the production-captured snapshot — IsOnTrack:true + InPitStall:true + status=1 fires InProgress", () => {
    // Pinned against `master/local/telemetry-snapshot-20260505-192236.json`
    // (lines 27, 57, 58). Regression guard for the original bug where
    // `inPitStall` re-seeded silently and swallowed every callout.
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), T0, emit); // seed at None outside stall
    diffPitStatus(
      state,
      tick({
        IsOnTrack: true,
        PlayerCarInPitStall: true,
        PlayerCarPitSvStatus: 1, // PitSvStatus.InProgress, exactly as captured
      }),
      T0 + 100,
      emit,
    );

    const fired = statusEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.InProgress });
  });

  it("emits a positioning correction while in the stall", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), T0, emit);
    diffPitStatus(
      state,
      tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: PitSvStatus.TooFarLeft }),
      T0 + 100,
      emit,
    );
    diffPitStatus(
      state,
      tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: PitSvStatus.TooFarRight }),
      T0 + 200,
      emit,
    );

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[1].data).toEqual({ from: PitSvStatus.TooFarLeft, to: PitSvStatus.TooFarRight });
  });
});

describe("diffPitStatus — emission", () => {
  it.each([
    PitSvStatus.InProgress,
    PitSvStatus.Complete,
    PitSvStatus.TooFarLeft,
    PitSvStatus.TooFarRight,
    PitSvStatus.TooFarForward,
    PitSvStatus.TooFarBack,
    PitSvStatus.BadAngle,
    PitSvStatus.CantFixThat,
  ])("emits one statusChanged event when transitioning None → %s", (target) => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), T0, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: target }), T0 + 100, emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0].data).toEqual({ from: PitSvStatus.None, to: target });
    expect(state.lastPitSvStatus).toBe(target);
  });

  it("emits with direct from/to on a positioning correction (TooFarLeft → TooFarRight)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), T0, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.TooFarLeft }), T0 + 100, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.TooFarRight }), T0 + 200, emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[1].data).toEqual({ from: PitSvStatus.TooFarLeft, to: PitSvStatus.TooFarRight });
  });

  it("does not emit on duplicate ticks of the same status", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), T0, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0 + 100, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0 + 200, emit);

    expect(statusEvents(events)).toHaveLength(1);
  });
});

describe("diffPitStatus — silent close", () => {
  it("absorbs `* → None` without emitting but still advances the baseline", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), T0, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.Complete }), T0 + 100, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.None }), T0 + 200, emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.Complete });
    expect(state.lastPitSvStatus).toBe(PitSvStatus.None);
  });

  it("re-fires on the next pit stop after a `* → None` close", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitStatus(state, tick(), T0, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0 + 100, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.None }), T0 + 200, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0 + 300, emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[1].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.InProgress });
  });
});

// ── Positioning-error repeat cadence (issue #951) ─────────────────────────

const POSITIONING_ERRORS = [
  PitSvStatus.TooFarLeft,
  PitSvStatus.TooFarRight,
  PitSvStatus.TooFarForward,
  PitSvStatus.TooFarBack,
  PitSvStatus.BadAngle,
] as const;

const ONE_SHOT_STATUSES = [PitSvStatus.InProgress, PitSvStatus.Complete, PitSvStatus.CantFixThat] as const;

/** Telemetry for a car parked in its box with the given latched status. */
function parked(status: PitSvStatus, speedMps = 0): TelemetryData {
  return tick({ PlayerCarInPitStall: true, PlayerCarPitSvStatus: status, Speed: speedMps });
}

/**
 * Seed the diff and drive the transition into `status` at `T0`, so each
 * repeat test starts from a freshly-armed cycle.
 */
function enterError(status: PitSvStatus, emit: (e: PendingEvent) => void): ReturnType<typeof createInitialState> {
  const state = createInitialState();

  diffPitStatus(state, tick(), T0 - 100, emit);
  diffPitStatus(state, parked(status), T0, emit);

  return state;
}

describe("diffPitStatus — positioning repeat (#951)", () => {
  it.each(POSITIONING_ERRORS)("repeats %s once the interval elapses while the car sits still", (status) => {
    const { events, emit } = collect();
    const state = enterError(status, emit);

    diffPitStatus(state, parked(status), T0 + PIT_STATUS_REPEAT_INTERVAL_MS - 1, emit);
    expect(repeatEvents(events)).toHaveLength(0);

    diffPitStatus(state, parked(status), T0 + PIT_STATUS_REPEAT_INTERVAL_MS, emit);

    const fired = repeatEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0].data).toEqual({ status });
  });

  it("keeps repeating on the interval for as long as the error persists", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    for (let elapsed = 0; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 3; elapsed += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarForward), T0 + elapsed, emit);
    }

    expect(repeatEvents(events)).toHaveLength(3);
  });

  it.each(ONE_SHOT_STATUSES)("never repeats the one-shot status %s", (status) => {
    const { events, emit } = collect();
    const state = enterError(status, emit);

    for (let elapsed = 0; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 5; elapsed += 100) {
      diffPitStatus(state, parked(status), T0 + elapsed, emit);
    }

    expect(repeatEvents(events)).toHaveLength(0);
  });

  it("stops repeating once the error clears", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    diffPitStatus(state, parked(PitSvStatus.None), T0 + 100, emit);

    for (let elapsed = 200; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 3; elapsed += 100) {
      diffPitStatus(state, parked(PitSvStatus.None), T0 + elapsed, emit);
    }

    expect(repeatEvents(events)).toHaveLength(0);
  });

  it("does not repeat while off-track", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    for (let elapsed = 100; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 3; elapsed += 100) {
      diffPitStatus(
        state,
        tick({ IsOnTrack: false, PlayerCarPitSvStatus: PitSvStatus.TooFarForward, Speed: 0 }),
        T0 + elapsed,
        emit,
      );
    }

    expect(repeatEvents(events)).toHaveLength(0);
  });

  it("treats missing Speed telemetry as at rest rather than suppressing the repeat", () => {
    const { events, emit } = collect();
    const state = createInitialState();

    diffPitStatus(state, tick(), T0 - 100, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.BadAngle }), T0, emit);
    diffPitStatus(
      state,
      tick({ PlayerCarPitSvStatus: PitSvStatus.BadAngle }),
      T0 + PIT_STATUS_REPEAT_INTERVAL_MS,
      emit,
    );

    expect(repeatEvents(events)).toHaveLength(1);
  });
});

describe("diffPitStatus — positioning repeat movement hold (#951)", () => {
  it("holds the repeat while the car is being repositioned", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    for (let elapsed = 100; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 3; elapsed += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarForward, 1.5), T0 + elapsed, emit);
    }

    expect(repeatEvents(events)).toHaveLength(0);
  });

  it("treats a crawl just above the movement threshold as moving", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);
    const crawl = PIT_STATUS_MOVEMENT_SPEED_MPS * 1.5;

    for (let elapsed = 100; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 3; elapsed += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarForward, crawl), T0 + elapsed, emit);
    }

    expect(repeatEvents(events)).toHaveLength(0);
  });

  it("treats a reverse crawl as moving (signed Speed)", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);
    const crawl = -PIT_STATUS_MOVEMENT_SPEED_MPS * 1.5;

    for (let elapsed = 100; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 3; elapsed += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarForward, crawl), T0 + elapsed, emit);
    }

    expect(repeatEvents(events)).toHaveLength(0);
  });

  it("resumes the repeat once the car comes to rest still misaligned", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);
    const stoppedAt = T0 + 5000;

    for (let elapsed = 100; elapsed < 5000; elapsed += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarForward, 1.5), T0 + elapsed, emit);
    }

    expect(repeatEvents(events)).toHaveLength(0);

    // Comes to rest — still nothing until the settle window has passed.
    diffPitStatus(state, parked(PitSvStatus.TooFarForward), stoppedAt, emit);
    diffPitStatus(state, parked(PitSvStatus.TooFarForward), stoppedAt + PIT_STATUS_REST_SETTLE_MS - 1, emit);
    expect(repeatEvents(events)).toHaveLength(0);

    diffPitStatus(state, parked(PitSvStatus.TooFarForward), stoppedAt + PIT_STATUS_REST_SETTLE_MS, emit);
    expect(repeatEvents(events)).toHaveLength(1);
  });

  it("waits a full interval after a held repeat rather than firing twice back to back", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarBack, emit);
    const stoppedAt = T0 + 10_000;

    for (let elapsed = 100; elapsed < 10_000; elapsed += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarBack, 1.5), T0 + elapsed, emit);
    }

    const resumedAt = stoppedAt + PIT_STATUS_REST_SETTLE_MS;

    for (let at = stoppedAt; at <= resumedAt; at += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarBack), at, emit);
    }

    expect(repeatEvents(events)).toHaveLength(1);

    // The overdue backlog must not drain as a burst on the next few ticks.
    diffPitStatus(state, parked(PitSvStatus.TooFarBack), resumedAt + 100, emit);
    diffPitStatus(state, parked(PitSvStatus.TooFarBack), resumedAt + PIT_STATUS_REPEAT_INTERVAL_MS - 1, emit);
    expect(repeatEvents(events)).toHaveLength(1);

    diffPitStatus(state, parked(PitSvStatus.TooFarBack), resumedAt + PIT_STATUS_REPEAT_INTERVAL_MS, emit);
    expect(repeatEvents(events)).toHaveLength(2);
  });

  it("defers the repeat when a single noisy speed sample lands just before it is due", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarLeft, emit);
    const dueAt = T0 + PIT_STATUS_REPEAT_INTERVAL_MS;
    const noiseAt = dueAt - 100;

    for (let at = T0 + 100; at < noiseAt; at += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarLeft), at, emit);
    }

    // One spurious sample above the threshold resets the rest clock, so the
    // repeat has to wait out a fresh settle window measured from the next
    // still tick — the safe direction for noise.
    diffPitStatus(state, parked(PitSvStatus.TooFarLeft, 1.5), noiseAt, emit);

    const settledAt = noiseAt + 100;

    for (let at = settledAt; at < settledAt + PIT_STATUS_REST_SETTLE_MS; at += 100) {
      diffPitStatus(state, parked(PitSvStatus.TooFarLeft), at, emit);
    }

    expect(repeatEvents(events)).toHaveLength(0);

    diffPitStatus(state, parked(PitSvStatus.TooFarLeft), settledAt + PIT_STATUS_REST_SETTLE_MS, emit);
    expect(repeatEvents(events)).toHaveLength(1);
  });
});

describe("diffPitStatus — positioning repeat cycle reset (#951)", () => {
  it("restarts the cycle on a new positioning error and speaks the full transition call", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    diffPitStatus(state, parked(PitSvStatus.TooFarForward), T0 + PIT_STATUS_REPEAT_INTERVAL_MS, emit);
    expect(repeatEvents(events)).toHaveLength(1);

    // Over-corrected: a different error takes over.
    const switchedAt = T0 + PIT_STATUS_REPEAT_INTERVAL_MS + 500;

    diffPitStatus(state, parked(PitSvStatus.TooFarBack), switchedAt, emit);

    const changes = statusEvents(events);

    expect(changes).toHaveLength(2);
    expect(changes[1].data).toEqual({ from: PitSvStatus.TooFarForward, to: PitSvStatus.TooFarBack });
    expect(repeatEvents(events)).toHaveLength(1);

    // The new error's own cycle starts from the transition, not from the
    // previous error's clock.
    diffPitStatus(state, parked(PitSvStatus.TooFarBack), switchedAt + PIT_STATUS_REPEAT_INTERVAL_MS - 1, emit);
    expect(repeatEvents(events)).toHaveLength(1);

    diffPitStatus(state, parked(PitSvStatus.TooFarBack), switchedAt + PIT_STATUS_REPEAT_INTERVAL_MS, emit);

    const repeats = repeatEvents(events);

    expect(repeats).toHaveLength(2);
    expect(repeats[1].data).toEqual({ status: PitSvStatus.TooFarBack });
  });

  it("disarms the cycle when a positioning error resolves into service starting", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    diffPitStatus(state, parked(PitSvStatus.InProgress), T0 + 100, emit);

    for (let elapsed = 200; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 3; elapsed += 100) {
      diffPitStatus(state, parked(PitSvStatus.InProgress), T0 + elapsed, emit);
    }

    expect(repeatEvents(events)).toHaveLength(0);
  });

  it("re-arms after a close to None and a fresh positioning error", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    diffPitStatus(state, parked(PitSvStatus.None), T0 + 100, emit);

    const reEnteredAt = T0 + 200;

    diffPitStatus(state, parked(PitSvStatus.TooFarRight), reEnteredAt, emit);
    diffPitStatus(state, parked(PitSvStatus.TooFarRight), reEnteredAt + PIT_STATUS_REPEAT_INTERVAL_MS, emit);

    const repeats = repeatEvents(events);

    expect(repeats).toHaveLength(1);
    expect(repeats[0].data).toEqual({ status: PitSvStatus.TooFarRight });
  });
});
