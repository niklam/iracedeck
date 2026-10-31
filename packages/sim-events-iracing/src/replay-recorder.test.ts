/**
 * The replay recorder's own sequencing: when it resets, in what order it runs
 * the four recorders and what it hands them. The recorders themselves are
 * mocked here — what they make of the ticks, and the whole stream across the
 * reset points, is the equivalence golden's (`replay-recorder.equivalence.test.ts`).
 */
import type { IEventBus } from "@iracedeck/event-bus";
import type { ReplayState, TelemetryCallback, TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { REPLAY_LAPS_EVENTS } from "./diff/replay-laps.js";
import type { EmitFn } from "./diff/types.js";
import type { ReplayRecorderState } from "./replay-recorder-state.js";
import { createInitialReplayRecorderState } from "./replay-recorder-state.js";
import {
  REPLAY_RECORDER_SUBSCRIPTION_ID,
  type ReplayRecorder,
  type ReplayRecorderController,
  startReplayRecorder,
} from "./replay-recorder.js";

/** The lap recorder's emitter, typed by its own list as `diffReplayLaps` takes it (#1499). */
type LapsEmit = EmitFn<(typeof REPLAY_LAPS_EVENTS)[number]>;

type Step = { name: "laps" | "greens" | "sessions" | "incidents" | "reset"; state: ReplayRecorderState };

const { calls, recorderArgs, onLaps } = vi.hoisted(() => ({
  calls: [] as Step[],
  recorderArgs: [] as Array<{ name: string; args: unknown[] }>,
  /** What the mocked lap recorder does with its state and emit, beyond logging the call. */
  onLaps: { current: null as ((state: ReplayRecorderState, emit: LapsEmit) => void) | null },
}));

vi.mock("./diff/replay-laps.js", () => ({
  diffReplayLaps: vi.fn((state: ReplayRecorderState, ...args: unknown[]) => {
    calls.push({ name: "laps", state });
    recorderArgs.push({ name: "laps", args });
    onLaps.current?.(state, args[3] as LapsEmit);
  }),
}));
vi.mock("./diff/replay-greens.js", () => ({
  diffReplayGreens: vi.fn((state: ReplayRecorderState, ...args: unknown[]) => {
    calls.push({ name: "greens", state });
    recorderArgs.push({ name: "greens", args });
  }),
}));
vi.mock("./diff/replay-sessions.js", () => ({
  diffReplaySessions: vi.fn((state: ReplayRecorderState, ...args: unknown[]) => {
    calls.push({ name: "sessions", state });
    recorderArgs.push({ name: "sessions", args });
  }),
}));
vi.mock("./diff/replay-incidents.js", () => ({
  diffReplayIncidents: vi.fn((state: ReplayRecorderState, ...args: unknown[]) => {
    calls.push({ name: "incidents", state });
    recorderArgs.push({ name: "incidents", args });
  }),
}));
vi.mock("./replay-recorder-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./replay-recorder-state.js")>();

  return {
    ...actual,
    resetReplayRecorderBaselines: vi.fn((state: ReplayRecorderState) => {
      calls.push({ name: "reset", state });

      return actual.resetReplayRecorderBaselines(state);
    }),
  };
});

const RECORDERS = ["laps", "greens", "sessions", "incidents"];

type SessionInfo = Record<string, unknown> | null;

function sessionInfo(subSessionId: number, simMode = "full"): SessionInfo {
  return { WeekendInfo: { SubSessionID: subSessionId, SimMode: simMode } };
}

function tick(sessionNum: number | undefined): TelemetryData {
  return { SessionNum: sessionNum } as TelemetryData;
}

/** The controller surface the recorder reads, with the real controller's delivery rule on subscribe. */
function createController() {
  let callback: TelemetryCallback | null = null;
  let info: SessionInfo = sessionInfo(89659949);
  let replay = { inReplay: false, replayOnlySession: false };

  const controller = {
    subscribe: vi.fn((_id: string, cb: TelemetryCallback) => {
      callback = cb;
      // The real controller notifies a new subscriber at once; before the
      // first connect that is `(null, false)`.
      cb(null, false);
    }),
    unsubscribe: vi.fn(() => {
      callback = null;
    }),
    getSessionInfo: vi.fn((): SessionInfo => info),
    getReplayState: vi.fn((): ReplayState => replay as ReplayState),
  };

  return {
    controller,
    setSessionInfo(next: SessionInfo) {
      info = next;
    },
    setReplay(next: { inReplay: boolean; replayOnlySession?: boolean }) {
      replay = { replayOnlySession: false, ...next };
    },
    deliver(telemetry: TelemetryData | null, isConnected = true) {
      callback?.(telemetry, isConnected);
    },
  };
}

