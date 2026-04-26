import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { FLAG_ALERTS, FLAG_POOL_NAMES, FLAG_SCENARIO_IDS } from "./flag-alerts.js";
import { POOLS } from "./pools.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";

const mockSessionType = vi.fn(() => "Race");

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
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

const VOICE_KEYS = ["luca", "titan"] as const;

const FLAG_CLIP_NAMES = [
  "yellow-local-01",
  "yellow-full-01",
  "yellow-cleared-01",
  "green-01",
  "green-02",
  "blue-01",
  "blue-02",
  "white-01",
  "white-02",
  "red-01",
  "black-01",
  "checkered-practise-01",
  "checkered-qualifying-01",
  "checkered-race-01",
  "debris-01",
  "meatball-01",
] as const;

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...VOICE_KEYS.flatMap((v) => FLAG_CLIP_NAMES.map((name) => `voice/${v}/flags/${name}.mp3`)),
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
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => activeVoice);

  for (const name of FLAG_POOL_NAMES) engine.definePool(name, [...POOLS[name]]);

  engine.defineScenario(RADIO_OPEN);
  engine.defineScenario(RADIO_CLOSE);

  for (const s of FLAG_ALERTS) engine.defineScenario(s);
});

afterEach(() => {
  _resetAudioScenarios();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function sfxClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.SFX).map((p) => p.path);
}

function findScenario(id: string): SimEventOf<SimEventName> extends never ? never : (typeof FLAG_ALERTS)[number] {
  const s = FLAG_ALERTS.find((x) => x.id === id);

  if (!s) throw new Error(`No flag scenario with id "${id}"`);

  return s;
}

describe("FLAG_ALERTS structure", () => {
  it("defines 11 scenarios", () => {
    expect(FLAG_ALERTS).toHaveLength(11);
  });

  it("exposes a stable list of ids", () => {
    expect(FLAG_SCENARIO_IDS).toEqual([
      "pit-crew.flag-yellow-local",
      "pit-crew.flag-yellow-full",
      "pit-crew.flag-yellow-cleared",
      "pit-crew.flag-green",
      "pit-crew.flag-blue",
      "pit-crew.flag-white",
      "pit-crew.flag-red",
      "pit-crew.flag-black",
      "pit-crew.flag-checkered",
      "pit-crew.flag-debris",
      "pit-crew.flag-meatball",
    ]);
  });

  it("ids are unique", () => {
    expect(new Set(FLAG_SCENARIO_IDS).size).toBe(FLAG_SCENARIO_IDS.length);
  });

  it("non-meatball scenarios share family 'flag' and use priority 'normal'", () => {
    for (const s of FLAG_ALERTS) {
      if (s.id === "pit-crew.flag-meatball") continue;

      expect(s.family).toBe("flag");
      expect(s.priority).toBe("normal");
      expect(s.preempt).not.toBe(true);
    }
  });

  it("meatball is urgent + preempt + outside the flag family", () => {
    const meatball = findScenario("pit-crew.flag-meatball");

    expect(meatball.priority).toBe("urgent");
    expect(meatball.preempt).toBe(true);
    expect(meatball.family).toBeUndefined();
  });

  it("every scenario uses the per-voice base path", () => {
    for (const s of FLAG_ALERTS) {
      expect(s.base).toBe("voice/{voice}");
    }
  });
});

