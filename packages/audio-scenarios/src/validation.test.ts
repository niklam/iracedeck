import { AudioBus, AudioChannel } from "@iracedeck/audio-service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IScenarioEngine } from "./interpreter.js";
import { _resetAudioScenarios, initializeAudioScenarios } from "./interpreter.js";

const manifest = {
  clips: ["pit-crew/greeting/a.mp3", "pit-crew/connector/and.mp3"],
  ambientLoop: "sfx/IRD-ambient-pit.mp3",
  ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
};

let engine: IScenarioEngine;
let errorLogs: string[];
let warnLogs: string[];

function initEngine(m: typeof manifest): void {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((msg: string) => warnLogs.push(msg)),
    error: vi.fn((msg: string) => errorLogs.push(msg)),
    createScope: vi.fn(),
    withLevel: vi.fn(),
  };

  engine = initializeAudioScenarios(
    { publish: vi.fn(), subscribe: vi.fn(() => () => {}), unsubscribe: vi.fn() } as never,
    {} as never,
    m,
    logger as never,
  );
}

beforeEach(() => {
  errorLogs = [];
  warnLogs = [];
  initEngine(manifest);
});

afterEach(() => {
  _resetAudioScenarios();
});

describe("validateScenario", () => {
  it("flags an unknown clip", () => {
    engine.defineScenario({
      id: "bad",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pit-crew/greeting/does-not-exist.mp3"],
    });

    expect(errorLogs.join("\n")).toContain("unknown clip");
  });

  it("flags an unregistered variable", () => {
    engine.defineScenario({
      id: "bad",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["{{missing}}"],
    });

    expect(errorLogs.join("\n")).toContain("unregistered variable: {{missing}}");
  });

  it("flags an unknown pool", () => {
    engine.defineScenario({
      id: "bad",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["pool:mystery"],
    });

    expect(errorLogs.join("\n")).toContain("unknown pool: mystery");
  });

  it("flags missing connector pool", () => {
    engine.defineScenario({
      id: "bad",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: [{ connector: true }],
    });

    expect(errorLogs.join("\n")).toContain("connector pool not defined");
  });

  it("flags an include target that does not exist", () => {
    engine.defineScenario({
      id: "bad",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["@does.not.exist"],
    });

    expect(errorLogs.join("\n")).toContain("include target not found: does.not.exist");
  });

  it("flags include cycles", () => {
    engine.defineScenario({
      id: "a",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["@b"],
    });
    engine.defineScenario({
      id: "b",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      sequence: ["@a"],
    });

    expect(errorLogs.join("\n")).toContain("include cycle");
  });

  it("rejects a pool that references unknown clips", () => {
    engine.definePool("bad-pool", ["nonexistent.mp3"]);

    expect(errorLogs.join("\n")).toContain("unknown clips");
  });

  it("flags resumable without queueable (issue #758)", () => {
    engine.defineScenario({
      id: "bad",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      resumable: true,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    expect(errorLogs.join("\n")).toContain("resumable requires queueable: true");
  });

  it("accepts resumable when queueable is set (issue #758)", () => {
    engine.defineScenario({
      id: "good-resumable",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      queueable: true,
      resumable: true,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    expect(errorLogs).toEqual([]);
  });

  it("flags a negative pendingHoldMs (issue #758)", () => {
    engine.defineScenario({
      id: "bad",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      pendingHoldMs: -1,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    expect(errorLogs.join("\n")).toContain("pendingHoldMs must be a non-negative number");
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("flags a non-finite pendingHoldMs: %s (issue #758)", (_label, value) => {
    engine.defineScenario({
      id: "bad",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      pendingHoldMs: value,
      sequence: ["pit-crew/greeting/a.mp3"],
    });

    expect(errorLogs.join("\n")).toContain("pendingHoldMs must be a non-negative number");
  });

  it("accepts a valid scenario", () => {
    engine.definePool("connector", ["pit-crew/connector/and.mp3"]);
    engine.defineVar("name", () => "pit-crew/greeting/a.mp3");
    engine.defineScenario({
      id: "good",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "pit-crew",
      sequence: ["greeting/a.mp3", { connector: true }, "{{name}}"],
    });

    expect(errorLogs).toEqual([]);
  });
});

describe("voice-templated clip steps (issue #664)", () => {
  // `default` is the reference voice; `titan` deliberately lacks the toggle clip.
  const voicedManifest = {
    clips: ["voice/default/toggle/fuel-on-01.mp3", "voice/titan/flags/red-01.mp3"],
    ambientLoop: "sfx/IRD-ambient-pit.mp3",
    ticks: { open: "sfx/IRD-tick-open.mp3", close: "sfx/IRD-tick-close.mp3" },
  };

  beforeEach(() => {
    _resetAudioScenarios();
    initEngine(voicedManifest);
  });

  it("does not disable a scenario whose templated clip is missing for a non-reference voice", () => {
    engine.defineScenario({
      id: "toggle",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      sequence: ["toggle/fuel-on-01.mp3"],
    });

    expect(errorLogs).toEqual([]);
  });

  it("warns without disabling when the templated clip is missing for the reference voice", () => {
    engine.defineScenario({
      id: "typo",
      channel: AudioChannel.Voice,
      bus: AudioBus.Voice,
      base: "voice/{voice}",
      sequence: ["toggle/feul-on-01.mp3"],
    });

    expect(errorLogs).toEqual([]);
    expect(warnLogs.join("\n")).toContain("voice/default/toggle/feul-on-01.mp3");
  });
});
