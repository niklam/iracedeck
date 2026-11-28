import {
  CameraCommand,
  CameraFocusMode,
  type INativeSDK,
  type TelemetryCallback,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import type { CameraSwitchOptions } from "@iracedeck/replay-engine";
import { resetEngine } from "@iracedeck/replay-engine/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CAR_CYCLE_BINDING_KEYS } from "../../shared/car-cycle-bindings.js";
import { noteCameraKeyTap } from "../../shared/car-cycle-focus.js";
import {
  _resetAutoGroup,
  AUTO_GROUP_POLL_MS,
  AUTO_GROUP_SETTLE_MS,
  AUTO_GROUP_SUBSCRIBER_ID,
  autoGroupOwner,
  isAutoGroupOwner,
  onAutoGroupChange,
  stopAutoGroup,
  toggleAutoGroup,
  updateAutoGroupSettings,
} from "./auto-group.js";

/** A stand-in SDK controller: one callback per subscriber id, delivered at once on subscribe, as `SDKController` does. */
class FakeController {
  telemetry: TelemetryData | null = null;
  sessionInfo: unknown = null;
  readonly callbacks = new Map<string, TelemetryCallback>();
  readonly subscribe = vi.fn((id: string, callback: TelemetryCallback) => {
    this.callbacks.set(id, callback);
    callback(this.telemetry, this.telemetry !== null);
  });
  readonly unsubscribe = vi.fn((id: string) => {
    this.callbacks.delete(id);
  });
  readonly getCurrentTelemetry = vi.fn(() => this.telemetry);
  readonly getSessionInfo = vi.fn(() => this.sessionInfo);

  /** Sets the camera without a tick, as iRacing does between two deliveries. */
  setCamera(car: number, group: number, extra: Partial<TelemetryData> = {}): void {
    this.telemetry = { CamCarIdx: car, CamGroupNumber: group, ...extra } as TelemetryData;
  }

  /** One delivery to every subscriber. */
  tick(telemetry: TelemetryData | null = this.telemetry): void {
    this.telemetry = telemetry;

    for (const callback of [...this.callbacks.values()]) callback(telemetry, telemetry !== null);
  }

  /** Moves the camera and delivers the tick. */
  camera(car: number, group: number, extra: Partial<TelemetryData> = {}): void {
    this.setCamera(car, group, extra);
    this.tick();
  }
}

type SwitchRequest = { send: () => unknown; options: CameraSwitchOptions };

const { engine, fake, switchNum, switchPos, director } = vi.hoisted(() => {
  const state = {
    /** When false, `requestCameraSwitch` holds each request in `held` instead of sending it. */
    sendAtOnce: true,
    held: [] as SwitchRequest[],
    /** When true, `requestCameraSwitch` is the engine's real waiter (`actual`), recorded all the same. */
    real: false,
    actual: null as ((send: () => unknown, options: CameraSwitchOptions) => Promise<void>) | null,
  };

  return {
    engine: {
      state,
      requestCameraSwitch: vi.fn((send: () => unknown, options: CameraSwitchOptions): Promise<void> => {
        if (state.real && state.actual !== null) return state.actual(send, options);

        if (state.sendAtOnce) send();
        else state.held.push({ send, options });

        return Promise.resolve();
      }),
    },
    fake: {
      controller: null as unknown as FakeController,
      /** When set, `getCommands().camera` is this real `CameraCommand` rather than the stand-in. */
      realCamera: null as unknown,
    },
    switchNum: vi.fn((_carNumberRaw: number, _group: number, _camera: number) => true),
    switchPos: vi.fn((_position: number, _group: number, _camera: number) => true),
    /** What the stand-in's `focusModeInEffect` reads (#1656). */
    director: { focus: null as number | null },
  };
});

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getController: () => fake.controller,
  getCommands: () => ({
    camera: fake.realCamera ?? {
      switchNum,
      switchPos,
      focusModeInEffect: () => director.focus,
      forgetFocusMode: () => {
        director.focus = null;
      },
    },
  }),
}));

vi.mock("@iracedeck/replay-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/replay-engine")>();

  engine.state.actual = actual.requestCameraSwitch;

  return { ...actual, requestCameraSwitch: engine.requestCameraSwitch };
});

/** The track's camera groups, numbered as the sim numbers them. */
const GROUPS = ["Nose", "Cockpit", "TV1", "TV2", "TV3", "Chase"];
const G = Object.fromEntries(GROUPS.map((name, i) => [name, i + 1])) as Record<string, number>;

/** Every car's `CarNumberRaw` is 100 + its index; car 9 has none. */
function sessionInfo(groups: readonly string[] = GROUPS): unknown {
  return {
    CameraInfo: { Groups: groups.map((GroupName) => ({ GroupNum: G[GroupName] ?? 99, GroupName })) },
    DriverInfo: {
      Drivers: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((CarIdx) => ({
        CarIdx,
        CarNumber: String(100 + CarIdx),
        CarNumberRaw: 100 + CarIdx,
      })),
    },
  };
}

function spyLogger(): ILogger {
  const logger: ILogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return logger;
}

const TVS = ["TV1", "TV2", "TV3"];
let logger: ILogger;
let unsubscribers: Array<() => void>;

function start(owner = "key-a", names: readonly string[] = TVS, pick: "in-order" | "random" = "in-order") {
  return toggleAutoGroup({ owner, names, pick, logger });
}

