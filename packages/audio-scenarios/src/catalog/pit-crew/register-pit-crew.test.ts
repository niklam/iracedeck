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
import { type DamageCalloutId, type FlagCalloutId, type IncidentCalloutId, registerPitCrew } from "./index.js";
import { _resetRadarEngine } from "./radar-engine.js";

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
  "red-01",
  "black-01",
  "checkered-practice-01",
  "checkered-qualifying-01",
  "checkered-race-01",
  "debris-01",
  "debris-02",
  "debris-03",
  "meatball-01",
] as const;

// Acknowledgment pool clips referenced from `pools.ts` — must be present
// so toggle scenarios that reference `pool:pit-action-acknowledgment` and
// `pool:acknowledgment` pass validation at register time.
const ACK_POOL_CLIPS = [
  "voice/luca/acknowledgment/okay.mp3",
  "voice/luca/acknowledgment/got-it.mp3",
  "voice/luca/acknowledgment/roger-that.mp3",
  "voice/luca/acknowledgment/copy-that.mp3",
  "voice/luca/acknowledgment/we-got-that.mp3",
  "voice/luca/pit-actions/got-it.mp3",
  "voice/luca/pit-actions/roger-that.mp3",
  "voice/luca/pit-actions/copy-that.mp3",
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
// alternating lines per category × six categories.
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
let voiceMasterEnabled: boolean;

beforeEach(() => {
  enabled = makeEnabledMap(true);
  pitServiceRequestsEnabled = true;
  damageEnabled = new Map<DamageCalloutId, boolean>([["repair-needed", true]]);
  incidentEnabled = makeIncidentEnabledMap(true);
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
    () => voiceMasterEnabled,
  );
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
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
];

describe("registerPitCrew live gating", () => {
  it.each(FLAG_FIRES)("$id fires when enabled", ({ event, data, expectedClipFragment }) => {
    bus.publishEvent(event, data as never);
    flush(audio);

    const matched = voiceClipsPlayed().some((p) => p.includes(expectedClipFragment));
    expect(matched).toBe(true);
  });

  it.each(FLAG_FIRES)("$id is suppressed when its toggle is off", ({ id, event, data }) => {
    enabled.set(id, false);
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

// Issue #515: the Race Engineer master gate ANDs the user's
// `pitCrewRaceEngineerEnabled` toggle with whatever the plugin needs to
// gate (e.g. Pit Crew button presence in a future iteration). When the
// gate returns false, every voice scenario short-circuits at event
// arrival regardless of per-callout opt-ins (which all default `true`).
// This is the smoking-gun fix: prior to the master gate, flag / pit /
// damage callouts could fire on a fresh install with no Pit Crew button
// placed because dispatch only consulted per-callout flags.
describe("Race Engineer master gate (issue #515)", () => {
  it.each(FLAG_FIRES)("$id is suppressed when the master gate is off", ({ event, data }) => {
    voiceMasterEnabled = false;
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
