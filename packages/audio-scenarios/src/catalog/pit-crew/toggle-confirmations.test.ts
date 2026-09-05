/**
 * Toggle-confirmation tests (issues #464, #468; scripted since #1065).
 *
 * Every contract fires through the bundled voice's real `callouts.json` for
 * two test voices, so what plays is the script's `acknowledgment → line` pair
 * resolved against each voice's own clips — the way the plugin runs them.
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
import {
  FAST_REPAIR_TOGGLE_CONTRACTS,
  FUEL_TOGGLE_CONTRACTS,
  TIRE_COMPOUND_CONTRACTS,
  TIRE_SET_NAMES,
  TIRE_TOGGLE_CONTRACTS,
  TOGGLE_CONFIRMATION_CLIP_SOURCES,
  TOGGLE_CONFIRMATION_CONTRACTS,
  TOGGLE_CONFIRMATION_SCENARIO_IDS,
  WINDSHIELD_TOGGLE_CONTRACTS,
} from "./toggle-confirmations.js";

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

const VOICE_KEYS = ["luca", "titan"] as const;

/**
 * The fixture manifest mirrors the bundled voice's clip naming for the
 * pit-actions group: the acknowledgment and the fuel / tires-off lines are
 * `-NN` variants, every other line a single bare clip — the pool matcher
 * admits both, and the shape is what `poolMemberPattern` is pinned on.
 */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...VOICE_KEYS.flatMap((v) => [
      `voice/${v}/pit-actions/acknowledgment-01.mp3`,
      `voice/${v}/pit-actions/acknowledgment-02.mp3`,
      `voice/${v}/pit-actions/acknowledgment-03.mp3`,
      `voice/${v}/pit-actions/fuel-on-01.mp3`,
      `voice/${v}/pit-actions/fuel-off-01.mp3`,
      `voice/${v}/pit-actions/tires-off-01.mp3`,
      ...TIRE_SET_NAMES.map((name) => `voice/${v}/pit-actions/tires-on-${name}.mp3`),
      `voice/${v}/pit-actions/tires-compound-dry.mp3`,
      `voice/${v}/pit-actions/tires-compound-wet.mp3`,
      `voice/${v}/pit-actions/windshield-on.mp3`,
      `voice/${v}/pit-actions/windshield-off.mp3`,
      `voice/${v}/pit-actions/fast-repair-on.mp3`,
      `voice/${v}/pit-actions/fast-repair-off.mp3`,
    ]),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script, verbatim. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the family's twenty-four entries (and to no
 * fragments — none of them includes one), handed to BOTH test voices. The
 * engine here registers the toggle family ALONE, and an entry for a contract
 * it does not hold would be a `no contract` warn.
 */
const TOGGLE_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(TOGGLE_CONFIRMATION_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

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

  // The production order (`registerPitCrew`): contracts, then the scripts —
  // the family registers no vocabulary and no pools; every step addresses
  // its clip group directly, resolved against the manifest at fire time.
  for (const c of TOGGLE_CONFIRMATION_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map(VOICE_KEYS.map((v) => [v, TOGGLE_SCRIPT])));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

describe("TOGGLE_CONFIRMATION_CONTRACTS structure (issue #1065)", () => {
  it("is the five groups in registration order, twenty-four contracts with unique ids", () => {
    expect(TOGGLE_CONFIRMATION_CONTRACTS).toEqual([
      ...FUEL_TOGGLE_CONTRACTS,
      ...TIRE_TOGGLE_CONTRACTS,
      ...TIRE_COMPOUND_CONTRACTS,
      ...WINDSHIELD_TOGGLE_CONTRACTS,
      ...FAST_REPAIR_TOGGLE_CONTRACTS,
    ]);
    expect(TOGGLE_CONFIRMATION_CONTRACTS).toHaveLength(24);
    expect(new Set(TOGGLE_CONFIRMATION_SCENARIO_IDS).size).toBe(24);
    expect(TIRE_TOGGLE_CONTRACTS).toHaveLength(16);
  });

  it("keeps the voice channel, bus and base, the default weight and frame, and carries no sequence", () => {
    for (const c of TOGGLE_CONFIRMATION_CONTRACTS) {
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.weight).toBeUndefined();
      expect(c.interrupt).toBeUndefined();
      expect(c.queueable).toBeUndefined();
      expect(c.frame).toBeUndefined();
      expect("sequence" in c).toBe(false);
    }
  });

  it("keeps the four family names — fuel, tire-service (sets and compounds together), windshield, fast repair", () => {
    for (const c of FUEL_TOGGLE_CONTRACTS) expect(c.family).toBe("pit-service.fuel");

    for (const c of [...TIRE_TOGGLE_CONTRACTS, ...TIRE_COMPOUND_CONTRACTS]) expect(c.family).toBe("tire-service");

    for (const c of WINDSHIELD_TOGGLE_CONTRACTS) expect(c.family).toBe("pit-service.windshield");

    for (const c of FAST_REPAIR_TOGGLE_CONTRACTS) expect(c.family).toBe("pit-service.fast-repair");
  });
});

