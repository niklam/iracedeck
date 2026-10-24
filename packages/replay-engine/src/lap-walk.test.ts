import type { TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { FastestLapPressCancelled } from "./lap-press.js";
import { computeFastestLapBisectionProbe, putReplayBack, SESSION_STRIDE } from "./lap-walk.js";
import { fakeReplay, type FakeReplay } from "./replay-command-gate.test-support.js";
import { cancelReplayCursorOwner, interruptReplayCursorOwnerIf } from "./replay-cursor.js";
import { resetEngine } from "./replay-engine-reset.test-support.js";
import { beginReplayJump, type ReplayJump } from "./replay-jump-playback.js";
import type { ReplaySpeed } from "./replay-jump-speed.js";

describe("putReplayBack (#1354, #1428 / #1435)", () => {
  let sim: FakeReplay;
  let info: Mock<(message: string) => void>;

  /** The engine over `sim`, the walk's `ReplayControl` lines into {@link info}. */
  function configure(speed: ReplaySpeed): void {
    sim = fakeReplay({ frame: 30_000, speed });
    info = vi.fn();

    const root: ILogger = {
      ...silentLogger,
      createScope: (scope) => (scope === "ReplayControl" ? { ...silentLogger, info: (m) => info(m) } : silentLogger),
    };

    resetEngine({
      logger: root,
      now: () => Date.now(),
      replay: () => sim.replay,
      readTelemetry: () => sim.telemetry(),
      inReplay: () => true,
      connected: () => true,
    });
  }

  /** A walk's jump, as the press opens it: the speed captured, the cursor claimed. */
  function walkJump(): ReplayJump {
    return beginReplayJump("jump-to-fastest-lap walk", sim.telemetry(), undefined, Date.now(), { origin: "ctx" });
  }

  /** The commands sent, by name: what the walk's way back sent. */
  const sent = (): string[] => [...sim.calls];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetEngine();
    vi.useRealTimers();
  });

  it("sends nothing for a walk that had not sent its opening pause", async () => {
    configure({ speed: 1, slowMotion: false });
    const jump = walkJump();

    await putReplayBack(jump, "Jump to fastest lap", { frame: null, paused: false });

    expect(sent()).toEqual([]);
    jump.end();
  });

  it("stopped in its opening pause: only the captured speed goes back, logged as the interrupted press", async () => {
    configure({ speed: 4, slowMotion: true });
    const jump = walkJump();

    interruptReplayCursorOwnerIf(["jump-to-fastest-lap walk"], "next-car");
    await putReplayBack(jump, "Jump to fastest lap", { frame: null, paused: true }, "next-car");

    expect(sent()).toEqual(["setPlaySpeed 4 true"]);
    expect(info).toHaveBeenCalledWith("Jump to fastest lap: walk interrupted by next-car; replay put back");
    jump.end();
  });

  it("stopped in its opening pause of a paused replay: nothing to send", async () => {
    configure({ speed: 0, slowMotion: false });
    const jump = walkJump();

    await putReplayBack(jump, "Jump to fastest lap", { frame: null, paused: true });

    expect(sent()).toEqual([]);
    expect(info).toHaveBeenCalledWith("Jump to fastest lap: replay put back where the press found it");
    jump.end();
  });

  it("sends nothing once a replay command took the cursor, interrupted or not", async () => {
    configure({ speed: 1, slowMotion: false });
    const jump = walkJump();

    interruptReplayCursorOwnerIf(["jump-to-fastest-lap walk"], "next-car");
    cancelReplayCursorOwner("frame-forward");

    await expect(
      putReplayBack(jump, "Jump to fastest lap", { frame: null, paused: true }, "next-car"),
    ).rejects.toBeInstanceOf(FastestLapPressCancelled);
    await expect(putReplayBack(jump, "Jump to fastest lap", { frame: 12_000, paused: true })).rejects.toBeInstanceOf(
      FastestLapPressCancelled,
    );
    expect(sent()).toEqual([]);
    jump.end();
  });
});

/** A sample with `carIdx` 2 on `lap` at `dist`, in `sessionNum`. */
function sample(sessionNum: number | undefined, lap: number, dist: number): TelemetryData {
  return { SessionNum: sessionNum, CarIdxLap: [0, 0, lap], CarIdxLapDistPct: [0, 0, dist] } as unknown as TelemetryData;
}

describe("computeFastestLapBisectionProbe (#607)", () => {
  it("scores a car in the world by session first, then lap and distance", () => {
    expect(computeFastestLapBisectionProbe(sample(2, 7, 0.25), 2)).toEqual({
      kind: "in-world",
      sessionNum: 2,
      lap: 7,
      dist: 0.25,
      score: 2 * SESSION_STRIDE + 7.25,
    });

    const score = (telemetry: TelemetryData): number => {
      const probe = computeFastestLapBisectionProbe(telemetry, 2);

      if (probe.kind !== "in-world") throw new Error(`expected a car in the world, got ${probe.kind}`);

      return probe.score;
    };

    // The last lap of a long session still scores below the first of the next.
    expect(score(sample(1, 900, 0.99))).toBeLessThan(score(sample(2, 0, 0)));
  });

  it("reads a car whose lap or distance is below zero as out of the world, keeping the session", () => {
    expect(computeFastestLapBisectionProbe(sample(2, -1, 0.5), 2)).toEqual({ kind: "out-of-world", sessionNum: 2 });
    expect(computeFastestLapBisectionProbe(sample(2, 3, -1), 2)).toEqual({ kind: "out-of-world", sessionNum: 2 });
    // A car the arrays do not reach is not in the world either.
    expect(computeFastestLapBisectionProbe(sample(2, 3, 0.5), 9)).toEqual({ kind: "out-of-world", sessionNum: 2 });
  });

  it("is missing without a SessionNum, or without telemetry", () => {
    expect(computeFastestLapBisectionProbe(sample(undefined, 3, 0.5), 2)).toEqual({ kind: "missing" });
    expect(computeFastestLapBisectionProbe(null, 2)).toEqual({ kind: "missing" });
  });
});
