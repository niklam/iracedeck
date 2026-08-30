/**
 * Unit tests for the pit-road speeding diff (issues #912, #1059).
 *
 * The three properties worth pinning hardest, because each is a decision a
 * later reader could plausibly "fix" into a bug:
 *
 *   - **Level-driven, not edge-driven.** There is no seed branch: the very
 *     first tick observing the condition emits `started`, so a driver already
 *     over the limit when the plugin restarts or the SDK reconnects hears the
 *     cue. Adding a `pitSpeedingInitialized` flag would reintroduce #951's
 *     go-silent-forever bug, and the first test here is what would catch it.
 *   - **The episode always ends.** Every exit path emits `ended` exactly once.
 *     A missed `ended` leaves the audio engine looping a tick over a live race
 *     with no way to stop it, which is the failure this feature must not have.
 *   - **Exact in speed, damped in time (#1059).** The comparisons are exact —
 *     over the limit sounds, at or under it does not — and flutter is damped
 *     by a hold on the speed exit, never by a speed dead band. The band this
 *     replaced sat immediately below the limit, so a driver who backed off to
 *     just under it could not silence the cue.
 *
 * The limit used here is deliberately NOT round: 72.42 kph is the converted
 * 45.00 mph that Charlotte publishes, and is the exact case from the #1059
 * report. A tidy 80.00 would hide a rounding assumption near the comparison.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffPitSpeeding, PIT_SPEEDING_END_HOLD_MS, PIT_SPEEDING_LIMITER_BUFFER_MPS } from "./pit-speeding.js";
import type { PendingEvent } from "./types.js";

/** 72.42 kph — the shape `resolvePitSpeedLimit` produces from session YAML. */
const LIMIT = 72.42 / 3.6;

/** 71.93 kph: 0.49 kph under the limit, and inside the old 0.72 kph dead band. */
const IN_OLD_DEAD_BAND = 71.93 / 3.6;

/** Non-zero so the `0` not-tracking sentinel is never ambiguous in a test. */
const T0 = 1_000;

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    OnPitRoad: true,
    PlayerCarInPitStall: false,
    Speed: 0,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e: PendingEvent) => events.push(e) };
}

function names(events: PendingEvent[]): string[] {
  return events.map((e) => e.event);
}

