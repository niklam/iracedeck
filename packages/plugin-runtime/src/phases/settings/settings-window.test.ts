import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTempBinDirs, createFakeCore } from "../../test-support/fake-host.js";
import { callLog, implement, resetRecorder, stub } from "../../test-support/recorder.js";
import { initSettingsWindow } from "./settings-window.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/diagnostics", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/settings-window", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/app-updates", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/iracing-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("../../actions.js", async () => (await import("../../test-support/module-mocks.js")).actionsMock());

/** A store whose path counts its reads, to tell an eager read from a deferred one. */
function countingStore(path: string): { readonly path: string; reads: number } {
  return {
    reads: 0,
    get path() {
      this.reads++;

      return path;
    },
  };
}

describe("initSettingsWindow (#1377)", () => {
  let handlerDeps: Record<string, unknown>[];
  let controllerOptions: Record<string, unknown>[];
  let reporterOptions: Record<string, unknown>[];

  beforeEach(() => {
    resetRecorder();
    handlerDeps = [];
    controllerOptions = [];
    reporterOptions = [];
    implement("createSettingsWindowCommandHandler", (deps) => handlerDeps.push(deps as Record<string, unknown>));
    implement("createSettingsWindowWarningReporter", (options) =>
      reporterOptions.push(options as Record<string, unknown>),
    );
    implement("createSettingsWindowController", (options) => {
      controllerOptions.push(options as Record<string, unknown>);

      return stub("controller");
    });
  });
  afterAll(() => cleanupTempBinDirs());

  it("builds the publisher, capture, update check, handler and controller in today's order and scopes", () => {
    const { core, adapter } = createFakeCore();

    initSettingsWindow({ core, store: { path: "C:/settings.json" }, voicePacks: stub("voicePacks") });

    expect(callLog.filter((n) => n.startsWith("create") || n.startsWith("init"))).toEqual([
      "createSettingsChannelPublisher",
      "initializeCpuProfileCapture",
      "createUpdateCheckService",
      "createSettingsWindowCommandHandler",
      "createSettingsWindowWarningReporter",
      "createSettingsWindowController",
    ]);
    expect(adapter.scopes).toEqual(["SettingsWindow", "CpuProfile", "UpdateCheck"]);
  });

  it("reads the store path at construction, for the command handler, and again for each warning", () => {
    const { core } = createFakeCore();
    const store = countingStore("C:/settings.json");

    initSettingsWindow({ core, store, voicePacks: stub("voicePacks") });

    expect(handlerDeps[0].storePath).toBe("C:/settings.json");
    expect(store.reads).toBe(1);
    expect((reporterOptions[0].getStorePath as () => string)()).toBe("C:/settings.json");
    expect(store.reads).toBe(2);
  });

  it("publishes the channel of a server that starts later, through the publisher", () => {
    const { core } = createFakeCore();
    const published: unknown[] = [];
    implement("createSettingsChannelPublisher().publish", (channel) => published.push(channel));

    const step = initSettingsWindow({ core, store: { path: "C:/settings.json" }, voicePacks: stub("voicePacks") });
    (controllerOptions[0].onStarted as (channel: unknown) => void)({ port: 2, token: "t" });

    expect(published).toEqual([{ port: 2, token: "t" }]);
    // The store-ready block publishes through the same publisher.
    callLog.length = 0;
    step.channel.publishUnavailable();
    expect(callLog).toEqual(["createSettingsChannelPublisher().publishUnavailable"]);
  });

  it("asks the catalog before opening the window (#1100), passing the options through", () => {
    const { core } = createFakeCore();
    const options: unknown[] = [];
    implement("controller.open", (o) => options.push(o));
    const step = initSettingsWindow({ core, store: { path: "C:/settings.json" }, voicePacks: stub("voicePacks") });
    callLog.length = 0;

    void step.openSettingsWindow({ pane: "getting-started" });

    expect(callLog).toEqual(["voicePacks.refreshCatalog", "controller.open"]);
    expect(options).toEqual([{ pane: "getting-started" }]);
  });
});
