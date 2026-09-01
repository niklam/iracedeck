/**
 * Live-gating tests for `registerPitCrew(bus, getFlagCalloutEnabled)`.
 *
 * Issue #467 ships per-flag opt-in toggles persisted to plugin-global
 * settings. The plugins pass a closure into `registerPitCrew` that
 * reads the live setting cache, so the user's choice takes effect on
 * the very next event of that color — and crucially, never cuts a
 * callout that is already playing, because the gate runs at event
 * arrival (before `attemptFire`).
 *
 * These tests pin that behavior:
 *   - disabled flag → no fire
 *   - mid-clip toggle off → in-flight clip completes; next event suppressed
 *   - toggle back on → next event fires again
 *   - existing scope `where:` predicates still work for yellow-local /
 *     yellow-full when the flag is enabled
 *   - logger.debug is called on each suppressed event (debuggable
 *     "engineer didn't say green!" reports)
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { PitSvStatus } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, getScenarioEngine, initializeAudioScenarios } from "../../interpreter.js";
import { _setFurledRaisedSpoken } from "./flag-alerts.js";
import { _resetGapCalloutCooldown, _setLastGapEvent } from "./gaps.js";
import { _resetLastIncidentPoints } from "./incidents.js";
import {
  _resetOpponentPitPending,
  type DamageCalloutId,
  type FlagCalloutId,
  type FuelCalloutId,
  type IncidentCalloutId,
  NO_LIMITER_SCENARIO_IDS,
  type NoLimiterCalloutId,
  type OpponentPitCalloutId,
  PIT_LIMITER_SCENARIO_IDS,
  type PitLimiterCalloutId,
  type PitStatusCalloutId,
  type PitWindowCalloutId,
  registerPitCrew,
  type RollingStartCalloutId,
} from "./index.js";
import { NO_LIMITER_POOL_NAMES } from "./no-limiter.js";
import { LIMITER_MISSING_DELAY_MS, LIMITER_ON_TRACK_DELAY_MS, PIT_LIMITER_POOL_NAMES } from "./pit-limiter.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import { POOL_REGISTRY } from "./pools.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const mockSessionType = vi.fn(() => "Race");
// Live-telemetry feed. Most of this file leaves it at `null` — the pre-#1051
// default — but the two DELAYED pit-limiter scenarios re-read it at fire time
// instead of the event envelope, so their tests drive it. Reset per test in the
// top-level `beforeEach` (`vi.clearAllMocks()` clears calls, not implementations).
const mockLatestTelemetry = vi.fn((): unknown => null);

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
  getStandingStart: () => false,
  getLatestTelemetry: () => mockLatestTelemetry(),
  TrackDirection: { Neutral: "neutral", Left: "left", Right: "right" },
}));

// Race-formation + start-light scenarios gate on `isLiveOnTrack` (issue #480
// follow-up), so published events carry in-car telemetry by default.
const IN_CAR = { IsOnTrack: true, IsReplayPlaying: false };

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
  publishEvent: <T extends SimEventName>(name: T, data: SimEventMap[T]["data"], telemetry?: unknown) => void;
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
    publishEvent<T extends SimEventName>(name: T, data: SimEventMap[T]["data"], telemetry: unknown = IN_CAR) {
      this.publish({
        event: name,
        timestamp: Date.now(),
        telemetry,
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

const FLAG_CLIP_NAMES = [
  "yellow-local-01",
  "yellow-full-01",
  "yellow-cleared-01",
  "green-practice-01",
  "green-qualifying-01",
  "green-race-01",
  "green-race-02",
  "blue-01",
  "blue-02",
  "white-practice-01",
  "white-qualifying-01",
  "white-race-01",
  "white-race-02",
  "white-last-lap-01",
  "white-last-lap-02",
  "red-01",
  "black-01",
  "checkered-practice-01",
  "checkered-qualifying-01",
  "checkered-race-01",
  "debris-01",
  "debris-02",
  "debris-03",
  "meatball-01",
  // Issue #480 — missing-session-flag callouts.
  "disqualify-01",
  "furled-01",
  "furled-cleared-01",
  "dq-scoring-invalid-01",
  "crossed-01",
  "one-pace-lap-to-go-01",
  "one-pace-lap-to-go-02",
  "one-pace-lap-to-go-03",
  "one-pace-lap-to-go-04",
  "one-pace-lap-to-go-05",
  "green-held-01",
  "green-held-02",
  "green-held-03",
  "green-held-04",
  "green-held-05",
  "ten-to-go-01",
  "five-to-go-01",
  "yellow-waving-01",
  "caution-waving-01",
] as const;

// Acknowledgment pool clips referenced from `pools.ts` — must be present
// so toggle scenarios that reference `pool:pit-action-acknowledgment` and
// `pool:acknowledgment` pass validation at register time.
const ACK_POOL_CLIPS = [
  "voice/luca/acknowledgment/acknowledgment-01.mp3",
  "voice/luca/acknowledgment/acknowledgment-02.mp3",
  "voice/luca/acknowledgment/acknowledgment-03.mp3",
  "voice/luca/acknowledgment/acknowledgment-04.mp3",
  "voice/luca/acknowledgment/acknowledgment-05.mp3",
  "voice/luca/pit-actions/acknowledgment-01.mp3",
  "voice/luca/pit-actions/acknowledgment-02.mp3",
  "voice/luca/pit-actions/acknowledgment-03.mp3",
] as const;

// Toggle-confirmation clips referenced directly from
// `toggle-confirmations.ts`. Includes fuel/tire-set/compound and the
// issue-#468 additions (windshield, fast-repair) so all five scenario
// families register cleanly when `registerPitCrew(...)` runs.
const TOGGLE_CLIP_PATHS = [
  "voice/luca/pit-actions/fuel-on-01.mp3",
  "voice/luca/pit-actions/fuel-off-01.mp3",
  "voice/luca/pit-actions/tires-off-01.mp3",
  "voice/luca/pit-actions/tires-on-all.mp3",
  "voice/luca/pit-actions/tires-on-fronts.mp3",
  "voice/luca/pit-actions/tires-on-rears.mp3",
  "voice/luca/pit-actions/tires-on-lefts.mp3",
  "voice/luca/pit-actions/tires-on-rights.mp3",
  "voice/luca/pit-actions/tires-on-lf.mp3",
  "voice/luca/pit-actions/tires-on-rf.mp3",
  "voice/luca/pit-actions/tires-on-lr.mp3",
  "voice/luca/pit-actions/tires-on-rr.mp3",
  "voice/luca/pit-actions/tires-on-lf-rr.mp3",
  "voice/luca/pit-actions/tires-on-rf-lr.mp3",
  "voice/luca/pit-actions/tires-on-skip-lf.mp3",
  "voice/luca/pit-actions/tires-on-skip-rf.mp3",
  "voice/luca/pit-actions/tires-on-skip-lr.mp3",
  "voice/luca/pit-actions/tires-on-skip-rr.mp3",
  "voice/luca/pit-actions/tires-compound-dry.mp3",
  "voice/luca/pit-actions/tires-compound-wet.mp3",
  "voice/luca/pit-actions/windshield-on.mp3",
  "voice/luca/pit-actions/windshield-off.mp3",
  "voice/luca/pit-actions/fast-repair-on.mp3",
  "voice/luca/pit-actions/fast-repair-off.mp3",
] as const;

const DAMAGE_CLIP_PATHS = [
  `voice/${VOICE}/damage/repair-needed-01.mp3`,
  `voice/${VOICE}/damage/repair-needed-02.mp3`,
  `voice/${VOICE}/damage/repair-needed-03.mp3`,
] as const;

// Incident clips referenced from `incidents.ts` (issue #530). Three
// alternating lines per category × six categories, plus the point-count
// value clips the contact/collision count clause resolves via
// `pool:incidents/points-<delta>` (issue #922).
const INCIDENT_CLIP_PATHS = [
  `voice/${VOICE}/incidents/off-track-01.mp3`,
  `voice/${VOICE}/incidents/off-track-02.mp3`,
  `voice/${VOICE}/incidents/off-track-03.mp3`,
  `voice/${VOICE}/incidents/out-of-control-01.mp3`,
  `voice/${VOICE}/incidents/out-of-control-02.mp3`,
  `voice/${VOICE}/incidents/out-of-control-03.mp3`,
  `voice/${VOICE}/incidents/contact-world-01.mp3`,
  `voice/${VOICE}/incidents/contact-world-02.mp3`,
  `voice/${VOICE}/incidents/contact-world-03.mp3`,
  `voice/${VOICE}/incidents/collision-world-01.mp3`,
  `voice/${VOICE}/incidents/collision-world-02.mp3`,
  `voice/${VOICE}/incidents/collision-world-03.mp3`,
  `voice/${VOICE}/incidents/contact-car-01.mp3`,
  `voice/${VOICE}/incidents/contact-car-02.mp3`,
  `voice/${VOICE}/incidents/contact-car-03.mp3`,
  `voice/${VOICE}/incidents/collision-car-01.mp3`,
  `voice/${VOICE}/incidents/collision-car-02.mp3`,
  `voice/${VOICE}/incidents/collision-car-03.mp3`,
  `voice/${VOICE}/incidents/points-1.mp3`,
  `voice/${VOICE}/incidents/points-2.mp3`,
  `voice/${VOICE}/incidents/points-3.mp3`,
  `voice/${VOICE}/incidents/points-4.mp3`,
] as const;

// Pit-box count-in clips referenced from `pit-box.ts` (issue #600). One per
// distance mark.
const PIT_STATUS_CLIP_PATHS = [
  `voice/${VOICE}/pit-status/in-progress-01.mp3`,
  `voice/${VOICE}/pit-status/too-far-forward-01.mp3`,
  `voice/${VOICE}/pit-status/too-far-back-01.mp3`,
  // The #951 repeat nags — one variant each so pool draws stay deterministic.
  `voice/${VOICE}/pit-status/too-far-left-repeat-01.mp3`,
  `voice/${VOICE}/pit-status/too-far-right-repeat-01.mp3`,
  `voice/${VOICE}/pit-status/too-far-forward-repeat-01.mp3`,
  `voice/${VOICE}/pit-status/too-far-back-repeat-01.mp3`,
  `voice/${VOICE}/pit-status/bad-angle-repeat-01.mp3`,
];

const PIT_BOX_CLIP_PATHS = [
  `voice/${VOICE}/pit-box/five-01.mp3`,
  `voice/${VOICE}/pit-box/four-01.mp3`,
  `voice/${VOICE}/pit-box/three-01.mp3`,
  `voice/${VOICE}/pit-box/two-01.mp3`,
  `voice/${VOICE}/pit-box/one-01.mp3`,
  `voice/${VOICE}/pit-box/pit-now-01.mp3`,
] as const;

// Start-light clips referenced from `start-lights.ts` (issues #480 / #673).
// Two gantry lines (ready / go) plus the four countdown marks (90 added in
// #673; 15/5 dropped in #666).
const START_LIGHT_CLIP_PATHS = [
  `voice/${VOICE}/start-lights/start-ready-01.mp3`,
  `voice/${VOICE}/start-lights/start-go-01.mp3`,
  `voice/${VOICE}/start-lights/countdown-90-01.mp3`,
  `voice/${VOICE}/start-lights/countdown-60-01.mp3`,
  `voice/${VOICE}/start-lights/countdown-30-01.mp3`,
  `voice/${VOICE}/start-lights/countdown-10-01.mp3`,
] as const;

// Rolling-start clips referenced from `rolling-start.ts` (issue #660). Five
// random-pick variants of the "pace car is moving" line.
const ROLLING_START_CLIP_PATHS = [
  `voice/${VOICE}/rolling-start/pace-car-moving-01.mp3`,
  `voice/${VOICE}/rolling-start/pace-car-moving-02.mp3`,
  `voice/${VOICE}/rolling-start/pace-car-moving-03.mp3`,
  `voice/${VOICE}/rolling-start/pace-car-moving-04.mp3`,
  `voice/${VOICE}/rolling-start/pace-car-moving-05.mp3`,
] as const;

// Pit-window clips referenced from `pit-window.ts` (issue #655). Five opened +
// five closed variants.
const PIT_WINDOW_CLIP_PATHS = [
  `voice/${VOICE}/pit-window/opened-01.mp3`,
  `voice/${VOICE}/pit-window/opened-02.mp3`,
  `voice/${VOICE}/pit-window/opened-03.mp3`,
  `voice/${VOICE}/pit-window/opened-04.mp3`,
  `voice/${VOICE}/pit-window/opened-05.mp3`,
  `voice/${VOICE}/pit-window/closed-01.mp3`,
  `voice/${VOICE}/pit-window/closed-02.mp3`,
  `voice/${VOICE}/pit-window/closed-03.mp3`,
  `voice/${VOICE}/pit-window/closed-04.mp3`,
  `voice/${VOICE}/pit-window/closed-05.mp3`,
] as const;

// Opponent-pit clips referenced from `opponent-pit.ts` (issue #622), plus the
// shared position-number clip the nearby splice composes with.
const OPPONENT_PIT_CLIP_PATHS = [
  `voice/${VOICE}/opponent-pit/leader-01.mp3`,
  `voice/${VOICE}/opponent-pit/ahead-01.mp3`,
  `voice/${VOICE}/opponent-pit/behind-01.mp3`,
  `voice/${VOICE}/opponent-pit/car-in-01.mp3`,
  `voice/${VOICE}/opponent-pit/is-pitting-01.mp3`,
  `voice/${VOICE}/opponent-pit/others-01.mp3`,
  `voice/${VOICE}/position-number/4.mp3`,
] as const;

// Laps-of-fuel-left clips referenced from `fuel-laps-left.ts` (issue #838).
// One clip per spoken count 10 → 1 plus the count-0 box call, and the
// enough-fuel reassurance (issue #880).
const FUEL_LAPS_LEFT_CLIP_PATHS = [
  ...["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "box"].map(
    (subject) => `voice/${VOICE}/fuel/laps-left-${subject}-01.mp3`,
  ),
  `voice/${VOICE}/fuel/race-covered-01.mp3`,
] as const;

// Gap callout clips referenced from `gaps.ts` (issue #933): trend lines per
// side/direction, threshold alerts per side, and the readout intro. The
// spoken number reuses the lap-time clip groups (not fixtured here — the
// readout clause is optional and skips without them).
const GAP_CLIP_PATHS = [
  `voice/${VOICE}/gap/ahead-closing-01.mp3`,
  `voice/${VOICE}/gap/ahead-opening-01.mp3`,
  `voice/${VOICE}/gap/behind-closing-01.mp3`,
  `voice/${VOICE}/gap/behind-opening-01.mp3`,
  `voice/${VOICE}/gap/threshold-ahead-01.mp3`,
  `voice/${VOICE}/gap/threshold-behind-01.mp3`,
  `voice/${VOICE}/gap/readout-intro.mp3`,
] as const;

// Both limiter families' clips (issue #1051). They share the one `pit-limiter`
// manifest group — the split is by REMEDY, not by clip location — so family B's
// two bases sit alongside family A's four. One variant each: the assertions
// match on the pool's base prefix, so a second variant would only make draws
// non-deterministic for no gain.
//
// The `-01` suffix is load-bearing, not decoration. `buildManifestPool` matches
// `<base>(?:-\d{2})?\.mp3` — exactly TWO digits — so a clip generated on a
// three-digit convention lands in NO pool, and an empty pool skips its sequence
// step SILENTLY. That is the shipped-once bug these fixtures are shaped after;
// see the pool-resolution test below for what actually guards it.
const PIT_LIMITER_CLIP_PATHS = [
  `voice/${VOICE}/pit-limiter/on-track-01.mp3`,
  `voice/${VOICE}/pit-limiter/missing-01.mp3`,
  `voice/${VOICE}/pit-limiter/dropped-01.mp3`,
  `voice/${VOICE}/pit-limiter/speeding-01.mp3`,
  `voice/${VOICE}/pit-limiter/no-limiter-speeding-01.mp3`,
  `voice/${VOICE}/pit-limiter/entry-01.mp3`,
] as const;

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...FLAG_CLIP_NAMES.map((name) => `voice/${VOICE}/flags/${name}.mp3`),
    ...ACK_POOL_CLIPS,
    ...TOGGLE_CLIP_PATHS,
    ...DAMAGE_CLIP_PATHS,
    ...INCIDENT_CLIP_PATHS,
    ...PIT_STATUS_CLIP_PATHS,
    ...PIT_BOX_CLIP_PATHS,
    ...START_LIGHT_CLIP_PATHS,
    ...ROLLING_START_CLIP_PATHS,
    ...PIT_WINDOW_CLIP_PATHS,
    ...OPPONENT_PIT_CLIP_PATHS,
    ...FUEL_LAPS_LEFT_CLIP_PATHS,
    ...GAP_CLIP_PATHS,
    ...PIT_LIMITER_CLIP_PATHS,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

function flush(audio: FakeAudio, iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
  }
}

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;

const ALL_FLAG_IDS: readonly FlagCalloutId[] = [
  "yellow-local",
  "yellow-full",
  "yellow-cleared",
  "green",
  "blue",
  "white",
  "red",
  "black",
  "checkered",
  "debris",
  "meatball",
  // Issue #480 additions.
  "disqualify",
  "furled",
  "furled-cleared",
  "dq-scoring-invalid",
  "crossed",
  "one-pace-lap-to-go",
  "green-held",
  "ten-to-go",
  "five-to-go",
  "yellow-waving",
  "caution-waving",
];

function makeEnabledMap(initial: boolean): Map<FlagCalloutId, boolean> {
  return new Map<FlagCalloutId, boolean>(ALL_FLAG_IDS.map((id) => [id, initial]));
}

const ALL_INCIDENT_IDS: readonly IncidentCalloutId[] = [
  "off-track",
  "out-of-control",
  "contact-world",
  "collision-world",
  "contact-car",
  "collision-car",
];

function makeIncidentEnabledMap(initial: boolean): Map<IncidentCalloutId, boolean> {
  return new Map<IncidentCalloutId, boolean>(ALL_INCIDENT_IDS.map((id) => [id, initial]));
}

let enabled: Map<FlagCalloutId, boolean>;
let pitServiceRequestsEnabled: boolean;
let damageEnabled: Map<DamageCalloutId, boolean>;
let incidentEnabled: Map<IncidentCalloutId, boolean>;
let pitStatusEnabled: Map<PitStatusCalloutId, boolean>;
let pitBoxEnabled: boolean;
let pitWindowEnabled: Map<PitWindowCalloutId, boolean>;
let opponentPitEnabled: Map<OpponentPitCalloutId, boolean>;
let opponentPitLivePosition: number | null;
let rollingStartEnabled: Map<RollingStartCalloutId, boolean>;
let fuelEnabled: Map<FuelCalloutId, boolean>;
// Issue #1051. Two SEPARATE spies rather than one shared closure: the two
// getters sit in adjacent positional slots (49 and 50 of 52) and have the same
// `(id) => boolean` shape, so only "which spy saw which id" can tell a slot
// swap from correct wiring. See the slot test in the #1051 describe block.
let pitLimiterEnabled: Map<PitLimiterCalloutId, boolean>;
let noLimiterEnabled: Map<NoLimiterCalloutId, boolean>;
let getPitLimiterEnabled: (id: PitLimiterCalloutId) => boolean;
let getNoLimiterEnabled: (id: NoLimiterCalloutId) => boolean;
let voiceMasterEnabled: boolean;

beforeEach(() => {
  enabled = makeEnabledMap(true);
  pitServiceRequestsEnabled = true;
  damageEnabled = new Map<DamageCalloutId, boolean>([["repair-needed", true]]);
  incidentEnabled = makeIncidentEnabledMap(true);
  pitStatusEnabled = new Map<PitStatusCalloutId, boolean>();
  pitBoxEnabled = true;
  pitWindowEnabled = new Map<PitWindowCalloutId, boolean>([["pit-open-closed", true]]);
  opponentPitEnabled = new Map<OpponentPitCalloutId, boolean>([
    ["leader", true],
    ["nearby", true],
  ]);
  opponentPitLivePosition = 4;
  _resetOpponentPitPending();
  rollingStartEnabled = new Map<RollingStartCalloutId, boolean>([["pace-car", true]]);
  fuelEnabled = new Map<FuelCalloutId, boolean>();
  pitLimiterEnabled = new Map<PitLimiterCalloutId, boolean>();
  noLimiterEnabled = new Map<NoLimiterCalloutId, boolean>();
  getPitLimiterEnabled = vi.fn((id: PitLimiterCalloutId) => pitLimiterEnabled.get(id) ?? true);
  getNoLimiterEnabled = vi.fn((id: NoLimiterCalloutId) => noLimiterEnabled.get(id) ?? true);
  voiceMasterEnabled = true;
  mockSessionType.mockReturnValue("Race");
  mockLatestTelemetry.mockReturnValue(null);
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    getFlagCalloutEnabled: (id) => enabled.get(id) ?? true,
    logger: mockLogger as never,
    getPitReadbackEnabled: () => true,
    getPitActionsAllowed: () => true,
    getPitServiceRequestsEnabled: () => pitServiceRequestsEnabled,
    getReadbackSnapshot: () => null,
    getDamageCalloutEnabled: (id) => damageEnabled.get(id) ?? true,
    getPitStatusCalloutEnabled: (id) => pitStatusEnabled.get(id) ?? true,
    getIncidentCalloutEnabled: (id) => incidentEnabled.get(id) ?? true,
    getPitBoxCalloutEnabled: () => pitBoxEnabled,
    getPitWindowCalloutEnabled: (id) => pitWindowEnabled.get(id) ?? true,
    getRollingStartCalloutEnabled: (id) => rollingStartEnabled.get(id) ?? true,
    getStartLightCalloutEnabled: () => true,
    getFuelCalloutEnabled: (id) => fuelEnabled.get(id) ?? true,
    getOpponentPitCalloutEnabled: (id) => opponentPitEnabled.get(id) ?? true,
    getOpponentPitLivePosition: () => opponentPitLivePosition,
    getPitLimiterCalloutEnabled: getPitLimiterEnabled,
    getNoLimiterCalloutEnabled: getNoLimiterEnabled,
    getRaceEngineerMasterEnabled: () => voiceMasterEnabled,
  });
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  _setFurledRaisedSpoken(false);
  _resetLastIncidentPoints();
  vi.clearAllMocks();
});

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

const FLAG_FIRES: ReadonlyArray<{
  id: FlagCalloutId;
  event: SimEventName;
  data: SimEventMap[SimEventName]["data"];
  expectedClipFragment: string;
  /** Pre-publish setup a fire needs (e.g. furled-cleared's spoken marker). */
  arrange?: () => void;
}> = [
  {
    id: "yellow-local",
    event: "flag.yellow.raised",
    data: { scope: "local" } as SimEventMap["flag.yellow.raised"]["data"],
    expectedClipFragment: "yellow-local",
  },
  {
    id: "yellow-full",
    event: "flag.yellow.raised",
    data: { scope: "full" } as SimEventMap["flag.yellow.raised"]["data"],
    expectedClipFragment: "yellow-full",
  },
  {
    id: "yellow-cleared",
    event: "flag.yellow.cleared",
    data: {} as SimEventMap["flag.yellow.cleared"]["data"],
    expectedClipFragment: "yellow-cleared",
  },
  {
    id: "green",
    event: "flag.green.raised",
    data: {} as SimEventMap["flag.green.raised"]["data"],
    expectedClipFragment: "green-",
  },
  {
    id: "blue",
    event: "flag.blue.raised",
    data: {} as SimEventMap["flag.blue.raised"]["data"],
    expectedClipFragment: "blue-",
  },
  {
    id: "white",
    event: "flag.white.raised",
    data: {} as SimEventMap["flag.white.raised"]["data"],
    expectedClipFragment: "white-",
  },
  // Stage 2 of the two-stage white (issue #772) — a second scenario riding
  // the SAME "white" opt-in, so disabling the white callout silences both.
  {
    id: "white",
    event: "flag.white-last-lap.raised",
    data: {} as SimEventMap["flag.white-last-lap.raised"]["data"],
    expectedClipFragment: "white-last-lap-",
  },
  {
    id: "red",
    event: "flag.red.raised",
    data: {} as SimEventMap["flag.red.raised"]["data"],
    expectedClipFragment: "red-",
  },
  {
    id: "black",
    event: "flag.black.raised",
    data: {} as SimEventMap["flag.black.raised"]["data"],
    expectedClipFragment: "black-",
  },
  {
    id: "checkered",
    event: "flag.checkered.raised",
    data: {} as SimEventMap["flag.checkered.raised"]["data"],
    expectedClipFragment: "checkered-",
  },
  {
    id: "debris",
    event: "flag.debris.raised",
    data: {} as SimEventMap["flag.debris.raised"]["data"],
    expectedClipFragment: "debris-",
  },
  {
    id: "meatball",
    event: "flag.meatball.raised",
    data: {} as SimEventMap["flag.meatball.raised"]["data"],
    expectedClipFragment: "meatball-",
  },
  // Issue #480 additions — fire with the default in-car / Race / non-standing
  // setup (beforeEach), so the race-formation gates pass and each maps to its
  // own per-callout opt-in via SCENARIO_ID_TO_FLAG_ID.
  {
    id: "disqualify",
    event: "flag.disqualify.raised",
    data: {} as SimEventMap["flag.disqualify.raised"]["data"],
    expectedClipFragment: "disqualify-",
  },
  {
    id: "furled",
    event: "flag.furled.raised",
    data: {} as SimEventMap["flag.furled.raised"]["data"],
    expectedClipFragment: "furled-01",
  },
  {
    id: "furled-cleared",
    event: "flag.furled.cleared",
    data: {} as SimEventMap["flag.furled.cleared"]["data"],
    expectedClipFragment: "furled-cleared-",
    // The cleared `where:` gates on the raised line having actually been
    // spoken (issue #669) — seed the marker as if it had.
    arrange: () => _setFurledRaisedSpoken(true),
  },
  {
    id: "dq-scoring-invalid",
    event: "flag.dq-scoring-invalid.raised",
    data: {} as SimEventMap["flag.dq-scoring-invalid.raised"]["data"],
    expectedClipFragment: "dq-scoring-invalid-",
  },
  {
    id: "crossed",
    event: "flag.crossed.raised",
    data: {} as SimEventMap["flag.crossed.raised"]["data"],
    expectedClipFragment: "crossed-",
  },
  {
    id: "one-pace-lap-to-go",
    event: "flag.one-pace-lap-to-go.raised",
    data: {} as SimEventMap["flag.one-pace-lap-to-go.raised"]["data"],
    expectedClipFragment: "one-pace-lap-to-go-",
  },
  {
    id: "green-held",
    event: "flag.green-held.raised",
    data: {} as SimEventMap["flag.green-held.raised"]["data"],
    expectedClipFragment: "green-held-",
  },
  {
    id: "ten-to-go",
    event: "flag.ten-to-go.raised",
    data: {} as SimEventMap["flag.ten-to-go.raised"]["data"],
    expectedClipFragment: "ten-to-go-",
  },
  {
    id: "five-to-go",
    event: "flag.five-to-go.raised",
    data: {} as SimEventMap["flag.five-to-go.raised"]["data"],
    expectedClipFragment: "five-to-go-",
  },
  {
    id: "yellow-waving",
    event: "flag.yellow-waving.raised",
    data: {} as SimEventMap["flag.yellow-waving.raised"]["data"],
    expectedClipFragment: "yellow-waving-",
  },
  {
    id: "caution-waving",
    event: "flag.caution-waving.raised",
    data: {} as SimEventMap["flag.caution-waving.raised"]["data"],
    expectedClipFragment: "caution-waving-",
  },
];