describe("diffPitSpeeding", () => {
  describe("level-driven start (issue #951's rule)", () => {
    it("emits started on the very first tick observed while already speeding", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started"]);
      expect(state.pitSpeedingActive).toBe(true);
    });

    it("stays silent on a first tick under the limit", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT - 5 }), LIMIT, false, T0, emit);

      expect(events).toEqual([]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("does not fire at exactly the limit — the start edge is strictly above it", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT }), LIMIT, false, T0, emit);

      expect(events).toEqual([]);
    });

    it("emits started only once while the condition keeps holding", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      for (let i = 0; i < 5; i++) {
        diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0 + i * 16, emit);
      }

      expect(names(events)).toEqual(["pitSpeeding.started"]);
    });
  });

  describe("end edge — speed is exact, the hold is in time (#1059)", () => {
    it("ends once the speed has been at or under the limit for the hold", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: LIMIT - 1 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: LIMIT - 1 }), LIMIT, false, T0 + PIT_SPEEDING_END_HOLD_MS, emit);

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("ends at EXACTLY the limit once the hold elapses", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: LIMIT }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: LIMIT }), LIMIT, false, T0 + PIT_SPEEDING_END_HOLD_MS, emit);

      // The contract: silent AT the limit, not merely below it.
      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
    });

    it("ends inside the old hysteresis dead band — the #1059 regression", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      // 71.93 kph against a 72.42 kph limit: under the limit, but by less than
      // the old 0.2 m/s band below it. This is the reported case — the cue was
      // unstoppable here, because the episode could neither end nor restart.
      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: IN_OLD_DEAD_BAND }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: IN_OLD_DEAD_BAND }), LIMIT, false, T0 + PIT_SPEEDING_END_HOLD_MS, emit);

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("does not end before the hold has elapsed", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: 0 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: 0 }), LIMIT, false, T0 + PIT_SPEEDING_END_HOLD_MS - 1, emit);

      expect(names(events)).toEqual(["pitSpeeding.started"]);
      expect(state.pitSpeedingActive).toBe(true);
    });

    it("restarts the hold when the speed goes back over the limit", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      // Under the limit, then back over before the hold elapses — that dip is
      // exactly the flutter this damps, and it must not end the episode.
      diffPitSpeeding(state, tick({ Speed: LIMIT - 1 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: LIMIT + 1 }), LIMIT, false, T0 + 50, emit);
      expect(state.pitSpeedingUnderLimitSince).toBe(0);

      // The clock is now past the original hold, but the hold restarted.
      diffPitSpeeding(state, tick({ Speed: LIMIT - 1 }), LIMIT, false, T0 + PIT_SPEEDING_END_HOLD_MS, emit);

      expect(names(events)).toEqual(["pitSpeeding.started"]);
      expect(state.pitSpeedingActive).toBe(true);
    });

    it("can start a second episode after ending the first", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: 0 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: 0 }), LIMIT, false, T0 + PIT_SPEEDING_END_HOLD_MS, emit);
      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0 + 1_000, emit);

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended", "pitSpeeding.started"]);
    });

    it("clears the hold timestamp when the episode ends, so the next one gets a full hold", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: 0 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: 0 }), LIMIT, false, T0 + PIT_SPEEDING_END_HOLD_MS, emit);

      expect(state.pitSpeedingUnderLimitSince).toBe(0);
      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
    });
  });

  describe("end edge — every other exit is immediate, with no hold", () => {
    it.each([
      ["left pit road", { OnPitRoad: false }],
      ["entered the pit stall", { PlayerCarInPitStall: true }],
      ["left the car", { IsOnTrack: false }],
    ])("ends the episode when the driver %s", (_label, exit) => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      // Same `now`, so no time can have passed: these exits must not be held.
      diffPitSpeeding(state, tick({ Speed: LIMIT + 5, ...exit }), LIMIT, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("ends the episode when the pit speed limit becomes unknown", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      // `resolvePitSpeedLimit` returns 0 on a track/session change before it
      // re-parses the new YAML.
      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), 0, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("emits ended only once when several exit conditions land together", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: 0, OnPitRoad: false, IsOnTrack: false }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: 0, OnPitRoad: false, IsOnTrack: false }), LIMIT, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
    });

    it("stays silent when no episode is running", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ OnPitRoad: false, Speed: 60 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ IsOnTrack: false }), LIMIT, false, T0, emit);

      expect(events).toEqual([]);
    });
  });

  describe("missing Speed", () => {
    it("ends the episode IMMEDIATELY on unknown telemetry, without waiting out the hold", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      // Same `now`, so no time can have passed. An unknown speed is a term of
      // eligibility, not a 0 fed through the held exit — otherwise the hold
      // would buy 300 ms of asserting an offence on evidence we do not have.
      diffPitSpeeding(state, tick({ Speed: undefined }), LIMIT, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("ends the episode on a NaN speed rather than sustaining it forever", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      // NaN is not null, so a null check would pass it through as "known" —
      // and then NaN satisfies neither comparison, so the active branch would
      // reset the hold every tick and the episode could never end by speed.
      diffPitSpeeding(state, tick({ Speed: Number.NaN }), LIMIT, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("never starts a cue on a NaN speed", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: Number.NaN }), LIMIT, false, T0, emit);

      expect(events).toEqual([]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("never starts a cue on unknown telemetry", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: undefined }), LIMIT, false, T0, emit);

      expect(events).toEqual([]);
      expect(state.pitSpeedingActive).toBe(false);
    });
  });

  describe("pit limiter engaged — the equipment-conditional buffer (#1059)", () => {
    const LIMITER_ON = { EngineWarnings: 0x0010 } as Partial<TelemetryData>;
    const REV_LIMITER_ONLY = { EngineWarnings: 0x0020 } as Partial<TelemetryData>;

    it("stays silent AT the limit with the limiter engaged — the acceptance criterion", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      for (let i = 0; i < 20; i++) {
        diffPitSpeeding(state, tick({ Speed: LIMIT, ...LIMITER_ON }), LIMIT, false, T0 + i * 16, emit);
      }

      // "The blimping can't happen while driver is within speed limit with a
      // limiter car." Sustained, because a blink or a single tick is a failure.
      expect(events).toEqual([]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("stays silent inside the buffer with the limiter engaged", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      const inBuffer = LIMIT + PIT_SPEEDING_LIMITER_BUFFER_MPS / 2;

      for (let i = 0; i < 20; i++) {
        diffPitSpeeding(state, tick({ Speed: inBuffer, ...LIMITER_ON }), LIMIT, false, T0 + i * 16, emit);
      }

      expect(events).toEqual([]);
    });

    it("still sounds when a limiter car is genuinely past the buffer", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      // The reason this is a buffer and not a gate: a limiter that is engaged
      // but not holding must still be reported.
      diffPitSpeeding(state, tick({ Speed: LIMIT + 5, ...LIMITER_ON }), LIMIT, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started"]);
    });

    it("applies the buffer to BOTH edges, so no dead band opens above the limit", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      // Start well over, then settle just INSIDE the buffer. If the buffer
      // applied only to the start edge, this episode could never end until the
      // car fell to the bare limit — this issue's original defect, relocated.
      diffPitSpeeding(state, tick({ Speed: LIMIT + 5, ...LIMITER_ON }), LIMIT, false, T0, emit);
      const inBuffer = LIMIT + PIT_SPEEDING_LIMITER_BUFFER_MPS / 2;
      diffPitSpeeding(state, tick({ Speed: inBuffer, ...LIMITER_ON }), LIMIT, false, T0, emit);
      diffPitSpeeding(
        state,
        tick({ Speed: inBuffer, ...LIMITER_ON }),
        LIMIT,
        false,
        T0 + PIT_SPEEDING_END_HOLD_MS,
        emit,
      );

      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("keeps the exact comparison when the limiter is NOT engaged", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      // The same speed that is silent under a limiter must sound without one.
      const inBuffer = LIMIT + PIT_SPEEDING_LIMITER_BUFFER_MPS / 2;
      diffPitSpeeding(state, tick({ Speed: inBuffer }), LIMIT, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started"]);
    });

    it("does not treat another EngineWarnings bit as the pit limiter", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      // `hasPitLimiter` (the car HAS one) is a different question from the
      // limiter being engaged, and so is any neighbouring warning bit.
      const inBuffer = LIMIT + PIT_SPEEDING_LIMITER_BUFFER_MPS / 2;
      diffPitSpeeding(state, tick({ Speed: inBuffer, ...REV_LIMITER_ONLY }), LIMIT, false, T0, emit);

      expect(names(events)).toEqual(["pitSpeeding.started"]);
    });

    it("drops back to the exact threshold when the limiter disengages mid-episode", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      const inBuffer = LIMIT + PIT_SPEEDING_LIMITER_BUFFER_MPS / 2;

      // Silent under the limiter at this speed...
      diffPitSpeeding(state, tick({ Speed: inBuffer, ...LIMITER_ON }), LIMIT, false, T0, emit);
      expect(events).toEqual([]);

      // ...and the moment the limiter drops, the driver has a remedy again.
      diffPitSpeeding(state, tick({ Speed: inBuffer }), LIMIT, false, T0 + 16, emit);

      expect(names(events)).toEqual(["pitSpeeding.started"]);
    });
  });

  describe("replay-only sessions", () => {
    it("never starts a cue while watching a standalone replay", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      // A paused or frame-scrubbed replay reads `IsReplayPlaying === false`
      // while `SimMode === "replay"`, so these ticks reach the diff past the
      // translator's main replay guard. Parking on a frame where the car is
      // over the limit must not beep over the replay UI.
      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, true, T0, emit);

      expect(events).toEqual([]);
      expect(state.pitSpeedingActive).toBe(false);
    });

    it("ends an episode in flight rather than stranding it when the session turns out replay-only", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, true, T0, emit);

      // The gate is a term of eligibility, not an early return, precisely so
      // the closing edge still fires — skipping the call would leave
      // `pitSpeedingActive` true with nothing left to clear it.
      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
    });
  });

  describe("unknown pit speed limit", () => {
    it("never starts a cue when the limit could not be parsed", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      // A track whose `WeekendInfo.TrackPitSpeedLimit` we cannot read would
      // otherwise beep continuously, since any speed exceeds 0.
      diffPitSpeeding(state, tick({ Speed: 200 }), 0, false, T0, emit);

      expect(events).toEqual([]);
      expect(state.pitSpeedingActive).toBe(false);
    });
  });
});
