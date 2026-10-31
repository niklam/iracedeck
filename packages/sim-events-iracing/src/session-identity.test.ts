import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  advanceSessionIdentity,
  createSessionIdentityBaseline,
  readSessionIdentity,
  type SessionIdentityBaseline,
  type SessionIdentityChange,
} from "./session-identity.js";

type SessionInfo = Record<string, unknown> | null;

/** Session info for one event: its `SubSessionID` (absent when `undefined`) and `SimMode`. */
function sessionInfo(subSessionId: number | undefined, simMode = "full"): SessionInfo {
  return {
    WeekendInfo: { SimMode: simMode, ...(subSessionId === undefined ? {} : { SubSessionID: subSessionId }) },
  };
}

function tick(sessionNum: number | undefined, isReplayPlaying = false): TelemetryData {
  return { SessionNum: sessionNum, IsReplayPlaying: isReplayPlaying } as TelemetryData;
}

/**
 * Steps a baseline through `ticks` as a subscriber does (read, then advance)
 * and returns every change, in order, with the baseline it ended on.
 */
function run(
  ticks: Array<[TelemetryData, SessionInfo]>,
  start: SessionIdentityBaseline = createSessionIdentityBaseline(),
): { changes: SessionIdentityChange[]; baseline: SessionIdentityBaseline } {
  const changes: SessionIdentityChange[] = [];
  let baseline = start;

  for (const [telemetry, info] of ticks) {
    const reading = readSessionIdentity(baseline, telemetry, () => info);

    if (reading.change) changes.push(reading.change);

    baseline = advanceSessionIdentity(baseline, reading);
  }

  return { changes, baseline };
}

// The 2026-10-26 log's registration practice and race-event practice (#1509).
const REGISTRATION = 89659949;
const RACE_EVENT = 89660575;