/** Moves the camera to `car` and lets the settle timer run out. */
function landOn(car: number, group = fake.controller.telemetry?.CamGroupNumber ?? G.Nose): void {
  fake.controller.camera(car, group);
  vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);
}

/** The groups switched to so far, by name. */
function switchedGroups(): string[] {
  return switchNum.mock.calls.map(([, group]) => GROUPS[group - 1]);
}

/** Has the sim apply each switch the run sent, as iRacing does on the next tick. */
function applySwitches(): void {
  switchNum.mockImplementation((_car, group) => {
    const car = fake.controller.telemetry?.CamCarIdx ?? 0;

    fake.controller.setCamera(car, group);

    return true;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  switchNum.mockImplementation(() => true);
  switchPos.mockImplementation(() => true);
  director.focus = null;
  fake.realCamera = null;
  fake.controller = new FakeController();
  fake.controller.sessionInfo = sessionInfo();
  fake.controller.setCamera(1, G.Nose);
  engine.state.sendAtOnce = true;
  engine.state.held = [];
  engine.state.real = false;
  logger = spyLogger();
  unsubscribers = [];
  _resetAutoGroup();
});

afterEach(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();

  _resetAutoGroup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("auto group triggers", () => {
  it("records the car on start and sends nothing", () => {
    expect(start()).toBe("started");
    expect(fake.controller.subscribe).toHaveBeenCalledWith(AUTO_GROUP_SUBSCRIBER_ID, expect.any(Function));

    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 10);
    fake.controller.tick();
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 10);

    expect(engine.requestCameraSwitch).not.toHaveBeenCalled();
    expect(switchNum).not.toHaveBeenCalled();
  });

  it("sends one switch 250 ms after a car change, keeping the car", () => {
    start();
    fake.controller.camera(4, G.Nose);

    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS - 1);
    expect(switchNum).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(switchNum).toHaveBeenCalledTimes(1);
    expect(switchNum).toHaveBeenCalledWith(104, G.TV1, 0);
  });

  it("builds the switch from the camera as it is when it goes out", () => {
    start();
    fake.controller.camera(4, G.Nose);
    // The group changes between two deliveries: the send reads it fresh.
    fake.controller.setCamera(4, G.TV1);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);

    expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV2, 0);
  });

  describe("a car change no tick delivers (a paused replay's frozen tick)", () => {
    it("is seen by the fresh read, and the switch goes out once after the settle time", () => {
      start();
      // iRacing moves the camera under a frozen tick: no delivery.
      fake.controller.setCamera(4, G.Nose);

      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS);
      expect(switchNum).not.toHaveBeenCalled();

      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS - 1);
      expect(switchNum).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);

      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS * 20);
      expect(switchNum).toHaveBeenCalledTimes(1);
    });

    it("keeps the car the start saw as the baseline: the first fresh read of it is no change", () => {
      start();
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS * 10);

      expect(fake.controller.getCurrentTelemetry).toHaveBeenCalled();
      expect(engine.requestCameraSwitch).not.toHaveBeenCalled();
    });

    it("arms once when a tick sees the change first and the fresh read sees it again", () => {
      start();
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS - 50);
      // The tick lands 50 ms before the next fresh read.
      fake.controller.camera(4, G.Nose);

      // Re-armed by the read, it would go out 50 ms later than this.
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);
      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);

      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS * 20);
      expect(switchNum).toHaveBeenCalledTimes(1);
    });

    it("arms once when the fresh read sees the change first and a tick then delivers it", () => {
      start();
      fake.controller.setCamera(4, G.Nose);
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS);
      vi.advanceTimersByTime(100);
      // The delivery of the same car 100 ms on is no new change.
      fake.controller.tick();

      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS - 100);
      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);

      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS * 20);
      expect(switchNum).toHaveBeenCalledTimes(1);
    });

    it("carries on through a replace, recording the car anew for the new owner", () => {
      start("key-a");
      start("key-b");

      // The first read after the replace records the car the camera is on.
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS);
      expect(engine.requestCameraSwitch).not.toHaveBeenCalled();

      fake.controller.setCamera(4, G.Nose);
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS + AUTO_GROUP_SETTLE_MS);

      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
    });

    it("changes nothing when the fresh read throws, and carries on", () => {
      start();
      fake.controller.getCurrentTelemetry.mockImplementationOnce(() => {
        throw new Error("read failed");
      });
      fake.controller.setCamera(4, G.Nose);

      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS);
      expect(autoGroupOwner()).toBe("key-a");

      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS + AUTO_GROUP_SETTLE_MS);
      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
    });

    it.each([
      ["a stop", () => stopAutoGroup()],
      ["a plugin-start reset", () => _resetAutoGroup()],
    ])("is read no more after %s", (_label, end) => {
      start();
      expect(vi.getTimerCount()).toBe(1);

      end();
      expect(vi.getTimerCount()).toBe(0);

      fake.controller.getCurrentTelemetry.mockClear();
      fake.controller.setCamera(4, G.Nose);
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS * 20);

      expect(fake.controller.getCurrentTelemetry).not.toHaveBeenCalled();
      expect(engine.requestCameraSwitch).not.toHaveBeenCalled();
    });

    it("leaves one interval when started again after a stop", () => {
      start();
      stopAutoGroup();
      start();

      expect(vi.getTimerCount()).toBe(1);
    });

    it("starts no interval when the subscription throws", () => {
      fake.controller.subscribe.mockImplementationOnce(() => {
        throw new Error("no SDK");
      });

      expect(() => start()).toThrow("no SDK");
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("goes through the replay engine's camera-switch waiter as a yielding switch of the angle only", () => {
    start();
    landOn(4);

    expect(engine.requestCameraSwitch).toHaveBeenCalledTimes(1);

    const options = engine.requestCameraSwitch.mock.calls[0][1];

    // The waiter keeps the "a user's switch comes first" rule for a yielding switch (decision 4).
    expect(options).toMatchObject({
      yields: true,
      interruptsWalks: false,
      label: "Camera controls",
      name: "auto group",
      logger,
    });
    expect(options.stillValid()).toBe(true);
  });

  it("says how long ago the latest car change was, so a user's switch since then drops it (second read)", () => {
    start();
    fake.controller.camera(4, G.Nose);
    vi.advanceTimersByTime(100);
    // The car moves again inside the window: the trigger is this change, not the first.
    fake.controller.camera(5, G.Nose);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);

    expect(engine.requestCameraSwitch).toHaveBeenCalledTimes(1);
    expect(engine.requestCameraSwitch.mock.calls[0][1].triggeredMsAgo).toBe(AUTO_GROUP_SETTLE_MS);
    // A tick sees the change within a frame: dated at the tick, the earliest it can have been too.
    expect(engine.requestCameraSwitch.mock.calls[0][1].earliestTriggerMsAgo).toBe(AUTO_GROUP_SETTLE_MS);
  });

  it("dates a change the fresh read noticed from the read before it that still showed the old car", () => {
    start();
    // The read at 200 still shows car 1.
    vi.advanceTimersByTime(AUTO_GROUP_POLL_MS);
    vi.advanceTimersByTime(20);
    // iRacing moves the camera under a frozen tick; the read at 400 sees it.
    fake.controller.setCamera(4, G.Nose);
    vi.advanceTimersByTime(AUTO_GROUP_POLL_MS - 20 + AUTO_GROUP_SETTLE_MS);

    expect(engine.requestCameraSwitch).toHaveBeenCalledTimes(1);

    const options = engine.requestCameraSwitch.mock.calls[0][1];

    expect(options.triggeredMsAgo).toBe(AUTO_GROUP_SETTLE_MS);
    expect(options.earliestTriggerMsAgo).toBe(AUTO_GROUP_POLL_MS + AUTO_GROUP_SETTLE_MS);
  });

  it("keeps the earlier bound on the last read that showed a car: a read with no car moves neither time", () => {
    start();
    vi.advanceTimersByTime(AUTO_GROUP_POLL_MS);
    // iRacing gone for one read: it shows nothing, so the read at 200 stays the last that showed car 1.
    fake.controller.telemetry = null;
    vi.advanceTimersByTime(AUTO_GROUP_POLL_MS);
    fake.controller.setCamera(4, G.Nose);
    vi.advanceTimersByTime(AUTO_GROUP_POLL_MS + AUTO_GROUP_SETTLE_MS);

    const options = engine.requestCameraSwitch.mock.calls[0][1];

    expect(options.triggeredMsAgo).toBe(AUTO_GROUP_SETTLE_MS);
    expect(options.earliestTriggerMsAgo).toBe(2 * AUTO_GROUP_POLL_MS + AUTO_GROUP_SETTLE_MS);
  });

  it("dates the change the send-time read finds from the read before it", () => {
    engine.state.sendAtOnce = false;
    start();
    landOn(4);

    // A tick on car 4, then the camera reaches car 5 unseen; the send-time read finds it 30 ms on.
    fake.controller.tick();
    vi.advanceTimersByTime(30);
    fake.controller.setCamera(5, G.Nose);
    engine.state.held[0].send();
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);

    const options = engine.state.held[1].options;

    expect(options.triggeredMsAgo).toBe(AUTO_GROUP_SETTLE_MS);
    expect(options.earliestTriggerMsAgo).toBe(AUTO_GROUP_SETTLE_MS + 30);
  });

  describe("a user's switch around a car change, against the engine's real waiter", () => {
    beforeEach(() => {
      engine.state.real = true;
      resetEngine({ now: () => Date.now(), inReplay: () => true });
    });

    afterEach(() => {
      resetEngine();
    });

    /** A user's switch through the real waiter: of the angle only (Cycle Camera), or of the car (Next Car). */
    function userSwitch(kind: "angle" | "car", send: () => unknown = () => {}): void {
      void engine.requestCameraSwitch(send, {
        by: kind === "angle" ? "camera-controls cycle-camera" : "camera-controls cycle-track-order",
        interruptsWalks: kind === "angle" ? false : undefined,
        label: "Camera controls",
        name: kind === "angle" ? "next camera" : "next car",
        asked: "key",
        surface: "the key",
        stillValid: () => true,
        logger,
      });
    }

    /**
     * CodeRabbit's timeline on a paused replay, from the read at 200 that
     * still shows car 1: the camera moves to car 4 at +20 (no tick), the
     * user's switch goes out at +100, and the read at 400 sees car 4.
     */
    function pausedReplayTimeline(kind: "angle" | "car"): void {
      start();
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS);

      if (kind === "angle") {
        vi.advanceTimersByTime(20);
        fake.controller.setCamera(4, G.Nose);
        vi.advanceTimersByTime(80);
        userSwitch("angle");
      } else {
        vi.advanceTimersByTime(100);
        // The user's Next Car is what moves the camera, still with no tick.
        userSwitch("car", () => fake.controller.setCamera(4, G.Nose));
      }

      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS - 100);
      // The read at 400 saw car 4; the settle time runs from there.
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);
    }

    it("drops the automatic switch when the user picked an angle after the car changed but before the read saw it", () => {
      pausedReplayTimeline("angle");

      expect(engine.requestCameraSwitch).toHaveBeenCalledTimes(2);
      expect(switchNum).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        "Camera controls: automatic switch dropped (auto group), the next camera switch, of the angle only, went out when what asked for it may already have happened",
      );
    });

    it("still switches the group for a car change the user's own Next Car made in that window", () => {
      pausedReplayTimeline("car");

      expect(engine.requestCameraSwitch).toHaveBeenCalledTimes(2);
      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
    });

    it("counts no angle pick from before the last read that showed the old car", () => {
      start();
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS - 50);
      // The user's pick at 150, then the read at 200 still on car 1.
      userSwitch("angle");
      vi.advanceTimersByTime(50 + 20);
      fake.controller.setCamera(4, G.Nose);
      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS - 20 + AUTO_GROUP_SETTLE_MS);

      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
    });

    it("dates a tick-delivered change at the tick, so an angle pick a frame before it does not drop the switch", () => {
      start();
      vi.advanceTimersByTime(50);
      userSwitch("angle");
      vi.advanceTimersByTime(16);
      // iRacing's own move, delivered by the next tick.
      fake.controller.camera(4, G.Nose);
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);

      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
    });

    it("switches the group for a change the user's Next Car made that the next tick delivered", () => {
      start();
      vi.advanceTimersByTime(50);
      userSwitch("car", () => fake.controller.setCamera(4, G.Nose));
      vi.advanceTimersByTime(16);
      fake.controller.tick();
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);

      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
    });

    it("drops it for any user's switch after a tick-delivered change, as before", () => {
      start();
      fake.controller.camera(4, G.Nose);
      vi.advanceTimersByTime(100);
      userSwitch("car");
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS - 100);

      expect(switchNum).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        "Camera controls: automatic switch dropped (auto group), the next car switch went out after what asked for it",
      );
    });
  });

  it("measures the age when the timer fires, rather than taking the settle time", () => {
    start();
    fake.controller.camera(4, G.Nose);
    // The clock runs on while the timer is late to fire.
    vi.setSystemTime(Date.now() + 40);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);

    expect(engine.requestCameraSwitch.mock.calls[0][1].triggeredMsAgo).toBe(AUTO_GROUP_SETTLE_MS + 40);
  });

  it("asks once per settled change, however long the switch then waits in the engine", () => {
    engine.state.sendAtOnce = false;
    start();
    landOn(4);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 40);

    expect(engine.requestCameraSwitch).toHaveBeenCalledTimes(1);
    expect(engine.state.held).toHaveLength(1);
  });

  it("sends one switch for a burst of changes inside the window, for the car it lands on", () => {
    start();

    for (const car of [2, 3, 4, 5, 6]) {
      fake.controller.camera(car, G.Nose);
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS - 50);
    }

    expect(switchNum).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(switchNum).toHaveBeenCalledExactlyOnceWith(106, G.TV1, 0);

    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 10);
    expect(switchNum).toHaveBeenCalledTimes(1);
  });

  it("never triggers itself: the switch it sent keeps the car", () => {
    applySwitches();
    start();
    landOn(4);

    expect(fake.controller.telemetry).toMatchObject({ CamCarIdx: 4, CamGroupNumber: G.TV1 });

    for (let i = 0; i < 5; i++) {
      fake.controller.tick();
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);
    }

    expect(switchNum).toHaveBeenCalledTimes(1);
  });

  it("does not trigger on a change of group alone", () => {
    start();
    fake.controller.camera(1, G.Chase);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 4);

    expect(switchNum).not.toHaveBeenCalled();
  });

  it.each([
    ["a key or the sim, live", {}],
    ["a car change in a replay", { IsReplayPlaying: true }],
    ["the replay paused", { IsReplayPlaying: false, ReplayFrameNum: 1200 }],
  ] as Array<[string, Partial<TelemetryData>]>)("follows a car change from any source: %s", (_label, extra) => {
    start();
    fake.controller.camera(5, G.Nose, extra);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);

    expect(switchNum).toHaveBeenCalledExactlyOnceWith(105, G.TV1, 0);
  });

  it("ignores a tick with no camera car", () => {
    start();
    fake.controller.tick({ CamGroupNumber: G.Nose } as TelemetryData);
    fake.controller.tick({ CamCarIdx: -1, CamGroupNumber: G.Nose } as TelemetryData);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 4);

    expect(switchNum).not.toHaveBeenCalled();
  });

  it("records the first car seen when it starts with iRacing gone", () => {
    fake.controller.telemetry = null;
    start();
    fake.controller.camera(3, G.Nose);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 4);

    expect(switchNum).not.toHaveBeenCalled();

    landOn(4);
    expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
  });

  describe("iRacing disconnected", () => {
    it("does nothing on a tick with no telemetry, and keeps the car it saw", () => {
      start();
      fake.controller.tick(null);
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 4);
      // Back on the same car: no change.
      fake.controller.camera(1, G.Nose);
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 4);

      expect(switchNum).not.toHaveBeenCalled();
      expect(autoGroupOwner()).toBe("key-a");
    });

    it("carries on after the reconnect", () => {
      start();
      fake.controller.tick(null);
      landOn(7);

      expect(switchNum).toHaveBeenCalledExactlyOnceWith(107, G.TV1, 0);
    });
  });
});

