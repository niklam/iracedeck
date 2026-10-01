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

import type { ScenarioContext } from "../../dsl.js";
import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { DAMAGE_CLIP_SOURCES, DAMAGE_CONTRACTS, DAMAGE_SCENARIO_IDS, damageStillNeedsRepair } from "./damage-alerts.js";
import {
  _resetLastIncidentPoints,
  INCIDENT_CLIP_SOURCES,
  INCIDENT_CONTRACTS,
  INCIDENT_SCENARIO_IDS,
  registerIncidentVocabulary,
} from "./incidents.js";
import { QUALIFYING_INVALIDATION_SCENARIO_IDS } from "./qualifying-invalidation.js";

// The speak-time gate reads the translator's SETTLED damage state (issue
// #1288), never a raw tick — that the getter rides out a flicker is tested in
// `sim-events-iracing`'s translator tests. `null` — not known — unless a test
// sets it.
const mockRepairNeeded = vi.fn((): boolean | null => null);

vi.mock("@iracedeck/sim-events-iracing", () => ({
  isDamageRepairNeeded: () => mockRepairNeeded(),
}));

/** The settled state with a repair needed, and with the repair done. */
const DAMAGED = true;
const REPAIRED = false;

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
  mockRepairNeeded.mockReset();
  mockRepairNeeded.mockReturnValue(null);
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
  it("defines the one repair-needed contract on the damage.repairNeeded.raised edge, with no where: of its own, queued behind the incident lines (issue #1211)", () => {
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
      // Waits for a held or busy bus (issue #1211), behind the incident line
      // for the same crash, or the lap-invalidation line in its place.
      expect(c.queueable).toBe(true);
      expect([...(c.queueBehind ?? [])]).toEqual([...INCIDENT_SCENARIO_IDS, ...QUALIFYING_INVALIDATION_SCENARIO_IDS]);
      expect(c.pendingHoldMs).toBeUndefined();
      // Re-checks the settled damage state at speak time (issue #1288).
      expect(c.speakGate?.admit).toBe(damageStillNeedsRepair);
      expect(c.speakGate?.description).toContain("still needs a repair");
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

/**
 * Issue #1211 / #1288: the damage line queues, waits behind the incident line
 * for the same crash, and is skipped once the repair has settled as done. The
 * engine here holds both families, as `registerPitCrew` does, with the
 * bundled script narrowed to them.
 */
describe("the damage line behind a held or busy bus (issues #1211, #1288)", () => {
  const OTHER_LINE = `voice/${VOICE}/other/line-01.mp3`;
  const DAMAGE_LINE = `voice/${VOICE}/damage/repair-needed-01.mp3`;
  const COMBINED_MANIFEST: AudioAssetsManifest = {
    ...manifest,
    clips: [
      ...manifest.clips,
      ...INCIDENT_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
      ...[1, 2, 4].map((n) => `voice/${VOICE}/incidents/points-${n}.mp3`),
      OTHER_LINE,
    ],
  };
  const COMBINED_SCRIPT: CalloutScript = {
    ...SCRIPT,
    scenarios: Object.fromEntries(
      [...DAMAGE_SCENARIO_IDS, ...INCIDENT_SCENARIO_IDS].map((id) => [id, SCRIPT.scenarios[id]]),
    ),
    fragments: {},
  };

  beforeEach(() => {
    _resetAudioScenarios();
    _resetLastIncidentPoints();
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, COMBINED_MANIFEST, mockLogger as never, () => VOICE);

    // The production order: damage first, then the incident vocabulary and
    // contracts — `queueBehind` matches by id at fire time.
    for (const c of DAMAGE_CONTRACTS) engine.defineContract(c);

    registerIncidentVocabulary(engine);

    for (const c of INCIDENT_CONTRACTS) engine.defineContract(c);

    engine.setScripts(new Map([[VOICE, COMBINED_SCRIPT]]));
    mockRepairNeeded.mockReturnValue(DAMAGED);
  });

  afterEach(() => {
    _resetLastIncidentPoints();
  });

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  function publishIncident(type: string, points: number): void {
    bus.publishEvent("incident.occurred", { type, delta: points, points } as never);
  }

  function publishDamage(): void {
    bus.publishEvent("damage.repairNeeded.raised", {} as never);
  }

  function holdSpotterFloor(): void {
    engine.acquireFocus(AudioBus.Voice, "spotter", WEIGHT.SAFETY);
  }

  function releaseSpotterFloor(): void {
    engine.releaseFocus(AudioBus.Voice, "spotter");
  }

  describe("behind the incident line", () => {
    it("on an idle bus the incident published first plays and the damage line follows it", () => {
      publishIncident("collision-car", 4);
      publishDamage();
      flush(audio);

      expect(voicePaths()).toEqual([
        `voice/${VOICE}/incidents/collision-car-01.mp3`,
        `voice/${VOICE}/incidents/points-4.mp3`,
        DAMAGE_LINE,
      ]);
    });

    it("under the spotter's floor the damage line attaches behind the waiting incident line", () => {
      holdSpotterFloor();
      publishIncident("collision-car", 4);
      publishDamage();
      flush(audio);

      expect(voicePaths()).toEqual([]);

      releaseSpotterFloor();
      flush(audio);

      expect(voicePaths()).toEqual([
        `voice/${VOICE}/incidents/collision-car-01.mp3`,
        `voice/${VOICE}/incidents/points-4.mp3`,
        DAMAGE_LINE,
      ]);
    });

    it("a damage line waiting alone moves behind an incident line that arrives after it", () => {
      holdSpotterFloor();
      publishDamage();
      publishIncident("collision-car", 4);
      releaseSpotterFloor();
      flush(audio);

      expect(voicePaths()).toEqual([
        `voice/${VOICE}/incidents/collision-car-01.mp3`,
        `voice/${VOICE}/incidents/points-4.mp3`,
        DAMAGE_LINE,
      ]);
    });

    it("an escalation replacing the waiting off-track line keeps the damage line behind it (the 14:54 log)", () => {
      holdSpotterFloor();
      publishIncident("off-track", 1);
      publishDamage();
      publishIncident("collision-world", 2);
      releaseSpotterFloor();
      flush(audio);

      expect(voicePaths()).toEqual([
        `voice/${VOICE}/incidents/collision-world-01.mp3`,
        `voice/${VOICE}/incidents/points-2.mp3`,
        DAMAGE_LINE,
      ]);
    });
  });

  describe("the speak-time gate on the settled damage state (issue #1288)", () => {
    function holdBusWithCaution(): void {
      engine.defineScenario({
        id: "test.caution",
        channel: AudioChannel.Voice,
        bus: AudioBus.Voice,
        family: "caution",
        weight: WEIGHT.SAFETY,
        sequence: [OTHER_LINE],
      });
      engine.fire("test.caution"); // playing, not flushed
    }

    it("a damage line behind a SAFETY caution call waits and plays after it while a repair is needed (the #1288 log)", () => {
      holdBusWithCaution();
      publishDamage();
      flush(audio);

      expect(voicePaths()).toEqual([OTHER_LINE, DAMAGE_LINE]);
    });

    it("the same line replaying after the repair settled as done is refused, and stamps nothing", () => {
      holdBusWithCaution();
      publishDamage();
      mockRepairNeeded.mockReturnValue(REPAIRED); // repaired while it waited
      flush(audio);

      expect(voicePaths()).toEqual([OTHER_LINE]);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(`Scenario "pit-crew.damage-repair-needed" skipped — speak-time gate`),
      );

      // Nothing was claimed or stamped: the next damage episode speaks at once.
      mockRepairNeeded.mockReturnValue(DAMAGED);
      publishDamage();
      flush(audio);

      expect(voicePaths()).toEqual([OTHER_LINE, DAMAGE_LINE]);
    });

    it("an imperative fire is admitted with the repair done (the harness buttons)", () => {
      mockRepairNeeded.mockReturnValue(REPAIRED);

      engine.fire("pit-crew.damage-repair-needed");
      flush(audio);

      expect(voicePaths()).toEqual([DAMAGE_LINE]);
    });

    it("a waiting line replaying with the damage state unknown is admitted — nothing disproves the damage", () => {
      holdBusWithCaution();
      publishDamage();
      mockRepairNeeded.mockReturnValue(null);
      flush(audio);

      expect(voicePaths()).toEqual([OTHER_LINE, DAMAGE_LINE]);
    });

    it("refuses only a settled false: admits true, an unknown state and an imperative fire", () => {
      const ctx = (event: SimEventOf<SimEventName> | null): ScenarioContext => ({
        event,
        telemetry: null,
        data: null,
        now: 0,
        vars: {},
      });
      const raised = {
        event: "damage.repairNeeded.raised",
        timestamp: 0,
        telemetry: null,
        data: {},
      } as unknown as SimEventOf<SimEventName>;

      mockRepairNeeded.mockReturnValue(true);
      expect(damageStillNeedsRepair(ctx(raised))).toBe(true);

      mockRepairNeeded.mockReturnValue(null);
      expect(damageStillNeedsRepair(ctx(raised))).toBe(true);

      mockRepairNeeded.mockReturnValue(false);
      expect(damageStillNeedsRepair(ctx(raised))).toBe(false);
      expect(damageStillNeedsRepair(ctx(null))).toBe(true);
    });
  });
});
