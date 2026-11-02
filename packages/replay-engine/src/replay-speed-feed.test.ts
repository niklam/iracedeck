import { replaySpeedToSdk, type TelemetryData } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureReplayEngine } from "./replay-engine-configure.js";
import type { ReplayEngineEnv } from "./replay-engine-env.js";
import { _resetReplayEngine } from "./replay-engine-reset.js";
import type { ReplaySpeed } from "./replay-jump-speed.js";
import { replayLeftController, type WatchedReplayController } from "./replay-left.test-support.js";
import { REPLAY_SPEED_FEED_SUBSCRIBER_ID, startReplaySpeedFeed, stopReplaySpeedFeed } from "./replay-speed-feed.js";
import { noteReplaySpeedSent, rememberedSpeed, resolveLiveSpeed } from "./replay-speed-state.js";

function speed(value: number, slowMotion = false): ReplaySpeed {
  return { speed: value, slowMotion };
}

/** A replay tick at `at`: raw value plus the slow-motion flag, as iRacing reports it. */
function replayAt(at: ReplaySpeed): TelemetryData {
  return {
    IsReplayPlaying: true,
    ReplayFrameNum: 2_000,
    ReplayPlaySpeed: replaySpeedToSdk(at.speed, at.slowMotion),
    ReplayPlaySlowMotion: at.slowMotion,
  } as TelemetryData;
}

/** From the car: `ReplayPlaySpeed` still carries a value, which says nothing about a replay. */
const DRIVING = { IsReplayPlaying: false, IsOnTrack: true, ReplayPlaySpeed: 4 } as TelemetryData;

let telemetry: TelemetryData | null;
let inReplay: boolean;

/** A stand-in controller ticking `telemetry`, with the debounced replay state reading `inReplay`. */
function controller(): WatchedReplayController {
  return replayLeftController({ replayState: () => ({ inReplay }), telemetry: () => telemetry });
}

/** The engine as the plugin's `initReplay` configures it, over `watched`. */
function engineOver(watched: WatchedReplayController): ReplayEngineEnv {
  return {
    controller: watched.controller,
    replay: () => {
      throw new Error("the feed sends nothing");
    },
    camera: () => ({ switchNum: () => true }),
    now: () => Date.now(),
    logger: silentLogger,
    settings: { replayJumpPlayback: () => undefined, fastestLapSearchDelayMs: () => undefined },
  };
}

describe("the engine's speed feed (#1427)", () => {
  beforeEach(() => {
    _resetReplayEngine();
    telemetry = replayAt(speed(1));
    inReplay = true;
  });

  afterEach(() => {
    _resetReplayEngine();
  });

  describe("configured as the plugin configures it", () => {
    it("the remembered speed follows telemetry with no Replay Control context on screen", () => {
      const watched = controller();

      configureReplayEngine(engineOver(watched));

      telemetry = replayAt(speed(4));
      watched.tick();

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("a pending speed ends on the first tick that shows it, so a change made after it reads at once", () => {
      const watched = controller();

      configureReplayEngine(engineOver(watched));
      noteReplaySpeedSent(speed(2), Date.now(), { rememberSpeed: false, telemetrySpeed: speed(1) });

      telemetry = replayAt(speed(2));
      watched.tick();

      // iRacing's own replay bar, inside the hold: nothing read the 2x tick but the feed.
      expect(resolveLiveSpeed(speed(8), Date.now())).toEqual(speed(8));
    });

    it("configuring again replaces the feed: the first controller's ticks feed nothing", () => {
      const first = controller();
      const second = controller();

      configureReplayEngine(engineOver(first));
      configureReplayEngine(engineOver(second));

      expect(first.unsubscribe).toHaveBeenCalledWith(REPLAY_SPEED_FEED_SUBSCRIBER_ID);

      telemetry = replayAt(speed(8));
      first.tick();

      expect(rememberedSpeed()).toEqual(speed(1));

      second.tick();

      expect(rememberedSpeed()).toEqual(speed(8));
    });

    it("the engine reset stops it", () => {
      const watched = controller();

      configureReplayEngine(engineOver(watched));
      _resetReplayEngine();

      expect(watched.unsubscribe).toHaveBeenCalledWith(REPLAY_SPEED_FEED_SUBSCRIBER_ID);

      telemetry = replayAt(speed(8));
      watched.tick();

      expect(rememberedSpeed()).toEqual(speed(1));
    });
  });

  describe("what it feeds", () => {
    it("feeds in the units the user sees: a slow-motion divisor, decoded (#1202)", () => {
      const watched = controller();

      startReplaySpeedFeed(watched.controller);

      telemetry = { ...replayAt(speed(1)), ReplayPlaySpeed: -3, ReplayPlaySlowMotion: true } as TelemetryData;
      watched.tick();

      expect(rememberedSpeed()).toEqual(speed(-4, true));
    });

    it("never feeds from the car, where ReplayPlaySpeed says nothing about a replay", () => {
      const watched = controller();

      startReplaySpeedFeed(watched.controller);

      inReplay = false;
      telemetry = DRIVING;
      watched.tick();

      expect(rememberedSpeed()).toEqual(speed(1));
    });

    it("keeps the remembered speed through a paused replay", () => {
      const watched = controller();

      startReplaySpeedFeed(watched.controller);

      telemetry = replayAt(speed(4));
      watched.tick();
      telemetry = replayAt(speed(0));
      watched.tick();

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("feeds nothing on a disconnect, or a tick with no telemetry or no speed", () => {
      const watched = controller();

      startReplaySpeedFeed(watched.controller);
      telemetry = replayAt(speed(4));
      watched.tick();

      watched.tick(replayAt(speed(8)), false);
      watched.tick(null, true);
      watched.tick({ IsReplayPlaying: true } as TelemetryData, true);

      expect(rememberedSpeed()).toEqual(speed(4));
    });

    it("a replay state that throws feeds nothing", () => {
      const watched = replayLeftController({
        replayState: () => {
          throw new Error("no sdk");
        },
        telemetry: () => replayAt(speed(8)),
      });

      startReplaySpeedFeed(watched.controller);
      watched.tick();

      expect(rememberedSpeed()).toEqual(speed(1));
    });

    it("stops on stopReplaySpeedFeed, which a controller that cannot unsubscribe does not break", () => {
      const watched = controller();

      startReplaySpeedFeed(watched.controller);
      watched.unsubscribe.mockImplementation(() => {
        throw new Error("gone");
      });

      expect(() => stopReplaySpeedFeed()).not.toThrow();

      telemetry = replayAt(speed(8));
      watched.tick();

      expect(rememberedSpeed()).toEqual(speed(1));
    });
  });
});
