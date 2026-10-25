/**
 * Pit-window family tests (issue #655; scripted since #1065).
 *
 * Both contracts fire off the single `pitsOpen.changed` event and branch on
 * `to`: `to === true` → opened, `to === false` → closed. They share the
 * `pit-window` family (so a rapid flurry preempts cleanly) and the same weight /
 * scheduling flags (above normal, below flags; never cut, but queueable). What
 * each line SAYS is the bundled voice's `callouts.json`, so the fire-through
 * cases below hand the real artifact to the engine and read what played.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { familyReferences } from "./family-references.test-util.js";
import { PIT_WINDOW_CLIP_SOURCES, PIT_WINDOW_CONTRACTS, PIT_WINDOW_SCENARIO_IDS } from "./pit-window.js";

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
        telemetry: null,
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
    [AudioChannel.Feedback]: null,
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

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

/** One clip per source for the test voice, so a pool draw is deterministic and a played path names its pool. */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...PIT_WINDOW_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script, verbatim. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the family's own entries (and to no
 * fragments — none of these entries includes one). The engine here registers
 * the pit-window family ALONE, and an entry for a contract it does not hold
 * would be a `no contract` warn.
 */
const PIT_WINDOW_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(PIT_WINDOW_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;

beforeEach(() => {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

  for (const c of PIT_WINDOW_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, PIT_WINDOW_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

function contract(id: string): ScenarioContract {
  const c = PIT_WINDOW_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`contract not found: ${id}`);

  return c;
}

function changed(to: boolean): SimEventOf<"pitsOpen.changed"> {
  return { event: "pitsOpen.changed", timestamp: 0, telemetry: null, data: { from: !to, to } };
}

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

describe("PIT_WINDOW_CONTRACTS structure", () => {
  it("exports both contract ids", () => {
    expect(PIT_WINDOW_SCENARIO_IDS).toEqual(["pit-crew.pit-window-opened", "pit-crew.pit-window-closed"]);
    expect(PIT_WINDOW_CONTRACTS.map((c) => c.id)).toEqual(PIT_WINDOW_SCENARIO_IDS);
  });

  it("shares the pit-window family across both directions (preemption)", () => {
    expect(PIT_WINDOW_CONTRACTS.every((c) => c.family === "pit-window")).toBe(true);
  });

  it("never interrupts but stays queueable, weighted between normal and flags", () => {
    for (const c of PIT_WINDOW_CONTRACTS) {
      expect(c.interrupt).toBe(false);
      expect(c.queueable).toBe(true);
      expect(c.weight).toBe(65);
    }
  });

  it("keeps the voice channel, bus and base, and carries no sequence and no frame — the line is the voice script's (issue #1065)", () => {
    for (const c of PIT_WINDOW_CONTRACTS) {
      expect(c.when?.event).toBe("pitsOpen.changed");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect("sequence" in c).toBe(false);
      // No `frame` → the engine's default (`radio`); the script never spells the ticks.
      expect(c.frame).toBeUndefined();
    }
  });

  it("opened fires only on to === true", () => {
    const where = contract("pit-crew.pit-window-opened").when?.where;

    expect(where?.(changed(true))).toBe(true);
    expect(where?.(changed(false))).toBe(false);
  });

  it("closed fires only on to === false", () => {
    const where = contract("pit-crew.pit-window-closed").when?.where;

    expect(where?.(changed(false))).toBe(true);
    expect(where?.(changed(true))).toBe(false);
  });
});

describe("pit-window fires through the bundled script (issue #1065)", () => {
  it("pits opened plays the opened line inside the radio frame", () => {
    bus.publishEvent("pitsOpen.changed", { from: false, to: true });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/pit-window/opened-01.mp3`]);

    const all = audio._played.map((p) => p.path);

    expect(all[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(all.at(-1)).toBe("sfx/IRD-tick-close.mp3");
  });

  it("pits closed plays the closed line, and nothing of the opened one", () => {
    bus.publishEvent("pitsOpen.changed", { from: true, to: false });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/pit-window/closed-01.mp3`]);
  });

  it("a voice with no script is silent — the contract alone says nothing", () => {
    engine.setScripts(new Map());

    bus.publishEvent("pitsOpen.changed", { from: false, to: true });
    flush(audio);

    expect(audio._played).toEqual([]);
  });
});

describe("the bundled script's pit-window entries (issue #1065)", () => {
  it("scripts both contracts, each with a comment, a Pit Window harness route and a single pool step", () => {
    for (const [id, base] of [
      ["pit-crew.pit-window-opened", "opened"],
      ["pit-crew.pit-window-closed", "closed"],
    ] as const) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Pit Window → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.frame).toBeUndefined();
      expect(entry.sequence).toEqual([`pool:pit-window/${base}`]);
    }
  });

  it("references no vocabulary, no fragment and no frame — and the family registers none", () => {
    const refs = familyReferences(PIT_WINDOW_SCRIPT);
    const vocabulary = engine.vocabulary();

    expect(refs.vars).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(vocabulary.vars).toEqual([]);
    expect(vocabulary.conds).toEqual([]);
    expect(vocabulary.cases).toEqual([]);
  });

  it("addresses exactly the published clip sources — the slashed form, no named pool — and every one has a clip in the bundled voice", () => {
    const sources = ["pit-window/closed", "pit-window/opened"];

    expect([...familyReferences(PIT_WINDOW_SCRIPT).pools].sort()).toEqual(sources);
    expect(PIT_WINDOW_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);
    expect(Object.keys(SCRIPT.pools ?? {})).toEqual([]);

    for (const { group, base } of PIT_WINDOW_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
      expect(
        manifest.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `fixture manifest carries no ${group}/${base} for the test voice`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped — no unknown pool, condition, case key or fragment", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
