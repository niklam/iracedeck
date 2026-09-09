/**
 * Pit-service status tests (issue #479) and their positioning-error repeat
 * nags (issue #951); scripted since #1065.
 *
 * Pins:
 *   - structure: 8 contracts, shared family / priority / base, no sequence
 *   - each contract fires its matching clip — through the bundled voice's
 *     real `callouts.json` — when the bus publishes `pitService.statusChanged`
 *     with the expected `to` value
 *   - the `where:` predicate filters on `data.to` correctly (a non-matching
 *     `to` does not fire)
 *   - same-family preemption: a positioning correction (TooFarLeft →
 *     TooFarRight) supersedes the in-flight callout
 *   - per-callout opt-out via `registerPitCrew(... getPitStatusCalloutEnabled)`:
 *     disabling one id suppresses only that callout
 *   - repeat nags (#951): 5 contracts in their own `pit-status-repeat` family
 *     at a weight strictly below the transition calls, terse (no radio frame),
 *     fired by `pitService.positioningRepeat` and filtered on `data.status`
 *   - the scheduling consequences of that split — a nag is dropped rather than
 *     cutting the full transition call, a fresh error still speaks in full
 *     after an in-flight nag, and nags replace each other
 *   - the repeats ride their transition sibling's opt-in (no new setting)
 *   - the speak-time gate is the CONTRACT's `speakGate` (#1138), reading the
 *     same live telemetry when the nag comes to speak — so it holds for a
 *     voice pack that writes no `if`, which the bundled script no longer does
 *   - the bundled script's entries, vocabulary and clip sources (#1065)
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { PitSvStatus } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_FRAME, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { type PitStatusCalloutId, registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import {
  PIT_STATUS_CLIP_SOURCES,
  PIT_STATUS_CONTRACTS,
  PIT_STATUS_REPEAT_CONTRACTS,
  PIT_STATUS_REPEAT_SCENARIO_IDS,
  PIT_STATUS_REPEAT_WEIGHT,
  PIT_STATUS_SCENARIO_IDS,
  POSITIONING_SUBJECTS,
  registerPitStatusVocabulary,
} from "./pit-status.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

// `latestTelemetry` backs the repeat nags' speak-time gate. `null` (the
// default, and what the scenario harness sees) means "unknown" — the gate must
// then let the line play rather than suppress on missing data.
const simMocks = vi.hoisted(() => ({ latestTelemetry: null as { PlayerCarPitSvStatus?: number } | null }));

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => "Race",
  getLatestTelemetry: () => simMocks.latestTelemetry,
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
        telemetry: null as unknown,
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

/**
 * The test-only line the #1138 block holds the Voice bus with, as the step a
 * legacy scenario names (resolved against `base: "voice/{voice}"`) and as the
 * played path the assertions read.
 */
const OCCUPIER_CLIP_STEP = "blocker/line-01.mp3";
const OCCUPIER_CLIP = `voice/${VOICE}/${OCCUPIER_CLIP_STEP}`;

/**
 * One clip per source for the test voice, so pool draws stay deterministic
 * and a played path names its pool; the shipped voice config carries several
 * per nag.
 */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...PIT_STATUS_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    // The test-only line the #1138 block holds the bus with; it belongs to no
    // pool the family publishes, so it can never be mistaken for a nag.
    OCCUPIER_CLIP,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script, verbatim. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

const ALL_IDS = [...PIT_STATUS_SCENARIO_IDS, ...PIT_STATUS_REPEAT_SCENARIO_IDS];

/**
 * The bundled script narrowed to the family's own thirteen entries (and to no
 * fragments — none of them includes one). The engine-level blocks register
 * the pit-status family ALONE, and an entry for a contract the engine does not
 * hold would be a `no contract` warn.
 */
const PIT_STATUS_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(ALL_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
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

function voiceClipsPlayed(audio: FakeAudio): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function sfxClipsPlayed(audio: FakeAudio): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.SFX).map((p) => p.path);
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;

