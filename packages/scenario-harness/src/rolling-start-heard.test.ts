/**
 * What the rolling-start buttons are HEARD to say (issue #1167).
 *
 * The other shortcut tests stop at the bus: they assert the events a button
 * makes the translator publish. That was not enough here. When the three
 * formation callouts gained a speak gate asking the translator whether a
 * formation is running, the two buttons that published their events by hand
 * went silent — and every test in the package stayed green, because the event
 * still reached the bus. An event on the bus is not a line on the radio.
 *
 * So this file runs the harness's whole stack the way `main.ts` boots it —
 * the real translator over the mock SDK, the real scenario engine, the
 * plugins' own Race Engineer wiring over the seeded settings, the reference
 * voice's committed script — with only the audio device replaced, and presses
 * each button the way the UI does. What is asserted is the clips the engine
 * hands the Voice channel, in order.
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
import { type SDKController, type SessionInfo, SessionState } from "@iracedeck/iracing-sdk";
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getAudioAssetsManifest, seedGlobalSettings } from "./bootstrap-settings.js";
import { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController, type TelemetryPatch } from "./mock-sdk-controller.js";
import { wireHarnessRaceEngineer } from "./race-engineer-wiring.js";
import { SCENARIO_SHORTCUTS, type ScenarioShortcut, type TelemetryStep } from "./scenario-shortcuts.js";
import { loadBundledVoiceScripts } from "./voice-scripts.js";

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "presets");

/** The voice every assertion below names clips of. */
const VOICE = "default";

/**
 * How long each clip plays on the stand-in device, in ms: the longest take of
 * each pool in the reference voice, measured from the committed clips on
 * 2026-10-11, rounded up. A hold that is too short for its line shows up here
 * as a line that is cut, queued behind the next one, or refused at its gate.
 */
