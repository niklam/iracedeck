/**
 * Track-conditions contract tests (issue #526; scripted since #1065).
 *
 * Mirrors `flag-alerts.test.ts`: a fake bus + fake audio service, the twelve
 * contracts registered on a fresh engine, and the bundled voice's REAL
 * `callouts.json` narrowed to this family's entries — so every fire here
 * runs the same compile + expansion path production does, and what the
 * engineer says is the script's. Covers:
 *   - every (direction, target) line fires its own clip and nothing else
 *   - the direction filter: a step towards wetter takes the worsening line,
 *     a step towards drier the drying line, and the physically impossible
 *     combinations (worsening to Dry, drying to ExtremelyWet) are silent
 *   - family preemption (a rapid double-step keeps only the newer line)
 *   - the engine's radio frame around each line
 *   - opt-in gating via the `registerPitCrew` closure (`wetness` off is
 *     silent for every line)
 *   - the bundled script's entries: complete, described, pinned to the
 *     published clip sources, and compiling clean for the test voice
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import {
  _resetAudioScenarios,
  getScenarioEngine,
  initializeAudioScenarios,
  poolMemberPattern,
} from "../../interpreter.js";
import { registerPitCrew, type TrackConditionsCalloutId } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";
import {
  TRACK_CONDITIONS_CLIP_SOURCES,
  TRACK_CONDITIONS_CONTRACTS,
  TRACK_CONDITIONS_SCENARIO_IDS,
} from "./track-conditions.js";

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
  getStandingStart: () => false,
  getLatestTelemetry: () => null,
  TrackDirection: { Neutral: "neutral", Left: "left", Right: "right" },
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

const VOICE = "luca";

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...TRACK_CONDITIONS_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to this family's own entries (and to no
 * fragments — none of these entries includes one): an entry for a contract
 * the engine under test does not hold is a `no contract` warn, and a foreign
 * fragment would widen `collectScriptReferences` under the assertions below.
 */
const TRACK_CONDITIONS_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(TRACK_CONDITIONS_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
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

beforeEach(() => {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

  // The production order (`registerPitCrew`): contracts, then the scripts.
  // No pools are registered in code for this family any more, and the script
  // names none either: its `pool:track-conditions/<base>` steps address the
  // clip group directly, resolved against the manifest at fire time.
  for (const c of TRACK_CONDITIONS_CONTRACTS) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, TRACK_CONDITIONS_SCRIPT]]));
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

function wetnessChanged(from: TrackWetness, to: TrackWetness): void {
  bus.publishEvent("track.wetness.changed", { from, to });
  flush(audio);
}

const WORSENING_LINES: ReadonlyArray<{ to: TrackWetness; slug: string }> = [
  { to: TrackWetness.MostlyDry, slug: "mostly-dry" },
  { to: TrackWetness.VeryLightlyWet, slug: "very-lightly-wet" },
  { to: TrackWetness.LightlyWet, slug: "lightly-wet" },
  { to: TrackWetness.ModeratelyWet, slug: "moderately-wet" },
  { to: TrackWetness.VeryWet, slug: "very-wet" },
  { to: TrackWetness.ExtremelyWet, slug: "extremely-wet" },
];

const DRYING_LINES: ReadonlyArray<{ to: TrackWetness; slug: string }> = [
  { to: TrackWetness.Dry, slug: "dry" },
  { to: TrackWetness.MostlyDry, slug: "mostly-dry" },
  { to: TrackWetness.VeryLightlyWet, slug: "very-lightly-wet" },
  { to: TrackWetness.LightlyWet, slug: "lightly-wet" },
  { to: TrackWetness.ModeratelyWet, slug: "moderately-wet" },
  { to: TrackWetness.VeryWet, slug: "very-wet" },
];

