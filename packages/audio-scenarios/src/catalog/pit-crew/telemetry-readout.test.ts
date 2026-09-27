/**
 * Telemetry readout family tests (issue #466).
 *
 * Five contracts fired by `telemetryReadout.requested`, a Pit Crew key press.
 * What they SAY is the bundled voice's `callouts.json`, so the fire-through
 * cases hand the real artifact to the engine and read what played. The
 * scheduling cases pin the contract options the spec's behaviour needs:
 * queue behind whatever plays, never cut a playing readout, a newer readout
 * replaces a waiting one — and the engine's one-slot limit that drops a
 * readout behind a heavier waiting fire.
 */
import manifestJson from "@iracedeck/audio-assets/manifest.json" with { type: "json" };
import defaultScript from "@iracedeck/audio-assets/voice/default/callouts.json" with { type: "json" };
import type { IAudioService } from "@iracedeck/audio-service";
import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { type CalloutScript, collectScriptReferences } from "@iracedeck/callout-script";
import type { IEventBus, SimEventMap, SimEventName, SimEventOf, TelemetryReadoutRequest } from "@iracedeck/event-bus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScenarioContext } from "../../dsl.js";
import { NO_FRAME, WEIGHT } from "../../dsl.js";
import type { AudioAssetsManifest, IScenarioEngine } from "../../interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios, poolMemberPattern } from "../../interpreter.js";
import { descriptionNamesGroup } from "../../reference/pack-reference.js";
import {
  registerTelemetryReadoutVocabulary,
  resolveDegreesUnit,
  resolveFuelDecimal,
  resolveFuelNumber,
  resolveLaps,
  resolveTempNumber,
  splitFuelFigure,
  TELEMETRY_READOUT_CLIP_SOURCES,
  TELEMETRY_READOUT_CONTRACTS,
  TELEMETRY_READOUT_SCENARIO_IDS,
} from "./telemetry-readout.js";

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
        telemetry: null,
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
  }
}

const VOICE = "luca";

/** Two stand-in lines for the scheduling cases: a line holding the bus, and a heavier queueable one waiting. */
const BUSY_CLIP = `voice/${VOICE}/spotter/car-left-01.mp3`;
const WAITING_CLIP = `voice/${VOICE}/spotter/car-right-01.mp3`;

