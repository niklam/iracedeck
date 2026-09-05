/**
 * The flag family after issue #1064: the code registers CONTRACTS (trigger,
 * scheduling, the `session.*` / `flag.*` vocabulary) and the bundled voice's
 * `callouts.json` supplies what is said. Every fire here goes through the real
 * artifact (`@iracedeck/audio-assets/voice/default/callouts.json`, fed to
 * `setScripts` for the test voices), so the behavioural assertions prove the
 * script AND the contracts together — the way the plugin runs them.
 */
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { Flags } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  _setFurledRaisedSpoken,
  FLAG_CLIP_SOURCES,
  FLAG_CONTRACTS,
  FLAG_SCENARIO_IDS,
  registerFlagVocabulary,
  WAVING_FLAG_COOLDOWN_MS,
} from "./flag-alerts.js";
import { classifySessionType, isRaceSession } from "./race-start.js";

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
  "white-leader-01",
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

/**
 * The bundled voice's script, verbatim — every scripted family's entries
 * and the `radio` frame; its `pools` is empty, every flag step addressing
 * its clips directly as `pool:flags/<base>`. The JSON import types `schema`
 * as `number`, hence the cast; the freshness test in `@iracedeck/audio-assets`
 * guarantees the file matches its config. The engine in these tests
 * registers the flag family ALONE, so it is handed {@link FLAG_SCRIPT},
 * never this whole file: an entry for a contract this engine does not hold
 * is a `no contract` warn, and since #1065 the file carries other families.
 */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the flag family's own entries — handed to
 * BOTH test voices. `fragments` is narrowed too (to none): a fragment
 * belongs to the entries that include it, no flag entry includes one, and
 * `collectScriptReferences` walks every fragment it is given, so another
 * family's fragment would otherwise widen the reference set under the
 * assertions below.
 */
const FLAG_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(FLAG_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
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

  // The production order (`registerPitCrew`): vocabulary, contracts, then the
  // scripts — no pools are registered in code for this family any more, and
  // the script names none either: its `pool:flags/<base>` steps address the
  // clip group directly, resolved against the manifest at fire time.
  registerFlagVocabulary(engine);

  for (const c of FLAG_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map(VOICE_KEYS.map((v) => [v, FLAG_SCRIPT])));
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

function findContract(id: string): ScenarioContract {
  const c = FLAG_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`No flag contract with id "${id}"`);

  return c;
}