/** The production order (`registerPitCrew`) for this family alone: vocabulary, contracts, then the script. */
function registerFamilyAlone(): void {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitStatusVocabulary(engine);

  for (const c of [...PIT_STATUS_CONTRACTS, ...PIT_STATUS_REPEAT_CONTRACTS]) engine.defineContract(c);

  engine.setScripts(new Map([[VOICE, PIT_STATUS_SCRIPT]]));
}

describe("PIT_STATUS_CONTRACTS structure", () => {
  it("defines exactly 8 contracts — one per non-`None` PitSvStatus value", () => {
    expect(PIT_STATUS_CONTRACTS).toHaveLength(8);
  });

  it("ids are unique and stable", () => {
    expect(PIT_STATUS_SCENARIO_IDS).toEqual([
      "pit-crew.pit-status-in-progress",
      "pit-crew.pit-status-complete",
      "pit-crew.pit-status-too-far-left",
      "pit-crew.pit-status-too-far-right",
      "pit-crew.pit-status-too-far-forward",
      "pit-crew.pit-status-too-far-back",
      "pit-crew.pit-status-bad-angle",
      "pit-crew.pit-status-cant-fix-that",
    ]);
    expect(new Set(PIT_STATUS_SCENARIO_IDS).size).toBe(PIT_STATUS_SCENARIO_IDS.length);
  });

  it("every contract shares family 'pit-status' and uses the default weight", () => {
    for (const c of PIT_STATUS_CONTRACTS) {
      expect(c.family).toBe("pit-status");
      // default weight band (WEIGHT.NORMAL) — left unset
      expect(c.weight).toBeUndefined();
      expect(c.interrupt).not.toBe(true);
    }
  });

  it("every contract uses the per-voice base path and the voice channel", () => {
    for (const c of PIT_STATUS_CONTRACTS) {
      expect(c.base).toBe("voice/{voice}");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.when?.event).toBe("pitService.statusChanged");
    }
  });

  it("carries no sequence and takes the engine's default frame — the line is the voice script's (issue #1065)", () => {
    for (const c of PIT_STATUS_CONTRACTS) {
      expect("sequence" in c).toBe(false);
      expect(c.frame).toBeUndefined();
    }
  });
});

describe("PIT_STATUS_CONTRACTS triggers (engine-level, no opt-out gating)", () => {
  beforeEach(registerFamilyAlone);

  afterEach(() => {
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  it.each([
    { to: PitSvStatus.InProgress, expected: `voice/${VOICE}/pit-status/in-progress-01.mp3` },
    { to: PitSvStatus.Complete, expected: `voice/${VOICE}/pit-status/complete-01.mp3` },
    { to: PitSvStatus.TooFarLeft, expected: `voice/${VOICE}/pit-status/too-far-left-01.mp3` },
    { to: PitSvStatus.TooFarRight, expected: `voice/${VOICE}/pit-status/too-far-right-01.mp3` },
    { to: PitSvStatus.TooFarForward, expected: `voice/${VOICE}/pit-status/too-far-forward-01.mp3` },
    { to: PitSvStatus.TooFarBack, expected: `voice/${VOICE}/pit-status/too-far-back-01.mp3` },
    { to: PitSvStatus.BadAngle, expected: `voice/${VOICE}/pit-status/bad-angle-01.mp3` },
    { to: PitSvStatus.CantFixThat, expected: `voice/${VOICE}/pit-status/cant-fix-that-01.mp3` },
  ])("to=$to fires the matching clip", ({ to, expected }) => {
    bus.publishEvent("pitService.statusChanged", { from: PitSvStatus.None, to });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([expected]);
  });

  it("a transition call is wrapped in the voice's radio frame by the engine — open tick first, close tick last (issue #1064)", () => {
    bus.publishEvent("pitService.statusChanged", { from: PitSvStatus.None, to: PitSvStatus.TooFarLeft });
    flush(audio);

    const played = audio._played.map((p) => p.path);

    expect(played[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(played.at(-1)).toBe("sfx/IRD-tick-close.mp3");
    expect(sfxClipsPlayed(audio)).toEqual(["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3"]);
  });

  it("a non-matching `to` value does not fire the InProgress contract", () => {
    // Filter by `data.to` — a Complete event must not pick the InProgress clip.
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.InProgress,
      to: PitSvStatus.Complete,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).not.toContain(`voice/${VOICE}/pit-status/in-progress-01.mp3`);
  });

  it("rapid positioning correction (TooFarLeft → TooFarRight) ends with the latter clip (same-family preempt)", () => {
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.None,
      to: PitSvStatus.TooFarLeft,
    });
    // Don't flush — TooFarLeft is still mid-playback. The follow-up event
    // should preempt via the shared `family: "pit-status"`.
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.TooFarLeft,
      to: PitSvStatus.TooFarRight,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio).at(-1)).toBe(`voice/${VOICE}/pit-status/too-far-right-01.mp3`);
  });

  it("a voice with no script is silent — the contract alone says nothing", () => {
    engine.setScripts(new Map());

    bus.publishEvent("pitService.statusChanged", { from: PitSvStatus.None, to: PitSvStatus.InProgress });
    flush(audio);

    expect(audio._played).toEqual([]);
  });
});

