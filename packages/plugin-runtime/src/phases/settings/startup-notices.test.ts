import { silentLogger } from "@iracedeck/logger";
import { FIRST_RUN_VERSION_KEY, GETTING_STARTED_PANE } from "@iracedeck/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder, stub } from "../../test-support/recorder.js";
import { createStartupNotices, type OpenSettingsWindow } from "./startup-notices.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/app-updates", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/deck-iracing", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/settings-window", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/iracing-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);

/** A deferred promise, to hold a check open while a second entry point fires. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });

  return { promise, resolve };
}

/** Let every pending promise callback run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function build() {
  return createStartupNotices({ core: stub("core"), logger: silentLogger });
}

/** Count how often each check ran. */
function checks(): { firstRun: number; version: number } {
  return {
    firstRun: callLog.filter((n) => n === "runFirstRunCheck").length,
    version: callLog.filter((n) => n === "runVersionCheck").length,
  };
}

describe("createStartupNotices (#1377)", () => {
  let opened: unknown[];
  let open: OpenSettingsWindow;

  beforeEach(() => {
    resetRecorder();
    opened = [];
    open = (options) => {
      opened.push(options);

      return Promise.resolve(true);
    };
    implement("getGlobalSettings", () => ({}));
    implement("runFirstRunCheck", () => Promise.resolve(false));
    implement("runVersionCheck", () => Promise.resolve());
  });

  it("does nothing until armed: nothing meaningful to compare before the store settles", async () => {
    const notices = build();

    await notices.run();

    expect(callLog).toEqual([]);
  });

  it("runs the first-run check, then the changelog check when the first run declines the start", async () => {
    const notices = build();
    notices.arm(open);

    await notices.run();

    expect(callLog.filter((n) => n.startsWith("run"))).toEqual(["runFirstRunCheck", "runVersionCheck"]);
  });

  it("skips the changelog check when the first run consumes the start (#1061)", async () => {
    implement("runFirstRunCheck", () => Promise.resolve(true));
    const notices = build();
    notices.arm(open);

    await notices.run();

    expect(checks()).toEqual({ firstRun: 1, version: 0 });
  });

  it("opens Getting Started through the opener it was armed with", async () => {
    const seen: Record<string, unknown>[] = [];
    implement("runFirstRunCheck", (deps) => {
      seen.push(deps as Record<string, unknown>);

      return Promise.resolve(true);
    });
    const notices = build();
    notices.arm(open);

    await notices.run();
    await (seen[0].openGettingStarted as () => Promise<unknown>)();

    expect(opened).toEqual([{ pane: GETTING_STARTED_PANE }]);
  });

  it("serialises overlapping runs into one, and starts afresh once it has settled", async () => {
    const firstRun = deferred<boolean>();
    implement("runFirstRunCheck", () => firstRun.promise);
    const notices = build();
    notices.arm(open);

    const a = notices.run();
    const b = notices.run();

    expect(b).toBe(a);
    firstRun.resolve(true);
    await a;
    expect(checks()).toEqual({ firstRun: 1, version: 0 });

    implement("runFirstRunCheck", () => Promise.resolve(true));
    await notices.run();
    expect(checks()).toEqual({ firstRun: 2, version: 0 });
  });

  it("frees the slot after a failed run too", async () => {
    implement("runFirstRunCheck", () => Promise.reject(new Error("spawn failed")));
    const notices = build();
    notices.arm(open);

    await expect(notices.run()).rejects.toThrow("spawn failed");

    implement("runFirstRunCheck", () => Promise.resolve(true));
    await notices.run();
    expect(checks()).toEqual({ firstRun: 2, version: 0 });
  });

  describe("onSimExited", () => {
    async function simExit(settings: Record<string, unknown>, opensChangelog: boolean): Promise<unknown[][]> {
      const asked: unknown[][] = [];
      implement("getGlobalSettings", () => settings);
      implement("shouldOpenChangelog", (...args) => {
        asked.push(args);

        return opensChangelog;
      });
      const notices = build();
      notices.arm(open);

      notices.onSimExited();
      await flush();

      return asked;
    }

    it("re-runs while Getting Started is unresolved, without asking about the changelog (#1061)", async () => {
      const asked = await simExit({}, false);

      expect(asked).toEqual([]);
      expect(checks().firstRun).toBe(1);
    });

    it("stays quiet once resolved when no changelog is due", async () => {
      const asked = await simExit({ [FIRST_RUN_VERSION_KEY]: "1.0.0", _lastSeenVersion: "2.0.0" }, false);

      expect(asked).toHaveLength(1);
      expect(asked[0][1]).toBe("2.0.0");
      expect(checks()).toEqual({ firstRun: 0, version: 0 });
    });

    it("re-runs once resolved when a changelog is due (#870)", async () => {
      const asked = await simExit({ [FIRST_RUN_VERSION_KEY]: "1.0.0", _lastSeenVersion: 7 }, true);

      // A non-string last-seen version is passed as absent.
      expect(asked[0][1]).toBeUndefined();
      expect(checks()).toEqual({ firstRun: 1, version: 1 });
    });

    it("is a no-op before the notices are armed", async () => {
      implement("getGlobalSettings", () => ({}));
      const notices = build();

      notices.onSimExited();
      await flush();

      // Positive control: the handler did read the settings to decide.
      expect(callLog).toContain("getGlobalSettings");
      expect(checks()).toEqual({ firstRun: 0, version: 0 });
    });
  });
});
