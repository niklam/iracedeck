/**
 * Pit-box count-in tests (issue #758; scripted since #1065).
 *
 * Pins the scheduling contract that reverses #646: the count-in outranks the
 * CHATTER-band pit-service readback and cuts it immediately, stays below the
 * NORMAL band (pit-status, flags, and fuel-critical still win), is never
 * deferred/replayed itself, and holds the bus's pending replay between marks
 * so an interrupted readback doesn't stutter back in the gaps. What each mark
 * SAYS is the bundled voice's `callouts.json`, so the fire-through cases hand
 * the real artifact to the engine and read what played — and that no tick
 * played around it.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, PitBoxMark, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_FRAME, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  PIT_BOX_CLIP_SOURCES,
  PIT_BOX_CONTRACTS,
  PIT_BOX_COUNT_IN_WEIGHT,
  PIT_BOX_PENDING_HOLD_MS,
  PIT_BOX_SCENARIO_IDS,
} from "./pit-box.js";

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

const MARKS: readonly PitBoxMark[] = ["five", "four", "three", "two", "one", "pit-now"];

/** One clip per mark for the test voice, so a pool draw is deterministic and a played path names its mark. */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...PIT_BOX_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script, verbatim. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the family's own entries (and to no
 * fragments — none of these entries includes one). The engine here registers
 * the pit-box family ALONE, and an entry for a contract it does not hold
 * would be a `no contract` warn.
 */
const PIT_BOX_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(PIT_BOX_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
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

  for (const c of PIT_BOX_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, PIT_BOX_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

function countdown(mark: PitBoxMark): SimEventOf<"pitBox.countdown"> {
  return { event: "pitBox.countdown", timestamp: 0, telemetry: null, data: { mark } as never };
}

describe("pit-box count-in scheduling (issue #758)", () => {
  it("outranks the CHATTER-band readback but stays below NORMAL", () => {
    expect(PIT_BOX_COUNT_IN_WEIGHT).toBeGreaterThan(WEIGHT.CHATTER);
    expect(PIT_BOX_COUNT_IN_WEIGHT).toBeLessThan(WEIGHT.NORMAL);
  });

  it("holds the pending replay long enough to bridge the ~1 s gaps between marks", () => {
    expect(PIT_BOX_PENDING_HOLD_MS).toBeGreaterThan(1000);
  });

  it.each(PIT_BOX_CONTRACTS.map((c) => [c.id, c] as const))("%s carries the count-in scheduling fields", (_id, c) => {
    expect(c.weight).toBe(PIT_BOX_COUNT_IN_WEIGHT);
    expect(c.interrupt).toBe(true);
    expect(c.queueable).toBe(false);
    expect(c.pendingHoldMs).toBe(PIT_BOX_PENDING_HOLD_MS);
    expect(c.family).toBe("pit-box");
  });

  it("covers all six marks, in approach order", () => {
    expect(PIT_BOX_SCENARIO_IDS).toEqual([
      "pit-crew.pit-box-five",
      "pit-crew.pit-box-four",
      "pit-crew.pit-box-three",
      "pit-crew.pit-box-two",
      "pit-crew.pit-box-one",
      "pit-crew.pit-box-pit-now",
    ]);
    expect(PIT_BOX_CLIP_SOURCES.map((s) => s.base)).toEqual([...MARKS]);
  });

  it("opts out of the radio frame on the contract, and carries no sequence — the clip is the voice script's (issue #1065)", () => {
    for (const c of PIT_BOX_CONTRACTS) {
      expect(c.frame).toBe(NO_FRAME);
      expect("sequence" in c).toBe(false);
      expect(c.when?.event).toBe("pitBox.countdown");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
    }
  });

  it("each contract answers its own mark and no other", () => {
    for (const c of PIT_BOX_CONTRACTS) {
      const own = c.id.replace("pit-crew.pit-box-", "") as PitBoxMark;

      for (const mark of MARKS) {
        expect(c.when?.where?.(countdown(mark)), `${c.id} on ${mark}`).toBe(mark === own);
      }
    }
  });
});

describe("pit-box fires through the bundled script (issue #1065)", () => {
  it.each(MARKS)("the %s mark plays its clip and nothing else — no tick around it", (mark) => {
    bus.publishEvent("pitBox.countdown", { mark } as never);
    flush(audio);

    expect(audio._played.map((p) => p.path)).toEqual([`voice/${VOICE}/pit-box/${mark}-01.mp3`]);
  });

  it("a voice with no script is silent — the contract alone says nothing", () => {
    engine.setScripts(new Map());

    bus.publishEvent("pitBox.countdown", { mark: "three" } as never);
    flush(audio);

    expect(audio._played).toEqual([]);
  });
});

describe("the bundled script's pit-box entries (issue #1065)", () => {
  it("scripts every mark, each with a comment, a Pit Box harness route and a single pool step", () => {
    for (const mark of MARKS) {
      const id = `pit-crew.pit-box-${mark}`;
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Pit Box → /);
      expect(entry.skip).toBeUndefined();
      // The opt-out is the contract's; an entry that named a frame would put the ticks back.
      expect(entry.frame).toBeUndefined();
      expect(entry.sequence).toEqual([`pool:pit-box/${mark}`]);
    }
  });

  it("references no vocabulary, no fragment and no frame — and the family registers none", () => {
    const refs = collectScriptReferences(PIT_BOX_SCRIPT);
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
    const sources = ["pit-box/five", "pit-box/four", "pit-box/one", "pit-box/pit-now", "pit-box/three", "pit-box/two"];

    expect([...collectScriptReferences(PIT_BOX_SCRIPT).pools].sort()).toEqual(sources);
    expect(PIT_BOX_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);
    expect(Object.keys(SCRIPT.pools ?? {})).toEqual([]);

    for (const { group, base } of PIT_BOX_CLIP_SOURCES) {
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