describe("auto group picking", () => {
  it("steps through the list in order across car changes, wrapping", () => {
    applySwitches();
    start();

    for (const car of [2, 3, 4, 5, 6]) landOn(car);

    expect(switchedGroups()).toEqual(["TV1", "TV2", "TV3", "TV1", "TV2"]);
  });

  it("keeps its place in order when a switch fails: the next car change offers the same group again", () => {
    start();
    switchNum.mockImplementationOnce(() => false);
    landOn(2);
    landOn(3);
    landOn(4);

    expect(switchedGroups()).toEqual(["TV1", "TV1", "TV2"]);
    expect(logger.info).toHaveBeenCalledWith("Automatic camera group switch failed");
  });

  it("keeps its place in order when a switch throws", () => {
    engine.state.sendAtOnce = false;
    start();
    switchNum.mockImplementationOnce(() => {
      throw new Error("broadcast failed");
    });
    landOn(2);

    // The waiter catches and logs the throw; here the held send is called by hand.
    expect(() => engine.state.held[0].send()).toThrow("broadcast failed");

    landOn(3);
    engine.state.held[1].send();

    expect(switchedGroups()).toEqual(["TV1", "TV1"]);
  });

  it("never repeats the camera's group in order: one step further when the camera is in the next", () => {
    start();
    landOn(2, G.TV1);

    expect(switchedGroups()).toEqual(["TV2"]);
  });

  it("skips names the track lacks", () => {
    applySwitches();
    fake.controller.sessionInfo = sessionInfo(["Nose", "Cockpit", "TV1", "TV3", "Chase"]);
    start();

    for (const car of [2, 3, 4]) landOn(car);

    expect(switchedGroups()).toEqual(["TV1", "TV3", "TV1"]);
  });

  it("picks at random from the groups the camera is not in", () => {
    applySwitches();
    const random = vi.spyOn(Math, "random");

    start("key-a", TVS, "random");
    random.mockReturnValue(0.99);
    landOn(2);
    // In TV3 now: the others are TV1 and TV2.
    random.mockReturnValue(0.99);
    landOn(3);
    random.mockReturnValue(0);
    landOn(4);

    expect(switchedGroups()).toEqual(["TV3", "TV2", "TV1"]);
  });

  it("never picks the camera's group at random", () => {
    applySwitches();
    start("key-a", TVS, "random");

    for (let car = 0; car < 9; car++) {
      const before = fake.controller.telemetry?.CamGroupNumber;

      landOn(car === fake.controller.telemetry?.CamCarIdx ? car + 1 : car);

      const after = switchNum.mock.lastCall?.[1];

      if (after !== undefined) expect(after).not.toBe(before);
    }

    expect(switchNum.mock.calls.length).toBeGreaterThan(0);
  });

  it("switches to the one candidate when the camera is elsewhere, and sends nothing when it is in it", () => {
    start("key-a", ["TV2"]);
    landOn(2, G.Nose);
    expect(switchedGroups()).toEqual(["TV2"]);

    landOn(3, G.TV2);
    expect(switchedGroups()).toEqual(["TV2"]);
  });

  it("asks for no switch when the session has none of the list", () => {
    start("key-a", ["Blimp", "Gyro"]);
    landOn(2);

    expect(engine.requestCameraSwitch).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Blimp, Gyro"));
  });

  it("asks for no switch with an empty list", () => {
    start("key-a", []);
    landOn(2);

    expect(engine.requestCameraSwitch).not.toHaveBeenCalled();
  });

  it("asks for no switch with no session's camera groups", () => {
    fake.controller.sessionInfo = null;
    start();
    landOn(2);

    expect(engine.requestCameraSwitch).not.toHaveBeenCalled();
  });

  it("sends nothing for a car with no car number", () => {
    start();
    landOn(9);

    expect(engine.requestCameraSwitch).toHaveBeenCalledTimes(1);
    expect(switchNum).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Auto group switch skipped: the camera's car has no car number");
  });

  it("works out the candidates again when the switch goes out", () => {
    engine.state.sendAtOnce = false;
    start();
    landOn(2);

    expect(engine.state.held).toHaveLength(1);

    // A new session info while the switch waited behind a jump, without TV1.
    fake.controller.sessionInfo = sessionInfo(["Nose", "TV2", "TV3"]);
    engine.state.held[0].send();

    expect(switchedGroups()).toEqual(["TV2"]);
  });
});

