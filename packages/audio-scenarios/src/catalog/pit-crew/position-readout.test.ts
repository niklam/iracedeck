/**
 * Position-readout tests: the reaction gate and bare/full intro logic (issue
 * #603), and — since #1065 — the two overtake readout contracts driven
 * through the real engine with the bundled script narrowed to them. The
 * cross-family behaviour (a readout deferring behind its reaction, the
 * cooldown shared with lap and race-status readouts) is `overtake.test.ts`'s,
 * which registers the whole catalog.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { PERMISSIVE_OVERTAKE_GATE } from "./overtake-gate.js";
import {
  _resetPositionReadoutCooldown,
  _setReactionRandom,
  buildOvertakeGainedPositionContract,
  buildOvertakeLostPositionContract,
  INTRO_COOLDOWN_MS,
  type LivePosition,
  OVERTAKE_POSITION_SCENARIO_IDS,
  POSITION_READOUT_COOLDOWN_MS,
  REACTION_CHANCE,
  registerPositionReadoutVocabulary,
  shouldReactToOvertake,
  shouldSpeakIntro,
} from "./position-readout.js";

describe("shouldReactToOvertake — random gate, podium-exempt (#603)", () => {
  beforeEach(() => _resetPositionReadoutCooldown());

  it("always reacts for podium positions (P1/P2/P3) regardless of the roll", () => {
    _setReactionRandom(() => 0.99); // would fail the chance gate

    expect(shouldReactToOvertake(1)).toBe(true);
    expect(shouldReactToOvertake(2)).toBe(true);
    expect(shouldReactToOvertake(3)).toBe(true);
  });

  it("reacts for a non-podium position when the roll is under the chance", () => {
    _setReactionRandom(() => REACTION_CHANCE - 0.01);

    expect(shouldReactToOvertake(4)).toBe(true);
    expect(shouldReactToOvertake(15)).toBe(true);
  });

  it("skips the reaction for a non-podium position when the roll is at or over the chance", () => {
    _setReactionRandom(() => REACTION_CHANCE);
    expect(shouldReactToOvertake(4)).toBe(false);

    _setReactionRandom(() => 0.99);
    expect(shouldReactToOvertake(20)).toBe(false);
  });
});

describe("shouldSpeakIntro — bare vs full intro (#603)", () => {
  beforeEach(() => _resetPositionReadoutCooldown());

  const T0 = 1_000_000;

  it("speaks the full intro on the first readout", () => {
    expect(shouldSpeakIntro(5, T0)).toBe(true);
  });

  it("drops the intro for a ≤1-position move within the cooldown window", () => {
    expect(shouldSpeakIntro(5, T0)).toBe(true);
    expect(shouldSpeakIntro(4, T0 + 1000)).toBe(false); // delta 1, inside 30 s → bare
    expect(shouldSpeakIntro(4, T0 + 2000)).toBe(false); // same position → bare
  });

  it("restores the full intro once the cooldown elapses", () => {
    expect(shouldSpeakIntro(5, T0)).toBe(true);
    expect(shouldSpeakIntro(4, T0 + INTRO_COOLDOWN_MS)).toBe(true);
  });

  it("always uses the full intro for a move of more than one position, even inside the window", () => {
    expect(shouldSpeakIntro(5, T0)).toBe(true);
    expect(shouldSpeakIntro(2, T0 + 1000)).toBe(true); // delta 3 > 1 → full
  });
});

// ─── The two readout contracts through the real script (issue #1065) ────────

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

const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
    ...Array.from({ length: 64 }, (_, i) => `voice/${VOICE}/position-number/${i + 1}.mp3`),
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

const SCRIPT = defaultScript as CalloutScript;

/** The bundled script narrowed to the two readout entries (F7-trap i). */
const READOUT_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(OVERTAKE_POSITION_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

const MANIFEST = manifestJson as AudioAssetsManifest;
const BUNDLED_VOICE = "default";

describe("the overtake position readouts through the real script (issue #1065)", () => {
  let bus: ReturnType<typeof createMockBus>;
  let audio: FakeAudio;
  let engine: IScenarioEngine;
  let live: LivePosition | null;

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  function fireGained(position: number): void {
    bus.publishEvent("overtake.completed", {
      carIdx: 0,
      sustained: 3000,
      position,
      previousPosition: position + 1,
      isLeader: false,
    } as never);
    flush(audio);
  }

  function fireLost(position: number): void {
    bus.publishEvent("overtake.lost", {
      carIdx: 0,
      sustained: 3000,
      position,
      previousPosition: position - 1,
    } as never);
    flush(audio);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    _resetPositionReadoutCooldown();
    live = { position: 5, classPosition: 5, isMultiClass: false };
    bus = createMockBus();
    audio = createFakeAudio();
    engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);
    // The production order (`registerPitCrew`): vocabulary, contracts, script.
    registerPositionReadoutVocabulary(engine, () => live);
    engine.defineContract(
      buildOvertakeGainedPositionContract(
        () => live,
        () => false,
        () => PERMISSIVE_OVERTAKE_GATE,
      ),
    );
    engine.defineContract(
      buildOvertakeLostPositionContract(
        () => live,
        () => false,
        () => PERMISSIVE_OVERTAKE_GATE,
      ),
    );
    engine.setScripts(new Map([[VOICE, READOUT_SCRIPT]]));
  });

  afterEach(() => {
    _resetAudioScenarios();
    _resetPositionReadoutCooldown();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("the first readout speaks the full intro and the LIVE position, inside the radio frame", () => {
    live = { position: 3, classPosition: 3, isMultiClass: false };
    fireGained(5);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/3.mp3`,
    ]);
    expect(audio._played.map((p) => p.path)[0]).toBe("sfx/IRD-tick-open.mp3");
  });

  it("a second readout inside the intro window that moved one place speaks the BARE number — the #603 form, optional lead-in (issue #1065)", () => {
    fireGained(5);
    audio._played.length = 0;

    // Past the shared 20 s position cooldown, inside the 30 s intro window.
    vi.advanceTimersByTime(POSITION_READOUT_COOLDOWN_MS + 1000);
    live = { position: 4, classPosition: 4, isMultiClass: false };
    fireGained(4);

    expect(voicePaths()).toEqual([`voice/${VOICE}/position-number/4.mp3`]);
  });

  it("positive control: with the intro REQUIRED — the closures' shape since #835 — the same in-window readout is silent, cooldown claimed and all", () => {
    engine.setScripts(
      new Map([
        [
          VOICE,
          {
            ...READOUT_SCRIPT,
            scenarios: Object.fromEntries(
              OVERTAKE_POSITION_SCENARIO_IDS.map((id) => [
                id,
                { sequence: ["{{positionReadout.intro}}", "{{positionReadout.number}}"] },
              ]),
            ),
          },
        ],
      ]),
    );

    fireGained(5);
    expect(voicePaths()).toHaveLength(2);
    audio._played.length = 0;

    vi.advanceTimersByTime(POSITION_READOUT_COOLDOWN_MS + 1000);
    live = { position: 4, classPosition: 4, isMultiClass: false };
    fireGained(4);

    // A null required var aborts the whole expansion (issue #835) — nothing
    // plays, though `where:` already claimed the shared cooldown. This is what
    // the bundled script's optional clause exists to avoid.
    expect(voicePaths()).toEqual([]);
  });

  it("a second readout inside the window that jumped more than one place keeps the full intro", () => {
    fireGained(5);
    audio._played.length = 0;

    vi.advanceTimersByTime(POSITION_READOUT_COOLDOWN_MS + 1000);
    live = { position: 2, classPosition: 2, isMultiClass: false };
    fireLost(2);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/2.mp3`,
    ]);
  });

  it("restores the full intro once the intro window has elapsed", () => {
    fireGained(5);
    audio._played.length = 0;

    vi.advanceTimersByTime(INTRO_COOLDOWN_MS);
    live = { position: 4, classPosition: 4, isMultiClass: false };
    fireGained(4);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/4.mp3`,
    ]);
  });

  it("stays silent as a whole when the live position has no clip — never a bare intro (issue #835)", () => {
    live = { position: 99, classPosition: 99, isMultiClass: false };
    fireGained(99);

    expect(voicePaths()).toEqual([]);
  });

  it("keeps every scheduling field verbatim on both contracts and carries no sequence", () => {
    for (const c of [buildOvertakeGainedPositionContract(() => null), buildOvertakeLostPositionContract(() => null)]) {
      expect("sequence" in c).toBe(false);
      expect(c.channel).toBe(AudioChannel.Voice);
      expect(c.bus).toBe(AudioBus.Voice);
      expect(c.base).toBe("voice/{voice}");
      expect(c.weight).toBe(WEIGHT.CHATTER);
      expect(c.queueable).toBe(true);
      expect(c.family).toBe("position-readout");
      expect(c.frame).toBeUndefined();
    }

    expect(buildOvertakeGainedPositionContract(() => null).when?.event).toBe("overtake.completed");
    expect(buildOvertakeLostPositionContract(() => null).when?.event).toBe("overtake.lost");
  });

  it("publishes the intro and number vars with descriptions naming their groups, and nothing else", () => {
    const { vars, conds, cases } = engine.vocabulary();
    const readoutVars = vars.filter((v) => v.name.startsWith("positionReadout."));

    expect(readoutVars.map((v) => v.name)).toEqual(["positionReadout.intro", "positionReadout.number"]);
    expect(readoutVars.find((v) => v.name === "positionReadout.intro")?.description).toContain("position-intro-worse");
    expect(readoutVars.find((v) => v.name === "positionReadout.number")?.description).toContain("position-number");
    expect(conds.filter((c) => c.name.startsWith("positionReadout."))).toEqual([]);
    expect(cases.filter((c) => c.name.startsWith("positionReadout."))).toEqual([]);
  });

  it("scripts both readouts with a comment, an In-sim route (the harness has no live position) and a sequence", () => {
    for (const id of OVERTAKE_POSITION_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, `${id}: comment`).toBeGreaterThan(0);
      expect(entry.test, `${id}: test`).toMatch(/^Harness: mute/);
      expect(entry.test, `${id}: test`).toContain("In-sim:");
      expect(entry.skip).toBeUndefined();
      expect(entry.sequence).toEqual([{ optional: ["{{positionReadout.intro}}"] }, "{{positionReadout.number}}"]);
    }
  });

  it("references only the two vars this family registers and no pool — every clip reaches the script through a var", () => {
    const refs = collectScriptReferences(READOUT_SCRIPT);

    expect(refs.vars).toEqual(["positionReadout.intro", "positionReadout.number"]);
    expect(refs.pools).toEqual([]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
  });

  it("the bundled voice ships the intro clip and the number clips the vars draw from", () => {
    for (const [group, base] of [
      ["position-intro-worse", "currently"],
      ["position-number", "1"],
      ["position-number", "64"],
    ] as const) {
      const pattern = poolMemberPattern(group, base);

      expect(
        MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === BUNDLED_VOICE),
        `${group}/${base}`,
      ).toBe(true);
    }
  });

  it("compiles for the test voice with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
