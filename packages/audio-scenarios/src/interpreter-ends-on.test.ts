/**
 * A contract's `endsOn` (issue #1407): when the named event is published, every
 * fire of the contract is ended wherever it is — a pending trigger timer, a
 * waiting fire, or the playing one, which stops silently before any body clip
 * has started and plays the frame's cut tail once one has.
 */
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import type { CalloutScript, FrameDefinition } from "@iracedeck/callout-script";
import type { IEventBus, SimEventName, SimEventOf } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContract } from "./dsl.js";
import { NO_FRAME, WEIGHT } from "./dsl.js";
import type { AudioAssetsManifest, FrameOptions, IScenarioEngine } from "./interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "./interpreter.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  createScope: vi.fn(),
  withLevel: vi.fn(),
};

type MockBus = IEventBus & { publishEvent: (name: SimEventName) => void };

function createMockBus(): MockBus {
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
    publishEvent(name) {
      this.publish({ event: name, timestamp: Date.now(), telemetry: null, data: {} } as SimEventOf<SimEventName>);
    },
  };
}

type FakeAudio = IAudioService & {
  _triggerChannelEnd: (channel: AudioChannel) => void;
  _played: { channel: AudioChannel; path: string }[];
  _stopped: AudioChannel[];
};

/**
 * Records plays and stops and lets a test end a channel's clip by hand. With
 * `completeOnStop`, `stopChannel` fires the channel's complete callback
 * synchronously before clearing it — the shape the end path must survive
 * without stepping into the next body op.
 */
function createFakeAudio(completeOnStop = false): FakeAudio {
  const callbacks = new Map<AudioChannel, () => void>();
  const played: { channel: AudioChannel; path: string }[] = [];
  const stopped: AudioChannel[] = [];

  return {
    playOnChannel: vi.fn((channel: AudioChannel, path: string) => {
      played.push({ channel, path });

      return true;
    }),
    stopChannel: vi.fn((channel: AudioChannel) => {
      stopped.push(channel);

      const cb = callbacks.get(channel);
      callbacks.delete(channel);

      if (completeOnStop) cb?.();
    }),
    onChannelComplete: vi.fn((channel: AudioChannel, cb: () => void) => {
      callbacks.set(channel, cb);
    }),
    seekChannelRandom: vi.fn(),
    _triggerChannelEnd: (channel: AudioChannel) => {
      const cb = callbacks.get(channel);
      callbacks.delete(channel);
      cb?.();
    },
    _played: played,
    _stopped: stopped,
  } as unknown as FakeAudio;
}

const TICK_OPEN = "sfx/IRD-tick-open.mp3";
const TICK_CLOSE = "sfx/IRD-tick-close.mp3";
const NEVER_MIND = "voice/default/radio/never-mind-01.mp3";
const BODY_A = "voice/default/limiter/a-01.mp3";
const BODY_B = "voice/default/limiter/b-01.mp3";
const LIGHT = "voice/default/other/light-01.mp3";
const HEAVY = "voice/default/other/heavy-01.mp3";
const FAMILY = "voice/default/other/family-01.mp3";
const RADAR = "voice/default/other/radar-01.mp3";
const BEEP_2 = "voice/default/radio/beep-01.mp3";

const manifest: AudioAssetsManifest = {
  clips: [
    TICK_OPEN,
    TICK_CLOSE,
    "sfx/IRD-ambient-pit.mp3",
    NEVER_MIND,
    BODY_A,
    BODY_B,
    LIGHT,
    HEAVY,
    FAMILY,
    RADAR,
    BEEP_2,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: TICK_OPEN, close: TICK_CLOSE },
};

const RADIO_WITH_CUT: FrameDefinition = {
  open: [TICK_OPEN],
  close: [{ ambient: "stop" }, TICK_CLOSE],
  cut: [NEVER_MIND, { ambient: "stop" }, TICK_CLOSE],
};

const RADIO_WITHOUT_CUT: FrameDefinition = { open: RADIO_WITH_CUT.open, close: RADIO_WITH_CUT.close };

const ENDS_ON = { event: "pitLane.exited", description: "The car leaves pit road." } as const;