describe("PIT_STATUS_REPEAT_CONTRACTS structure (#951)", () => {
  it("defines exactly 5 contracts — one per positioning error", () => {
    expect(PIT_STATUS_REPEAT_CONTRACTS).toHaveLength(5);
  });

  it("ids are unique, stable, and suffixed so they grep next to their transition sibling", () => {
    expect(PIT_STATUS_REPEAT_SCENARIO_IDS).toEqual([
      "pit-crew.pit-status-too-far-left-repeat",
      "pit-crew.pit-status-too-far-right-repeat",
      "pit-crew.pit-status-too-far-forward-repeat",
      "pit-crew.pit-status-too-far-back-repeat",
      "pit-crew.pit-status-bad-angle-repeat",
    ]);
    expect(new Set(PIT_STATUS_REPEAT_SCENARIO_IDS).size).toBe(PIT_STATUS_REPEAT_SCENARIO_IDS.length);
  });

  it("uses its own family so a nag never same-family-preempts the full transition call", () => {
    for (const c of PIT_STATUS_REPEAT_CONTRACTS) {
      expect(c.family).toBe("pit-status-repeat");
      expect(c.family).not.toBe("pit-status");
    }
  });

  it("sits strictly below the transition calls so a fresh error always wins the bus", () => {
    for (const c of PIT_STATUS_REPEAT_CONTRACTS) {
      expect(c.weight).toBe(PIT_STATUS_REPEAT_WEIGHT);
    }

    // The transition calls take the default band, which must outrank the nag.
    expect(PIT_STATUS_REPEAT_WEIGHT).toBeLessThan(WEIGHT.NORMAL);
  });

  it("never cuts an in-flight line and never replays late", () => {
    for (const c of PIT_STATUS_REPEAT_CONTRACTS) {
      expect(c.interrupt).not.toBe(true);
      expect(c.queueable).not.toBe(true);
    }
  });

  it("opts out of the radio frame on the contract, and carries no sequence — the gated body is the voice script's", () => {
    for (const c of PIT_STATUS_REPEAT_CONTRACTS) {
      // The frame is the engine's since issue #1064, so the opt-out is the
      // contract field, not the absence of an include in a sequence.
      expect(c.frame).toBe(NO_FRAME);
      expect("sequence" in c).toBe(false);
      expect(c.when?.event).toBe("pitService.positioningRepeat");
    }
  });
});