const CLIP_MS: readonly (readonly [pattern: RegExp, ms: number])[] = [
  [/\/car-number\//, 900],
  [/\/rolling-start\//, 3600],
  [/\/caution\/one-to-go/, 2600],
  [/\/caution\/lineup-changed/, 1700],
  [/\/caution\/pace-car-off/, 1400],
  [/\/flags\/green-held/, 4800],
  [/\/start-lights\//, 1100],
];

/** A clip no pattern above names — the radio frame's two ticks, mostly. */
const OTHER_CLIP_MS = 300;

type Played = { channel: AudioChannel; path: string };

type FakeAudio = IAudioService & { played: Played[] };

/**
 * The audio service, with the device replaced by a clock: a clip "plays" for
 * its {@link CLIP_MS} of the fake timers' time and then completes. The engine
 * registers its completion callback before it starts a clip, so the callback
 * that is current when the clip ends is the one for that clip unless the
 * channel was stopped or restarted meanwhile, which the per-channel token
 * tells apart.
 */
function createFakeAudio(): FakeAudio {
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

      const ms = CLIP_MS.find(([pattern]) => pattern.test(path.replaceAll("\\", "/")))?.[1] ?? OTHER_CLIP_MS;

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

function shortcutOf(id: string): ScenarioShortcut {
  const shortcut = SCENARIO_SHORTCUTS.find((s) => s.id === id);

  if (shortcut === undefined) throw new Error(`no shortcut "${id}"`);

  return shortcut;
}

describe("what the rolling-start buttons are heard to say (issue #1167)", () => {
  let bus: IEventBus;
  let audio: FakeAudio;
  let controller: MockSDKController;

  beforeAll(async () => {
    // Once, on one bus: `registerPitCrew` binds the radar, spotter and
    // pit-speeding engines to the first bus it sees and refuses another, and
    // their resets are not exported. The translator is the part that is
    // restarted per test, on this same bus.
    bus = initializeEventBus(silentLogger);
    audio = createFakeAudio();

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
    controller.stop();
    _resetSimEventsIracing();
    // Whatever is still waiting is refused or played out before the next test.
    vi.advanceTimersByTime(60_000);
    audio.played.length = 0;
  });

  /**
   * The harness as a tester sets it up before pressing: a session preset
   * applied and the mock SDK connected, on its boot telemetry. `ticking: false`
   * is the tick loop paused, where the translator sees only the ticks a step
   * asks for.
   */
  function boot(sessionPreset: string, { ticking = true }: { ticking?: boolean } = {}): void {
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
  }

  /** One step as the UI posts it and `/api/telemetry` applies it, then its hold with the mock's timer running. */
  function apply(steps: readonly TelemetryStep[] | undefined): void {
    for (const step of steps ?? []) {
      controller.mutateTelemetry(step.patch as TelemetryPatch);

      if (step.tick === true) controller.tickOnce();

      vi.advanceTimersByTime(step.holdMs ?? 0);
    }
  }

  /** One event as `/api/bus/publish` publishes it: the mock's current telemetry as the envelope. */
  function publish(event: SimEventName, data: Record<string, unknown> = {}): void {
    bus.publish({
      event,
      timestamp: Date.now(),
      telemetry: controller.getState().telemetry,
      data,
    } as SimEventOf<SimEventName>);
  }

  /** A press, in the UI's order: the setup sequence, the publish, the teardown. */
  function press(id: string): void {
    const shortcut = shortcutOf(id);

    apply(shortcut.telemetrySequence);

    if (shortcut.event !== undefined) publish(shortcut.event, shortcut.data);

    apply(shortcut.teardownSequence);
    // Past the end, so a line that only started late is still counted.
    vi.advanceTimersByTime(10_000);
  }

  /** What was heard since the last call, and nothing kept. */
  function heardAndCleared(): string[] {
    const clips = heard();

    audio.played.length = 0;

    return clips;
  }

  /** The Voice channel's clips in order, as paths under the voice's folder without the take number. */
  function heard(): string[] {
    return audio.played
      .filter((p) => p.channel === AudioChannel.Voice)
      .map((p) => {
        const path = p.path.replaceAll("\\", "/");
        const at = path.indexOf(`voice/${VOICE}/`);

        return (at < 0 ? path : path.slice(at + `voice/${VOICE}/`.length)).replace(/(-\d+)?\.mp3$/, "");
      });
  }

  const PACE_CAR_INSIDE = ["rolling-start/pace-car-moving-inside", "car-number/8"];
  const ONE_LAP_INSIDE = ["caution/one-to-go-inside", "car-number/8"];
  const CHANGE_INSIDE = ["caution/lineup-changed-inside", "car-number/19"];

  it('"Formation (oval, two laps)" speaks the three formation calls with the lane and the car, then the three the start already had', () => {
    boot("race-oval");
    press("rolling-start-formation");

    expect(heard()).toEqual([
      // "Pace car's rolling. Inside line, behind" + "car eight".
      ...PACE_CAR_INSIDE,
      // "One lap to green. Take the inside line behind" + "car eight" — the real #773 decision.
      ...ONE_LAP_INSIDE,
      // "Change — you're on the inside behind" + "car nineteen": car eight was the one last named.
      ...CHANGE_INSIDE,
      "flags/green-held",
      "caution/pace-car-off",
      "start-lights/start-go",
    ]);
  });

  it('"Formation (oval, two laps)" is heard whole on a second press', () => {
    boot("race-oval");
    press("rolling-start-formation");

    const first = heardAndCleared();

    press("rolling-start-formation");

    expect(heard()).toEqual(first);
    expect(first).toHaveLength(9);
  });

  it.each([
    { preset: "race-oval", lane: "the lane", clips: PACE_CAR_INSIDE },
    { preset: "race", lane: "no lane", clips: ["rolling-start/pace-car-moving-behind", "car-number/8"] },
  ])('"Pace car moving" speaks the pace-car call with $lane on $preset', ({ preset, clips }) => {
    boot(preset);
    press("rolling-start-pace-car-moving");

    expect(heard()).toEqual(clips);
  });

  it.each([
    { preset: "race-oval", lane: "the lane", clips: CHANGE_INSIDE },
    { preset: "race", lane: "no lane", clips: ["caution/lineup-changed-plain", "car-number/19"] },
  ])('"Car ahead changed" speaks the change call with $lane on $preset', ({ preset, clips }) => {
    boot(preset);
    press("rolling-start-lineup-changed");

    expect(heard()).toEqual(clips);
  });

  it.each([
    { preset: "race-oval", lane: "the lane", clips: ONE_LAP_INSIDE },
    { preset: "race", lane: "no lane", clips: ["caution/one-to-go-plain", "car-number/8"] },
  ])('"One Lap to Green" speaks the one-lap-to-green call with $lane on $preset', ({ preset, clips }) => {
    boot(preset);
    press("flag-one-lap-to-green");

    expect(heard()).toEqual(clips);
  });

  it('"One Lap to Green" is heard with the tick loop paused — its setup ticks the formation in front of the publish', () => {
    // The #1349 rule: a step whose job is to put state in front of a publish
    // cannot rely on its hold, because the hold lets a tick through only while
    // the timer runs. Here the state is the translator's formation.
    boot("race-oval", { ticking: false });
    press("flag-one-lap-to-green");

    expect(heard()).toEqual(ONE_LAP_INSIDE);
  });

  it("speaks each button again when they are pressed one after another, whatever state the last one left", () => {
    boot("race-oval");

    for (const id of [
      "flag-one-lap-to-green",
      "rolling-start-lineup-changed",
      "rolling-start-pace-car-moving",
      "flag-one-lap-to-green",
    ]) {
      press(id);
    }

    expect(heardAndCleared()).toEqual([...ONE_LAP_INSIDE, ...CHANGE_INSIDE, ...PACE_CAR_INSIDE, ...ONE_LAP_INSIDE]);

    press("rolling-start-formation");

    expect(heard()).toHaveLength(9);
  });

  it("control: the same three events published by hand with NO formation running are silent — the old buttons", () => {
    // What the two pre-#1167 buttons did, and why they went quiet: the event
    // reaches the bus, the callout's `where:` admits it (a race, live in the
    // car), and the speak gate refuses it because the translator holds no
    // formation. If this ever speaks, the gate is gone and the buttons above
    // prove nothing about it.
    boot("race-oval");
    apply([{ patch: { IsOnTrack: true, SessionState: SessionState.Racing }, holdMs: 200, tick: true }]);

    publish("rollingStart.pace-car-moving.raised");
    publish("flag.one-pace-lap-to-go.raised");
    publish("rollingStart.lineup.changed");
    vi.advanceTimersByTime(10_000);

    expect(heard()).toEqual([]);

    // ...and the first of them speaks once a formation is in front of the
    // translator, so the silence above was the gate's and not the rig's.
    apply(shortcutOf("flag-one-lap-to-green").telemetrySequence);
    publish("rollingStart.pace-car-moving.raised");
    vi.advanceTimersByTime(10_000);

    expect(heard()).toEqual(PACE_CAR_INSIDE);
  });
});