describe("session identity", () => {
  describe("seeding", () => {
    it("seeds on the first tick without reporting a change", () => {
      const { changes, baseline } = run([[tick(0), sessionInfo(REGISTRATION)]]);

      expect(changes).toEqual([]);
      expect(baseline).toEqual({ lastObservedSessionNum: 0, lastObservedSubSessionId: REGISTRATION });
    });

    it("reports nothing while the identity holds", () => {
      const { changes } = run([
        [tick(0), sessionInfo(REGISTRATION)],
        [tick(0), sessionInfo(REGISTRATION)],
        [tick(0), sessionInfo(REGISTRATION)],
      ]);

      expect(changes).toEqual([]);
    });

    it("reads no session info and keeps the baseline on a tick without a SessionNum", () => {
      const baseline: SessionIdentityBaseline = { lastObservedSessionNum: 1, lastObservedSubSessionId: REGISTRATION };
      const readSessionInfo = vi.fn(() => sessionInfo(RACE_EVENT));

      const reading = readSessionIdentity(baseline, tick(undefined), readSessionInfo);

      expect(readSessionInfo).not.toHaveBeenCalled();
      expect(reading).toMatchObject({ sessionNum: null, sessionInfo: null, replayOnlySession: false, change: null });
      expect(advanceSessionIdentity(baseline, reading)).toBe(baseline);
    });

    it("reads the session info once on a tick with a SessionNum and hands it back", () => {
      const info = sessionInfo(REGISTRATION);
      const readSessionInfo = vi.fn(() => info);

      const reading = readSessionIdentity(createSessionIdentityBaseline(), tick(0), readSessionInfo);

      expect(readSessionInfo).toHaveBeenCalledTimes(1);
      expect(reading.sessionInfo).toBe(info);
      expect(reading.subSessionId).toBe(REGISTRATION);
    });

    it("changes neither the baseline it reads nor the one it advances", () => {
      const baseline: SessionIdentityBaseline = { lastObservedSessionNum: 0, lastObservedSubSessionId: REGISTRATION };
      const before = { ...baseline };

      const reading = readSessionIdentity(baseline, tick(1), () => sessionInfo(RACE_EVENT));
      const next = advanceSessionIdentity(baseline, reading);

      expect(baseline).toEqual(before);
      expect(next).not.toBe(baseline);
      expect(next).toEqual({ lastObservedSessionNum: 1, lastObservedSubSessionId: RACE_EVENT });
    });
  });

  describe("SessionNum (issue #564)", () => {
    it("reports a SessionNum change from the last observed one", () => {
      const { changes } = run([
        [tick(1), sessionInfo(REGISTRATION)],
        [tick(2), sessionInfo(REGISTRATION)],
      ]);

      expect(changes).toEqual([
        {
          previousSessionNum: 1,
          sessionNum: 2,
          previousSubSessionId: REGISTRATION,
          subSessionId: REGISTRATION,
          subSessionChanged: false,
        },
      ]);
    });

    it("reports the change on a replay-mode loading tick of a live session (the #568 shape)", () => {
      const { changes } = run([
        [tick(1), sessionInfo(REGISTRATION)],
        [tick(2, true), sessionInfo(REGISTRATION)],
        [tick(2), sessionInfo(REGISTRATION)],
      ]);

      expect(changes.map((c) => [c.previousSessionNum, c.sessionNum])).toEqual([[1, 2]]);
    });

    it("compares across a tick without a SessionNum rather than seeding again", () => {
      const { changes } = run([
        [tick(1), sessionInfo(REGISTRATION)],
        [tick(undefined), null],
        [tick(2), sessionInfo(REGISTRATION)],
      ]);

      expect(changes.map((c) => [c.previousSessionNum, c.sessionNum])).toEqual([[1, 2]]);
    });
  });

  describe("a new subsession is a session change (issue #1509)", () => {
    it("reports a change from 0 to 0 when only the subsession changes", () => {
      const { changes } = run([
        [tick(0), sessionInfo(REGISTRATION)],
        [tick(0), sessionInfo(RACE_EVENT)],
        [tick(0), sessionInfo(RACE_EVENT)],
      ]);

      expect(changes).toEqual([
        {
          previousSessionNum: 0,
          sessionNum: 0,
          previousSubSessionId: REGISTRATION,
          subSessionId: RACE_EVENT,
          subSessionChanged: true,
        },
      ]);
    });

    it("neither reports nor advances while a saved replay shows another subsession", () => {
      const live: SessionIdentityBaseline = { lastObservedSessionNum: 0, lastObservedSubSessionId: REGISTRATION };
      const replay = readSessionIdentity(live, tick(3, true), () => sessionInfo(70000000, "replay"));

      expect(replay.replayOnlySession).toBe(true);
      expect(replay.change).toBeNull();
      expect(advanceSessionIdentity(live, replay)).toBe(live);

      // Back to live in the same event: no phantom change against the replay's identity.
      const { changes } = run(
        [
          [tick(3, true), sessionInfo(70000000, "replay")],
          [tick(0), sessionInfo(REGISTRATION)],
        ],
        live,
      );

      expect(changes).toEqual([]);
    });

    it("reports once when a tick without a readable SubSessionID sits between the two events", () => {
      const { changes } = run([
        [tick(0), sessionInfo(REGISTRATION)],
        [tick(0), null],
        [tick(0), sessionInfo(undefined)],
        [tick(0), sessionInfo(RACE_EVENT)],
        [tick(0), sessionInfo(RACE_EVENT)],
      ]);

      expect(changes).toEqual([
        {
          previousSessionNum: 0,
          sessionNum: 0,
          previousSubSessionId: REGISTRATION,
          subSessionId: RACE_EVENT,
          subSessionChanged: true,
        },
      ]);
    });

    it("reports once when SessionNum changes on a tick without a readable SubSessionID and a new one follows", () => {
      const { changes, baseline } = run([
        [tick(0), sessionInfo(REGISTRATION)],
        [tick(1), sessionInfo(undefined)],
        [tick(1), sessionInfo(RACE_EVENT)],
        [tick(1), sessionInfo(RACE_EVENT)],
      ]);

      expect(changes).toEqual([
        {
          previousSessionNum: 0,
          sessionNum: 1,
          previousSubSessionId: REGISTRATION,
          subSessionId: null,
          subSessionChanged: false,
        },
      ]);
      // The new subsession was seeded: a later event is still detected.
      expect(baseline).toEqual({ lastObservedSessionNum: 1, lastObservedSubSessionId: RACE_EVENT });
      expect(run([[tick(1), sessionInfo(89661111)]], baseline).changes).toEqual([
        {
          previousSessionNum: 1,
          sessionNum: 1,
          previousSubSessionId: RACE_EVENT,
          subSessionId: 89661111,
          subSessionChanged: true,
        },
      ]);
    });

    it("keeps the subsession baseline through a tick without a readable one when SessionNum holds", () => {
      const { baseline } = run([
        [tick(0), sessionInfo(REGISTRATION)],
        [tick(0), sessionInfo(undefined)],
      ]);

      expect(baseline).toEqual({ lastObservedSessionNum: 0, lastObservedSubSessionId: REGISTRATION });
    });

    it("reports once when SessionNum and SubSessionID change on the same tick", () => {
      const { changes } = run([
        [tick(0), sessionInfo(REGISTRATION)],
        [tick(1), sessionInfo(RACE_EVENT)],
      ]);

      expect(changes).toEqual([
        {
          previousSessionNum: 0,
          sessionNum: 1,
          previousSubSessionId: REGISTRATION,
          subSessionId: RACE_EVENT,
          subSessionChanged: true,
        },
      ]);
    });

    it("treats offline (SubSessionID 0) to a hosted event as a change", () => {
      const { changes } = run([
        [tick(0), sessionInfo(0)],
        [tick(0), sessionInfo(REGISTRATION)],
      ]);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ previousSubSessionId: 0, subSessionId: REGISTRATION });
    });

    it("seeds rather than compares from a fresh baseline, as after a disconnect", () => {
      const { baseline } = run([[tick(0), sessionInfo(REGISTRATION)]]);

      expect(baseline.lastObservedSubSessionId).toBe(REGISTRATION);

      const { changes } = run([[tick(0), sessionInfo(RACE_EVENT)]], createSessionIdentityBaseline());

      expect(changes).toEqual([]);
    });
  });
});
