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
import { diffPitSpeeding, PIT_SPEEDING_END_HOLD_MS } from "./pit-speeding.js";
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
    it("ends the episode rather than sustaining it on unknown telemetry", () => {
      const state = createInitialState();
      const { events, emit } = collect();

      diffPitSpeeding(state, tick({ Speed: LIMIT + 5 }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: undefined }), LIMIT, false, T0, emit);
      diffPitSpeeding(state, tick({ Speed: undefined }), LIMIT, false, T0 + PIT_SPEEDING_END_HOLD_MS, emit);

      // A missing Speed reads as 0, so this exit goes through the held speed
      // path rather than the eligibility gate. Deliberately inverts the usual
      // "unknown telemetry keeps the callout alive" rule: the claim is that
      // the driver IS speeding, and that cannot be asserted without a speed.
      expect(names(events)).toEqual(["pitSpeeding.started", "pitSpeeding.ended"]);
      expect(state.pitSpeedingActive).toBe(false);
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