describe("TRACK_CONDITIONS_CONTRACTS structure", () => {
  it("defines 12 contracts — six worsening targets, six drying targets", () => {
    expect(TRACK_CONDITIONS_CONTRACTS).toHaveLength(12);
    expect(TRACK_CONDITIONS_SCENARIO_IDS).toEqual([
      "pit-crew.track-conditions-worsening-mostly-dry",
      "pit-crew.track-conditions-worsening-very-lightly-wet",
      "pit-crew.track-conditions-worsening-lightly-wet",
      "pit-crew.track-conditions-worsening-moderately-wet",
      "pit-crew.track-conditions-worsening-very-wet",
      "pit-crew.track-conditions-worsening-extremely-wet",
      "pit-crew.track-conditions-drying-dry",
      "pit-crew.track-conditions-drying-mostly-dry",
      "pit-crew.track-conditions-drying-very-lightly-wet",
      "pit-crew.track-conditions-drying-lightly-wet",
      "pit-crew.track-conditions-drying-moderately-wet",
      "pit-crew.track-conditions-drying-very-wet",
    ]);
    expect(new Set(TRACK_CONDITIONS_SCENARIO_IDS).size).toBe(12);
  });

  it("carries no sequence — what a line says is the voice script's, never the code's", () => {
    for (const c of TRACK_CONDITIONS_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("keeps every scheduling field of the former scenarios verbatim, and takes the engine's default frame", () => {
    for (const c of TRACK_CONDITIONS_CONTRACTS) {
      expect(c.when?.event).toBe("track.wetness.changed");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.family).toBe("track-conditions");
      expect(c.weight).toBeUndefined();
      expect(c.interrupt).toBeUndefined();
      expect(c.queueable).toBeUndefined();
      expect(c.cooldown).toBeUndefined();
      expect(c.triggerDelay).toBeUndefined();
      expect(c.frame).toBeUndefined();
    }
  });
});

describe("TRACK_CONDITIONS_CONTRACTS triggers", () => {
  it.each(WORSENING_LINES)("a step wetter to $slug plays only the worsening-$slug line", ({ to, slug }) => {
    wetnessChanged(to - 1, to);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/track-conditions/worsening-${slug}-01.mp3`]);
  });

  it.each(DRYING_LINES)("a step drier to $slug plays only the drying-$slug line", ({ to, slug }) => {
    wetnessChanged(to + 1, to);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/track-conditions/drying-${slug}-01.mp3`]);
  });

  it("a multi-step jump still keys on the target and the direction (Dry → VeryWet is worsening-very-wet)", () => {
    wetnessChanged(TrackWetness.Dry, TrackWetness.VeryWet);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/track-conditions/worsening-very-wet-01.mp3`]);
  });

  it("worsening to Dry and drying to ExtremelyWet are not lines — nothing plays", () => {
    // `to === from` is neither direction; the translator never emits it, but
    // the contract must not invent a line for it either.
    wetnessChanged(TrackWetness.Dry, TrackWetness.Dry);
    wetnessChanged(TrackWetness.ExtremelyWet, TrackWetness.ExtremelyWet);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("is wrapped in the active voice's radio frame by the engine — open tick first, close tick last (issue #1064)", () => {
    wetnessChanged(TrackWetness.LightlyWet, TrackWetness.ModeratelyWet);

    const played = audio._played.map((p) => p.path);

    expect(played[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(played.at(-1)).toBe("sfx/IRD-tick-close.mp3");
    expect(sfxClipsPlayed()).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });

  it("a voice with no script plays no track-conditions line at all — no line, no frame", () => {
    engine.setScripts(new Map([["titan", TRACK_CONDITIONS_SCRIPT]]));

    wetnessChanged(TrackWetness.LightlyWet, TrackWetness.ModeratelyWet);

    expect(audio._played).toEqual([]);
  });
});

describe("TRACK_CONDITIONS_CONTRACTS preemption", () => {
  it("a rapid double-step supersedes the in-flight line (family share) — only the newer target plays", () => {
    bus.publishEvent("track.wetness.changed", { from: TrackWetness.LightlyWet, to: TrackWetness.ModeratelyWet });
    // Don't flush — the moderately-wet line is still mid-playback.
    bus.publishEvent("track.wetness.changed", { from: TrackWetness.ModeratelyWet, to: TrackWetness.VeryWet });
    flush(audio);

    expect(voiceClipsPlayed().at(-1)).toBe(`voice/${VOICE}/track-conditions/worsening-very-wet-01.mp3`);
    expect(voiceClipsPlayed()).not.toContain(`voice/${VOICE}/track-conditions/worsening-moderately-wet-01.mp3`);
  });

  it("a CRITICAL line outranks a track-conditions line on a busy bus (default weight, no interrupt)", () => {
    engine.defineScenario({
      id: "test.critical",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CRITICAL,
      sequence: [`voice/${VOICE}/track-conditions/drying-dry-01.mp3`],
    });
    engine.fire("test.critical");

    // Not queueable: a fire that cannot take the bus is dropped, not replayed.
    bus.publishEvent("track.wetness.changed", { from: TrackWetness.LightlyWet, to: TrackWetness.ModeratelyWet });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/track-conditions/drying-dry-01.mp3`]);
  });
});

