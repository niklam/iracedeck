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
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { _setFurledRaisedSpoken } from "./flag-alerts.js";
import { _resetLastIncidentDelta } from "./incidents.js";
import {
  type DamageCalloutId,
  type FlagCalloutId,
  type FuelCalloutId,
  type IncidentCalloutId,
  type PitWindowCalloutId,
  registerPitCrew,
  type RollingStartCalloutId,
} from "./index.js";
import { _resetRadarEngine } from "./radar-engine.js";
import { _resetSpotterEngine } from "./spotter-engine.js";

const mockSessionType = vi.fn(() => "Race");

vi.mock("@iracedeck/sim-events-iracing", () => ({
  getSessionType: () => mockSessionType(),
  getStandingStart: () => false,
  getLatestTelemetry: () => null,
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

// Laps-of-fuel-left clips referenced from `fuel-laps-left.ts` (issue #838).
// One clip per spoken count 10 → 1 plus the count-0 box call, and the
// enough-fuel reassurance (issue #880).
const FUEL_LAPS_LEFT_CLIP_PATHS = [
  ...["10", "9", "8", "7", "6", "5", "4", "3", "2", "1", "box"].map(
    (subject) => `voice/${VOICE}/fuel/laps-left-${subject}-01.mp3`,
  ),
  `voice/${VOICE}/fuel/race-covered-01.mp3`,
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
    ...PIT_BOX_CLIP_PATHS,
    ...START_LIGHT_CLIP_PATHS,
    ...ROLLING_START_CLIP_PATHS,
    ...PIT_WINDOW_CLIP_PATHS,
    ...FUEL_LAPS_LEFT_CLIP_PATHS,
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
let pitBoxEnabled: boolean;
let pitWindowEnabled: Map<PitWindowCalloutId, boolean>;
let rollingStartEnabled: Map<RollingStartCalloutId, boolean>;
let fuelEnabled: Map<FuelCalloutId, boolean>;
let voiceMasterEnabled: boolean;

beforeEach(() => {
  enabled = makeEnabledMap(true);
  pitServiceRequestsEnabled = true;
  damageEnabled = new Map<DamageCalloutId, boolean>([["repair-needed", true]]);
  incidentEnabled = makeIncidentEnabledMap(true);
  pitBoxEnabled = true;
  pitWindowEnabled = new Map<PitWindowCalloutId, boolean>([["pit-open-closed", true]]);
  rollingStartEnabled = new Map<RollingStartCalloutId, boolean>([["pace-car", true]]);
  fuelEnabled = new Map<FuelCalloutId, boolean>();
  voiceMasterEnabled = true;
  mockSessionType.mockReturnValue("Race");
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(
    bus,
    (id) => enabled.get(id) ?? true,
    mockLogger as never,
    () => true,
    () => true,
    () => pitServiceRequestsEnabled,
    () => null,
    (id) => damageEnabled.get(id) ?? true,
    undefined,
    undefined,
    (id) => incidentEnabled.get(id) ?? true,
    undefined, // getSessionStartCalloutEnabled
    undefined, // getSessionStartSnapshot
    undefined, // getLapTimeCalloutEnabled
    undefined, // getLapCompletedSnapshot
    undefined, // getPositionCalloutEnabled (issue #566)
    undefined, // getQualifyingInvalidationCalloutEnabled (issue #567)
    undefined, // getQualifyingInvalidationSnapshot (issue #567)
    undefined, // getRaceStatusCalloutEnabled (issue #569)
    undefined, // getRaceFinishedFired (issue #569)
    undefined, // getRaceEndCalloutEnabled (issue #569)
    undefined, // getRaceFinishedSnapshot (issue #569)
    undefined, // getRaceStartCalloutEnabled (issue #568)
    undefined, // getRaceStartSnapshot (issue #568)
    undefined, // getOvertakeCalloutEnabled (issue #574)
    undefined, // getOvertakeDriverName (issue #574)
    undefined, // getLivePosition (issue #574)
    undefined, // getOvertakeGate (issue #574)
    () => pitBoxEnabled, // getPitBoxCalloutEnabled (issue #600)
    undefined, // getSetupWarningMismatch (issue #625)
    undefined, // getSpotterCalloutEnabled (issue #651)
    undefined, // getSpotterTrackDirection (issue #651)
    undefined, // getSpotterStillThereIntervalMs (issue #651)
    undefined, // getSpotterNearestCarGapMeters (issue #651)
    (id) => pitWindowEnabled.get(id) ?? true, // getPitWindowCalloutEnabled (issue #655)
    (id) => rollingStartEnabled.get(id) ?? true, // getRollingStartCalloutEnabled (issue #660)
    () => true, // getStartLightCalloutEnabled (issue #480)
    (id) => fuelEnabled.get(id) ?? true, // getFuelCalloutEnabled (issue #838)
    undefined, // getCornerNameCalloutEnabled (issue #888)
    undefined, // getCornerNameSnapshot (issue #888)
    () => voiceMasterEnabled,
    undefined, // getRadarMasterEnabled
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _setFurledRaisedSpoken(false);
  _resetLastIncidentDelta();
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
    bus.publishEvent("incident.occurred", { delta: 1, type: id } as never);
    flush(audio);

    const matched = voiceClipsPlayed().some((p) => p.includes(`/incidents/${id}-`));
    expect(matched).toBe(true);
  });

  it.each(ALL_INCIDENT_IDS)("%s is suppressed when its toggle is off", (id) => {
    incidentEnabled.set(id, false);
    bus.publishEvent("incident.occurred", { delta: 1, type: id } as never);
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([]);
  });

  it("logs a debug line on suppression", () => {
    incidentEnabled.set("collision-car", false);
    bus.publishEvent("incident.occurred", { delta: 4, type: "collision-car" } as never);

    expect(mockLogger.debug).toHaveBeenCalledWith("incident callout suppressed: collision-car");
  });

  it("disabling one category does not affect another (per-id isolation)", () => {
    incidentEnabled.set("out-of-control", false);
    bus.publishEvent("incident.occurred", { delta: 1, type: "off-track" } as never);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/incidents/off-track-"))).toBe(true);
  });

  it("toggling off mid-clip does not cut the in-flight callout", () => {
    bus.publishEvent("incident.occurred", { delta: 4, type: "collision-car" } as never);
    expect(audio._played.length).toBeGreaterThan(0);

    incidentEnabled.set("collision-car", false);
    flush(audio);

    expect(voiceClipsPlayed().some((p) => p.includes("/incidents/collision-car-"))).toBe(true);
  });

  it("re-enabling restores future fires", () => {
    incidentEnabled.set("off-track", false);
    bus.publishEvent("incident.occurred", { delta: 1, type: "off-track" } as never);
    flush(audio);
    expect(voiceClipsPlayed()).toEqual([]);

    incidentEnabled.set("off-track", true);
    bus.publishEvent("incident.occurred", { delta: 1, type: "off-track" } as never);
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
      bus.publishEvent("incident.occurred", { delta: 1, type: "off-track" } as never);
      flush(audio);

      expect(voiceClipsPlayed().some((p) => p.includes("/incidents/off-track-"))).toBe(true);
    },
  );
});

// Issue #922: the spoken point count is composed from the event payload's
// `delta` (a `pool:incidents/points-<delta>` value clip appended after the
// type-flavored intro), never a type-assumed constant baked into the intro
// wording. A delta with no matching clip skips the count clause (issue #835
// optional-group semantics) so the intro still plays with no number.
describe("incident point-count composition (issue #922)", () => {
  it("collision-car speaks the detected delta, not a type-assumed count", () => {
    // The dirt-track case from the issue: car collision awarded 2x, not 4x.
    bus.publishEvent("incident.occurred", { delta: 2, type: "collision-car" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    const introIndex = clips.findIndex((p) => p.includes("/incidents/collision-car-"));
    expect(introIndex).toBeGreaterThanOrEqual(0);
    expect(clips).toContain(`voice/${VOICE}/incidents/points-2.mp3`);
    expect(clips).not.toContain(`voice/${VOICE}/incidents/points-4.mp3`);
    // Count clause follows the intro.
    expect(clips.indexOf(`voice/${VOICE}/incidents/points-2.mp3`)).toBeGreaterThan(introIndex);
  });

  it("collision-world speaks an accumulated burst delta", () => {
    // Multi-step crash: off-track 1x then collision-world upgrade → delta 3.
    bus.publishEvent("incident.occurred", { delta: 3, type: "collision-world" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/collision-world-"))).toBe(true);
    expect(clips).toContain(`voice/${VOICE}/incidents/points-3.mp3`);
  });

  it("contact-car with detected points speaks the count too", () => {
    bus.publishEvent("incident.occurred", { delta: 1, type: "contact-car" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/contact-car-"))).toBe(true);
    expect(clips).toContain(`voice/${VOICE}/incidents/points-1.mp3`);
  });

  it("speaks no count when the delta has no matching value clip", () => {
    bus.publishEvent("incident.occurred", { delta: 9, type: "collision-car" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/collision-car-"))).toBe(true);
    expect(clips.some((p) => p.includes("/incidents/points-"))).toBe(false);
  });

  it("speaks no count for a zero delta (harness-style light contact)", () => {
    bus.publishEvent("incident.occurred", { delta: 0, type: "contact-world" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/contact-world-"))).toBe(true);
    expect(clips.some((p) => p.includes("/incidents/points-"))).toBe(false);
  });

  it("off-track and out-of-control keep their no-count lines", () => {
    bus.publishEvent("incident.occurred", { delta: 1, type: "off-track" } as never);
    flush(audio);
    bus.publishEvent("incident.occurred", { delta: 2, type: "out-of-control" } as never);
    flush(audio);

    const clips = voiceClipsPlayed();
    expect(clips.some((p) => p.includes("/incidents/off-track-"))).toBe(true);
    expect(clips.some((p) => p.includes("/incidents/out-of-control-"))).toBe(true);
    expect(clips.some((p) => p.includes("/incidents/points-"))).toBe(false);
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
    bus.publishEvent("incident.occurred", { delta: 1, type: id } as never);
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
