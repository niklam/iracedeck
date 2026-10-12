import { ReplayPosMode, replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetReplayCursor,
  cancelReplayCursorOwner,
  currentReplayCursorOwner,
  pendingReplayJumpSpeed,
} from "./replay-cursor.js";
import {
  applyReplayJumpPlayback,
  beginReplayJump,
  captureReplaySpeed,
  describeReplayJump,
  JUMP_SPEED_HOLD_MS,
  readReplayJumpPlayback,
  type ReplayJumpOutcome,
  type ReplaySpeed,
  resolveReplayJumpSpeed,
  runReplayJump,
} from "./replay-jump-playback.js";

const { mockGetGlobalSettings } = vi.hoisted(() => ({
  mockGetGlobalSettings: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@iracedeck/settings", () => ({
  getGlobalSettings: mockGetGlobalSettings,
}));

/** Telemetry as iRacing reports a speed: raw value plus the slow-motion flag. */
function telemetryAt(speed: ReplaySpeed, frame = 90_000): TelemetryData {
  return {
    ReplayFrameNum: frame,
    ReplayPlaySpeed: replaySpeedToSdk(speed.speed, speed.slowMotion),
    ReplayPlaySlowMotion: speed.slowMotion,
  } as TelemetryData;
}

const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };
const NORMAL: ReplaySpeed = { speed: 1, slowMotion: false };
const QUARTER: ReplaySpeed = { speed: 4, slowMotion: true };
const FORWARD_8: ReplaySpeed = { speed: 8, slowMotion: false };
const REWIND_8: ReplaySpeed = { speed: -8, slowMotion: false };

/**
 * A sim that acts on a command only at its next update, `lagMs` later — the
 * shape that makes "read the landing before sending anything else" matter.
 * `calls` is every command in the order it was sent.
 */
function fakeSim(
  initial: ReplaySpeed,
  options: { frame?: number; lagMs?: number; seekLagMs?: number; seekFramesPerUpdate?: number } = {},
) {
  const lagMs = options.lagMs ?? 20;
  const seekLagMs = options.seekLagMs ?? lagMs;
  /** With a value, a seek covers this many frames per 16 ms update, as iRacing does; without, it lands in one step. */
  const seekFramesPerUpdate = options.seekFramesPerUpdate;
  let seeking: ReturnType<typeof setInterval> | null = null;
  let sample = telemetryAt(initial, options.frame ?? 90_000);
  const calls: string[] = [];
  const refuse = { setPlaySpeed: false, setPlayPosition: false };
  const ignore = { setPlaySpeed: false, setPlayPosition: false };

  const replay = {
    setPlaySpeed: vi.fn((speed: number, slowMotion: boolean = false): boolean => {
      calls.push(`speed ${speed}${slowMotion ? " slow" : ""}`);

      if (refuse.setPlaySpeed) return false;

      if (!ignore.setPlaySpeed) {
        setTimeout(() => {
          sample = { ...sample, ...telemetryAt({ speed, slowMotion }, sample.ReplayFrameNum as number) };
        }, lagMs);
      }

      return true;
    }),
    setPlayPosition: vi.fn((_mode: ReplayPosMode, frame: number): boolean => {
      calls.push(`seek ${frame}`);

      if (refuse.setPlayPosition) return false;

      if (ignore.setPlayPosition) return true;

      if (seekFramesPerUpdate === undefined) {
        setTimeout(() => {
          sample = { ...sample, ReplayFrameNum: frame };
        }, seekLagMs);

        return true;
      }

      if (seeking !== null) clearInterval(seeking);

      seeking = setInterval(() => {
        const at = sample.ReplayFrameNum as number;
        const step = Math.min(seekFramesPerUpdate, Math.abs(frame - at));

        sample = { ...sample, ReplayFrameNum: at + Math.sign(frame - at) * step };

        if (sample.ReplayFrameNum === frame && seeking !== null) {
          clearInterval(seeking);
          seeking = null;
        }
      }, 16);

      return true;
    }),
  };

  return {
    replay,
    calls,
    refuse,
    ignore,
    readTelemetry: (): TelemetryData => ({ ...sample }),
    speed: (): ReplaySpeed => captureReplaySpeed(null, sample, 0),
    /** Stops a seek where it has got to, as a replay command arriving mid-search does. */
    stallSeek: (): void => {
      if (seeking !== null) clearInterval(seeking);

      seeking = null;
    },
  };
}

