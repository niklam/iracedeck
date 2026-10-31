import type { ILogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import {
  type AudioHoldTarget,
  type AudioSessionHoldDeps,
  IRACING_SESSION_HOLD_REASON,
  startAudioSessionHold,
} from "./audio-session-hold.js";

/**
 * The audio service's hold, as a class whose methods read `this` like the real
 * one: a controller that detached `hold` from its object would throw here.
 */
class FakeAudio implements AudioHoldTarget {
  /** Every call, in order, as `hold:<reason>` / `release:<reason>` — failed ones included. */
  readonly calls: string[] = [];
  /** The reasons currently held. */
  readonly reasons = new Set<string>();
  /** Set to make the next calls of that kind throw. */
  failing: "hold" | "release" | null = null;
  /** Runs inside `hold`, before it returns — where a device open would be. */
  duringHold: (() => void) | null = null;

  hold(reason: string): void {
    this.calls.push(`hold:${reason}`);

    if (this.failing === "hold") throw new Error("device exploded");

    this.duringHold?.();
    this.reasons.add(reason);
  }

  release(reason: string): void {
    this.calls.push(`release:${reason}`);

    if (this.failing === "release") throw new Error("device stuck");

    this.reasons.delete(reason);
  }
}

/** A listener registry shaped like the app monitor's and the settings layer's. */
function createEvent(): { subscribe: (listener: () => void) => () => void; fire: () => void; count: () => number } {
  const listeners = new Set<() => void>();

  return {
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    // No try/catch, like `updateGlobalSettings`' fan-out: a listener that
    // throws fails the test that fired it.
    fire: () => {
      for (const listener of [...listeners]) listener();
    },
    count: () => listeners.size,
  };
}

function createLogger(): ILogger {
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

interface World {
  audio: FakeAudio;
  started: ReturnType<typeof createEvent>;
  terminated: ReturnType<typeof createEvent>;
  settingsChanged: ReturnType<typeof createEvent>;
  /** What the readers answer; a test flips these and fires `settingsChanged`. */
  state: { active: boolean; raceEngineer: boolean; radar: boolean; pressSound: boolean };
  isIRacingActive: ReturnType<typeof vi.fn<() => boolean>>;
  isRaceEngineerEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  isRadarEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  isPressSoundEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  logger: ILogger;
  deps: AudioSessionHoldDeps;
}

function createWorld(initial: Partial<World["state"]> = {}): World {
  const state = { active: false, raceEngineer: false, radar: false, pressSound: false, ...initial };
  const audio = new FakeAudio();
  const started = createEvent();
  const terminated = createEvent();
  const settingsChanged = createEvent();
  const isIRacingActive = vi.fn(() => state.active);
  const isRaceEngineerEnabled = vi.fn(() => state.raceEngineer);
  const isRadarEnabled = vi.fn(() => state.radar);
  const isPressSoundEnabled = vi.fn(() => state.pressSound);
  const logger = createLogger();

  return {
    audio,
    started,
    terminated,
    settingsChanged,
    state,
    isIRacingActive,
    isRaceEngineerEnabled,
    isRadarEnabled,
    isPressSoundEnabled,
    logger,
    deps: {
      audio,
      onIRacingStarted: started.subscribe,
      onIRacingTerminated: terminated.subscribe,
      isIRacingActive,
      isRaceEngineerEnabled,
      isRadarEnabled,
      isPressSoundEnabled,
      onGlobalSettingsChange: settingsChanged.subscribe,
      logger,
    },
  };
}

const HOLD = `hold:${IRACING_SESSION_HOLD_REASON}`;
const RELEASE = `release:${IRACING_SESSION_HOLD_REASON}`;

describe("startAudioSessionHold (#1347)", () => {
  it("names its reason iracing-session", () => {
    expect(IRACING_SESSION_HOLD_REASON).toBe("iracing-session");
  });

  describe("iRacing starting and exiting", () => {
    it("takes the hold exactly once when iRacing starts with a gate on", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      expect(world.audio.calls).toEqual([]);

      world.started.fire();

      expect(world.audio.calls).toEqual([HOLD]);
      expect(world.audio.reasons.has("iracing-session")).toBe(true);
    });

    it("takes no hold when iRacing starts with every gate off", () => {
      const world = createWorld();
      startAudioSessionHold(world.deps);

      world.started.fire();

      expect(world.audio.calls).toEqual([]);
    });

    it.each([
      ["the Race Engineer", { raceEngineer: true, radar: false }],
      ["the Radar", { raceEngineer: false, radar: true }],
      ["the press sound", { raceEngineer: false, radar: false, pressSound: true }],
    ])("%s gate alone is enough", (_name, gates) => {
      const world = createWorld(gates);
      startAudioSessionHold(world.deps);

      world.started.fire();

      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("releases the hold when iRacing exits", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      world.started.fire();

      world.terminated.fire();

      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
      expect(world.audio.reasons.size).toBe(0);
    });

    it("takes it again when iRacing starts a second time", () => {
      const world = createWorld({ radar: true });
      startAudioSessionHold(world.deps);
      world.started.fire();
      world.terminated.fire();

      world.started.fire();

      expect(world.audio.calls).toEqual([HOLD, RELEASE, HOLD]);
    });

    it("releases nothing when iRacing exits without a hold", () => {
      const world = createWorld();
      startAudioSessionHold(world.deps);
      world.started.fire();

      world.terminated.fire();

      expect(world.audio.calls).toEqual([]);
    });
  });

  describe("starting with iRacing already running", () => {
    it("takes the hold at once", () => {
      const world = createWorld({ active: true, raceEngineer: true });

      startAudioSessionHold(world.deps);

      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("does not take it a second time when the started edge then reports the same session", () => {
      const world = createWorld({ active: true, raceEngineer: true });
      startAudioSessionHold(world.deps);

      world.started.fire();

      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("takes none with both gates off, and takes it when one turns on", () => {
      const world = createWorld({ active: true });
      startAudioSessionHold(world.deps);
      expect(world.audio.calls).toEqual([]);

      world.state.radar = true;
      world.settingsChanged.fire();

      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("reads isIRacingActive once and follows the edges from then on", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);

      // The SDK connected, but the started edge has not said so: a settings
      // write in between must not open the device.
      world.state.active = true;
      world.settingsChanged.fire();

      expect(world.isIRacingActive).toHaveBeenCalledTimes(1);
      expect(world.audio.calls).toEqual([]);
    });
  });

  describe("gate changes mid-session", () => {
    it("takes the hold when a gate turns on", () => {
      const world = createWorld();
      startAudioSessionHold(world.deps);
      world.started.fire();

      world.state.raceEngineer = true;
      world.settingsChanged.fire();

      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("keeps it while one gate stays on and releases it when the last turns off", () => {
      const world = createWorld({ raceEngineer: true, radar: true });
      startAudioSessionHold(world.deps);
      world.started.fire();

      world.state.raceEngineer = false;
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD]);

      world.state.radar = false;
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
    });

    it("calls nothing for a settings change that changes neither gate, held or not", () => {
      const world = createWorld();
      startAudioSessionHold(world.deps);
      world.started.fire();

      world.settingsChanged.fire();
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([]);

      world.state.raceEngineer = true;
      world.settingsChanged.fire();
      world.settingsChanged.fire();
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("takes no hold for a gate turned on while iRacing is not running, and reads no gate", () => {
      const world = createWorld();
      startAudioSessionHold(world.deps);

      world.state.raceEngineer = true;
      world.state.pressSound = true;
      world.settingsChanged.fire();

      expect(world.audio.calls).toEqual([]);
      expect(world.isRaceEngineerEnabled).not.toHaveBeenCalled();
      expect(world.isRadarEnabled).not.toHaveBeenCalled();
      expect(world.isPressSoundEnabled).not.toHaveBeenCalled();
    });

    it("with both master gates off, takes the hold for press sounds while iRacing runs and releases it at none (#269)", () => {
      const world = createWorld();
      startAudioSessionHold(world.deps);
      world.started.fire();
      expect(world.audio.calls).toEqual([]);

      // The Press sound setting moves off `none`.
      world.state.pressSound = true;
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD]);

      // A write that leaves it on changes nothing.
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD]);

      // Back to `none`.
      world.state.pressSound = false;
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
      expect(world.audio.reasons.size).toBe(0);
    });

    it("keeps the hold while press sounds stay on and the last master gate turns off (#269)", () => {
      const world = createWorld({ active: true, radar: true, pressSound: true });
      startAudioSessionHold(world.deps);
      expect(world.audio.calls).toEqual([HOLD]);

      world.state.radar = false;
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD]);

      world.terminated.fire();
      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
    });

    it("takes the hold at the next start for a gate turned on while iRacing was closed", () => {
      const world = createWorld();
      startAudioSessionHold(world.deps);
      world.state.radar = true;
      world.settingsChanged.fire();

      world.started.fire();

      expect(world.audio.calls).toEqual([HOLD]);
    });
  });

  describe("faults", () => {
    it("contains a throwing gate reader, logs it, and retries on the next evaluation", () => {
      const world = createWorld();
      startAudioSessionHold(world.deps);
      world.started.fire();
      world.state.raceEngineer = true;
      world.isRaceEngineerEnabled.mockImplementationOnce(() => {
        throw new Error("settings cache gone");
      });

      expect(() => world.settingsChanged.fire()).not.toThrow();

      expect(world.audio.calls).toEqual([]);
      expect(world.logger.error).toHaveBeenCalledTimes(1);
      expect(world.logger.error).toHaveBeenCalledWith("Updating the audio session hold failed");
      expect(world.logger.debug).toHaveBeenCalledWith("Error: settings cache gone");

      world.settingsChanged.fire();

      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("contains a throwing hold on the started edge, and retries it until it succeeds", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      world.audio.failing = "hold";

      expect(() => world.started.fire()).not.toThrow();

      expect(world.audio.calls).toEqual([HOLD]);
      expect(world.audio.reasons.size).toBe(0);
      expect(world.logger.error).toHaveBeenCalledWith("Updating the audio session hold failed");
      expect(world.logger.debug).toHaveBeenCalledWith("Error: device exploded");

      // Still failing: the change stays pending rather than being recorded.
      expect(() => world.settingsChanged.fire()).not.toThrow();
      expect(world.audio.calls).toEqual([HOLD, HOLD]);

      world.audio.failing = null;
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD, HOLD, HOLD]);
      expect(world.audio.reasons.has("iracing-session")).toBe(true);

      // Recorded now, so the steady state is quiet again.
      world.settingsChanged.fire();
      expect(world.audio.calls).toEqual([HOLD, HOLD, HOLD]);
    });

    it("contains a throwing release on the terminated edge, and retries it", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      world.started.fire();
      world.audio.failing = "release";

      expect(() => world.terminated.fire()).not.toThrow();

      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
      expect(world.audio.reasons.has("iracing-session")).toBe(true);
      expect(world.logger.error).toHaveBeenCalledWith("Updating the audio session hold failed");
      expect(world.logger.debug).toHaveBeenCalledWith("Error: device stuck");

      world.audio.failing = null;
      world.settingsChanged.fire();

      expect(world.audio.calls).toEqual([HOLD, RELEASE, RELEASE]);
      expect(world.audio.reasons.size).toBe(0);
    });

    it("releases on exit even when a gate reader would throw", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      world.started.fire();
      world.isRaceEngineerEnabled.mockImplementation(() => {
        throw new Error("settings cache gone");
      });

      world.terminated.fire();

      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
    });

    it("contains a throwing hold in the start call itself, and retries it", () => {
      const world = createWorld({ active: true, radar: true });
      world.audio.failing = "hold";

      expect(() => startAudioSessionHold(world.deps)).not.toThrow();
      expect(world.logger.error).toHaveBeenCalledWith("Updating the audio session hold failed");

      world.audio.failing = null;
      world.settingsChanged.fire();

      expect(world.audio.calls).toEqual([HOLD, HOLD]);
      expect(world.audio.reasons.has("iracing-session")).toBe(true);
    });

    it("treats a throwing isIRacingActive as not running, and still follows the edges", () => {
      const world = createWorld({ raceEngineer: true });
      world.isIRacingActive.mockImplementationOnce(() => {
        throw new Error("no controller");
      });

      expect(() => startAudioSessionHold(world.deps)).not.toThrow();

      expect(world.audio.calls).toEqual([]);
      expect(world.logger.error).toHaveBeenCalledWith("Reading whether iRacing is running failed");
      expect(world.logger.debug).toHaveBeenCalledWith("Error: no controller");

      world.started.fire();

      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("keeps the detail out of the error line", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      world.audio.failing = "hold";

      world.started.fire();

      for (const [message] of vi.mocked(world.logger.error).mock.calls) {
        expect(message).not.toContain("device exploded");
      }
    });

    it("does not take the hold twice when a settings change arrives while the device opens", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      // `held` is recorded after `hold` returns, so without the deferral this
      // nested evaluation would see the change as pending and repeat it.
      world.audio.duringHold = () => world.settingsChanged.fire();

      world.started.fire();

      expect(world.audio.calls).toEqual([HOLD]);
    });

    it("applies a gate turned off while the device opens once the open has returned", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      world.audio.duringHold = () => {
        world.audio.duringHold = null;
        world.state.raceEngineer = false;
        world.settingsChanged.fire();
      };

      world.started.fire();

      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
      expect(world.audio.reasons.size).toBe(0);
    });
  });

  describe("logging", () => {
    it("writes no info or warn line of its own, and says why at debug", () => {
      const world = createWorld({ raceEngineer: true });
      startAudioSessionHold(world.deps);
      world.started.fire();
      world.settingsChanged.fire();
      world.terminated.fire();

      expect(world.logger.info).not.toHaveBeenCalled();
      expect(world.logger.warn).not.toHaveBeenCalled();
      expect(world.logger.error).not.toHaveBeenCalled();
      expect(vi.mocked(world.logger.debug).mock.calls).toEqual([
        ["Taking the audio hold (iRacing started)"],
        ["Releasing the audio hold (iRacing exited)"],
      ]);
    });
  });

  describe("the stop function", () => {
    it("releases the hold it took and unsubscribes all three listeners", () => {
      const world = createWorld({ raceEngineer: true });
      const stop = startAudioSessionHold(world.deps);
      world.started.fire();
      expect([world.started.count(), world.terminated.count(), world.settingsChanged.count()]).toEqual([1, 1, 1]);

      stop();

      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
      expect([world.started.count(), world.terminated.count(), world.settingsChanged.count()]).toEqual([0, 0, 0]);
    });

    it("releases nothing when it holds nothing", () => {
      const world = createWorld();
      const stop = startAudioSessionHold(world.deps);

      stop();

      expect(world.audio.calls).toEqual([]);
    });

    it("releases once however often it is called", () => {
      const world = createWorld({ active: true, radar: true });
      const stop = startAudioSessionHold(world.deps);

      stop();
      stop();

      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
    });

    it("ignores every later event, even from a subscription that could not be removed", () => {
      const world = createWorld({ raceEngineer: true });
      // A registry whose unsubscribe does nothing, so the listener stays reachable.
      const sticky = createEvent();
      const stop = startAudioSessionHold({
        ...world.deps,
        onIRacingStarted: (listener) => {
          sticky.subscribe(listener);

          return () => undefined;
        },
      });

      stop();
      sticky.fire();
      world.settingsChanged.fire();

      expect(world.audio.calls).toEqual([]);
    });

    it("still releases and unsubscribes the rest when one unsubscribe throws", () => {
      const world = createWorld({ active: true, raceEngineer: true });
      const stop = startAudioSessionHold({
        ...world.deps,
        onIRacingStarted: () => () => {
          throw new Error("registry gone");
        },
      });

      expect(() => stop()).not.toThrow();

      expect(world.audio.calls).toEqual([HOLD, RELEASE]);
      expect([world.terminated.count(), world.settingsChanged.count()]).toEqual([0, 0]);
      expect(world.logger.error).toHaveBeenCalledWith("Unsubscribing the audio session hold failed");
    });

    it("contains a throwing release", () => {
      const world = createWorld({ active: true, raceEngineer: true });
      const stop = startAudioSessionHold(world.deps);
      world.audio.failing = "release";

      expect(() => stop()).not.toThrow();

      expect(world.logger.error).toHaveBeenCalledWith("Updating the audio session hold failed");
    });
  });
});
