import { beforeEach, describe, expect, it } from "vitest";

import { callLog, describeFirstDifference, implement, recordingModule, resetRecorder, stub } from "./recorder.js";

describe("the call recorder", () => {
  beforeEach(() => resetRecorder());

  it("logs a plain call under its name", () => {
    stub("initializeSDK")();

    expect(callLog).toEqual(["initializeSDK"]);
  });

  it("logs a call on a call's result as name().method", () => {
    stub("getAudio")().init();

    expect(callLog).toEqual(["getAudio", "getAudio().init"]);
  });

  it("logs a constructor as `new X` and an instance method as `new X().method`", () => {
    const X = stub("IRacingNative");

    new X().sendScanKeys([1]);

    expect(callLog).toEqual(["new IRacingNative", "new IRacingNative().sendScanKeys"]);
  });

  it('names an instance method the same way when `implement("new X")` returned a primitive', () => {
    implement("new AudioNative", () => 5);
    const X = stub("AudioNative");

    new X().init();

    expect(callLog).toEqual(["new AudioNative", "new AudioNative().init"]);
  });

  it("returns an implemented constructor's object as the instance", () => {
    const instance = { ready: true };
    implement("new AudioNative", () => instance);
    const X = stub("AudioNative");

    expect(new X()).toBe(instance);
  });

  it("runs an implementation with the call's arguments and still logs the call", () => {
    const seen: unknown[][] = [];
    implement("initializeAudio", (...args) => {
      seen.push(args);

      return "result";
    });

    expect(stub("initializeAudio")("a", 1)).toBe("result");
    expect(seen).toEqual([["a", 1]]);
    expect(callLog).toEqual(["initializeAudio"]);
  });

  it("implements a chained name", () => {
    implement("createVoicePackService().refresh", () => 42);

    expect(stub("createVoicePackService")().refresh()).toBe(42);
    expect(callLog).toEqual(["createVoicePackService", "createVoicePackService().refresh"]);
  });

  it("is never thenable, so awaiting a stub yields the stub itself", async () => {
    const value = stub("isSettingsStoreReady")();

    expect(value.then).toBeUndefined();
    expect(await value).toBe(value);
  });

  it("iterates as empty", () => {
    expect([...stub("list")()]).toEqual([]);
  });

  it("is a truthy function, so an unimplemented setting reads as set", () => {
    const settings = stub("getGlobalSettings")();

    expect(typeof settings.flag).toBe("function");
    expect(settings.flag === false).toBe(false);
    expect(settings.flag !== false).toBe(true);
  });

  it("resetRecorder clears the log and every implementation", () => {
    implement("initializeSDK", () => "implemented");
    stub("initializeSDK")();
    expect(callLog).toEqual(["initializeSDK"]);

    resetRecorder();

    expect(callLog).toEqual([]);
    expect(stub("initializeSDK")()).not.toBe("implemented");
  });

  it("recordingModule keeps non-function exports real and records the functions", () => {
    const actual = { KEY: "k", SCHEMA: { a: 1 }, fn: () => "real", Klass: class {} };

    const mocked = recordingModule(actual);
    (mocked.fn as () => unknown)();
    new (mocked.Klass as new () => unknown)();

    expect(mocked.KEY).toBe("k");
    expect(mocked.SCHEMA).toBe(actual.SCHEMA);
    expect(mocked.fn).not.toBe(actual.fn);
    expect(callLog).toEqual(["fn", "new Klass"]);
  });
});

describe("describeFirstDifference", () => {
  it("reports identical sequences", () => {
    expect(describeFirstDifference(["a", "b"], ["a", "b"])).toBe("identical");
  });

  it("names the first expected call that never ran when the actual list is a prefix", () => {
    expect(describeFirstDifference(["a"], ["a", "b", "c"])).toBe('the sequences agree for 1 call, then "b" never ran');
    expect(describeFirstDifference(["a", "b"], ["a", "b", "c"])).toBe(
      'the sequences agree for 2 calls, then "c" never ran',
    );
  });

  it("names the first extra call when the expected list is a prefix", () => {
    expect(describeFirstDifference(["a", "b", "c"], ["a"])).toBe('the sequences agree for 1 call, then "b" ran extra');
    expect(describeFirstDifference(["a"], [])).toBe('the sequences agree for 0 calls, then "a" ran extra');
  });

  it("names the index and both calls where the sequences first differ", () => {
    expect(describeFirstDifference(["a", "c", "b"], ["a", "b", "c"])).toBe(
      'call #1: expected "b", but "c" ran there — "c" and "b" swapped places or one moved',
    );
  });
});
