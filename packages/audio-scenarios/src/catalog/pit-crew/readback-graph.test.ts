/**
 * Path-graph invariant test for the pit-readback scenarios (issue #476).
 *
 * The voice-path design constraint applies to the **outer graph** where
 * each multi-clip slot (e.g. the 19 tire/compound options) is one node,
 * not 19 separate nodes. Quoting the issue: "a 19-tire-pattern slot is
 * one *slot* in the outer graph (not 19 outer-graph nodes), held together
 * by a unified prosodic envelope so the slot exposes a single acoustic
 * predecessor / successor identity to its neighbours." So we count
 * predecessor / successor SLOTS, not individual clips, and assert the
 * outer graph respects ≤3 in/out degree per slot.
 *
 * Approach: enumerate every reachable readback sequence by fanning out
 * the snapshot inputs (fuel × tire-pattern × compound × fastRepair ×
 * windshield × limiter), bucket each clip by its slot, then walk the
 * recorded slot sequences to compute distinct predecessor / successor
 * slot sets.
 *
 * Radio-frame clips (`/sfx/IRD-tick-*`) are excluded — the engine wraps
 * every scenario in them (issue #1064), so they aren't part of the outer
 * slot graph.
 *
 * Since #1065 the sequences under test are the bundled voice's script
 * (`voice/default/callouts.json`: the two readback entries and the
 * `readback-body` fragment they share), compiled against the readback
 * vocabulary the code registers. The invariant is a property of what the
 * engineer can be heard to say, so it is checked the same way wherever the
 * sequence lives — the enumeration fires through the real engine, and the
 * script is handed to it exactly as the plugins hand it over.
 */
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { CalloutScript } from "@iracedeck/callout-script";
import type { IEventBus, PitReadbackSnapshot, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { registerPitCrew } from "./index.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const mockSessionType = vi.fn(() => "Race");
vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
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

      return () => handlers.get(name)?.delete(handler as (e: SimEventOf<SimEventName>) => void);
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
  _reset: () => void;
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
    _reset: () => {
      played.length = 0;
      callbacks[AudioChannel.Ambient] = null;
      callbacks[AudioChannel.SFX] = null;
      callbacks[AudioChannel.Voice] = null;
      callbacks[AudioChannel.Radar] = null;
    },
  } as unknown as FakeAudio;
}

const VOICE = "luca";

const READBACK_CLIP_NAMES = [
  "opener-entry",
  "opener-entry-limiter",
  "opener-exit",
  "empty-fallback",
  "fuel-on",
  "fuel-off",
  "tires-all",
  "tires-fronts",
  "tires-rears",
  "tires-lefts",
  "tires-rights",
  "tires-lf",
  "tires-rf",
  "tires-lr",
  "tires-rr",
  "tires-lf-rr",
  "tires-rf-lr",
  "tires-skip-lf",
  "tires-skip-rf",
  "tires-skip-lr",
  "tires-skip-rr",
  "tires-off",
  "compound-dry",
  "compound-wet",
  "fast-repair-on",
  "fast-repair-off",
  "windshield-on",
  "windshield-off",
] as const;