describe("PIT_STATUS_REPEAT_CONTRACTS triggers (engine-level, no opt-out gating)", () => {
  beforeEach(registerFamilyAlone);

  afterEach(() => {
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  it.each([
    { status: PitSvStatus.TooFarLeft, expected: `voice/${VOICE}/pit-status/too-far-left-repeat-01.mp3` },
    { status: PitSvStatus.TooFarRight, expected: `voice/${VOICE}/pit-status/too-far-right-repeat-01.mp3` },
    { status: PitSvStatus.TooFarForward, expected: `voice/${VOICE}/pit-status/too-far-forward-repeat-01.mp3` },
    { status: PitSvStatus.TooFarBack, expected: `voice/${VOICE}/pit-status/too-far-back-repeat-01.mp3` },
    { status: PitSvStatus.BadAngle, expected: `voice/${VOICE}/pit-status/bad-angle-repeat-01.mp3` },
  ])("status=$status fires the matching nag clip on its own", ({ status, expected }) => {
    bus.publishEvent("pitService.positioningRepeat", { status });
    flush(audio);

    // Terse delivery: the nag clip only. The voice's script DOES define the
    // radio frame (the transition calls above get it), so an empty SFX list
    // is `frame: NO_FRAME` doing its job through the engine (issue #1064).
    expect(voiceClipsPlayed(audio)).toEqual([expected]);
    expect(sfxClipsPlayed(audio)).toEqual([]);
    expect(audio._played.map((p) => p.path)).toEqual([expected]);
  });

  it("a non-matching status does not fire another error's nag", () => {
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.BadAngle });
    flush(audio);

    // Exact match, not `not.toContain` — the loose form also passes when the
    // matching nag never fired at all, or when a THIRD error's nag fired.
    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/bad-angle-repeat-01.mp3`]);
  });

  it("is dropped rather than cutting the full transition call it belongs to", () => {
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.None,
      to: PitSvStatus.TooFarForward,
    });
    // Don't flush — the full call is mid-playback. The nag must NOT chop it.
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarForward });
    flush(audio);

    const played = voiceClipsPlayed(audio);

    expect(played).toContain(`voice/${VOICE}/pit-status/too-far-forward-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/pit-status/too-far-forward-repeat-01.mp3`);
  });

  it("lets a fresh positioning error speak in full right after an in-flight nag", () => {
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarForward });
    // Don't flush — the driver over-corrects while the nag is still playing.
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.TooFarForward,
      to: PitSvStatus.TooFarBack,
    });
    flush(audio);

    const played = voiceClipsPlayed(audio);

    expect(played).toContain(`voice/${VOICE}/pit-status/too-far-forward-repeat-01.mp3`);
    expect(played.at(-1)).toBe(`voice/${VOICE}/pit-status/too-far-back-01.mp3`);
  });

  it("replaces its own in-flight predecessor rather than stacking nags", () => {
    // No flush between the two — the second nag arrives mid-playback of the
    // first, so same-family preemption must CUT it. The cut is the assertable
    // signal: both fires start a clip either way, so a clip-list assertion
    // alone can't tell a replacement from two nags queued back to back.
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarLeft });
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarLeft });

    expect(audio.stopChannel).toHaveBeenCalledWith(AudioChannel.Voice);

    flush(audio);

    expect(voiceClipsPlayed(audio).at(-1)).toBe(`voice/${VOICE}/pit-status/too-far-left-repeat-01.mp3`);
  });
});

describe("PIT_STATUS_REPEAT_CONTRACTS speak-time validity gate (#951)", () => {
  // `queueable: false` does NOT drop a nag behind a LOWER-weight line: the
  // engine sets it as the pending fire whenever `weight > runningWeight` and
  // `interrupt !== true`, and a pending fire replays WITHOUT re-running
  // `where:`. So a nag queued behind the (CHATTER-weight, long) pit-service
  // readback could speak after the driver had already corrected. Each nag's
  // contract carries a `speakGate` (issue #1138 — a script `if` until then)
  // that the engine asks after the script expands and before the bus take,
  // deferred replays included, which re-checks the live status.
  beforeEach(registerFamilyAlone);

  afterEach(() => {
    simMocks.latestTelemetry = null;
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  it("stays silent when the driver has already corrected by the time it speaks", () => {
    simMocks.latestTelemetry = { PlayerCarPitSvStatus: PitSvStatus.None };

    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarForward });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);
    // An empty body gets no frame either — silence, not a bare beep.
    expect(audio._played).toEqual([]);
  });

  it("stays silent when the live error is no longer the one it names", () => {
    simMocks.latestTelemetry = { PlayerCarPitSvStatus: PitSvStatus.TooFarBack };

    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarForward });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);
  });

  it("speaks when the live status still reports the same error", () => {
    simMocks.latestTelemetry = { PlayerCarPitSvStatus: PitSvStatus.TooFarForward };

    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarForward });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/too-far-forward-repeat-01.mp3`]);
  });

  it("speaks when telemetry is unavailable — never suppress on missing data", () => {
    simMocks.latestTelemetry = null;

    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.BadAngle });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/bad-angle-repeat-01.mp3`]);
  });

  it("speaks when telemetry omits the status field — keeps the scenario harness firable", () => {
    simMocks.latestTelemetry = {};

    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarLeft });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/too-far-left-repeat-01.mp3`]);
  });
});