describe("FLAG_ALERTS triggers", () => {
  it.each([
    {
      label: "yellow local",
      event: "flag.yellow.raised" as const,
      data: { scope: "local" as const },
      expected: "voice/luca/flags/yellow-local-01.mp3",
    },
    {
      label: "yellow full",
      event: "flag.yellow.raised" as const,
      data: { scope: "full" as const },
      expected: "voice/luca/flags/yellow-full-01.mp3",
    },
    {
      label: "yellow cleared",
      event: "flag.yellow.cleared" as const,
      data: {},
      expected: "voice/luca/flags/yellow-cleared-01.mp3",
    },
    {
      label: "red",
      event: "flag.red.raised" as const,
      data: {},
      expected: "voice/luca/flags/red-01.mp3",
    },
    {
      label: "black",
      event: "flag.black.raised" as const,
      data: {},
      expected: "voice/luca/flags/black-01.mp3",
    },
    {
      label: "debris",
      event: "flag.debris.raised" as const,
      data: {},
      expected: "voice/luca/flags/debris-01.mp3",
    },
    {
      label: "meatball",
      event: "flag.meatball.raised" as const,
      data: {},
      expected: "voice/luca/flags/meatball-01.mp3",
    },
  ])("$label fires the matching clip", ({ event, data, expected }) => {
    bus.publishEvent(event, data as never);
    flush(audio);

    expect(voiceClipsPlayed()).toContain(expected);
  });

  it("yellow.raised with scope='local' does NOT play the full-yellow clip", () => {
    bus.publishEvent("flag.yellow.raised", { scope: "local" });
    flush(audio);

    expect(voiceClipsPlayed()).not.toContain("voice/luca/flags/yellow-full-01.mp3");
  });

  it("yellow.raised with scope='full' does NOT play the local-yellow clip", () => {
    bus.publishEvent("flag.yellow.raised", { scope: "full" });
    flush(audio);

    expect(voiceClipsPlayed()).not.toContain("voice/luca/flags/yellow-local-01.mp3");
  });

  it("blue draws from the flag-blue pool (one of the two recorded variants)", () => {
    bus.publishEvent("flag.blue.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played.includes("voice/luca/flags/blue-01.mp3") || played.includes("voice/luca/flags/blue-02.mp3")).toBe(
      true,
    );
  });

  it("green draws from the flag-green pool (one of the two recorded variants)", () => {
    bus.publishEvent("flag.green.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played.includes("voice/luca/flags/green-01.mp3") || played.includes("voice/luca/flags/green-02.mp3")).toBe(
      true,
    );
  });

  it("white draws from the flag-white pool (one of the two recorded variants)", () => {
    bus.publishEvent("flag.white.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played.includes("voice/luca/flags/white-01.mp3") || played.includes("voice/luca/flags/white-02.mp3")).toBe(
      true,
    );
  });

  it("substitutes the active voice — switching voice changes resolved path", () => {
    activeVoice = "titan";
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/titan/flags/red-01.mp3");
  });

  it("wraps the callout in the radio frame (open + close ticks on the SFX channel)", () => {
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    const sfx = sfxClipsPlayed();
    expect(sfx).toContain("sfx/IRD-tick-open.mp3");
    expect(sfx).toContain("sfx/IRD-tick-close.mp3");
  });
});

describe("FLAG_ALERTS checkered session-type branch", () => {
  it.each([
    { sessionType: "Race", expected: "voice/luca/flags/checkered-race-01.mp3" },
    { sessionType: "Practice", expected: "voice/luca/flags/checkered-practise-01.mp3" },
    { sessionType: "Open Qualify", expected: "voice/luca/flags/checkered-qualifying-01.mp3" },
    { sessionType: "Lone Qualify", expected: "voice/luca/flags/checkered-qualifying-01.mp3" },
    { sessionType: "", expected: "voice/luca/flags/checkered-race-01.mp3" },
    { sessionType: "Some Unknown", expected: "voice/luca/flags/checkered-race-01.mp3" },
  ])("$sessionType session → $expected", ({ sessionType, expected }) => {
    mockSessionType.mockReturnValue(sessionType);
    bus.publishEvent("flag.checkered.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toContain(expected);
  });
});

describe("FLAG_ALERTS preemption", () => {
  // The Voice channel only sees flag voice clips in these tests (the
  // radio frame uses SFX + Ambient channels). So `voiceClipsPlayed()`
  // is the chronological list of flag callouts; asserting on the last
  // entry proves the second event's callout is what the engineer
  // ultimately settles on, not just one of several lines that played.
  function lastVoiceClip(): string | undefined {
    return voiceClipsPlayed().at(-1);
  }

  it("meatball preempts an in-flight non-meatball flag callout", () => {
    bus.publishEvent("flag.yellow.raised", { scope: "local" });
    // Don't flush — local yellow is still mid-playback.
    bus.publishEvent("flag.meatball.raised", {});
    flush(audio);

    expect(lastVoiceClip()).toBe("voice/luca/flags/meatball-01.mp3");
  });

  it("a newer non-meatball flag preempts a previous one (family share)", () => {
    bus.publishEvent("flag.yellow.cleared", {});
    // Same tick: red.raised arrives. Red uses a single-clip pool so
    // the assertion stays deterministic regardless of multi-variant
    // pool rotation order.
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    expect(lastVoiceClip()).toBe("voice/luca/flags/red-01.mp3");
  });
});

describe("FLAG_POOL_NAMES", () => {
  it("lists every flag pool that pools.ts defines for flag scenarios", () => {
    expect(FLAG_POOL_NAMES).toEqual([
      "flag-yellow-local",
      "flag-yellow-full",
      "flag-yellow-cleared",
      "flag-green",
      "flag-blue",
      "flag-white",
      "flag-red",
      "flag-black",
      "flag-debris",
      "flag-meatball",
      "flag-checkered-practise",
      "flag-checkered-qualifying",
      "flag-checkered-race",
    ]);
  });

  it("every name has a non-empty pool entry in POOLS", () => {
    for (const name of FLAG_POOL_NAMES) {
      expect(POOLS[name]).toBeDefined();
      expect(POOLS[name].length).toBeGreaterThan(0);
    }
  });
});
