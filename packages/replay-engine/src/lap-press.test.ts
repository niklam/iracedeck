import { afterEach, describe, expect, it } from "vitest";

import { inReplayNow, readSessionInfo } from "./lap-press.js";
import type { ReplayEngineController } from "./replay-engine-env.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";

/** A controller whose every read throws, as a native read may. */
const THROWING = {
  getReplayState: () => {
    throw new Error("native read failed");
  },
  getSessionInfo: () => {
    throw new Error("native read failed");
  },
} as unknown as ReplayEngineController;

describe("lap-press reads (#1467)", () => {
  afterEach(() => {
    resetEngine();
  });

  it("the replay-state read goes through the engine's reads, so a test's override applies", () => {
    const controller = { getReplayState: () => ({ inReplay: false }) } as unknown as ReplayEngineController;

    resetEngine({ controller, inReplay: () => true });

    expect(inReplayNow()).toBe(true);
  });

  it("a replay-state read that throws reads as not in the replay", () => {
    resetEngine({ controller: THROWING });

    expect(inReplayNow()).toBe(false);
  });

  it("reads the controller's replay state when nothing overrides it", () => {
    const controller = { getReplayState: () => ({ inReplay: true }) } as unknown as ReplayEngineController;

    resetEngine({ controller });

    expect(inReplayNow()).toBe(true);
  });

  it("a session-info read that throws reads as none", () => {
    resetEngine({ controller: THROWING });

    expect(readSessionInfo()).toBeUndefined();
  });

  it("reads the controller's session info", () => {
    const info = { WeekendInfo: { SubSessionID: 7 } };
    const controller = { getSessionInfo: () => info } as unknown as ReplayEngineController;

    resetEngine({ controller });

    expect(readSessionInfo()).toBe(info);
  });
});
