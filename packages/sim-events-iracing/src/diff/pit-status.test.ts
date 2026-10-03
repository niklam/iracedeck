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
 *   - that the repeat is armed from the LEVEL, so a re-seed mid-stop (plugin
 *     restart, SDK reconnect, off-track blip, replay wipe) can't silence a
 *     still-latched error — and still waits a full interval when it does
 *   - the `OnPitRoad` bound, which stops a latched status nagging forever
 *     once the car has left the pit lane, without breaking the overshoot
 *     case that reads `PlayerCarInPitStall: false`
 *   - `pitService.stopEmpty` (issue #1180): a `PitstopActive` pulse shorter
 *     than `PIT_STATUS_EMPTY_STOP_MAX_MS` that falls on the InPitStall surface
 *     releases the driver, replayed frame by frame from the three captured
 *     empty stops (two of which never report InProgress); a real stop's
 *     service-long pulse, a pulse at or over the bound, one already up at the
 *     seed, one falling off the stall surface, or no `PitstopActive` at all
 *     stays silent, and a missing surface qualifies. `statusChanged` keeps
 *     mirroring the sim: InProgress is emitted on the tick it appears
 */
import { PitSvStatus, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import {
  diffPitStatus,
  PIT_STATUS_EMPTY_STOP_MAX_MS,
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

function stopEmptyEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "pitService.stopEmpty");
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

    // No `PitstopActive` pulse here, so the close is the plain silent kind —
    // no release (#1180).
    diffPitStatus(state, tick(), T0, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0 + 100, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.None }), T0 + 5000, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0 + 6000, emit);

    const fired = statusEvents(events);

    expect(fired).toHaveLength(2);
    expect(fired[1].data).toEqual({ from: PitSvStatus.None, to: PitSvStatus.InProgress });
    expect(stopEmptyEvents(events)).toHaveLength(0);
  });
});

