import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPLAY_JUMP_PLAYBACK,
  parseReplayJumpPlayback,
  REPLAY_JUMP_PLAYBACK_MODES,
} from "./replay-jump-playback.js";

describe("parseReplayJumpPlayback (issue #1276)", () => {
  it("passes the three mode strings through", () => {
    for (const mode of REPLAY_JUMP_PLAYBACK_MODES) {
      expect(parseReplayJumpPlayback(mode)).toBe(mode);
    }
  });

  it("falls back to the default for anything else", () => {
    expect(DEFAULT_REPLAY_JUMP_PLAYBACK).toBe("remember");
    expect(parseReplayJumpPlayback(undefined)).toBe("remember");
    expect(parseReplayJumpPlayback(null)).toBe("remember");
    expect(parseReplayJumpPlayback("resume")).toBe("remember");
    expect(parseReplayJumpPlayback("PLAY")).toBe("remember"); // exact match only
    expect(parseReplayJumpPlayback(true)).toBe("remember");
    expect(parseReplayJumpPlayback(1)).toBe("remember");
  });
});