const OTHER_CLIP_NAMES = [
  "voice/luca/acknowledgment/acknowledgment-01.mp3",
  "voice/luca/acknowledgment/acknowledgment-02.mp3",
  "voice/luca/acknowledgment/acknowledgment-03.mp3",
  "voice/luca/acknowledgment/acknowledgment-04.mp3",
  "voice/luca/acknowledgment/acknowledgment-05.mp3",
  "voice/luca/pit-actions/acknowledgment-01.mp3",
  "voice/luca/pit-actions/acknowledgment-02.mp3",
  "voice/luca/pit-actions/acknowledgment-03.mp3",
  "voice/luca/pit-actions/fuel-on-01.mp3",
  "voice/luca/pit-actions/fuel-off-01.mp3",
  "voice/luca/pit-actions/tires-off-01.mp3",
  ...[
    "all",
    "fronts",
    "rears",
    "lefts",
    "rights",
    "lf",
    "rf",
    "lr",
    "rr",
    "lf-rr",
    "rf-lr",
    "skip-rr",
    "skip-lr",
    "skip-rf",
    "skip-lf",
  ].map((n) => `voice/luca/pit-actions/tires-on-${n}.mp3`),
  "voice/luca/pit-actions/tires-compound-dry.mp3",
  "voice/luca/pit-actions/tires-compound-wet.mp3",
  "voice/luca/flags/yellow-local-01.mp3",
  "voice/luca/flags/yellow-full-01.mp3",
  "voice/luca/flags/yellow-cleared-01.mp3",
  "voice/luca/flags/green-practice-01.mp3",
  "voice/luca/flags/green-qualifying-01.mp3",
  "voice/luca/flags/green-race-01.mp3",
  "voice/luca/flags/green-race-02.mp3",
  "voice/luca/flags/blue-01.mp3",
  "voice/luca/flags/blue-02.mp3",
  "voice/luca/flags/white-practice-01.mp3",
  "voice/luca/flags/white-qualifying-01.mp3",
  "voice/luca/flags/white-race-01.mp3",
  "voice/luca/flags/white-race-02.mp3",
  "voice/luca/flags/red-01.mp3",
  "voice/luca/flags/black-01.mp3",
  "voice/luca/flags/debris-01.mp3",
  "voice/luca/flags/debris-02.mp3",
  "voice/luca/flags/debris-03.mp3",
  "voice/luca/flags/meatball-01.mp3",
  "voice/luca/flags/checkered-practice-01.mp3",
  "voice/luca/flags/checkered-qualifying-01.mp3",
  "voice/luca/flags/checkered-race-01.mp3",
];

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...READBACK_CLIP_NAMES.map((n) => `voice/${VOICE}/pit-readback/${n}.mp3`),
    ...OTHER_CLIP_NAMES,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/**
 * The bundled voice's script, verbatim — the readback entries, their shared
 * fragment and the `radio` frame — handed to the test voice; its pool steps
 * address the clip group directly, resolved against the fixture manifest.
 * The JSON import types `schema` as `number`, hence the cast.
 */
const SCRIPT = defaultScript as CalloutScript;

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let currentSnapshot: PitReadbackSnapshot | null;

