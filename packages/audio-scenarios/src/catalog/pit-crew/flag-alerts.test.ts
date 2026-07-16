import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { Flags } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import {
  _setFurledRaisedSpoken,
  FLAG_ALERTS,
  FLAG_POOL_NAMES,
  FLAG_SCENARIO_IDS,
  WAVING_FLAG_COOLDOWN_MS,
} from "./flag-alerts.js";
import { POOL_REGISTRY } from "./pools.js";
import { RADIO_CLOSE, RADIO_OPEN } from "./radio-frame.js";

const mockSessionType = vi.fn(() => "Race");
const mockStandingStart = vi.fn(() => false);
// Live-telemetry feed for the furled speak-time gate (issue #669). `null`
// (the default) means "no live signal", which the gate treats as still-up.
const mockLatestTelemetry = vi.fn((): unknown => null);

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
  getStandingStart: () => mockStandingStart(),
  getLatestTelemetry: () => mockLatestTelemetry(),
}));

// Default telemetry attached to published events: driver live in the car. The
// race-formation flags gate on `isLiveOnTrack` (issue #480 follow-up), so events
// need in-car telemetry to fire; out-of-car tests pass an override.
const IN_CAR = { IsOnTrack: true, IsReplayPlaying: false };

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
  publishEvent: <T extends SimEventName>(name: T, data: SimEventMap[T]["data"], telemetry?: unknown) => void;
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
    publishEvent<T extends SimEventName>(name: T, data: SimEventMap[T]["data"], telemetry: unknown = IN_CAR) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry,
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
  "green-practice-01",
  "green-qualifying-01",
  "green-race-01",
  "green-race-02",
  "blue-01",
  "blue-02",
  "white-practice-01",
  "white-qualifying-01",
  "white-race-01",
  "white-race-02",
  "white-last-lap-01",
  "white-last-lap-02",
  "red-01",
  "black-01",
  "checkered-practice-01",
  "checkered-qualifying-01",
  "checkered-race-01",
  "debris-01",
  "debris-02",
  "debris-03",
  "meatball-01",
  // Issue #480 — missing-session-flag callouts.
  "disqualify-01",
  "furled-01",
  "furled-cleared-01",
  "dq-scoring-invalid-01",
  "crossed-01",
  "one-pace-lap-to-go-01",
  "one-pace-lap-to-go-02",
  "one-pace-lap-to-go-03",
  "one-pace-lap-to-go-04",
  "one-pace-lap-to-go-05",
  "green-held-01",
  "green-held-02",
  "green-held-03",
  "green-held-04",
  "green-held-05",
  "ten-to-go-01",
  "five-to-go-01",
  "yellow-waving-01",
  "caution-waving-01",
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
  mockStandingStart.mockReturnValue(false);
  mockLatestTelemetry.mockReturnValue(null);
  _setFurledRaisedSpoken(false);
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => activeVoice);

  for (const name of FLAG_POOL_NAMES) {
    const { group, base } = POOL_REGISTRY[name];
    engine.definePoolFromManifest(name, group, base);
  }

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

function findScenario(id: string): (typeof FLAG_ALERTS)[number] {
  const s = FLAG_ALERTS.find((x) => x.id === id);

  if (!s) throw new Error(`No flag scenario with id "${id}"`);

  return s;
}