describe("startReplayRecorder", () => {
  let bus: IEventBus;
  let publish: ReturnType<typeof vi.fn>;
  let fake: ReturnType<typeof createController>;
  let recorder: ReplayRecorder;
  let logger: ILogger;

  /** The step names logged since the last call, cleared. */
  function take(): string[] {
    const names = calls.map((c) => c.name);
    calls.length = 0;
    recorderArgs.length = 0;

    return names;
  }

  beforeEach(() => {
    calls.length = 0;
    recorderArgs.length = 0;
    onLaps.current = null;
    publish = vi.fn();
    bus = { publish } as unknown as IEventBus;
    logger = { ...silentLogger };
    fake = createController();
    recorder = startReplayRecorder(bus, fake.controller as unknown as ReplayRecorderController, logger);
  });

  afterEach(() => {
    recorder.stop();
    vi.useRealTimers();
  });

  describe("subscription", () => {
    it("subscribes under its own id beside the translator's", () => {
      expect(REPLAY_RECORDER_SUBSCRIPTION_ID).toBe("__sim-events-iracing-replay-recorder__");
      expect(fake.controller.subscribe).toHaveBeenCalledWith(REPLAY_RECORDER_SUBSCRIPTION_ID, expect.any(Function));
    });

    it("takes the subscribe-time `(null, false)` delivery without running a recorder", () => {
      expect(take()).toEqual([]);
    });

    it("unsubscribes on stop, once, and sees no tick after it", () => {
      recorder.stop();
      recorder.stop();

      expect(fake.controller.unsubscribe).toHaveBeenCalledTimes(1);
      expect(fake.controller.unsubscribe).toHaveBeenCalledWith(REPLAY_RECORDER_SUBSCRIPTION_ID);

      fake.deliver(tick(0));
      expect(take()).toEqual([]);
    });

    it("takes its callback back out when the subscribe-time tick throws, so none is left that nothing can stop", () => {
      const failing = createController();
      failing.controller.subscribe.mockImplementationOnce((_id: string, cb: TelemetryCallback) => {
        cb(tick(0), true);
      });
      onLaps.current = () => {
        throw new Error("bad session info");
      };

      expect(() => startReplayRecorder(bus, failing.controller as unknown as ReplayRecorderController, logger)).toThrow(
        "bad session info",
      );
      expect(failing.controller.unsubscribe).toHaveBeenCalledWith(REPLAY_RECORDER_SUBSCRIPTION_ID);
    });
  });

  describe("an ordinary tick", () => {
    it("runs the four recorders in order on one state, with no reset", () => {
      fake.deliver(tick(0));
      const state = calls[0]!.state;

      expect(calls.every((c) => c.state === state)).toBe(true);
      expect(take()).toEqual(RECORDERS);
    });

    it("reads the replay state once and hands every recorder the tick's inputs", () => {
      const info = sessionInfo(89659949);
      fake.setSessionInfo(info);
      fake.setReplay({ inReplay: true, replayOnlySession: true });
      const telemetry = tick(0);
      fake.controller.getReplayState.mockClear();

      fake.deliver(telemetry);

      expect(fake.controller.getReplayState).toHaveBeenCalledTimes(1);
      const args = Object.fromEntries(recorderArgs.map((r) => [r.name, r.args]));
      expect(args.laps).toEqual([telemetry, info, true, expect.any(Function)]);
      expect(args.greens).toEqual([telemetry, info, true, expect.any(Function), logger]);
      // The session record reads the controller's sticky saved-replay answer.
      expect(args.sessions).toEqual([telemetry, info, true, true, expect.any(Function), logger]);
      expect(args.incidents).toEqual([telemetry, info, true, expect.any(Function)]);
    });

    it("runs nothing on a connected tick without telemetry", () => {
      fake.deliver(tick(0));
      take();

      fake.deliver(null, true);

      expect(take()).toEqual([]);
    });

    it("publishes a recorder's event in the live envelope", () => {
      vi.useFakeTimers({ now: 1_700_000_000_000 });
      const telemetry = tick(0);
      onLaps.current = (_state, emit) =>
        emit({
          event: "replay.lapStarted",
          data: { carIdx: 3 } as never,
        });

      fake.deliver(telemetry);

      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith({
        event: "replay.lapStarted",
        timestamp: 1_700_000_000_000,
        telemetry,
        data: { carIdx: 3 },
      });
    });
  });

  describe("a session change (reset C)", () => {
    it("resets the baselines BEFORE the recorders on a new SessionNum", () => {
      fake.deliver(tick(0));
      const before = calls[0]!.state;
      take();

      fake.deliver(tick(1));

      expect(calls.map((c) => c.name)).toEqual(["reset", ...RECORDERS]);
      expect(calls[0]!.state).toBe(before);
      // The recorders read the reset state, not the old one.
      expect(calls[1]!.state).not.toBe(before);
      expect(calls.slice(1).every((c) => c.state === calls[1]!.state)).toBe(true);
    });

    it("resets on a new SubSessionID with the same SessionNum (#1509)", () => {
      fake.deliver(tick(0));
      take();

      fake.setSessionInfo(sessionInfo(89660575));
      fake.deliver(tick(0));

      expect(take()).toEqual(["reset", ...RECORDERS]);
    });

    it("keeps the session record across the reset", () => {
      onLaps.current = (state) => {
        state.replaySessionsPublished.push("89659949:0:1");
      };
      fake.deliver(tick(0));
      onLaps.current = null;
      take();

      fake.deliver(tick(1));

      expect(calls[1]!.state.replaySessionsPublished).toEqual(["89659949:0:1"]);
    });

    it("does not reset for a saved replay showing another session, nor on the way back", () => {
      fake.deliver(tick(0));
      take();

      fake.setSessionInfo(sessionInfo(70000000, "replay"));
      fake.deliver(tick(3));
      fake.setSessionInfo(sessionInfo(89659949));
      fake.deliver(tick(0));

      expect(take()).toEqual([...RECORDERS, ...RECORDERS]);
    });

    it("resets once, not on the next tick of the same new session", () => {
      fake.deliver(tick(0));
      fake.deliver(tick(1));
      take();

      fake.deliver(tick(1));

      expect(take()).toEqual(RECORDERS);
    });
  });

  describe("the replay view's edges (resets D and E)", () => {
    it("resets AFTER the recorders on the entry tick and on the first live tick, and only there", () => {
      fake.deliver(tick(0));
      take();

      fake.setReplay({ inReplay: true });
      fake.deliver(tick(0));
      expect(take()).toEqual([...RECORDERS, "reset"]);

      fake.deliver(tick(0));
      expect(take()).toEqual(RECORDERS);

      fake.setReplay({ inReplay: false });
      fake.deliver(tick(0));
      expect(take()).toEqual([...RECORDERS, "reset"]);

      fake.deliver(tick(0));
      expect(take()).toEqual(RECORDERS);
    });

    it("hands the next tick the state the edge reset made", () => {
      fake.deliver(tick(0));
      fake.setReplay({ inReplay: true });
      fake.deliver(tick(0));
      const reset = calls.at(-1)!;
      take();

      fake.deliver(tick(0));

      expect(reset.name).toBe("reset");
      expect(calls[0]!.state).not.toBe(reset.state);
      expect(calls.every((c) => c.state === calls[0]!.state)).toBe(true);
    });

    it("runs the session-change reset first and the edge reset last when both fall on one tick", () => {
      fake.deliver(tick(0));
      take();

      fake.setReplay({ inReplay: true });
      fake.deliver(tick(1));

      expect(take()).toEqual(["reset", ...RECORDERS, "reset"]);
    });
  });

  describe("a disconnect (reset B)", () => {
    it("starts the next tick from a fresh state, the session record included, with no reset call", () => {
      onLaps.current = (state) => {
        state.replaySessionsPublished.push("89659949:0:1");
        state.replayLapsSeeded = true;
      };
      fake.deliver(tick(0));
      onLaps.current = null;
      const before = calls[0]!.state;
      take();

      fake.deliver(null, false);
      expect(take()).toEqual([]);

      fake.deliver(tick(0));

      expect(calls.map((c) => c.name)).toEqual(RECORDERS);
      expect(calls[0]!.state).not.toBe(before);
      expect(calls[0]!.state).toEqual(createInitialReplayRecorderState());
    });

    it("forgets the session identity, so a reconnect into another session seeds rather than resets", () => {
      fake.deliver(tick(0));
      fake.deliver(null, false);
      take();

      fake.setSessionInfo(sessionInfo(89660575));
      fake.deliver(tick(2));

      expect(take()).toEqual(RECORDERS);
    });

    it("keeps the last-tick-in-replay flag, so a reconnect that lands live resets on its first tick", () => {
      fake.deliver(tick(0));
      fake.setReplay({ inReplay: true });
      fake.deliver(tick(0));
      fake.deliver(null, false);
      take();

      fake.setReplay({ inReplay: false });
      fake.deliver(tick(0));

      expect(take()).toEqual([...RECORDERS, "reset"]);
    });
  });
});
