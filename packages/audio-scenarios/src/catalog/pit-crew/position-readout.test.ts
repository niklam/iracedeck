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
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { createFakeAudio, type FakeAudio } from "@iracedeck/audio-service/testing";
import { type CalloutScript } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { type TelemetryData, TrkLoc } from "@iracedeck/iracing-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NO_FRAME, type ScenarioContext, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { familyReferences } from "./family-references.test-util.js";
import { PERMISSIVE_OVERTAKE_GATE } from "./overtake-gate.js";
import {
  _resetPositionReadoutCooldown,
  _setReactionRandom,
  buildOvertakeGainedPositionContract,
  buildOvertakeLostPositionContract,
  buildPositionReadoutSpeakGate,
  canAnnouncePosition,
  commitIntroDecision,
  INTRO_COOLDOWN_MS,
  lapEnteredPitRoad,
  type LivePosition,
  lowerFirst,
  OVERTAKE_POSITION_SCENARIO_IDS,
  playerOnPitRoadOrOutOfCar,
  POSITION_READOUT_COOLDOWN_MS,
  POSITION_READOUT_PIT_ROAD_CLAUSE,
  POSITION_READOUT_SPEAK_GATE_DESCRIPTION,
  REACTION_CHANCE,
  readPositionReadoutDebugState,
  registerPositionReadoutVocabulary,
  shouldReactToOvertake,
  shouldSpeakIntro,
  tryClaimPositionAnnouncement,
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

describe("lowerFirst — composing the shared gate sentence onto a qualifier", () => {
  it("lowers the first letter and nothing else", () => {
    expect(lowerFirst("No other readout. Speaking it Starts the window.")).toBe(
      "no other readout. Speaking it Starts the window.",
    );
    expect(lowerFirst("")).toBe("");
  });

  it("turns the shared gate sentence into a clause a qualified gate can end on", () => {
    expect(`In a race, ${lowerFirst(POSITION_READOUT_SPEAK_GATE_DESCRIPTION)}`).toBe(
      "In a race, no other position readout has spoken in the last twenty seconds; speaking this one starts that window.",
    );
  });
});

/** A tick of the player's car, out on track and driving (issue #1722). */
const ON_TRACK = { IsOnTrack: true, OnPitRoad: false, PlayerTrackSurface: TrkLoc.OnTrack } as TelemetryData;

/** Each state in which no position readout starts (issue #1722), named for the test titles. */
const PIT_ROAD_STATES: ReadonlyArray<readonly [string, TelemetryData]> = [
  ["OnPitRoad", { ...ON_TRACK, OnPitRoad: true }],
  ["the pit-stall surface", { ...ON_TRACK, PlayerTrackSurface: TrkLoc.InPitStall }],
  ["the pit-lane surface (AproachingPits)", { ...ON_TRACK, PlayerTrackSurface: TrkLoc.AproachingPits }],
  ["out of the car (IsOnTrack: false)", { ...ON_TRACK, IsOnTrack: false }],
  ["the tow or reset tick (NotInWorld, IsOnTrack still true)", { ...ON_TRACK, PlayerTrackSurface: TrkLoc.NotInWorld }],
];

describe("playerOnPitRoadOrOutOfCar — the state no position readout starts in (issue #1722)", () => {
  it("is false with no telemetry — missing data never silences a readout", () => {
    expect(playerOnPitRoadOrOutOfCar(null)).toBe(false);
  });

  it("is false for a tick that carries none of the fields it reads", () => {
    expect(playerOnPitRoadOrOutOfCar({} as TelemetryData)).toBe(false);
  });

  it("is false out on track, and off the racing surface", () => {
    expect(playerOnPitRoadOrOutOfCar(ON_TRACK)).toBe(false);
    expect(playerOnPitRoadOrOutOfCar({ ...ON_TRACK, PlayerTrackSurface: TrkLoc.OffTrack })).toBe(false);
  });

  it.each(PIT_ROAD_STATES)("is true on %s", (_name, telemetry) => {
    expect(playerOnPitRoadOrOutOfCar(telemetry)).toBe(true);
  });

  it("reads each field on its own — any one refusing state is enough, the others missing", () => {
    expect(playerOnPitRoadOrOutOfCar({ OnPitRoad: true } as TelemetryData)).toBe(true);
    expect(playerOnPitRoadOrOutOfCar({ IsOnTrack: false } as TelemetryData)).toBe(true);
    expect(playerOnPitRoadOrOutOfCar({ PlayerTrackSurface: TrkLoc.InPitStall } as TelemetryData)).toBe(true);
    expect(playerOnPitRoadOrOutOfCar({ PlayerTrackSurface: TrkLoc.AproachingPits } as TelemetryData)).toBe(true);
    expect(playerOnPitRoadOrOutOfCar({ PlayerTrackSurface: TrkLoc.NotInWorld } as TelemetryData)).toBe(true);
  });

  it("refuses the tow or reset tick, which keeps IsOnTrack true — but a surface it was not given still admits", () => {
    expect(
      playerOnPitRoadOrOutOfCar({
        IsOnTrack: true,
        OnPitRoad: false,
        PlayerTrackSurface: TrkLoc.NotInWorld,
      } as TelemetryData),
    ).toBe(true);
    expect(playerOnPitRoadOrOutOfCar({ IsOnTrack: true, OnPitRoad: false } as TelemetryData)).toBe(false);
  });
});

describe("lapEnteredPitRoad — the in lap no lap-completed readout speaks for (issue #1722)", () => {
  type Lap = Parameters<typeof lapEnteredPitRoad>[0];

  it("is true for an in lap, an out lap that came back in included", () => {
    expect(lapEnteredPitRoad({ lap: 5, isBest: false, isInLap: true } as Lap)).toBe(true);
    expect(lapEnteredPitRoad({ lap: 5, isBest: false, isOutLap: true, isInLap: true } as Lap)).toBe(true);
  });

  it("is false for an out lap that ended on track, and for a lap that never touched pit road", () => {
    expect(lapEnteredPitRoad({ lap: 5, isBest: false, isOutLap: true } as Lap)).toBe(false);
    expect(lapEnteredPitRoad({ lap: 5, isBest: false } as Lap)).toBe(false);
  });
});

describe("buildPositionReadoutSpeakGate — the one gate every position readout is built on (issue #1722)", () => {
  let telemetry: TelemetryData | null;

  /** A fire context for the gate; it reads nothing of it but the intro stash's identity. */
  function ctx(): ScenarioContext {
    return { event: null, telemetry: null, data: null, now: Date.now(), vars: {} };
  }

  beforeEach(() => {
    _resetPositionReadoutCooldown();
    telemetry = ON_TRACK;
  });

  afterEach(() => _resetPositionReadoutCooldown());

  it("admits on track and claims the shared window", () => {
    const gate = buildPositionReadoutSpeakGate(() => telemetry);

    expect(gate.admit(ctx())).toBe(true);
    expect(canAnnouncePosition()).toBe(false);
  });

  it.each(PIT_ROAD_STATES)("refuses on %s WITHOUT claiming the shared window", (_name, state) => {
    const gate = buildPositionReadoutSpeakGate(() => telemetry);

    telemetry = state;
    expect(gate.admit(ctx())).toBe(false);
    expect(canAnnouncePosition()).toBe(true);
  });

  it("admits with no telemetry — the default resolver's answer", () => {
    telemetry = null;

    expect(buildPositionReadoutSpeakGate(() => telemetry).admit(ctx())).toBe(true);
  });

  it("asks pit road before the contract's own refusal, and that refusal before the claim", () => {
    const refuses = vi.fn(() => true);
    const gate = buildPositionReadoutSpeakGate(() => telemetry, { refuses });

    telemetry = { ...ON_TRACK, OnPitRoad: true };
    expect(gate.admit(ctx())).toBe(false);
    expect(refuses).not.toHaveBeenCalled();

    telemetry = ON_TRACK;
    expect(gate.admit(ctx())).toBe(false);
    expect(refuses).toHaveBeenCalledTimes(1);
    expect(canAnnouncePosition()).toBe(true);
  });

  it("claims nothing for a fire the contract says does not claim the window, and still refuses it on pit road", () => {
    const gate = buildPositionReadoutSpeakGate(() => telemetry, { claimsWindow: () => false });

    expect(gate.admit(ctx())).toBe(true);
    expect(canAnnouncePosition()).toBe(true);

    telemetry = { ...ON_TRACK, PlayerTrackSurface: TrkLoc.InPitStall };
    expect(gate.admit(ctx())).toBe(false);
  });

  it("publishes the pit-road clause and the shared window as one sentence by default", () => {
    const { description } = buildPositionReadoutSpeakGate(() => null);

    expect(description).toBe(
      "The driver is in the car and off pit road, and no other position readout has spoken in the last twenty seconds; speaking this one starts that window.",
    );
    expect(description.startsWith(POSITION_READOUT_PIT_ROAD_CLAUSE)).toBe(true);
    expect(description).toContain(lowerFirst(POSITION_READOUT_SPEAK_GATE_DESCRIPTION));
  });
});

describe("shouldSpeakIntro — bare vs full intro (#603)", () => {
  beforeEach(() => _resetPositionReadoutCooldown());

  const T0 = 1_000_000;

  /**
   * The production pair since #1138: the pure decision runs during expansion,
   * the record is committed by the contract's speak-time gate for a readout
   * that goes on to play. Composed here so one assertion still reads as "does
   * this readout speak its lead-in, and does it become the one the next
   * readout measures from".
   */
  function speakIntro(position: number, now: number): boolean {
    const spokeIntro = shouldSpeakIntro(position, now);

    commitIntroDecision({ spokeIntro, position, at: now });

    return spokeIntro;
  }

  it("speaks the full intro on the first readout", () => {
    expect(speakIntro(5, T0)).toBe(true);
  });

  it("is pure: deciding twice does not record the readout (issue #1138)", () => {
    // The `where:`-never-claims rule one step later. A readout that decides
    // and is then refused at its gate — or aborted at expansion — must leave
    // the next one's decision exactly as it found it.
    expect(shouldSpeakIntro(5, T0)).toBe(true);
    expect(shouldSpeakIntro(4, T0 + 1000)).toBe(true); // still nothing recorded → still the first
  });

  it("drops the intro for a ≤1-position move within the cooldown window", () => {
    expect(speakIntro(5, T0)).toBe(true);
    expect(speakIntro(4, T0 + 1000)).toBe(false); // delta 1, inside 30 s → bare
    expect(speakIntro(4, T0 + 2000)).toBe(false); // same position → bare
  });

  it("restores the full intro once the cooldown elapses", () => {
    expect(speakIntro(5, T0)).toBe(true);
    expect(speakIntro(4, T0 + INTRO_COOLDOWN_MS)).toBe(true);
  });

  it("always uses the full intro for a move of more than one position, even inside the window", () => {
    expect(speakIntro(5, T0)).toBe(true);
    expect(speakIntro(2, T0 + 1000)).toBe(true); // delta 3 > 1 → full
  });

  it("a bare readout still becomes the position the next one measures from", () => {
    // A committed decision records the position whether or not the lead-in
    // was spoken — the 30 s window is only re-armed by an intro.
    expect(speakIntro(5, T0)).toBe(true);
    expect(speakIntro(4, T0 + 1000)).toBe(false); // bare, records P4
    expect(speakIntro(2, T0 + 2000)).toBe(true); // |2 - 4| > 1 → full again
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
    // The stand-in line the deferral tests park on the Voice bus.
    "test/blocker.mp3",
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
  /** The player's live tick the readouts' pit-road check reads (issue #1722). */
  let telemetry: TelemetryData | null;

  function voicePaths(): string[] {
    return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
  }

  /** Publish the gain WITHOUT draining the bus — for the deferral tests. */
  function publishGained(position: number): void {
    bus.publishEvent("overtake.completed", {
      carIdx: 0,
      sustained: 3000,
      position,
      previousPosition: position + 1,
      isLeader: false,
    } as never);
  }

  function fireGained(position: number): void {
    publishGained(position);
    flush(audio);
  }

  /**
   * The pre-#1064 closures' shape: the intro is a REQUIRED step, so a readout
   * whose intro resolves to nothing aborts the whole expansion (issue #835).
   */
  function useRequiredIntroScript(): void {
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
  }

  /** A NORMAL-weight line already on the Voice bus, so a CHATTER readout defers behind it. */
  function startBlocker(): void {
    engine.defineScenario({
      id: "test.blocker",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      weight: WEIGHT.NORMAL,
      frame: NO_FRAME,
      sequence: ["test/blocker.mp3"],
    });
    engine.fire("test.blocker");
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
    telemetry = ON_TRACK;
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
        () => telemetry,
      ),
    );
    engine.defineContract(
      buildOvertakeLostPositionContract(
        () => live,
        () => false,
        () => PERMISSIVE_OVERTAKE_GATE,
        () => telemetry,
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

  it("positive control: with the intro REQUIRED — the closures' shape since #835 — the same in-window readout is silent", () => {
    useRequiredIntroScript();

    fireGained(5);
    expect(voicePaths()).toHaveLength(2);
    audio._played.length = 0;

    vi.advanceTimersByTime(POSITION_READOUT_COOLDOWN_MS + 1000);
    live = { position: 4, classPosition: 4, isMultiClass: false };
    fireGained(4);

    // A null required var aborts the whole expansion (issue #835) — nothing
    // plays. This is what the bundled script's optional clause exists to
    // avoid. Until #1137 the abort also burned the shared cooldown, which the
    // `where:` had already claimed; the test below is what pins that gone.
    expect(voicePaths()).toEqual([]);
  });

  it("an aborted expansion leaves the shared position cooldown unclaimed — the next genuine readout still speaks (issue #1137)", () => {
    // Same setup as the positive control above: the intro is REQUIRED and
    // resolves to nothing, so the expansion aborts. The claim is the
    // speak-time gate's now, and an aborting expansion never reaches it.
    useRequiredIntroScript();

    fireGained(5);
    expect(voicePaths()).toHaveLength(2);
    audio._played.length = 0;

    // Past the shared window, inside the intro window, a one-place move: the
    // intro resolves to nothing and the whole readout aborts.
    vi.advanceTimersByTime(POSITION_READOUT_COOLDOWN_MS + 1000);
    live = { position: 4, classPosition: 4, isMultiClass: false };
    fireGained(4);

    expect(voicePaths()).toEqual([]);
    expect(canAnnouncePosition()).toBe(true);

    // A second later — deep inside the twenty seconds the aborted fire used to
    // burn — a readout the script CAN expand (a move of more than one place
    // keeps the intro) still speaks.
    audio._played.length = 0;
    vi.advanceTimersByTime(1000);
    live = { position: 2, classPosition: 2, isMultiClass: false };
    fireLost(2);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/2.mp3`,
    ]);
  });

  it("a readout deferred behind a busier line claims the shared window only when it finally speaks (issue #1137)", () => {
    startBlocker();
    publishGained(5);

    // `where:` passed and the fire is waiting for the bus — nothing is claimed
    // yet, because the claim now happens at the speak-time gate.
    expect(canAnnouncePosition()).toBe(true);

    flush(audio);

    expect(voicePaths()).toEqual([
      "test/blocker.mp3",
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/5.mp3`,
    ]);
    expect(canAnnouncePosition()).toBe(false);
  });

  it("a readout whose window another trigger took while it waited is refused at its gate, and cuts nothing (issue #1137)", () => {
    startBlocker();
    publishGained(5);

    // Another trigger's readout (a lap-completed one, in production) speaks
    // while this one waits behind the busier line, taking the shared window.
    expect(tryClaimPositionAnnouncement()).toBe(true);

    flush(audio);

    // The deferred readout replays, re-expands, and is refused at its gate —
    // the position is never spoken twice (issue #651) — while the line that
    // was in flight played through untouched.
    expect(voicePaths()).toEqual(["test/blocker.mp3"]);
  });

  it("a readout refused at its gate stamps no intro tracker — the next accepted one still speaks the lead-in (issue #1138)", () => {
    // The refused readout's expansion resolved the intro var and DECIDED to
    // speak the lead-in; it must not record that, because nobody heard it.
    // Recording it made the next accepted readout — within the 30 s intro
    // window, one place away — speak a bare number with no "We're currently".
    startBlocker();
    publishGained(5);
    expect(tryClaimPositionAnnouncement()).toBe(true); // another trigger takes the window
    flush(audio);

    expect(voicePaths()).toEqual(["test/blocker.mp3"]);

    // The shared window frees up; the intro window has NOT, and the move is
    // one place — exactly the conditions under which a stamped tracker would
    // drop the lead-in.
    audio._played.length = 0;
    vi.advanceTimersByTime(POSITION_READOUT_COOLDOWN_MS);
    live = { position: 4, classPosition: 4, isMultiClass: false };
    fireGained(4);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/4.mp3`,
    ]);
  });

  it("a readout whose expansion aborts stamps no intro tracker either (issues #835/#1138)", () => {
    // The intro var resolves (and decides) before the number var aborts the
    // whole callout — P65 is past the clips this voice ships. Nothing was
    // heard, so nothing is recorded: the same rule as the refused gate,
    // reached one step earlier.
    live = { position: 65, classPosition: 65, isMultiClass: false };
    fireGained(65);

    expect(voicePaths()).toEqual([]);

    // One place away, inside the intro window: a tracker left by the aborted
    // expansion would drop this readout's lead-in.
    audio._played.length = 0;
    vi.advanceTimersByTime(POSITION_READOUT_COOLDOWN_MS);
    live = { position: 64, classPosition: 64, isMultiClass: false };
    fireGained(64);

    expect(voicePaths()).toEqual([
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/64.mp3`,
    ]);
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
      // The shared-cooldown claim is a speak-time gate since #1137, described
      // for the pack author reading a readout that sometimes says nothing.
      expect(c.speakGate?.description).toContain("twenty seconds");
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
    const refs = familyReferences(READOUT_SCRIPT);

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

  describe("silent on pit road and out of the car (issue #1722)", () => {
    const READOUT_P5 = [
      `voice/${VOICE}/position-intro-worse/currently-01.mp3`,
      `voice/${VOICE}/position-number/5.mp3`,
    ];

    it("both readouts play on track — the positive control", () => {
      fireGained(5);
      expect(voicePaths()).toEqual(READOUT_P5);

      // Past the intro window too, so the second readout keeps its lead-in.
      audio._played.length = 0;
      vi.advanceTimersByTime(INTRO_COOLDOWN_MS);
      fireLost(5);
      expect(voicePaths()).toEqual(READOUT_P5);
    });

    it.each(PIT_ROAD_STATES)("neither readout fires on %s, and neither claims the shared window", (_name, state) => {
      telemetry = state;
      fireGained(5);
      fireLost(5);

      expect(voicePaths()).toEqual([]);
      expect(canAnnouncePosition()).toBe(true);
    });

    it("a refusal does not burn the window — the next readout on track, inside twenty seconds, speaks", () => {
      telemetry = { ...ON_TRACK, OnPitRoad: true };
      fireGained(5);
      expect(voicePaths()).toEqual([]);

      vi.advanceTimersByTime(1000);
      telemetry = ON_TRACK;
      fireLost(5);

      expect(voicePaths()).toEqual(READOUT_P5);
    });

    it("a readout queued on track and still waiting when the car reaches pit road is dropped, and never plays after the stop", () => {
      startBlocker();
      publishGained(5);

      // The car turns into the pit lane while the readout waits behind the
      // busier line: the gate drops it when the bus idles.
      telemetry = { ...ON_TRACK, OnPitRoad: true, PlayerTrackSurface: TrkLoc.AproachingPits };
      flush(audio);

      expect(voicePaths()).toEqual(["test/blocker.mp3"]);
      expect(canAnnouncePosition()).toBe(true);
      // Taken and dropped: the refused readout leaves no intro decision.
      expect(readPositionReadoutDebugState().pendingIntro).toBeNull();
      expect(readPositionReadoutDebugState().lastSpokenPosition).toBe(0);

      // Back on track after the stop: nothing replays — dropped, not held.
      telemetry = ON_TRACK;
      flush(audio);

      expect(voicePaths()).toEqual(["test/blocker.mp3"]);
    });
  });
});
