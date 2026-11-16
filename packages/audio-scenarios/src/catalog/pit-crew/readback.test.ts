/**
 * Pit-service readback tests (issue #476, #481; scripted since #1065).
 *
 * Pins the slot-resolution behavior, family preemption on refire, and
 * per-callout opt-out gating. Drives the contracts through the real
 * scenario engine with the bundled voice's real `callouts.json`, so every
 * fire exercises the same compile + expansion path production uses — what
 * the readback says is the script's, and the tests read the script.
 *
 * Issue #481 changed the data flow: the queued-services snapshot is no
 * longer carried on the event payload; the readback vocabulary reads it
 * from a resolver closure at fire time. These tests set the closure's
 * source (`currentSnapshot`) before publishing the event so each fire sees
 * the intended state.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio, type FakeAudio } from "@iracedeck/audio-service/testing";
import { type CalloutScript } from "@iracedeck/callout-script";
import { FLAG_CALLOUTS, PIT_READBACK_CALLOUTS, SPOTTER_CALLOUTS } from "@iracedeck/callout-settings";
import type { IEventBus, PitReadbackSnapshot, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { classifySession } from "@iracedeck/sim-events-iracing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { familyGate } from "./callout-gate.test-util.js";
import { familyReferences } from "./family-references.test-util.js";
import { type FlagCalloutId, type PitReadbackCalloutId, registerPitCrew } from "./index.js";
import { _resetLimiterCueEngine } from "./limiter-cue-engine.js";
import { PIT_BOX_PENDING_HOLD_MS } from "./pit-box.js";
import { _resetPitExitCueEngine } from "./pit-exit-cue-engine.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { _resetRadarEngine } from "./radar-engine.js";
import {
  PIT_READBACK_CLIP_SOURCES,
  PIT_READBACK_CONTRACTS,
  PIT_READBACK_SCENARIO_IDS,
  READBACK_MAX_QUEUE_WAIT_MS,
  resolveTirePattern,
  TIRE_PATTERN_KEYS,
} from "./readback.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const mockSessionType = vi.fn(() => "Race");
// The session the registrations see (#1378), over the stub above.
const SIM_READS = { getSessionClass: () => classifySession(mockSessionType()) };

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

/**
 * The voice's callout script: the bundled voice's `callouts.json`, verbatim.
 * It supplies the `radio` frame the engine wraps every callout in (issue
 * #1064) AND the readback's own two entries plus the `readback-body`
 * fragment they share (#1065) — the readback is a pair of contracts now, so
 * a fire plays nothing unless the active voice's script says what to say.
 * Handed to the test voice as-is: the script addresses its clips as
 * `pool:pit-readback/<base>`, resolved against the fixture manifest for
 * whichever voice is active. The JSON import types `schema` as `number`,
 * hence the cast.
 */
const SCRIPT = defaultScript as CalloutScript;

/**
 * The bundled script narrowed to the readback family's own entries AND its
 * own fragment: `collectScriptReferences` walks every fragment a script
 * defines, so carrying another family's fragment along (the gap readout, say)
 * would make that family's vars show up as readback's.
 */
const READBACK_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(PIT_READBACK_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: Object.fromEntries(Object.entries(SCRIPT.fragments ?? {}).filter(([name]) => name === "readback-body")),
};

