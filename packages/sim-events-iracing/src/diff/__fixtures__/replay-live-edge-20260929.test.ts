/**
 * The out-of-car frame against what iRacing reported (issue #1426): four
 * snapshots taken out of the car in the in-session replay of live offline
 * sessions, three scrubbed back and one at the live edge. The live-tick
 * resolver rests on the reading they show: out of the car `ReplayFrameNumEnd`
 * counts the frames from the cursor to the end of the tape, so the cursor plus
 * it is the newest frame recorded, and a small one is the live edge.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createInitialReplayRecorderState } from "../../replay-recorder-state.js";
import { LIVE_EDGE_MAX_FRAMES, resolveReplayLiveTick } from "../replay-record-gate.js";
import { diffReplaySessions } from "../replay-sessions.js";
import type { PendingEvent } from "../types.js";

type Snapshot = {
  snapshot: string;
  sessionInfo: { WeekendInfo: { SimMode: string; SubSessionID: number } };
  telemetry: TelemetryData & {
    SessionTime: number;
    IsOnTrack: boolean;
    IsReplayPlaying: boolean;
    ReplayFrameNum: number;
    ReplayFrameNumEnd: number;
    ReplaySessionTime: number;
  };
};

const snapshots = JSON.parse(
  readFileSync(new URL("./replay-live-edge-20260929.json", import.meta.url), "utf-8"),
) as Snapshot[];

function find(label: string): Snapshot {
  const found = snapshots.find((s) => s.snapshot === label);

  if (!found) throw new Error(`no snapshot ${label}`);

  return found;
}

const EDGE = find("20260929-182927-480");
const SCRUBBED_SAME_SESSION = find("20260929-182921-601");
const SCRUBBED = ["20260928-194048-015", "20260928-210628-373", "20260929-182921-601"].map(find);

/** The newest frame recorded, as the resolver reads it out of the car. */
const newestFrame = (s: Snapshot): number => s.telemetry.ReplayFrameNum + s.telemetry.ReplayFrameNumEnd;

describe("replay-live-edge-20260929 fixture", () => {
  it("is four out-of-car snapshots of live sessions, the raw replay flag true in each", () => {
    expect(snapshots).toHaveLength(4);

    for (const s of snapshots) {
      expect(s.sessionInfo.WeekendInfo.SimMode).toBe("full");
      expect(s.telemetry.IsOnTrack).toBe(false);
      expect(s.telemetry.IsReplayPlaying).toBe(true);
    }
  });

  it("reads ReplayFrameNumEnd as the distance from the cursor to the end of the tape", () => {
    // The cursor's session time is behind the live one by that distance, less
    // the ~59-frame lag of a frame recorded live (#1162).
    for (const s of snapshots) {
      const behind = (s.telemetry.SessionTime - s.telemetry.ReplaySessionTime) * 60 - s.telemetry.ReplayFrameNumEnd;

      expect(behind).toBeGreaterThanOrEqual(57);
      expect(behind).toBeLessThanOrEqual(60);
    }
  });

  it("gives one tape growing at 60 frames a second, wherever the cursor sat", () => {
    // Two snapshots of one session 5.87 s apart, the first scrubbed 40182
    // frames back, the second at the edge: the newest frame moved by exactly
    // the session time between them.
    const elapsedFrames = Math.round((EDGE.telemetry.SessionTime - SCRUBBED_SAME_SESSION.telemetry.SessionTime) * 60);

    expect(newestFrame(EDGE) - newestFrame(SCRUBBED_SAME_SESSION)).toBe(elapsedFrames);
  });

  it("resolves the snapshot at the live edge to the cursor plus ReplayFrameNumEnd", () => {
    expect(EDGE.telemetry.ReplayFrameNumEnd).toBe(1);
    expect(resolveReplayLiveTick(EDGE.telemetry, true, false)).toEqual({
      sessionNum: 0,
      sessionUniqueId: 3,
      frame: 53_593,
    });
  });

  it("resolves no snapshot scrubbed back: the distance to the end is far past the edge", () => {
    for (const s of SCRUBBED) {
      expect(s.telemetry.ReplayFrameNumEnd).toBeGreaterThan(LIVE_EDGE_MAX_FRAMES);
      expect(resolveReplayLiveTick(s.telemetry, true, false)).toBeNull();
    }
  });

  it("records the session's start from the live edge, the frame the scrubbed-back snapshot's sum also gives", () => {
    const state = createInitialReplayRecorderState();
    const out: PendingEvent[] = [];
    // The tick after the snapshot: playback at 1x moves the cursor one frame
    // and the clock one frame's time, and the cursor stays at the edge.
    const next = {
      ...EDGE.telemetry,
      ReplayFrameNum: EDGE.telemetry.ReplayFrameNum + 1,
      SessionTime: EDGE.telemetry.SessionTime + 1 / 60,
    } as TelemetryData;

    for (const t of [SCRUBBED_SAME_SESSION.telemetry, EDGE.telemetry, next]) {
      diffReplaySessions(state, t, EDGE.sessionInfo, true, false, (ev) => out.push(ev));
    }

    // 53593 − round(743.0167 × 60): the session began 9012 frames into the tape.
    expect(out).toEqual([
      {
        event: "replay.sessionStarted",
        data: { subSessionId: 0, sessionNum: 0, sessionUniqueId: 3, frame: 9_012 },
      },
    ]);
    expect(newestFrame(SCRUBBED_SAME_SESSION) - Math.round(SCRUBBED_SAME_SESSION.telemetry.SessionTime * 60)).toBe(
      9_012,
    );
  });
});
