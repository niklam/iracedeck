/**
 * Live-gating tests for `registerPitCrew(bus, getFlagCalloutEnabled)`.
 *
 * Issue #467 ships per-flag opt-in toggles persisted to plugin-global
 * settings. The plugins pass a closure into `registerPitCrew` that
 * reads the live setting cache, so the user's choice takes effect on
 * the very next event of that color — and crucially, never cuts a
 * callout that is already playing, because the gate runs at event
 * arrival (before `attemptFire`).
 *
 * These tests pin that behavior:
 *   - disabled flag → no fire
 *   - mid-clip toggle off → in-flight clip completes; next event suppressed
 *   - toggle back on → next event fires again
 *   - existing scope `where:` predicates still work for yellow-local /
 *     yellow-full when the flag is enabled
 *   - logger.debug is called on each suppressed event (debuggable
 *     "engineer didn't say green!" reports)
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { type FlagCalloutId, registerPitCrew } from "./index.js";
import { _resetRadarEngine } from "./radar-engine.js";

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

const VOICE = "luca";

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
  "debris-02",
  "debris-03",
  "meatball-01",
] as const;

// Ack pool clips (used by toggle confirmations). Test only fires flag
// events, so these are present in the manifest just to satisfy
// validation when scenarios reference them via `pool:acknowledgment`.
const ACK_CLIP_NAMES = [
  "ack-01",
  "ack-02",
  "ack-03",
  "ack-04",
  "ack-05",
  "ack-06",
  "ack-07",
  "ack-08",
  "ack-09",
  "ack-10",
] as const;

const TOGGLE_ON_CLIP_NAMES = [
  "fuel-fill-on-01",
  "fuel-fill-off-01",
  "tire-fl-only-01",
  "tire-fr-only-01",
  "tire-rl-only-01",
  "tire-rr-only-01",
  "tire-front-01",
  "tire-rear-01",
  "tire-left-01",
  "tire-right-01",
  "tire-diag-fl-rr-01",
  "tire-diag-fr-rl-01",
  "tire-three-not-fl-01",
  "tire-three-not-fr-01",
  "tire-three-not-rl-01",
  "tire-three-not-rr-01",
  "tire-all-01",
  "tire-none-01",
  "tire-compound-dry-01",
  "tire-compound-wet-01",
] as const;

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...FLAG_CLIP_NAMES.map((name) => `voice/${VOICE}/flags/${name}.mp3`),
    ...ACK_CLIP_NAMES.map((name) => `voice/${VOICE}/ack/${name}.mp3`),
    ...TOGGLE_ON_CLIP_NAMES.map((name) => `voice/${VOICE}/toggles/${name}.mp3`),
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

const ALL_FLAG_IDS: readonly FlagCalloutId[] = [
  "yellow-local",
  "yellow-full",
  "yellow-cleared",
  "green",
  "blue",
  "white",
  "red",
  "black",
  "checkered",
  "debris",
  "meatball",
];

function makeEnabledMap(initial: boolean): Map<FlagCalloutId, boolean> {
  return new Map<FlagCalloutId, boolean>(ALL_FLAG_IDS.map((id) => [id, initial]));
}

let enabled: Map<FlagCalloutId, boolean>;

beforeEach(() => {
  enabled = makeEnabledMap(true);
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, (id) => enabled.get(id) ?? true, mockLogger as never);
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  vi.clearAllMocks();
});

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

const FLAG_FIRES: ReadonlyArray<{
  id: FlagCalloutId;
  event: SimEventName;
  data: SimEventMap[SimEventName]["data"];
  expectedClipFragment: string;
}> = [
  {
    id: "yellow-local",
    event: "flag.yellow.raised",
    data: { scope: "local" } as SimEventMap["flag.yellow.raised"]["data"],
    expectedClipFragment: "yellow-local",
  },
  {
    id: "yellow-full",
    event: "flag.yellow.raised",
    data: { scope: "full" } as SimEventMap["flag.yellow.raised"]["data"],
    expectedClipFragment: "yellow-full",
  },
  {
    id: "yellow-cleared",
    event: "flag.yellow.cleared",
    data: {} as SimEventMap["flag.yellow.cleared"]["data"],
    expectedClipFragment: "yellow-cleared",
  },
  {
    id: "green",
    event: "flag.green.raised",
    data: {} as SimEventMap["flag.green.raised"]["data"],
    expectedClipFragment: "green-",
  },
  {
    id: "blue",
    event: "flag.blue.raised",
    data: {} as SimEventMap["flag.blue.raised"]["data"],
    expectedClipFragment: "blue-",
  },
  {
    id: "white",
    event: "flag.white.raised",
    data: {} as SimEventMap["flag.white.raised"]["data"],
    expectedClipFragment: "white-",
  },
  {
    id: "red",
    event: "flag.red.raised",
    data: {} as SimEventMap["flag.red.raised"]["data"],
    expectedClipFragment: "red-",
  },
  {
    id: "black",
    event: "flag.black.raised",
    data: {} as SimEventMap["flag.black.raised"]["data"],
    expectedClipFragment: "black-",
  },
  {
    id: "checkered",
    event: "flag.checkered.raised",
    data: {} as SimEventMap["flag.checkered.raised"]["data"],
    expectedClipFragment: "checkered-",
  },
  {
    id: "debris",
    event: "flag.debris.raised",
    data: {} as SimEventMap["flag.debris.raised"]["data"],
    expectedClipFragment: "debris-",
  },
  {
    id: "meatball",
    event: "flag.meatball.raised",
    data: {} as SimEventMap["flag.meatball.raised"]["data"],
    expectedClipFragment: "meatball-",
  },
];

describe("registerPitCrew live gating", () => {
  it.each(FLAG_FIRES)("$id fires when enabled", ({ event, data, expectedClipFragment }) => {
    bus.publishEvent(event, data as never);
    flush(audio);

    const matched = voiceClipsPlayed().some((p) => p.includes(expectedClipFragment));
    expect(matched).toBe(true);
  });

  it.each(FLAG_FIRES)("$id is suppressed when its toggle is off", ({ id, event, data }) => {
    enabled.set(id, false);
    bus.publishEvent(event, data as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line each time a flag is suppressed", () => {
    enabled.set("debris", false);
    bus.publishEvent("flag.debris.raised", {} as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("flag callout suppressed: debris");
  });

  it("toggling a flag off mid-clip does not cut the in-flight callout", () => {
    bus.publishEvent("flag.red.raised", {} as never);
    // Don't flush — red is still mid-playback (radio open + voice + radio close).
    const playsBeforeToggle = audio._played.length;
    expect(playsBeforeToggle).toBeGreaterThan(0);

    // User unchecks Red while it is playing.
    enabled.set("red", false);

    // Drain the in-flight sequence — gate fires only on event arrival,
    // so the already-fired sequence completes naturally.
    flush(audio);

    expect(voiceClipsPlayed()).toContain(`voice/${VOICE}/flags/red-01.mp3`);
  });

  it("toggling a flag off only blocks future fires; the previous one finishes", () => {
    // First red fires and is allowed to play.
    bus.publishEvent("flag.red.raised", {} as never);
    flush(audio);
    const playsAfterFirst = voiceClipsPlayed().length;
    expect(playsAfterFirst).toBe(1);

    // User disables red. A subsequent red event is gated.
    enabled.set("red", false);
    bus.publishEvent("flag.red.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed().length).toBe(playsAfterFirst);
  });

  it("re-enabling a flag restores future fires", () => {
    enabled.set("debris", false);
    bus.publishEvent("flag.debris.raised", {} as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    enabled.set("debris", true);
    bus.publishEvent("flag.debris.raised", {} as never);
    flush(audio);
    const played = voiceClipsPlayed();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(new RegExp(`^voice/${VOICE}/flags/debris-0[123]\\.mp3$`));
  });

  it("yellow scope predicate still works when both yellow flags are enabled", () => {
    bus.publishEvent("flag.yellow.raised", { scope: "full" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/flags/yellow-full-01.mp3`]);
  });

  it("disabling yellow-local does not affect yellow-full", () => {
    enabled.set("yellow-local", false);
    bus.publishEvent("flag.yellow.raised", { scope: "full" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/flags/yellow-full-01.mp3`]);
  });

  it("disabling yellow-full does not affect yellow-local", () => {
    enabled.set("yellow-full", false);
    bus.publishEvent("flag.yellow.raised", { scope: "local" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/flags/yellow-local-01.mp3`]);
  });

  it("disabling meatball means no preemption — an in-flight non-meatball flag survives", () => {
    bus.publishEvent("flag.yellow.cleared", {} as never);
    // Don't flush — yellow-cleared is mid-playback.
    enabled.set("meatball", false);
    bus.publishEvent("flag.meatball.raised", {} as never);
    flush(audio);

    // yellow-cleared completed; no meatball ever played.
    const played = voiceClipsPlayed();
    expect(played).toContain(`voice/${VOICE}/flags/yellow-cleared-01.mp3`);
    expect(played.some((p) => p.includes("meatball"))).toBe(false);
  });
});
