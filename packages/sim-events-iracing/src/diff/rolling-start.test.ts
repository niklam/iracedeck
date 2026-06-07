/**
 * Unit tests for the rolling-start "pace car is moving" diff (issue #660).
 *
 * The cue fires once at the `*→ParadeLaps` entry edge of a rolling start (the
 * field released into the formation lap), never on a standing start, and
 * re-fires on a genuine re-entry into ParadeLaps (a re-grid). The first tick
 * after connect seeds without firing.
 */
import { SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it } from "vitest";

import { createInitialState, type TranslatorState } from "../state.js";
import { diffRollingStart } from "./rolling-start.js";
import type { PendingEvent } from "./types.js";

/** Rolling start (StandingStart not set). */
const ROLLING: Record<string, unknown> | null = null;
/** Standing start. */
const STANDING: Record<string, unknown> = { WeekendInfo: { WeekendOptions: { StandingStart: 1 } } };

function feed(
  state: TranslatorState,
  sessionInfo: Record<string, unknown> | null,
  sessionState: number,
): PendingEvent[] {
  const events: PendingEvent[] = [];
  const telemetry = { SessionState: sessionState } as TelemetryData;
  diffRollingStart(state, telemetry, sessionInfo, (e) => events.push(e));

  return events;
}

const PACE_CAR_MOVING = { event: "rollingStart.pace-car-moving.raised", data: {} } as const;

describe("diffRollingStart", () => {
  it("seeds on the first tick without firing (connecting mid-parade)", () => {
    const state = createInitialState();
    const events = feed(state, ROLLING, SessionState.ParadeLaps);

    expect(events).toEqual([]);
    expect(state.rollingStartInitialized).toBe(true);
  });

  it("fires once at the Warmup→ParadeLaps entry edge on a rolling start", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup); // seed
    const events = feed(state, ROLLING, SessionState.ParadeLaps);

    expect(events).toEqual([PACE_CAR_MOVING]);
  });

  it("never fires on a standing start", () => {
    const state = createInitialState();
    feed(state, STANDING, SessionState.Warmup); // seed
    const events = feed(state, STANDING, SessionState.ParadeLaps);

    expect(events).toEqual([]);
  });

  it("does not re-fire while staying in ParadeLaps", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup); // seed
    feed(state, ROLLING, SessionState.ParadeLaps); // fires

    const again = feed(state, ROLLING, SessionState.ParadeLaps);
    expect(again).toEqual([]);
  });

  it("re-fires when leaving ParadeLaps then re-entering (re-grid)", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup); // seed
    feed(state, ROLLING, SessionState.ParadeLaps); // fires

    feed(state, ROLLING, SessionState.Racing); // race underway
    const events = feed(state, ROLLING, SessionState.ParadeLaps); // re-grid

    expect(events).toEqual([PACE_CAR_MOVING]);
  });

  it("does not fire on a non-ParadeLaps transition (Warmup→Racing)", () => {
    const state = createInitialState();
    feed(state, ROLLING, SessionState.Warmup); // seed
    const events = feed(state, ROLLING, SessionState.Racing);

    expect(events).toEqual([]);
  });
});