// Opt-in gating wired through `registerPitCrew`'s `getTrackConditionsCalloutEnabled`
// closure (issue #526): one `wetness` subject gates all twelve lines. The
// manifest here only carries the track-conditions clips, so unrelated
// families register with disabled scenarios (pool-validation errors are
// logged but harmless) — the track-conditions events under test still fire.
describe("TRACK_CONDITIONS_CONTRACTS opt-in gating (issue #526)", () => {
  let wetnessEnabled: Map<TrackConditionsCalloutId, boolean>;

  beforeEach(() => {
    _resetAudioScenarios();
    bus = createMockBus();
    audio = createFakeAudio();
    initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

    wetnessEnabled = new Map<TrackConditionsCalloutId, boolean>([["wetness", true]]);

    registerPitCrew(bus, {
      logger: mockLogger as never,
      getTrackConditionsCalloutEnabled: (id) => wetnessEnabled.get(id) ?? true,
    });
    getScenarioEngine().setScripts(new Map([[VOICE, TRACK_CONDITIONS_SCRIPT]]));
  });

  afterEach(() => {
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
  });

  it("fires a worsening and a drying line when the opt-in is on", () => {
    wetnessChanged(TrackWetness.Dry, TrackWetness.MostlyDry);
    wetnessChanged(TrackWetness.MostlyDry, TrackWetness.Dry);

    expect(voiceClipsPlayed()).toEqual([
      `voice/${VOICE}/track-conditions/worsening-mostly-dry-01.mp3`,
      `voice/${VOICE}/track-conditions/drying-dry-01.mp3`,
    ]);
  });

  it("wetness off suppresses every line in both directions", () => {
    wetnessEnabled.set("wetness", false);

    for (const { to } of WORSENING_LINES) wetnessChanged(to - 1, to);

    for (const { to } of DRYING_LINES) wetnessChanged(to + 1, to);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});

describe("the bundled script's track-conditions entries (issue #1065)", () => {
  it("scripts every contract, each with a comment, a Track Conditions harness route and a sequence", () => {
    for (const id of TRACK_CONDITIONS_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(
        /^Harness → Scenario Shortcuts → Track Conditions — (Worsening|Drying) → /,
      );
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("names no vocabulary, no frame, no fragment and no pool alias — every line is one direct pool step", () => {
    const refs = collectScriptReferences(TRACK_CONDITIONS_SCRIPT);

    expect(refs.vars).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(Object.keys(TRACK_CONDITIONS_SCRIPT.pools ?? {})).toEqual([]);

    for (const id of TRACK_CONDITIONS_SCENARIO_IDS) {
      expect(SCRIPT.scenarios[id].sequence).toEqual([
        `pool:${id.replace("pit-crew.", "").replace("track-conditions-", "track-conditions/")}`,
      ]);
    }
  });

  it("addresses exactly the published clip sources — the slashed form throughout — and every one has a clip in the bundled voice", () => {
    // The literal is the published surface: a `(group, base)` a script
    // addresses is a rename in every pack's script and clip folder.
    const sources = [
      "track-conditions/drying-dry",
      "track-conditions/drying-lightly-wet",
      "track-conditions/drying-moderately-wet",
      "track-conditions/drying-mostly-dry",
      "track-conditions/drying-very-lightly-wet",
      "track-conditions/drying-very-wet",
      "track-conditions/worsening-extremely-wet",
      "track-conditions/worsening-lightly-wet",
      "track-conditions/worsening-moderately-wet",
      "track-conditions/worsening-mostly-dry",
      "track-conditions/worsening-very-lightly-wet",
      "track-conditions/worsening-very-wet",
    ];

    expect([...collectScriptReferences(TRACK_CONDITIONS_SCRIPT).pools].sort()).toEqual(sources);
    expect(TRACK_CONDITIONS_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of TRACK_CONDITIONS_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });

  it("the fixture manifest carries every source for the test voice — the fires above are not vacuous", () => {
    for (const { group, base } of TRACK_CONDITIONS_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        manifest.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `${group}/${base}`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped — no unknown pool, condition, case key or fragment", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
