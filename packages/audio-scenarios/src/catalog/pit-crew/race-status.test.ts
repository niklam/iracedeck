/**
 * Race-status periodic position update tests (issue #569; scripted since
 * #1065), focused on the class-aware "still leading" wording added in issue
 * #599.
 *
 * Drives the contract through the real scenario engine — same harness shape
 * as `race-start.test.ts` / `overtake.test.ts` — with the bundled voice's REAL
 * `callouts.json` narrowed to this family's entry, so var resolution and the
 * leader branch all run the production compile + expansion path. The spoken
 * line reads LIVE position via the `getLivePosition` resolver (issue #574), so
 * the class-vs-race wording is driven by `currentLive.isMultiClass`.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { _resetPositionReadoutCooldown, registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import {
  buildRaceStatusContract,
  RACE_STATUS_CLIP_SOURCES,
  RACE_STATUS_SCENARIO_IDS,
  raceStatusCadenceHits,
} from "./race-status.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
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
      for (const handler of Array.from(handlers.get(event.event as SimEventName) ?? [])) handler(event);
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

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

const RACE_STATUS_CLIPS = [
  `voice/${VOICE}/race-status/still-leading-01.mp3`,
  `voice/${VOICE}/race-status/still-leading-class-01.mp3`,
  `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
  ...Array.from({ length: 64 }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
];

const manifest: AudioAssetsManifest = {
  clips: ["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3", "sfx/IRD-ambient-pit.mp3", ...RACE_STATUS_CLIPS],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

/** The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's own entry (and to no
 * fragments — it includes none): an entry for a contract this engine does
 * not hold is a `no contract` warn, and a foreign fragment would widen
 * `collectScriptReferences` under the assertions below.
 */
const RACE_STATUS_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(RACE_STATUS_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

type LapSnap = SimEventOf<"lap.completed">["data"];
type Live = { position: number; classPosition: number; isMultiClass: boolean };

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let currentSnapshot: LapSnap | null;
let currentLive: Live | null;
let raceFinished: boolean;
let raceStatusEnabled: boolean;

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

/** Fire an every-3-laps cadence hit in a race session (position held). */
function fireStatus(): void {
  const data: Partial<LapSnap> = {
    lap: 6,
    lapTime: 90.5,
    isBest: false,
    sessionType: "race",
    lapsSincePositionChange: 3,
    // Held position keeps the position-change (#566) scenario silent so only
    // the race-status callout speaks.
    position: 1,
    previousPosition: 1,
  };
  currentSnapshot = data as LapSnap;
  bus.publishEvent("lap.completed", data as LapSnap);
  flush(audio);
}

beforeEach(() => {
  currentSnapshot = null;
  currentLive = { position: 1, classPosition: 1, isMultiClass: false };
  raceFinished = false;
  raceStatusEnabled = true;
  _resetPositionReadoutCooldown();
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getLapCompletedSnapshot: () => currentSnapshot,
    getRaceStatusCalloutEnabled: () => raceStatusEnabled,
    getRaceFinishedFired: () => raceFinished,
    getLivePosition: () => currentLive,
  });
  // After the registration, as the plugins do: the update's body is looked
  // up in the active voice's compiled script at fire time (issue #1065).
  getScenarioEngine().setScripts(new Map([[VOICE, RACE_STATUS_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  _resetPositionReadoutCooldown();
  vi.clearAllMocks();
});

describe("raceStatusCadenceHits", () => {
  it("fires on a positive multiple of 3, stays silent otherwise", () => {
    expect(raceStatusCadenceHits({ lapsSincePositionChange: 3 } as LapSnap)).toBe(true);
    expect(raceStatusCadenceHits({ lapsSincePositionChange: 6 } as LapSnap)).toBe(true);
    expect(raceStatusCadenceHits({ lapsSincePositionChange: 2 } as LapSnap)).toBe(false);
    expect(raceStatusCadenceHits({ lapsSincePositionChange: 0 } as LapSnap)).toBe(false);
    expect(raceStatusCadenceHits({} as LapSnap)).toBe(false);
  });
});

describe("race-status still-leading wording (#599)", () => {
  it("single-class leader speaks 'still leading the race'", () => {
    currentLive = { position: 1, classPosition: 1, isMultiClass: false };
    fireStatus();

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/race-status/still-leading-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/race-status/still-leading-class-01.mp3`);
  });

  it("multi-class CLASS leader speaks 'still leading our class'", () => {
    // Class P1 while overall P8 — leading the class, not the race.
    currentLive = { position: 8, classPosition: 1, isMultiClass: true };
    fireStatus();

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/race-status/still-leading-class-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/race-status/still-leading-01.mp3`);
  });

  it("multi-class non-leader speaks the intro + class number, not a leading line", () => {
    currentLive = { position: 8, classPosition: 3, isMultiClass: true };
    fireStatus();

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-number/3.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/race-status/still-leading-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/race-status/still-leading-class-01.mp3`);
  });

  it("single-class non-leader reads intro then number, in the script's order", () => {
    currentLive = { position: 5, classPosition: 5, isMultiClass: false };
    fireStatus();

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/5.mp3`,
    ]);
  });
});

