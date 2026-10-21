import { beforeEach, describe, expect, it } from "vitest";

import { _configureReplayEngine, _resetReplayEngineEnv } from "./replay-engine-env.js";
import { isSameSpeed, readReplayJumpPlayback, resolveReplayJumpSpeed } from "./replay-jump-speed.js";

function setPlayback(value: unknown): void {
  _configureReplayEngine({ settings: { replayJumpPlayback: () => value, fastestLapSearchDelayMs: () => undefined } });
}

describe("replay-jump-speed", () => {
  beforeEach(() => {
    _resetReplayEngineEnv();
  });

  it("reads the Replay jump playback setting through the engine, unreadable as remember", () => {
    setPlayback("play");
    expect(readReplayJumpPlayback()).toBe("play");

    setPlayback(42);
    expect(readReplayJumpPlayback()).toBe("remember");
  });

  it("resolves the speed a jump leaves", () => {
    const captured = { speed: 4, slowMotion: true };

    expect(resolveReplayJumpSpeed("play", captured)).toEqual({ speed: 1, slowMotion: false });
    expect(resolveReplayJumpSpeed("stopped", captured)).toEqual({ speed: 0, slowMotion: false });
    expect(resolveReplayJumpSpeed("remember", captured)).toBe(captured);
  });

  it("compares speeds by value, the slow-motion flag meaning nothing at 0", () => {
    expect(isSameSpeed({ speed: 0, slowMotion: true }, { speed: 0, slowMotion: false })).toBe(true);
    expect(isSameSpeed({ speed: 4, slowMotion: true }, { speed: 4, slowMotion: false })).toBe(false);
    expect(isSameSpeed({ speed: -4, slowMotion: true }, { speed: -4, slowMotion: true })).toBe(true);
    expect(isSameSpeed({ speed: 2, slowMotion: false }, { speed: 2, slowMotion: false })).toBe(true);
  });
});