describe("FLAG_CONTRACTS structure", () => {
  it("defines 24 contracts", () => {
    expect(FLAG_CONTRACTS).toHaveLength(24);
  });

  it("carries no sequence — what a flag says is the voice script's, never the code's (issue #1064)", () => {
    for (const c of FLAG_CONTRACTS) {
      expect("sequence" in c, `${c.id} smuggles a sequence`).toBe(false);
    }
  });

  it("names no frame — every flag takes the engine default (the voice's `radio`)", () => {
    for (const c of FLAG_CONTRACTS) {
      expect(c.frame, `${c.id} names a frame`).toBeUndefined();
    }
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
      "pit-crew.flag-white-leader",
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

  it("non-meatball contracts share family 'flag' and sit in the SAFETY weight band", () => {
    for (const s of FLAG_CONTRACTS) {
      if (s.id === "pit-crew.flag-meatball") continue;

      expect(s.family).toBe("flag");
      expect(s.weight).toBe(WEIGHT.SAFETY);
      expect(s.interrupt).not.toBe(true);
    }
  });

  it("meatball is CRITICAL weight + interrupt + queueable + outside the flag family", () => {
    const meatball = findContract("pit-crew.flag-meatball");

    expect(meatball.weight).toBe(WEIGHT.CRITICAL);
    expect(meatball.interrupt).toBe(true);
    // Issue #867: a spotter proximity call (PROXIMITY > CRITICAL) can cut or
    // outrank the meatball line; queueable defers it for replay instead of
    // losing the one-shot box-for-repairs instruction forever.
    expect(meatball.queueable).toBe(true);
    expect(meatball.family).toBeUndefined();
  });

  it("furled, furled-cleared, yellow-cleared, white-last-lap, white-leader, meatball and the penalty raises are queueable (defer behind a busy bus) — and they're the only flags that are", () => {
    const queueableIds = [
      "pit-crew.flag-furled",
      "pit-crew.flag-furled-cleared",
      "pit-crew.flag-yellow-cleared",
      // Issue #772: the last-lap crossing is one-shot and the translator
      // latch never re-fires, so a fire displaced by an equal-weight line
      // (spotter call) must replay at idle instead of being dropped.
      "pit-crew.flag-white-last-lap",
      // Issue #936: the leader's last-lap crossing is one-shot and the
      // translator latch never re-fires, so must replay on deferral like
      // white-last-lap.
      "pit-crew.flag-white-leader",
      // Issue #867: a spotter proximity call outranks the meatball line; the
      // one-shot raise must defer/stash and replay instead of being lost.
      "pit-crew.flag-meatball",
      // Issue #923: the penalty raises are one-shot edges that never re-fire
      // and the penalty is a sustained state — a fire that can't take the bus
      // must defer and replay at idle, never leave the driver untold.
      "pit-crew.flag-black",
      "pit-crew.flag-disqualify",
      "pit-crew.flag-dq-scoring-invalid",
    ];

    for (const id of queueableIds) {
      expect(findContract(id).queueable).toBe(true);
    }

    for (const s of FLAG_CONTRACTS) {
      if (queueableIds.includes(s.id)) continue;

      expect(s.queueable).not.toBe(true);
    }
  });

  // Issue #671 — iRacing re-raises the waving bits on every zone re-approach
  // while an incident persists; the 30 s cooldown collapses the repeats.
  it("the waving contracts carry the 30 s cooldown — and they're the only flags that do", () => {
    const cooldownIds = ["pit-crew.flag-yellow-waving", "pit-crew.flag-caution-waving"];

    for (const id of cooldownIds) {
      expect(findContract(id).cooldown).toBe(WAVING_FLAG_COOLDOWN_MS);
    }

    for (const s of FLAG_CONTRACTS) {
      if (cooldownIds.includes(s.id)) continue;

      expect(s.cooldown).toBeUndefined();
    }
  });

  it("every contract uses the per-voice base path", () => {
    for (const s of FLAG_CONTRACTS) {
      expect(s.base).toBe("voice/{voice}");
    }
  });
});

describe("FLAG_CONTRACTS triggers", () => {
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

  it("is wrapped in the active voice's radio frame by the engine — open tick first, close tick last (issue #1064)", () => {
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    const played = audio._played.map((p) => p.path);

    expect(played[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(played.at(-1)).toBe("sfx/IRD-tick-close.mp3");
    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/red-01.mp3"]);
  });

  it("a voice with no script plays no flag callout at all — no line, no frame (issue #1064)", () => {
    // Only titan is scripted; the active voice (luca) is a clips-only voice.
    engine.setScripts(new Map([["titan", FLAG_SCRIPT]]));
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    expect(audio._played).toEqual([]);
    expect(mockLogger.debug).toHaveBeenCalledWith('Scenario "pit-crew.flag-red" skipped — no script for voice "luca"');
    // Absent means skipped, never an error: a clips-only voice is valid.
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("a script entry that skips the flag deliberately is silent too, and warns about nothing", () => {
    const skipping: CalloutScript = {
      ...FLAG_SCRIPT,
      scenarios: { ...FLAG_SCRIPT.scenarios, "pit-crew.flag-red": { skip: true } },
    };
    engine.setScripts(new Map([["luca", skipping]]));
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    expect(audio._played).toEqual([]);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });
});

describe("FLAG_CONTRACTS green session-type branch", () => {
  it.each([
    { sessionType: "Practice", expected: "voice/luca/flags/green-practice-01.mp3" },
    // The shared session rule: any practice-like type reads as practice, as
    // the `where:` gates beside it already read them (issue #1064).
    { sessionType: "Lone Practice", expected: "voice/luca/flags/green-practice-01.mp3" },
    { sessionType: "Offline Testing", expected: "voice/luca/flags/green-practice-01.mp3" },
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
    { sessionType: "Warmup" },
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

describe("FLAG_CONTRACTS white session-type branch", () => {
  it.each([
    { sessionType: "Practice", expected: "voice/luca/flags/white-practice-01.mp3" },
    { sessionType: "Lone Practice", expected: "voice/luca/flags/white-practice-01.mp3" },
    { sessionType: "Offline Testing", expected: "voice/luca/flags/white-practice-01.mp3" },
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

describe("FLAG_CONTRACTS white last-lap (issue #772)", () => {
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

describe("FLAG_CONTRACTS white leader (issue #936)", () => {
  it("plays a leader clip when the leader crosses S/F under the white flag in a race", () => {
    bus.publishEvent("flag.white-leader.raised", {});
    flush(audio);

    const played = voiceClipsPlayed();
    expect(
      played.includes("voice/luca/flags/white-leader-01.mp3") ||
        played.includes("voice/luca/flags/white-leader-02.mp3"),
    ).toBe(true);
  });

  it.each([{ sessionType: "Practice" }, { sessionType: "Open Qualify" }, { sessionType: "Lone Qualify" }])(
    "stays silent in a $sessionType session (race-only stage)",
    ({ sessionType }) => {
      mockSessionType.mockReturnValue(sessionType);
      bus.publishEvent("flag.white-leader.raised", {});
      flush(audio);

      expect(voiceClipsPlayed()).toEqual([]);
    },
  );
});

describe("FLAG_CONTRACTS checkered session-type branch", () => {
  it.each([
    { sessionType: "Race", expected: "voice/luca/flags/checkered-race-01.mp3" },
    { sessionType: "Warmup", expected: "voice/luca/flags/checkered-race-01.mp3" },
    { sessionType: "Practice", expected: "voice/luca/flags/checkered-practice-01.mp3" },
    { sessionType: "Lone Practice", expected: "voice/luca/flags/checkered-practice-01.mp3" },
    { sessionType: "Offline Testing", expected: "voice/luca/flags/checkered-practice-01.mp3" },
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

describe("FLAG_CONTRACTS preemption", () => {
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
describe("FLAG_CONTRACTS yellow-cleared delivery + waving debounce (issue #671)", () => {
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

    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" });
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

// Issue #923 — a directly-issued black flag (pit-lane speeding, a race-admin
// `!black`, escalation after an ignored meatball) landing while an equal- or
// higher-weight line held the Voice bus was silently dropped, and the raise
// is a one-shot edge that never re-fires — the driver was never told about
// the penalty. The penalty scenarios are queueable so the fire defers and
// replays when the bus idles; a black→DQ escalation while queued resolves
// structurally (the queueable DQ fire replaces the pending black — equal
// weight, ties → newest in the single pending slot).
describe("FLAG_CONTRACTS penalty-flag delivery (issue #923)", () => {
  // A stand-in for a spotter call / pit chatter: same Voice bus, NOT in the
  // flag family — so a penalty fire can't take the bus and can't
  // family-preempt. Equal weight (SAFETY) by default; pass CRITICAL to model
  // the meatball / fuel-critical occupants. Pre-#923 it was dropped here.
  function defineBlocker(weight: number = WEIGHT.SAFETY): void {
    engine.defineScenario({
      id: "test.blocker",
      when: { event: "incident.occurred" },
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      weight,
      sequence: ["flags/red-01.mp3"],
    });
  }

  it.each([
    { event: "flag.black.raised" as const, clip: "voice/luca/flags/black-01.mp3" },
    { event: "flag.disqualify.raised" as const, clip: "voice/luca/flags/disqualify-01.mp3" },
    { event: "flag.dq-scoring-invalid.raised" as const, clip: "voice/luca/flags/dq-scoring-invalid-01.mp3" },
  ])("$event defers behind an equal-weight non-flag line and replays at idle (queueable)", ({ event, clip }) => {
    defineBlocker();

    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" });
    // Don't flush — the blocker holds the Voice bus.
    bus.publishEvent(event, {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/red-01.mp3", clip]);
  });

  // The issue's loss paths also include HIGHER-weight occupants (meatball,
  // fuel-critical at CRITICAL; spotter calls at PROXIMITY) — same queueOrDrop
  // branch, but cover it explicitly with a CRITICAL blocker.
  it.each([
    { event: "flag.black.raised" as const, clip: "voice/luca/flags/black-01.mp3" },
    { event: "flag.disqualify.raised" as const, clip: "voice/luca/flags/disqualify-01.mp3" },
    { event: "flag.dq-scoring-invalid.raised" as const, clip: "voice/luca/flags/dq-scoring-invalid-01.mp3" },
  ])("$event defers behind a HIGHER-weight non-flag line and replays at idle (queueable)", ({ event, clip }) => {
    defineBlocker(WEIGHT.CRITICAL);

    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" });
    // Don't flush — the critical blocker holds the Voice bus.
    bus.publishEvent(event, {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/red-01.mp3", clip]);
  });

  it("a disqualify raised while the black line waits replaces it — only the DQ line plays (escalation)", () => {
    defineBlocker();

    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" });
    // Don't flush — the blocker holds the Voice bus; the black fire defers.
    bus.publishEvent("flag.black.raised", {});
    // The penalty escalates while the black line waits: the queueable DQ fire
    // takes the single pending slot (equal weight, ties → newest), so the
    // driver hears the escalated line, never the stale black-flag one.
    bus.publishEvent("flag.disqualify.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toEqual(["voice/luca/flags/red-01.mp3", "voice/luca/flags/disqualify-01.mp3"]);
  });

  // The #867 supersession guard pattern (see start-lights.test.ts): the DSL
  // replays queueable fires unconditionally, so prove a black line cut
  // MID-PLAYBACK by the escalating disqualify is never stashed for replay — a
  // same-family replacement skips `stashRunningIfQueueable`, and making the
  // black scenario queueable must not change that.
  it("a black line cut mid-playback by disqualify is not stashed — no replay at idle (escalation)", () => {
    bus.publishEvent("flag.black.raised", {});
    // Complete the frame's open tick (SFX) so the black VOICE clip is genuinely
    // in flight when the escalation lands.
    audio._triggerChannelEnd(AudioChannel.SFX);
    // Mid-playback (no flush): the DQ supersedes via the shared flag family.
    bus.publishEvent("flag.disqualify.raised", {});
    flush(audio);

    // The black clip started exactly once and was never stashed for replay.
    expect(voiceClipsPlayed().filter((p) => p === "voice/luca/flags/black-01.mp3")).toHaveLength(1);
    expect(voiceClipsPlayed().at(-1)).toBe("voice/luca/flags/disqualify-01.mp3");
  });
});

describe("FLAG_CLIP_SOURCES", () => {
  it("lists every flag line, all in the flags clip group", () => {
    expect(FLAG_CLIP_SOURCES.map((source) => source.base)).toEqual([
      "yellow-local",
      "yellow-full",
      "yellow-cleared",
      "blue",
      "red",
      "black",
      "debris",
      "meatball",
      "green-practice",
      "green-qualifying",
      "green-race",
      "white-practice",
      "white-qualifying",
      "white-race",
      "white-last-lap",
      "white-leader",
      "checkered-practice",
      "checkered-qualifying",
      "checkered-race",
      "disqualify",
      "furled",
      "furled-cleared",
      "dq-scoring-invalid",
      "crossed",
      "one-pace-lap-to-go",
      "green-held",
      "ten-to-go",
      "five-to-go",
      "yellow-waving",
      "caution-waving",
    ]);

    for (const source of FLAG_CLIP_SOURCES) expect(source.group).toBe("flags");
  });

  it("the fixture manifest carries at least one clip per source for both test voices — the fires above are not vacuous", () => {
    for (const { group, base } of FLAG_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);
      const voices = new Set(manifest.clips.map((clip) => pattern.exec(clip)?.[1]).filter((v) => v !== undefined));

      expect([...voices].sort(), `${group}/${base}`).toEqual([...VOICE_KEYS].sort());
    }
  });

  it("is exactly the set of clip groups the bundled flag scripts address — every step the slashed form, no stray reference either way", () => {
    // Narrowed to the family's own entries so another family's migration
    // (#1065) cannot widen the reference set under this assertion. Equality
    // with the `group/base` spellings is also what pins the decision that
    // no flag pool carries a name: a named entry under `pools` would show
    // up here as a reference the sources do not spell.
    const referenced = collectScriptReferences(FLAG_SCRIPT).pools;
    const sources = FLAG_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`);

    expect([...referenced].sort()).toEqual([...sources].sort());
  });
});

describe("the bundled script's flag entries (issue #1064)", () => {
  it("scripts every flag contract, and nothing that is not a flag contract", () => {
    expect(Object.keys(FLAG_SCRIPT.scenarios).sort()).toEqual([...FLAG_SCENARIO_IDS].sort());

    for (const id of FLAG_SCENARIO_IDS) {
      expect(SCRIPT.scenarios[id], `no script entry for ${id}`).toBeDefined();
    }
  });

  it("every entry carries a comment, a harness route and a sequence — the reference's source text", () => {
    for (const id of FLAG_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Flags → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("references only vocabulary the flag family registers, with the declared case keys", () => {
    const refs = collectScriptReferences(FLAG_SCRIPT);
    const vocabulary = engine.vocabulary();

    expect(refs.vars).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.conds).toEqual(["flag.furledStillShown", "flag.furledWithdrawn"]);
    expect(refs.cases).toEqual([{ name: "session.type", keys: ["practice", "qualifying", "race"] }]);

    for (const cond of refs.conds) {
      expect(vocabulary.conds.map((c) => c.name)).toContain(cond);
    }

    for (const c of refs.cases) {
      const declared = vocabulary.cases.find((v) => v.name === c.name);

      expect(declared).toBeDefined();
      expect(Object.keys(declared?.keys ?? {}).sort()).toEqual([...c.keys].sort());
    }
  });

  it("compiles for every voice with nothing skipped — no unknown pool, condition or case key", () => {
    // A compile problem is ONE warn per (voice, scenario); the fixture's
    // manifest covers both voices, so a clean compile means every reference
    // resolved. Deliberate skips would be silent, and there are none.
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

// The session rule the vocabulary reads is the package's shared one
// (`classifySessionType`, race-start.ts) — the same rule the `where:` gates
// read through `isRaceSession` — so a pack can never see `session.type` call
// a session a race that a gate beside it calls practice.
describe("the shared session rule (issue #1064)", () => {
  it.each([
    { raw: "Practice", kind: "practice" },
    { raw: "Lone Practice", kind: "practice" },
    { raw: "Offline Testing", kind: "practice" },
    { raw: "Open Qualify", kind: "qualifying" },
    { raw: "Lone Qualify", kind: "qualifying" },
    { raw: "Race", kind: "race" },
    { raw: "Warmup", kind: "race" },
    { raw: "Some Unknown", kind: "race" },
    { raw: "", kind: null },
  ])("classifySessionType($raw) → $kind", ({ raw, kind }) => {
    expect(classifySessionType(raw)).toBe(kind);
  });

  it("isRaceSession is the same rule for every known type, and permissive only on the unknown one", () => {
    for (const raw of ["Practice", "Lone Practice", "Offline Testing", "Open Qualify", "Lone Qualify"]) {
      expect(isRaceSession(raw), raw).toBe(false);
      expect(classifySessionType(raw)).not.toBe("race");
    }

    for (const raw of ["Race", "Warmup", "Some Unknown"]) {
      expect(isRaceSession(raw), raw).toBe(true);
      expect(classifySessionType(raw)).toBe("race");
    }

    // A gate never suppresses on missing data (the #574 precedent); the
    // vocabulary reports the same case as `null` and lets the pack decide.
    expect(isRaceSession("")).toBe(true);
    expect(classifySessionType("")).toBeNull();
  });
});

describe("registerFlagVocabulary (issue #1064)", () => {
  it("publishes the session case and the furled gates with their descriptions, verbatim", () => {
    const { conds, cases } = engine.vocabulary();

    expect(cases).toEqual([
      {
        name: "session.type",
        description: "The type of the current session.",
        keys: {
          practice: "A practice session.",
          qualifying: "Any qualifying session (open or lone).",
          race: "A race session.",
        },
      },
    ]);
    expect(conds).toEqual([
      {
        name: "flag.furledStillShown",
        description:
          "The furled black flag is still being shown at speak time; speaking it marks the raise as announced.",
      },
      {
        name: "flag.furledWithdrawn",
        description: "An announced furled flag has been withdrawn; speaking it consumes the announcement.",
      },
      { name: "session.isPractice", description: "The current session is a practice session." },
      {
        name: "session.isQualifying",
        description: "The current session is a qualifying session (open or lone).",
      },
      {
        name: "session.isRace",
        description: "The current session is a race session (anything that is not practice or qualifying).",
      },
    ]);
  });

  // The three binary conditions are published for packs, not used by ours —
  // so prove them through a probe script the way a pack would write one.
  function probe(cond: string): CalloutScript {
    return {
      ...FLAG_SCRIPT,
      scenarios: {
        ...FLAG_SCRIPT.scenarios,
        "pit-crew.flag-red": { sequence: [{ if: cond, then: ["flags/red-01.mp3"] }] },
      },
    };
  }

  function redPlays(cond: string, sessionType: string): boolean {
    // Counted from a mark, so two probes in one test read only their own fire.
    const before = voiceClipsPlayed().length;
    engine.setScripts(new Map([["luca", probe(cond)]]));
    mockSessionType.mockReturnValue(sessionType);
    bus.publishEvent("flag.red.raised", {});
    flush(audio);

    return voiceClipsPlayed().slice(before).includes("voice/luca/flags/red-01.mp3");
  }

  it.each([
    { cond: "session.isPractice", sessionType: "Practice", expected: true },
    { cond: "session.isPractice", sessionType: "Lone Practice", expected: true },
    { cond: "session.isPractice", sessionType: "Offline Testing", expected: true },
    { cond: "session.isPractice", sessionType: "Open Qualify", expected: false },
    { cond: "session.isPractice", sessionType: "Race", expected: false },
    { cond: "session.isQualifying", sessionType: "Open Qualify", expected: true },
    { cond: "session.isQualifying", sessionType: "Lone Qualify", expected: true },
    { cond: "session.isQualifying", sessionType: "Race", expected: false },
    { cond: "session.isRace", sessionType: "Race", expected: true },
    { cond: "session.isRace", sessionType: "Warmup", expected: true },
    { cond: "session.isRace", sessionType: "Practice", expected: false },
    { cond: "session.isRace", sessionType: "Lone Practice", expected: false },
    { cond: "session.isRace", sessionType: "Offline Testing", expected: false },
    { cond: "session.isRace", sessionType: "Lone Qualify", expected: false },
    // No session type known: none of the three holds (the case var reads null).
    { cond: "session.isPractice", sessionType: "", expected: false },
    { cond: "session.isQualifying", sessionType: "", expected: false },
    { cond: "session.isRace", sessionType: "", expected: false },
  ])("$cond is $expected in a '$sessionType' session", ({ cond, sessionType, expected }) => {
    expect(redPlays(cond, sessionType)).toBe(expected);
  });

  it("a negated condition flips the branch (`!session.isRace`)", () => {
    expect(redPlays("!session.isRace", "Practice")).toBe(true);
    expect(redPlays("!session.isRace", "Race")).toBe(false);
  });

  it("session.type resolves to null when no session type is known — the script's `default` branch answers", () => {
    // The bundled green script maps `default` to the race line, which is why
    // the '' case in the session-type describe above still plays it. A script
    // WITHOUT a default is silent there, never wrong.
    const withoutDefault: CalloutScript = {
      ...FLAG_SCRIPT,
      scenarios: {
        ...FLAG_SCRIPT.scenarios,
        "pit-crew.flag-green": {
          sequence: [{ case: "session.type", of: { race: ["pool:flags/green-race"] } }],
        },
      },
    };
    engine.setScripts(new Map([["luca", withoutDefault]]));
    mockSessionType.mockReturnValue("");
    bus.publishEvent("flag.green.raised", {});
    flush(audio);

    expect(audio._played).toEqual([]);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    // …and the same script speaks in a race, so the silence above is the
    // missing default, not a broken probe.
    mockSessionType.mockReturnValue("Race");
    bus.publishEvent("flag.green.raised", {});
    flush(audio);

    expect(voiceClipsPlayed()).toHaveLength(1);
    expect(voiceClipsPlayed()[0]).toMatch(/voice\/luca\/flags\/green-race-0[12]\.mp3$/);
  });
});

// Issue #480 follow-up: iRacing raises the race-grid bits (e.g. OneLapToGreen)
// while forming the race grid at the END of a qualifying session, so the
// race-formation / progression callouts fired "One pace lap to go" at the
// qualifying checkered. They must gate on the race session.
describe("FLAG_CONTRACTS race-only gating", () => {
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
    // The frame is the engine's now (issue #1064) and it wraps only a body that
    // said something, so a gate that expands to nothing leaves no bare ticks.
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
      // A clip path, not `pool:flags/yellow-cleared`: the flags have no code
      // pool since #1064, and a legacy scenario is validated against the code
      // registry only — the slashed form is a script spelling.
      sequence: ["flags/yellow-cleared-01.mp3"],
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
      sequence: ["flags/yellow-cleared-01.mp3"],
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
      sequence: ["flags/yellow-cleared-01.mp3"],
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
