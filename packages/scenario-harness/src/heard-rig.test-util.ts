/**
 * The rig behind the "what is HEARD" tests (issue #1167): the harness's whole
 * stack the way `main.ts` boots it — the real translator over the mock SDK,
 * the real scenario engine, the plugins' own Race Engineer wiring over the
 * seeded settings, the reference voice's committed script — with only the
 * audio device replaced, and a shortcut pressed the way the UI presses it.
 *
 * It exists because the tests that stop at the bus cannot see a line that is
 * refused at its speak gate. When the formation callouts gained a gate asking
 * the translator whether a formation is running, the buttons that published
 * their events by hand went silent and every test in the package stayed
 * green: the event still reached the bus. An event on the bus is not a line
 * on the radio, so a test of a button whose callout asks the translator
 * anything at speak time asserts the clips handed to the Voice channel.
 *
 * One rig per test FILE: `registerPitCrew` binds the radar, spotter and
 * pit-speeding engines to the first bus it sees and refuses another, and
 * their resets are not exported, so the engine and the wiring are set up once
 * on one bus and the translator is the part restarted per test.
 */
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "@iracedeck/audio-scenarios";
import { AudioChannel, type IAudioService } from "@iracedeck/audio-service";
import {
  _resetEventBus,
  type IEventBus,
  initializeEventBus,
  type SimEventName,
  type SimEventOf,
} from "@iracedeck/event-bus";
import type { SDKController, SessionInfo } from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import {
  _resetGlobalSettings,
  createMemorySettingsStore,
  initGlobalSettings,
  whenSettingsStoreSettled,
} from "@iracedeck/settings";
import { _resetSimEventsIracing, initializeSimEventsIracing } from "@iracedeck/sim-events-iracing";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

import { getAudioAssetsManifest, seedGlobalSettings } from "./bootstrap-settings.js";
import { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import { wireHarnessRaceEngineer } from "./race-engineer-wiring.js";
import { SCENARIO_SHORTCUTS, type ScenarioShortcut, type TelemetryStep } from "./scenario-shortcuts.js";
import { loadBundledVoiceScripts } from "./voice-scripts.js";

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

/** The voice every heard clip is named under. */
const VOICE = "default";

/**
 * How long a clip plays on the stand-in device: the first pattern its path
 * matches decides, in ms. A test hands in the longest take of each pool its
 * buttons draw on, so a hold that is too short for its line shows up as a
 * line that is cut, queued behind the next one, or refused at its gate.
 */
export type ClipDurations = readonly (readonly [pattern: RegExp, ms: number])[];

/** A clip no pattern names — the radio frame's two ticks, mostly. */
const OTHER_CLIP_MS = 300;

type Played = { channel: AudioChannel; path: string };

type FakeAudio = IAudioService & { played: Played[] };

/**
 * The audio service, with the device replaced by a clock: a clip "plays" for
 * its duration of the fake timers' time and then completes. The engine
 * registers its completion callback before it starts a clip, so the callback
 * that is current when the clip ends is the one for that clip unless the
 * channel was stopped or restarted meanwhile, which the per-channel token
 * tells apart.
 */
function createFakeAudio(clipMs: ClipDurations): FakeAudio {
  const played: Played[] = [];
  const callbacks = new Map<AudioChannel, () => void>();
  const tokens = new Map<AudioChannel, number>();
  const playing = new Set<AudioChannel>();
  const nextToken = (channel: AudioChannel): number => {
    const token = (tokens.get(channel) ?? 0) + 1;

    tokens.set(channel, token);

    return token;
  };

  const audio: Partial<IAudioService> & { played: Played[] } = {
    played,
    init: () => true,
    destroy: () => {},
    playOnChannel: (channel, path, loop) => {
      const token = nextToken(channel);

      played.push({ channel, path });
      playing.add(channel);

      if (loop === true) return true;

      const ms = clipMs.find(([pattern]) => pattern.test(path.replaceAll("\\", "/")))?.[1] ?? OTHER_CLIP_MS;

      setTimeout(() => {
        if (tokens.get(channel) !== token) return;

        const done = callbacks.get(channel);

        playing.delete(channel);
        callbacks.delete(channel);
        done?.();
      }, ms);

      return true;
    },
    stopChannel: (channel) => {
      nextToken(channel);
      playing.delete(channel);
      callbacks.delete(channel);
    },
    stopAllChannels: () => {},
    setChannelVolume: () => {},
    setBusVolume: () => {},
    getBusVolume: () => 1,
    isChannelPlaying: (channel) => playing.has(channel),
    onChannelComplete: (channel, callback) => {
      callbacks.set(channel, callback);
    },
    seekChannelRandom: () => {},
    getAudioDevices: () => [],
    setAudioDevice: () => true,
  };

  return audio as FakeAudio;
}

/** The shortcut with this id, or a thrown error naming it. */
export function shortcutOf(id: string): ScenarioShortcut {
  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === id);

  if (shortcut === undefined) throw new Error(`no shortcut "${id}"`);

  return shortcut;
}