describe("registerPitCrew live gating", () => {
  it.each(FLAG_FIRES)("$id fires when enabled", ({ event, data, expectedClipFragment, arrange }) => {
    arrange?.();
    bus.publishEvent(event, data as never);
    flush(audio);

    const matched = voiceClipsPlayed().some((p) => p.includes(expectedClipFragment));
    expect(matched).toBe(true);
  });

  it.each(FLAG_FIRES)("$id is suppressed when its toggle is off", ({ id, event, data, arrange }) => {
    enabled.set(id, false);
    arrange?.();
    bus.publishEvent(event, data as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line each time a flag is suppressed", () => {
    enabled.set("debris", false);
    bus.publishEvent("flag.debris.raised", {} as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("flag callout suppressed: debris");
  });

  it("toggling a flag off mid-clip does not cut the in-flight callout", () => {
    bus.publishEvent("flag.red.raised", {} as never);
    // Don't flush — red is still mid-playback (radio open + voice + radio close).
    const playsBeforeToggle = audio._played.length;
    expect(playsBeforeToggle).toBeGreaterThan(0);

    // User unchecks Red while it is playing.
    enabled.set("red", false);

    // Drain the in-flight sequence — gate fires only on event arrival,
    // so the already-fired sequence completes naturally.
    flush(audio);

    expect(voiceClipsPlayed()).toContain(`voice/${VOICE}/flags/red-01.mp3`);
  });

  it("toggling a flag off only blocks future fires; the previous one finishes", () => {
    // First red fires and is allowed to play.
    bus.publishEvent("flag.red.raised", {} as never);
    flush(audio);
    const playsAfterFirst = voiceClipsPlayed().length;
    expect(playsAfterFirst).toBe(1);

    // User disables red. A subsequent red event is gated.
    enabled.set("red", false);
    bus.publishEvent("flag.red.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed().length).toBe(playsAfterFirst);
  });

  it("re-enabling a flag restores future fires", () => {
    enabled.set("debris", false);
    bus.publishEvent("flag.debris.raised", {} as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    enabled.set("debris", true);
    bus.publishEvent("flag.debris.raised", {} as never);
    flush(audio);
    const played = voiceClipsPlayed();
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(new RegExp(`^voice/${VOICE}/flags/debris-0[123]\\.mp3$`));
  });

  it("yellow scope predicate still works when both yellow flags are enabled", () => {
    bus.publishEvent("flag.yellow.raised", { scope: "full" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/flags/yellow-full-01.mp3`]);
  });

  it("disabling yellow-local does not affect yellow-full", () => {
    enabled.set("yellow-local", false);
    bus.publishEvent("flag.yellow.raised", { scope: "full" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/flags/yellow-full-01.mp3`]);
  });

  it("disabling yellow-full does not affect yellow-local", () => {
    enabled.set("yellow-full", false);
    bus.publishEvent("flag.yellow.raised", { scope: "local" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([`voice/${VOICE}/flags/yellow-local-01.mp3`]);
  });

  it("disabling meatball means no preemption — an in-flight non-meatball flag survives", () => {
    bus.publishEvent("flag.yellow.cleared", {} as never);
    // Don't flush — yellow-cleared is mid-playback.
    enabled.set("meatball", false);
    bus.publishEvent("flag.meatball.raised", {} as never);
    flush(audio);

    // yellow-cleared completed; no meatball ever played.
    const played = voiceClipsPlayed();
    expect(played).toContain(`voice/${VOICE}/flags/yellow-cleared-01.mp3`);
    expect(played.some((p) => p.includes("meatball"))).toBe(false);
  });
});

describe("pit-service-requests live gate (issue #468)", () => {
  // The user opt-in toggle covers the whole pit-action family — fuel,
  // tire-set, compound, windshield, fast-repair. One closure gates all
  // five scenario sets in `registerPitCrew`. A representative event from
  // each family is enough to pin the wiring; per-scenario behavior is
  // covered by `toggle-confirmations.test.ts`.

  it.each([
    {
      family: "fuel",
      event: "pitService.toggled" as SimEventName,
      data: { service: "fuel", on: true },
      expectedClip: `voice/${VOICE}/pit-actions/fuel-on-01.mp3`,
    },
    {
      family: "tire-set",
      event: "tireService.changed" as SimEventName,
      data: { added: ["LF", "RF", "LR", "RR"], removed: [], current: ["LF", "RF", "LR", "RR"] },
      expectedClip: `voice/${VOICE}/pit-actions/tires-on-all.mp3`,
    },
    {
      family: "compound",
      event: "tireService.compoundChanged" as SimEventName,
      data: { from: 0, to: 1 },
      expectedClip: `voice/${VOICE}/pit-actions/tires-compound-wet.mp3`,
    },
    {
      family: "windshield",
      event: "pitService.toggled" as SimEventName,
      data: { service: "windshield", on: true },
      expectedClip: `voice/${VOICE}/pit-actions/windshield-on.mp3`,
    },
    {
      family: "fast-repair",
      event: "pitService.toggled" as SimEventName,
      data: { service: "fastRepair", on: true },
      expectedClip: `voice/${VOICE}/pit-actions/fast-repair-on.mp3`,
    },
  ])("$family fires when the gate is enabled", ({ event, data, expectedClip }) => {
    bus.publishEvent(event, data as never);
    flush(audio);

    expect(voiceClipsPlayed()).toContain(expectedClip);
  });

  it.each([
    {
      family: "fuel",
      event: "pitService.toggled" as SimEventName,
      data: { service: "fuel", on: true },
    },
    {
      family: "tire-set",
      event: "tireService.changed" as SimEventName,
      data: { added: ["LF", "RF", "LR", "RR"], removed: [], current: ["LF", "RF", "LR", "RR"] },
    },
    {
      family: "compound",
      event: "tireService.compoundChanged" as SimEventName,
      data: { from: 0, to: 1 },
    },
    {
      family: "windshield",
      event: "pitService.toggled" as SimEventName,
      data: { service: "windshield", on: true },
    },
    {
      family: "fast-repair",
      event: "pitService.toggled" as SimEventName,
      data: { service: "fastRepair", on: true },
    },
  ])("$family is suppressed when the gate is disabled", ({ event, data }) => {
    pitServiceRequestsEnabled = false;
    bus.publishEvent(event, data as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line each time a pit-service request is suppressed", () => {
    pitServiceRequestsEnabled = false;
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true } as never);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining("pit service request suppressed: pit-crew.toggle-fuel-on"),
    );
  });

  it("toggling the gate off mid-clip does not cut the in-flight callout", () => {
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true } as never);
    // Don't flush — fuel-on is still mid-playback (radio open + ack + voice + radio close).
    expect(audio._played.length).toBeGreaterThan(0);

    // User unchecks the gate while it is playing.
    pitServiceRequestsEnabled = false;

    // Drain the in-flight sequence — gate fires only on event arrival,
    // so the already-fired sequence completes naturally.
    flush(audio);

    expect(voiceClipsPlayed()).toContain(`voice/${VOICE}/pit-actions/fuel-on-01.mp3`);
  });

  it("re-enabling the gate restores future fires", () => {
    pitServiceRequestsEnabled = false;
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true } as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    pitServiceRequestsEnabled = true;
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toContain(`voice/${VOICE}/pit-actions/fuel-on-01.mp3`);
  });
});

// Issue #489: damage callout opt-in behaves identically to the flag callouts
// — gated at event arrival, suppression doesn't cut in-flight playback,
// re-enabling restores future fires.
describe("damage callout live gating (issue #489)", () => {
  it("fires when enabled", () => {
    bus.publishEvent("damage.repairNeeded.raised", {} as never);
    flush(audio);

    const matched = voiceClipsPlayed().some((p) => p.includes("/damage/repair-needed-"));
    expect(matched).toBe(true);
  });

  it("is suppressed when its toggle is off", () => {
    damageEnabled.set("repair-needed", false);
    bus.publishEvent("damage.repairNeeded.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line on suppression", () => {
    damageEnabled.set("repair-needed", false);
    bus.publishEvent("damage.repairNeeded.raised", {} as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("damage callout suppressed: repair-needed");
  });

  it("toggling off mid-clip does not cut the in-flight callout", () => {
    bus.publishEvent("damage.repairNeeded.raised", {} as never);
    expect(audio._played.length).toBeGreaterThan(0);

    damageEnabled.set("repair-needed", false);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/damage/repair-needed-"))).toBe(true);
  });

  it("re-enabling restores future fires", () => {
    damageEnabled.set("repair-needed", false);
    bus.publishEvent("damage.repairNeeded.raised", {} as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    damageEnabled.set("repair-needed", true);
    bus.publishEvent("damage.repairNeeded.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/damage/repair-needed-"))).toBe(true);
  });
});

describe("incident callout live gating (issue #530)", () => {
  it.each(ALL_INCIDENT_IDS)("%s fires when its toggle is enabled", (id) => {
    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: id } as never);
    flush(audio);

    const matched = voiceClipsPlayed().some((p) => p.includes(`/incidents/${id}-`));
    expect(matched).toBe(true);
  });

  it.each(ALL_INCIDENT_IDS)("%s is suppressed when its toggle is off", (id) => {
    incidentEnabled.set(id, false);
    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: id } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line on suppression", () => {
    incidentEnabled.set("collision-car", false);
    bus.publishEvent("incident.occurred", { delta: 4, points: 4, type: "collision-car" } as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("incident callout suppressed: collision-car");
  });

  it("disabling one category does not affect another (per-id isolation)", () => {
    incidentEnabled.set("out-of-control", false);
    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/incidents/off-track-"))).toBe(true);
  });

  it("toggling off mid-clip does not cut the in-flight callout", () => {
    bus.publishEvent("incident.occurred", { delta: 4, points: 4, type: "collision-car" } as never);
    expect(audio._played.length).toBeGreaterThan(0);

    incidentEnabled.set("collision-car", false);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/incidents/collision-car-"))).toBe(true);
  });

  it("re-enabling restores future fires", () => {
    incidentEnabled.set("off-track", false);
    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" } as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    incidentEnabled.set("off-track", true);
    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/incidents/off-track-"))).toBe(true);
  });

  // Issue #567: the qualifying lap-invalidation scenario is registered
  // BEFORE the incident scenarios in `index.ts`, so when both could fire on
  // a qualifying flying lap the qualifying scenario grabs the Voice bus and
  // the incident scenario drops. This test setup wires no qualifying-
  // invalidation snapshot resolver (default `() => null`), so the qualifying
  // scenario's `where:` short-circuits and the incident scenario fires
  // normally in every session type — confirming there's no spurious
  // suppression when the qualifying-invalidation snapshot isn't available.
  it.each(["Lone Qualify", "Open Qualify", "Race", "Practice", "Lone Practice", "Warmup", ""])(
    "incident callouts fire in %s sessions when the qualifying snapshot is null",
    (sessionType) => {
      mockSessionType.mockReturnValue(sessionType);
      audio._played.length = 0;
      bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" } as never);
      flush(audio);

      expect(voiceClipsPlayed().some((p) => p.includes("/incidents/off-track-"))).toBe(true);
    },
  );
});

// Issue #922 / #938: the spoken point count is composed from the event
// payload's `points` — the incident's value as the sim scores it (the
// discipline-resolved Sporting Code value of the classified type) — as a
// `pool:incidents/points-<points>` value clip appended after the
// type-flavored intro, never a type-assumed constant baked into the intro
// wording and never the raw count `delta`. A points value with no matching
// clip skips the count clause (issue #835 optional-group semantics) so the
// intro still plays with no number.
describe("incident point-count composition (issue #922)", () => {
  it("collision-car speaks the payload's points, not a type-assumed count", () => {
    // The dirt-track case from the issue: car collision awarded 2x, not 4x.
    bus.publishEvent("incident.occurred", { delta: 2, points: 2, type: "collision-car" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    const introIndex = clips.findIndex((p) => p.includes("/incidents/collision-car-"));
    expect(introIndex).toBeGreaterThanOrEqual(0);
    expect(clips).toContain(`voice/${VOICE}/incidents/points-2.mp3`);
    expect(clips).not.toContain(`voice/${VOICE}/incidents/points-4.mp3`);
    // Count clause follows the intro.
    expect(clips.indexOf(`voice/${VOICE}/incidents/points-2.mp3`)).toBeGreaterThan(introIndex);
  });

  it("collision-world speaks its detected count", () => {
    bus.publishEvent("incident.occurred", { delta: 2, points: 2, type: "collision-world" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/collision-world-"))).toBe(true);
    expect(clips).toContain(`voice/${VOICE}/incidents/points-2.mp3`);
  });

  it("collision-car with the full 4x award speaks four points", () => {
    bus.publishEvent("incident.occurred", { delta: 4, points: 4, type: "collision-car" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toContain(`voice/${VOICE}/incidents/points-4.mp3`);
  });

  it("speaks points, not delta, when an escalation's marginal differs (issue #938)", () => {
    // Off-track upgraded to a car collision: the count moved +3 (4 − 1) but
    // the incident is worth 4x — the engineer must say four, never three.
    bus.publishEvent("incident.occurred", { delta: 3, points: 4, type: "collision-car" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips).toContain(`voice/${VOICE}/incidents/points-4.mp3`);
    expect(clips).not.toContain(`voice/${VOICE}/incidents/points-3.mp3`);
  });

  it("contact-car with detected points speaks the count too", () => {
    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "contact-car" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/contact-car-"))).toBe(true);
    expect(clips).toContain(`voice/${VOICE}/incidents/points-1.mp3`);
  });

  it("speaks no count when the delta has no matching value clip", () => {
    bus.publishEvent("incident.occurred", { delta: 9, points: 9, type: "collision-car" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/collision-car-"))).toBe(true);
    expect(clips.some((p) => p.includes("/incidents/points-"))).toBe(false);
  });

  it("speaks no count for zero points (light contact)", () => {
    bus.publishEvent("incident.occurred", { delta: 0, points: 0, type: "contact-world" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/contact-world-"))).toBe(true);
    expect(clips.some((p) => p.includes("/incidents/points-"))).toBe(false);
  });

  it("off-track and out-of-control keep their no-count lines", () => {
    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: "off-track" } as never);
    flush(audio);
    bus.publishEvent("incident.occurred", { delta: 2, points: 2, type: "out-of-control" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/off-track-"))).toBe(true);
    expect(clips.some((p) => p.includes("/incidents/out-of-control-"))).toBe(true);
    expect(clips.some((p) => p.includes("/incidents/points-"))).toBe(false);
  });

  it("a later suppressed incident event does not corrupt a queued fire's count", () => {
    // An incident that arrives while a LOWER-weight line holds the Voice bus
    // waits in the pending slot with its expansion deferred to the drain —
    // the delta stash must not be rewritten by a later dispatch in which
    // nothing fires (here: the later event's own callout is toggled off), or
    // the queued fire would speak the later event's count.
    getScenarioEngine().defineScenario({
      id: "test.chatter",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.CHATTER,
      sequence: [`voice/${VOICE}/incidents/off-track-01.mp3`],
      when: { event: "offTrack.started" },
    });
    bus.publishEvent("offTrack.started", {} as never);

    // Queued behind the in-flight chatter (higher weight, no interrupt).
    bus.publishEvent("incident.occurred", { delta: 2, points: 2, type: "contact-car" } as never);

    // Later incident whose own callout is disabled — must not fire AND must
    // not disturb the queued contact-car fire's count.
    incidentEnabled.set("collision-car", false);
    bus.publishEvent("incident.occurred", { delta: 4, points: 4, type: "collision-car" } as never);

    // Chatter finishes → the pending contact-car fire drains and expands.
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/contact-car-"))).toBe(true);
    expect(clips).toContain(`voice/${VOICE}/incidents/points-2.mp3`);
    expect(clips).not.toContain(`voice/${VOICE}/incidents/points-4.mp3`);
  });
});

// Issue #600: the pit-box count-in opt-in is a single subject (`count-in`)
// gating all six per-mark scenarios. Same gate-at-event-arrival shape as the
// other families — suppression doesn't cut in-flight playback, re-enabling
// restores future fires.
describe("pit-box count-in live gating (issue #600)", () => {
  it.each(["five", "four", "three", "two", "one", "pit-now"] as const)("%s fires when enabled", (mark) => {
    bus.publishEvent("pitBox.countdown", { mark } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes(`/pit-box/${mark}-`))).toBe(true);
  });

  it("is suppressed when the toggle is off", () => {
    pitBoxEnabled = false;
    bus.publishEvent("pitBox.countdown", { mark: "three" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line on suppression", () => {
    pitBoxEnabled = false;
    bus.publishEvent("pitBox.countdown", { mark: "three" } as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("pit-box callout suppressed: count-in");
  });

  it("toggling off mid-clip does not cut the in-flight callout", () => {
    bus.publishEvent("pitBox.countdown", { mark: "five" } as never);
    expect(audio._played.length).toBeGreaterThan(0);

    pitBoxEnabled = false;
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/pit-box/five-"))).toBe(true);
  });

  it("re-enabling restores future fires", () => {
    pitBoxEnabled = false;
    bus.publishEvent("pitBox.countdown", { mark: "two" } as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    pitBoxEnabled = true;
    bus.publishEvent("pitBox.countdown", { mark: "two" } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/pit-box/two-"))).toBe(true);
  });

  it("is suppressed when the master gate is off", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("pitBox.countdown", { mark: "pit-now" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});

// Issue #479 / #951: the pit-status family — both the transition callouts and
// their repeat nags — is registered by `registerPitCrew` and wrapped by the
// master gate. These tests confirm that WIRING; the per-scenario behavior
// (weights, families, the speak-time validity gate) is covered in
// `pit-status.test.ts`. The repeats matter here because they are a second
// array threaded through the SAME wrapper: registering them outside
// `wrapWithMaster` / `wrapCalloutScenario` would be invisible to the family
// test, which registers scenarios on the engine directly.
describe("pit-status family registration (issue #479 / #951)", () => {
  const REPEAT = { status: PitSvStatus.TooFarForward } as const;

  // `wrapCalloutScenario` THROWS on a scenario id missing from
  // `SCENARIO_ID_TO_PIT_STATUS_ID`, so `registerPitCrew` succeeding in
  // `beforeEach` already proves every repeat id is mapped. This sweep proves
  // the stronger property: each one is mapped to the RIGHT subject, so its
  // sibling's checkbox actually silences it.
  it.each([
    ["too-far-left", PitSvStatus.TooFarLeft],
    ["too-far-right", PitSvStatus.TooFarRight],
    ["too-far-forward", PitSvStatus.TooFarForward],
    ["too-far-back", PitSvStatus.TooFarBack],
    ["bad-angle", PitSvStatus.BadAngle],
  ] as const)("the %s repeat is gated by its own subject's opt-in", (subject, status) => {
    bus.publishEvent("pitService.positioningRepeat", { status });
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes(`/pit-status/${subject}-repeat-`))).toBe(true);

    audio._played.length = 0;
    pitStatusEnabled.set(subject, false);
    bus.publishEvent("pitService.positioningRepeat", { status });
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("a transition callout fires through the real registration", () => {
    bus.publishEvent("pitService.statusChanged", { from: PitSvStatus.None, to: PitSvStatus.TooFarForward });
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/pit-status/too-far-forward-01"))).toBe(true);
  });

  it("a repeat nag fires through the real registration", () => {
    bus.publishEvent("pitService.positioningRepeat", REPEAT);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/pit-status/too-far-forward-repeat-"))).toBe(true);
  });

  it("the per-status opt-in suppresses the repeat as well as the transition call", () => {
    pitStatusEnabled.set("too-far-forward", false);

    bus.publishEvent("pitService.statusChanged", { from: PitSvStatus.None, to: PitSvStatus.TooFarForward });
    bus.publishEvent("pitService.positioningRepeat", REPEAT);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("disabling one status leaves another status's repeat firing", () => {
    pitStatusEnabled.set("too-far-forward", false);

    bus.publishEvent("pitService.positioningRepeat", REPEAT);
    bus.publishEvent("pitService.positioningRepeat", { status: PitSvStatus.TooFarBack });
    flush(audio);

    const played = voiceClipsPlayed();

    expect(played.some((p) => p.includes("/pit-status/too-far-forward-repeat-"))).toBe(false);
    expect(played.some((p) => p.includes("/pit-status/too-far-back-repeat-"))).toBe(true);
  });

  it("logs a debug line when a repeat is suppressed", () => {
    pitStatusEnabled.set("too-far-forward", false);
    bus.publishEvent("pitService.positioningRepeat", REPEAT);

    expect(mockLogger.debug).toHaveBeenCalledWith("pit-status callout suppressed: too-far-forward");
  });

  it("is suppressed when the master gate is off", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("pitService.positioningRepeat", REPEAT);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("toggling the status off mid-nag does not cut the in-flight clip", () => {
    bus.publishEvent("pitService.positioningRepeat", REPEAT);
    expect(audio._played.length).toBeGreaterThan(0);

    pitStatusEnabled.set("too-far-forward", false);
    // `_played` is append-only and `stopChannel` never removes from it, so a
    // clip-list assertion alone would pass even if the gate HAD cut the line.
    // `stopChannel(Voice)` is reachable only from `cancelActiveFire`, so its
    // absence is the precise observable for "nothing was cut".
    expect(audio.stopChannel).not.toHaveBeenCalledWith(AudioChannel.Voice);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/pit-status/too-far-forward-repeat-"))).toBe(true);
  });
});

// Issue #480: the start-light family is registered by `registerPitCrew` and
// wrapped by the master gate. These tests confirm the wiring is in place —
// per-callout / preemption behavior is covered in `start-lights.test.ts`.
describe("start-light family registration (issue #480)", () => {
  it.each([
    { event: "startLight.start-ready.raised", data: {}, fragment: "/start-lights/start-ready-" },
    { event: "startLight.start-go.raised", data: {}, fragment: "/start-lights/start-go-" },
    { event: "startLight.countdown.raised", data: { seconds: 90 }, fragment: "/start-lights/countdown-90-" },
    { event: "startLight.countdown.raised", data: { seconds: 30 }, fragment: "/start-lights/countdown-30-" },
  ])("$event fires its registered clip", ({ event, data, fragment }) => {
    bus.publishEvent(event as SimEventName, data as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes(fragment))).toBe(true);
  });

  it("is suppressed when the master gate is off", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("startLight.start-go.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});

// Issue #660: the rolling-start family is registered by `registerPitCrew` and
// wrapped by the master gate + the per-callout opt-in. These tests confirm the
// wiring — per-callout / structural behavior is covered in `rolling-start.test.ts`.
describe("rolling-start family registration (issue #660)", () => {
  it("fires its registered clip when the opt-in is on", () => {
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/rolling-start/pace-car-moving-"))).toBe(true);
  });

  it("is suppressed when the opt-in is off", () => {
    rollingStartEnabled.set("pace-car", false);
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("is suppressed when the master gate is off", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("rollingStart.pace-car-moving.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});

// Issue #655: the pit-window family is registered by `registerPitCrew` and
// wrapped by the master gate + the single per-callout opt-in (both directions
// share `pit-open-closed`). These tests confirm the wiring; the directional
// `where:` branch + diff gating are covered in `pit-window.test.ts` /
// `pits-open.test.ts`.
describe("pit-window family registration (issue #655)", () => {
  it.each([
    { to: true, fragment: "/pit-window/opened-" },
    { to: false, fragment: "/pit-window/closed-" },
  ])("fires the $fragment clip on to=$to when the opt-in is on", ({ to, fragment }) => {
    bus.publishEvent("pitsOpen.changed", { from: !to, to } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes(fragment))).toBe(true);
  });

  it.each([
    { from: false, to: true },
    { from: true, to: false },
  ])("is suppressed when the opt-in is off (from=$from to=$to)", ({ from, to }) => {
    pitWindowEnabled.set("pit-open-closed", false);
    bus.publishEvent("pitsOpen.changed", { from, to } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line on suppression", () => {
    pitWindowEnabled.set("pit-open-closed", false);
    bus.publishEvent("pitsOpen.changed", { from: false, to: true } as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("pit-window callout suppressed: pit-open-closed");
  });

  it("is suppressed when the master gate is off", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("pitsOpen.changed", { from: true, to: false } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});

// Issue #622: the opponent-pit family is registered by `registerPitCrew` and
// wrapped by the master gate + two per-subject opt-ins (leader / nearby, the
// latter covering ahead / behind / numbered / aggregate). These tests confirm
// the wiring; relation branching + diff gating are covered in
// `opponent-pit.test.ts` (audio) / `opponent-pit.test.ts` (sim-events).
describe("opponent-pit family registration (issue #622)", () => {
  it.each([
    { relation: "leader", fragment: "/opponent-pit/leader-" },
    { relation: "ahead", fragment: "/opponent-pit/ahead-" },
    { relation: "behind", fragment: "/opponent-pit/behind-" },
    { relation: "others", fragment: "/opponent-pit/others-" },
  ])("fires the $fragment clip on relation=$relation when the opt-in is on", ({ relation, fragment }) => {
    bus.publishEvent("opponentPit.entered", { relation, carIdx: 7, position: 4 } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes(fragment))).toBe(true);
  });

  it("composes the nearby line as car-in + speak-time number + is-pitting", () => {
    bus.publishEvent("opponentPit.entered", { relation: "nearby", carIdx: 7, position: 6 } as never);
    flush(audio);

    const played = voiceClipsPlayed();
    const carIn = played.findIndex((p) => p.includes("/opponent-pit/car-in-"));
    const number = played.findIndex((p) => p.includes("/position-number/4.mp3"));
    const isPitting = played.findIndex((p) => p.includes("/opponent-pit/is-pitting-"));

    // The number comes from the live resolver (position 4), not the
    // emit-time payload (position 6) — the speak-time freshness contract.
    expect(carIn).toBeGreaterThanOrEqual(0);
    expect(number).toBeGreaterThan(carIn);
    expect(isPitting).toBeGreaterThan(number);
  });

  it("falls back to the emit-time payload position when the live read fails", () => {
    opponentPitLivePosition = null;
    bus.publishEvent("opponentPit.entered", { relation: "nearby", carIdx: 7, position: 4 } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/position-number/4.mp3"))).toBe(true);
  });

  it("rejects a nearby event without a usable car or position", () => {
    bus.publishEvent("opponentPit.entered", { relation: "nearby" } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("nearby opt-in off suppresses the window lines but not the leader", () => {
    opponentPitEnabled.set("nearby", false);

    bus.publishEvent("opponentPit.entered", { relation: "ahead", carIdx: 7, position: 4 } as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    bus.publishEvent("opponentPit.entered", { relation: "leader", carIdx: 2, position: 1 } as never);
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/opponent-pit/leader-"))).toBe(true);
  });

  it("leader opt-in off suppresses only the leader line", () => {
    opponentPitEnabled.set("leader", false);

    bus.publishEvent("opponentPit.entered", { relation: "leader", carIdx: 2, position: 1 } as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    bus.publishEvent("opponentPit.entered", { relation: "behind", carIdx: 7, position: 5 } as never);
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("/opponent-pit/behind-"))).toBe(true);
  });

  it("is suppressed when the master gate is off", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("opponentPit.entered", { relation: "leader", carIdx: 2, position: 1 } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});

// Issue #838: the laps-of-fuel-left family is registered by `registerPitCrew`
// and wrapped by the master gate + one per-count opt-in. These tests confirm
// the wiring — the count math / dedup / refuel re-arm live in the translator
// diff and are covered in `sim-events-iracing`'s `fuel-laps-left.test.ts`.
describe("laps-of-fuel-left family registration (issue #838)", () => {
  it.each([
    { count: 5, fragment: "/fuel/laps-left-5-" },
    { count: 1, fragment: "/fuel/laps-left-1-" },
    { count: 0, fragment: "/fuel/laps-left-box-" },
  ])("fires the $fragment clip on count=$count when the opt-in is on", ({ count, fragment }) => {
    bus.publishEvent("fuel.lapsLeft.crossed", { count, lapsLeft: count + 0.4 } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes(fragment))).toBe(true);
  });

  it("only the matching count's scenario fires", () => {
    bus.publishEvent("fuel.lapsLeft.crossed", { count: 3, lapsLeft: 3.4 } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/fuel/laps-left-3-"))).toBe(true);
    expect(clips.filter((p) => p.includes("/fuel/laps-left-")).length).toBe(1);
  });

  it("is suppressed when that count's opt-in is off", () => {
    fuelEnabled.set("laps-left-box", false);
    bus.publishEvent("fuel.lapsLeft.crossed", { count: 0, lapsLeft: 0.2 } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
    expect(mockLogger.debug).toHaveBeenCalledWith("fuel callout suppressed: laps-left-box");
  });

  it("a disabled count does not gate a different count", () => {
    fuelEnabled.set("laps-left-4", false);
    bus.publishEvent("fuel.lapsLeft.crossed", { count: 3, lapsLeft: 3.4 } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/fuel/laps-left-3-"))).toBe(true);
  });

  it("is suppressed when the master gate is off", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("fuel.lapsLeft.crossed", { count: 0, lapsLeft: 0.2 } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("fires the enough-fuel reassurance on fuel.lapsLeft.raceCovered (issue #880)", () => {
    bus.publishEvent("fuel.lapsLeft.raceCovered", {} as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/fuel/race-covered-"))).toBe(true);
  });

  it("the reassurance is suppressed when its opt-in is off (issue #880)", () => {
    fuelEnabled.set("race-covered", false);
    bus.publishEvent("fuel.lapsLeft.raceCovered", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
    expect(mockLogger.debug).toHaveBeenCalledWith("fuel callout suppressed: race-covered");
  });

  it("the reassurance is suppressed when the master gate is off (issue #880)", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("fuel.lapsLeft.raceCovered", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });
});

// Issue #1051: two mirror families registered by `registerPitCrew`, each wrapped
// by the master gate + its own per-callout opt-in. They partition the field on
// equipment — family A speaks to cars that HAVE a pit limiter, family B to cars
// that have none — and the `where:` predicates that do the partitioning are
// covered exhaustively in `pit-limiter.test.ts` / `no-limiter.test.ts`. What is
// only observable HERE is the wiring: that the scenarios reach the engine at
// all, that the pools they name resolve to clips, and that each family's opt-in
// arrives in the right positional slot.
describe("pit-limiter / no-limiter family registration (issue #1051)", () => {
  // Two of family A's scenarios carry a `triggerDelay`, so every fire in this
  // block is walked through the clock by `fire()` below.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // `hasPitLimiter` tests for the PRESENCE of `dcPitSpeedLimiterToggle`, never
  // its value, so the equipped snapshot carries it as `false` — a disengaged
  // limiter, which is precisely when family A has something to say. `OnPitRoad`
  // is pinned false for the scenarios that read it.
  const HAS_LIMITER = { ...IN_CAR, dcPitSpeedLimiterToggle: false, OnPitRoad: false };
  const LACKS_LIMITER = { ...IN_CAR, OnPitRoad: false };

  // The live snapshots the two DELAYED scenarios re-read when their window
  // closes: each one is the state that scenario has something to say about.
  const STILL_ENGAGED_ON_TRACK = { ...IN_CAR, dcPitSpeedLimiterToggle: true, OnPitRoad: false };
  const STILL_MISSING_ON_PIT_ROAD = { ...IN_CAR, dcPitSpeedLimiterToggle: false, OnPitRoad: true };

  // ...and the two states a driver can reach by fixing the problem. The first is
  // one snapshot with two stories: for the on-track window it is the driver
  // reaching the button, for the missing window it is the car reaching the end
  // of pit road. Both are "equipped, limiter off, not on pit road".
  const LIMITER_OFF_ON_TRACK = { ...IN_CAR, dcPitSpeedLimiterToggle: false, OnPitRoad: false };
  const LIMITER_ENGAGED_ON_PIT_ROAD = { ...IN_CAR, dcPitSpeedLimiterToggle: true, OnPitRoad: true };

  type Fire = {
    id: string;
    pool: string;
    event: SimEventName;
    data: Record<string, unknown>;
    telemetry: Record<string, unknown>;
    /**
     * The snapshot `getLatestTelemetry()` serves. Present only on the two
     * delayed scenarios, which re-read live telemetry at fire time rather than
     * the envelope's; for the other six it is the same thing as `telemetry`.
     */
    live?: Record<string, unknown>;
    /** The scenario's `triggerDelay`, or absent for the immediate ones. */
    delayMs?: number;
  };

  const LIMITER_FIRES: readonly Fire[] = [
    {
      id: "pit-crew.limiter-on-track",
      pool: "pit-limiter-on-track",
      event: "pitLane.exited",
      data: {},
      telemetry: HAS_LIMITER,
      live: STILL_ENGAGED_ON_TRACK,
      delayMs: LIMITER_ON_TRACK_DELAY_MS,
    },
    {
      id: "pit-crew.limiter-missing",
      pool: "pit-limiter-missing",
      event: "limiter.missing",
      data: {},
      telemetry: HAS_LIMITER,
      live: STILL_MISSING_ON_PIT_ROAD,
      delayMs: LIMITER_MISSING_DELAY_MS,
    },
    {
      id: "pit-crew.limiter-dropped",
      pool: "pit-limiter-dropped",
      event: "limiter.dropped",
      data: {},
      telemetry: HAS_LIMITER,
    },
    {
      id: "pit-crew.limiter-speeding",
      pool: "pit-limiter-speeding",
      event: "limiter.speeding",
      data: {},
      telemetry: HAS_LIMITER,
    },
  ];

  const NO_LIMITER_FIRES: readonly Fire[] = [
    {
      id: "pit-crew.no-limiter-speeding",
      pool: "no-limiter-speeding",
      event: "limiter.speeding",
      data: {},
      telemetry: LACKS_LIMITER,
    },
    {
      id: "pit-crew.no-limiter-entry",
      pool: "no-limiter-entry",
      event: "pitLane.entered",
      data: {},
      telemetry: LACKS_LIMITER,
    },
  ];

  // Derived from the registry rather than written out, so a `(group, base)`
  // rename in `pools.ts` moves the expectation with it instead of going stale.
  function poolClipPrefix(pool: string): string {
    const source = POOL_REGISTRY[pool];

    if (!source) throw new Error(`POOL_REGISTRY has no entry for pool "${pool}"`);

    return `voice/${VOICE}/${source.group}/${source.base}`;
  }

  /** Whether any clip from `pool` reached the Voice channel. */
  function played(pool: string): boolean {
    return voiceClipsPlayed().some((p) => p.startsWith(poolClipPrefix(pool)));
  }

  function fireFor(id: string): Fire {
    const row = [...LIMITER_FIRES, ...NO_LIMITER_FIRES].find((f) => f.id === id);

    if (!row) throw new Error(`no fire row for scenario "${id}"`);

    return row;
  }

  // Publish, then walk the clock past the row's `triggerDelay` — nothing to
  // walk for the six immediate rows. The leading flush drains whatever fired on
  // the same event WITHOUT a delay (`pitLane.exited` also triggers the
  // higher-weight PIT_EXIT), so a delayed fire meets an idle bus instead of
  // losing a weight contest to a callout that is only still playing because the
  // test never let it finish.
  function fire({ event, data, telemetry, live, delayMs = 0 }: Fire): void {
    mockLatestTelemetry.mockReturnValue(live ?? telemetry);
    bus.publishEvent(event, data as never, telemetry);
    flush(audio);

    if (delayMs === 0) return;

    vi.advanceTimersByTime(delayMs);
    flush(audio);
  }

  it("the fire table covers exactly the scenario ids each family exports", () => {
    expect(LIMITER_FIRES.map((f) => f.id).sort()).toEqual([...PIT_LIMITER_SCENARIO_IDS].sort());
    expect(NO_LIMITER_FIRES.map((f) => f.id).sort()).toEqual([...NO_LIMITER_SCENARIO_IDS].sort());
  });

  // The pool names are pinned to an explicit list rather than re-derived by
  // prefix. Both constants are built as `Object.keys(POOL_REGISTRY).filter(
  // startsWith(...))`, so a registry rename that outruns the filter yields an
  // EMPTY array — which every `for (const name of ...)` sweep would pass
  // vacuously. Comparing against a literal is what makes that a failure.
  it("the exported pool-name constants still name the pools these scenarios draw from", () => {
    expect([...PIT_LIMITER_POOL_NAMES].sort()).toEqual(LIMITER_FIRES.map((f) => f.pool).sort());
    expect([...NO_LIMITER_POOL_NAMES].sort()).toEqual(NO_LIMITER_FIRES.map((f) => f.pool).sort());
  });

  it("every declared pool name has a registry entry in the shared pit-limiter group", () => {
    for (const name of [...PIT_LIMITER_POOL_NAMES, ...NO_LIMITER_POOL_NAMES]) {
      expect(POOL_REGISTRY[name], `POOL_REGISTRY has no entry for "${name}"`).toBeDefined();
      // One group for both families: the split is by remedy, not by location.
      expect(POOL_REGISTRY[name].group).toBe("pit-limiter");
      expect(POOL_REGISTRY[name].base.length).toBeGreaterThan(0);
    }
  });

  // THE assertion this block exists for. An empty pool does not throw and does
  // not log — the interpreter skips its sequence step in silence, so a callout
  // can be registered, enabled, unit-tested and still completely mute. This has
  // already happened twice on #1051 (clips generated on a three-digit suffix the
  // `-\d{2}` matcher rejects; a pool-name filter left keyed on a stale prefix
  // after a rename). Playing a clip whose path carries the pool's own
  // `(group, base)` is the only proof that the pool resolved to members, and it
  // goes through the real `buildManifestPool`, not a re-implementation of it.
  it.each([...LIMITER_FIRES, ...NO_LIMITER_FIRES])("$id draws a clip from a non-empty $pool pool", (row) => {
    fire(row);

    expect(played(row.pool)).toBe(true);
  });

  // `getPitLimiterCalloutEnabled` and `getNoLimiterCalloutEnabled` are
  // positional parameters 49 and 50 of 52, adjacent, both `(id) => boolean`, and
  // both defaulting to `() => true`. A parameter inserted above them shifts both
  // silently: nothing throws, no type changes, and every "it fires" test still
  // passes because the shifted-in getter also returns true. Only the id each spy
  // is handed distinguishes the two — their unions overlap on "speeding" but
  // family A alone owns "on-track"/"missing"/"dropped" and family B alone owns
  // "entry", so a swap shows up as the wrong spy seeing an id it has no member
  // for.
  it("consults the pit-limiter getter, and only it, for a family A scenario", () => {
    fire(fireFor("pit-crew.limiter-on-track"));

    expect(getPitLimiterEnabled).toHaveBeenCalledWith("on-track");
    expect(getNoLimiterEnabled).not.toHaveBeenCalled();
  });

  it("consults the no-limiter getter, and only it, for a family B scenario", () => {
    fire(fireFor("pit-crew.no-limiter-entry"));

    expect(getNoLimiterEnabled).toHaveBeenCalledWith("entry");
    expect(getPitLimiterEnabled).not.toHaveBeenCalled();
  });

  it.each(LIMITER_FIRES)("$id is suppressed when its own opt-in is off", (row) => {
    const calloutId = row.id.replace("pit-crew.limiter-", "") as PitLimiterCalloutId;
    pitLimiterEnabled.set(calloutId, false);

    fire(row);

    expect(played(row.pool)).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith(`pit-limiter callout suppressed: ${calloutId}`);
  });

  it.each(NO_LIMITER_FIRES)("$id is suppressed when its own opt-in is off", (row) => {
    const calloutId = row.id.replace("pit-crew.no-limiter-", "") as NoLimiterCalloutId;
    noLimiterEnabled.set(calloutId, false);

    fire(row);

    expect(played(row.pool)).toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith(`no-limiter callout suppressed: ${calloutId}`);
  });

  // The two families' ids collide on "speeding", and `limiter.speeding` is the
  // one event BOTH subscribe to. If a single opt-in map backed both getters,
  // silencing one family's speeding line would silence the other's — leaving the
  // driver who cannot press a button to fix it with nothing at all.
  it("silencing one family's speeding line leaves the other family's speaking", () => {
    pitLimiterEnabled.set("speeding", false);

    bus.publishEvent("limiter.speeding", {} as never, HAS_LIMITER);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    bus.publishEvent("limiter.speeding", {} as never, LACKS_LIMITER);
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.startsWith(poolClipPrefix("no-limiter-speeding")))).toBe(true);
  });

  it("a disabled callout in one family does not gate its sibling in the same family", () => {
    pitLimiterEnabled.set("missing", false);

    bus.publishEvent("limiter.dropped", {} as never, HAS_LIMITER);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.startsWith(poolClipPrefix("pit-limiter-dropped")))).toBe(true);
  });

  it.each([...LIMITER_FIRES, ...NO_LIMITER_FIRES])("$id is suppressed when the master gate is off", (row) => {
    voiceMasterEnabled = false;
    fire(row);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  // The two DELAYED scenarios, and the only place their delay is observable at
  // all. `triggerDelay` re-runs `where:` when the window closes but hands it the
  // ORIGINAL event envelope, whose telemetry was captured at publish time — so
  // both predicates read `getLatestTelemetry()` instead.
  //
  // DO NOT DELETE THE SILENCE TESTS AS REDUNDANT. They are the only tests in the
  // suite that can catch the realistic regression: a later "simplification" of
  // either predicate back to `e.telemetry`. Under that change the delay still
  // elapses and the callout still plays, so every test that merely asserts a
  // fire — including the positive cases these sit beside — stays green. Only a
  // test that MUTATES the live snapshot inside the window and then expects
  // nothing goes red. The positives are here for the opposite reason: so the
  // silence cannot be produced trivially by the scenario being broken outright.
  describe("the delayed re-check reads live telemetry, not the event's", () => {
    function publishThenSettle(
      event: SimEventName,
      atPublish: Record<string, unknown>,
      atFireTime: Record<string, unknown>,
      delayMs: number,
    ): void {
      mockLatestTelemetry.mockReturnValue(atPublish);
      bus.publishEvent(event, {} as never, atPublish);
      flush(audio);

      // Whatever the driver does, they do it INSIDE the window — before the
      // trigger timer expires and the predicate is re-run.
      mockLatestTelemetry.mockReturnValue(atFireTime);
      vi.advanceTimersByTime(delayMs);
      flush(audio);
    }

    it("limiter-on-track speaks when the limiter is still engaged as the window closes", () => {
      publishThenSettle("pitLane.exited", STILL_ENGAGED_ON_TRACK, STILL_ENGAGED_ON_TRACK, LIMITER_ON_TRACK_DELAY_MS);

      expect(played("pit-limiter-on-track")).toBe(true);
    });

    it("limiter-on-track stays silent when the driver switches the limiter off inside the window", () => {
      publishThenSettle("pitLane.exited", STILL_ENGAGED_ON_TRACK, LIMITER_OFF_ON_TRACK, LIMITER_ON_TRACK_DELAY_MS);

      expect(played("pit-limiter-on-track")).toBe(false);
    });

    it("limiter-missing speaks when the limiter is still not engaged as the window closes", () => {
      publishThenSettle(
        "limiter.missing",
        STILL_MISSING_ON_PIT_ROAD,
        STILL_MISSING_ON_PIT_ROAD,
        LIMITER_MISSING_DELAY_MS,
      );

      expect(played("pit-limiter-missing")).toBe(true);
    });

    it("limiter-missing stays silent when the driver engages the limiter inside the window", () => {
      publishThenSettle(
        "limiter.missing",
        STILL_MISSING_ON_PIT_ROAD,
        LIMITER_ENGAGED_ON_PIT_ROAD,
        LIMITER_MISSING_DELAY_MS,
      );

      expect(played("pit-limiter-missing")).toBe(false);
    });

    // The episode ended before the window did. A fire landing here would scold a
    // driver about pit road they are no longer on.
    it("limiter-missing stays silent when the car has left pit road inside the window", () => {
      publishThenSettle("limiter.missing", STILL_MISSING_ON_PIT_ROAD, LIMITER_OFF_ON_TRACK, LIMITER_MISSING_DELAY_MS);

      expect(played("pit-limiter-missing")).toBe(false);
    });
  });

  // The speak-time `if:` gate — the third distinct silence case in this feature
  // and the least obvious, because reaching it needs a busy bus AND a change
  // while the fire waits, so nothing arrives here by accident.
  //
  // `PIT_EXIT` fires on every `pitLane.exited` at the higher WEIGHT.SAFETY and
  // ungated, so when the limiter's window closes the bus is usually still busy
  // with a spoken line. `queueable: true` is what stops the callout being
  // dropped there — but queueing puts back the staleness the delay existed to
  // remove: the fire decision is taken when the timer elapses, the line can then
  // sit behind a longer call, and by the time it speaks the driver may have
  // fixed the limiter. The `if:` gate wrapping the WHOLE framed sequence is what
  // makes that expand to silence rather than a radio click with nothing after it.
  //
  // DO NOT DELETE THE SILENCE TESTS HERE. Remove the `if:` gate and `where:`,
  // `triggerDelay` and `queueable` all still work — the callout fires, queues and
  // plays, so every other test in this file stays green, including the two
  // silence tests above (they never let the bus get busy, so nothing queues).
  // Only a test that holds the bus, flips the live snapshot while the fire
  // waits, and then expects silence goes red. The positive counterparts are here
  // so the silence cannot instead be queueing broken outright.
  describe("the speak-time gate re-checks again when a queued fire drains", () => {
    // Stands in for PIT_EXIT: above the limiter callouts' NORMAL, with no
    // `interrupt`, so a limiter fire arriving mid-line takes the queue-or-drop
    // path rather than winning the bus — the same path real driving takes.
    // `offTrack.started` has no subscriber in the catalog, so this occupies the
    // Voice bus and does nothing else.
    const OCCUPIER_CLIP = `voice/${VOICE}/incidents/off-track-01.mp3`;

    function occupyVoiceBus(): void {
      getScenarioEngine().defineScenario({
        id: "test.bus-occupier",
        channel: AudioChannel.Voice,
        bus: AudioBus.Voice,
        weight: WEIGHT.SAFETY,
        sequence: [OCCUPIER_CLIP],
        when: { event: "offTrack.started" },
      });
      bus.publishEvent("offTrack.started", {} as never);
    }

    /**
     * Publish the trigger with the bus already busy, close the delay window so
     * the fire is QUEUED rather than played, then change the live snapshot
     * before letting the bus idle. By that point `where:` has already said yes,
     * so the only thing left that can stop the callout is the `if:` gate
     * re-running as the queued fire expands.
     */
    function queueThenDrain(
      event: SimEventName,
      atPublish: Record<string, unknown>,
      atDrain: Record<string, unknown>,
      delayMs: number,
    ): void {
      occupyVoiceBus();

      mockLatestTelemetry.mockReturnValue(atPublish);
      bus.publishEvent(event, {} as never, atPublish);

      // The window closes while the occupier still holds the bus: `where:`
      // passes and the fire lands in the pending slot instead of playing.
      vi.advanceTimersByTime(delayMs);

      // The driver fixes it while the line waits its turn.
      mockLatestTelemetry.mockReturnValue(atDrain);

      // Occupier finishes → the pending fire drains and expands NOW.
      flush(audio);
    }

    /**
     * Proof the fire actually took the QUEUE rather than the play-immediately
     * path, which is what puts the `if:` gate on the critical path at all.
     * Without this the block could quietly degrade into the previous block's
     * scenario — an idle bus, the gate evaluated at fire time — and still pass,
     * since the silence would then come from `where:` instead.
     */
    function expectQueuedThenDrained(id: string): void {
      expect(mockLogger.debug).toHaveBeenCalledWith(`Scenario "${id}" pending — deferred (bus busy)`);
      expect(mockLogger.debug).toHaveBeenCalledWith(`Replaying pending scenario "${id}"`);
    }

    it("limiter-on-track speaks, late, when the limiter is still engaged at the drain", () => {
      queueThenDrain("pitLane.exited", STILL_ENGAGED_ON_TRACK, STILL_ENGAGED_ON_TRACK, LIMITER_ON_TRACK_DELAY_MS);

      expectQueuedThenDrained("pit-crew.limiter-on-track");
      expect(voiceClipsPlayed()).toContain(OCCUPIER_CLIP);
      expect(played("pit-limiter-on-track")).toBe(true);
    });

    it("limiter-on-track stays silent when the driver switches the limiter off while it is queued", () => {
      queueThenDrain("pitLane.exited", STILL_ENGAGED_ON_TRACK, LIMITER_OFF_ON_TRACK, LIMITER_ON_TRACK_DELAY_MS);

      // The line that held the bus is unaffected — only the stale callout is
      // dropped, and it leaves no radio click behind either.
      expectQueuedThenDrained("pit-crew.limiter-on-track");
      expect(voiceClipsPlayed()).toContain(OCCUPIER_CLIP);
      expect(played("pit-limiter-on-track")).toBe(false);
    });

    it("limiter-missing speaks, late, when the limiter is still not engaged at the drain", () => {
      queueThenDrain("limiter.missing", STILL_MISSING_ON_PIT_ROAD, STILL_MISSING_ON_PIT_ROAD, LIMITER_MISSING_DELAY_MS);

      expectQueuedThenDrained("pit-crew.limiter-missing");
      expect(voiceClipsPlayed()).toContain(OCCUPIER_CLIP);
      expect(played("pit-limiter-missing")).toBe(true);
    });

    it("limiter-missing stays silent when the driver engages the limiter while it is queued", () => {
      queueThenDrain(
        "limiter.missing",
        STILL_MISSING_ON_PIT_ROAD,
        LIMITER_ENGAGED_ON_PIT_ROAD,
        LIMITER_MISSING_DELAY_MS,
      );

      expectQueuedThenDrained("pit-crew.limiter-missing");
      expect(voiceClipsPlayed()).toContain(OCCUPIER_CLIP);
      expect(played("pit-limiter-missing")).toBe(false);
    });
  });
});

// Issue #515: the Race Engineer master gate ANDs the user's
// `pitCrewRaceEngineerEnabled` toggle with whatever the plugin needs to
// gate (e.g. Pit Crew button presence in a future iteration). When the
// gate returns false, every voice scenario short-circuits at event
// arrival regardless of per-callout opt-ins (which all default `true`).
// This is the smoking-gun fix: prior to the master gate, flag / pit /
// damage callouts could fire on a fresh install with no Pit Crew button
// placed because dispatch only consulted per-callout flags.
describe("Race Engineer master gate (issue #515)", () => {
  it.each(FLAG_FIRES)("$id is suppressed when the master gate is off", ({ event, data, arrange }) => {
    voiceMasterEnabled = false;
    arrange?.();
    bus.publishEvent(event, data as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line each time a flag is suppressed by the master gate", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("flag.green.raised", {} as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("race engineer master gate suppressed: pit-crew.flag-green");
  });

  it("master gate off blocks pit-service request callouts (fuel)", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("pitService.toggled", { service: "fuel", on: true } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("master gate off blocks damage callouts", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("damage.repairNeeded.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it.each(ALL_INCIDENT_IDS)("master gate off blocks incident callouts (%s)", (id) => {
    voiceMasterEnabled = false;
    bus.publishEvent("incident.occurred", { delta: 1, points: 1, type: id } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("master gate off does not cut an in-flight callout", () => {
    bus.publishEvent("flag.red.raised", {} as never);
    expect(audio._played.length).toBeGreaterThan(0);

    voiceMasterEnabled = false;
    flush(audio);

    expect(voiceClipsPlayed()).toContain(`voice/${VOICE}/flags/red-01.mp3`);
  });

  it("master gate flipping back on restores future fires", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("flag.green.raised", {} as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    voiceMasterEnabled = true;
    bus.publishEvent("flag.green.raised", {} as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("green-"))).toBe(true);
  });

  it("master gate on with a single per-callout off keeps the family granularity working", () => {
    // Confirms the master gate is the OUTERMOST wrapper — when master is
    // on, the per-callout flag still has independent effect, so a user
    // who disables a single flag color still sees the others fire.
    voiceMasterEnabled = true;
    enabled.set("debris", false);

    bus.publishEvent("flag.debris.raised", {} as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    bus.publishEvent("flag.green.raised", {} as never);
    flush(audio);
    expect(voiceClipsPlayed().some((p) => p.includes("green-"))).toBe(true);
  });
});

describe("gap callouts fire end-to-end (issue #933)", () => {
  afterEach(() => {
    _resetGapCalloutCooldown();
    _setLastGapEvent(null);
    // The master-gate test in this block leaves the flag off; restore it so a
    // test added after this describe isn't silenced by the leftover state.
    voiceMasterEnabled = true;
  });

  it("plays the trend line on gap.trendChanged", () => {
    bus.publishEvent("gap.trendChanged", {
      side: "ahead",
      direction: "closing",
      gapSeconds: 1.8,
      ratePerLap: -0.8,
      lapsToContact: 2.3,
      carIdx: 3,
    });
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("gap/ahead-closing"))).toBe(true);
  });

  it("plays the threshold line on gap.thresholdCrossed", () => {
    bus.publishEvent("gap.thresholdCrossed", {
      side: "behind",
      gapSeconds: 0.9,
      thresholdSeconds: 1.0,
      carIdx: 5,
    });
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("gap/threshold-behind"))).toBe(true);
  });

  it("shares one cooldown across both gap scenarios", () => {
    bus.publishEvent("gap.trendChanged", {
      side: "behind",
      direction: "opening",
      gapSeconds: 7.0,
      ratePerLap: 1.6,
      carIdx: 5,
    });
    flush(audio);
    bus.publishEvent("gap.thresholdCrossed", { side: "ahead", gapSeconds: 0.9, thresholdSeconds: 1.0, carIdx: 3 });
    flush(audio);

    const gapClips = voiceClipsPlayed().filter((p) => p.includes("gap/"));

    expect(gapClips.some((p) => p.includes("gap/behind-opening"))).toBe(true);
    expect(gapClips.some((p) => p.includes("gap/threshold-ahead"))).toBe(false);
  });

  it("suppresses when the Race Engineer master is off", () => {
    voiceMasterEnabled = false;
    bus.publishEvent("gap.trendChanged", {
      side: "ahead",
      direction: "opening",
      gapSeconds: 3.0,
      ratePerLap: 1.0,
      carIdx: 3,
    });
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("gap/"))).toBe(false);
  });
});