describe("FUEL_TOGGLE_CONTRACTS", () => {
  it("fires fuel-on when pitService.toggled { fuel, on: true } and resolves voice/{voice}", () => {
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/fuel-on-01.mp3");
  });

  it("speaks the acknowledgment then the toggle line, inside the engine's radio frame (issue #1064)", () => {
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true } as never);
    flush(audio);

    const played = audio._played.map((p) => p.path);

    expect(played[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(played.at(-1)).toBe("sfx/IRD-tick-close.mp3");

    const voice = voiceClipsPlayed();

    expect(voice).toHaveLength(2);
    expect(voice[0]).toMatch(/^voice\/luca\/pit-actions\/acknowledgment-/);
    expect(voice[1]).toBe("voice/luca/pit-actions/fuel-on-01.mp3");
  });

  it("fires fuel-off when pitService.toggled { fuel, on: false }", () => {
    bus.publishEvent("pitService.toggled", { service: "fuel", on: false });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/fuel-off-01.mp3");
  });

  it("does not fire any fuel contract for a non-fuel service (windshield)", () => {
    bus.publishEvent("pitService.toggled", { service: "windshield", on: true });
    flush(audio);

    // The fuel contracts filter on `data.service === "fuel"` and must not match.
    expect(voiceClipsPlayed()).not.toContain("voice/luca/pit-actions/fuel-on-01.mp3");
    expect(voiceClipsPlayed()).not.toContain("voice/luca/pit-actions/fuel-off-01.mp3");
  });

  it("substitutes the active voice — switching voice changes resolved path", () => {
    activeVoice = "titan";
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/titan/pit-actions/fuel-on-01.mp3");
  });

  it("a voice with no script is silent — the contract alone says nothing", () => {
    engine.setScripts(new Map());

    bus.publishEvent("pitService.toggled", { service: "fuel", on: true });
    flush(audio);

    expect(audio._played).toEqual([]);
  });
});

describe("TIRE_TOGGLE_CONTRACTS", () => {
  // Coverage is exhaustive across the 15 non-empty 4-corner combinations.
  // The empty-set case is exercised separately below via the tire-set-off contract.
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

describe("TIRE_COMPOUND_CONTRACTS", () => {
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

describe("WINDSHIELD_TOGGLE_CONTRACTS", () => {
  it("fires windshield-on when pitService.toggled { windshield, on: true }", () => {
    bus.publishEvent("pitService.toggled", { service: "windshield", on: true });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/windshield-on.mp3");
  });

  it("fires windshield-off when pitService.toggled { windshield, on: false }", () => {
    bus.publishEvent("pitService.toggled", { service: "windshield", on: false });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/windshield-off.mp3");
  });

  it("does not fire on a non-windshield service (fuel)", () => {
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true });
    flush(audio);

    const played = voiceClipsPlayed();

    expect(played).not.toContain("voice/luca/pit-actions/windshield-on.mp3");
    expect(played).not.toContain("voice/luca/pit-actions/windshield-off.mp3");
  });

  it("substitutes the active voice for windshield toggles", () => {
    activeVoice = "titan";
    bus.publishEvent("pitService.toggled", { service: "windshield", on: true });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/titan/pit-actions/windshield-on.mp3");
  });
});

describe("FAST_REPAIR_TOGGLE_CONTRACTS", () => {
  it("fires fast-repair-on when pitService.toggled { fastRepair, on: true }", () => {
    bus.publishEvent("pitService.toggled", { service: "fastRepair", on: true });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/fast-repair-on.mp3");
  });

  it("fires fast-repair-off when pitService.toggled { fastRepair, on: false }", () => {
    bus.publishEvent("pitService.toggled", { service: "fastRepair", on: false });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/luca/pit-actions/fast-repair-off.mp3");
  });

  it("does not fire on a non-fast-repair service (fuel)", () => {
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true });
    flush(audio);

    const played = voiceClipsPlayed();

    expect(played).not.toContain("voice/luca/pit-actions/fast-repair-on.mp3");
    expect(played).not.toContain("voice/luca/pit-actions/fast-repair-off.mp3");
  });

  it("substitutes the active voice for fast-repair toggles", () => {
    activeVoice = "titan";
    bus.publishEvent("pitService.toggled", { service: "fastRepair", on: true });
    flush(audio);

    expect(voiceClipsPlayed()).toContain("voice/titan/pit-actions/fast-repair-on.mp3");
  });
});

