import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { POOLS } from "./pools.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";
import { FUEL_TOGGLE_SCENARIOS, TIRE_COMPOUND_SCENARIOS, TIRE_TOGGLE_SCENARIOS } from "./toggle-confirmations.js";

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

const VOICE_KEYS = ["luca", "titan"] as const;

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...VOICE_KEYS.flatMap((v) => [
      `voice/${v}/acknowledgment/okay.mp3`,
      `voice/${v}/acknowledgment/got-it.mp3`,
      `voice/${v}/acknowledgment/roger-that.mp3`,
      `voice/${v}/acknowledgment/copy-that.mp3`,
      `voice/${v}/acknowledgment/we-got-that.mp3`,
      `voice/${v}/pit-actions/got-it.mp3`,
      `voice/${v}/pit-actions/roger-that.mp3`,
      `voice/${v}/pit-actions/copy-that.mp3`,
      `voice/${v}/pit-actions/fuel-on-01.mp3`,
      `voice/${v}/pit-actions/fuel-off-01.mp3`,
      `voice/${v}/pit-actions/tires-off-01.mp3`,
      `voice/${v}/pit-actions/tires-on-all.mp3`,
      `voice/${v}/pit-actions/tires-on-fronts.mp3`,
      `voice/${v}/pit-actions/tires-on-rears.mp3`,
      `voice/${v}/pit-actions/tires-on-lefts.mp3`,
      `voice/${v}/pit-actions/tires-on-rights.mp3`,
      `voice/${v}/pit-actions/tires-on-lf.mp3`,
      `voice/${v}/pit-actions/tires-on-rf.mp3`,
      `voice/${v}/pit-actions/tires-on-lr.mp3`,
      `voice/${v}/pit-actions/tires-on-rr.mp3`,
      `voice/${v}/pit-actions/tires-on-lf-rr.mp3`,
      `voice/${v}/pit-actions/tires-on-rf-lr.mp3`,
      `voice/${v}/pit-actions/tires-on-skip-lf.mp3`,
      `voice/${v}/pit-actions/tires-on-skip-rf.mp3`,
      `voice/${v}/pit-actions/tires-on-skip-lr.mp3`,
      `voice/${v}/pit-actions/tires-on-skip-rr.mp3`,
      `voice/${v}/pit-actions/tires-compound-dry.mp3`,
      `voice/${v}/pit-actions/tires-compound-wet.mp3`,
    ]),
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

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;
let activeVoice: string;

beforeEach(() => {
  activeVoice = "luca";
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => activeVoice);

  engine.definePool("pit-action-acknowledgment", [...POOLS["pit-action-acknowledgment"]]);
  engine.definePool("pit-action-fuel-on", [...POOLS["pit-action-fuel-on"]]);
  engine.definePool("pit-action-fuel-off", [...POOLS["pit-action-fuel-off"]]);
  engine.definePool("pit-action-tires-off", [...POOLS["pit-action-tires-off"]]);
  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  for (const s of FUEL_TOGGLE_SCENARIOS) engine.defineScenario(s);

  for (const s of TIRE_TOGGLE_SCENARIOS) engine.defineScenario(s);

  for (const s of TIRE_COMPOUND_SCENARIOS) engine.defineScenario(s);
});

afterEach(() => {
  _resetAudioScenarios();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

describe("FUEL_TOGGLE_SCENARIOS", () => {
  it("fires fuel-on when pitService.toggled { fuel, on: true } and resolves voice/{voice}", () => {
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/fuel-on-01.mp3");
  });

  it("fires fuel-off when pitService.toggled { fuel, on: false }", () => {
    bus.publishEvent("pitService.toggled", { service: "fuel", on: false });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/fuel-off-01.mp3");
  });

  it("ignores pitService.toggled for other services (windshield)", () => {
    bus.publishEvent("pitService.toggled", { service: "windshield", on: true });
    flush(audio);

    // None of the registered fuel scenarios should match.
    expect(voiceClipsPlayed()).not.toContain("voice/luca/pit-actions/fuel-on-01.mp3");
    expect(voiceClipsPlayed()).not.toContain("voice/luca/pit-actions/fuel-off-01.mp3");
  });

  it("substitutes the active voice — switching voice changes resolved path", () => {
    activeVoice = "titan";
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/titan/pit-actions/fuel-on-01.mp3");
  });
});

describe("TIRE_TOGGLE_SCENARIOS", () => {
  // Coverage is exhaustive across the 15 non-empty 4-corner combinations.
  // The empty-set case is exercised separately below via TIRE_OFF_SCENARIO.
  it.each([
    // Standard 5
    { name: "all", current: ["LF", "RF", "LR", "RR"] },
    { name: "fronts", current: ["LF", "RF"] },
    { name: "rears", current: ["LR", "RR"] },
    { name: "lefts", current: ["LF", "LR"] },
    { name: "rights", current: ["RF", "RR"] },
    // Singles
    { name: "lf", current: ["LF"] },
    { name: "rf", current: ["RF"] },
    { name: "lr", current: ["LR"] },
    { name: "rr", current: ["RR"] },
    // Diagonals
    { name: "lf-rr", current: ["LF", "RR"] },
    { name: "rf-lr", current: ["RF", "LR"] },
    // Three-corner combos (skip the named tire)
    { name: "skip-rr", current: ["LF", "RF", "LR"] },
    { name: "skip-lr", current: ["LF", "RF", "RR"] },
    { name: "skip-rf", current: ["LF", "LR", "RR"] },
    { name: "skip-lf", current: ["RF", "LR", "RR"] },
  ])("plays $name set callout for current=$current", ({ name, current }) => {
    bus.publishEvent("tireService.changed", { added: current, removed: [], current });
    flush(audio);

    expect(voiceClipsPlayed()).toContain(`voice/luca/pit-actions/tires-on-${name}.mp3`);
  });

  it("plays tires-off only when current set is empty", () => {
    bus.publishEvent("tireService.changed", {
      added: [],
      removed: ["LF", "RF", "LR", "RR"],
      current: [],
    });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/tires-off-01.mp3");
  });

  it("does NOT play tires-off on a side-switch that removes some tires (lefts → rights via clear-all event)", () => {
    // Going from [LF,RF,LR,RR] to [LR,RR] in one tick: deltas show only
    // removals, but `current` is non-empty so this is a switch to "rears",
    // not a full clear.
    bus.publishEvent("tireService.changed", {
      added: [],
      removed: ["LF", "RF"],
      current: ["LR", "RR"],
    });
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played).not.toContain("voice/luca/pit-actions/tires-off-01.mp3");
    expect(played).toContain("voice/luca/pit-actions/tires-on-rears.mp3");
  });

  it("plays the matching set when a side-switch lands on a known pattern (fronts → lefts)", () => {
    bus.publishEvent("tireService.changed", {
      added: ["LR"],
      removed: ["RF"],
      current: ["LF", "LR"],
    });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/tires-on-lefts.mp3");
  });
});

describe("TIRE_COMPOUND_SCENARIOS", () => {
  it("fires the dry-compound callout when to=0", () => {
    bus.publishEvent("tireService.compoundChanged", { from: 1, to: 0 });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/tires-compound-dry.mp3");
  });

  it("fires the wet-compound callout when to=1", () => {
    bus.publishEvent("tireService.compoundChanged", { from: 0, to: 1 });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/tires-compound-wet.mp3");
  });

  it("substitutes the active voice for compound switches", () => {
    activeVoice = "titan";
    bus.publishEvent("tireService.compoundChanged", { from: 0, to: 1 });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/titan/pit-actions/tires-compound-wet.mp3");
  });
});