// The gate is the CONTRACT's since #1138, so it must hold for a voice pack
// that writes no `if` at all — which is every pack that ever gets the wording
// right and the pacing wrong. The tests above install the bundled script and
// so cannot tell a contract gate from a script one; these install a bare-clip
// entry (`["pool:pit-status/too-far-left-repeat"]`) and drive the case the
// gate exists for: the nag waits behind a LOWER-weight line, the driver
// corrects while it waits, and the drain must expand to silence.
//
// DO NOT DELETE THE SILENCE TEST. Take the `speakGate` off the contract and
// nothing else in this file goes red: with the bundled script the `if` is
// gone too, so the nag simply speaks, and every "it fires" test still passes.
// The positive twin is here so the silence cannot instead be the bare-clip
// script, the occupier, or the queue being broken outright.
describe("the gate is the contract's, not the script's (issue #1138)", () => {
  beforeEach(registerFamilyAlone);

  afterEach(() => {
    simMocks.latestTelemetry = null;
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  const NAG_ID = "pit-crew.pit-status-too-far-left-repeat";
  const NAG_CLIP = `voice/${VOICE}/pit-status/too-far-left-repeat-01.mp3`;

  /** The nag's entry, stripped to the clip alone — a pack that wrote no gate. */
  function installBareClipNag(): void {
    engine.setScripts(
      new Map([
        [
          VOICE,
          {
            ...PIT_STATUS_SCRIPT,
            scenarios: {
              ...PIT_STATUS_SCRIPT.scenarios,
              [NAG_ID]: { sequence: ["pool:pit-status/too-far-left-repeat"] },
            },
          },
        ],
      ]),
    );
  }

  /**
   * Hold the bus with a line the nag OUTRANKS but may not cut: `queueable:
   * false` does not drop a nag behind a lower-weight line — the engine parks
   * it as the bus's pending fire (`weight > runningWeight && interrupt !==
   * true`) — which is the pit-service readback's shape and the only way a nag
   * reaches the drain at all.
   */
  function occupyVoiceBus(): void {
    engine.defineScenario({
      id: "test.bus-occupier",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      weight: WEIGHT.CHATTER,
      sequence: [OCCUPIER_CLIP_STEP],
    });
    engine.fire("test.bus-occupier");
  }

  /** Publish the nag while the bus is busy, move the world on, then let it drain. */
  function queueThenDrain(live: number | undefined): void {
    occupyVoiceBus();

    simMocks.latestTelemetry = { PlayerCarPitSvStatus: PitSvStatus.TooFarLeft };
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarLeft });

    // Proof it took the PENDING path rather than playing straight away —
    // without it this block could quietly degrade into the one above, where
    // the gate is asked at fire time and the silence proves much less.
    expect(mockLogger.debug).toHaveBeenCalledWith(
      `Scenario "${NAG_ID}" pending — waiting for bus (higher weight, no interrupt)`,
    );

    simMocks.latestTelemetry = { PlayerCarPitSvStatus: live };
    flush(audio);
  }

  it("stays silent when the driver corrects while the nag waits — with a script that has no `if` at all", () => {
    installBareClipNag();
    queueThenDrain(PitSvStatus.None);

    expect(mockLogger.debug).toHaveBeenCalledWith(`Replaying pending scenario "${NAG_ID}"`);
    // The line that held the bus is unaffected; only the stale nag is dropped.
    expect(voiceClipsPlayed(audio)).toContain(OCCUPIER_CLIP);
    expect(voiceClipsPlayed(audio)).not.toContain(NAG_CLIP);
  });

  it("speaks, late, with that same script when the car is still too far left at the drain", () => {
    installBareClipNag();
    queueThenDrain(PitSvStatus.TooFarLeft);

    expect(mockLogger.debug).toHaveBeenCalledWith(`Replaying pending scenario "${NAG_ID}"`);
    expect(voiceClipsPlayed(audio)).toContain(OCCUPIER_CLIP);
    expect(voiceClipsPlayed(audio)).toContain(NAG_CLIP);
  });
});

