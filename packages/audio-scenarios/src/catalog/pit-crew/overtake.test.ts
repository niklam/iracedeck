/**
 * Race Engineer overtake callouts — scenario-engine integration tests (issue
 * #574, split design). Each overtake produces a reaction (immediate) plus a
 * separate `WEIGHT.CHATTER` + `queueable: true` position readout that defers
 * behind the reaction and speaks "We're currently P[n]" from LIVE telemetry,
 * gated by a shared cooldown and suppressed after the race ends.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioChannel } from "@iracedeck/audio-service";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioAssetsManifest } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "../../interpreter.js";
import { _resetPositionReadoutCooldown, registerPitCrew } from "./index.js";
import { overtakeGainIsAnnounceable, overtakeLossIsAnnounceable } from "./overtake.js";
import { _resetPitSpeedingEngine } from "./pit-speeding-engine.js";
import {
  _setReactionRandom,
  canAnnouncePosition,
  POSITION_READOUT_COOLDOWN_MS,
  tryClaimPositionAnnouncement,
} from "./position-readout.js";
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

const OVERTAKE_CLIPS = [
  `voice/${VOICE}/position-overtake/nice-pass-01.mp3`,
  `voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`,
  `voice/${VOICE}/position-overtake/nice-pass-leader-class-01.mp3`,
  `voice/${VOICE}/position-overtake/nice-pass-p2-01.mp3`,
  `voice/${VOICE}/position-overtake/nice-pass-p2-class-01.mp3`,
  `voice/${VOICE}/position-overtake/nice-pass-p3-01.mp3`,
  `voice/${VOICE}/position-overtake/nice-pass-p3-class-01.mp3`,
  `voice/${VOICE}/position-overtake/dont-give-up-positions-01.mp3`,
  `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
  `voice/${VOICE}/position-overtake-come-on/niklas.mp3`,
  `voice/${VOICE}/position-overtake-come-on/driver.mp3`,
  ...Array.from({ length: 64 }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
];

const manifest: AudioAssetsManifest = {
  clips: ["sfx/IRD-tick-open.mp3", "sfx/IRD-tick-close.mp3", "sfx/IRD-ambient-pit.mp3", ...OVERTAKE_CLIPS],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

type GainedSnap = SimEventOf<"overtake.completed">["data"];
type LostSnap = SimEventOf<"overtake.lost">["data"];
type Live = { position: number; classPosition: number; isMultiClass: boolean };

type Gate = {
  carsAlongside: boolean;
  onTrack: boolean;
  speedKmh: number;
  onPitRoad: boolean;
  msSinceIncident: number | null;
};

const CLEAR_GATE: Gate = {
  carsAlongside: false,
  onTrack: true,
  speedKmh: 200,
  onPitRoad: false,
  msSinceIncident: null,
};

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let currentDriverName: string | null;
let currentLive: Live | null;
let currentGate: Gate | null;
let raceFinished: boolean;
let overtakeEnabled: Record<"gained" | "lost", boolean>;

function voicePaths(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

function fireGained(snapshot: Partial<GainedSnap>): void {
  bus.publishEvent("overtake.completed", {
    carIdx: 0,
    sustained: 3000,
    position: 5,
    previousPosition: 6,
    isLeader: false,
    ...snapshot,
  } as GainedSnap);
  flush(audio);
}

function fireLost(snapshot: Partial<LostSnap>): void {
  bus.publishEvent("overtake.lost", {
    carIdx: 0,
    sustained: 3000,
    position: 5,
    previousPosition: 4,
    ...snapshot,
  } as LostSnap);
  flush(audio);
}

beforeEach(() => {
  currentDriverName = "niklas";
  currentLive = { position: 5, classPosition: 5, isMultiClass: false };
  currentGate = { ...CLEAR_GATE };
  raceFinished = false;
  overtakeEnabled = { gained: true, lost: true };
  _resetPositionReadoutCooldown();
  // Make the ~1/3 reaction gate (#603) deterministic: roll 0 → always react, so
  // every non-podium reaction fires unless a test overrides it. Podium positions
  // react regardless of the roll.
  _setReactionRandom(() => 0);
  bus = createMockBus();
  audio = createFakeAudio();
  initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
  registerPitCrew(bus, {
    logger: mockLogger as never,
    getRaceFinishedFired: () => raceFinished,
    getOvertakeCalloutEnabled: (id) => overtakeEnabled[id],
    getOvertakeDriverName: () => currentDriverName,
    getLivePosition: () => currentLive,
    getOvertakeGate: () => currentGate,
  });
});

afterEach(() => {
  _resetAudioScenarios();
  _resetRadarEngine();
  _resetSpotterEngine();
  _resetPitSpeedingEngine();
  _resetPositionReadoutCooldown();
  vi.clearAllMocks();
});

describe("overtakeGainIsAnnounceable / overtakeLossIsAnnounceable", () => {
  it("accepts an in-range overall position", () => {
    expect(
      overtakeGainIsAnnounceable({
        position: 5,
        previousPosition: 6,
        isLeader: false,
        carIdx: 0,
        sustained: 3000,
      } as GainedSnap),
    ).toBe(true);
    expect(
      overtakeLossIsAnnounceable({ position: 5, previousPosition: 4, carIdx: 0, sustained: 3000 } as LostSnap),
    ).toBe(true);
  });

  it("accepts any known position — speakability derives from the clips at expansion time (issue #836)", () => {
    expect(
      overtakeGainIsAnnounceable({
        position: 100,
        previousPosition: 101,
        isLeader: false,
        carIdx: 0,
        sustained: 3000,
      } as GainedSnap),
    ).toBe(true);
  });

  it("uses class position when multi-class", () => {
    expect(
      overtakeGainIsAnnounceable({
        position: 50,
        classPosition: 3,
        previousPosition: 51,
        isMultiClass: true,
        isLeader: false,
        carIdx: 0,
        sustained: 3000,
      } as GainedSnap),
    ).toBe(true);
  });
});

describe("position-readout cooldown helper", () => {
  beforeEach(() => _resetPositionReadoutCooldown());

  // Use a realistic (non-zero) clock — `0` is the "never announced" sentinel.
  const T0 = 1_000_000;

  it("allows the first announcement, then suppresses within the window", () => {
    expect(canAnnouncePosition(T0)).toBe(true);
    expect(tryClaimPositionAnnouncement(T0)).toBe(true);
    expect(tryClaimPositionAnnouncement(T0 + 1000)).toBe(false);
    expect(tryClaimPositionAnnouncement(T0 + POSITION_READOUT_COOLDOWN_MS - 1)).toBe(false);
  });

  it("allows again once the cooldown elapses", () => {
    expect(tryClaimPositionAnnouncement(T0)).toBe(true);
    expect(tryClaimPositionAnnouncement(T0 + POSITION_READOUT_COOLDOWN_MS)).toBe(true);
  });
});

describe("overtake reaction (immediate)", () => {
  it("gained non-leader plays only 'Nice pass.' (no position in the reaction)", () => {
    fireGained({ isLeader: false });

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`);
  });

  it("gained leader plays the standalone leader line", () => {
    fireGained({ position: 1, previousPosition: 2, isLeader: true });

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
  });

  it("gained CLASS leader in multi-class plays the leading-our-class line, not the race-leader line (#599)", () => {
    fireGained({
      position: 8, // overall — not the race leader
      classPosition: 1, // class leader
      previousPosition: 9,
      previousClassPosition: 2,
      isMultiClass: true,
      isLeader: false, // overall P1 only
    });

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-class-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
  });

  it("gained overall+class leader in multi-class still speaks the class-leader line (focus on class, #599)", () => {
    // Leading the race overall in a multi-class field also means class P1; the
    // class-focused wording wins.
    fireGained({
      position: 1,
      classPosition: 1,
      previousPosition: 2,
      previousClassPosition: 2,
      isMultiClass: true,
      isLeader: true,
    });

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-class-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`);
  });

  it("lost plays the per-name come-on clip + dont-give-up (no number)", () => {
    fireLost({});

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake-come-on/niklas.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-overtake/dont-give-up-positions-01.mp3`);
    // The old generic "Come on," clip is no longer part of the line (#591).
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/come-on-01.mp3`);
  });

  it("lost falls back to the 'driver' come-on clip", () => {
    currentDriverName = "driver";
    fireLost({});

    expect(voicePaths()).toContain(`voice/${VOICE}/position-overtake-come-on/driver.mp3`);
  });

  it("lost skips the come-on clause when the voice lacks the name clip, still playing dont-give-up (issue #835)", () => {
    currentDriverName = "ghost";
    fireLost({});

    expect(voicePaths().some((p) => p.includes("position-overtake-come-on"))).toBe(false);
    expect(voicePaths()).toContain(`voice/${VOICE}/position-overtake/dont-give-up-positions-01.mp3`);
  });

  it("lost skips the come-on clause when no name resolver is wired, still playing dont-give-up (issue #835)", () => {
    currentDriverName = null;
    fireLost({});

    expect(voicePaths().some((p) => p.includes("position-overtake-come-on"))).toBe(false);
    expect(voicePaths()).toContain(`voice/${VOICE}/position-overtake/dont-give-up-positions-01.mp3`);
  });

  it("does not fire the gained reaction when its opt-in is off", () => {
    overtakeEnabled.gained = false;
    fireGained({});

    expect(voicePaths().some((p) => p.includes("nice-pass"))).toBe(false);
  });

  it("does not fire after the race has finished", () => {
    raceFinished = true;
    fireGained({});
    fireLost({});

    expect(voicePaths()).toEqual([]);
  });
});

describe("overtake position readout (live, deferred)", () => {
  it("gained non-leader follows the reaction with the LIVE position", () => {
    // Event says P5, but live telemetry says P3 at speak-time → speaks P3.
    currentLive = { position: 3, classPosition: 3, isMultiClass: false };
    fireGained({ position: 5, previousPosition: 6, isLeader: false });

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-number/3.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-number/5.mp3`);
  });

  it("gained LEADER gets no position readout (reaction is self-contained)", () => {
    currentLive = { position: 1, classPosition: 1, isMultiClass: false };
    fireGained({ position: 1, previousPosition: 2, isLeader: true });

    expect(voicePaths()).not.toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });

  it("gained CLASS leader in multi-class gets no position readout (class-leader reaction states the position, #599)", () => {
    currentLive = { position: 8, classPosition: 1, isMultiClass: true };
    fireGained({
      position: 8,
      classPosition: 1,
      previousPosition: 9,
      previousClassPosition: 2,
      isMultiClass: true,
      isLeader: false,
    });

    expect(voicePaths()).not.toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });

  it("lost follows the reaction with the LIVE position", () => {
    currentLive = { position: 6, classPosition: 6, isMultiClass: false };
    fireLost({ position: 5, previousPosition: 4 });

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-number/6.mp3`);
  });

  it("reads the live CLASS position in multi-class", () => {
    currentLive = { position: 12, classPosition: 2, isMultiClass: true };
    fireGained({ position: 12, previousPosition: 13, isLeader: false });

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-number/2.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-number/12.mp3`);
  });

  it("defers the position readout to a recent announcement (never doubles the position, #651)", () => {
    fireGained({});
    expect(voicePaths()).toContain(`voice/${VOICE}/position-number/5.mp3`);

    audio._played.length = 0;
    // A second overtake within the shared position cooldown no longer re-announces
    // the position — it would otherwise be spoken twice (e.g. a lap-completed
    // readout followed by an overtake, possibly delayed by the spotter focus
    // floor). The reaction catchphrase is a separate scenario and still plays.
    fireLost({});
    const played = voicePaths();
    expect(played).not.toContain(`voice/${VOICE}/position-number/5.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });

  it("marks the shared position cooldown so lap/race-status readouts defer", () => {
    expect(canAnnouncePosition()).toBe(true);
    fireGained({});
    expect(canAnnouncePosition()).toBe(false);
  });

  it("no readout after the race has finished", () => {
    raceFinished = true;
    fireGained({});

    expect(voicePaths()).toEqual([]);
  });

  it("no readout when live position is unreadable", () => {
    currentLive = null;
    fireGained({});

    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });
});

describe("reaction gate (random ~1/3, podium-exempt) (#603)", () => {
  it("non-podium gain reacts when the roll is under the chance, and reads the position", () => {
    _setReactionRandom(() => 0);
    fireGained({ position: 5, previousPosition: 6 });
    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });

  it("non-podium gain skips the catchphrase when the roll is over the chance, but still reads the position", () => {
    _setReactionRandom(() => 0.99);
    fireGained({ position: 5, previousPosition: 6 });
    const played = voicePaths();
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });

  it("non-podium loss skips the catchphrase when the roll is over the chance, but still reads the position", () => {
    _setReactionRandom(() => 0.99);
    currentLive = { position: 5, classPosition: 5, isMultiClass: false };
    fireLost({ position: 5, previousPosition: 4 });
    const played = voicePaths();
    expect(played).not.toContain(`voice/${VOICE}/position-overtake-come-on/niklas.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });

  it("podium gain (P2) always reacts even when the roll is over the chance", () => {
    _setReactionRandom(() => 0.99);
    currentLive = { position: 2, classPosition: 2, isMultiClass: false };
    fireGained({ position: 2, previousPosition: 3 });
    expect(voicePaths()).toContain(`voice/${VOICE}/position-overtake/nice-pass-p2-01.mp3`);
  });

  it("the leader line always reacts (podium-exempt)", () => {
    _setReactionRandom(() => 0.99);
    currentLive = { position: 1, classPosition: 1, isMultiClass: false };
    fireGained({ position: 1, previousPosition: 2, isLeader: true });
    expect(voicePaths()).toContain(`voice/${VOICE}/position-overtake/nice-pass-leader-01.mp3`);
  });
});

describe("podium reaction lines (#603)", () => {
  it("gained P2 plays the dedicated second-place line and suppresses the follow-up readout", () => {
    currentLive = { position: 2, classPosition: 2, isMultiClass: false };
    fireGained({ position: 2, previousPosition: 3 });
    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-p2-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
    // The dedicated line states the position, so no "We're currently P[n]".
    expect(played).not.toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });

  it("gained P2 in multi-class plays the in-class second-place line", () => {
    currentLive = { position: 12, classPosition: 2, isMultiClass: true };
    fireGained({ position: 12, classPosition: 2, previousPosition: 12, previousClassPosition: 3, isMultiClass: true });
    expect(voicePaths()).toContain(`voice/${VOICE}/position-overtake/nice-pass-p2-class-01.mp3`);
  });

  it("gained P3 plays the dedicated third-place line and suppresses the readout", () => {
    currentLive = { position: 3, classPosition: 3, isMultiClass: false };
    fireGained({ position: 3, previousPosition: 4 });
    const played = voicePaths();
    expect(played).toContain(`voice/${VOICE}/position-overtake/nice-pass-p3-01.mp3`);
    expect(played).not.toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
  });

  it("gained P3 in multi-class plays the in-class third-place line", () => {
    currentLive = { position: 20, classPosition: 3, isMultiClass: true };
    fireGained({ position: 20, classPosition: 3, previousPosition: 21, previousClassPosition: 4, isMultiClass: true });
    expect(voicePaths()).toContain(`voice/${VOICE}/position-overtake/nice-pass-p3-class-01.mp3`);
  });
});

describe("retirement-driven gain (#603)", () => {
  it("reads the new position but suppresses the Nice pass reaction", () => {
    _setReactionRandom(() => 0); // would otherwise react
    currentLive = { position: 13, classPosition: 13, isMultiClass: false };
    fireGained({ position: 13, previousPosition: 14, fromRetirement: true });
    const played = voicePaths();
    expect(played).not.toContain(`voice/${VOICE}/position-overtake/nice-pass-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-intro-worse/currently-01.mp3`);
    expect(played).toContain(`voice/${VOICE}/position-number/13.mp3`);
  });
});

describe("overtake context gate (suppresses the whole callout, both directions)", () => {
  const REACTION = `voice/${VOICE}/position-overtake/nice-pass-01.mp3`;
  const POSITION = `voice/${VOICE}/position-intro-worse/currently-01.mp3`;

  it("fires when the context is clear", () => {
    fireGained({});
    const played = voicePaths();
    expect(played).toContain(REACTION);
    expect(played).toContain(POSITION);
  });

  it.each([
    ["cars alongside", { carsAlongside: true }],
    ["off track", { onTrack: false }],
    ["below 50 km/h", { speedKmh: 30 }],
    ["on pit road", { onPitRoad: true }],
    ["recent incident", { msSinceIncident: 2000 }],
  ])("suppresses a gain when %s", (_label, override) => {
    currentGate = { ...CLEAR_GATE, ...override };
    fireGained({});
    expect(voicePaths()).toEqual([]);
  });

  it.each([
    ["cars alongside", { carsAlongside: true }],
    ["off track", { onTrack: false }],
    ["below 50 km/h", { speedKmh: 30 }],
    ["on pit road", { onPitRoad: true }],
    ["recent incident", { msSinceIncident: 2000 }],
  ])("suppresses a loss when %s", (_label, override) => {
    currentGate = { ...CLEAR_GATE, ...override };
    fireLost({});
    expect(voicePaths()).toEqual([]);
  });

  it("suppresses when telemetry (gate) is unavailable", () => {
    currentGate = null;
    fireGained({});
    fireLost({});
    expect(voicePaths()).toEqual([]);
  });

  it("an older incident (outside the window) does not suppress", () => {
    currentGate = { ...CLEAR_GATE, msSinceIncident: 20_000 };
    fireGained({});
    expect(voicePaths()).toContain(REACTION);
  });
});