export type HeardRig = {
  /**
   * The harness as a tester sets it up before pressing: a session preset
   * applied and the mock SDK connected, on its boot telemetry. `ticking: false`
   * is the tick loop paused, where the translator sees only the ticks a step
   * asks for.
   */
  boot: (sessionPreset: string, options?: { ticking?: boolean }) => void;
  /** Steps as the UI posts them and `/api/telemetry` applies them, each held with the mock's timer running. */
  apply: (steps: readonly TelemetryStep[] | undefined) => void;
  /** One event as `/api/bus/publish` publishes it: the mock's current telemetry as the envelope. */
  publish: (event: SimEventName, data?: Record<string, unknown>) => void;
  /** A press, in the UI's order: the setup sequence, the publish, the teardown — then a listen past the end. */
  press: (id: string) => void;
  /** The Voice channel's clips in order, as paths under the voice's folder without the take number. */
  heard: () => string[];
  /**
   * The SFX channel's clips in order, named the same way (`sfx/…` for a clip
   * outside the voice's folder): the radio frame's ticks. A cut tail's spoken
   * clip — the never-mind (issue #1407) — is the engineer's voice and is in
   * `heard()`; only the tail's ticks are here.
   */
  radio: () => string[];
  /** What was heard since the last call, and nothing kept. */
  heardAndCleared: () => string[];
};

/**
 * Sets the rig up for the calling test file: registers the hooks that build
 * the stack once, restart the translator per test and tear it all down, and
 * returns the handles a test presses buttons and listens with. Fake timers are
 * on from the first test to the last.
 */
export function useHeardRig(clipMs: ClipDurations): HeardRig {
  let bus: IEventBus;
  let audio: FakeAudio;
  let controller: MockSDKController | null = null;

  beforeAll(async () => {
    bus = initializeEventBus(silentLogger);
    audio = createFakeAudio(clipMs);

    const adapter = new MockPlatformAdapter(silentLogger);
    const voices = seedGlobalSettings(adapter);

    // `main.ts`'s order: the engine, the wiring (which registers the
    // contracts), then the scripts that compile against them, then settings.
    initializeAudioScenarios(bus, audio, getAudioAssetsManifest(), silentLogger, () => VOICE);
    wireHarnessRaceEngineer(bus, silentLogger, voices);
    getScenarioEngine().setScripts(loadBundledVoiceScripts());
    initGlobalSettings(adapter, silentLogger, createMemorySettingsStore());
    await whenSettingsStoreSettled();

    vi.useFakeTimers();
  });

  afterAll(() => {
    vi.useRealTimers();
    _resetAudioScenarios();
    _resetGlobalSettings();
    _resetEventBus();
  });

  afterEach(() => {
    controller?.stop();
    controller = null;
    _resetSimEventsIracing();
    // Whatever is still waiting is refused or played out before the next test.
    vi.advanceTimersByTime(60_000);
    audio.played.length = 0;
  });

  const running = (): MockSDKController => {
    if (controller === null) throw new Error("boot() the rig before pressing anything");

    return controller;
  };

  const apply: HeardRig["apply"] = (steps) => {
    for (const step of steps ?? []) {
      running().mutateTelemetry(step.patch as TelemetryPatch);

      if (step.tick === true) running().tickOnce();

      vi.advanceTimersByTime(step.holdMs ?? 0);
    }
  };

  const publish: HeardRig["publish"] = (event, data = {}) => {
    bus.publish({
      event,
      timestamp: Date.now(),
      telemetry: running().getState().telemetry,
      data,
    } as SimEventOf<SimEventName>);
  };

  const clipsOn = (channel: AudioChannel): string[] =>
    audio.played
      .filter((p) => p.channel === channel)
      .map((p) => {
        const path = p.path.replaceAll("\\", "/");
        const at = path.indexOf(`voice/${VOICE}/`);
        const sfx = path.lastIndexOf("sfx/");
        const named = at >= 0 ? path.slice(at + `voice/${VOICE}/`.length) : sfx >= 0 ? path.slice(sfx) : path;

        return named.replace(/(-\d+)?\.mp3$/, "");
      });

  const heard: HeardRig["heard"] = () => clipsOn(AudioChannel.Voice);

  return {
    boot: (sessionPreset, { ticking = true } = {}) => {
      controller = new MockSDKController();
      controller.setSessionInfo(
        JSON.parse(readFileSync(join(PRESETS_DIR, "session", `${sessionPreset}.json`), "utf8")) as SessionInfo,
      );
      controller.setConnected(true);
      initializeSimEventsIracing(bus, controller as unknown as SDKController, silentLogger);

      if (ticking) controller.start();
      else controller.tickOnce();

      vi.advanceTimersByTime(500);
      audio.played.length = 0;
    },
    apply,
    publish,
    press: (id) => {
      const shortcut = shortcutOf(id);

      apply(shortcut.telemetrySequence);

      if (shortcut.event !== undefined) publish(shortcut.event, shortcut.data);

      apply(shortcut.teardownSequence);
      // Past the end, so a line that only started late is still counted.
      vi.advanceTimersByTime(10_000);
    },
    heard,
    radio: () => clipsOn(AudioChannel.SFX),
    heardAndCleared: () => {
      const clips = heard();

      audio.played.length = 0;

      return clips;
    },
  };
}