/** The bundled manifest, for the clip-existence half of the sources check. */
const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;
let flagsEnabled: Map<FlagCalloutId, boolean>;
let readbackEnabled: Map<PitReadbackCalloutId, boolean>;
/** The spotter's "Cars" opt-in; "Still there" stays on (issue #1681's floor-held cut). */
let spotterCarsEnabled: boolean;
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
  spotterCarsEnabled = true;
  currentSnapshot = null;
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  // The production wiring (`registerPitCrew`): the readback vocabulary and
  // contracts register beside the rest of the catalog, so the cross-family
  // cases below (the count-in cutting a readback, a meatball stashing one)
  // run against the real scheduling neighbours.
  registerPitCrew(bus, {
    ...SIM_READS,
    logger: mockLogger as never,
    isCalloutEnabled: (key) =>
      familyGate(FLAG_CALLOUTS, (id) => flagsEnabled.get(id) ?? true)(key) &&
      familyGate(PIT_READBACK_CALLOUTS, (id) => readbackEnabled.get(id) ?? true)(key) &&
      familyGate(SPOTTER_CALLOUTS, (id) => id !== "cars" || spotterCarsEnabled)(key),
    getReadbackSnapshot: () => currentSnapshot,
  });
  // After the registration, as the plugins do: the readback's body and its
  // frame are both looked up in the active voice's compiled script at fire
  // time, and the step-by-step tests below drive the open tick the engine
  // puts in front of every readback.
  engine.setScripts(new Map([[VOICE, SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  _resetPitExitCueEngine();
  _resetLimiterCueEngine();
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
      //    (the engine's radio-frame open tick → opener → …).
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
    for (const c of PIT_READBACK_CONTRACTS) {
      expect(c.weight).toBe(WEIGHT.CHATTER);
      expect(c.queueable).toBe(true);
      expect(c.resumable).toBe(true);
      expect(c.interrupt).not.toBe(true);
    }
  });

  it("a count-in mark cuts the playing readback, which resumes at the interrupted clip", () => {
    currentSnapshot = snap({
      fuel: { queued: true },
      tires: { lf: true, rf: true, lr: true, rr: true },
      limiterEngaged: true,
    });

    bus.publishEvent("pitService.readbackRequested", { reason: "entry" });
    audio._triggerChannelEnd(AudioChannel.SFX); // the frame's open tick done → opener-entry
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

// Issue #1681: a cut line keeps its due time, so the entry readback's resume
// after the count-in is measured from when the readback took the bus at 0 s,
// not from the cut. The count-in train outlasts the 8 s default, so both
// readbacks wait READBACK_MAX_QUEUE_WAIT_MS, and share a supersede group so
// an entry readback still waiting when the exit readback speaks is dropped.
// Each drop half sits beside its replay half, in the same fixture, as its
// positive control. (On master, where the wait ran from the cut, this resume
// was dropped too, at `waited 9340 ms`: confirmed on 2026-11-10 against
// master's built engine. That is why the fix ships a Bug Fixes fragment.)
describe("the readback's wait covers the count-in train (issue #1681)", () => {
  const ENTRY_ID = "pit-crew.pit-readback-entry";
  /** The entry contract without its 30 s override: the engine's 8 s default. */
  const DEFAULT_WAIT_ID = "test.pit-readback-entry-default-wait";
  const MARKS = ["five", "four", "three", "two", "one", "pit-now"] as const;
  /** A mark every 20 m at a 60 km/h pit limit. */
  const MARK_GAP_MS = 1200;
  /** The bundled voice's count-in clips. */
  const MARK_CLIP_MS = 840;
  /** The bundled voice's limiter pre-opener. */
  const LIMITER_OPENER_MS = 1620;
  /** When the "five" cuts the readback. */
  const CUT_AT_MS = 3000;
  /** "pit now" at 9 s, its clip, then the marks' pending hold: about 12.34 s after the readback was due. */
  const RESUME_AT_MS = CUT_AT_MS + (MARKS.length - 1) * MARK_GAP_MS + MARK_CLIP_MS + PIT_BOX_PENDING_HOLD_MS;

  /** Everything the entry readback can say: fuel, four tires, fast repair on a damaged car, windshield. */
  const FULL_SERVICE = snap({
    fuel: { queued: true },
    tires: { lf: true, rf: true, lr: true, rr: true },
    fastRepair: { queued: true, available: true },
    windshield: { queued: true, available: true },
    hasDamage: true,
    limiterEngaged: false,
  });

  /**
   * The entry readback plays from 0 s; the count-in's "five" cuts it at 3 s,
   * in its opener; the marks follow every 1.2 s, each clip ending 0.84 s after
   * it starts. Returns at the end of "pit now" (9.84 s), the hold armed.
   */
  function cutByTheCountIn(): void {
    currentSnapshot = FULL_SERVICE;
    bus.publishEvent("pitService.readbackRequested", { reason: "entry" });
    audio._triggerChannelEnd(AudioChannel.SFX); // the frame's open tick → the limiter pre-opener
    vi.advanceTimersByTime(LIMITER_OPENER_MS);
    audio._triggerChannelEnd(AudioChannel.Voice); // → opener-entry
    vi.advanceTimersByTime(CUT_AT_MS - LIMITER_OPENER_MS);

    for (const [i, mark] of MARKS.entries()) {
      if (i > 0) vi.advanceTimersByTime(MARK_GAP_MS - MARK_CLIP_MS);

      bus.publishEvent("pitBox.countdown", { mark });
      vi.advanceTimersByTime(MARK_CLIP_MS);
      audio._triggerChannelEnd(AudioChannel.Voice);
    }
  }

  /** The voice clips heard after "pit now", by their path below the voice. */
  function heardAfterTheCountIn(): string[] {
    const paths = voicePaths();
    const pitNow = paths.indexOf(`voice/${VOICE}/pit-box/pit-now-01.mp3`);

    return paths.slice(pitNow + 1).map((p) => p.split(`voice/${VOICE}/`)[1]);
  }

  function infoMessages(): string[] {
    return mockLogger.info.mock.calls.map(([message]) => String(message));
  }

  it("the cut is in the readback's opener, and every mark plays in turn", () => {
    cutByTheCountIn();

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/pit-readback/opener-entry-limiter.mp3`,
      `voice/${VOICE}/pit-readback/opener-entry.mp3`,
      ...MARKS.map((mark) => `voice/${VOICE}/pit-box/${mark}-01.mp3`),
    ]);
    expect(mockLogger.debug).toHaveBeenCalledWith(`Scenario "${ENTRY_ID}" pending (1 of 1) — stashed (preempted)`);
  });

  it("resumes from the cut clip at about 12.34 s after it was due, inside its 30 s wait", () => {
    cutByTheCountIn();

    vi.advanceTimersByTime(PIT_BOX_PENDING_HOLD_MS - 1);
    expect(infoMessages()).not.toContain(`Resuming scenario "${ENTRY_ID}"`);

    vi.advanceTimersByTime(1);
    expect(RESUME_AT_MS).toBe(12_340);
    expect(infoMessages()).toContain(`Resuming scenario "${ENTRY_ID}"`);

    flush(audio);

    // From the clip the "five" cut — the limiter pre-opener is not said twice.
    expect(heardAfterTheCountIn()).toEqual([
      "pit-readback/opener-entry.mp3",
      "pit-readback/fuel-on.mp3",
      "pit-readback/tires-all.mp3",
      "pit-readback/fast-repair-on.mp3",
      "pit-readback/windshield-on.mp3",
    ]);
  });

  it("the same contract on the 8 s default is dropped at the drain, its wait counted from 0 s", () => {
    const entry = PIT_READBACK_CONTRACTS.find((c) => c.id === ENTRY_ID);

    if (entry === undefined) throw new Error(`no ${ENTRY_ID} contract`);

    // The real entry readback is switched off, so only the copy answers the event.
    readbackEnabled.set("pit-readback-entry", false);
    engine.defineContract({ ...entry, id: DEFAULT_WAIT_ID, maxQueueWaitMs: undefined });
    engine.setScripts(
      new Map([
        [VOICE, { ...SCRIPT, scenarios: { ...SCRIPT.scenarios, [DEFAULT_WAIT_ID]: SCRIPT.scenarios[ENTRY_ID] } }],
      ]),
    );

    cutByTheCountIn();
    flush(audio);

    expect(voicePaths()[1]).toBe(`voice/${VOICE}/pit-readback/opener-entry.mp3`);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      `Scenario "${DEFAULT_WAIT_ID}" dropped — waited ${RESUME_AT_MS} ms (max 8000 ms)`,
    );
    expect(infoMessages()).not.toContain(`Resuming scenario "${DEFAULT_WAIT_ID}"`);
    expect(heardAfterTheCountIn()).toEqual([]);
  });

  it("an exit readback taking the bus drops the entry readback still waiting", () => {
    cutByTheCountIn();

    // Inside the hold, the entry readback still waiting: the exit readback is
    // newer news about the same stop.
    vi.advanceTimersByTime(1000);
    bus.publishEvent("pitService.readbackRequested", { reason: "exit" });

    expect(mockLogger.debug).toHaveBeenCalledWith(
      `Scenario "${ENTRY_ID}" dropped — superseded by "pit-crew.pit-readback-exit"`,
    );

    flush(audio);

    expect(infoMessages()).not.toContain(`Resuming scenario "${ENTRY_ID}"`);
    expect(heardAfterTheCountIn()).toEqual([
      "pit-readback/opener-exit.mp3",
      "pit-readback/fuel-on.mp3",
      "pit-readback/tires-all.mp3",
      "pit-readback/fast-repair-on.mp3",
      "pit-readback/windshield-on.mp3",
    ]);
  });

  describe("an exit readback deferred behind a heavier line", () => {
    /** The entry readback plays from 0 s; the "five" cuts it at 3 s and holds the bus for its 0.84 s clip. */
    function entryCutByTheFive(): void {
      currentSnapshot = FULL_SERVICE;
      bus.publishEvent("pitService.readbackRequested", { reason: "entry" });
      audio._triggerChannelEnd(AudioChannel.SFX); // the frame's open tick → the limiter pre-opener
      vi.advanceTimersByTime(LIMITER_OPENER_MS);
      audio._triggerChannelEnd(AudioChannel.Voice); // → opener-entry
      vi.advanceTimersByTime(CUT_AT_MS - LIMITER_OPENER_MS);
      bus.publishEvent("pitBox.countdown", { mark: "five" });
      expect(mockLogger.debug).toHaveBeenCalledWith(`Scenario "${ENTRY_ID}" pending (1 of 1) — stashed (preempted)`);
      vi.advanceTimersByTime(400);
    }

    /** The "five" ends, the hold runs out, and everything left plays. */
    function playOut(): void {
      vi.advanceTimersByTime(MARK_CLIP_MS - 400);
      audio._triggerChannelEnd(AudioChannel.Voice);
      vi.advanceTimersByTime(PIT_BOX_PENDING_HOLD_MS);
      flush(audio);
    }

    function heardAfterTheFive(): string[] {
      const paths = voicePaths();

      return paths
        .slice(paths.indexOf(`voice/${VOICE}/pit-box/five-01.mp3`) + 1)
        .map((p) => p.split(`voice/${VOICE}/`)[1]);
    }

    it("drops the entry readback waiting beside it, when the exit is offered to the queue", () => {
      entryCutByTheFive();
      bus.publishEvent("pitService.readbackRequested", { reason: "exit" }); // the "five" holds the bus

      expect(mockLogger.debug).toHaveBeenCalledWith(
        `Scenario "${ENTRY_ID}" dropped — superseded by "pit-crew.pit-readback-exit"`,
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Scenario "pit-crew.pit-readback-exit" pending (1 of 1) — deferred (bus busy)',
      );

      playOut();

      expect(infoMessages()).not.toContain(`Resuming scenario "${ENTRY_ID}"`);
      expect(heardAfterTheFive()).toEqual([
        "pit-readback/opener-exit.mp3",
        "pit-readback/fuel-on.mp3",
        "pit-readback/tires-all.mp3",
        "pit-readback/fast-repair-on.mp3",
        "pit-readback/windshield-on.mp3",
      ]);
    });

    it("without the exit readback, the entry readback resumes after the hold (positive control)", () => {
      entryCutByTheFive();
      playOut();

      expect(infoMessages()).toContain(`Resuming scenario "${ENTRY_ID}"`);
      expect(heardAfterTheFive()[0]).toBe("pit-readback/opener-entry.mp3");
    });
  });

  // Reachable because the focus floor is checked before the same-family
  // replacement: an exit readback arriving while the entry readback plays
  // under the spotter's floor waits below the floor instead of replacing the
  // entry. The floor is up without a call cutting the entry when "Cars" is
  // off and "Still there" on; the meatball then cuts the entry, whose stash
  // yields to the newer exit readback (`yieldsToGroup`).
  describe("an entry readback cut after an exit readback queued below the spotter's floor", () => {
    /** The entry readback plays from 0 s; at 0.5 s a car pulls alongside, raising the floor without a call. */
    function entryPlayingUnderTheFloor(): void {
      spotterCarsEnabled = false;
      currentSnapshot = FULL_SERVICE;
      bus.publishEvent("pitService.readbackRequested", { reason: "entry" });
      audio._triggerChannelEnd(AudioChannel.SFX); // the frame's open tick → the limiter pre-opener
      vi.advanceTimersByTime(500);
      bus.publishEvent("radar.changed", { from: "clear", to: "left" });
      vi.advanceTimersByTime(500);
    }

    /** At 1.5 s the meatball cuts the entry readback; then the car is gone and everything left plays. */
    function meatballThenClear(): void {
      vi.advanceTimersByTime(500);
      bus.publishEvent("flag.meatball.raised", {});
      vi.advanceTimersByTime(500);
      bus.publishEvent("radar.changed", { from: "left", to: "clear" });
      flush(audio);
    }

    it("the entry readback's stash yields to the waiting exit readback", () => {
      entryPlayingUnderTheFloor();
      bus.publishEvent("pitService.readbackRequested", { reason: "exit" });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Scenario "pit-crew.pit-readback-exit" pending (1 of 1) — deferred (below focus floor (spotter))',
      );

      meatballThenClear();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        `Scenario "${ENTRY_ID}" dropped — superseded by "pit-crew.pit-readback-exit"`,
      );
      expect(infoMessages()).not.toContain(`Resuming scenario "${ENTRY_ID}"`);
      expect(voicePaths().filter((p) => p.endsWith("/pit-readback/opener-entry-limiter.mp3"))).toHaveLength(1);
      expect(voicePaths()).toContain(`voice/${VOICE}/pit-readback/opener-exit.mp3`);
    });

    it("without the exit readback, the cut entry readback is stashed and resumes (positive control)", () => {
      entryPlayingUnderTheFloor();
      meatballThenClear();

      expect(mockLogger.debug).toHaveBeenCalledWith(`Scenario "${ENTRY_ID}" pending (1 of 1) — stashed (preempted)`);
      expect(infoMessages()).toContain(`Resuming scenario "${ENTRY_ID}"`);
    });
  });

  it("pins both readbacks to READBACK_MAX_QUEUE_WAIT_MS (30 s) in the shared pit-readback group", () => {
    expect(READBACK_MAX_QUEUE_WAIT_MS).toBe(30_000);

    for (const c of PIT_READBACK_CONTRACTS) {
      expect(c.maxQueueWaitMs, c.id).toBe(READBACK_MAX_QUEUE_WAIT_MS);
      expect(c.supersedeGroup, c.id).toBe("pit-readback");
    }
  });
});

// The migration (issue #1065): the two readbacks are contracts — the code
// decides WHEN a readback fires and how it is scheduled, the voice's script
// says WHAT it reads back — and the closure predicates became named
// vocabulary the script branches on.
describe("PIT_READBACK_CONTRACTS structure (issue #1065)", () => {
  function readbackEvent(reason: Reason): SimEventOf<SimEventName> {
    return { event: "pitService.readbackRequested", timestamp: 0, telemetry: null, data: { reason } } as never;
  }

  it("defines the entry contract and the exit contract, in that order", () => {
    expect(PIT_READBACK_CONTRACTS.map((c) => c.id)).toEqual([
      "pit-crew.pit-readback-entry",
      "pit-crew.pit-readback-exit",
    ]);
    expect(PIT_READBACK_SCENARIO_IDS).toEqual(PIT_READBACK_CONTRACTS.map((c) => c.id));
  });

  it("carries no sequence — what the readback says is the voice script's, never the code's", () => {
    for (const c of PIT_READBACK_CONTRACTS) expect("sequence" in c).toBe(false);
  });

  it("keeps every scheduling field of the former scenarios verbatim, and takes the engine's default frame", () => {
    for (const c of PIT_READBACK_CONTRACTS) {
      expect(c.when?.event).toBe("pitService.readbackRequested");
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.weight).toBe(WEIGHT.CHATTER);
      expect(c.family).toBe("pit-readback");
      expect(c.queueable).toBe(true);
      expect(c.resumable).toBe(true);
      expect(c.interrupt).toBeUndefined();
      expect(c.cooldown).toBeUndefined();
      expect(c.triggerDelay).toBeUndefined();
      expect(c.frame).toBeUndefined();
    }
  });

  it("the entry contract answers `entry` and `entry-refire`, the exit contract `exit` only — the reason is the only thing `where:` reads", () => {
    const answers = (id: string, reason: Reason): boolean | undefined => {
      const contract = PIT_READBACK_CONTRACTS.find((c) => c.id === id);

      return contract?.when?.where?.(readbackEvent(reason));
    };

    expect(answers("pit-crew.pit-readback-entry", "entry")).toBe(true);
    expect(answers("pit-crew.pit-readback-entry", "entry-refire")).toBe(true);
    expect(answers("pit-crew.pit-readback-entry", "exit")).toBe(false);

    expect(answers("pit-crew.pit-readback-exit", "exit")).toBe(true);
    expect(answers("pit-crew.pit-readback-exit", "entry")).toBe(false);
    expect(answers("pit-crew.pit-readback-exit", "entry-refire")).toBe(false);
  });
});

describe("registerReadbackVocabulary (issue #1065)", () => {
  /** The readback family's slice of what the whole catalog registered. */
  function readbackVocabulary(): {
    conds: { name: string; description: string }[];
    cases: { name: string; description: string; keys: Readonly<Record<string, string>> }[];
  } {
    const { conds, cases } = engine.vocabulary();

    return {
      conds: conds.filter((c) => c.name.startsWith("readback.")),
      cases: cases.filter((c) => c.name.startsWith("readback.")),
    };
  }

  it("publishes the seven conditions and the tire-pattern case, each with a description for a pack author", () => {
    const { conds, cases } = readbackVocabulary();

    expect(conds.map((c) => c.name)).toEqual([
      "readback.fastRepairQueued",
      "readback.fastRepairSkipped",
      "readback.fuelQueued",
      "readback.hasAnyService",
      "readback.isFirstEntry",
      "readback.limiterReminderDue",
      "readback.windshieldQueued",
    ]);
    expect(cases.map((c) => c.name)).toEqual(["readback.tirePattern"]);

    for (const entry of [...conds, ...cases]) {
      expect(entry.description.length, entry.name).toBeGreaterThan(0);
    }

    for (const [key, description] of Object.entries(cases[0]?.keys ?? {})) {
      expect(description.length, `readback.tirePattern key ${key}`).toBeGreaterThan(0);
    }
  });

  it("declares exactly the keys the tire-pattern resolver can return — enumerated over every reachable snapshot", () => {
    const declared = readbackVocabulary().cases[0]?.keys ?? {};
    const reachable = new Set<string>();

    // Every combination of the four tire bits, with no compound change and
    // with each compound the sim can queue.
    for (let bits = 0; bits < 16; bits++) {
      const tires = { lf: !!(bits & 1), rf: !!(bits & 2), lr: !!(bits & 4), rr: !!(bits & 8) };

      for (const compoundChange of [null, { from: 1, to: 0 }, { from: 0, to: 1 }]) {
        const key = resolveTirePattern(snap({ tires, compoundChange }));

        expect(key).not.toBeNull();
        reachable.add(key ?? "");
      }
    }

    expect([...reachable].sort()).toEqual(Object.keys(declared).sort());
    expect(Object.keys(declared).sort()).toEqual(Object.keys(TIRE_PATTERN_KEYS).sort());
    expect(Object.keys(declared)).toHaveLength(18);
  });

  it("a compound the catalog has no word for resolves to no key — the slot says nothing, as the closure did", () => {
    expect(resolveTirePattern(snap({ compoundChange: { from: 0, to: 7 } }))).toBeNull();
  });
});

describe("the bundled script's readback entries (issue #1065)", () => {
  it("scripts both contracts, each with a comment, a Pit Service Readback harness route and a sequence", () => {
    for (const id of PIT_READBACK_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness → Pit Service Readback → /);
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence?.length ?? 0, `${id}: sequence`).toBeGreaterThan(0);
    }
  });

  it("both entries include the readback-body fragment, defined once under `fragments` with a comment", () => {
    const fragment = SCRIPT.fragments?.["readback-body"];

    expect(fragment).toBeDefined();
    expect(fragment?.comment?.length ?? 0).toBeGreaterThan(0);
    expect(fragment?.sequence.length ?? 0).toBeGreaterThan(0);

    for (const id of PIT_READBACK_SCENARIO_IDS) {
      expect(JSON.stringify(SCRIPT.scenarios[id].sequence), id).toContain('"@readback-body"');
    }
  });

  it("references only vocabulary the readback family registers, with the declared case keys", () => {
    const refs = familyReferences(READBACK_SCRIPT);
    const vocabulary = engine.vocabulary();

    expect(refs.vars).toEqual([]);
    expect(refs.frames).toEqual([]);
    expect(refs.includes).toEqual(["readback-body"]);
    expect(refs.conds).toEqual([
      "readback.fastRepairQueued",
      "readback.fastRepairSkipped",
      "readback.fuelQueued",
      "readback.hasAnyService",
      "readback.isFirstEntry",
      "readback.limiterReminderDue",
      "readback.windshieldQueued",
    ]);
    expect(refs.cases).toEqual([{ name: "readback.tirePattern", keys: Object.keys(TIRE_PATTERN_KEYS).sort() }]);

    for (const cond of refs.conds) {
      expect(vocabulary.conds.map((c) => c.name)).toContain(cond);
    }

    for (const c of refs.cases) {
      const declared = vocabulary.cases.find((v) => v.name === c.name);

      expect(declared).toBeDefined();
      expect(Object.keys(declared?.keys ?? {}).sort()).toEqual([...c.keys].sort());
    }
  });

  it("addresses exactly the published clip sources — the slashed form throughout — and every one has a clip in the bundled voice", () => {
    // The literal is the published surface: a `(group, base)` a script
    // addresses is a rename in every pack's script and clip folder. Note
    // `windshield-off` is deliberately absent — the negative is never spoken
    // (open-wheel cars have no windshield and telemetry cannot tell).
    const sources = [
      "pit-readback/compound-dry",
      "pit-readback/compound-wet",
      "pit-readback/empty-fallback",
      "pit-readback/fast-repair-off",
      "pit-readback/fast-repair-on",
      "pit-readback/fuel-off",
      "pit-readback/fuel-on",
      "pit-readback/opener-entry",
      "pit-readback/opener-entry-limiter",
      "pit-readback/opener-exit",
      "pit-readback/tires-all",
      "pit-readback/tires-fronts",
      "pit-readback/tires-lefts",
      "pit-readback/tires-lf",
      "pit-readback/tires-lf-rr",
      "pit-readback/tires-lr",
      "pit-readback/tires-off",
      "pit-readback/tires-rears",
      "pit-readback/tires-rf",
      "pit-readback/tires-rf-lr",
      "pit-readback/tires-rights",
      "pit-readback/tires-rr",
      "pit-readback/tires-skip-lf",
      "pit-readback/tires-skip-lr",
      "pit-readback/tires-skip-rf",
      "pit-readback/tires-skip-rr",
      "pit-readback/windshield-on",
    ];

    expect([...familyReferences(READBACK_SCRIPT).pools].sort()).toEqual(sources);
    expect(PIT_READBACK_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort()).toEqual(sources);

    for (const { group, base } of PIT_READBACK_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `no voice/${BUNDLED_VOICE}/${group}/${base}(-NN).mp3 in manifest.json`,
      ).toBe(true);
    }
  });

  it("the fixture manifest carries every source for the test voice — the fires above are not vacuous", () => {
    for (const { group, base } of PIT_READBACK_CLIP_SOURCES) {
      const pattern = poolMemberPattern(group, base);

      expect(
        manifest.clips.some((clip) => pattern.exec(clip)?.[1] === VOICE),
        `${group}/${base}`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped — no unknown pool, condition, case key or fragment", () => {
    // A compile problem is ONE warn per (voice, scenario) naming the id.
    // Other families still validate their closure sequences against this
    // hand-built manifest, so only the readback's own diagnostics count.
    const readbackWarnings = mockLogger.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("pit-readback"));

    expect(readbackWarnings).toEqual([]);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("the fragment is inlined: entry and exit read the same body for the same snapshot, after their own openers", () => {
    const snapshot = snap({
      fuel: { queued: true },
      tires: { lf: true, rf: false, lr: true, rr: true },
      hasDamage: true,
      fastRepair: { queued: false, available: true },
      windshield: { queued: true, available: true },
      limiterEngaged: true,
    });

    fireReadback("entry", snapshot);
    const entryPaths = voicePaths().map((p) => p.split("/pit-readback/")[1]);

    audio._played.length = 0;
    fireReadback("exit", snapshot);
    const exitPaths = voicePaths().map((p) => p.split("/pit-readback/")[1]);

    const body = ["fuel-on.mp3", "tires-skip-rf.mp3", "fast-repair-off.mp3", "windshield-on.mp3"];

    expect(entryPaths).toEqual(["opener-entry.mp3", ...body]);
    expect(exitPaths).toEqual(["opener-exit.mp3", ...body]);
  });
});
