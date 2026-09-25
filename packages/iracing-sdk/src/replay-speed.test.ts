import { describe, expect, it } from "vitest";

import { replaySpeedFromSdk, replaySpeedToSdk } from "./replay-speed.js";

describe("replaySpeedToSdk", () => {
  it("sends slow-motion divisor N as N - 1, which iRacing plays at 1/N", () => {
    expect(replaySpeedToSdk(2, true)).toBe(1);
    expect(replaySpeedToSdk(5, true)).toBe(4);
    expect(replaySpeedToSdk(16, true)).toBe(15);
  });

  it("keeps the direction for slow-motion rewind", () => {
    expect(replaySpeedToSdk(-2, true)).toBe(-1);
    expect(replaySpeedToSdk(-16, true)).toBe(-15);
  });

  it("clamps a slow-motion divisor below 2 to 1/2x rather than sending a pause", () => {
    expect(replaySpeedToSdk(1, true)).toBe(1);
    expect(replaySpeedToSdk(-1, true)).toBe(-1);
  });

  it("sends zero as zero", () => {
    expect(replaySpeedToSdk(0, true)).toBe(0);
    expect(replaySpeedToSdk(0, false)).toBe(0);
  });

  it("passes normal speeds through unchanged", () => {
    expect(replaySpeedToSdk(1, false)).toBe(1);
    expect(replaySpeedToSdk(4, false)).toBe(4);
    expect(replaySpeedToSdk(-16, false)).toBe(-16);
  });
});

describe("replaySpeedFromSdk", () => {
  it("reads raw slow-motion N as divisor N + 1", () => {
    expect(replaySpeedFromSdk(1, true)).toBe(2);
    expect(replaySpeedFromSdk(4, true)).toBe(5);
    expect(replaySpeedFromSdk(15, true)).toBe(16);
  });

  it("keeps the direction for slow-motion rewind", () => {
    expect(replaySpeedFromSdk(-1, true)).toBe(-2);
    expect(replaySpeedFromSdk(-15, true)).toBe(-16);
  });

  it("reads zero as paused even with the slow-motion flag set", () => {
    expect(replaySpeedFromSdk(0, true)).toBe(0);
  });

  it("passes normal speeds through unchanged", () => {
    expect(replaySpeedFromSdk(1, false)).toBe(1);
    expect(replaySpeedFromSdk(-8, false)).toBe(-8);
  });

  it("round-trips every slow-motion divisor", () => {
    for (let divisor = 2; divisor <= 16; divisor++) {
      expect(replaySpeedFromSdk(replaySpeedToSdk(divisor, true), true)).toBe(divisor);
      expect(replaySpeedFromSdk(replaySpeedToSdk(-divisor, true), true)).toBe(-divisor);
    }
  });
});
