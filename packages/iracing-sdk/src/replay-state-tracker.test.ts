import type { TelemetryData } from "@iracedeck/iracing-native";
import { describe, expect, it } from "vitest";

import { ReplayStateTracker } from "./replay-state-tracker.js";
import { REPLAY_EXIT_GRACE_MS } from "./telemetry-features.js";

const replayTick = (frame: number): TelemetryData =>
  ({ IsReplayPlaying: true, ReplayFrameNum: frame, ReplayFrameNumEnd: 100 }) as TelemetryData;
const liveTick = (end: number): TelemetryData =>
  ({ IsReplayPlaying: false, ReplayFrameNum: 0, ReplayFrameNumEnd: end }) as TelemetryData;

const LIVE_SESSION = { WeekendInfo: { SimMode: "full" } };
const SAVED_REPLAY = { WeekendInfo: { SimMode: "replay" } };

describe("ReplayStateTracker (#1324)", () => {
  it("starts live with nothing sighted", () => {
    expect(new ReplayStateTracker().read(0)).toMatchObject({ inReplay: false, frame: null, replaySeenAt: null });
  });

  it("steps the rule over the held state and reads it at the caller's time", () => {
    const tracker = new ReplayStateTracker();

    tracker.step(replayTick(500), LIVE_SESSION, 0);
    tracker.step(liveTick(900), LIVE_SESSION, 300);

    expect(tracker.read(300)).toMatchObject({ inReplay: true, frame: 500 });
    expect(tracker.read(REPLAY_EXIT_GRACE_MS - 1)).toMatchObject({ inReplay: true, frame: 500 });
    expect(tracker.read(REPLAY_EXIT_GRACE_MS)).toMatchObject({ inReplay: false, frame: 900 });
  });

  it("noteLeftForLive drops the grace outside a saved replay, so the next false tick is the car", () => {
    const tracker = new ReplayStateTracker();

    tracker.step(replayTick(500), LIVE_SESSION, 0);
    tracker.noteLeftForLive(10);
    tracker.step(liveTick(900), LIVE_SESSION, 50);

    expect(tracker.read(50)).toMatchObject({ inReplay: false, frame: 900 });
  });

  it("noteLeftForLive changes nothing in a saved replay", () => {
    const tracker = new ReplayStateTracker();

    tracker.step(replayTick(500), SAVED_REPLAY, 0);
    tracker.noteLeftForLive(10);
    tracker.step(liveTick(900), SAVED_REPLAY, 50);

    expect(tracker.read(50)).toMatchObject({ inReplay: true, replayOnlySession: true });
  });

  it("reset returns to live with nothing sighted, the saved-replay answer included", () => {
    const tracker = new ReplayStateTracker();

    tracker.step(replayTick(500), SAVED_REPLAY, 0);
    tracker.reset();

    expect(tracker.read(0)).toMatchObject({ inReplay: false, frame: null, replayOnlySession: false });
  });

  it("defaults every clock to Date.now()", () => {
    const tracker = new ReplayStateTracker();

    tracker.step(replayTick(500), LIVE_SESSION);
    tracker.step(liveTick(900), LIVE_SESSION);

    expect(tracker.read()).toMatchObject({ inReplay: true, frame: 500 });
    tracker.noteLeftForLive();
    expect(tracker.read()).toMatchObject({ inReplay: false, frame: 900 });
  });
});