/** One clip per readout line and every figure a readout can speak, for the test voice. */
const manifest: AudioAssetsManifest = {
  clips: [
    "sfx/IRD-tick-open.mp3",
    "sfx/IRD-tick-close.mp3",
    "sfx/IRD-ambient-pit.mp3",
    ...TELEMETRY_READOUT_CLIP_SOURCES.map(({ group, base }) => `voice/${VOICE}/${group}/${base}-01.mp3`),
    ...Array.from({ length: 121 }, (_, n) => `voice/${VOICE}/numbers-fuel/${n}.mp3`),
    ...["liters", "gallons"].flatMap((u) =>
      Array.from({ length: 10 }, (_, d) => `voice/${VOICE}/numbers-fuel-decimal/${u}-${d}.mp3`),
    ),
    ...Array.from({ length: 20 }, (_, i) => `voice/${VOICE}/readout-laps/${i + 1}.mp3`),
    ...Array.from({ length: 21 }, (_, i) => `voice/${VOICE}/numbers-degrees/minus${i}.mp3`).slice(1),
    ...Array.from({ length: 177 }, (_, n) => `voice/${VOICE}/numbers-degrees/${n}.mp3`),
    BUSY_CLIP,
    WAITING_CLIP,
  ],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

/** The bundled voice's script. The JSON import types `schema` as `number`, hence the cast. */
const SCRIPT = defaultScript as CalloutScript;

/** The bundled script narrowed to the entries this file's engine holds; an entry for an unregistered contract would warn. */
const READOUT_SCRIPT: CalloutScript = {
  ...SCRIPT,
  scenarios: Object.fromEntries(TELEMETRY_READOUT_SCENARIO_IDS.map((id) => [id, SCRIPT.scenarios[id]])),
  fragments: {},
};

let bus: ReturnType<typeof createMockBus>;
let audio: FakeAudio;
let engine: IScenarioEngine;

beforeEach(() => {
  bus = createMockBus();
  audio = createFakeAudio();
  engine = initializeAudioScenarios(bus, audio, manifest, mockLogger as never, () => VOICE);

  registerTelemetryReadoutVocabulary(engine);

  for (const c of TELEMETRY_READOUT_CONTRACTS) engine.defineContract(c);

  // Stand-ins for "something else is on the radio": a line holding the bus
  // above a readout, and a heavier queueable line that can wait in the slot.
  engine.defineScenario({
    id: "test.busy",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.CRITICAL,
    frame: NO_FRAME,
    sequence: ["spotter/car-left-01.mp3"],
  });
  engine.defineScenario({
    id: "test.waiting",
    channel: AudioChannel.Voice,
    bus: AudioBus.Voice,
    base: "voice/{voice}",
    weight: WEIGHT.SAFETY,
    queueable: true,
    frame: NO_FRAME,
    sequence: ["spotter/car-right-01.mp3"],
  });

  engine.setScripts(new Map([[VOICE, READOUT_SCRIPT]]));
});

afterEach(() => {
  _resetAudioScenarios();
  vi.clearAllMocks();
});

function request(partial: Partial<TelemetryReadoutRequest>): TelemetryReadoutRequest {
  return { kind: "fuel-last-lap", value: 2.44, unit: "liters", laps: null, ...partial };
}

/** A fire context carrying `data` as a `telemetryReadout.requested` event — or another event, or none. */
function ctxOf(data: unknown, event: SimEventName | null = "telemetryReadout.requested"): ScenarioContext {
  return {
    event: event === null ? null : ({ event, timestamp: 0, telemetry: null, data } as SimEventOf<SimEventName>),
    telemetry: null,
    data: event === null ? null : data,
    now: 0,
    vars: {},
  };
}

function voiceClipsPlayed(): string[] {
  return audio._played.filter((p) => p.channel === AudioChannel.Voice).map((p) => p.path);
}

const line = (base: string): string => `voice/${VOICE}/telemetry-readout/${base}-01.mp3`;
const fuel = (n: number): string => `voice/${VOICE}/numbers-fuel/${n}.mp3`;
const tail = (key: string): string => `voice/${VOICE}/numbers-fuel-decimal/${key}.mp3`;
const laps = (n: number): string => `voice/${VOICE}/readout-laps/${n}.mp3`;
const deg = (name: string): string => `voice/${VOICE}/numbers-degrees/${name}.mp3`;

describe("TELEMETRY_READOUT_CONTRACTS structure (issue #466)", () => {
  it("exports the five readout contracts", () => {
    expect(TELEMETRY_READOUT_SCENARIO_IDS).toEqual([
      "pit-crew.readout-fuel-last-lap",
      "pit-crew.readout-fuel-average",
      "pit-crew.readout-track-temp",
      "pit-crew.readout-air-temp",
      "pit-crew.readout-no-data",
    ]);
  });

  it("fires on telemetryReadout.requested on the voice bus, queueable at the default weight and frame, in no family, carrying no sequence", () => {
    for (const c of TELEMETRY_READOUT_CONTRACTS) {
      expect(c.when?.event, c.id).toBe("telemetryReadout.requested");
      expect(c.channel, c.id).toBe(AudioChannel.Voice);
      expect(c.bus, c.id).toBe(AudioBus.Voice);
      expect(c.base, c.id).toBe("voice/{voice}");
      expect(c.queueable, c.id).toBe(true);
      expect(c.weight, c.id).toBeUndefined();
      expect(c.family, c.id).toBeUndefined();
      expect(c.interrupt, c.id).toBeUndefined();
      expect(c.queueBehind, c.id).toBeUndefined();
      expect(c.frame, c.id).toBeUndefined();
      expect("sequence" in c, c.id).toBe(false);
    }
  });

  it("describes when each fires in one sentence for a pack author", () => {
    for (const c of TELEMETRY_READOUT_CONTRACTS) {
      expect(c.description?.trim().endsWith("."), c.id).toBe(true);
      expect((c.description ?? "").length, c.id).toBeLessThanOrEqual(200);
    }
  });
});

describe("each kind reaches exactly its own contract", () => {
  const firing = (data: TelemetryReadoutRequest): string[] =>
    TELEMETRY_READOUT_CONTRACTS.filter((c) =>
      c.when?.where?.({ event: "telemetryReadout.requested", timestamp: 0, telemetry: null, data } as never),
    ).map((c) => c.id);

  it.each([
    [request({ kind: "fuel-last-lap", value: 2.4 }), ["pit-crew.readout-fuel-last-lap"]],
    [request({ kind: "fuel-average", value: 2.4, laps: 5 }), ["pit-crew.readout-fuel-average"]],
    [request({ kind: "track-temp", value: 41, unit: "celsius" }), ["pit-crew.readout-track-temp"]],
    [request({ kind: "air-temp", value: 73.4, unit: "fahrenheit" }), ["pit-crew.readout-air-temp"]],
    [request({ kind: "fuel-last-lap", value: null }), ["pit-crew.readout-no-data"]],
    [request({ kind: "fuel-average", value: null, laps: null }), ["pit-crew.readout-no-data"]],
    [request({ kind: "track-temp", value: null, unit: "celsius" }), []],
    [request({ kind: "air-temp", value: Number.NaN, unit: "celsius" }), []],
  ])("%o → %o", (data, ids) => {
    expect(firing(data)).toEqual(ids);
  });

  it("an unknown kind or a malformed payload reaches none", () => {
    expect(firing({ kind: "oil-temp", value: 90, unit: "celsius", laps: null } as never)).toEqual([]);
    expect(firing(null as never)).toEqual([]);
  });
});

describe("splitFuelFigure — rounds once, to a tenth, before the split", () => {
  it.each([
    [2.44, 2, 4],
    [2.45, 2, 5],
    [0.04, 0, 0],
    [0.96, 1, 0],
    [120.9, 120, 9],
    [120.96, 121, 0],
  ])("%d → %d point %d", (value, whole, tenth) => {
    expect(splitFuelFigure(value)).toEqual({ whole, tenth });
  });

  it("refuses what no clip name can express — a negative or non-finite figure", () => {
    expect(splitFuelFigure(-0.5)).toBeNull();
    expect(splitFuelFigure(Number.NaN)).toBeNull();
    expect(splitFuelFigure(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("the readout resolvers read the fire's own event", () => {
  it("speaks the whole part from numbers-fuel and the tenth plus unit from numbers-fuel-decimal", () => {
    const ctx = ctxOf(request({ value: 2.44, unit: "liters" }));

    expect(resolveFuelNumber(ctx)).toBe("pool:numbers-fuel/2");
    expect(resolveFuelDecimal(ctx)).toBe("pool:numbers-fuel-decimal/liters-4");
  });

  it("names the gallons tail for an imperial figure", () => {
    const ctx = ctxOf(request({ value: 0.64, unit: "gallons" }));

    expect(resolveFuelNumber(ctx)).toBe("pool:numbers-fuel/0");
    expect(resolveFuelDecimal(ctx)).toBe("pool:numbers-fuel-decimal/gallons-6");
  });

  it("names the lap count from readout-laps, 1 and 20 alike", () => {
    expect(resolveLaps(ctxOf(request({ kind: "fuel-average", laps: 1 })))).toBe("pool:readout-laps/1");
    expect(resolveLaps(ctxOf(request({ kind: "fuel-average", laps: 20 })))).toBe("pool:readout-laps/20");
    expect(resolveLaps(ctxOf(request({ kind: "fuel-average", laps: 0 })))).toBeNull();
    expect(resolveLaps(ctxOf(request({ kind: "fuel-average", laps: 2.5 })))).toBeNull();
  });

  it("speaks temperatures through the shared numbers-degrees rule, negatives spelled minus<N>", () => {
    expect(resolveTempNumber(ctxOf(request({ kind: "track-temp", value: 41.3, unit: "celsius" })))).toBe(
      "pool:numbers-degrees/41",
    );
    expect(resolveTempNumber(ctxOf(request({ kind: "air-temp", value: -4.4, unit: "celsius" })))).toBe(
      "pool:numbers-degrees/minus4",
    );
    expect(resolveDegreesUnit(ctxOf(request({ kind: "air-temp", value: 73, unit: "fahrenheit" })))).toBe(
      "pool:session-start/unit-fahrenheit",
    );
  });

  it("keeps fuel and temperature vocabularies apart — neither speaks the other's payload", () => {
    const temp = ctxOf(request({ kind: "track-temp", value: 41, unit: "celsius" }));
    const fuelCtx = ctxOf(request({ value: 2.4, unit: "liters" }));

    expect(resolveFuelNumber(temp)).toBeNull();
    expect(resolveFuelDecimal(temp)).toBeNull();
    expect(resolveTempNumber(fuelCtx)).toBeNull();
    expect(resolveDegreesUnit(fuelCtx)).toBeNull();
  });

  it("answers nothing for an imperative fire or a fire of another event", () => {
    for (const ctx of [ctxOf(null, null), ctxOf(request({}), "tireWear.reported")]) {
      expect(resolveFuelNumber(ctx)).toBeNull();
      expect(resolveFuelDecimal(ctx)).toBeNull();
      expect(resolveLaps(ctx)).toBeNull();
      expect(resolveTempNumber(ctx)).toBeNull();
      expect(resolveDegreesUnit(ctx)).toBeNull();
    }
  });
});

describe("registerTelemetryReadoutVocabulary (issue #466)", () => {
  it("publishes the five readout vars, each with a one-sentence description", () => {
    const vars = engine.vocabulary().vars.filter((v) => v.name.startsWith("readout."));

    expect(vars.map((v) => v.name)).toEqual([
      "readout.degreesUnit",
      "readout.fuelDecimal",
      "readout.fuelNumber",
      "readout.laps",
      "readout.tempNumber",
    ]);

    for (const v of vars) expect(v.description.trim().endsWith("."), v.name).toBe(true);
  });

  it("names the clip group each var draws from — and only that one — so the recording script attributes the lines (#1066)", () => {
    const descriptionOf = (name: string): string =>
      engine.vocabulary().vars.find((v) => v.name === name)?.description ?? "";

    expect(descriptionNamesGroup(descriptionOf("readout.fuelNumber"), "numbers-fuel")).toBe(true);
    expect(descriptionNamesGroup(descriptionOf("readout.fuelDecimal"), "numbers-fuel-decimal")).toBe(true);
    expect(descriptionNamesGroup(descriptionOf("readout.fuelDecimal"), "numbers-fuel")).toBe(false);
    expect(descriptionNamesGroup(descriptionOf("readout.laps"), "readout-laps")).toBe(true);
    expect(descriptionNamesGroup(descriptionOf("readout.tempNumber"), "numbers-degrees")).toBe(true);
    expect(descriptionNamesGroup(descriptionOf("readout.degreesUnit"), "session-start")).toBe(true);
  });
});

describe("the readouts fire through the bundled script (issue #466)", () => {
  it("fuel last lap: intro, whole figure, unit-bearing tenth — inside the radio frame", () => {
    bus.publishEvent("telemetryReadout.requested", request({ value: 2.44, unit: "liters" }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([line("fuel-last-lap-intro"), fuel(2), tail("liters-4")]);

    const all = audio._played.map((p) => p.path);

    expect(all[0]).toBe("sfx/IRD-tick-open.mp3");
    expect(all.at(-1)).toBe("sfx/IRD-tick-close.mp3");
  });

  it("fuel last lap in gallons", () => {
    bus.publishEvent("telemetryReadout.requested", request({ value: 0.64, unit: "gallons" }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([line("fuel-last-lap-intro"), fuel(0), tail("gallons-6")]);
  });

  it("fuel average names the laps actually averaged before the figure", () => {
    bus.publishEvent("telemetryReadout.requested", request({ kind: "fuel-average", value: 2.51, laps: 3 }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([line("fuel-average-intro"), laps(3), fuel(2), tail("liters-5")]);
  });

  it("track and air temperature: intro and the degrees figure, no unit clip", () => {
    bus.publishEvent("telemetryReadout.requested", request({ kind: "track-temp", value: 41.3, unit: "celsius" }));
    flush(audio);
    bus.publishEvent("telemetryReadout.requested", request({ kind: "air-temp", value: 73.4, unit: "fahrenheit" }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([line("track-temp-intro"), deg("41"), line("air-temp-intro"), deg("73")]);
  });

  it("no data: the no-clean-lap line for either fuel kind", () => {
    bus.publishEvent("telemetryReadout.requested", request({ kind: "fuel-last-lap", value: null }));
    flush(audio);
    bus.publishEvent("telemetryReadout.requested", request({ kind: "fuel-average", value: null }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([line("no-data"), line("no-data")]);
  });

  it("the top of the recorded range speaks; past it the callout is silent — no clamping (issue #836)", () => {
    bus.publishEvent("telemetryReadout.requested", request({ value: 120.94 }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([line("fuel-last-lap-intro"), fuel(120), tail("liters-9")]);

    audio._played.length = 0;
    bus.publishEvent("telemetryReadout.requested", request({ value: 120.96 }));
    bus.publishEvent("telemetryReadout.requested", request({ kind: "track-temp", value: 190, unit: "fahrenheit" }));
    flush(audio);

    expect(audio._played).toEqual([]);
  });

  it("an out-of-range readout never cuts the line that is playing", () => {
    bus.publishEvent("telemetryReadout.requested", request({ kind: "track-temp", value: 41, unit: "celsius" }));
    bus.publishEvent("telemetryReadout.requested", request({ value: 130 }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([line("track-temp-intro"), deg("41")]);
  });

  it("a voice with no script is silent — the contract alone says nothing", () => {
    engine.setScripts(new Map());

    bus.publishEvent("telemetryReadout.requested", request({}));
    flush(audio);

    expect(audio._played).toEqual([]);
  });
});

describe("scheduling (issue #466): queue behind what plays, newest pending wins", () => {
  it("a press while another line holds the bus waits and plays after it", () => {
    engine.fire("test.busy");
    bus.publishEvent("telemetryReadout.requested", request({ value: 2.44 }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([BUSY_CLIP, line("fuel-last-lap-intro"), fuel(2), tail("liters-4")]);
  });

  it("a second press during a readout never cuts it — the second waits (no family)", () => {
    bus.publishEvent("telemetryReadout.requested", request({ kind: "track-temp", value: 41, unit: "celsius" }));
    bus.publishEvent("telemetryReadout.requested", request({ kind: "air-temp", value: 23, unit: "celsius" }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([line("track-temp-intro"), deg("41"), line("air-temp-intro"), deg("23")]);
  });

  it("a burst of presses while the bus is busy speaks only the latest readout — never a backlog", () => {
    engine.fire("test.busy");
    bus.publishEvent("telemetryReadout.requested", request({ kind: "track-temp", value: 41, unit: "celsius" }));
    bus.publishEvent("telemetryReadout.requested", request({ kind: "air-temp", value: 23, unit: "celsius" }));
    bus.publishEvent("telemetryReadout.requested", request({ value: 2.44 }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([BUSY_CLIP, line("fuel-last-lap-intro"), fuel(2), tail("liters-4")]);
  });

  it("the engine's one pending slot: a readout behind a HEAVIER waiting line is dropped (#1185's limit, documented)", () => {
    engine.fire("test.busy");
    engine.fire("test.waiting");
    bus.publishEvent("telemetryReadout.requested", request({ value: 2.44 }));
    flush(audio);

    expect(voiceClipsPlayed()).toEqual([BUSY_CLIP, WAITING_CLIP]);
  });
});

describe("the bundled script's readout entries (issue #466)", () => {
  it("scripts every contract with a comment, a Telemetry Readout harness route and a sequence", () => {
    for (const id of TELEMETRY_READOUT_SCENARIO_IDS) {
      const entry = SCRIPT.scenarios[id];

      expect(entry, `no script entry for ${id}`).toBeDefined();
      expect(entry.comment?.length ?? 0, id).toBeGreaterThan(0);
      expect(entry.test, id).toMatch(/^Harness → Telemetry Readout → /);
      expect(entry.skip, id).toBeUndefined();
      expect(entry.frame, id).toBeUndefined();
    }
  });

  it("addresses exactly the published clip sources and references only readout vars", () => {
    const refs = collectScriptReferences(READOUT_SCRIPT);

    expect([...refs.pools].sort()).toEqual(
      TELEMETRY_READOUT_CLIP_SOURCES.map(({ group, base }) => `${group}/${base}`).sort(),
    );
    expect([...refs.vars].sort()).toEqual([
      "readout.fuelDecimal",
      "readout.fuelNumber",
      "readout.laps",
      "readout.tempNumber",
    ]);
    expect(refs.conds).toEqual([]);
    expect(refs.cases).toEqual([]);
    expect(refs.includes).toEqual([]);
    expect(refs.frames).toEqual([]);
  });

  it("compiles for the test voice with nothing skipped", () => {
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  const MANIFEST: AudioAssetsManifest = manifestJson;

  it("every clip source has a clip in the bundled voice", () => {
    const missing = TELEMETRY_READOUT_CLIP_SOURCES.filter(({ group, base }) => {
      const pattern = poolMemberPattern(group, base);

      return !MANIFEST.clips.some((clip) => pattern.exec(clip)?.[1] === "default");
    }).map(({ group, base }) => `${group}/${base}`);

    expect(missing).toEqual([]);
  });

  it("the bundled voice records every figure a readout can speak: 0–120, both tails, 1–20 laps", () => {
    const clips = new Set(MANIFEST.clips);
    const expected = [
      ...Array.from({ length: 121 }, (_, n) => `numbers-fuel/${n}`),
      ...["liters", "gallons"].flatMap((u) => Array.from({ length: 10 }, (_, d) => `numbers-fuel-decimal/${u}-${d}`)),
      ...Array.from({ length: 20 }, (_, i) => `readout-laps/${i + 1}`),
    ];

    expect(expected.filter((p) => !clips.has(`voice/default/${p}.mp3`))).toEqual([]);
  });
});
