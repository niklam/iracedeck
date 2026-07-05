/**
 * Pit-service readback scenario tests (issue #476, #481).
 *
 * Pins the slot-resolution behavior, family preemption on refire, and
 * per-callout opt-out gating. Drives the scenarios through the real
 * scenario engine so we exercise validation and the same expansion path
 * production uses.
 *
 * Issue #481 changed the data flow: the queued-services snapshot is no
 * longer carried on the event payload; the audio scenarios read it from
 * a resolver closure at fire time. These tests set the closure's source
 * (`currentSnapshot`) before publishing the event so each fire sees the
 * intended state.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, PitReadbackSnapshot, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { type FlagCalloutId, type PitReadbackCalloutId, registerPitCrew } from "./index.js";
import { PIT_BOX_PENDING_HOLD_MS } from "./pit-box.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { buildPitReadbackScenarios } from "./readback.js";
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

function flush(audio: FakeAudio, iterations = 60): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
    // Advance fake timers so any pending `pause` step ({ pause: ms }
    // uses setTimeout) progresses without blocking the synchronous
    // flush loop.
    vi.advanceTimersByTime(1000);
  }
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

// Other catalog clips referenced by scenarios sharing the engine. Required
// to satisfy load-time validation even though we only fire readback events.
const OTHER_CLIP_NAMES = [
  "voice/luca/acknowledgment/okay.mp3",
  "voice/luca/acknowledgment/got-it.mp3",
  "voice/luca/acknowledgment/roger-that.mp3",
  "voice/luca/acknowledgment/copy-that.mp3",
  "voice/luca/acknowledgment/we-got-that.mp3",
  "voice/luca/pit-actions/got-it.mp3",
  "voice/luca/pit-actions/roger-that.mp3",
  "voice/luca/pit-actions/copy-that.mp3",
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
  // Damage callout pool clips (issue #489). Required because
  // `registerPitCrew()` always defines the damage scenarios; without
  // these in the manifest, `definePool` silently rejects the pool
  // (interpreter.ts: logs an error and returns), and any future damage-
  // related test added to this file would hit a missing-pool failure
  // at fire time.
  "voice/luca/damage/repair-needed-01.mp3",
  "voice/luca/damage/repair-needed-02.mp3",
  "voice/luca/damage/repair-needed-03.mp3",
  // Pit-box count-in pool clips (issue #600). Same rationale as the damage
  // clips above — and the #758 interruption/resume tests fire these marks
  // against a playing readback.
  "voice/luca/pit-box/five-01.mp3",
  "voice/luca/pit-box/four-01.mp3",
  "voice/luca/pit-box/three-01.mp3",
  "voice/luca/pit-box/two-01.mp3",
  "voice/luca/pit-box/one-01.mp3",
  "voice/luca/pit-box/pit-now-01.mp3",
];

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...READBACK_CLIP_NAMES.map((name) => `voice/${VOICE}/pit-readback/${name}.mp3`),
    ...OTHER_CLIP_NAMES,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let flagsEnabled: Map<FlagCalloutId, boolean>;
let readbackEnabled: Map<PitReadbackCalloutId, boolean>;
let currentSnapshot: PitReadbackSnapshot | null;

type Reason = SimEventMap["pitService.readbackRequested"]["data"]["reason"];

const EMPTY_SNAPSHOT: PitReadbackSnapshot = {
  fuel: { queued: false },
  tires: { lf: false, rf: false, lr: false, rr: false },
  compoundChange: null,
  fastRepair: { queued: false, available: true },
  windshield: { queued: false, available: true },
  limiterEngaged: false,
  // Default to a limiter-equipped car so the existing limiter pre-opener tests
  // (which represent the common case) stay valid; the no-limiter path is
  // covered by explicit `hasPitLimiter: false` cases (issue #639).
  hasPitLimiter: true,
  hasDamage: false,
};

function snap(overrides: Partial<PitReadbackSnapshot>): PitReadbackSnapshot {
  return { ...EMPTY_SNAPSHOT, ...overrides };
}

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

/**
 * Fire a readback by setting the resolver's snapshot then publishing the
 * (slim) event. Mirrors production: the diff publishes only `reason`,
 * the audio scenario reads the queued-services state via the resolver
 * at fire time.
 */