describe("FLAG_ALERTS structure", () => {
  it("defines 23 scenarios", () => {
    expect(FLAG_ALERTS).toHaveLength(23);
  });

  it("exposes a stable list of ids", () => {
    expect(FLAG_SCENARIO_IDS).toEqual([
      "pit-crew.flag-yellow-local",
      "pit-crew.flag-yellow-full",
      "pit-crew.flag-yellow-cleared",
      "pit-crew.flag-green",
      "pit-crew.flag-blue",
      "pit-crew.flag-white",
      "pit-crew.flag-white-last-lap",
      "pit-crew.flag-red",
      "pit-crew.flag-black",
      "pit-crew.flag-checkered",
      "pit-crew.flag-debris",
      "pit-crew.flag-meatball",
      "pit-crew.flag-disqualify",
      "pit-crew.flag-furled",
      "pit-crew.flag-furled-cleared",
      "pit-crew.flag-dq-scoring-invalid",
      "pit-crew.flag-crossed",
      "pit-crew.flag-one-pace-lap-to-go",
      "pit-crew.flag-green-held",
      "pit-crew.flag-ten-to-go",
      "pit-crew.flag-five-to-go",
      "pit-crew.flag-yellow-waving",
      "pit-crew.flag-caution-waving",
    ]);
  });

  it("ids are unique", () => {
    expect(new Set(FLAG_SCENARIO_IDS).size).toBe(FLAG_SCENARIO_IDS.length);
  });

  it("non-meatball scenarios share family 'flag' and sit in the SAFETY weight band", () => {
    for (const s of FLAG_ALERTS) {
      if (s.id === "pit-crew.flag-meatball") continue;

      expect(s.family).toBe("flag");
      expect(s.weight).toBe(WEIGHT.SAFETY);
      expect(s.interrupt).not.toBe(true);
    }
  });

  it("meatball is CRITICAL weight + interrupt + outside the flag family", () => {
    const meatball = findScenario("pit-crew.flag-meatball");

    expect(meatball.weight).toBe(WEIGHT.CRITICAL);
    expect(meatball.interrupt).toBe(true);
    expect(meatball.family).toBeUndefined();
  });

  it("furled, furled-cleared, yellow-cleared and white-last-lap are queueable (defer behind a busy bus) — and they're the only flags that are", () => {
    const queueableIds = [
      "pit-crew.flag-furled",
      "pit-crew.flag-furled-cleared",
      "pit-crew.flag-yellow-cleared",
      // Issue #772: the last-lap crossing is one-shot and the translator
      // latch never re-fires, so a fire displaced by an equal-weight line
      // (spotter call) must replay at idle instead of being dropped.
      "pit-crew.flag-white-last-lap",
    ];

    for (const id of queueableIds) {
      expect(findScenario(id).queueable).toBe(true);
    }

    for (const s of FLAG_ALERTS) {
      if (queueableIds.includes(s.id)) continue;

      expect(s.queueable).not.toBe(true);
    }
  });

  // Issue #671 — iRacing re-raises the waving bits on every zone re-approach
  // while an incident persists; the 30 s cooldown collapses the repeats.
  it("the waving scenarios carry the 30 s cooldown — and they're the only flags that do", () => {
    const cooldownIds = ["pit-crew.flag-yellow-waving", "pit-crew.flag-caution-waving"];

    for (const id of cooldownIds) {
      expect(findScenario(id).cooldown).toBe(WAVING_FLAG_COOLDOWN_MS);
    }

    for (const s of FLAG_ALERTS) {
      if (cooldownIds.includes(s.id)) continue;

      expect(s.cooldown).toBeUndefined();
    }
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
      label: "meatball",
      event: "flag.meatball.raised" as const,
      data: {},
      expected: "voice/luca/flags/meatball-01.mp3",
    },
    {
      label: "disqualify",
      event: "flag.disqualify.raised" as const,
      data: {},
      expected: "voice/luca/flags/disqualify-01.mp3",
    },
    {
      label: "furled",
      event: "flag.furled.raised" as const,
      data: {},
      expected: "voice/luca/flags/furled-01.mp3",
    },
    {
      label: "furled cleared",
      event: "flag.furled.cleared" as const,
      data: {},
      expected: "voice/luca/flags/furled-cleared-01.mp3",
      // The cleared `where:` gates on the raised line having actually been
      // spoken (issue #669) — seed the marker as if it had.
      arrange: () => _setFurledRaisedSpoken(true),
    },
    {
      label: "dq-scoring-invalid",
      event: "flag.dq-scoring-invalid.raised" as const,
      data: {},
      expected: "voice/luca/flags/dq-scoring-invalid-01.mp3",
    },
    {
      label: "crossed",
      event: "flag.crossed.raised" as const,
      data: {},
      expected: "voice/luca/flags/crossed-01.mp3",
    },
    {
      label: "ten-to-go",
      event: "flag.ten-to-go.raised" as const,
      data: {},
      expected: "voice/luca/flags/ten-to-go-01.mp3",
    },
    {
      label: "five-to-go",
      event: "flag.five-to-go.raised" as const,
      data: {},
      expected: "voice/luca/flags/five-to-go-01.mp3",
    },
    {
      label: "yellow-waving",
      event: "flag.yellow-waving.raised" as const,
      data: {},
      expected: "voice/luca/flags/yellow-waving-01.mp3",
    },
    {
      label: "caution-waving",
      event: "flag.caution-waving.raised" as const,
      data: {},
      expected: "voice/luca/flags/caution-waving-01.mp3",
    },
  ])("$label fires the matching clip", ({ event, data, expected, ...row }) => {
    (row as { arrange?: () => void }).arrange?.();
    bus.publishEvent(event, data as never);
    flush(audio);

    // Strict equality (not toContain) so an accidental duplicate fire
    // or an extra voice clip in the sequence would surface here.
    expect(voiceClipsPlayed()).toEqual([expected]);
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

  it("green in a Race session draws from the flag-green-race pool (one of the two recorded variants)", () => {
    bus.publishEvent("flag.green.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(
      played.includes("voice/luca/flags/green-race-01.mp3") || played.includes("voice/luca/flags/green-race-02.mp3"),
    ).toBe(true);
  });

  it("white in a Race session draws from the flag-white-race pool (one of the two recorded variants)", () => {
    bus.publishEvent("flag.white.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(
      played.includes("voice/luca/flags/white-race-01.mp3") || played.includes("voice/luca/flags/white-race-02.mp3"),
    ).toBe(true);
  });

  it("debris draws from the flag-debris pool (one of the three recorded variants)", () => {
    bus.publishEvent("flag.debris.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/voice\/luca\/flags\/debris-0[123]\.mp3$/);
  });

  it("one-pace-lap-to-go draws from the flag-one-pace-lap-to-go pool (one of the five variants)", () => {
    mockSessionType.mockReturnValue("Race");
    bus.publishEvent("flag.one-pace-lap-to-go.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/voice\/luca\/flags\/one-pace-lap-to-go-0[1-5]\.mp3$/);
  });

  it("green-held draws from the flag-green-held pool (one of the five variants)", () => {
    mockSessionType.mockReturnValue("Race");
    bus.publishEvent("flag.green-held.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/voice\/luca\/flags\/green-held-0[1-5]\.mp3$/);
  });

  it("substitutes the active voice — switching voice changes resolved path", () => {
    activeVoice = "titan";
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/titan/flags/red-01.mp3"]);
  });

  it("wraps the callout in the radio frame (open + close ticks on the SFX channel)", () => {
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });
});

describe("FLAG_ALERTS green session-type branch", () => {
  it.each([
    { sessionType: "Practice", expected: "voice/luca/flags/green-practice-01.mp3" },
    { sessionType: "Open Qualify", expected: "voice/luca/flags/green-qualifying-01.mp3" },
    { sessionType: "Lone Qualify", expected: "voice/luca/flags/green-qualifying-01.mp3" },
  ])("$sessionType session → $expected", ({ sessionType, expected }) => {
    mockSessionType.mockReturnValue(sessionType);
    bus.publishEvent("flag.green.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toContain(expected);
  });

  it.each([
    { sessionType: "Race" },
    { sessionType: "" },
    { sessionType: "Some Unknown" },
  ])("$sessionType session falls through to flag-green-race", ({ sessionType }) => {
    mockSessionType.mockReturnValue(sessionType);
    bus.publishEvent("flag.green.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(
      played.includes("voice/luca/flags/green-race-01.mp3") || played.includes("voice/luca/flags/green-race-02.mp3"),
    ).toBe(true);
  });
});

describe("FLAG_ALERTS white session-type branch", () => {
  it.each([
    { sessionType: "Practice", expected: "voice/luca/flags/white-practice-01.mp3" },
    { sessionType: "Open Qualify", expected: "voice/luca/flags/white-qualifying-01.mp3" },
    { sessionType: "Lone Qualify", expected: "voice/luca/flags/white-qualifying-01.mp3" },
  ])("$sessionType session → $expected", ({ sessionType, expected }) => {
    mockSessionType.mockReturnValue(sessionType);
    bus.publishEvent("flag.white.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toContain(expected);
  });

  it.each([
    { sessionType: "Race" },
    { sessionType: "" },
    { sessionType: "Some Unknown" },
  ])("$sessionType session falls through to flag-white-race", ({ sessionType }) => {
    mockSessionType.mockReturnValue(sessionType);
    bus.publishEvent("flag.white.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(
      played.includes("voice/luca/flags/white-race-01.mp3") || played.includes("voice/luca/flags/white-race-02.mp3"),
    ).toBe(true);
  });
});

describe("FLAG_ALERTS white last-lap (issue #772)", () => {
  it("plays a last-lap clip when the player crosses S/F under the white flag in a race", () => {
    bus.publishEvent("flag.white-last-lap.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(
      played.includes("voice/luca/flags/white-last-lap-01.mp3") ||
        played.includes("voice/luca/flags/white-last-lap-02.mp3"),
    ).toBe(true);
  });

  it.each([{ sessionType: "Practice" }, { sessionType: "Open Qualify" }, { sessionType: "Lone Qualify" }])(
    "stays silent in a $sessionType session (race-only stage)",
    ({ sessionType }) => {
      mockSessionType.mockReturnValue(sessionType);
      bus.publishEvent("flag.white-last-lap.raised", {});
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([]);
    },
  );
});

describe("FLAG_ALERTS checkered session-type branch", () => {
  it.each([
    { sessionType: "Race", expected: "voice/luca/flags/checkered-race-01.mp3" },
    { sessionType: "Practice", expected: "voice/luca/flags/checkered-practice-01.mp3" },
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

// Issue #671 — "no Yellow cleared heard": `flag.yellow.cleared` is a one-shot
// event, so a non-queueable cleared callout arriving while an equal-weight
// non-flag line held the Voice bus was silently dropped. And iRacing re-raises
// the waving bits on every re-approach of a persistent incident zone, replaying
// the waving callout each pass — debounced with a 30 s cooldown (CrewChief's
// `timeBetweenYellowFlagMessages`).
describe("FLAG_ALERTS yellow-cleared delivery + waving debounce (issue #671)", () => {
  it("plays yellow-cleared after a completed yellow-waving callout (the #671 regression sequence)", () => {
    bus.publishEvent("flag.yellow-waving.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/yellow-waving-01.mp3"]);

    bus.publishEvent("flag.yellow.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      "voice/luca/flags/yellow-waving-01.mp3",
      "voice/luca/flags/yellow-cleared-01.mp3",
    ]);
  });

  it("yellow-cleared preempts an in-flight yellow-waving callout (same family)", () => {
    bus.publishEvent("flag.yellow-waving.raised", {});
    // Don't flush — the waving callout is still mid-playback.
    bus.publishEvent("flag.yellow.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed().at(-1)).toBe("voice/luca/flags/yellow-cleared-01.mp3");
  });

  it("yellow-cleared defers behind an equal-weight non-flag line and replays at idle (queueable)", () => {
    // A stand-in for a spotter call / pit chatter: same Voice bus, same SAFETY
    // weight, NOT in the flag family — so the cleared fire can't take the bus
    // and can't family-preempt. Pre-#671 it was dropped here.
    engine.defineScenario({
      id: "test.blocker",
      when: { event: "incident.occurred" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      weight: WEIGHT.SAFETY,
      sequence: ["flags/red-01.mp3"],
    });

    bus.publishEvent("incident.occurred", { delta: 1, type: "off-track" });
    // Don't flush — the blocker holds the Voice bus.
    bus.publishEvent("flag.yellow.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      "voice/luca/flags/red-01.mp3",
      "voice/luca/flags/yellow-cleared-01.mp3",
    ]);
  });

  it.each([
    { event: "flag.yellow-waving.raised" as const, clip: "voice/luca/flags/yellow-waving-01.mp3" },
    { event: "flag.caution-waving.raised" as const, clip: "voice/luca/flags/caution-waving-01.mp3" },
  ])("$event re-raised within 30 s is debounced; fires again after the cooldown", ({ event, clip }) => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    bus.publishEvent(event, {});
    flush(audio);

    expect(voiceClipsPlayed().filter((p) => p === clip)).toHaveLength(1);

    // Re-approach the incident 10 s later — iRacing re-raises the bit.
    now += 10_000;
    bus.publishEvent(event, {});
    flush(audio);

    expect(voiceClipsPlayed().filter((p) => p === clip)).toHaveLength(1);

    // Past the cooldown window the incident is still out there — call it again.
    now += WAVING_FLAG_COOLDOWN_MS;
    bus.publishEvent(event, {});
    flush(audio);

    expect(voiceClipsPlayed().filter((p) => p === clip)).toHaveLength(2);
  });
});

describe("FLAG_POOL_NAMES", () => {
  it("lists every flag pool that pools.ts defines for flag scenarios", () => {
    expect(FLAG_POOL_NAMES).toEqual([
      "flag-yellow-local",
      "flag-yellow-full",
      "flag-yellow-cleared",
      "flag-blue",
      "flag-red",
      "flag-black",
      "flag-debris",
      "flag-meatball",
      "flag-green-practice",
      "flag-green-qualifying",
      "flag-green-race",
      "flag-white-practice",
      "flag-white-qualifying",
      "flag-white-race",
      "flag-white-last-lap",
      "flag-checkered-practice",
      "flag-checkered-qualifying",
      "flag-checkered-race",
      "flag-disqualify",
      "flag-furled",
      "flag-furled-cleared",
      "flag-dq-scoring-invalid",
      "flag-crossed",
      "flag-one-pace-lap-to-go",
      "flag-green-held",
      "flag-ten-to-go",
      "flag-five-to-go",
      "flag-yellow-waving",
      "flag-caution-waving",
    ]);
  });

  it("every name has a POOL_REGISTRY entry sourced from the flags group", () => {
    for (const name of FLAG_POOL_NAMES) {
      expect(POOL_REGISTRY[name]).toBeDefined();
      expect(POOL_REGISTRY[name].group).toBe("flags");
      expect(POOL_REGISTRY[name].base.length).toBeGreaterThan(0);
    }
  });
});

// Issue #480 follow-up: iRacing raises the race-grid bits (e.g. OneLapToGreen)
// while forming the race grid at the END of a qualifying session, so the
// race-formation / progression callouts fired "One pace lap to go" at the
// qualifying checkered. They must gate on the race session.
describe("FLAG_ALERTS race-only gating", () => {
  // Clip identity per event is asserted elsewhere (the deterministic `expected`
  // table for the single-clip flags; the membership tests for the random
  // one-pace-lap-to-go / green-held pools). Here we only care that the event
  // fires in a race and is suppressed otherwise, so the positive case just
  // checks a single clip played.
  const RACE_ONLY = [
    { event: "flag.crossed.raised" },
    { event: "flag.one-pace-lap-to-go.raised" },
    { event: "flag.green-held.raised" },
    { event: "flag.ten-to-go.raised" },
    { event: "flag.five-to-go.raised" },
  ] as const;

  it.each(RACE_ONLY)("$event is suppressed in qualifying", ({ event }) => {
    mockSessionType.mockReturnValue("Qualify");
    bus.publishEvent(event, {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it.each(RACE_ONLY)("$event fires in a race", ({ event }) => {
    mockSessionType.mockReturnValue("Race");
    bus.publishEvent(event, {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toHaveLength(1);
  });

  it.each(RACE_ONLY)("$event is suppressed in practice", ({ event }) => {
    mockSessionType.mockReturnValue("Practice");
    bus.publishEvent(event, {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it.each(RACE_ONLY)("$event is suppressed when out of the car (replay / grid spectating)", ({ event }) => {
    bus.publishEvent(event, {} as never, { IsOnTrack: false, IsReplayPlaying: false });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  // Issue #657: race-progression callouts must go silent after the race finishes
  // — iRacing re-asserts the grid bits in cool-down / next-session grid formation.
  it.each(RACE_ONLY)("$event is suppressed after the race finishes (Checkered)", ({ event }) => {
    mockSessionType.mockReturnValue("Race");
    // SessionState 5 = Checkered → isPostRace true.
    bus.publishEvent(event, {} as never, { IsOnTrack: true, SessionState: 5 });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it.each(RACE_ONLY)("$event is suppressed during cool-down (CoolDown)", ({ event }) => {
    mockSessionType.mockReturnValue("Race");
    // SessionState 6 = CoolDown → isPostRace true.
    bus.publishEvent(event, {} as never, { IsOnTrack: true, SessionState: 6 });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  // green-held keeps the scenario-level rolling-only gate (`rollingFormationOnly`):
  // a standing start has no pace lap, so its lead-in is owned by the start-light
  // family. ("One pace lap to go" gates rolling-only in its diff instead — #657.)
  it("green-held is suppressed during a standing-start pre-green grid", () => {
    mockStandingStart.mockReturnValue(true);
    // SessionState 2 = Warmup → isPreGreen true.
    bus.publishEvent("flag.green-held.raised", {}, { IsOnTrack: true, SessionState: 2 });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("green-held still fires at a standing-start race RESTART (Racing state)", () => {
    mockStandingStart.mockReturnValue(true);
    // SessionState 4 = Racing → not pre-green, so a rolling restart still calls it.
    bus.publishEvent("flag.green-held.raised", {}, { IsOnTrack: true, SessionState: 4 });
    flush(audio);

    const played = voiceClipsPlayed();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(/voice\/luca\/flags\/green-held-0[1-5]\.mp3$/);
  });
});

// Issue #669 follow-up: the queueable FURLED fire can replay only after a
// longer call (incident points, readback) finishes — by which time the warning
// may already be withdrawn. The raised line re-checks the LIVE Furled bit at
// speak time and expands to nothing when the flag is down, and FURLED_CLEARED
// only plays when the raised line actually reached the speaker.
describe("furled speak-time validity + cleared pairing (issue #669)", () => {
  const FURLED_UP = { SessionFlags: Flags.Furled };
  const FURLED_DOWN = { SessionFlags: 0 };

  it("raised plays when the live Furled bit is still up at speak time", () => {
    mockLatestTelemetry.mockReturnValue(FURLED_UP);
    bus.publishEvent("flag.furled.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/furled-01.mp3"]);
  });

  it("raised expands to silence — no line, no radio frame — when the warning is already withdrawn at speak time", () => {
    mockLatestTelemetry.mockReturnValue(FURLED_DOWN);
    bus.publishEvent("flag.furled.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
    expect(sfxClipsPlayed()).toEqual([]);
  });

  it("a cleared whose raised never reached the speaker plays nothing", () => {
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("spoken raised → cleared plays once; the marker is consumed so a second cleared is silent", () => {
    mockLatestTelemetry.mockReturnValue(FURLED_UP);
    bus.publishEvent("flag.furled.raised", {});
    flush(audio);
    mockLatestTelemetry.mockReturnValue(FURLED_DOWN); // the warning drops
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([
      "voice/luca/flags/furled-01.mp3",
      "voice/luca/flags/furled-cleared-01.mp3",
    ]);
  });

  it("a clear arriving while the bit is up again plays nothing but keeps the marker for the real drop", () => {
    _setFurledRaisedSpoken(true); // raised line was spoken
    mockLatestTelemetry.mockReturnValue(FURLED_UP); // …but the warning is back up
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);

    mockLatestTelemetry.mockReturnValue(FURLED_DOWN); // the genuine drop
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/furled-cleared-01.mp3"]);
  });

  it("a fresh raised fire invalidates a stale spoken marker from a previous episode", () => {
    _setFurledRaisedSpoken(true); // stale leftover (e.g. session change ate the falling edge)
    mockLatestTelemetry.mockReturnValue(FURLED_DOWN); // and this episode never speaks
    bus.publishEvent("flag.furled.raised", {});
    flush(audio);
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("queued behind a longer call: a withdrawn warning plays neither the raised nor the cleared line", () => {
    // Equal-weight non-flag occupant, so the furled fire defers instead of
    // family-preempting (the user-reported incident-points shape).
    engine.defineScenario({
      id: "test.filler",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      weight: WEIGHT.SAFETY,
      sequence: ["pool:flag-yellow-cleared"],
    });
    mockLatestTelemetry.mockReturnValue(FURLED_UP);

    engine.fire("test.filler"); // occupies the Voice bus; deliberately not flushed
    bus.publishEvent("flag.furled.raised", {}); // equal weight + queueable → pending
    mockLatestTelemetry.mockReturnValue(FURLED_DOWN); // warning withdrawn while queued
    bus.publishEvent("flag.furled.cleared", {}); // raised never spoke → dropped at where:
    flush(audio); // filler finishes → pending raised replays → expands to silence

    expect(voiceClipsPlayed().filter((p) => p.includes("furled"))).toEqual([]);
  });

  it("a queued clear is dropped at speak time when the warning is back up, and the kept marker pairs the eventual real drop", () => {
    engine.defineScenario({
      id: "test.filler2",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      weight: WEIGHT.SAFETY,
      sequence: ["pool:flag-yellow-cleared"],
    });
    mockLatestTelemetry.mockReturnValue(FURLED_UP);
    bus.publishEvent("flag.furled.raised", {});
    flush(audio); // raised plays → marker set

    engine.fire("test.filler2"); // occupies the Voice bus; deliberately not flushed
    bus.publishEvent("flag.furled.cleared", {}); // bit dropped → diff cleared; equal weight → queued
    // The bit is back up by the time the bus idles (the re-raise is debounced
    // upstream, so no fresh raised fire has displaced the queued clear yet).
    flush(audio); // filler finishes → queued clear replays → expands to silence

    expect(voiceClipsPlayed().filter((p) => p.includes("furled-cleared"))).toEqual([]);

    mockLatestTelemetry.mockReturnValue(FURLED_DOWN); // the genuine withdrawal
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed().filter((p) => p.includes("furled-cleared"))).toEqual([
      "voice/luca/flags/furled-cleared-01.mp3",
    ]);
  });
});

// Issue #846: when the driver ignores the furled warning, iRacing raises the
// actual black flag by clearing Furled and setting Black in one transition.
// The diff suppresses the cleared emission on that tick, but a cleared that
// was legitimately emitted (genuine withdrawal) and then deferred behind a
// longer line can still meet the escalation before the bus idles — the
// speak-time gate must expand it to silence rather than announce "Black flag
// cleared." right after the black-flag call.
describe("furled → black escalation speak-time gate (issue #846)", () => {
  const BLACK_UP = { SessionFlags: Flags.Black };
  const DQ_UP = { SessionFlags: Flags.Disqualify };

  it("a cleared meeting the actual black flag at speak time plays nothing", () => {
    _setFurledRaisedSpoken(true); // raised line was spoken
    mockLatestTelemetry.mockReturnValue(BLACK_UP); // …but the warning escalated
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
    expect(sfxClipsPlayed()).toEqual([]);
  });

  it("a cleared meeting a disqualification at speak time plays nothing", () => {
    _setFurledRaisedSpoken(true);
    mockLatestTelemetry.mockReturnValue(DQ_UP);
    bus.publishEvent("flag.furled.cleared", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("a queued clear overtaken by the escalation expands to silence at idle-replay", () => {
    engine.defineScenario({
      id: "test.filler3",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      weight: WEIGHT.SAFETY,
      sequence: ["pool:flag-yellow-cleared"],
    });
    mockLatestTelemetry.mockReturnValue({ SessionFlags: Flags.Furled });
    bus.publishEvent("flag.furled.raised", {});
    flush(audio); // raised plays → marker set

    engine.fire("test.filler3"); // occupies the Voice bus; deliberately not flushed
    mockLatestTelemetry.mockReturnValue({ SessionFlags: 0 }); // genuine drop…
    bus.publishEvent("flag.furled.cleared", {}); // …emits cleared; equal weight → queued
    mockLatestTelemetry.mockReturnValue(BLACK_UP); // escalation lands while queued
    flush(audio); // filler finishes → queued clear replays → expands to silence

    expect(voiceClipsPlayed().filter((p) => p.includes("furled-cleared"))).toEqual([]);
  });
});
