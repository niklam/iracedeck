import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createHost } from "../../test-support/fake-host.js";
import { callLog, implement, resetRecorder, stub } from "../../test-support/recorder.js";
import type { Core } from "../../types.js";
import { initSettingsStore } from "./settings-store.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/iracing-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);

function fakeCore() {
  const host = createHost();
  const core: Core = {
    host,
    adapter: host.adapter,
    binDir: host.binDir,
    logLocation: { kind: "daily", dir: tmpdir() },
    bus: stub("bus"),
    controller: stub("controller"),
    nativeAddons: { iracing: { kind: "native" }, audio: { kind: "native" } },
  };

  return { core, adapter: host.adapter };
}

describe("initSettingsStore (#1377)", () => {
  let exitListenersBefore: Set<unknown>;

  beforeEach(() => {
    resetRecorder();
    exitListenersBefore = new Set(process.listeners("exit"));
  });
  afterEach(() => {
    // Never let a flush pile up on the worker.
    for (const listener of process.listeners("exit")) {
      if (!exitListenersBefore.has(listener)) process.removeListener("exit", listener);
    }
  });
  afterAll(() => cleanupTempBinDirs());

  it("builds the file store at the resolved path, under its own scope, with the rejection banner", () => {
    const store = { path: "C:/settings.json", flushSync: () => undefined };
    const deps: Record<string, unknown>[] = [];
    implement("resolveSettingsStorePath", () => "C:/settings.json");
    implement("createSettingsFileRejectionReporter", () => "reporter");
    implement("createFileSettingsStore", (d) => {
      deps.push(d as Record<string, unknown>);

      return store;
    });
    const { core, adapter } = fakeCore();

    expect(initSettingsStore(core)).toBe(store);
    expect(deps).toHaveLength(1);
    expect(deps[0].path).toBe("C:/settings.json");
    expect(deps[0].onRejected).toBe("reporter");
    expect(adapter.scopes).toEqual(["SettingsStore"]);
  });

  it("registers the synchronous flush on the way out, right after building the store", () => {
    const registered: string[] = [];
    const on = vi.spyOn(process, "on");
    on.mockImplementation((event) => {
      registered.push(`${String(event)} after ${callLog.at(-1)}`);

      return process;
    });

    try {
      initSettingsStore(fakeCore().core);
    } finally {
      on.mockRestore();
    }

    expect(registered).toEqual(["exit after createFileSettingsStore"]);
  });

  it("flushes the store synchronously when the process exits", () => {
    initSettingsStore(fakeCore().core);
    const added = process.listeners("exit").filter((l) => !exitListenersBefore.has(l));
    callLog.length = 0;

    expect(added).toHaveLength(1);
    (added[0] as () => void)();

    expect(callLog).toEqual(["createFileSettingsStore().flushSync"]);
  });
});
