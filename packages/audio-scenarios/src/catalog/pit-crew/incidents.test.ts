/**
 * Incident callout tests (issue #530; scripted since #1065).
 *
 * Six contracts fire off `incident.occurred`, one per incident type, all in
 * `family: "incident"`. What each says is the bundled script's: the type
 * line, and for the four contact / collision types the points clause the
 * `incident.points` var resolves from the stash the firing contract's own
 * `where:` wrote (the #922 shape). The fire-through cases run the real
 * `callouts.json` narrowed to this family through the real engine; the live
 * opt-in gating and the registration order against the qualifying
 * invalidation line are `register-pit-crew.test.ts`'s.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, IncidentType, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { poolRef } from "../../dsl.js";
import type { ScenarioContract } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import {
  _resetLastIncidentPoints,
  INCIDENT_CLIP_SOURCES,
  INCIDENT_CONTRACTS,
  INCIDENT_SCENARIO_IDS,
  registerIncidentVocabulary,
} from "./incidents.js";

const TYPES: readonly IncidentType[] = [
  "off-track",
  "out-of-control",
  "contact-world",
  "collision-world",
  "contact-car",
  "collision-car",
];

/** The four types whose script entry carries the optional points clause. */
const COUNTED: readonly IncidentType[] = ["contact-world", "collision-world", "contact-car", "collision-car"];

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

function flush(audio: FakeAudio, iterations = 20): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

const VOICE = "luca";

/** One variant per type line, and count clips for 1–4 points only. */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...INCIDENT_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    ...[1, 2, 3, 4].map((n) => `voice/${VOICE}/incidents/points-${n}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const SCRIPT = defaultScript as CalloutScript;

/** The bundled script narrowed to this family's entries (F7-trap i). */
const INCIDENT_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(INCIDENT_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;

function contract(id: string): ScenarioContract {
  const c = INCIDENT_CONTRACTS.find((x) => x.id === id);

  if (!c) throw new Error(`contract not found: ${id}`);

  return c;
}

function incident(type: IncidentType, points: number): SimEventOf<"incident.occurred"> {
  return { event: "incident.occurred", timestamp: 0, telemetry: null, data: { type, delta: points, points } as never };
}

function fire(type: IncidentType, points: number): void {
  bus.publishEvent("incident.occurred", incident(type, points).data);
  flush(audio);
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

beforeEach(() => {
  _resetLastIncidentPoints();
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  // The production order (`registerPitCrew`): vocabulary, contracts, script.
  // The family is registered ALONE, so only its own compile diagnostics appear.
  registerIncidentVocabulary(engine);

  for (const c of INCIDENT_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, INCIDENT_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

describe("INCIDENT_CONTRACTS", () => {
  it("exports one contract per incident type, in registration order", () => {
    expect(INCIDENT_SCENARIO_IDS).toEqual(TYPES.map((type) => `pit-crew.incident-${type}`));
  });

  it("carries no sequence — what each line says is the voice script's", () => {
    for (const c of INCIDENT_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("keeps every scheduling field verbatim: one family, default weight, the engine's default frame", () => {
    for (const c of INCIDENT_CONTRACTS) {
      expect(c.when?.event).toBe("incident.occurred");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.family).toBe("incident");
      expect(c.weight).toBeUndefined();
      expect(c.interrupt).toBeUndefined();
      expect(c.queueable).toBeUndefined();
      expect(c.frame).toBeUndefined();
    }
  });

  it("each contract fires only for its own type", () => {
    for (const type of TYPES) {
      for (const other of TYPES) {
        expect(contract(`pit-crew.incident-${type}`).when?.where?.(incident(other, 1)), `${type} vs ${other}`).toBe(
          type === other,
        );
      }
    }
  });
});

describe("the incident lines through the real script", () => {
  it.each(["off-track", "out-of-control"] as const)(
    "%s plays its type line alone — no count, whatever the payload says",
    (type) => {
      fire(type, 2);

      expect(voicePaths()).toEqual([`voice/${VOICE}/incidents/${type}-01.mp3`]);
    },
  );

  it.each(COUNTED)("%s plays its type line and then the points clause the sim scored", (type) => {
    fire(type, 2);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/incidents/${type}-01.mp3`,
      `voice/${VOICE}/incidents/points-2.mp3`,
    ]);
  });

  it("speaks the payload's points, never a per-type constant — a dirt car collision is two, pavement four (issue #922)", () => {
    fire("collision-car", 4);
    expect(voicePaths()).toContain(`voice/${VOICE}/incidents/points-4.mp3`);

    audio._played.length = 0;
    fire("collision-car", 2);
    expect(voicePaths()).toContain(`voice/${VOICE}/incidents/points-2.mp3`);
    expect(voicePaths()).not.toContain(`voice/${VOICE}/incidents/points-4.mp3`);
  });

  it("drops the points clause and keeps the type line when the incident cost nothing", () => {
    fire("contact-car", 0);

    expect(voicePaths()).toEqual([`voice/${VOICE}/incidents/contact-car-01.mp3`]);
  });

  it("drops the points clause and keeps the type line when the voice has no clip for the count (issue #835)", () => {
    fire("collision-car", 9);

    expect(voicePaths()).toEqual([`voice/${VOICE}/incidents/collision-car-01.mp3`]);
  });

  it("plays inside the radio frame", () => {
    fire("off-track", 1);

    const all = audio._played.map((p) => p.path);

    expect(all[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(all.at(-1)).toBe("sfx/IRD-tick-close.mp3");
  });
});

