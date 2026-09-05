/**
 * Damage-alert tests (issue #489; scripted since #1065).
 *
 * The one contract fires on `damage.repairNeeded.raised` with no `where:` of
 * its own — the rising-edge debounce is the translator's. What it SAYS is the
 * bundled voice's `callouts.json`, so the fire-through case hands the real
 * artifact to the engine and reads what played.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { DAMAGE_CLIP_SOURCES, DAMAGE_CONTRACTS, DAMAGE_SCENARIO_IDS } from "./damage-alerts.js";

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
    ...DAMAGE_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script, verbatim. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the family's own entry (and to no
 * fragments — it includes none). The engine here registers the damage family
 * ALONE, and an entry for a contract it does not hold would be a `no contract`
 * warn.
 */
const DAMAGE_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(DAMAGE_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
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

  for (const c of DAMAGE_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, DAMAGE_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

describe("DAMAGE_CONTRACTS structure", () => {
  it("defines the one repair-needed contract on the damage.repairNeeded.raised edge, with no where: of its own", () => {
    expect(DAMAGE_SCENARIO_IDS).toEqual(["pit-crew.damage-repair-needed"]);

    for (const c of DAMAGE_CONTRACTS) {
      expect(c.when?.event).toBe("damage.repairNeeded.raised");
      expect(c.when?.where).toBeUndefined();
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.family).toBe("damage");
      // Default weight: a meatball (CRITICAL) still wins the bus over the heads-up.
      expect(c.weight).toBeUndefined();
      expect(c.interrupt).toBeUndefined();
      expect(c.queueable).toBeUndefined();
    }
  });

  it("carries no sequence and no frame — the line is the voice script's, framed by the engine (issue #1065)", () => {
    for (const c of DAMAGE_CONTRACTS) {
      expect("sequence" in c).toBe(false);
      expect(c.frame).toBeUndefined();
    }
  });
});

describe("damage fires through the bundled script (issue #1065)", () => {
  it("plays the repair-needed line inside the radio frame", () => {
    bus.publishEvent("damage.repairNeeded.raised", {} as never);
    flush(audio);

    const voice = audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
    const all = audio._played.map((p) => p.path);

    expect(voice).toEqual([`voice/${VOICE}/damage/repair-needed-01.mp3`]);
    expect(all[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(all.at(-1)).toBe("sfx/IRD-tick-close.mp3");
  });

  it("a voice with no script is silent — the contract alone says nothing", () => {
    engine.setScripts(new Map());

    bus.publishEvent("damage.repairNeeded.raised", {} as never);
    flush(audio);

    expect(audio._played).toEqual([]);
  });
});

describe("the bundled script's damage entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Damage harness route and a single pool step", () => {
    const entry = SCRIPT.scenarios["pit-crew.damage-repair-needed"];

    expect(entry).toBeDefined();
    expect(entry.comment?.length ?? 0).toBeGreaterThan(0);
    expect(entry.test).toMatch(/^Harness → Damage → /);
    expect(entry.skip).toBeUndefined();
    expect(entry.frame).toBeUndefined();
    expect(entry.sequence).toEqual(["pool:damage/repair-needed"]);
  });

  it("references no vocabulary, no fragment and no frame — and the family registers none", () => {
    const refs = collectScriptReferences(DAMAGE_SCRIPT);
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

  it("addresses exactly the published clip source — the slashed form, no named pool — and it has a clip in the bundled voice", () => {
    const sources = ["damage/repair-needed"];

    expect([...collectScriptReferences(DAMAGE_SCRIPT).pools].sort()).toEqual(sources);
    expect(DAMAGE_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);
    expect(Object.keys(SCRIPT.pools ?? {})).toEqual([]);

    for (const { group, base } of DAMAGE_CLIP_SOURCES) {
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
