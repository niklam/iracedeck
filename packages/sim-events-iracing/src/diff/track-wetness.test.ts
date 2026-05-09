/**
 * Unit tests for the track-wetness diff translator (issue #526).
 *
 * Pins:
 *   - first-tick seeding (no fire on connect)
 *   - one event per real transition between known states
 *   - Unknown ↔ x transitions are suppressed (still advance baseline)
 *   - multi-step jumps fire a single event with the full from/to pair
 *   - re-emission after Unknown round-trips
 */
import { TrackWetness } from "@iracedeck/event-bus";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffTrackWetness } from "./track-wetness.js";
import type { PendingEvent } from "./types.js";

function tick(wetness: number | undefined): TelemetryData {
  return { TrackWetness: wetness } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function wetnessEvents(events: PendingEvent[]): PendingEvent[] {
  return events.filter((e) => e.event === "track.wetness.changed");
}

describe("diffTrackWetness — seeding", () => {
  it("does not emit on first tick at Dry", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.Dry), emit);

    expect(wetnessEvents(events)).toHaveLength(0);
    expect(state.trackWetnessInitialized).toBe(true);
    expect(state.lastTrackWetness).toBe(TrackWetness.Dry);
  });

  it("does not emit on first tick mid-state (connecting in the rain)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.VeryWet), emit);

    expect(wetnessEvents(events)).toHaveLength(0);
    expect(state.lastTrackWetness).toBe(TrackWetness.VeryWet);
  });

  it("treats missing TrackWetness as Unknown on first tick", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(undefined), emit);

    expect(wetnessEvents(events)).toHaveLength(0);
    expect(state.lastTrackWetness).toBe(TrackWetness.Unknown);
  });
});

describe("diffTrackWetness — transitions", () => {
  it("emits one event per single-step worsening transition", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.Dry), emit); // seed
    diffTrackWetness(state, tick(TrackWetness.MostlyDry), emit);

    const fired = wetnessEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({
      event: "track.wetness.changed",
      data: { from: TrackWetness.Dry, to: TrackWetness.MostlyDry },
    });
    expect(state.lastTrackWetness).toBe(TrackWetness.MostlyDry);
  });

  it("emits one event per single-step drying transition", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.VeryWet), emit); // seed
    diffTrackWetness(state, tick(TrackWetness.ModeratelyWet), emit);

    const fired = wetnessEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({
      event: "track.wetness.changed",
      data: { from: TrackWetness.VeryWet, to: TrackWetness.ModeratelyWet },
    });
  });

  it("emits a single event for a multi-step jump (Dry → ModeratelyWet)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.Dry), emit);
    diffTrackWetness(state, tick(TrackWetness.ModeratelyWet), emit);

    const fired = wetnessEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0]?.data).toEqual({ from: TrackWetness.Dry, to: TrackWetness.ModeratelyWet });
  });

  it("does not emit when state is unchanged across ticks", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.LightlyWet), emit);
    diffTrackWetness(state, tick(TrackWetness.LightlyWet), emit);
    diffTrackWetness(state, tick(TrackWetness.LightlyWet), emit);

    expect(wetnessEvents(events)).toHaveLength(0);
  });

  it("emits a single event per oscillation step (rapid back-and-forth)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.MostlyDry), emit); // seed
    diffTrackWetness(state, tick(TrackWetness.VeryLightlyWet), emit);
    diffTrackWetness(state, tick(TrackWetness.MostlyDry), emit);
    diffTrackWetness(state, tick(TrackWetness.VeryLightlyWet), emit);

    const fired = wetnessEvents(events);

    expect(fired).toHaveLength(3);
    expect(fired.map((e) => e.data)).toEqual([
      { from: TrackWetness.MostlyDry, to: TrackWetness.VeryLightlyWet },
      { from: TrackWetness.VeryLightlyWet, to: TrackWetness.MostlyDry },
      { from: TrackWetness.MostlyDry, to: TrackWetness.VeryLightlyWet },
    ]);
  });
});

describe("diffTrackWetness — Unknown handling", () => {
  it("does not emit on Unknown → known transition (silent reseed)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.Unknown), emit); // seed at Unknown
    diffTrackWetness(state, tick(TrackWetness.Dry), emit); // sim reports state

    expect(wetnessEvents(events)).toHaveLength(0);
    expect(state.lastTrackWetness).toBe(TrackWetness.Dry);
  });

  it("does not emit on known → Unknown transition (sim stops reporting)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.LightlyWet), emit); // seed
    diffTrackWetness(state, tick(TrackWetness.Unknown), emit);

    expect(wetnessEvents(events)).toHaveLength(0);
    expect(state.lastTrackWetness).toBe(TrackWetness.Unknown);
  });

  it("re-fires correctly after an Unknown round-trip", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(TrackWetness.Dry), emit); // seed
    diffTrackWetness(state, tick(TrackWetness.Unknown), emit); // suppressed
    diffTrackWetness(state, tick(TrackWetness.MostlyDry), emit); // suppressed (Unknown → known)
    diffTrackWetness(state, tick(TrackWetness.LightlyWet), emit); // fires

    const fired = wetnessEvents(events);

    expect(fired).toHaveLength(1);
    expect(fired[0]?.data).toEqual({ from: TrackWetness.MostlyDry, to: TrackWetness.LightlyWet });
  });
});

describe("diffTrackWetness — invalid input", () => {
  it("treats out-of-range values as Unknown", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(99), emit); // invalid → Unknown
    diffTrackWetness(state, tick(TrackWetness.Dry), emit); // Unknown → Dry, suppressed

    expect(wetnessEvents(events)).toHaveLength(0);
    expect(state.lastTrackWetness).toBe(TrackWetness.Dry);
  });

  it("treats non-integer values as Unknown (e.g. 2.5 between MostlyDry and VeryLightlyWet)", () => {
    const state = createInitialState();
    const { events, emit } = collect();

    diffTrackWetness(state, tick(2.5), emit); // non-integer → Unknown
    diffTrackWetness(state, tick(TrackWetness.LightlyWet), emit); // Unknown → known, suppressed

    expect(wetnessEvents(events)).toHaveLength(0);
    expect(state.lastTrackWetness).toBe(TrackWetness.LightlyWet);
  });
});
