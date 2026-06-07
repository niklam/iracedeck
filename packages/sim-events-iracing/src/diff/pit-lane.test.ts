/**
 * Unit tests for the pit-lane diff translator, focused on the
 * `pitLane.approaching` re-entry cooldown (issue #650).
 *
 * The cooldown gates BOTH emission paths so an accidental drive-out /
 * drive-back-in within the window doesn't re-announce "approaching pits":
 *   - Dirt oval — fires on the `OnPitRoad` false→true drive-in edge (#634).
 *   - Road course / unknown — fires on approach-zone entry.
 *
 * Calling the diff directly with an explicit `now` is what lets these tests
 * advance simulated time across the 10 s window — `translator.test.ts` can't,
 * since `handleTick` reads the real `Date.now()`.
 *
 * Pins:
 *   - first-tick seeding doesn't fire and leaves the cooldown inactive
 *   - each path fires once and arms the cooldown to `now + COOLDOWN`
 *   - a re-entry within the window is suppressed (both paths)
 *   - a re-entry after the window fires again (both paths)
 *   - dirt-oval teleport-to-stall stays silent (cooldown never arms)
 */
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { TrackType } from "../track-type.js";
import { diffPitLane, PIT_APPROACH_COOLDOWN_MS } from "./pit-lane.js";
import type { PendingEvent } from "./types.js";

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function approachEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "pitLane.approaching");
}

const onTrack = tick({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack });
const approaching = tick({ OnPitRoad: false, PlayerTrackSurface: TrkLoc.AproachingPits });
const droveIn = tick({ OnPitRoad: true, PlayerCarInPitStall: false, PlayerTrackSurface: TrkLoc.AproachingPits });

describe("diffPitLane — seeding", () => {
  it("does not emit on the first tick and leaves the cooldown inactive", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitLane(state, onTrack, TrackType.Unknown, 1000, emit);

    expect(approachEvents(events)).toHaveLength(0);
    expect(state.pitLaneInitialized).toBe(true);
    expect(state.pitApproachCooldownUntil).toBe(0);
  });
});

describe("diffPitLane — approach cooldown (road course)", () => {
  it("fires once on approach-zone entry and arms the cooldown", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitLane(state, onTrack, TrackType.Unknown, 1000, emit); // seed
    diffPitLane(state, approaching, TrackType.Unknown, 1000, emit);

    expect(approachEvents(events)).toHaveLength(1);
    expect(state.pitApproachCooldownUntil).toBe(1000 + PIT_APPROACH_COOLDOWN_MS);
  });

  it("suppresses a re-approach within the cooldown window", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitLane(state, onTrack, TrackType.Unknown, 1000, emit); // seed
    diffPitLane(state, approaching, TrackType.Unknown, 1000, emit); // fires
    diffPitLane(state, onTrack, TrackType.Unknown, 1100, emit); // rearm (back on track)
    diffPitLane(state, approaching, TrackType.Unknown, 1200, emit); // within window — suppressed

    expect(approachEvents(events)).toHaveLength(1);
  });

  it("fires again once the cooldown window has elapsed", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitLane(state, onTrack, TrackType.Unknown, 1000, emit); // seed
    diffPitLane(state, approaching, TrackType.Unknown, 1000, emit); // fires (until 11000)
    diffPitLane(state, onTrack, TrackType.Unknown, 1100, emit); // rearm
    diffPitLane(state, approaching, TrackType.Unknown, 1200, emit); // suppressed
    diffPitLane(state, onTrack, TrackType.Unknown, 1300, emit); // rearm
    diffPitLane(state, approaching, TrackType.Unknown, 1000 + PIT_APPROACH_COOLDOWN_MS, emit); // at deadline — fires

    expect(approachEvents(events)).toHaveLength(2);
    expect(state.pitApproachCooldownUntil).toBe(1000 + PIT_APPROACH_COOLDOWN_MS + PIT_APPROACH_COOLDOWN_MS);
  });
});

describe("diffPitLane — approach cooldown (dirt oval)", () => {
  it("fires once on the drive-in edge and arms the cooldown", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitLane(state, onTrack, TrackType.DirtOval, 1000, emit); // seed
    diffPitLane(state, droveIn, TrackType.DirtOval, 1000, emit);

    expect(approachEvents(events)).toHaveLength(1);
    expect(state.pitApproachCooldownUntil).toBe(1000 + PIT_APPROACH_COOLDOWN_MS);
  });

  it("suppresses a drive-out / drive-back-in within the cooldown window", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitLane(state, onTrack, TrackType.DirtOval, 1000, emit); // seed
    diffPitLane(state, droveIn, TrackType.DirtOval, 1000, emit); // fires
    diffPitLane(state, onTrack, TrackType.DirtOval, 1100, emit); // drove back out
    diffPitLane(state, droveIn, TrackType.DirtOval, 1200, emit); // within window — suppressed

    expect(approachEvents(events)).toHaveLength(1);
  });

  it("fires again once the cooldown window has elapsed", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitLane(state, onTrack, TrackType.DirtOval, 1000, emit); // seed
    diffPitLane(state, droveIn, TrackType.DirtOval, 1000, emit); // fires (until 11000)
    diffPitLane(state, onTrack, TrackType.DirtOval, 1100, emit); // out
    diffPitLane(state, droveIn, TrackType.DirtOval, 1200, emit); // suppressed
    diffPitLane(state, onTrack, TrackType.DirtOval, 1300, emit); // out
    diffPitLane(state, droveIn, TrackType.DirtOval, 1000 + PIT_APPROACH_COOLDOWN_MS, emit); // at deadline — fires

    expect(approachEvents(events)).toHaveLength(2);
    expect(state.pitApproachCooldownUntil).toBe(1000 + PIT_APPROACH_COOLDOWN_MS + PIT_APPROACH_COOLDOWN_MS);
  });

  it("stays silent (and never arms the cooldown) on a teleport straight into the stall", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffPitLane(state, onTrack, TrackType.DirtOval, 1000, emit); // seed
    diffPitLane(
      state,
      tick({ OnPitRoad: true, PlayerCarInPitStall: true, PlayerTrackSurface: TrkLoc.InPitStall }),
      TrackType.DirtOval,
      1000,
      emit,
    );

    expect(approachEvents(events)).toHaveLength(0);
    expect(state.pitApproachCooldownUntil).toBe(0);
  });
});
