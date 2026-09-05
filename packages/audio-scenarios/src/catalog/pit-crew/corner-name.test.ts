/**
 * Corner-name callout tests (issue #888; scripted since #1065).
 *
 * Drives the contract through the real scenario engine with the bundled
 * voice's real `callouts.json`, narrowed to this family: what the callout
 * says is the script's one `{{cornerName.clip}}` step, so every fire below
 * exercises the same compile + expansion path production uses.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_FRAME, poolRef } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  buildCornerNameContract,
  CORNER_NAME_SCENARIO_IDS,
  type CornerNameSnapshot,
  registerCornerNameVocabulary,
  SCENARIO_ID_TO_CORNER_NAME_ID,
} from "./corner-name.js";

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
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
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
  _played: { channel: AudioChannel; path: string }[];
};

function createFakeAudio(): FakeAudio {
  const callbacks: Record<AudioChannel, (() => void) | null> = {
    [AudioChannel.Ambient]: null,
    [AudioChannel.SFX]: null,
    [AudioChannel.Voice]: null,
    [AudioChannel.Radar]: null,
  };
  const played: { channel: AudioChannel; path: string }[] = [];

  return {
    init: vi.fn(() => true),
    destroy: vi.fn(),
    playOnChannel: vi.fn((channel: AudioChannel, path: string) => {
      played.push({ channel, path });

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

function flush(audio: FakeAudio, iterations = 10): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

/** The fixture voice knows two corners; every other slug has no clip. */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    `voice/${VOICE}/corner-names/eau-rouge-01.mp3`,
    `voice/${VOICE}/corner-names/turn-5-01.mp3`,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's entry (F7-trap i): an entry
 * for a contract this engine does not hold is a `no contract` warn, and a
 * foreign fragment would widen `collectScriptReferences`.
 */
const CORNER_NAME_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(CORNER_NAME_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;
let snapshot: CornerNameSnapshot | null;

function cornerEvent(data: { name: string; slug: string }): SimEventOf<"cornerName.approaching"> {
  return { event: "cornerName.approaching", data } as SimEventOf<"cornerName.approaching">;
}

function approach(name: string, slug: string): void {
  snapshot = { name, slug };
  bus.publishEvent("cornerName.approaching", { name, slug });
  flush(audio);
}

function played(): string[] {
  return audio._played.map((p) => p.path);
}

beforeEach(() => {
  snapshot = null;
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  // The production order (`registerPitCrew`): vocabulary, the contract, then
  // the script. The family is registered ALONE here, so only its own compile
  // diagnostics can appear.
  registerCornerNameVocabulary(engine, () => snapshot);
  engine.defineContract(buildCornerNameContract(() => snapshot));
  engine.setScripts(new Map([[VOICE, CORNER_NAME_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

describe("buildCornerNameContract", () => {
  it("has the terse non-queueable corner-name shape and no sequence — the name is the voice script's", () => {
    const c = buildCornerNameContract(() => null);

    expect(c.id).toBe("pit-crew.corner-name-approaching");
    expect(c.when?.event).toBe("cornerName.approaching");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.family).toBe("corner-name");
    expect(c.queueable).toBe(false);
    expect(c.frame).toBe(NO_FRAME);
    expect(c.weight).toBeUndefined();
    expect("sequence" in c).toBe(false);
  });

  it("where: requires a usable slug and a populated snapshot", () => {
    let s: CornerNameSnapshot | null = null;
    const c = buildCornerNameContract(() => s);
    const good = cornerEvent({ name: "Eau Rouge", slug: "eau-rouge" });

    expect(c.when?.where?.(good)).toBe(false); // snapshot not populated yet

    s = { name: "Eau Rouge", slug: "eau-rouge" };
    expect(c.when?.where?.(good)).toBe(true);
    expect(c.when?.where?.(cornerEvent({ name: "", slug: "" }))).toBe(false);
  });
});

describe("registerCornerNameVocabulary", () => {
  it("resolves cornerName.clip to the group/slug pool, null without a snapshot", () => {
    const vars = new Map<string, () => unknown>();
    const stub = {
      defineVar: vi.fn((name: string, fn: () => unknown) => vars.set(name, fn)),
    } as unknown as IScenarioEngine;
    let s: CornerNameSnapshot | null = null;

    registerCornerNameVocabulary(stub, () => s);

    const resolve = vars.get("cornerName.clip");

    expect(resolve).toBeDefined();
    expect(resolve!()).toBeNull();

    s = { name: "Eau Rouge", slug: "eau-rouge" };
    expect(resolve!()).toEqual(poolRef("corner-names", "eau-rouge"));
  });

  it("publishes the var with a description naming the corner-names group, for a pack author", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const clip = vars.find((v) => v.name === "cornerName.clip");

    expect(clip).toBeDefined();
    expect(clip?.description).toContain("corner-names");
    expect(conds.filter((c) => c.name.startsWith("cornerName."))).toEqual([]);
    expect(cases.filter((c) => c.name.startsWith("cornerName."))).toEqual([]);
  });
});

describe("the corner-name callout through the real script", () => {
  it("speaks the corner's clip alone — no frame ticks around a terse name", () => {
    approach("Eau Rouge", "eau-rouge");

    expect(played()).toEqual([`voice/${VOICE}/corner-names/eau-rouge-01.mp3`]);
  });

  it("speaks whichever corner the snapshot names at expansion time", () => {
    approach("Turn 5", "turn-5");

    expect(played()).toEqual([`voice/${VOICE}/corner-names/turn-5-01.mp3`]);
  });

  it("stays silent for a corner the active voice has no clip for — the whole callout, never a fragment (issue #835)", () => {
    approach("Raidillon", "raidillon");

    expect(played()).toEqual([]);
  });

  it("stays silent for a voice whose script has no entry — a contract has nothing of its own to say", () => {
    engine.setScripts(new Map([[VOICE, { ...CORNER_NAME_SCRIPT, scenarios: {} }]]));
    approach("Eau Rouge", "eau-rouge");

    expect(played()).toEqual([]);
  });
});

describe("the bundled script's corner-name entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Corner Names harness route and a sequence", () => {
    for (const id of CORNER_NAME_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Corner Names → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("references only the var this family registers and no pool — the name is var-driven from corner-names/<slug>", () => {
    const refs = collectScriptReferences(CORNER_NAME_SCRIPT);

    expect(refs.vars).toEqual(["cornerName.clip"]);
    expect(refs.pools).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(engine.vocabulary().vars.map((v) => v.name)).toContain("cornerName.clip");
  });

  it("the bundled voice ships corner clips the var can draw from — the dynamic group is not empty", () => {
    const pattern = poolMemberPattern("corner-names", "eau-rouge");

    expect(MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE)).toBe(true);
  });

  it("compiles for the test voice with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("family wiring", () => {
  it("maps every scenario id to the corner-names opt-in", () => {
    expect(CORNER_NAME_SCENARIO_IDS.length).toBeGreaterThan(0);

    for (const id of CORNER_NAME_SCENARIO_IDS) {
      expect(SCENARIO_ID_TO_CORNER_NAME_ID[id]).toBe("corner-names");
    }
  });
});