describe("diffPitStatus — empty stop (#1180)", () => {
  /**
   * One captured frame: `[sessionTime (s), PlayerCarPitSvStatus,
   * PlayerTrackSurface, PlayerCarInPitStall, PitstopActive, OnPitRoad, Speed]`.
   * `IsOnTrack` read true on every frame of every window below, and the
   * 2026-09-19 capture has no `Speed` (left out of the tick, not zeroed).
   */
  type Frame = readonly [number, PitSvStatus, TrkLoc, boolean, boolean, boolean, number?];

  const STALL = TrkLoc.InPitStall;
  const APPROACH = TrkLoc.AproachingPits;
  const BACK = PitSvStatus.TooFarBack;

  /**
   * Replay frames through the diff, `now` taken from `sessionTime` in ms.
   * Returns the events and the `now` of each tick that emitted
   * `pitService.stopEmpty`.
   */
  function replay(frames: readonly Frame[]): { events: PendingEvent[]; releasedAt: number[] } {
    const state = createInitialState();
    const { events, emit } = collect();
    const releasedAt: number[] = [];

    for (const [sessionTime, status, surface, inStall, active, onPitRoad, speed] of frames) {
      const now = Math.round(sessionTime * 1000);
      const before = stopEmptyEvents(events).length;

      diffPitStatus(
        state,
        tick({
          IsOnTrack: true,
          OnPitRoad: onPitRoad,
          PlayerCarPitSvStatus: status,
          PlayerTrackSurface: surface,
          PlayerCarInPitStall: inStall,
          PitstopActive: active,
          ...(speed === undefined ? {} : { Speed: speed }),
        }),
        now,
        emit,
      );

      if (stopEmptyEvents(events).length > before) releasedAt.push(now);
    }

    return { events, releasedAt };
  }

  /**
   * 2026-10-03, 348 s: overshoot, backed into the box. TooFarBack clears to
   * None while the car still rolls at 1.24 m/s and InProgress never appears;
   * `PitstopActive` pulses for four frames on the stall surface. Every frame
   * from 348.200 s on; the approach before it keeps only the frames where a
   * discrete value changed.
   */
  const OVERSHOOT_2026_10_03: readonly Frame[] = [
    [343.35, PitSvStatus.None, APPROACH, false, false, true, 0.135],
    [343.367, BACK, APPROACH, false, false, true, 0.004],
    [347.267, BACK, STALL, false, false, true, 0.789],
    [348.2, BACK, STALL, false, false, true, 1.241],
    [348.217, BACK, STALL, false, false, true, 1.238],
    [348.233, PitSvStatus.None, STALL, false, false, true, 1.238],
    [348.25, PitSvStatus.None, STALL, false, false, true, 1.236],
    [348.267, PitSvStatus.None, STALL, false, false, true, 1.234],
    [348.283, PitSvStatus.None, STALL, false, false, true, 1.233],
    [348.3, PitSvStatus.None, STALL, false, false, true, 1.231],
    [348.317, PitSvStatus.None, STALL, false, false, true, 1.23],
    [348.333, PitSvStatus.None, STALL, false, false, true, 1.228],
    [348.35, PitSvStatus.None, STALL, false, false, true, 1.227],
    [348.367, PitSvStatus.None, STALL, false, false, true, 1.218],
    [348.383, PitSvStatus.None, STALL, false, false, true, 1.196],
    [348.4, PitSvStatus.None, STALL, false, false, true, 1.163],
    [348.417, PitSvStatus.None, STALL, false, false, true, 1.119],
    [348.433, PitSvStatus.None, STALL, false, false, true, 1.066],
    [348.45, PitSvStatus.None, STALL, false, false, true, 1.004],
    [348.467, PitSvStatus.None, STALL, false, false, true, 0.925],
    [348.483, PitSvStatus.None, STALL, false, false, true, 0.836],
    [348.5, PitSvStatus.None, STALL, false, false, true, 0.741],
    [348.517, PitSvStatus.None, STALL, false, false, true, 0.641],
    [348.533, PitSvStatus.None, STALL, false, false, true, 0.535],
    [348.55, PitSvStatus.None, STALL, false, false, true, 0.425],
    [348.567, PitSvStatus.None, STALL, false, false, true, 0.311],
    [348.583, PitSvStatus.None, STALL, false, false, true, 0.193],
    [348.6, PitSvStatus.None, STALL, false, false, true, 0.068],
    [348.617, PitSvStatus.None, STALL, false, true, true, 0.06],
    [348.633, PitSvStatus.None, STALL, false, true, true, 0.097],
    [348.65, PitSvStatus.None, STALL, false, true, true, 0.042],
    [348.667, PitSvStatus.None, STALL, false, true, true, 0.029],
    [348.683, PitSvStatus.None, STALL, false, false, true, 0.05],
    [348.7, PitSvStatus.None, STALL, false, false, true, 0.021],
    [348.717, PitSvStatus.None, STALL, false, false, true, 0.017],
    [348.733, PitSvStatus.None, STALL, false, false, true, 0.027],
    [348.75, PitSvStatus.None, STALL, false, false, true, 0.01],
    [348.767, PitSvStatus.None, STALL, true, false, true, 0.011],
    [348.783, PitSvStatus.None, STALL, true, false, true, 0.017],
    [348.8, PitSvStatus.None, STALL, true, false, true, 0.007],
    [350.4, PitSvStatus.None, STALL, false, false, true, 0.842],
    [351.0, PitSvStatus.None, APPROACH, false, false, true, 5.095],
  ];

  /**
   * 2026-10-03, 414 s: a clean stop on the marks. The status stays None
   * throughout — no InProgress at all — and `PitstopActive` pulses for four
   * frames. Every frame from 414.833 s on.
   */
  const CLEAN_2026_10_03: readonly Frame[] = [
    [414.05, PitSvStatus.None, APPROACH, false, false, true, 3.373],
    [414.067, PitSvStatus.None, STALL, false, false, true, 3.346],
    [414.833, PitSvStatus.None, STALL, false, false, true, 0.367],
    [414.85, PitSvStatus.None, STALL, false, false, true, 0.238],
    [414.867, PitSvStatus.None, STALL, false, false, true, 0.107],
    [414.883, PitSvStatus.None, STALL, false, false, true, 0.024],
    [414.9, PitSvStatus.None, STALL, false, true, true, 0.098],
    [414.917, PitSvStatus.None, STALL, false, true, true, 0.066],
    [414.933, PitSvStatus.None, STALL, false, true, true, 0.01],
    [414.95, PitSvStatus.None, STALL, false, true, true, 0.051],
    [414.967, PitSvStatus.None, STALL, false, false, true, 0.033],
    [414.983, PitSvStatus.None, STALL, false, false, true, 0.007],
    [415.0, PitSvStatus.None, STALL, false, false, true, 0.028],
    [415.017, PitSvStatus.None, STALL, false, false, true, 0.018],
    [415.033, PitSvStatus.None, STALL, false, false, true, 0.005],
    [415.05, PitSvStatus.None, STALL, false, false, true, 0.017],
    [415.067, PitSvStatus.None, STALL, false, false, true, 0.011],
    [415.083, PitSvStatus.None, STALL, false, false, true, 0.001],
    [415.1, PitSvStatus.None, STALL, false, false, true, 0.008],
    [415.117, PitSvStatus.None, STALL, true, false, true, 0.006],
  ];

  /**
   * 2026-09-19, 597 s: the first captured empty stop — one tick of
   * InProgress, then a two-frame `PitstopActive` pulse that rises on the very
   * tick the status drops back to None. Changes-only capture, every record.
   */
  const EMPTY_2026_09_19: readonly Frame[] = [
    [572.7, PitSvStatus.None, APPROACH, false, false, true],
    [597.55, PitSvStatus.None, STALL, false, false, true],
    [597.75, PitSvStatus.InProgress, STALL, false, false, true],
    [597.767, PitSvStatus.None, STALL, false, true, true],
    [597.8, PitSvStatus.None, STALL, false, false, true],
    [598.0, PitSvStatus.None, STALL, true, false, true],
    [607.0, PitSvStatus.None, STALL, false, false, true],
    [607.75, PitSvStatus.None, APPROACH, false, false, true],
    [613.7, PitSvStatus.None, APPROACH, false, false, false],
  ];

  /**
   * 2026-09-19, 447 s: a real stop, four tyres and fuel. `PitstopActive` is up
   * from 447.267 s to 467.433 s — the whole service — and falls one frame
   * after Complete. Changes-only capture, every record (PitSvFlags-only
   * changes mid-service collapse to the same frame values here).
   */
  const REAL_2026_09_19: readonly Frame[] = [
    [436.6, PitSvStatus.None, APPROACH, false, false, true],
    [444.967, BACK, APPROACH, false, false, true],
    [446.767, BACK, STALL, false, false, true],
    [447.25, PitSvStatus.None, STALL, false, false, true],
    [447.267, PitSvStatus.None, STALL, false, true, true],
    [447.467, PitSvStatus.None, STALL, true, true, true],
    [448.267, PitSvStatus.InProgress, STALL, true, true, true],
    [448.35, PitSvStatus.InProgress, STALL, true, true, true],
    [449.883, PitSvStatus.InProgress, STALL, true, true, true],
    [457.467, PitSvStatus.InProgress, STALL, true, true, true],
    [458.967, PitSvStatus.InProgress, STALL, true, true, true],
    [467.417, PitSvStatus.Complete, STALL, true, true, true],
    [467.433, PitSvStatus.Complete, STALL, true, false, true],
    [469.133, PitSvStatus.Complete, STALL, false, false, true],
    [469.683, PitSvStatus.Complete, APPROACH, false, false, true],
    [475.55, PitSvStatus.None, APPROACH, false, false, false],
  ];

  describe("captured stops", () => {
    it("releases the 2026-10-03 overshoot once, on the pulse's fall — the status never reports InProgress", () => {
      const { events, releasedAt } = replay(OVERSHOOT_2026_10_03);

      expect(releasedAt).toEqual([348_683]);
      expect(stopEmptyEvents(events)).toEqual([{ event: "pitService.stopEmpty", data: {} }]);
      expect(statusEvents(events).map((e) => e.data)).toEqual([{ from: PitSvStatus.None, to: BACK }]);
    });

    it("releases the 2026-10-03 clean stop once, on the pulse's fall — the status stays None throughout", () => {
      const { events, releasedAt } = replay(CLEAN_2026_10_03);

      expect(releasedAt).toEqual([414_967]);
      expect(events).toEqual([{ event: "pitService.stopEmpty", data: {} }]);
    });

    it("releases the 2026-09-19 empty stop once, and still mirrors its one-tick InProgress", () => {
      const { events, releasedAt } = replay(EMPTY_2026_09_19);

      expect(releasedAt).toEqual([597_800]);
      expect(events.map((e) => e.event)).toEqual(["pitService.statusChanged", "pitService.stopEmpty"]);
      expect(statusEvents(events).map((e) => e.data)).toEqual([
        { from: PitSvStatus.None, to: PitSvStatus.InProgress },
      ]);
    });

    it("does not release the 2026-09-19 real stop — its 20 s pulse is a service — and mirrors InProgress and Complete", () => {
      const { events } = replay(REAL_2026_09_19);

      expect(stopEmptyEvents(events)).toHaveLength(0);
      expect(statusEvents(events).map((e) => e.data)).toEqual([
        { from: PitSvStatus.None, to: BACK },
        { from: PitSvStatus.None, to: PitSvStatus.InProgress },
        { from: PitSvStatus.InProgress, to: PitSvStatus.Complete },
      ]);
    });
  });

  describe("the pulse", () => {
    const stall = { PlayerTrackSurface: TrkLoc.InPitStall, Speed: 0 };

    /**
     * Idle in the stall, `PitstopActive` up at T0 + 100 and down `heldMs`
     * later; `falling` overrides the telemetry of the falling tick.
     */
    function pulse(heldMs: number, falling: Partial<TelemetryData> = {}): PendingEvent[] {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitStatus(state, tick(stall), T0, emit);
      diffPitStatus(state, tick({ ...stall, PitstopActive: true }), T0 + 100, emit);
      diffPitStatus(state, tick({ ...stall, PitstopActive: false, ...falling }), T0 + 100 + heldMs, emit);

      return events;
    }

    it("releases a pulse just under the bound", () => {
      expect(stopEmptyEvents(pulse(PIT_STATUS_EMPTY_STOP_MAX_MS - 1))).toHaveLength(1);
    });

    it("does not release a pulse that lasted exactly the bound", () => {
      expect(stopEmptyEvents(pulse(PIT_STATUS_EMPTY_STOP_MAX_MS))).toHaveLength(0);
    });

    it("does not release a pulse whose fall is off the InPitStall surface", () => {
      expect(stopEmptyEvents(pulse(67, { PlayerTrackSurface: TrkLoc.AproachingPits }))).toHaveLength(0);
    });

    it("has no speed gate: a car still rolling at the fall is released", () => {
      expect(stopEmptyEvents(pulse(67, { Speed: 1.5 }))).toHaveLength(1);
    });

    it("treats a missing PlayerTrackSurface as qualifying rather than suppressing (#574)", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitStatus(state, tick(), T0, emit);
      diffPitStatus(state, tick({ PitstopActive: true }), T0 + 100, emit);
      diffPitStatus(state, tick({ PitstopActive: false }), T0 + 167, emit);

      expect(stopEmptyEvents(events)).toEqual([{ event: "pitService.stopEmpty", data: {} }]);
    });

    it("never releases without PitstopActive — a one-tick InProgress alone is not the signal", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitStatus(state, tick(stall), T0, emit);
      diffPitStatus(state, tick({ ...stall, PlayerCarPitSvStatus: PitSvStatus.InProgress }), T0 + 100, emit);
      diffPitStatus(state, tick({ ...stall, PlayerCarPitSvStatus: PitSvStatus.None }), T0 + 117, emit);
      diffPitStatus(state, tick(stall), T0 + 1000, emit);

      expect(stopEmptyEvents(events)).toHaveLength(0);
      expect(state.lastPitstopActive).toBe(false);
      expect(state.pitstopActiveSince).toBe(0);
    });

    it("does not release a pulse that was already up at the seed — its start is unknown", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitStatus(state, tick({ ...stall, PitstopActive: true }), T0, emit);
      expect(state.lastPitstopActive).toBe(true);
      expect(state.pitstopActiveSince).toBe(0);

      diffPitStatus(state, tick({ ...stall, PitstopActive: false }), T0 + 20, emit);

      expect(events).toEqual([]);
    });

    it("does not release after a re-seed mid-pulse, even a moment later — the start is cleared", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitStatus(state, tick(stall), T0, emit);
      diffPitStatus(state, tick({ ...stall, PitstopActive: true }), T0 + 100, emit);
      expect(state.pitstopActiveSince).toBe(T0 + 100);

      // A one-tick off-track blip re-seeds the diff while the pulse is up.
      diffPitStatus(state, tick({ ...stall, IsOnTrack: false, PitstopActive: true }), T0 + 117, emit);
      expect(state.pitstopActiveSince).toBe(0);

      diffPitStatus(state, tick({ ...stall, PitstopActive: false }), T0 + 133, emit);

      expect(stopEmptyEvents(events)).toHaveLength(0);
    });

    it("tracks the pulse on ticks where the status changes too", () => {
      // Rises on the tick InProgress appears, falls on the tick it closes:
      // both take the diff's status-change branch, which returns early.
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitStatus(state, tick(stall), T0, emit);
      diffPitStatus(
        state,
        tick({ ...stall, PlayerCarPitSvStatus: PitSvStatus.InProgress, PitstopActive: true }),
        T0 + 100,
        emit,
      );
      diffPitStatus(
        state,
        tick({ ...stall, PlayerCarPitSvStatus: PitSvStatus.None, PitstopActive: false }),
        T0 + 150,
        emit,
      );

      expect(events.map((e) => e.event)).toEqual(["pitService.statusChanged", "pitService.stopEmpty"]);
    });

    it("releases each empty stop once, and again on the next one", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitStatus(state, tick(stall), T0, emit);

      for (const at of [T0 + 1000, T0 + 60_000]) {
        diffPitStatus(state, tick({ ...stall, PitstopActive: true }), at, emit);
        diffPitStatus(state, tick({ ...stall, PitstopActive: true }), at + 33, emit);
        diffPitStatus(state, tick({ ...stall, PitstopActive: false }), at + 67, emit);
        diffPitStatus(state, tick({ ...stall, PitstopActive: false }), at + 1000, emit);
      }

      expect(stopEmptyEvents(events)).toHaveLength(2);
      expect(state.pitstopActiveSince).toBe(0);
    });
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
  return tick({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerCarPitSvStatus: status, Speed: speedMps });
}