describe("the bundled script's toggle-confirmation entries (issue #1065)", () => {
  /** Contract id → the base of the line that follows the acknowledgment. */
  const LINE_BASES: Record<string, string> = {
    "pit-crew.toggle-fuel-on": "fuel-on",
    "pit-crew.toggle-fuel-off": "fuel-off",
    ...Object.fromEntries(TIRE_SET_NAMES.map((name) => [`pit-crew.tire-set-on-${name}`, `tires-on-${name}`])),
    "pit-crew.tire-set-off": "tires-off",
    "pit-crew.tire-compound-dry": "tires-compound-dry",
    "pit-crew.tire-compound-wet": "tires-compound-wet",
    "pit-crew.toggle-windshield-on": "windshield-on",
    "pit-crew.toggle-windshield-off": "windshield-off",
    "pit-crew.toggle-fast-repair-on": "fast-repair-on",
    "pit-crew.toggle-fast-repair-off": "fast-repair-off",
  };

  it("scripts every contract as the acknowledgment then its own line, with a comment and a Pit Service / Tire Service harness route", () => {
    expect(Object.keys(LINE_BASES).sort()).toEqual([...TOGGLE_CONFIRMATION_SCENARIO_IDS].sort());

    for (const [id, base] of Object.entries(LINE_BASES)) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → (Pit Service|Tire Service) → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.frame).toBeUndefined();
      expect(entry.sequence, id).toEqual(["pool:pit-actions/acknowledgment", `pool:pit-actions/${base}`]);
    }
  });

  it("references no vocabulary, no fragment and no frame — and the family registers none", () => {
    const refs = collectScriptReferences(TOGGLE_SCRIPT);
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

  it("addresses exactly the published clip sources — the slashed form throughout, no named pool for the acknowledgment — and every one has a clip in the bundled voice", () => {
    // `pit-actions/acknowledgment` is a different `(group, base)` from the
    // generic `acknowledgment/acknowledgment`, so its no-repeat tracker is its
    // own by construction: the alias the old registry named for that purpose
    // has no decision left to carry, and the script's `pools` stays empty.
    const sources = [
      "pit-actions/acknowledgment",
      "pit-actions/fast-repair-off",
      "pit-actions/fast-repair-on",
      "pit-actions/fuel-off",
      "pit-actions/fuel-on",
      "pit-actions/tires-compound-dry",
      "pit-actions/tires-compound-wet",
      "pit-actions/tires-off",
      "pit-actions/tires-on-all",
      "pit-actions/tires-on-fronts",
      "pit-actions/tires-on-lefts",
      "pit-actions/tires-on-lf",
      "pit-actions/tires-on-lf-rr",
      "pit-actions/tires-on-lr",
      "pit-actions/tires-on-rears",
      "pit-actions/tires-on-rf",
      "pit-actions/tires-on-rf-lr",
      "pit-actions/tires-on-rights",
      "pit-actions/tires-on-rr",
      "pit-actions/tires-on-skip-lf",
      "pit-actions/tires-on-skip-lr",
      "pit-actions/tires-on-skip-rf",
      "pit-actions/tires-on-skip-rr",
      "pit-actions/windshield-off",
      "pit-actions/windshield-on",
    ];

    expect([...collectScriptReferences(TOGGLE_SCRIPT).pools].sort()).toEqual(sources);
    expect(TOGGLE_CONFIRMATION_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);
    expect(Object.keys(SCRIPT.pools ?? {})).toEqual([]);

    for (const { group, base } of TOGGLE_CONFIRMATION_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);

      const voices = new Set(manifest.clips.map((clip) => pattern.exec(clip)?.[1]).filter((v) => v !== undefined));

      expect([...voices].sort(), `${group}/${base}`).toEqual([...VOICE_KEYS].sort());
    }
  });

  it("a single-corner base never matches a diagonal's clip — the pool rule admits `-NN` only, so `tires-on-lf` excludes `tires-on-lf-rr`", () => {
    const lf = poolMemberPattern("pit-actions", "tires-on-lf");

    expect(lf.test(`voice/luca/pit-actions/tires-on-lf.mp3`)).toBe(true);
    expect(lf.test(`voice/luca/pit-actions/tires-on-lf-rr.mp3`)).toBe(false);
    expect(lf.test(`voice/luca/pit-actions/tires-on-lf-01.mp3`)).toBe(true);
  });

  it("compiles for both voices with nothing skipped — no unknown pool, condition, case key or fragment", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