describe("race-status gating", () => {
  it("is suppressed when the per-callout opt-in is off", () => {
    raceStatusEnabled = false;
    fireStatus();

    expect(voicePaths()).toEqual([]);
  });

  it("is suppressed on the final lap of a race when race-end fires (issue #569)", () => {
    raceFinished = true;
    fireStatus();

    expect(voicePaths()).toEqual([]);
  });

  it("a voice with no script plays no status update at all — no line, no frame (issue #1065)", () => {
    getScenarioEngine().setScripts(new Map([["titan", RACE_STATUS_SCRIPT]]));
    fireStatus();

    expect(audio._played).toEqual([]);
  });
});

describe("buildRaceStatusContract (issue #1065)", () => {
  it("carries no sequence and keeps every scheduling field verbatim, taking the engine's default frame", () => {
    const c = buildRaceStatusContract(() => false);

    expect("sequence" in c).toBe(false);
    expect(c.id).toBe("pit-crew.race-status");
    expect([...RACE_STATUS_SCENARIO_IDS]).toEqual([c.id]);
    expect(c.when?.event).toBe("lap.completed");
    expect(c.channel).toBe(AudioChannel.Voice);
    expect(c.bus).toBe(AudioBus.Voice);
    expect(c.base).toBe("voice/{voice}");
    expect(c.weight).toBe(WEIGHT.CHATTER);
    expect(c.queueable).toBe(true);
    expect(c.family).toBe("race-status");
    expect(c.interrupt).toBeUndefined();
    expect(c.cooldown).toBeUndefined();
    expect(c.triggerDelay).toBeUndefined();
    expect(c.frame).toBeUndefined();
  });
});

describe("registerRaceStatusVocabulary (issue #1065)", () => {
  it("publishes the three vars and the leader condition, each with a description for a pack author", () => {
    const { vars, conds } = getScenarioEngine().vocabulary();
    const ours = (name: string) => name.startsWith("raceStatus.");

    expect(vars.filter((v) => ours(v.name)).map((v) => v.name)).toEqual([
      "raceStatus.intro",
      "raceStatus.number",
      "raceStatus.stillLeading",
    ]);
    expect(conds.filter((c) => ours(c.name)).map((c) => c.name)).toEqual(["raceStatus.isLeading"]);

    for (const entry of [...vars, ...conds].filter((e) => ours(e.name))) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
    }
  });
});

describe("the bundled script's race-status entry (issue #1065)", () => {
  it("scripts the contract with a comment, a Race harness route that says the harness is mute, and a sequence", () => {
    for (const id of RACE_STATUS_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Scenario Shortcuts → Race → Status update \(P5 on lap 7\)/);
      expect(entry.test).toContain("MUTE");
      expect(entry.test).toContain("In-sim:");
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("branches on the leader condition: the whole leading line, else intro + a required number", () => {
    expect(SCRIPT.scenarios["pit-crew.race-status"].sequence).toEqual([
      {
        if: "raceStatus.isLeading",
        then: ["{{raceStatus.stillLeading}}"],
        else: ["{{raceStatus.intro}}", "{{raceStatus.number}}"],
      },
    ]);
  });

  it("references only vocabulary the race-status family registers, and no pool, frame, fragment or alias", () => {
    const refs = collectScriptReferences(RACE_STATUS_SCRIPT);
    const vocabulary = getScenarioEngine().vocabulary();

    expect(refs.vars).toEqual(["raceStatus.intro", "raceStatus.number", "raceStatus.stillLeading"]);
    expect(refs.conds).toEqual(["raceStatus.isLeading"]);
    expect(refs.cases).toEqual([]);
    expect(refs.pools).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(RACE_STATUS_SCRIPT.pools ?? {})).toEqual([]);

    for (const v of refs.vars) expect(vocabulary.vars.map((x) => x.name)).toContain(v);

    for (const c of refs.conds) expect(vocabulary.conds.map((x) => x.name)).toContain(c);
  });

  it("publishes no direct clip source — every clip is a var's, and the bundled voice ships the groups the vars draw from", () => {
    expect(RACE_STATUS_CLIP_SOURCES).toEqual([]);

    for (const clip of [
      "race-status/still-leading-01.mp3",
      "race-status/still-leading-class-01.mp3",
      "position-intro-worse/currently-01.mp3",
      "position-number/1.mp3",
    ]) {
      expect(MANIFEST.clips, `no voice/${BUNDLED_VOICE}/${clip} in manifest.json`).toContain(
        `voice/${BUNDLED_VOICE}/${clip}`,
      );
    }
  });

  it("compiles for the test voice with nothing skipped — no unknown var, condition or fragment", () => {
    const raceStatusWarnings = mockLogger.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("race-status"));

    expect(raceStatusWarnings).toEqual([]);
  });
});