/** Drive `count` stationary ticks from `from`, 100 ms apart, and return the end time. */
function idleFor(
  state: ReturnType<typeof createInitialState>,
  status: PitSvStatus,
  from: number,
  durationMs: number,
  emit: (e: PendingEvent) => void,
): number {
  for (let at = from; at <= from + durationMs; at += 100) {
    diffPitStatus(state, parked(status), at, emit);
  }

  return from + durationMs;
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

describe("diffPitStatus — positioning repeat survives a re-seed (#951)", () => {
  // The cycle used to be armed ONLY on a status transition, while the
  // seed / off-track branch disarmed it — so anything that re-seeded the diff
  // mid-stop (plugin restart on a deck-host auto-update per #870, an SDK
  // reconnect, a one-tick `IsOnTrack: false` blip, or the replay-flip
  // `wipeStateForReplay`, which does NOT preserve `pitStatusInitialized`) left
  // a latched error with no edge to re-arm on: permanent silence, the exact
  // failure this issue exists to remove.
  it("re-arms after an off-track blip with the error still latched", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    diffPitStatus(
      state,
      tick({ IsOnTrack: false, OnPitRoad: true, PlayerCarPitSvStatus: PitSvStatus.TooFarForward }),
      T0 + 100,
      emit,
    );
    expect(state.pitStatusRepeatDueAt).toBe(0);

    idleFor(
      state,
      PitSvStatus.TooFarForward,
      T0 + 200,
      PIT_STATUS_REPEAT_INTERVAL_MS + PIT_STATUS_REST_SETTLE_MS,
      emit,
    );

    expect(repeatEvents(events).length).toBeGreaterThan(0);
  });

  it("re-arms after a full state re-seed (plugin restart mid-stop)", () => {
    const { events, emit } = collect();
    const state = createInitialState();

    // A fresh translator state that first sees the car ALREADY parked wrong:
    // the seed swallows the status, so no transition ever occurs.
    diffPitStatus(state, parked(PitSvStatus.BadAngle), T0, emit);
    expect(statusEvents(events)).toHaveLength(0);

    idleFor(state, PitSvStatus.BadAngle, T0 + 100, PIT_STATUS_REPEAT_INTERVAL_MS + PIT_STATUS_REST_SETTLE_MS, emit);

    const fired = repeatEvents(events);

    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0].data).toEqual({ status: PitSvStatus.BadAngle });
  });

  it("still waits a full interval before the first re-armed repeat", () => {
    const { events, emit } = collect();
    const state = createInitialState();

    diffPitStatus(state, parked(PitSvStatus.TooFarLeft), T0, emit);
    idleFor(state, PitSvStatus.TooFarLeft, T0 + 100, PIT_STATUS_REPEAT_INTERVAL_MS - 200, emit);

    expect(repeatEvents(events)).toHaveLength(0);
  });
});