function script(radio: FrameDefinition = RADIO_WITH_CUT): CalloutScript {
  return {
    schema: 1,
    scenarios: {
      "test.ends": { sequence: [BODY_A, BODY_B] },
      "test.light": { sequence: [LIGHT] },
      "test.heavy": { sequence: [HEAVY] },
      "test.family": { sequence: [FAMILY] },
      "test.radar": { sequence: [RADAR] },
    },
    frames: { radio },
    pools: {},
  };
}

/** The contract under test: triggered by the green flag, ended by the pit exit. */
function endsContract(overrides: Partial<ScenarioContract> = {}): ScenarioContract {
  return {
    id: "test.ends",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    when: { event: "flag.green.raised" },
    endsOn: ENDS_ON,
    ...overrides,
  };
}

function contract(id: string, overrides: Partial<ScenarioContract> = {}): ScenarioContract {
  return { id, channel: AudioChannel.Voice, bus: AudioBus.Voice, ...overrides };
}

let bus: MockBus;
let audio: FakeAudio;
let engine: IScenarioEngine;
let frameOptions: FrameOptions;

function init(completeOnStop = false): void {
  _resetAudioScenarios();
  bus = createMockBus();
  audio = createFakeAudio(completeOnStop);
  engine = initializeAudioScenarios(
    bus,
    audio,
    manifest,
    mockLogger as never,
    () => "default",
    () => frameOptions,
  );
}

beforeEach(() => {
  frameOptions = { beeps: true, ambience: true };
  init();
});

afterEach(() => {
  _resetAudioScenarios();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function played(): string[] {
  return audio._played.map((p) => p.path);
}

/** End whatever clip is in flight on the Voice and SFX channels, repeatedly, until nothing more plays. */
function flush(iterations = 30): void {
  for (let i = 0; i < iterations; i++) {
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.SFX);
    audio._triggerChannelEnd(AudioChannel.Radar);
  }
}

function voiceBus() {
  return engine.describeState().buses.find((b) => b.bus === "Voice")!;
}

function endedLines(): string[] {
  return mockLogger.debug.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(" ended by "));
}

/** Fire `test.ends` and run it until its first body clip is in flight: [tick-open] done, [a] playing. */
function startEndsMidBody(): void {
  bus.publishEvent("flag.green.raised");
  expect(played()).toEqual([TICK_OPEN]);
  audio._triggerChannelEnd(AudioChannel.SFX);
  expect(played()).toEqual([TICK_OPEN, BODY_A]);
}

// ─── The end path ────────────────────────────────────────────────────────────