beforeEach(() => {
  vi.useFakeTimers();
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  currentSnapshot = null;
  const engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getReadbackSnapshot: () => currentSnapshot,
  });
  // After the registration, as the plugins do: a readback contract plays
  // nothing until the active voice's script says what it reads back.
  engine.setScripts(new Map([[VOICE, SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

type Reason = SimEventMap["pitService.readbackRequested"]["data"]["reason"];

const TIRE_PATTERNS: ReadonlyArray<PitReadbackSnapshot["tires"]> = [
  { lf: false, rf: false, lr: false, rr: false }, // none
  { lf: true, rf: true, lr: true, rr: true },
  { lf: true, rf: true, lr: false, rr: false },
  { lf: false, rf: false, lr: true, rr: true },
  { lf: true, rf: false, lr: true, rr: false },
  { lf: false, rf: true, lr: false, rr: true },
  { lf: true, rf: false, lr: false, rr: true },
  { lf: false, rf: true, lr: true, rr: false },
  { lf: false, rf: true, lr: true, rr: true },
  { lf: true, rf: false, lr: true, rr: true },
  { lf: true, rf: true, lr: false, rr: true },
  { lf: true, rf: true, lr: true, rr: false },
  { lf: true, rf: false, lr: false, rr: false },
  { lf: false, rf: true, lr: false, rr: false },
  { lf: false, rf: false, lr: true, rr: false },
  { lf: false, rf: false, lr: false, rr: true },
];

const COMPOUND_OPTIONS: ReadonlyArray<PitReadbackSnapshot["compoundChange"]> = [
  null,
  { from: 0, to: 1 },
  { from: 1, to: 0 },
];

const BOOLS = [false, true] as const;

function readbackClipsFromPath(path: string): string | null {
  const m = /\/pit-readback\/([^/]+)\.mp3$/.exec(path);

  return m ? (m[1] ?? null) : null;
}

function flush(): void {
  for (let i = 0; i < 60; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
    // Advance fake timers so the 300 ms `{ pause: 300 }` step between
    // the tire/compound slot and fast-repair / windshield extras
    // actually elapses — without this the sequence stops at the pause
    // and the `extras` slot is never reached, so the invariant test
    // never sees those edges.
    vi.advanceTimersByTime(1000);
  }
}

function recordSequence(reason: Reason, snapshot: PitReadbackSnapshot): string[] {
  audio._reset();
  // Publish only `reason` per issue #481; the audio scenarios pull the
  // queued-services snapshot via the resolver closure at fire time.
  currentSnapshot = snapshot;
  bus.publishEvent("pitService.readbackRequested", { reason });
  flush();

  // Filter to readback clips only (drop the engine's radio-frame ticks and
  // any ambient noise).
  return audio._played.map((p) => readbackClipsFromPath(p.path)).filter((n): n is string => n !== null);
}

/**
 * Bucket a clip name into its outer-graph slot id. Optional / fallback
 * clips that share the "may-or-may-not-fire body tail" prosodic envelope
 * (fast-repair, windshield, empty-fallback) collapse into one `extras`
 * slot — they're recorded with consistent lead-in / lead-out so they're
 * acoustically interchangeable as the tail of the readback.
 */
function slotOf(clipName: string): string {
  if (clipName.startsWith("opener-")) return "opener";

  if (clipName === "fuel-on" || clipName === "fuel-off") return "fuel";

  if (clipName.startsWith("tires-") || clipName.startsWith("compound-")) return "tires-or-compound";

  if (clipName.startsWith("fast-repair-") || clipName.startsWith("windshield-") || clipName === "empty-fallback") {
    return "extras";
  }

  throw new Error(`Unbucketed clip: ${clipName}`);
}

describe("pit-readback path-graph invariant", () => {
  it("every slot has ≤3 distinct predecessor slots and ≤3 distinct successor slots", () => {
    const predecessors = new Map<string, Set<string>>();
    const successors = new Map<string, Set<string>>();

    function neighborSet(map: Map<string, Set<string>>, key: string): Set<string> {
      let set = map.get(key);

      if (!set) {
        set = new Set();
        map.set(key, set);
      }

      return set;
    }

    function record(seq: string[]): void {
      // Map clips to slots and collapse runs of the same slot (a single
      // slot picks at most one clip per fire, so this is just defensive
      // against future fanout).
      const slots: string[] = [];

      for (const clip of seq) {
        const slot = slotOf(clip);

        if (slots[slots.length - 1] !== slot) slots.push(slot);
      }

      for (let i = 0; i < slots.length; i++) {
        const cur = slots[i]!;
        const prev = i > 0 ? slots[i - 1]! : null;
        const next = i < slots.length - 1 ? slots[i + 1]! : null;

        if (prev) neighborSet(predecessors, cur).add(prev);

        if (next) neighborSet(successors, cur).add(next);
      }
    }

    const reasons: ReadonlyArray<Reason> = ["entry", "exit"];
    let spokenFires = 0;

    for (const reason of reasons) {
      for (const tires of TIRE_PATTERNS) {
        for (const compoundChange of COMPOUND_OPTIONS) {
          // Compound-change scenarios force all 4 tire bits in iRacing.
          // Skip incompatible combinations to avoid testing unreachable
          // states (the snapshot-builder won't produce them in practice).
          if (compoundChange !== null && !(tires.lf && tires.rf && tires.lr && tires.rr)) continue;

          for (const fuelQ of BOOLS) {
            for (const frAvail of BOOLS) {
              for (const frQ of BOOLS) {
                if (frQ && !frAvail) continue;

                for (const wsAvail of BOOLS) {
                  for (const wsQ of BOOLS) {
                    if (wsQ && !wsAvail) continue;

                    for (const limiter of BOOLS) {
                      for (const damage of BOOLS) {
                        const seq = recordSequence(reason, {
                          fuel: { queued: fuelQ },
                          tires,
                          compoundChange,
                          fastRepair: { queued: frQ, available: frAvail },
                          windshield: { queued: wsQ, available: wsAvail },
                          limiterEngaged: limiter,
                          // Limiter-equipped car (issue #639): keeps the existing
                          // pre-opener graph identical; the no-limiter suppression
                          // path is covered directly in readback.test.ts.
                          hasPitLimiter: true,
                          hasDamage: damage,
                        });

                        if (seq.length > 0) spokenFires++;

                        record(seq);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // The vacuity floor: a contract whose voice has no script is SILENT
    // (issue #1065), and a walk over silence has no edges to violate. Every
    // enumerated fire speaks (the exit opener is unconditional; an empty
    // entry still plays the fallback), and every slot must have been seen.
    expect(spokenFires).toBeGreaterThan(1000);
    expect([...new Set([...predecessors.keys(), ...successors.keys()])].sort()).toEqual([
      "extras",
      "fuel",
      "opener",
      "tires-or-compound",
    ]);

    const violations: string[] = [];

    for (const [slot, prevs] of predecessors) {
      if (prevs.size > 3) {
        violations.push(`slot "${slot}" has ${prevs.size} predecessor slots: ${[...prevs].join(", ")}`);
      }
    }

    for (const [slot, succs] of successors) {
      if (succs.size > 3) {
        violations.push(`slot "${slot}" has ${succs.size} successor slots: ${[...succs].join(", ")}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