describe("registerPitStatusVocabulary (issue #1065)", () => {
  beforeEach(registerFamilyAlone);

  afterEach(() => {
    simMocks.latestTelemetry = null;
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  it("publishes one still-misaligned condition per positioning error, each with a description for a pack author, and nothing else", () => {
    const { vars, conds, cases } = engine.vocabulary();

    expect(vars).toEqual([]);
    expect(cases).toEqual([]);
    expect(conds.map((c) => c.name)).toEqual([
      "pitStatus.stillBadAngle",
      "pitStatus.stillTooFarBack",
      "pitStatus.stillTooFarForward",
      "pitStatus.stillTooFarLeft",
      "pitStatus.stillTooFarRight",
    ]);
    expect(conds.map((c) => c.name).sort()).toEqual(POSITIONING_SUBJECTS.map((s) => s.cond).sort());

    for (const c of conds) expect(c.description.length, c.name).toBeGreaterThan(0);
  });

  it("each condition answers for its own error only, reading live telemetry", () => {
    // Drive the gate through the engine: the nag for X plays only while the
    // live status is X (or unknown), which is what each condition means.
    for (const { target, still } of POSITIONING_SUBJECTS) {
      for (const live of POSITIONING_SUBJECTS) {
        audio._played.length = 0;
        simMocks.latestTelemetry = { PlayerCarPitSvStatus: live.target };

        bus.publishEvent("pitService.positioningRepeat", { status: target });
        flush(audio);

        expect(voiceClipsPlayed(audio).length, `${still} while ${live.still}`).toBe(live.target === target ? 1 : 0);
      }
    }
  });
});

describe("the bundled script's pit-status entries (issue #1065)", () => {
  beforeEach(registerFamilyAlone);

  afterEach(() => {
    _resetAudioScenarios();
    vi.clearAllMocks();
  });

  it("scripts every transition call as a single pool step, with a comment and a Pit Status harness route", () => {
    for (const id of PIT_STATUS_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];
      const base = id.replace("pit-crew.pit-status-", "");

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Pit Status → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.frame).toBeUndefined();
      expect(entry.sequence).toEqual([`pool:pit-status/${base}`]);
    }
  });

  it("scripts every repeat nag as the clip alone — the re-check is the contract's gate (issue #1138)", () => {
    // Both halves together: the entry says only what is SAID, and the
    // still-misaligned re-check is on the contract. Asserting the bare
    // sequence alone would also pass for a nag whose gate had been dropped
    // entirely, which is the regression that would let it nag a corrected car.
    for (const { id } of POSITIONING_SUBJECTS) {
      const scenarioId = `pit-crew.pit-status-${id}-repeat`;
      const entry = SCRIPT.scenarios[scenarioId];

      expect(entry, `no script entry for ${scenarioId}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${scenarioId}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${scenarioId}: test`).toMatch(/^Harness → Pit Status → Still /);
      expect(entry.skip).toBeUndefined();
      // The opt-out is the contract's; an entry naming a frame would put the ticks back.
      expect(entry.frame).toBeUndefined();
      expect(entry.sequence).toEqual([`pool:pit-status/${id}-repeat`]);
    }

    for (const c of PIT_STATUS_REPEAT_CONTRACTS) {
      expect(c.speakGate?.description, c.id).toBeTruthy();
    }

    // …and only the nags: a transition line decides everything at `where:`.
    for (const c of PIT_STATUS_CONTRACTS) expect(c.speakGate, c.id).toBeUndefined();
  });

  it("references no condition at all — the five the family registers are published, not used (issue #1138)", () => {
    const refs = collectScriptReferences(PIT_STATUS_SCRIPT);
    const vocabulary = engine.vocabulary();

    expect(refs.vars).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.conds).toEqual([]);

    // Still published, so a pack CAN write the belt-and-braces `if`.
    expect(vocabulary.conds.map((c) => c.name).sort()).toEqual(POSITIONING_SUBJECTS.map((s) => s.cond).sort());
  });

  it("addresses exactly the published clip sources — the slashed form, no named pool — and every one has a clip in the bundled voice", () => {
    const sources = [
      "pit-status/bad-angle",
      "pit-status/bad-angle-repeat",
      "pit-status/cant-fix-that",
      "pit-status/complete",
      "pit-status/in-progress",
      "pit-status/too-far-back",
      "pit-status/too-far-back-repeat",
      "pit-status/too-far-forward",
      "pit-status/too-far-forward-repeat",
      "pit-status/too-far-left",
      "pit-status/too-far-left-repeat",
      "pit-status/too-far-right",
      "pit-status/too-far-right-repeat",
    ];

    expect([...collectScriptReferences(PIT_STATUS_SCRIPT).pools].sort()).toEqual(sources);
    expect(PIT_STATUS_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);
    expect(Object.keys(SCRIPT.pools ?? {})).toEqual([]);

    for (const { group, base } of PIT_STATUS_CLIP_SOURCES) {
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

describe("PIT_STATUS_CONTRACTS per-callout opt-out (via registerPitCrew)", () => {
  let enabled: Map<PitStatusCalloutId, boolean>;

  beforeEach(() => {
    enabled = new Map<PitStatusCalloutId, boolean>([
      ["in-progress", true],
      ["complete", true],
      ["too-far-left", true],
      ["too-far-right", true],
      ["too-far-forward", true],
      ["too-far-back", true],
      ["bad-angle", true],
      ["cant-fix-that", true],
    ]);
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    registerPitCrew(bus, {
      getFlagCalloutEnabled: () => true,
      logger: mockLogger as never,
      getPitReadbackEnabled: () => true,
      getPitActionsAllowed: () => true,
      getPitServiceRequestsEnabled: () => true,
      getReadbackSnapshot: () => null,
      getDamageCalloutEnabled: () => true,
      getPitStatusCalloutEnabled: (id) => enabled.get(id) ?? true,
    });
    // After the registration, as the plugins do: the whole bundled script,
    // since the real registration holds every family's contracts.
    engine.setScripts(new Map([[VOICE, SCRIPT]]));
  });

  afterEach(() => {
    _resetAudioScenarios();
    _resetRadarEngine();
    _resetSpotterEngine();
    _resetPitSpeedingEngine();
    vi.clearAllMocks();
  });

  it("disabling a single status suppresses only that callout", () => {
    enabled.set("too-far-left", false);
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.None,
      to: PitSvStatus.TooFarLeft,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);

    // Other ids still fire.
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.None,
      to: PitSvStatus.TooFarRight,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/too-far-right-01.mp3`]);
  });

  it("disabling all suppresses every callout", () => {
    for (const id of enabled.keys()) enabled.set(id, false);

    for (const to of [
      PitSvStatus.InProgress,
      PitSvStatus.Complete,
      PitSvStatus.TooFarLeft,
      PitSvStatus.TooFarRight,
      PitSvStatus.TooFarForward,
      PitSvStatus.TooFarBack,
      PitSvStatus.BadAngle,
      PitSvStatus.CantFixThat,
    ]) {
      bus.publishEvent("pitService.statusChanged", { from: PitSvStatus.None, to });
    }

    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);
  });

  it("disabling a status suppresses its repeat nag too — the repeats ride the same opt-in (#951)", () => {
    enabled.set("too-far-forward", false);
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarForward });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);

    enabled.set("too-far-forward", true);
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarForward });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/too-far-forward-repeat-01.mp3`]);
  });

  it("re-enabling restores firing on the next event", () => {
    enabled.set("complete", false);
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.InProgress,
      to: PitSvStatus.Complete,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([]);

    enabled.set("complete", true);
    bus.publishEvent("pitService.statusChanged", {
      from: PitSvStatus.InProgress,
      to: PitSvStatus.Complete,
    });
    flush(audio);

    expect(voiceClipsPlayed(audio)).toEqual([`voice/${VOICE}/pit-status/complete-01.mp3`]);
  });
});