describe("endsOn (issue #1407)", () => {
  it("pending trigger timer is cleared", () => {
    vi.useFakeTimers();
    engine.defineContract(endsContract({ triggerDelay: 500 }));
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised");
    vi.advanceTimersByTime(100);
    bus.publishEvent("pitLane.exited");
    vi.advanceTimersByTime(1000);
    flush();

    expect(played()).toEqual([]);
    expect(engine.describeState().contracts.find((c) => c.id === "test.ends")?.triggerPending).toBe(false);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (pending)']);
  });

  it("waiting fire is removed with reason ended", () => {
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL }));
    engine.defineContract(contract("test.light", { weight: WEIGHT.CHATTER, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    engine.fire("test.light");
    // Heavier, no interrupt: it waits for the light line to finish.
    bus.publishEvent("flag.green.raised");
    expect(voiceBus().waiting.map((w) => w.id)).toEqual(["test.ends"]);

    bus.publishEvent("pitLane.exited");

    expect(voiceBus().waiting).toEqual([]);
    expect(mockLogger.debug).toHaveBeenCalledWith('Scenario "test.ends" dropped — ended');
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (waiting)']);

    flush();
    expect(played()).toEqual([LIGHT]);
  });

  it("interrupt-stashed fire is removed", () => {
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL, queueable: true }));
    engine.defineContract(contract("test.heavy", { weight: WEIGHT.CRITICAL, interrupt: true, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    engine.fire("test.heavy");
    expect(voiceBus().waiting.map((w) => w.id)).toEqual(["test.ends"]);

    bus.publishEvent("pitLane.exited");
    expect(voiceBus().waiting).toEqual([]);

    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, HEAVY]);
    expect(voiceBus().playingId).toBeNull();
  });

  it("fire ended during open ops stops silently", () => {
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised");
    expect(played()).toEqual([TICK_OPEN]);

    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN]);
    expect(audio._stopped).toContain(AudioChannel.SFX);
    expect(voiceBus().playingId).toBeNull();
    expect(voiceBus().active).toBeNull();
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → silent)']);
  });

  it("fire ended mid-body plays the cut tail", () => {
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL }));
    engine.defineContract(contract("test.light", { weight: WEIGHT.CHATTER, queueable: true, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    engine.fire("test.light"); // waits behind the playing line
    audio._stopped.length = 0;

    bus.publishEvent("pitLane.exited");

    // The body is cut mid-clip and the tail takes the bus at once. The
    // ambience bed is left running: the tail stops it itself, after "never
    // mind", so the line is abandoned over the bed rather than into silence.
    expect(audio._stopped).toEqual(expect.arrayContaining([AudioChannel.Voice, AudioChannel.SFX]));
    expect(audio._stopped).not.toContain(AudioChannel.Ambient);
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND]);
    expect(voiceBus().playingId).toBe("test.ends");
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);

    // "Never mind" is the engineer speaking: it plays on the Voice channel,
    // at voice volume like the body; the close tick stays a sound effect.
    audio._stopped.length = 0;
    audio._triggerChannelEnd(AudioChannel.Voice); // never mind ends: the ambience stops, the close tick plays
    expect(audio._stopped).toEqual([AudioChannel.Ambient]);
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);
    expect(audio._played.slice(-2)).toEqual([
      { channel: AudioChannel.Voice, path: NEVER_MIND },
      { channel: AudioChannel.SFX, path: TICK_CLOSE },
    ]);

    // The tail ends, the bus is released and drains what waited.
    audio._triggerChannelEnd(AudioChannel.SFX);
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE, LIGHT]);
    expect(played()).not.toContain(BODY_B);
  });

  it("frame without cut plays close after an end mid-body", () => {
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script(RADIO_WITHOUT_CUT)]]));

    startEndsMidBody();
    audio._stopped.length = 0;
    bus.publishEvent("pitLane.exited");
    // The close carries the ambience stop, so the cut leaves the bed to it:
    // the bed is stopped once, by the tail's first op, not also at the cut.
    expect(audio._stopped.filter((c) => c === AudioChannel.Ambient)).toEqual([AudioChannel.Ambient]);
    expect(audio._stopped.indexOf(AudioChannel.Ambient)).toBe(audio._stopped.length - 1);

    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, TICK_CLOSE]);
    expect(audio._stopped.filter((c) => c === AudioChannel.Ambient)).toEqual([AudioChannel.Ambient]);
    expect(voiceBus().playingId).toBeNull();
  });

  it("a close fallback plays as the close does — a pack's own close beep stays a sound effect", () => {
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script({ open: [TICK_OPEN], close: [{ ambient: "stop" }, BEEP_2] })]]));

    startEndsMidBody();
    bus.publishEvent("pitLane.exited");
    flush();

    expect(audio._played.slice(-1)).toEqual([{ channel: AudioChannel.SFX, path: BEEP_2 }]);

    // And Radio beeps drops it there, as it does in the close.
    init();
    frameOptions = { beeps: false, ambience: true };
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script({ open: [TICK_OPEN], close: [{ ambient: "stop" }, BEEP_2] })]]));

    bus.publishEvent("flag.green.raised");
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([BODY_A]);
  });

  it("frame none: playing fire stops and nothing more plays", () => {
    engine.defineContract(endsContract({ frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised");
    expect(played()).toEqual([BODY_A]);

    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([BODY_A]);
    expect(voiceBus().playingId).toBeNull();
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → silent)']);
  });

  it("ended fire is never re-queued", () => {
    engine.defineContract(endsContract({ queueable: true, resumable: true }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);
    expect(voiceBus().playingId).toBeNull();
    expect(voiceBus().waiting).toEqual([]);
  });

  it("heavier interrupt cuts the tail and does not stash", () => {
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL, queueable: true, resumable: true }));
    engine.defineContract(contract("test.heavy", { weight: WEIGHT.CRITICAL, interrupt: true, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    bus.publishEvent("pitLane.exited");
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND]);

    engine.fire("test.heavy");
    expect(voiceBus().waiting).toEqual([]);

    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, HEAVY]);
    expect(voiceBus().playingId).toBeNull();
    expect(voiceBus().waiting).toEqual([]);
  });

  it("second end event during the tail is a no-op", () => {
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    bus.publishEvent("pitLane.exited");
    bus.publishEvent("pitLane.exited");
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND]);

    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);
  });

  it("stopChannel completion does not advance into the body", () => {
    init(true);
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    bus.publishEvent("pitLane.exited");

    // Stopping the Voice channel completed the body clip synchronously; the
    // cut fire must not have moved on to the next body clip, and that
    // completion — on the channel "never mind" now plays on — must not have
    // been taken for the tail's either.
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND]);

    audio._triggerChannelEnd(AudioChannel.Voice); // never mind's own completion: the close follows
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);

    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);
    expect(played()).not.toContain(BODY_B);
  });

  it("stopChannel completion does not advance a silently ended fire either", () => {
    init(true);
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised"); // the open tick in flight
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN]);
  });

  it("resumed fire ended in its preroll plays the tail", () => {
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL, queueable: true, resumable: true }));
    engine.defineContract(contract("test.heavy", { weight: WEIGHT.CRITICAL, interrupt: true, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    engine.fire("test.heavy"); // cuts the body at its first clip and stashes a resume
    audio._triggerChannelEnd(AudioChannel.Voice); // the heavy line ends; the resume re-keys with the open tick
    expect(played()).toEqual([TICK_OPEN, BODY_A, HEAVY, TICK_OPEN]);
    expect(mockLogger.info).toHaveBeenCalledWith('Resuming scenario "test.ends"');

    // No body clip has played since the resume, but the driver heard words before the cut.
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, HEAVY, TICK_OPEN, NEVER_MIND, TICK_CLOSE]);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);
  });

  it("resumed into its close, ended during the re-key preroll, is left to finish — no never mind", () => {
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL, queueable: true, resumable: true }));
    engine.defineContract(contract("test.heavy", { weight: WEIGHT.CRITICAL, interrupt: true, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    audio._triggerChannelEnd(AudioChannel.Voice); // a ends; b plays
    audio._triggerChannelEnd(AudioChannel.Voice); // b ends; the close tick is in flight
    engine.fire("test.heavy"); // cuts the close tick and stashes a resume there
    audio._triggerChannelEnd(AudioChannel.Voice); // the heavy line ends; the resume re-keys with the open tick
    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE, HEAVY, TICK_OPEN]);
    expect(mockLogger.info).toHaveBeenCalledWith('Resuming scenario "test.ends"');

    // The whole line was heard before the interrupt: the end leaves the close to finish.
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE, HEAVY, TICK_OPEN, TICK_CLOSE]);
    expect(played()).not.toContain(NEVER_MIND);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → closing)']);
    expect(voiceBus().playingId).toBeNull();
  });

  it("resumed from inside a two-beep open, ended during the re-key preroll, stops silently", () => {
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL, queueable: true, resumable: true }));
    engine.defineContract(contract("test.heavy", { weight: WEIGHT.CRITICAL, interrupt: true, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script({ ...RADIO_WITH_CUT, open: [TICK_OPEN, BEEP_2] })]]));

    bus.publishEvent("flag.green.raised");
    audio._triggerChannelEnd(AudioChannel.SFX); // the first beep ends; the second is in flight
    engine.fire("test.heavy"); // cuts the open at its second beep and stashes a resume there
    audio._triggerChannelEnd(AudioChannel.Voice); // the heavy line ends; the resume re-keys with the first beep
    expect(played()).toEqual([TICK_OPEN, BEEP_2, HEAVY, TICK_OPEN]);
    expect(mockLogger.info).toHaveBeenCalledWith('Resuming scenario "test.ends"');

    // Not a word of the body has been heard: nothing to abandon.
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN, BEEP_2, HEAVY, TICK_OPEN]);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → silent)']);
    expect(voiceBus().playingId).toBeNull();
  });

  it("ended in a trailing pause after its last clip, it is left to finish — no never mind", () => {
    vi.useFakeTimers();
    engine.defineContract(endsContract());
    const base = script();
    engine.setScripts(
      new Map([
        ["default", { ...base, scenarios: { ...base.scenarios, "test.ends": { sequence: [BODY_A, { pause: 500 }] } } }],
      ]),
    );

    startEndsMidBody();
    audio._triggerChannelEnd(AudioChannel.Voice); // a ends; the trailing pause is armed

    bus.publishEvent("pitLane.exited");
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → closing)']);

    vi.advanceTimersByTime(500);
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, TICK_CLOSE]);
    expect(played()).not.toContain(NEVER_MIND);
  });

  it("ended in a pause between two clips, it plays the tail — the line is not finished", () => {
    vi.useFakeTimers();
    engine.defineContract(endsContract());
    const base = script();
    engine.setScripts(
      new Map([
        [
          "default",
          { ...base, scenarios: { ...base.scenarios, "test.ends": { sequence: [BODY_A, { pause: 500 }, BODY_B] } } },
        ],
      ]),
    );

    startEndsMidBody();
    audio._triggerChannelEnd(AudioChannel.Voice); // a ends; the pause before b is armed

    bus.publishEvent("pitLane.exited");
    vi.advanceTimersByTime(1000);
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);
  });

  it("a cut tail without an ambience stop has the bed stopped at the cut", () => {
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script({ ...RADIO_WITH_CUT, cut: [NEVER_MIND, TICK_CLOSE] })]]));

    startEndsMidBody();
    audio._stopped.length = 0;
    bus.publishEvent("pitLane.exited");

    // Nothing in the tail would stop the loop, so the cut does.
    expect(audio._stopped).toEqual(expect.arrayContaining([AudioChannel.Voice, AudioChannel.Ambient]));
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND]);

    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);
    expect(audio._stopped.filter((c) => c === AudioChannel.Ambient)).toEqual([AudioChannel.Ambient]);
  });

  it("fire ended during its close ops is left to finish — no never mind after a complete line", () => {
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL }));
    engine.defineContract(contract("test.light", { weight: WEIGHT.CHATTER, queueable: true, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    engine.fire("test.light"); // waits behind the playing line
    audio._triggerChannelEnd(AudioChannel.Voice); // a ends; b plays
    audio._triggerChannelEnd(AudioChannel.Voice); // b ends; the close stops the bed and plays the close tick
    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE]);
    audio._stopped.length = 0;

    bus.publishEvent("pitLane.exited");

    expect(audio._stopped).toEqual([]);
    expect(voiceBus().playingId).toBe("test.ends");
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → closing)']);

    // The close tick completes and the bus drains what waited.
    audio._triggerChannelEnd(AudioChannel.SFX);
    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE, LIGHT]);
    expect(played()).not.toContain(NEVER_MIND);
  });

  it("an end during the close still removes the contract's waiting fire", () => {
    engine.defineContract(endsContract({ queueable: true }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    audio._triggerChannelEnd(AudioChannel.Voice);
    audio._triggerChannelEnd(AudioChannel.Voice); // the close tick in flight
    bus.publishEvent("flag.green.raised"); // the same line again, queued behind itself
    expect(voiceBus().waiting.map((w) => w.id)).toEqual(["test.ends"]);

    bus.publishEvent("pitLane.exited");

    expect(voiceBus().waiting).toEqual([]);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (waiting, playing → closing)']);

    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE]);
  });

  it("a cut that fails to resolve keeps the line and falls back to the close, warning once", () => {
    const missing = "voice/default/radio/missing-01.mp3";
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script({ ...RADIO_WITH_CUT, cut: [missing, TICK_CLOSE] })]]));

    // The line itself still plays in full.
    bus.publishEvent("flag.green.raised");
    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE]);

    // Ended mid-body, it closes the radio with the frame's close instead.
    audio._played.length = 0;
    startEndsMidBody();
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, TICK_CLOSE]);
    expect(played()).not.toContain(missing);

    const warns = mockLogger.warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("cut tail"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('Voice "default" frame "radio" cut tail cannot play');
  });

  it("a cut that does not compile keeps the line and closes the radio, warning once (issue #1407)", () => {
    // `pool:never-mind` names a pool the script does not define: a compile
    // problem in the tail, which must not fail the frame and with it the line.
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script({ ...RADIO_WITH_CUT, cut: ["pool:never-mind", TICK_CLOSE] })]]));

    const cutWarns = (): string[] =>
      mockLogger.warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("cut tail"));

    expect(cutWarns()).toEqual([
      'Voice "default" frame "radio" cut tail cannot play — unknown pool "never-mind"; an ended line closes the radio instead',
    ]);

    // A recompile (a registration after the load) does not warn again.
    engine.defineContract(contract("test.late", { frame: NO_FRAME }));

    // The line itself still plays in full.
    bus.publishEvent("flag.green.raised");
    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE]);

    // Ended mid-word, it closes the radio with the frame's close.
    audio._played.length = 0;
    startEndsMidBody();
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, TICK_CLOSE]);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);
    expect(cutWarns()).toHaveLength(1);
  });

  it("beeps off: the tail drops only its ticks — never mind is still said", () => {
    frameOptions = { beeps: false, ambience: true };
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised");
    expect(played()).toEqual([BODY_A]); // no open tick

    audio._stopped.length = 0;
    bus.publishEvent("pitLane.exited");
    flush();

    // The tail is "never mind" and its ambience stop: no close tick, and the
    // bed is stopped once, by the tail rather than at the cut.
    expect(played()).toEqual([BODY_A, NEVER_MIND]);
    expect(audio._played.slice(-1)).toEqual([{ channel: AudioChannel.Voice, path: NEVER_MIND }]);
    expect(audio._stopped.filter((c) => c === AudioChannel.Ambient).length).toBe(1);
    expect(voiceBus().playingId).toBeNull();
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);
  });

  it("beeps and ambience off: an end mid-word still says never mind", () => {
    frameOptions = { beeps: false, ambience: false };
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised");
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([BODY_A, NEVER_MIND]);
    expect(audio._stopped).not.toContain(AudioChannel.Ambient);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);
  });

  it("same-family fire without endsOn is untouched", () => {
    engine.defineContract(endsContract({ family: "limiter" }));
    engine.defineContract(contract("test.family", { family: "limiter", frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    engine.fire("test.family");
    expect(played()).toEqual([FAMILY]);

    bus.publishEvent("pitLane.exited");

    expect(voiceBus().playingId).toBe("test.family");
    expect(audio._stopped).toEqual([]);
    expect(endedLines()).toEqual([]);
  });

  it("other-bus fire is untouched", () => {
    engine.defineContract(endsContract());
    engine.defineContract(
      contract("test.radar", { channel: AudioChannel.Radar, bus: AudioBus.Alerts, frame: NO_FRAME }),
    );
    engine.setScripts(new Map([["default", script()]]));

    engine.fire("test.radar");
    bus.publishEvent("flag.green.raised");
    audio._triggerChannelEnd(AudioChannel.SFX); // the open tick ends; the first body clip is in flight
    expect(played()).toEqual([RADAR, TICK_OPEN, BODY_A]);

    bus.publishEvent("pitLane.exited");

    expect(audio._stopped).not.toContain(AudioChannel.Radar);
    expect(engine.describeState().buses.find((b) => b.bus === "Alerts")?.playingId).toBe("test.radar");

    flush();
    expect(played()).toEqual([RADAR, TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);
  });

  it("end event with nothing pending is a no-op", () => {
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("pitLane.exited");

    expect(played()).toEqual([]);
    expect(audio._stopped).toEqual([]);
    expect(endedLines()).toEqual([]);

    // The contract still fires normally afterwards.
    bus.publishEvent("flag.green.raised");
    flush();
    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE]);
  });

  it("a contract without endsOn is not ended by any event", () => {
    engine.defineContract(endsContract({ endsOn: undefined }));
    engine.defineContract(contract("test.light", { endsOn: ENDS_ON, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, BODY_B, TICK_CLOSE]);
  });

  it("two contracts ended by one event, one playing and one waiting behind it: the waiting one never starts (#1514)", () => {
    // The case `endFires`' two passes exist for. The playing contract is
    // registered FIRST, so a single pass in table order would stop it
    // silently and drain the bus — starting the waiting contract — before
    // it ever reached that contract's waiting fire.
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL }));
    engine.defineContract(
      contract("test.light", { endsOn: ENDS_ON, weight: WEIGHT.CHATTER, queueable: true, frame: NO_FRAME }),
    );
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised"); // the open tick in flight: no word heard, so the end stops it silently
    engine.fire("test.light"); // waits behind the playing line
    expect(played()).toEqual([TICK_OPEN]);
    expect(voiceBus().waiting.map((w) => w.id)).toEqual(["test.light"]);

    bus.publishEvent("pitLane.exited");

    expect(played()).toEqual([TICK_OPEN]);
    expect(voiceBus().playingId).toBeNull();
    expect(voiceBus().waiting).toEqual([]);
    expect(endedLines()).toEqual([
      'Scenario "test.light" ended by pitLane.exited (waiting)',
      'Scenario "test.ends" ended by pitLane.exited (playing → silent)',
    ]);

    flush();
    expect(played()).toEqual([TICK_OPEN]);
  });

  it("playing fires on two buses are ended in contract table order, not bus order (#1514)", () => {
    // The radar contract is registered first, but the Voice bus is used
    // first: a pass that walked buses outside and contracts inside would end
    // the Voice line first, and the debug lines would swap.
    engine.defineContract(
      contract("test.radar", { endsOn: ENDS_ON, channel: AudioChannel.Radar, bus: AudioBus.Alerts, frame: NO_FRAME }),
    );
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    startEndsMidBody();
    engine.fire("test.radar");
    expect(played()).toEqual([TICK_OPEN, BODY_A, RADAR]);

    bus.publishEvent("pitLane.exited");

    expect(endedLines()).toEqual([
      'Scenario "test.radar" ended by pitLane.exited (playing → silent)',
      'Scenario "test.ends" ended by pitLane.exited (playing → tail)',
    ]);
  });

  it("waiting fires on two buses are removed in contract table order, not bus order (#1514)", () => {
    engine.defineContract(
      contract("test.radar", {
        endsOn: ENDS_ON,
        channel: AudioChannel.Radar,
        bus: AudioBus.Alerts,
        queueable: true,
        frame: NO_FRAME,
      }),
    );
    engine.defineContract(
      contract("test.heavy", { channel: AudioChannel.Radar, bus: AudioBus.Alerts, frame: NO_FRAME }),
    );
    engine.defineContract(endsContract({ weight: WEIGHT.NORMAL }));
    engine.defineContract(contract("test.light", { weight: WEIGHT.CHATTER, frame: NO_FRAME }));
    engine.setScripts(new Map([["default", script()]]));

    // The Voice bus first: the light line plays and the ended contract waits behind it.
    engine.fire("test.light");
    bus.publishEvent("flag.green.raised");
    // Then the Alerts bus: the heavy line plays and the radar contract waits behind it.
    engine.fire("test.heavy");
    engine.fire("test.radar");
    expect(voiceBus().waiting.map((w) => w.id)).toEqual(["test.ends"]);
    expect(
      engine
        .describeState()
        .buses.find((b) => b.bus === "Alerts")
        ?.waiting.map((w) => w.id),
    ).toEqual([
      "test.radar",
    ]);

    bus.publishEvent("pitLane.exited");

    const dropped = mockLogger.debug.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.endsWith("dropped — ended"));
    expect(dropped).toEqual(['Scenario "test.radar" dropped — ended', 'Scenario "test.ends" dropped — ended']);
    expect(endedLines()).toEqual([
      'Scenario "test.radar" ended by pitLane.exited (waiting)',
      'Scenario "test.ends" ended by pitLane.exited (waiting)',
    ]);
  });

  it("contracts() reports endsOn description, null when absent", () => {
    engine.defineContract(endsContract());
    engine.defineContract(contract("test.light"));

    expect(engine.contracts().map((c) => [c.id, c.endsOn])).toEqual([
      ["test.ends", "The car leaves pit road."],
      ["test.light", null],
    ]);
  });

  it("contracts() reports the endsOn event beside the trigger event, null when absent (#1499)", () => {
    engine.defineContract(endsContract());
    engine.defineContract(contract("test.light"));

    expect(engine.contracts().map((c) => [c.id, c.event, c.endsOnEvent])).toEqual([
      ["test.ends", "flag.green.raised", "pitLane.exited"],
      ["test.light", null, null],
    ]);
  });
});
