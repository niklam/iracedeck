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

const manifest: AudioAssetsManifest = {
  clips: [TICK_OPEN, TICK_CLOSE, "sfx/IRD-ambient-pit.mp3", NEVER_MIND, BODY_A, BODY_B, LIGHT, HEAVY, FAMILY, RADAR],
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

    // The body is cut mid-clip and the tail takes the bus at once.
    expect(audio._stopped).toEqual(
      expect.arrayContaining([AudioChannel.Voice, AudioChannel.SFX, AudioChannel.Ambient]),
    );
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND]);
    expect(voiceBus().playingId).toBe("test.ends");
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);

    audio._stopped.length = 0;
    audio._triggerChannelEnd(AudioChannel.SFX); // never mind ends: the ambience stops, the close tick plays
    expect(audio._stopped).toEqual([AudioChannel.Ambient]);
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE]);

    // The tail ends, the bus is released and drains what waited.
    audio._triggerChannelEnd(AudioChannel.SFX);
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND, TICK_CLOSE, LIGHT]);
    expect(played()).not.toContain(BODY_B);
  });

  it("frame without cut plays close after an end mid-body", () => {
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script(RADIO_WITHOUT_CUT)]]));

    startEndsMidBody();
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([TICK_OPEN, BODY_A, TICK_CLOSE]);
    expect(voiceBus().playingId).toBeNull();
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
    // cut fire must not have moved on to the next body clip.
    expect(played()).toEqual([TICK_OPEN, BODY_A, NEVER_MIND]);

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

  it("beeps off: the tail drops its clip beeps like open/close do", () => {
    frameOptions = { beeps: false, ambience: true };
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised");
    expect(played()).toEqual([BODY_A]); // no open tick

    audio._stopped.length = 0;
    bus.publishEvent("pitLane.exited");
    flush();

    // The tail is its ambience stop alone: no "never mind", no close tick.
    expect(played()).toEqual([BODY_A]);
    expect(audio._stopped.filter((c) => c === AudioChannel.Ambient).length).toBe(2);
    expect(voiceBus().playingId).toBeNull();
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → tail)']);
  });

  it("beeps and ambience off: an empty tail stops silently", () => {
    frameOptions = { beeps: false, ambience: false };
    engine.defineContract(endsContract());
    engine.setScripts(new Map([["default", script()]]));

    bus.publishEvent("flag.green.raised");
    bus.publishEvent("pitLane.exited");
    flush();

    expect(played()).toEqual([BODY_A]);
    expect(endedLines()).toEqual(['Scenario "test.ends" ended by pitLane.exited (playing → silent)']);
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

  it("contracts() reports endsOn description, null when absent", () => {
    engine.defineContract(endsContract());
    engine.defineContract(contract("test.light"));

    expect(engine.contracts().map((c) => [c.id, c.endsOn])).toEqual([
      ["test.ends", "The car leaves pit road."],
      ["test.light", null],
    ]);
  });
});