describe("registerIncidentVocabulary + the points stash", () => {
  it("resolves incident.points to the value pool of the last ADMITTED fire, null before any", () => {
    const vars = new Map<string, () => unknown>();
    const stub = {
      defineVar: vi.fn((name: string, fn: () => unknown) => vars.set(name, fn)),
    } as unknown as IScenarioEngine;

    registerIncidentVocabulary(stub);

    const resolve = vars.get("incident.points");

    expect(resolve).toBeDefined();
    expect(resolve!()).toBeNull();

    contract("pit-crew.incident-collision-car").when?.where?.(incident("collision-car", 4));
    expect(resolve!()).toEqual(poolRef("incidents", "points-4"));

    // Zero or a non-integer is "no usable count" — the clause skips.
    contract("pit-crew.incident-contact-car").when?.where?.(incident("contact-car", 0));
    expect(resolve!()).toBeNull();
  });

  it("a non-matching event never touches the stash — a queued fire keeps its own count (#922 review)", () => {
    const vars = new Map<string, () => unknown>();
    const stub = {
      defineVar: vi.fn((name: string, fn: () => unknown) => vars.set(name, fn)),
    } as unknown as IScenarioEngine;

    registerIncidentVocabulary(stub);
    contract("pit-crew.incident-collision-car").when?.where?.(incident("collision-car", 4));
    // The off-track contract rejects a collision-car event before the stash write.
    contract("pit-crew.incident-off-track").when?.where?.(incident("collision-car", 1));

    expect(vars.get("incident.points")!()).toEqual(poolRef("incidents", "points-4"));
  });

  it("publishes the points var with a description naming the incidents group, and nothing else", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const points = vars.find((v) => v.name === "incident.points");

    expect(points).toBeDefined();
    expect(points?.description).toContain("incidents");
    expect(vars.filter((v) => v.name.startsWith("incident."))).toHaveLength(1);
    expect(conds.filter((c) => c.name.startsWith("incident."))).toEqual([]);
    expect(cases.filter((c) => c.name.startsWith("incident."))).toEqual([]);
  });
});

describe("the bundled script's incident entries (issue #1065)", () => {
  it("scripts every contract with a comment, an Incidents harness route and a sequence", () => {
    for (const id of INCIDENT_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Incidents → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("the four counted types carry the points clause as an OPTIONAL whole clause after the type line; the other two carry no count", () => {
    for (const type of COUNTED) {
      expect(SCRIPT.scenarios[`pit-crew.incident-${type}`].sequence, type).toEqual([
        `pool:incidents/${type}`,
        { optional: ["{{incident.points}}"] },
      ]);
    }

    for (const type of ["off-track", "out-of-control"]) {
      expect(SCRIPT.scenarios[`pit-crew.incident-${type}`].sequence, type).toEqual([`pool:incidents/${type}`]);
    }
  });

  it("references only the var this family registers, no condition, case, fragment or frame", () => {
    const refs = collectScriptReferences(INCIDENT_SCRIPT);

    expect(refs.vars).toEqual(["incident.points"]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(engine.vocabulary().vars.map((v) => v.name)).toContain("incident.points");
  });

  it("addresses exactly the published clip sources — the slashed form throughout — and every one has a clip in the bundled voice", () => {
    const sources = [
      "incidents/collision-car",
      "incidents/collision-world",
      "incidents/contact-car",
      "incidents/contact-world",
      "incidents/off-track",
      "incidents/out-of-control",
    ];

    expect([...collectScriptReferences(INCIDENT_SCRIPT).pools].sort()).toEqual(sources);
    expect(INCIDENT_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of INCIDENT_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });

  it("the bundled voice ships count clips the points var can draw from", () => {
    for (const n of [1, 2, 3, 4]) {
      const pattern = poolMemberPattern("incidents", `points-${n}`);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `points-${n}`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
