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

beforeEach(() => {
  errorLogs = [];
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((msg: string) => errorLogs.push(msg)),
    createScope: vi.fn(),
    withLevel: vi.fn(),
  };

  engine = initializeAudioScenarios(
    { publish: vi.fn(), subscribe: vi.fn(() => () => {}), unsubscribe: vi.fn() } as never,
    {} as never,
    manifest,
    logger as never,
  );
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