describe("auto group under iRacing's director focus (#1656)", () => {
  const { FocusAtIncident, FocusAtLeader, FocusAtExiting } = CameraFocusMode;

  it.each([
    ["Most Exciting", FocusAtExiting],
    ["Leader", FocusAtLeader],
    ["Incident", FocusAtIncident],
  ])("with Focus on %s in effect, changes only the group: switchPos(<focus>, group, 0)", (_name, focus) => {
    director.focus = focus;
    start();
    landOn(4);

    expect(switchPos).toHaveBeenCalledExactlyOnceWith(focus, G.TV1, 0);
    expect(switchNum).not.toHaveBeenCalled();
  });

  it("with no focus in effect, keeps the car: switchNum(<car number>, group, 0)", () => {
    start();
    landOn(4);

    expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
    expect(switchPos).not.toHaveBeenCalled();
  });

  it("reads the focus when the switch goes out, not when the timer fired", () => {
    engine.state.sendAtOnce = false;
    start();
    landOn(4);

    expect(engine.state.held).toHaveLength(1);

    // Focus on Most Exciting goes out while the switch waits behind a jump.
    director.focus = FocusAtExiting;
    engine.state.held[0].send();

    expect(switchPos).toHaveBeenCalledExactlyOnceWith(FocusAtExiting, G.TV1, 0);
    expect(switchNum).not.toHaveBeenCalled();
  });

  it("needs no car number under a focus: a car without one still gets its group", () => {
    director.focus = FocusAtExiting;
    start();
    landOn(9);

    expect(switchPos).toHaveBeenCalledExactlyOnceWith(FocusAtExiting, G.TV1, 0);
    expect(logger.info).not.toHaveBeenCalledWith("Auto group switch skipped: the camera's car has no car number");
  });

  it("picks In order as before, moving on after each switch that went out", () => {
    director.focus = FocusAtExiting;
    start();
    landOn(4);
    landOn(5);
    landOn(6);

    expect(switchPos.mock.calls.map(([, group]) => GROUPS[group - 1])).toEqual(["TV1", "TV2", "TV3"]);
  });

  it("leaves the place in the list when the focus switch failed", () => {
    director.focus = FocusAtExiting;
    switchPos.mockImplementationOnce(() => false);
    start();
    landOn(4);
    landOn(5);

    expect(switchPos.mock.calls.map(([, group]) => GROUPS[group - 1])).toEqual(["TV1", "TV1"]);
    expect(logger.info).toHaveBeenCalledWith("Automatic camera group switch failed");
  });

  it("says at debug which form went out", () => {
    director.focus = FocusAtExiting;
    start();
    landOn(4);

    expect(logger.info).toHaveBeenCalledWith("Camera group switched automatically");
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("switchPos(FocusAtExiting), keeping the director focus"),
    );

    director.focus = null;
    landOn(5);

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("switchNum(carNumberRaw 105), keeping the car"));
  });

  describe("over the SDK's real CameraCommand", () => {
    let camera: CameraCommand;

    beforeEach(() => {
      const native: INativeSDK = {
        startup: vi.fn(),
        shutdown: vi.fn(),
        isConnected: vi.fn(),
        getHeader: vi.fn(),
        getData: vi.fn(),
        waitForData: vi.fn(),
        getSessionInfoStr: vi.fn(),
        getVarHeaderEntry: vi.fn(),
        varNameToIndex: vi.fn(),
        broadcastMsg: vi.fn(),
        sendChatMessage: vi.fn(),
      };

      camera = new CameraCommand(native);
      fake.realCamera = camera;
      vi.spyOn(camera, "switchPos");
      vi.spyOn(camera, "switchNum");
    });

    /** Every `switchPos` / `switchNum` since the last clear, `switchPos` first. */
    function sends(): Array<[string, number, number, number]> {
      return [
        ...vi.mocked(camera.switchPos).mock.calls.map(([target, group, cam]): [string, number, number, number] => [
          "switchPos",
          target,
          group,
          cam,
        ]),
        ...vi.mocked(camera.switchNum).mock.calls.map(([target, group, cam]): [string, number, number, number] => [
          "switchNum",
          target,
          group,
          cam,
        ]),
      ];
    }

    function clearSends(): void {
      vi.mocked(camera.switchPos).mockClear();
      vi.mocked(camera.switchNum).mockClear();
    }

    it("after a Focus on Most Exciting press, every group switch is a switchPos, and the focus stays", () => {
      camera.focusOnMostExciting(G.Nose, 0);
      clearSends();
      start();
      landOn(4);
      landOn(5);

      expect(sends()).toEqual([
        ["switchPos", FocusAtExiting, G.TV1, 0],
        ["switchPos", FocusAtExiting, G.TV2, 0],
      ]);
      expect(camera.focusModeInEffect()).toBe(FocusAtExiting);
    });

    it("a switch to a car in between ends it: the next group switch keeps the car", () => {
      camera.focusOnMostExciting(G.Nose, 0);
      start();
      landOn(4);

      // The user picks car 6 (Focus Your Car, Switch by Car Number, Race Admin, ...).
      camera.switchNum(106, G.TV1, 0);
      clearSends();
      landOn(6, G.TV1);

      expect(sends()).toEqual([["switchNum", 106, G.TV2, 0]]);
    });

    it("a Cycle Camera in between ends it too: it targets the camera's car", () => {
      camera.focusOnLeader(G.Nose, 0);
      start();
      camera.cycleCamera(4, G.Nose, 1);
      clearSends();
      landOn(4);

      expect(sends()).toEqual([["switchNum", 104, G.TV1, 0]]);
    });

    it("a Next / Previous Car key tap in between ends it", () => {
      camera.focusOnIncident(G.Nose, 0);
      start();
      noteCameraKeyTap(CAR_CYCLE_BINDING_KEYS.next);
      clearSends();
      landOn(4);

      expect(sends()).toEqual([["switchNum", 104, G.TV1, 0]]);
    });

    it("a fresh CameraCommand (a plugin start) has none: the group switch keeps the car", () => {
      start();
      landOn(4);

      expect(sends()).toEqual([["switchNum", 104, G.TV1, 0]]);
    });
  });
});

