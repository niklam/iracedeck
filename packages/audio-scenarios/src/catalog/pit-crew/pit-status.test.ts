/**
 * Unit tests for the pit-service status callout catalog (issue #479).
 *
 * Pins:
 *   - structure: 8 scenarios, shared family / priority / base
 *   - each scenario fires its matching clip when the bus publishes
 *     `pitService.statusChanged` with the expected `to` value
 *   - the `where:` predicate filters on `data.to` correctly (a non-matching
 *     `to` does not fire)
 *   - same-family preemption: a positioning correction (TooFarLeft →
 *     TooFarRight) supersedes the in-flight callout
 *   - per-callout opt-out via `registerPitCrew(... getPitStatusCalloutEnabled)`:
 *     disabling one id suppresses only that callout
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { PitSvStatus } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { type PitStatusCalloutId, registerPitCrew } from "./index.js";
import { PIT_STATUS_ALERTS, PIT_STATUS_POOL_NAMES, PIT_STATUS_SCENARIO_IDS } from "./pit-status.js";
import { POOL_REGISTRY } from "./pools.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
}));

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

function createMockBus(): IEventBus & {
  publishEvent: <T extends SimEventName>(name: T, data: SimEventMap[T]["data"]) => void;
} {
  const handlers = new Map<SimEventName, Set<(e: SimEventOf<SimEventName>) => void>>();

  return {
    subscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler as (e: SimEventOf<SimEventName>) => void);

      return () => {
        handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
      };
    },
    unsubscribe: <T extends SimEventName>(name: T, handler: (e: SimEventOf<T>) => void) => {
      handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
    },
    publish: (event: SimEventOf<SimEventName>) => {
      const set = handlers.get(event.event as SimEventName);

      if (!set) return;

      for (const handler of Array.from(set)) handler(event);
    },
    publishEvent<T extends SimEventName>(name: T, data: SimEventMap[T]["data"]) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry: null as unknown,
        data: data as never,
      } as SimEventOf<SimEventName>);
    },
  };
}

type FakeAudio = IAudioService & {
  _triggerChannelEnd: (channel: AudioChannel) => void;
  _played: { channel: AudioChannel; path: string; loop: boolean }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Radar]: null,
  };
  const played: { channel: AudioChannel; path: string; loop: boolean }[] = [];

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string, loop = false) => {
      played.push({ channel, path, loop });

      return true;
    }),
    stopChannel: vi.fn((channel: AudioChannel) => {
      callbacks[channel] = null;
    }),
    stopAllChannels: vi.fn(),
    setChannelVolume: vi.fn(),
    setBusVolume: vi.fn(),
    getBusVolume: vi.fn(() => 1.0),
    isChannelPlaying: vi.fn(() => false),
    onChannelComplete: vi.fn((channel: AudioChannel, cb: () => void) => {
      callbacks[channel] = cb;
    }),
    playVoiceSequence: vi.fn(),
    cancelVoiceSequence: vi.fn(),
    onVoiceSequenceComplete: vi.fn(),
    seekChannelRandom: vi.fn(),
    getAudioDevices: vi.fn(() => []),
    setAudioDevice: vi.fn(() => true),
    _triggerChannelEnd: (channel: AudioChannel) => {
      const cb = callbacks[channel];
      callbacks[channel] = null;
      cb?.();
    },
    _played: played,
  } as unknown as FakeAudio;
}

const VOICE = "luca";

const PIT_STATUS_CLIP_NAMES = [
  "in-progress-01",
  "complete-01",
  "too-far-left-01",
  "too-far-right-01",
  "too-far-forward-01",
  "too-far-back-01",
  "bad-angle-01",
  "cant-fix-that-01",
] as const;

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...PIT_STATUS_CLIP_NAMES.map((name) => `voice/${VOICE}/pit-status/${name}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

function voiceClipsPlayed(audio: FakeAudio): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;

describe("PIT_STATUS_ALERTS structure", () => {
  it("defines exactly 8 scenarios — one per non-`None` PitSvStatus value", () => {
    expect(PIT_STATUS_ALERTS).toHaveLength(8);
  });

  it("ids are unique and stable", () => {
    expect(PIT_STATUS_SCENARIO_IDS).toEqual([
      "pit-crew.pit-status-in-progress",
      "pit-crew.pit-status-complete",
      "pit-crew.pit-status-too-far-left",
      "pit-crew.pit-status-too-far-right",
      "pit-crew.pit-status-too-far-forward",
      "pit-crew.pit-status-too-far-back",
      "pit-crew.pit-status-bad-angle",
      "pit-crew.pit-status-cant-fix-that",
    ]);
    expect(new Set(PIT_STATUS_SCENARIO_IDS).size).toBe(PIT_STATUS_SCENARIO_IDS.length);
  });

  it("every scenario shares family 'pit-status' and uses the default weight", () => {
    for (const s of PIT_STATUS_ALERTS) {
      expect(s.family).toBe("pit-status");
      // default weight band (WEIGHT.NORMAL) — left unset
      expect(s.weight).toBeUndefined();
      expect(s.interrupt).not.toBe(true);
    }
  });

  it("every scenario uses the per-voice base path", () => {
    for (const s of PIT_STATUS_ALERTS) {
      expect(s.base).toBe("voice/{voice}");
    }
  });

  it("every pool name has a POOL_REGISTRY entry sourced from the pit-status group", () => {
    for (const name of PIT_STATUS_POOL_NAMES) {
      expect(POOL_REGISTRY[name]).toBeDefined();
      expect(POOL_REGISTRY[name].group).toBe("pit-status");
      expect(POOL_REGISTRY[name].base.length).toBeGreaterThan(0);
    }
  });
});

describe("PIT_STATUS_ALERTS triggers (engine-level, no opt-out gating)", () => {
  beforeEach(() => {
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

    for (const name of PIT_STATUS_POOL_NAMES) {
      const { group, base } = POOL_REGISTRY[name];
      engine.definePoolFromManifest(name, group, base);
    }

    engine.defineScenario(RADIO_OPEN);
    engine.defineScenario(RADIO_CLOSE);

    for (const s of PIT_STATUS_ALERTS) engine.defineScenario(s);
  });

  afterEach(() => {
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  it.each([
    { to: PitSvStatus.InProgress, expected: `voice/${VOICE}/pit-status/in-progress-01.mp3` },
    { to: PitSvStatus.Complete, expected: `voice/${VOICE}/pit-status/complete-01.mp3` },
    { to: PitSvStatus.TooFarLeft, expected: `voice/${VOICE}/pit-status/too-far-left-01.mp3` },
    { to: PitSvStatus.TooFarRight, expected: `voice/${VOICE}/pit-status/too-far-right-01.mp3` },
    { to: PitSvStatus.TooFarForward, expected: `voice/${VOICE}/pit-status/too-far-forward-01.mp3` },
    { to: PitSvStatus.TooFarBack, expected: `voice/${VOICE}/pit-status/too-far-back-01.mp3` },
    { to: PitSvStatus.BadAngle, expected: `voice/${VOICE}/pit-status/bad-angle-01.mp3` },
    { to: PitSvStatus.CantFixThat, expected: `voice/${VOICE}/pit-status/cant-fix-that-01.mp3` },
  ])("to=$to fires the matching clip", ({ to, expected }) => {
    bus.publishEvent("pitService.statusChanged", { from: PitSvStatus.None, to });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([expected]);
  });

  it("a non-matching `to` value does not fire the InProgress scenario", () => {
    // Filter by `data.to` — a Complete event must not pick the InProgress clip.
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.InProgress,
      to: PitSvStatus.Complete,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).not.toContain(`voice/${VOICE}/pit-status/in-progress-01.mp3`);
  });

  it("rapid positioning correction (TooFarLeft → TooFarRight) ends with the latter clip (same-family preempt)", () => {
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.None,
      to: PitSvStatus.TooFarLeft,
    });
    // Don't flush — TooFarLeft is still mid-playback. The follow-up event
    // should preempt via the shared `family: "pit-status"`.
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.TooFarLeft,
      to: PitSvStatus.TooFarRight,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio).at(-1)).toBe(`voice/${VOICE}/pit-status/too-far-right-01.mp3`);
  });
});

describe("PIT_STATUS_ALERTS per-callout opt-out (via registerPitCrew)", () => {
  let enabled: Map<PitStatusCalloutId, boolean>;

  beforeEach(() => {
    enabled = new Map<PitStatusCalloutId, boolean>([
      ["in-progress", true],
      ["complete", true],
      ["too-far-left", true],
      ["too-far-right", true],
      ["too-far-forward", true],
      ["too-far-back", true],
      ["bad-angle", true],
      ["cant-fix-that", true],
    ]);
    bus = createMockBus();
    audio = createFakeAudio();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    registerPitCrew(
      bus,
      () => true, // flag callouts not exercised here
      mockLogger as never,
      () => true, // pit-readback
      () => true, // pit-actions cooldown
      () => true, // pit-service requests
      () => null, // readback snapshot resolver
      () => true, // damage callouts
      (id) => enabled.get(id) ?? true,
    );
  });

  afterEach(() => {
    _resetAudioScenarios();
    _resetRadarEngine();
    _resetSpotterEngine();
    vi.clearAllMocks();
  });

  it("disabling a single status suppresses only that callout", () => {
    enabled.set("too-far-left", false);
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.None,
      to: PitSvStatus.TooFarLeft,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);

    // Other ids still fire.
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.None,
      to: PitSvStatus.TooFarRight,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/too-far-right-01.mp3`]);
  });

  it("disabling all suppresses every callout", () => {
    for (const id of enabled.keys()) enabled.set(id, false);

    for (const to of [
      PitSvStatus.InProgress,
      PitSvStatus.Complete,
      PitSvStatus.TooFarLeft,
      PitSvStatus.TooFarRight,
      PitSvStatus.TooFarForward,
      PitSvStatus.TooFarBack,
      PitSvStatus.BadAngle,
      PitSvStatus.CantFixThat,
    ]) {
      bus.publishEvent("pitService.statusChanged", { from: PitSvStatus.None, to });
    }

    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);
  });

  it("re-enabling restores firing on the next event", () => {
    enabled.set("complete", false);
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.InProgress,
      to: PitSvStatus.Complete,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);

    enabled.set("complete", true);
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.InProgress,
      to: PitSvStatus.Complete,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/complete-01.mp3`]);
  });
});