describe("diffPitStatus — positioning repeat pit-road gate (#951)", () => {
  // A latched status on a car that has left pit road must not nag forever
  // wherever the car happens to stop (spin, red flag, off-track recovery).
  // The gate is `OnPitRoad`, NOT `PlayerCarInPitStall` — an overshot car may
  // well read false for the stall, which is the very repro case.
  it("does not repeat once the car has left pit road", () => {
    const { events, emit } = collect();
    const state = enterError(PitSvStatus.TooFarForward, emit);

    for (let elapsed = 100; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS * 3; elapsed += 100) {
      diffPitStatus(
        state,
        tick({ OnPitRoad: false, PlayerCarPitSvStatus: PitSvStatus.TooFarForward, Speed: 0 }),
        T0 + elapsed,
        emit,
      );
    }

    expect(repeatEvents(events)).toHaveLength(0);
  });

  it("still repeats for an overshooting car that is on pit road but not in the stall", () => {
    const { events, emit } = collect();
    const state = createInitialState();
    const overshot = (): TelemetryData =>
      tick({ OnPitRoad: true, PlayerCarInPitStall: false, PlayerCarPitSvStatus: PitSvStatus.TooFarForward, Speed: 0 });

    diffPitStatus(state, tick({ OnPitRoad: true }), T0 - 100, emit);
    diffPitStatus(state, overshot(), T0, emit);

    for (let elapsed = 100; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS + PIT_STATUS_REST_SETTLE_MS; elapsed += 100) {
      diffPitStatus(state, overshot(), T0 + elapsed, emit);
    }

    expect(repeatEvents(events).length).toBeGreaterThan(0);
  });

  it("treats missing OnPitRoad telemetry as on pit road rather than suppressing", () => {
    const { events, emit } = collect();
    const state = createInitialState();

    diffPitStatus(state, tick(), T0 - 100, emit);
    diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.TooFarBack }), T0, emit);

    for (let elapsed = 100; elapsed <= PIT_STATUS_REPEAT_INTERVAL_MS + PIT_STATUS_REST_SETTLE_MS; elapsed += 100) {
      diffPitStatus(state, tick({ PlayerCarPitSvStatus: PitSvStatus.TooFarBack }), T0 + elapsed, emit);
    }

    expect(repeatEvents(events).length).toBeGreaterThan(0);
  });
});

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