describe("auto group ownership", () => {
  it("is off at plugin start", () => {
    start();
    _resetAutoGroup();

    expect(autoGroupOwner()).toBeNull();
    expect(isAutoGroupOwner("key-a")).toBe(false);

    landOn(4);
    expect(switchNum).not.toHaveBeenCalled();
  });

  it("starts with the pressing context as owner, and only that context reads as on", () => {
    start("key-a");

    expect(autoGroupOwner()).toBe("key-a");
    expect(isAutoGroupOwner("key-a")).toBe(true);
    expect(isAutoGroupOwner("key-b")).toBe(false);
    expect(isAutoGroupOwner("dial-c")).toBe(false);
  });

  it("stops on a press of the active owner: no subscription, no timer, no send", () => {
    start("key-a");
    fake.controller.camera(4, G.Nose);

    expect(start("key-a")).toBe("stopped");
    expect(autoGroupOwner()).toBeNull();
    expect(fake.controller.unsubscribe).toHaveBeenCalledWith(AUTO_GROUP_SUBSCRIBER_ID);
    expect(fake.controller.callbacks.has(AUTO_GROUP_SUBSCRIBER_ID)).toBe(false);

    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 4);
    expect(engine.requestCameraSwitch).not.toHaveBeenCalled();
  });

  it("stopAutoGroup stops it, and does nothing when it is off", () => {
    start("key-a");
    stopAutoGroup();
    stopAutoGroup();

    expect(autoGroupOwner()).toBeNull();
    expect(fake.controller.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("is replaced by a press on another key or dial, which takes over with its own list", () => {
    applySwitches();
    start("key-a", ["TV1", "TV2"]);
    landOn(2);

    expect(start("dial-b", ["Chase", "Cockpit"])).toBe("replaced");
    expect(autoGroupOwner()).toBe("dial-b");
    expect(isAutoGroupOwner("key-a")).toBe(false);
    // The subscription carries on.
    expect(fake.controller.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.controller.unsubscribe).not.toHaveBeenCalled();

    // The first tick after the replace records the car, even a new one.
    fake.controller.camera(5, G.TV1);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 4);
    expect(switchedGroups()).toEqual(["TV1"]);

    landOn(6);
    expect(switchedGroups()).toEqual(["TV1", "Cockpit"]);
  });

  it("drops the timer of the run it replaced", () => {
    start("key-a");
    fake.controller.camera(4, G.Nose);
    start("key-b");
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS * 4);

    expect(engine.requestCameraSwitch).not.toHaveBeenCalled();
  });

  it("a second press on the replaced key takes it back rather than stopping it", () => {
    start("key-a");
    start("key-b");

    expect(start("key-a")).toBe("replaced");
    expect(autoGroupOwner()).toBe("key-a");
  });

  it.each([
    ["stopped", () => stopAutoGroup()],
    ["replaced", () => start("key-b")],
  ])("drops a switch waiting behind a jump once the run is %s", (_label, change) => {
    engine.state.sendAtOnce = false;
    start("key-a");
    landOn(4);

    const { options } = engine.state.held[0];

    expect(options.stillValid()).toBe(true);

    change();
    expect(options.stillValid()).toBe(false);

    // Even sent anyway, it sends nothing.
    engine.state.held[0].send();
    expect(switchNum).not.toHaveBeenCalled();
  });

  describe("a switch waiting behind a hold answers its own car change only", () => {
    /** Ends the hold on request `index` as the engine's waiter does: asks `stillValid()`, then sends or drops. */
    function endHold(index: number): void {
      const { send, options } = engine.state.held[index];

      if (options.stillValid()) send();
    }

    it("is dropped when a newer car change arrives before it goes out, and that car gets one switch from its own timer", () => {
      engine.state.sendAtOnce = false;
      applySwitches();
      start("key-a");
      // Car 4 settled: its switch waits behind a replay hold.
      landOn(4);
      expect(engine.state.held).toHaveLength(1);

      // The camera moves to car 5 natively, arming car 5's own timer.
      fake.controller.camera(5, G.Nose);
      vi.advanceTimersByTime(50);

      // The hold ends inside car 5's window: car 4's request no longer answers.
      expect(engine.state.held[0].options.stillValid()).toBe(false);
      endHold(0);
      expect(switchNum).not.toHaveBeenCalled();

      // Even sent anyway, it sends nothing.
      engine.state.held[0].send();
      expect(switchNum).not.toHaveBeenCalled();

      // Car 5's timer runs out: its own request, sent once.
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS - 50);
      expect(engine.state.held).toHaveLength(2);
      endHold(1);

      expect(switchNum).toHaveBeenCalledExactlyOnceWith(105, G.TV1, 0);
    });

    it("sends nothing when the camera is on another car no read has reported yet, and that car gets its own settle time", () => {
      engine.state.sendAtOnce = false;
      start("key-a");
      landOn(4);
      expect(engine.state.held).toHaveLength(1);

      // The camera reaches car 5 behind the jump, before any tick or fresh read sees it.
      fake.controller.setCamera(5, G.Nose);
      expect(engine.state.held[0].options.stillValid()).toBe(true);

      endHold(0);
      expect(switchNum).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        "Auto group: the camera moved from car 4 to 5 before the switch went out, nothing sent",
      );

      // Car 5 settles for the whole settle time from that read, then gets one switch.
      vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS - 1);
      expect(engine.state.held).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(engine.state.held).toHaveLength(2);
      expect(engine.state.held[1].options.triggeredMsAgo).toBe(AUTO_GROUP_SETTLE_MS);
      endHold(1);

      expect(switchNum).toHaveBeenCalledExactlyOnceWith(105, G.TV1, 0);

      vi.advanceTimersByTime(AUTO_GROUP_POLL_MS * 20);
      expect(engine.state.held).toHaveLength(2);
    });

    it("is dropped by a car change back to the car it was asked for", () => {
      engine.state.sendAtOnce = false;
      start("key-a");
      landOn(4);
      fake.controller.camera(5, G.Nose);
      fake.controller.camera(4, G.Nose);

      expect(engine.state.held[0].options.stillValid()).toBe(false);
    });

    it("still goes out when the hold ends with the trigger unchanged", () => {
      engine.state.sendAtOnce = false;
      start("key-a");
      landOn(4);

      // Ticks on the same car while it waits are no new trigger.
      for (let i = 0; i < 5; i++) {
        fake.controller.tick();
        vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);
      }

      endHold(0);

      expect(engine.state.held).toHaveLength(1);
      expect(switchNum).toHaveBeenCalledExactlyOnceWith(104, G.TV1, 0);
    });
  });

  it("tells the listeners every start, replace and stop", () => {
    const heard: Array<string | null> = [];

    unsubscribers.push(onAutoGroupChange((owner) => heard.push(owner)));
    start("key-a");
    start("dial-b");
    start("dial-b");

    expect(heard).toEqual(["key-a", "dial-b", null]);
  });

  it("keeps telling the other listeners when one throws", () => {
    const heard: Array<string | null> = [];

    unsubscribers.push(
      onAutoGroupChange(() => {
        throw new Error("boom");
      }),
    );
    unsubscribers.push(onAutoGroupChange((owner) => heard.push(owner)));
    start("key-a");

    expect(heard).toEqual(["key-a"]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("stops telling a listener that unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = onAutoGroupChange(listener);

    start("key-a");
    unsubscribe();
    stopAutoGroup();

    expect(listener).toHaveBeenCalledExactlyOnceWith("key-a");
  });

  it("tells nobody on a plugin-start reset", () => {
    const listener = vi.fn();

    start("key-a");
    unsubscribers.push(onAutoGroupChange(listener));
    _resetAutoGroup();

    expect(listener).not.toHaveBeenCalled();
  });

  it("leaves nothing running when the subscription throws", () => {
    fake.controller.subscribe.mockImplementationOnce(() => {
      throw new Error("no SDK");
    });

    expect(() => start("key-a")).toThrow("no SDK");
    expect(autoGroupOwner()).toBeNull();
  });

  describe("the owner's settings edits (plan decision 5)", () => {
    it("apply to the running automation, keeping its place in the list", () => {
      applySwitches();
      start("key-a", ["TV1", "TV2", "TV3"]);
      landOn(2);

      expect(updateAutoGroupSettings("key-a", ["Cockpit", "TV1", "TV2"], "in-order")).toBe(true);
      landOn(3);

      // After TV1 comes TV2 in the new list too.
      expect(switchedGroups()).toEqual(["TV1", "TV2"]);
    });

    it("log an applied edit at info without its values, and the values at debug", () => {
      start("key-a", ["TV1"]);
      updateAutoGroupSettings("key-a", ["Cockpit", "TV2"], "random");

      expect(logger.info).toHaveBeenCalledWith("Auto group settings updated");
      expect(logger.debug).toHaveBeenCalledWith("Auto group settings updated: pick random, groups: Cockpit, TV2");
    });

    it("log nothing for an edit they ignore", () => {
      start("key-a", ["TV1"]);
      vi.mocked(logger.info).mockClear();
      updateAutoGroupSettings("key-b", ["Chase"], "random");

      expect(logger.info).not.toHaveBeenCalled();
    });

    it("switch the pick order", () => {
      applySwitches();
      // A draw at the top of the range: in order would take TV2 after TV1,
      // so only the random pick reaches TV3.
      vi.spyOn(Math, "random").mockReturnValue(0.99);
      start("key-a", ["TV1", "TV2", "TV3"]);
      landOn(2);
      updateAutoGroupSettings("key-a", ["TV1", "TV2", "TV3"], "random");
      landOn(3);

      // Random from TV1: the others are TV2 and TV3, and 0.99 draws TV3.
      expect(switchedGroups()).toEqual(["TV1", "TV3"]);
    });

    it("are ignored from any other context, and with nothing running", () => {
      start("key-a", ["TV1"]);

      expect(updateAutoGroupSettings("key-b", ["Chase"], "random")).toBe(false);
      landOn(2);
      expect(switchedGroups()).toEqual(["TV1"]);

      stopAutoGroup();
      expect(updateAutoGroupSettings("key-a", ["Chase"], "random")).toBe(false);
    });
  });
});