function setMode(mode: unknown): void {
  mockGetGlobalSettings.mockReturnValue({ replayJumpPlayback: mode, fastestLapSearchDelayMs: 400 });
}

/** Runs timers until the outcome settles, and returns it. */
async function settle(outcome: Promise<ReplayJumpOutcome>, ms = 5_000): Promise<ReplayJumpOutcome> {
  await vi.advanceTimersByTimeAsync(ms);

  return outcome;
}

describe("replay-jump-playback (#1276)", () => {
  beforeEach(() => {
    _resetReplayCursor();
    vi.useFakeTimers();
    mockGetGlobalSettings.mockReset();
    setMode("remember");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("readReplayJumpPlayback", () => {
    it.each(["remember", "play", "stopped"])("reads %s", (mode) => {
      setMode(mode);

      expect(readReplayJumpPlayback()).toBe(mode);
    });

    it("reads a missing or unknown value as remember", () => {
      mockGetGlobalSettings.mockReturnValue({});
      expect(readReplayJumpPlayback()).toBe("remember");

      setMode("resume");
      expect(readReplayJumpPlayback()).toBe("remember");
    });
  });

  describe("captureReplaySpeed", () => {
    it("reads the exact speed from telemetry, slow motion decoded", () => {
      expect(captureReplaySpeed(null, telemetryAt(PAUSED), 0)).toEqual(PAUSED);
      expect(captureReplaySpeed(null, telemetryAt(NORMAL), 0)).toEqual(NORMAL);
      expect(captureReplaySpeed(null, telemetryAt(REWIND_8), 0)).toEqual(REWIND_8);
      // iRacing reports 1/4x as raw 3 with the slow-motion flag (#1202).
      expect(captureReplaySpeed(null, { ReplayPlaySpeed: 3, ReplayPlaySlowMotion: true } as TelemetryData, 0)).toEqual(
        QUARTER,
      );
    });

    it("takes an unreadable speed as paused", () => {
      expect(captureReplaySpeed(null, null, 0)).toEqual(PAUSED);
      expect(captureReplaySpeed(null, {} as TelemetryData, 0)).toEqual(PAUSED);
    });

    it("a paused replay has no slow-motion flag to remember", () => {
      expect(captureReplaySpeed(null, { ReplayPlaySpeed: 0, ReplayPlaySlowMotion: true } as TelemetryData, 0)).toEqual(
        PAUSED,
      );
    });

    it("inherits the speed of a jump still under way, whatever telemetry reads and however long ago", () => {
      const pending = { ...FORWARD_8, appliedAt: null };

      expect(captureReplaySpeed(pending, telemetryAt(PAUSED), 1_000_000)).toEqual(FORWARD_8);
    });

    it("reads the speed a jump just applied until telemetry shows it", () => {
      const pending = { ...NORMAL, appliedAt: 10_000 };

      expect(captureReplaySpeed(pending, telemetryAt(PAUSED), 10_030)).toEqual(NORMAL);
      expect(captureReplaySpeed(pending, null, 10_030)).toEqual(NORMAL);
    });

    it("goes back to telemetry once the hold has run out", () => {
      const pending = { ...NORMAL, appliedAt: 10_000 };

      expect(captureReplaySpeed(pending, telemetryAt(PAUSED), 10_000 + JUMP_SPEED_HOLD_MS - 1)).toEqual(NORMAL);
      expect(captureReplaySpeed(pending, telemetryAt(PAUSED), 10_000 + JUMP_SPEED_HOLD_MS)).toEqual(PAUSED);
    });
  });

  describe("resolveReplayJumpSpeed", () => {
    it("remember is the captured speed, play is 1x, stopped is paused", () => {
      for (const captured of [PAUSED, NORMAL, QUARTER, FORWARD_8, REWIND_8]) {
        expect(resolveReplayJumpSpeed("remember", captured)).toEqual(captured);
        expect(resolveReplayJumpSpeed("play", captured)).toEqual(NORMAL);
        expect(resolveReplayJumpSpeed("stopped", captured)).toEqual(PAUSED);
      }
    });
  });

  describe("runReplayJump", () => {
    const states: Array<[string, ReplaySpeed, string]> = [
      ["paused", PAUSED, "speed 0"],
      ["playing at 1x", NORMAL, "speed 1"],
      ["in slow motion at 1/4x", QUARTER, "speed 4 slow"],
      ["fast-forwarding at 8x", FORWARD_8, "speed 8"],
      ["rewinding at -8x", REWIND_8, "speed -8"],
    ];

    describe.each(states)("from a replay %s", (_name, before, restoreCommand) => {
      const wasPaused = before.speed === 0;
      const pauseFirst = wasPaused ? [] : ["speed 0"];

      it("remember: lands and carries on at the speed it had", async () => {
        setMode("remember");
        const sim = fakeSim(before);
        const jump = beginReplayJump("next", sim.readTelemetry());
        const outcome = await settle(
          runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry }),
        );

        jump.end();

        // A paused press sends the seek and nothing else.
        expect(sim.calls).toEqual([...pauseFirst, "seek 64401", ...(wasPaused ? [] : [restoreCommand])]);
        expect(outcome).toEqual({ kind: "landed", speed: before, command: wasPaused ? "none" : "sent" });

        await vi.advanceTimersByTimeAsync(100);
        expect(sim.speed()).toEqual(before);
        expect(sim.readTelemetry().ReplayFrameNum).toBe(64_401);
      });

      it("play: lands and plays at 1x", async () => {
        setMode("play");
        const sim = fakeSim(before);
        const jump = beginReplayJump("next", sim.readTelemetry());
        const outcome = await settle(
          runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry }),
        );

        jump.end();

        expect(sim.calls).toEqual([...pauseFirst, "seek 64401", "speed 1"]);
        expect(outcome).toEqual({ kind: "landed", speed: NORMAL, command: "sent" });

        await vi.advanceTimersByTimeAsync(100);
        expect(sim.speed()).toEqual(NORMAL);
      });

      it("stopped: lands and stays paused", async () => {
        setMode("stopped");
        const sim = fakeSim(before);
        const jump = beginReplayJump("next", sim.readTelemetry());
        const outcome = await settle(
          runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry }),
        );

        jump.end();

        // The pause before the seek is the only speed command: the landing already reads paused.
        expect(sim.calls).toEqual([...pauseFirst, "seek 64401"]);
        expect(outcome).toEqual({ kind: "landed", speed: PAUSED, command: "none" });

        await vi.advanceTimersByTimeAsync(100);
        expect(sim.speed()).toEqual(PAUSED);
      });
    });

    it("sends the seek at once when the replay reads paused", () => {
      const sim = fakeSim(PAUSED);
      const jump = beginReplayJump("next", sim.readTelemetry());

      void runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry });

      expect(sim.replay.setPlayPosition).toHaveBeenCalledExactlyOnceWith(ReplayPosMode.Begin, 64_401);
    });

    it("waits for the pause to show before it seeks", async () => {
      const sim = fakeSim(NORMAL, { lagMs: 120 });
      const jump = beginReplayJump("next", sim.readTelemetry());
      const onPaused = vi.fn();
      const outcome = runReplayJump(jump, {
        frame: 64_401,
        replay: sim.replay,
        readTelemetry: sim.readTelemetry,
        onPaused,
      });

      expect(sim.calls).toEqual(["speed 0"]);
      expect(onPaused).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(100);
      expect(sim.calls).toEqual(["speed 0"]);

      await vi.advanceTimersByTimeAsync(50);
      expect(sim.calls).toEqual(["speed 0", "seek 64401"]);

      await settle(outcome);
      jump.end();
    });

    it("sends nothing between the seek and the landing, then the caller's step, then the speed", async () => {
      setMode("play");
      const sim = fakeSim(PAUSED, { lagMs: 400 });
      const jump = beginReplayJump("jump-to-fastest-lap record jump", sim.readTelemetry());
      const afterLanding = vi.fn((landing: TelemetryData): boolean => {
        sim.calls.push(`camera at ${landing.ReplayFrameNum as number}`);

        return true;
      });
      const outcome = runReplayJump(jump, {
        frame: 64_401,
        replay: sim.replay,
        readTelemetry: sim.readTelemetry,
        afterLanding,
      });

      await vi.advanceTimersByTimeAsync(350);
      expect(sim.calls).toEqual(["seek 64401"]);
      expect(afterLanding).not.toHaveBeenCalled();

      await settle(outcome);
      jump.end();

      expect(sim.calls).toEqual(["seek 64401", "camera at 64401", "speed 1"]);
    });

    it("stops paused on the frame, sending no speed, when the caller's step fails", async () => {
      setMode("play");
      const sim = fakeSim(NORMAL);
      const jump = beginReplayJump("jump-to-fastest-lap record jump", sim.readTelemetry());
      const outcome = await settle(
        runReplayJump(jump, {
          frame: 64_401,
          replay: sim.replay,
          readTelemetry: sim.readTelemetry,
          afterLanding: () => false,
        }),
      );

      jump.end();

      expect(outcome).toMatchObject({ kind: "stopped", reason: "after-landing-failed" });
      expect(sim.calls).toEqual(["speed 0", "seek 64401"]);
      expect(pendingReplayJumpSpeed()).toBeNull();
    });

    describe("when the landing times out", () => {
      it.each(["remember", "play", "stopped"])(
        "%s: sends nothing after the seek and leaves the replay paused",
        async (mode) => {
          setMode(mode);
          const sim = fakeSim(NORMAL);
          const jump = beginReplayJump("next", sim.readTelemetry());

          sim.ignore.setPlayPosition = true;

          const outcome = await settle(
            runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry }),
          );

          jump.end();

          expect(outcome).toMatchObject({ kind: "stopped", reason: "seek-timeout" });
          // The last frame seen is in the outcome, for the caller's warning.
          expect((outcome as { telemetry: TelemetryData }).telemetry.ReplayFrameNum).toBe(90_000);
          expect(sim.calls).toEqual(["speed 0", "seek 64401"]);
          expect(sim.speed()).toEqual(PAUSED);
          // What it captured does not outlive it: the next press reads the paused replay.
          expect(pendingReplayJumpSpeed()).toBeNull();
          expect(currentReplayCursorOwner()).toBeNull();
        },
      );

      it("waits the walk's delay × 4, and never less than three seconds", async () => {
        const sim = fakeSim(PAUSED);
        const jump = beginReplayJump("next", sim.readTelemetry());

        sim.ignore.setPlayPosition = true;

        let outcome: ReplayJumpOutcome | null = null;

        void runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry }).then(
          (result) => (outcome = result),
        );

        await vi.advanceTimersByTimeAsync(2_900);
        expect(outcome).toBeNull();

        await vi.advanceTimersByTimeAsync(200);
        expect(outcome).toMatchObject({ kind: "stopped", reason: "seek-timeout" });
        jump.end();
      });
    });

    it("does not seek when the replay never reads paused", async () => {
      const sim = fakeSim(NORMAL);
      const jump = beginReplayJump("next", sim.readTelemetry());

      sim.ignore.setPlaySpeed = true;

      const outcome = await settle(
        runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry }),
      );

      jump.end();

      expect(outcome).toMatchObject({ kind: "stopped", reason: "pause-timeout" });
      expect(sim.calls).toEqual(["speed 0"]);
    });

    it("stops at once when the pause or the seek is refused", async () => {
      const moving = fakeSim(NORMAL);
      const first = beginReplayJump("next", moving.readTelemetry());

      moving.refuse.setPlaySpeed = true;

      await expect(
        runReplayJump(first, { frame: 64_401, replay: moving.replay, readTelemetry: moving.readTelemetry }),
      ).resolves.toMatchObject({ kind: "stopped", reason: "pause-failed" });
      first.end();
      expect(moving.calls).toEqual(["speed 0"]);

      const paused = fakeSim(PAUSED);
      const second = beginReplayJump("next", paused.readTelemetry());

      paused.refuse.setPlayPosition = true;

      await expect(
        runReplayJump(second, { frame: 64_401, replay: paused.replay, readTelemetry: paused.readTelemetry }),
      ).resolves.toMatchObject({ kind: "stopped", reason: "seek-failed" });
      second.end();
      expect(paused.calls).toEqual(["seek 64401"]);
    });

    describe("a long seek", () => {
      it("is waited for as long as the cursor keeps moving towards the frame", async () => {
        setMode("play");
        // 2048 frames per update over 800,000 frames: about 6 s, twice the timeout.
        const sim = fakeSim(PAUSED, { frame: 900_000, seekFramesPerUpdate: 2048 });
        const jump = beginReplayJump("next", sim.readTelemetry());
        let outcome: ReplayJumpOutcome | null = null;

        void runReplayJump(jump, { frame: 100_000, replay: sim.replay, readTelemetry: sim.readTelemetry }).then(
          (result) => (outcome = result),
        );

        await vi.advanceTimersByTimeAsync(5_000);
        expect(outcome).toBeNull();
        expect(sim.calls).toEqual(["seek 100000"]);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(outcome).toEqual({ kind: "landed", speed: NORMAL, command: "sent" });
        expect(sim.calls).toEqual(["seek 100000", "speed 1"]);
        jump.end();
      });

      it("gives up once the cursor has stopped short of the frame for the timeout", async () => {
        const sim = fakeSim(NORMAL, { frame: 900_000, seekFramesPerUpdate: 2048 });
        const jump = beginReplayJump("next", sim.readTelemetry());
        let outcome: ReplayJumpOutcome | null = null;

        void runReplayJump(jump, { frame: 100_000, replay: sim.replay, readTelemetry: sim.readTelemetry }).then(
          (result) => (outcome = result),
        );

        await vi.advanceTimersByTimeAsync(2_000);
        sim.stallSeek();

        const stalledAt = sim.readTelemetry().ReplayFrameNum;

        await vi.advanceTimersByTimeAsync(2_900);
        expect(outcome).toBeNull();

        await vi.advanceTimersByTimeAsync(200);
        expect(outcome).toMatchObject({ kind: "stopped", reason: "seek-timeout" });
        expect((outcome as unknown as { telemetry: TelemetryData }).telemetry.ReplayFrameNum).toBe(stalledAt);
        expect(sim.calls).toEqual(["speed 0", "seek 100000"]);
        jump.end();
      });

      it("does not wait for ever on a cursor that never stops moving", async () => {
        // A replay that is playing after all: the frame changes at every read and never reads the target.
        let frame = 90_000;
        const replay = { setPlaySpeed: vi.fn(() => true), setPlayPosition: vi.fn(() => true) };
        const readTelemetry = (): TelemetryData => ({ ReplayFrameNum: frame++, ReplayPlaySpeed: 0 }) as TelemetryData;
        const jump = beginReplayJump("next", readTelemetry());
        let outcome: ReplayJumpOutcome | null = null;

        void runReplayJump(jump, { frame: 10, replay, readTelemetry }).then((result) => (outcome = result));

        await vi.advanceTimersByTimeAsync(119_000);
        expect(outcome).toBeNull();

        await vi.advanceTimersByTimeAsync(2_000);
        expect(outcome).toMatchObject({ kind: "stopped", reason: "seek-timeout" });
        jump.end();
      });
    });

    it("pauses before the seek when a jump just applied a speed telemetry does not show yet", async () => {
      // Each detent of a dial spin: the one before has landed and sent 1x, and
      // telemetry still reads paused. A seek sent now would go into a replay
      // that is starting to play, and be run past.
      const sim = fakeSim(NORMAL, { lagMs: 40 });
      const first = beginReplayJump("dial-next", sim.readTelemetry());
      const firstOutcome = runReplayJump(first, {
        frame: 64_401,
        replay: sim.replay,
        readTelemetry: sim.readTelemetry,
      });

      let applied = false;

      for (let i = 0; i < 100 && !applied; i++) {
        await vi.advanceTimersByTimeAsync(10);
        applied = sim.calls.includes("speed 1");
      }

      await firstOutcome;
      first.end();
      expect(sim.speed()).toEqual(PAUSED);

      const second = beginReplayJump("dial-next", sim.readTelemetry());
      const secondOutcome = runReplayJump(second, {
        frame: 70_000,
        replay: sim.replay,
        readTelemetry: sim.readTelemetry,
      });

      expect(sim.calls).toEqual(["speed 0", "seek 64401", "speed 1", "speed 0"]);

      await expect(settle(secondOutcome)).resolves.toEqual({ kind: "landed", speed: NORMAL, command: "sent" });
      second.end();
      expect(sim.calls).toEqual(["speed 0", "seek 64401", "speed 1", "speed 0", "seek 70000", "speed 1"]);

      await vi.advanceTimersByTimeAsync(100);
      expect(sim.speed()).toEqual(NORMAL);
      expect(sim.readTelemetry().ReplayFrameNum).toBe(70_000);
    });

    describe("cancellation", () => {
      it("another replay command during the wait ends the jump with nothing more sent", async () => {
        setMode("play");
        const sim = fakeSim(NORMAL, { lagMs: 400 });
        const onCancelled = vi.fn();
        const jump = beginReplayJump("next", sim.readTelemetry(), onCancelled);
        const outcome = runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry });

        await vi.advanceTimersByTimeAsync(500);
        expect(sim.calls).toEqual(["speed 0", "seek 64401"]);

        // The driver's own command: the jump must not put its speed over it.
        expect(cancelReplayCursorOwner("play-pause")).toBe("next");
        expect(onCancelled).toHaveBeenCalledExactlyOnceWith("play-pause");

        await expect(settle(outcome)).resolves.toEqual({ kind: "cancelled", by: "play-pause" });
        jump.end();

        expect(sim.calls).toEqual(["speed 0", "seek 64401"]);
        expect(pendingReplayJumpSpeed()).toBeNull();
      });

      it("a jump cancelled before it ran sends nothing", async () => {
        const sim = fakeSim(NORMAL);
        const jump = beginReplayJump("next", sim.readTelemetry());

        cancelReplayCursorOwner("rewind");

        await expect(
          runReplayJump(jump, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry }),
        ).resolves.toEqual({ kind: "cancelled", by: "rewind" });
        jump.end();
        expect(sim.calls).toEqual([]);
      });

      it("a command after the jump's own pause is not restored over by the next jump", async () => {
        const sim = fakeSim(FORWARD_8, { seekLagMs: 400 });
        const first = beginReplayJump("next", sim.readTelemetry());
        const firstOutcome = runReplayJump(first, {
          frame: 64_401,
          replay: sim.replay,
          readTelemetry: sim.readTelemetry,
        });

        await vi.advanceTimersByTimeAsync(60);
        expect(sim.calls).toEqual(["speed 0", "seek 64401"]);
        cancelReplayCursorOwner("pause");
        await expect(settle(firstOutcome)).resolves.toEqual({ kind: "cancelled", by: "pause" });
        first.end();

        // The replay is paused, by the first jump and then by the driver: the next jump remembers paused.
        const second = beginReplayJump("next", sim.readTelemetry());

        expect(second.captured).toEqual(PAUSED);
        second.end();
      });
    });

    describe("overlapping jumps", () => {
      it("a jump that takes over from another restores the speed the first one captured", async () => {
        const sim = fakeSim(REWIND_8, { seekLagMs: 400 });
        const first = beginReplayJump("replay-markers-dial-next", sim.readTelemetry());
        const firstOutcome = runReplayJump(first, {
          frame: 64_401,
          replay: sim.replay,
          readTelemetry: sim.readTelemetry,
        });

        // The first jump has paused the replay and is waiting for its landing;
        // the second press reads the replay paused.
        await vi.advanceTimersByTimeAsync(110);
        expect(sim.calls).toEqual(["speed 0", "seek 64401"]);
        expect(sim.speed()).toEqual(PAUSED);

        const second = beginReplayJump("replay-markers-dial-next", sim.readTelemetry());

        expect(second.captured).toEqual(REWIND_8);

        const secondOutcome = runReplayJump(second, {
          frame: 70_000,
          replay: sim.replay,
          readTelemetry: sim.readTelemetry,
        });

        await expect(settle(firstOutcome)).resolves.toEqual({ kind: "cancelled", by: "replay-markers-dial-next" });
        first.end();

        await expect(settle(secondOutcome)).resolves.toEqual({ kind: "landed", speed: REWIND_8, command: "sent" });
        second.end();

        // The second jump pauses too: the speed it inherited says the replay
        // was moving, and a pause sent to a paused replay costs nothing.
        expect(sim.calls).toEqual(["speed 0", "seek 64401", "speed 0", "seek 70000", "speed -8"]);
        await vi.advanceTimersByTimeAsync(100);
        expect(sim.speed()).toEqual(REWIND_8);
        expect(sim.readTelemetry().ReplayFrameNum).toBe(70_000);
      });

      it("the first jump unwinding after the takeover does not drop the second one's speed", async () => {
        const sim = fakeSim(NORMAL);
        const first = beginReplayJump("next", sim.readTelemetry());
        const second = beginReplayJump("next", sim.readTelemetry());

        first.end();

        expect(pendingReplayJumpSpeed()).toEqual({ ...NORMAL, appliedAt: null });
        second.end();
        expect(pendingReplayJumpSpeed()).toBeNull();
      });

      it("a jump pressed before telemetry shows the speed the last one applied still remembers that speed", async () => {
        const sim = fakeSim(NORMAL, { lagMs: 40 });
        const first = beginReplayJump("next", sim.readTelemetry());
        const firstOutcome = runReplayJump(first, {
          frame: 64_401,
          replay: sim.replay,
          readTelemetry: sim.readTelemetry,
        });

        // Step the sim just far enough to land and apply, not far enough for the applied speed to show.
        let applied = false;

        for (let i = 0; i < 100 && !applied; i++) {
          await vi.advanceTimersByTimeAsync(10);
          applied = sim.calls.includes("speed 1");
        }

        expect(applied).toBe(true);
        await expect(firstOutcome).resolves.toEqual({ kind: "landed", speed: NORMAL, command: "sent" });
        first.end();
        expect(sim.speed()).toEqual(PAUSED);

        const second = beginReplayJump("next", sim.readTelemetry());

        expect(second.captured).toEqual(NORMAL);
        second.end();
      });

      it("once telemetry shows the applied speed, the next jump reads telemetry again", async () => {
        const sim = fakeSim(NORMAL);
        const first = beginReplayJump("next", sim.readTelemetry());

        await settle(runReplayJump(first, { frame: 64_401, replay: sim.replay, readTelemetry: sim.readTelemetry }));
        first.end();
        expect(sim.speed()).toEqual(NORMAL);

        // Changed outside the plugin (iRacing's own replay bar): telemetry is the only witness.
        sim.replay.setPlaySpeed(2, true);
        await vi.advanceTimersByTimeAsync(JUMP_SPEED_HOLD_MS);

        const second = beginReplayJump("next", sim.readTelemetry());

        expect(second.captured).toEqual({ speed: 2, slowMotion: true });
        second.end();
      });
    });
  });

  describe("applyReplayJumpPlayback (the walk's last step)", () => {
    it("restores the speed captured at the press over whatever the walk left", () => {
      const sim = fakeSim(QUARTER);
      const jump = beginReplayJump("jump-to-fastest-lap walk", sim.readTelemetry());

      // The walk paused and moved the cursor itself; its last sample reads paused.
      expect(applyReplayJumpPlayback(jump, sim.replay, telemetryAt(PAUSED, 64_401))).toEqual({
        speed: QUARTER,
        command: "sent",
      });
      expect(sim.calls).toEqual(["speed 4 slow"]);
      jump.end();
    });

    it("sends nothing and returns null once the jump was cancelled", () => {
      setMode("play");
      const sim = fakeSim(PAUSED);
      const jump = beginReplayJump("jump-to-fastest-lap walk", sim.readTelemetry());

      cancelReplayCursorOwner("next marker");

      expect(applyReplayJumpPlayback(jump, sim.replay, telemetryAt(PAUSED))).toBeNull();
      expect(sim.calls).toEqual([]);
      jump.end();
    });

    it("reports a refused speed command and the speed the replay is still at", () => {
      setMode("play");
      const sim = fakeSim(PAUSED);
      const jump = beginReplayJump("jump-to-fastest-lap walk", sim.readTelemetry());

      sim.refuse.setPlaySpeed = true;

      expect(applyReplayJumpPlayback(jump, sim.replay, telemetryAt(PAUSED))).toEqual({
        speed: PAUSED,
        command: "failed",
      });
      jump.end();
    });

    it("sends the speed when the landing sample carries none", () => {
      setMode("stopped");
      const sim = fakeSim(PAUSED);
      const jump = beginReplayJump("jump-to-fastest-lap walk", sim.readTelemetry());

      expect(applyReplayJumpPlayback(jump, sim.replay, null)).toEqual({ speed: PAUSED, command: "sent" });
      expect(sim.calls).toEqual(["speed 0"]);
      jump.end();
    });

    it("reads the setting when the jump lands, not when it was pressed", () => {
      setMode("stopped");
      const sim = fakeSim(NORMAL);
      const jump = beginReplayJump("jump-to-fastest-lap walk", sim.readTelemetry());

      setMode("play");

      expect(applyReplayJumpPlayback(jump, sim.replay, telemetryAt(PAUSED))).toEqual({
        speed: NORMAL,
        command: "sent",
      });
      jump.end();
    });
  });

  describe("describeReplayJump", () => {
    it("has no warning for a jump that landed or was cancelled", () => {
      expect(describeReplayJump({ kind: "landed", speed: QUARTER, command: "sent" }, 64_401)).toEqual({
        warn: null,
        detail: "landed on frame 64401; speed=4 slowMotion=true command=sent",
      });
      expect(describeReplayJump({ kind: "cancelled", by: "play-pause" }, 64_401)).toEqual({
        warn: null,
        detail: "jump to frame 64401 cancelled by play-pause",
      });
    });

    it("warns when the speed command was refused", () => {
      expect(describeReplayJump({ kind: "landed", speed: PAUSED, command: "failed" }, 64_401).warn).toBe(
        "speed command failed; replay left as it landed",
      );
    });

    it.each([
      ["pause-failed", "pause failed; jump not sent"],
      ["pause-timeout", "replay did not pause; jump not sent"],
      ["seek-failed", "jump not sent"],
      ["seek-timeout", "jump did not land; replay left where the seek stopped"],
      ["after-landing-failed", "jump stopped after the landing; replay left paused there"],
    ] as const)("names what went wrong for %s", (reason, warn) => {
      expect(describeReplayJump({ kind: "stopped", reason, telemetry: null }, 64_401).warn).toBe(warn);
    });

    it("puts the frame sent and the frame and speed last seen in the details of a stopped jump", () => {
      const report = describeReplayJump(
        { kind: "stopped", reason: "seek-timeout", telemetry: telemetryAt(PAUSED, 71_000) },
        64_401,
      );

      expect(report.detail).toBe("reason=seek-timeout target=64401 lastFrame=71000 lastSpeed=0");
      expect(describeReplayJump({ kind: "stopped", reason: "seek-failed", telemetry: null }, 64_401).detail).toBe(
        "reason=seek-failed target=64401 lastFrame=n/a lastSpeed=n/a",
      );
    });
  });
});