function fireReadback(reason: Reason, snapshot: PitReadbackSnapshot): void {
  currentSnapshot = snapshot;
  bus.publishEvent("pitService.readbackRequested", { reason });
  flush(audio);
}

beforeEach(() => {
  vi.useFakeTimers();
  flagsEnabled = new Map();
  readbackEnabled = new Map();
  currentSnapshot = null;
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(
    bus,
    (id) => flagsEnabled.get(id) ?? true,
    mockLogger as never,
    (id) => readbackEnabled.get(id) ?? true,
    undefined,
    undefined,
    () => currentSnapshot,
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("pit readback scenarios", () => {
  describe("entry readback", () => {
    it("fires on entry reason and plays the entry opener", () => {
      fireReadback(
        "entry",
        snap({
          fuel: { queued: true },
          tires: { lf: true, rf: true, lr: true, rr: true },
          limiterEngaged: true,
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/fuel-on.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/tires-all.mp3"))).toBe(true);
    });

    it("prepends the limiter pre-opener when limiter is not engaged, then plays opener-entry", () => {
      fireReadback("entry", snap({ fuel: { queued: true }, limiterEngaged: false }));

      const paths = voicePaths();
      const limiterIdx = paths.findIndex((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"));
      const openerIdx = paths.findIndex((p) => p.endsWith("/pit-readback/opener-entry.mp3"));

      expect(limiterIdx).toBeGreaterThanOrEqual(0);
      expect(openerIdx).toBeGreaterThanOrEqual(0);
      expect(limiterIdx).toBeLessThan(openerIdx);
    });

    it("plays only opener-entry (no limiter pre-opener) when limiter is already engaged", () => {
      fireReadback("entry", snap({ fuel: { queued: true }, limiterEngaged: true }));

      expect(voicePaths().some((p) => p.endsWith("/pit-readback/opener-entry.mp3"))).toBe(true);
      expect(voicePaths().some((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"))).toBe(false);
    });

    it("omits the limiter pre-opener on a car with no pit limiter, even when not engaged (issue #639)", () => {
      fireReadback("entry", snap({ fuel: { queued: true }, hasPitLimiter: false, limiterEngaged: false }));

      const paths = voicePaths();
      // The regular opener still plays — only the limiter pre-opener is suppressed.
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"))).toBe(false);
    });

    it("keeps the limiter pre-opener on a limiter-equipped car when not engaged (issue #639 regression guard)", () => {
      fireReadback("entry", snap({ fuel: { queued: true }, hasPitLimiter: true, limiterEngaged: false }));

      expect(voicePaths().some((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"))).toBe(true);
    });

    it("entry-refire reason fires the entry scenario but skips the opener", () => {
      fireReadback("entry-refire", snap({ fuel: { queued: true } }));

      const paths = voicePaths();
      // Slot content still plays on a refire so the recap reflects the
      // updated snapshot, but the opener is silent — the driver heard
      // the carrier sentence already on the initial entry.
      expect(paths.some((p) => p.endsWith("/pit-readback/fuel-on.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"))).toBe(false);
    });

    it("entry-refire skips the limiter pre-opener even when limiter is not engaged", () => {
      fireReadback("entry-refire", snap({ fuel: { queued: true }, limiterEngaged: false }));

      expect(voicePaths().some((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"))).toBe(false);
    });

    it("does not fire the exit scenario", () => {
      fireReadback("entry", snap({ fuel: { queued: true } }));

      expect(voicePaths().some((p) => p.endsWith("/pit-readback/opener-exit.mp3"))).toBe(false);
    });
  });

  describe("exit readback", () => {
    it("fires on exit reason with the exit opener", () => {
      fireReadback("exit", snap({ fuel: { queued: true } }));

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-exit.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/fuel-on.mp3"))).toBe(true);
    });

    it("does not fire on entry / entry-refire reasons", () => {
      fireReadback("entry", snap({ fuel: { queued: true } }));
      const entryPaths = voicePaths().slice();
      expect(entryPaths.some((p) => p.endsWith("/pit-readback/opener-exit.mp3"))).toBe(false);
    });
  });

  describe("empty snapshot", () => {
    it("entry empty plays the limiter pre-opener (when not engaged) + fallback, no opener / no slots", () => {
      fireReadback("entry", snap({ limiterEngaged: false }));

      const paths = voicePaths();
      const limiterIdx = paths.findIndex((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"));
      const fallbackIdx = paths.findIndex((p) => p.endsWith("/pit-readback/empty-fallback.mp3"));

      // Limiter pre-opener fires before the empty-fallback so the engineer
      // still nudges the limiter even when nothing is queued.
      expect(limiterIdx).toBeGreaterThanOrEqual(0);
      expect(fallbackIdx).toBeGreaterThan(limiterIdx);
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/fuel-on.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/fuel-off.mp3"))).toBe(false);
    });

    it("entry empty with limiter engaged plays only the empty-fallback (no openers)", () => {
      fireReadback("entry", snap({ limiterEngaged: true }));

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/empty-fallback.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"))).toBe(false);
    });

    it("exit keeps the opener around the empty-fallback", () => {
      fireReadback("exit", snap({}));

      const paths = voicePaths();
      const openerIdx = paths.findIndex((p) => p.endsWith("/pit-readback/opener-exit.mp3"));
      const fallbackIdx = paths.findIndex((p) => p.endsWith("/pit-readback/empty-fallback.mp3"));

      expect(openerIdx).toBeGreaterThanOrEqual(0);
      expect(fallbackIdx).toBeGreaterThan(openerIdx);
      expect(paths.some((p) => p.endsWith("/pit-readback/fuel-on.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/fuel-off.mp3"))).toBe(false);
    });

    it("treats an unavailable-only fast-repair queue as empty", () => {
      fireReadback(
        "entry",
        snap({
          fastRepair: { queued: true, available: false },
        }),
      );

      expect(voicePaths().some((p) => p.endsWith("/pit-readback/empty-fallback.mp3"))).toBe(true);
    });
  });

  describe("tire pattern slot", () => {
    type Tires = PitReadbackSnapshot["tires"];

    const PATTERNS: ReadonlyArray<[Tires, string]> = [
      [{ lf: true, rf: true, lr: true, rr: true }, "tires-all.mp3"],
      [{ lf: true, rf: true, lr: false, rr: false }, "tires-fronts.mp3"],
      [{ lf: false, rf: false, lr: true, rr: true }, "tires-rears.mp3"],
      [{ lf: true, rf: false, lr: true, rr: false }, "tires-lefts.mp3"],
      [{ lf: false, rf: true, lr: false, rr: true }, "tires-rights.mp3"],
      [{ lf: true, rf: false, lr: false, rr: true }, "tires-lf-rr.mp3"],
      [{ lf: false, rf: true, lr: true, rr: false }, "tires-rf-lr.mp3"],
      [{ lf: false, rf: true, lr: true, rr: true }, "tires-skip-lf.mp3"],
      [{ lf: true, rf: false, lr: true, rr: true }, "tires-skip-rf.mp3"],
      [{ lf: true, rf: true, lr: false, rr: true }, "tires-skip-lr.mp3"],
      [{ lf: true, rf: true, lr: true, rr: false }, "tires-skip-rr.mp3"],
      [{ lf: true, rf: false, lr: false, rr: false }, "tires-lf.mp3"],
      [{ lf: false, rf: true, lr: false, rr: false }, "tires-rf.mp3"],
      [{ lf: false, rf: false, lr: true, rr: false }, "tires-lr.mp3"],
      [{ lf: false, rf: false, lr: false, rr: true }, "tires-rr.mp3"],
    ];

    it.each(PATTERNS)("pattern %j resolves to %s", (tires, expectedClip) => {
      fireReadback("entry", snap({ tires }));

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith(`/pit-readback/${expectedClip}`))).toBe(true);
      // No other tire-pattern clips fire.
      const otherTireClips = PATTERNS.filter(([, c]) => c !== expectedClip);

      for (const [, otherClip] of otherTireClips) {
        expect(paths.some((p) => p.endsWith(`/pit-readback/${otherClip}`))).toBe(false);
      }
    });

    it("falls back to tires-off when no bits are set and no compound change", () => {
      fireReadback("entry", snap({ fuel: { queued: true } }));

      expect(voicePaths().some((p) => p.endsWith("/pit-readback/tires-off.mp3"))).toBe(true);
    });
  });

  describe("compound slot", () => {
    it("plays compound-dry and skips the tire-pattern slot", () => {
      fireReadback(
        "entry",
        snap({
          tires: { lf: true, rf: true, lr: true, rr: true },
          compoundChange: { from: 1, to: 0 },
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/compound-dry.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/tires-all.mp3"))).toBe(false);
    });

    it("plays compound-wet and skips the tire-pattern slot", () => {
      fireReadback(
        "entry",
        snap({
          tires: { lf: true, rf: true, lr: true, rr: true },
          compoundChange: { from: 0, to: 1 },
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/compound-wet.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/tires-all.mp3"))).toBe(false);
    });
  });

  describe("fast repair / windshield slots", () => {
    it("stays silent on both fast-repair and windshield when neither is queued", () => {
      fireReadback(
        "entry",
        snap({
          fuel: { queued: true },
          fastRepair: { queued: false, available: true },
          windshield: { queued: false, available: true },
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-on.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-off.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/windshield-on.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/windshield-off.mp3"))).toBe(false);
    });

    it("stays silent on windshield when not queued (no false 'no windshield' on open-wheel cars)", () => {
      fireReadback(
        "entry",
        snap({
          fuel: { queued: true },
          windshield: { queued: false, available: true },
        }),
      );

      expect(voicePaths().some((p) => p.endsWith("/pit-readback/windshield-off.mp3"))).toBe(false);
      expect(voicePaths().some((p) => p.endsWith("/pit-readback/windshield-on.mp3"))).toBe(false);
    });
  });

  // Issue #489: the fast-repair slot is gated on `hasDamage` so the readback
  // stays silent about repairs on a clean car (regardless of whether the
  // user accidentally queued fast-repair).
  describe("fast-repair damage gate (issue #489)", () => {
    it("plays fast-repair-on when damaged and queued", () => {
      fireReadback(
        "entry",
        snap({
          fuel: { queued: true },
          hasDamage: true,
          fastRepair: { queued: true, available: true },
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-on.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-off.mp3"))).toBe(false);
    });

    it("plays fast-repair-off when damaged but not queued (warns the driver)", () => {
      fireReadback(
        "entry",
        snap({
          fuel: { queued: true },
          hasDamage: true,
          fastRepair: { queued: false, available: true },
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-off.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-on.mp3"))).toBe(false);
    });

    it("drops the fast-repair slot when no damage, even if queued", () => {
      fireReadback(
        "entry",
        snap({
          fuel: { queued: true },
          hasDamage: false,
          fastRepair: { queued: true, available: true },
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-on.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-off.mp3"))).toBe(false);
    });

    it("drops the fast-repair slot when damaged but the series doesn't offer fast-repair", () => {
      fireReadback(
        "entry",
        snap({
          fuel: { queued: true },
          hasDamage: true,
          fastRepair: { queued: false, available: false },
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-on.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-off.mp3"))).toBe(false);
    });

    it("collapses to empty-fallback when only fast-repair was queued and the car is clean", () => {
      fireReadback(
        "entry",
        snap({
          hasDamage: false,
          fastRepair: { queued: true, available: true },
          limiterEngaged: true,
        }),
      );

      const paths = voicePaths();
      expect(paths.some((p) => p.endsWith("/pit-readback/empty-fallback.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-on.mp3"))).toBe(false);
    });

    it("damaged + nothing else queued still produces a non-empty readback (the fast-repair-off warning)", () => {
      fireReadback(
        "entry",
        snap({
          hasDamage: true,
          fastRepair: { queued: false, available: true },
          limiterEngaged: true,
        }),
      );

      const paths = voicePaths();
      // hasAnyService(snapshot) returns true because of the damage+available
      // path, so we get the regular opener and slots — not the empty
      // fallback. The fast-repair-off warning carries the meaningful content.
      expect(paths.some((p) => p.endsWith("/pit-readback/empty-fallback.mp3"))).toBe(false);
      expect(paths.some((p) => p.endsWith("/pit-readback/opener-entry.mp3"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/pit-readback/fast-repair-off.mp3"))).toBe(true);
    });
  });

  describe("opt-out gating", () => {
    it("entry callout suppressed when opt-out is off", () => {
      readbackEnabled.set("pit-readback-entry", false);
      fireReadback("entry", snap({ fuel: { queued: true } }));

      expect(voicePaths().some((p) => p.includes("/pit-readback/"))).toBe(false);
    });

    it("exit callout suppressed when opt-out is off", () => {
      readbackEnabled.set("pit-readback-exit", false);
      fireReadback("exit", snap({ fuel: { queued: true } }));

      expect(voicePaths().some((p) => p.includes("/pit-readback/"))).toBe(false);
    });

    it("entry off does not affect exit", () => {
      readbackEnabled.set("pit-readback-entry", false);
      fireReadback("exit", snap({ fuel: { queued: true } }));

      expect(voicePaths().some((p) => p.endsWith("/pit-readback/opener-exit.mp3"))).toBe(true);
    });
  });

  describe("slot composition", () => {
    it("emits each populated slot back-to-back without glue clips", () => {
      fireReadback(
        "entry",
        snap({
          fuel: { queued: true },
          tires: { lf: true, rf: true, lr: true, rr: true },
          hasDamage: true,
          fastRepair: { queued: true, available: true },
          windshield: { queued: true, available: true },
          limiterEngaged: true,
        }),
      );

      const readbackPaths = voicePaths()
        .filter((p) => p.includes("/pit-readback/"))
        .map((p) => p.split("/pit-readback/")[1]);

      // Opener → fuel → tires → fast-repair → windshield, in that order.
      // The 300 ms pause between tires and the extras isn't a clip so
      // doesn't appear in the played-paths list.
      expect(readbackPaths).toEqual([
        "opener-entry.mp3",
        "fuel-on.mp3",
        "tires-all.mp3",
        "fast-repair-on.mp3",
        "windshield-on.mp3",
      ]);
    });
  });

  // Issue #481 regression: a queueable readback that gets stashed as the bus's
  // `pending` fire (busy-bus deferral or interrupt-preempt) must speak the
  // CURRENT queued-services state when it eventually replays — not the
  // state captured at the moment the original event was emitted. The bug
  // before #481 was that the snapshot rode on the event payload, so the
  // deferred replay walked stale data. With the resolver pulled at fire
  // time, the replay reads whatever the user has queued NOW.
  describe("deferred-replay snapshot freshness (issue #481)", () => {
    it("uses the latest snapshot when a busy-bus deferred low fire replays", () => {
      // 1. Stash an "all four tires" snapshot the first event would see.
      currentSnapshot = snap({ fuel: { queued: true }, tires: { lf: true, rf: true, lr: true, rr: true } });

      // 2. Pre-occupy the bus with a normal-priority fuel-toggle confirmation
      //    so the readback can't fire immediately and gets deferred.
      bus.publishEvent("pitService.toggled", { service: "fuel", on: true });

      // 3. Publish the readback while the bus is still busy with the
      //    fuel-toggle. The readback (CHATTER) loses the bus to the toggle
      //    (NORMAL) and is stashed as the bus's `pending` fire — no clips
      //    play yet for the readback.
      bus.publishEvent("pitService.readbackRequested", { reason: "entry" });

      // 4. Sim state changes between event emit and deferred replay: the
      //    user toggles tires down to FRONTS only.
      currentSnapshot = snap({
        fuel: { queued: true },
        tires: { lf: true, rf: true, lr: false, rr: false },
      });

      // 5. Drain the bus. Toggle confirmation finishes, deferred replay
      //    runs against the CURRENT snapshot.
      flush(audio);

      const readbackPaths = voicePaths()
        .filter((p) => p.includes("/pit-readback/"))
        .map((p) => p.split("/pit-readback/")[1]);

      // The replay must reflect the post-toggle state (fronts only).
      // Pre-#481 the deferred fire walked the stale "all four" snapshot
      // and mis-spoke the tire pattern.
      expect(readbackPaths).toContain("tires-fronts.mp3");
      expect(readbackPaths).not.toContain("tires-all.mp3");
    });

    it("uses the latest snapshot when an interrupt preempt stashes the readback", () => {
      // 1. Set the snapshot the original event would have captured.
      currentSnapshot = snap({ fuel: { queued: true }, tires: { lf: true, rf: true, lr: true, rr: true } });

      // 2. Fire the readback. It starts playing immediately
      //    (radio-open → opener → …).
      bus.publishEvent("pitService.readbackRequested", { reason: "entry" });

      // 3. Mid-playback, raise a meatball — a CRITICAL + interrupt callout
      //    that cuts the in-flight readback. Because the readback is
      //    `queueable`, the interpreter stashes it as the bus's `pending`
      //    fire for replay once the meatball completes (issue #652).
      bus.publishEvent("flag.meatball.raised", {});

      // 4. While the meatball plays, the user changes the queue (e.g.
      //    cancels two tires). The replay must reflect this.
      currentSnapshot = snap({
        fuel: { queued: true },
        tires: { lf: true, rf: true, lr: false, rr: false },
      });

      // 5. Drain — meatball finishes, the stashed readback replays.
      flush(audio);

      const readbackPaths = voicePaths()
        .filter((p) => p.includes("/pit-readback/"))
        .map((p) => p.split("/pit-readback/")[1]);

      // Both the original (pre-empted) and the replay run inside one
      // flush window; the replay's tire pattern must be the post-toggle
      // one. Pre-#481 the replay re-expanded the stashed event's frozen
      // snapshot and reported "tires-all".
      expect(readbackPaths).toContain("tires-fronts.mp3");
    });
  });
});

// Issue #758 (reverses #646): the pit-box count-in outranks the readback and
// cuts it immediately; the readback never interrupts a count-in; the
// interrupted readback resumes from the interrupted clip once the count-in is
// done (after the marks' pending-hold window), not from the top.
describe("count-in priority over the readback (issue #758)", () => {
  it("declares the readback queueable + resumable and never interrupting", () => {
    for (const s of buildPitReadbackScenarios(() => null)) {
      expect(s.weight).toBe(WEIGHT.CHATTER);
      expect(s.queueable).toBe(true);
      expect(s.resumable).toBe(true);
      expect(s.interrupt).not.toBe(true);
    }
  });

  it("a count-in mark cuts the playing readback, which resumes at the interrupted clip", () => {
    currentSnapshot = snap({
      fuel: { queued: true },
      tires: { lf: true, rf: true, lr: true, rr: true },
      limiterEngaged: true,
    });

    bus.publishEvent("pitService.readbackRequested", { reason: "entry" });
    audio._triggerChannelEnd(AudioChannel.SFX); // tick-open done → opener-entry
    audio._triggerChannelEnd(AudioChannel.Voice); // opener done → fuel-on in flight

    bus.publishEvent("pitBox.countdown", { mark: "two" }); // cuts fuel-on
    audio._triggerChannelEnd(AudioChannel.Voice); // mark finishes → hold armed

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/pit-readback/opener-entry.mp3`,
      `voice/${VOICE}/pit-readback/fuel-on.mp3`,
      `voice/${VOICE}/pit-box/two-01.mp3`,
    ]);

    // The resume waits out the marks' pending-hold window.
    vi.advanceTimersByTime(PIT_BOX_PENDING_HOLD_MS);
    flush(audio);

    // Resumed from the interrupted clip: fuel-on replays, then the rest —
    // the opener is NOT spoken a second time.
    expect(voicePaths()).toEqual([
      `voice/${VOICE}/pit-readback/opener-entry.mp3`,
      `voice/${VOICE}/pit-readback/fuel-on.mp3`,
      `voice/${VOICE}/pit-box/two-01.mp3`,
      `voice/${VOICE}/pit-readback/fuel-on.mp3`,
      `voice/${VOICE}/pit-readback/tires-all.mp3`,
    ]);
  });

  it("a readback fired during a count-in defers (never cuts) and replays in full after the hold", () => {
    currentSnapshot = snap({
      fuel: { queued: true },
      tires: { lf: true, rf: true, lr: true, rr: true },
      limiterEngaged: true,
    });

    bus.publishEvent("pitBox.countdown", { mark: "five" }); // five-01 in flight
    bus.publishEvent("pitService.readbackRequested", { reason: "entry" }); // must defer

    expect(voicePaths()).toEqual([`voice/${VOICE}/pit-box/five-01.mp3`]);

    audio._triggerChannelEnd(AudioChannel.Voice); // mark finishes → hold armed

    // Still held — the readback must not start in the gap between marks.
    expect(voicePaths()).toEqual([`voice/${VOICE}/pit-box/five-01.mp3`]);

    vi.advanceTimersByTime(PIT_BOX_PENDING_HOLD_MS);
    flush(audio);

    // Full replay from the top (it never started, so there is nothing to resume).
    expect(voicePaths()).toEqual([
      `voice/${VOICE}/pit-box/five-01.mp3`,
      `voice/${VOICE}/pit-readback/opener-entry.mp3`,
      `voice/${VOICE}/pit-readback/fuel-on.mp3`,
      `voice/${VOICE}/pit-readback/tires-all.mp3`,
    ]);
  });
});
