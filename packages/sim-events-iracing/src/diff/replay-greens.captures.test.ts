/**
 * The green recorder against what iRacing actually published (issue #1354):
 * the two 2026-09 offline AI races the caution and rolling-start fixtures were
 * cut from, replayed through `diffReplayGreens` tick by tick.
 *
 * They are the captures the design asks for. Its model is that `SessionState`
 * entering `Racing` IS the green, to within a few ticks of the `StartGo` /
 * `Green` bit, and that a restart is the green rising on the tick the caution
 * bits drop. Both races show the state flip and the bits on ONE session tick,
 * for a standing and for a rolling start, and both show every restart on the
 * tick the bits drop — so the recorder's latch, which lives only as long as a
 * caution bit is set, misses none of the three restarts captured.
 *
 * What the captures do not carry is a replay frame or a session YAML (the
 * watch recorded neither), so the frame here is made from the session time
 * and the session is declared a race by hand. The frame the sim reports, and
 * where a jump to it lands, are the manual test's to measure.
 */
import { Flags, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialState } from "../state.js";
import { diffReplayGreens } from "./replay-greens.js";

type CapturedTick = { t: number; SessionFlags: number; SessionState: number; sessionTick?: number };

function load<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf-8")) as T;
}

/** A single race session at `SessionNum` 0, which is what both offline races were. */
const RACE_ONLY: Record<string, unknown> = {
  WeekendInfo: { SubSessionID: 0 },
  SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
};

/** No capture has a replay frame; one is made from the session time, 60 to the second. */
const frameAt = (t: number): number => Math.round(t * 60);

type RecordedGreen = { index: number; kind: "start" | "restart"; frame: number; sessionTimeMs: number };

function replay(ticks: readonly CapturedTick[], sessionInfo: Record<string, unknown> = RACE_ONLY): RecordedGreen[] {
  const state = createInitialState();
  const greens: RecordedGreen[] = [];

  ticks.forEach((tick, index) => {
    const telemetry = {
      SessionState: tick.SessionState,
      SessionFlags: tick.SessionFlags,
      SessionTime: tick.t,
      SessionNum: 0,
      SessionUniqueID: 1,
      IsReplayPlaying: false,
      ReplayFrameNumEnd: frameAt(tick.t),
    } as TelemetryData;

    diffReplayGreens(state, telemetry, sessionInfo, false, (ev) => {
      if (ev.event !== "replay.greenFlag") throw new Error(`unexpected event ${ev.event}`);

      const { kind, frame, sessionTimeMs } = ev.data;

      greens.push({ index, kind, frame, sessionTimeMs });
    });
  });

  return greens;
}

describe("the green recorder on the 2026-09 captures (issue #1354)", () => {
  it("records the standing start on the tick the lights go out (road course, 2026-09-18)", () => {
    const ticks = load<CapturedTick[]>("replay-greens-standing-20260918.json");

    expect(replay(ticks)).toEqual([{ index: 4, kind: "start", frame: 3419, sessionTimeMs: 56_980 }]);

    // The model, read off the capture: a standing start goes from `Warmup`
    // straight to `Racing` — no `ParadeLaps` — and the flip, `StartGo` and
    // `Green` are one record of the watch, i.e. one session tick.
    const [before, flip] = [ticks[3], ticks[4]];

    expect(before.SessionState).toBe(SessionState.Warmup);
    expect(hasFlag(before.SessionFlags, Flags.StartSet)).toBe(true);
    expect(hasFlag(before.SessionFlags, Flags.Green)).toBe(false);
    expect(flip.SessionState).toBe(SessionState.Racing);
    expect(hasFlag(flip.SessionFlags, Flags.StartGo)).toBe(true);
    expect(hasFlag(flip.SessionFlags, Flags.Green)).toBe(true);
    expect(flip.sessionTick).toBe(3603);
  });

  it("records the rolling start on the tick the field is released (oval, 2026-09-17)", () => {
    const { sessionInfo, ticks } = load<{ sessionInfo: Record<string, unknown>; ticks: CapturedTick[] }>(
      "rolling-start-formation-20260917.json",
    );

    // The fixture's own session YAML, which lists the one race session.
    expect(replay(ticks, sessionInfo)).toEqual([{ index: 29, kind: "start", frame: 12_071, sessionTimeMs: 201_180 }]);

    const [before, flip] = [ticks[28], ticks[29]];

    expect(before.SessionState).toBe(SessionState.ParadeLaps);
    expect(hasFlag(before.SessionFlags, Flags.Green)).toBe(false);
    expect(flip.SessionState).toBe(SessionState.Racing);
    expect(hasFlag(flip.SessionFlags, Flags.StartGo)).toBe(true);
    expect(hasFlag(flip.SessionFlags, Flags.Green)).toBe(true);
  });

  it("records both oval restarts and no start from a capture that begins under green (2026-09-17)", () => {
    const ticks = load<CapturedTick[]>("caution-restart-20260917.json");

    expect(ticks[0].SessionState).toBe(SessionState.Racing);
    expect(replay(ticks)).toEqual([
      { index: 96, kind: "restart", frame: 29_569, sessionTimeMs: 492_820 },
      { index: 248, kind: "restart", frame: 52_347, sessionTimeMs: 872_450 },
    ]);
  });

  it("records the road restart, and nothing for the caution still out when the capture ends (2026-09-18)", () => {
    const ticks = load<CapturedTick[]>("caution-road-20260918.json");
    const last = ticks.at(-1);

    // The capture opens with the start's green still up: seeded, not recorded.
    expect(hasFlag(ticks[0].SessionFlags, Flags.Green)).toBe(true);
    expect(hasFlag(last?.SessionFlags, Flags.CautionWaving)).toBe(true);
    expect(replay(ticks)).toEqual([{ index: 70, kind: "restart", frame: 28_017, sessionTimeMs: 466_950 }]);
  });

  it("drops a caution bit and raises the green on one tick at every captured restart", () => {
    const captures = ["caution-restart-20260917.json", "caution-road-20260918.json"];
    let restarts = 0;

    for (const name of captures) {
      const ticks = load<CapturedTick[]>(name);

      for (let i = 1; i < ticks.length; i++) {
        const greenRose =
          hasFlag(ticks[i].SessionFlags, Flags.Green) && !hasFlag(ticks[i - 1].SessionFlags, Flags.Green);

        if (!greenRose) continue;

        restarts++;
        expect(hasFlag(ticks[i - 1].SessionFlags, Flags.Caution), `${name} #${i}`).toBe(true);
        expect(hasFlag(ticks[i].SessionFlags, Flags.Caution), `${name} #${i}`).toBe(false);
        expect(hasFlag(ticks[i].SessionFlags, Flags.CautionWaving), `${name} #${i}`).toBe(false);
      }
    }

    // Vacuous unless the captures hold restarts at all.
    expect(restarts).toBe(3);
  });
});
