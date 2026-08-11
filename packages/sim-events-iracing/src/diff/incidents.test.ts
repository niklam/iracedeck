import { IncidentFlags, type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import {
  classifyIncident,
  COLLISION_CAR_VALUE_DIRT,
  COLLISION_CAR_VALUE_PAVEMENT,
  diffIncidents,
  INCIDENT_BURST_QUIET_MS,
  INCIDENT_LATE_TYPE_MS,
  incidentTypeValue,
  resolveCollisionCarValue,
} from "./incidents.js";
import type { PendingEvent } from "./types.js";

describe("classifyIncident", () => {
  it.each([
    [IncidentFlags.RepOutOfControl, "out-of-control"],
    [IncidentFlags.RepOffTrack, "off-track"],
    [IncidentFlags.RepContactWithWorld, "contact-world"],
    [IncidentFlags.RepCollisionWithWorld, "collision-world"],
    [IncidentFlags.RepContactWithCar, "contact-car"],
    [IncidentFlags.RepCollisionWithCar, "collision-car"],
  ])("maps report byte %i to %s", (input, expected) => {
    expect(classifyIncident(input)).toBe(expected);
  });

  it("returns null for RepNoReport", () => {
    expect(classifyIncident(IncidentFlags.RepNoReport)).toBeNull();
  });

  it("returns null for the Ongoing variants iRacing never emits", () => {
    expect(classifyIncident(IncidentFlags.RepOffTrackOngoing)).toBeNull();
    expect(classifyIncident(IncidentFlags.RepCollisionWithWorldOngoing)).toBeNull();
  });

  it("ignores the penalty byte when classifying the report byte", () => {
    // Report byte 0x02 (RepOffTrack) + Pen byte 0x0200 (PenOneX) — the report
    // mask must isolate the low byte cleanly so the penalty bits don't
    // perturb classification.
    const combined = IncidentFlags.RepOffTrack | IncidentFlags.PenOneX;
    expect(classifyIncident(combined)).toBe("off-track");
  });

  it("returns null for unknown high values to stay forward-compatible", () => {
    // Hypothetical future iRacing report code the bus doesn't know about.
    expect(classifyIncident(0x00ff)).toBeNull();
  });
});

function tick(overrides: Partial<TelemetryData> = {}): TelemetryData {
  return {
    IsOnTrack: true,
    OnPitRoad: false,
    PlayerTrackSurface: TrkLoc.OnTrack,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    PlayerIncidents: 0,
    ...overrides,
  } as unknown as TelemetryData;
}

function collect(): { events: PendingEvent[]; emit: (e: PendingEvent) => void } {
  const events: PendingEvent[] = [];

  return { events, emit: (e) => events.push(e) };
}

function occurred(events: PendingEvent[]): Array<{ delta: number; points: number; type: string }> {
  return events.filter((e) => e.event === "incident.occurred").map((e) => e.data as never);
}

describe("incidentTypeValue / resolveCollisionCarValue", () => {
  it("maps the Sporting Code §3.5.1 values", () => {
    expect(incidentTypeValue("off-track", COLLISION_CAR_VALUE_PAVEMENT)).toBe(1);
    expect(incidentTypeValue("out-of-control", COLLISION_CAR_VALUE_PAVEMENT)).toBe(2);
    expect(incidentTypeValue("contact-world", COLLISION_CAR_VALUE_PAVEMENT)).toBe(0);
    expect(incidentTypeValue("collision-world", COLLISION_CAR_VALUE_PAVEMENT)).toBe(2);
    expect(incidentTypeValue("contact-car", COLLISION_CAR_VALUE_PAVEMENT)).toBe(0);
    expect(incidentTypeValue("collision-car", COLLISION_CAR_VALUE_PAVEMENT)).toBe(4);
    expect(incidentTypeValue("collision-car", COLLISION_CAR_VALUE_DIRT)).toBe(2);
  });

  it("resolves collision-car by discipline, defaulting to pavement", () => {
    expect(resolveCollisionCarValue({ WeekendInfo: { TrackType: "dirt oval" } })).toBe(2);
    expect(resolveCollisionCarValue({ WeekendInfo: { TrackType: "road course" } })).toBe(4);
    expect(resolveCollisionCarValue(null)).toBe(4);
  });
});

describe("diffIncidents — type-value announcements (issue #938)", () => {
  function seed(state: ReturnType<typeof createInitialState>, emit: (e: PendingEvent) => void): void {
    diffIncidents(state, tick(), 1_000, emit);
  }

  it("replays capture sequence B: a slow escalation announces the collision's full value", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    // Off-track: byte one frame, count lags ~2 frames.
    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack | IncidentFlags.PenOneX }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033 + INCIDENT_BURST_QUIET_MS, emit);
    expect(occurred(events)).toEqual([{ delta: 1, points: 1, type: "off-track" }]);

    // Collision with a car 4.1 s later — a new burst, but the spoken value is
    // the TYPE's value (4x), never the marginal +3 the count moved by.
    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepCollisionWithCar }),
      6_100,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 6_133, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 6_133 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([
      { delta: 1, points: 1, type: "off-track" },
      { delta: 3, points: 4, type: "collision-car" },
    ]);
  });

  it("replays capture sequence C: an untyped increment is kept and a late byte retypes the burst", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    // Second increment lands with NO byte; its report byte follows 2 frames later.
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 3_000, emit);
    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 2, PlayerIncidents: IncidentFlags.RepOutOfControl }),
      3_033,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 3_033 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([{ delta: 2, points: 2, type: "out-of-control" }]);
  });

  it("does not retype the burst from a byte beyond the late-type window", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    // An unrelated classified byte 500 ms later (no count movement) must not
    // repaint the pending off-track burst.
    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepContactWithCar }),
      2_033 + INCIDENT_LATE_TYPE_MS + 300,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 4_500, emit);

    expect(occurred(events)).toEqual([{ delta: 1, points: 1, type: "off-track" }]);
  });

  it("does not let a lesser late byte downgrade an already-typed burst", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    // Hard car collision types the burst at 4x...
    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepCollisionWithCar }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 2_033, emit);
    // ...then a light rub reports 100 ms later with no count movement — it
    // must not repaint the burst down to a 0-point contact.
    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 4, PlayerIncidents: IncidentFlags.RepContactWithCar }),
      2_133,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 2_133 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([{ delta: 4, points: 4, type: "collision-car" }]);
  });

  it("keeps the worst type when a lighter incident coalesces after a heavier one", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    // Wall collision (2x)...
    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepCollisionWithWorld }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 2_033, emit);
    // ...then a separate off-track 1 s later, inside the same quiet window.
    // The heavier wall hit must stay the announced type and value.
    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 2, PlayerIncidents: IncidentFlags.RepOffTrack }),
      3_000,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 3 }), 3_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 3 }), 3_033 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([{ delta: 3, points: 2, type: "collision-world" }]);
  });

  it("holds the hard-cap flush open for a trailing report byte", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    // A sustained crash keeps the burst alive to the hard cap: increments at
    // 2000 (typed off-track), 3300, 4600, and 4990 — the last one untyped,
    // its collision byte trailing by 2 frames, right as the cap expires.
    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }),
      2_000,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 3_300, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 3 }), 4_600, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 4_990, emit);

    // Cap expired (age 3010 ms) but the late-type window is still open — the
    // flush must wait for the trailing byte instead of announcing off-track.
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 5_010, emit);
    expect(occurred(events)).toEqual([]);

    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 4, PlayerIncidents: IncidentFlags.RepCollisionWithCar }),
      5_023,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 4 }), 5_200, emit);

    expect(occurred(events)).toEqual([{ delta: 4, points: 4, type: "collision-car" }]);
  });

  it("announces the discipline-resolved collision-car value", () => {
    const run = (collisionCarValue: number): Array<{ delta: number; points: number; type: string }> => {
      const state = createInitialState();
      const { events, emit } = collect();
      diffIncidents(state, tick(), 1_000, emit, collisionCarValue);
      diffIncidents(
        state,
        tick({ PlayerIncidents: IncidentFlags.RepCollisionWithCar }),
        2_000,
        emit,
        collisionCarValue,
      );
      diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 2_033, emit, collisionCarValue);
      diffIncidents(
        state,
        tick({ PlayerCarMyIncidentCount: 2 }),
        2_033 + INCIDENT_BURST_QUIET_MS,
        emit,
        collisionCarValue,
      );

      return occurred(events);
    };

    expect(run(COLLISION_CAR_VALUE_DIRT)).toEqual([{ delta: 2, points: 2, type: "collision-car" }]);
    expect(run(COLLISION_CAR_VALUE_PAVEMENT)).toEqual([{ delta: 2, points: 4, type: "collision-car" }]);
  });

  it("announces points 0 for a contact type so audio skips the count clause", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepContactWithCar }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([{ delta: 1, points: 0, type: "contact-car" }]);
  });

  it("keeps an untyped-only burst silent", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_000 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([]);
  });

  it("announces two separated off-tracks independently", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033 + INCIDENT_BURST_QUIET_MS, emit);
    diffIncidents(
      state,
      tick({ PlayerCarMyIncidentCount: 1, PlayerIncidents: IncidentFlags.RepOffTrack }),
      7_000,
      emit,
    );
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 7_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 2 }), 7_033 + INCIDENT_BURST_QUIET_MS, emit);

    expect(occurred(events)).toEqual([
      { delta: 1, points: 1, type: "off-track" },
      { delta: 1, points: 1, type: "off-track" },
    ]);
  });

  it("clears the pending burst on pit-lane entry", () => {
    const state = createInitialState();
    const { events, emit } = collect();
    seed(state, emit);

    diffIncidents(state, tick({ PlayerIncidents: IncidentFlags.RepOffTrack }), 2_000, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 2_033, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1, OnPitRoad: true }), 2_100, emit);
    diffIncidents(state, tick({ PlayerCarMyIncidentCount: 1 }), 6_000, emit);

    expect(occurred(events)).toEqual([]);
  });
});
