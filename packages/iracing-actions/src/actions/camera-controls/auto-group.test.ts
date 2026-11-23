import type { TelemetryCallback, TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import type { CameraSwitchOptions } from "@iracedeck/replay-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAutoGroup,
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

const { engine, fake, switchNum } = vi.hoisted(() => {
  const state = {
    /** When false, `requestCameraSwitch` holds each request in `held` instead of sending it. */
    sendAtOnce: true,
    held: [] as SwitchRequest[],
  };

  return {
    engine: {
      state,
      requestCameraSwitch: vi.fn((send: () => unknown, options: CameraSwitchOptions): Promise<void> => {
        if (state.sendAtOnce) send();
        else state.held.push({ send, options });

        return Promise.resolve();
      }),
    },
    fake: { controller: null as unknown as FakeController },
    switchNum: vi.fn((_carNumberRaw: number, _group: number, _camera: number) => true),
  };
});

vi.mock("@iracedeck/deck-iracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/deck-iracing")>()),
  getController: () => fake.controller,
  getCommands: () => ({ camera: { switchNum } }),
}));

vi.mock("@iracedeck/replay-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/replay-engine")>()),
  requestCameraSwitch: engine.requestCameraSwitch,
}));

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
  fake.controller = new FakeController();
  fake.controller.sessionInfo = sessionInfo();
  fake.controller.setCamera(1, G.Nose);
  engine.state.sendAtOnce = true;
  engine.state.held = [];
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

  it("builds the switch from the car the camera is on when it goes out", () => {
    start();
    fake.controller.camera(4, G.Nose);
    // The camera moves on between two deliveries: the send reads it fresh.
    fake.controller.setCamera(6, G.Nose);
    vi.advanceTimersByTime(AUTO_GROUP_SETTLE_MS);

    expect(switchNum).toHaveBeenCalledExactlyOnceWith(106, G.TV1, 0);
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

    it("switch the pick order", () => {
      applySwitches();
      vi.spyOn(Math, "random").mockReturnValue(0);
      start("key-a", ["TV1", "TV2", "TV3"]);
      landOn(2);
      updateAutoGroupSettings("key-a", ["TV1", "TV2", "TV3"], "random");
      landOn(3);

      // Random from TV1: the others are TV2 and TV3, and 0 draws TV2.
      expect(switchedGroups()).toEqual(["TV1", "TV2"]);
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
