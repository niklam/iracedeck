import { silentLogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import { MockPlatformAdapter } from "./mock-platform-adapter.js";

describe("MockPlatformAdapter", () => {
  it("readSettings returns an empty object by default", () => {
    const adapter = new MockPlatformAdapter(silentLogger);
    expect(adapter.readSettings()).toEqual({});
  });

  it("setGlobalSettings persists the payload", () => {
    const adapter = new MockPlatformAdapter(silentLogger);
    adapter.setGlobalSettings({ raceEngineerVolume: 50, pitCrewRaceEngineerEnabled: true });

    expect(adapter.readSettings()).toEqual({ raceEngineerVolume: 50, pitCrewRaceEngineerEnabled: true });
  });

  it("setGlobalSettings notifies all listeners", () => {
    const adapter = new MockPlatformAdapter(silentLogger);
    const a = vi.fn();
    const b = vi.fn();
    adapter.onDidReceiveGlobalSettings(a);
    adapter.onDidReceiveGlobalSettings(b);

    adapter.setGlobalSettings({ pitCrewRaceEngineerEnabled: false });

    expect(a).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: false });
    expect(b).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: false });
  });

  it("getGlobalSettings replays the current value to all listeners", () => {
    const adapter = new MockPlatformAdapter(silentLogger);
    adapter.setGlobalSettings({ pitCrewRaceEngineerEnabled: true });

    const callback = vi.fn();
    adapter.onDidReceiveGlobalSettings(callback);
    callback.mockClear();

    adapter.getGlobalSettings();

    expect(callback).toHaveBeenCalledWith({ pitCrewRaceEngineerEnabled: true });
  });

  it("setGlobalSettings replaces rather than merges", () => {
    const adapter = new MockPlatformAdapter(silentLogger);
    adapter.setGlobalSettings({ a: 1, b: 2 });
    adapter.setGlobalSettings({ b: 99 });

    expect(adapter.readSettings()).toEqual({ b: 99 });
  });

  it("createLogger returns a scoped logger", () => {
    const adapter = new MockPlatformAdapter(silentLogger);
    const logger = adapter.createLogger("Foo");

    expect(typeof logger.info).toBe("function");
    expect(typeof logger.createScope).toBe("function");
  });

  it("noop methods do not throw", () => {
    const adapter = new MockPlatformAdapter(silentLogger);

    expect(() => adapter.onApplicationDidLaunch(() => {})).not.toThrow();
    expect(() => adapter.onApplicationDidTerminate(() => {})).not.toThrow();
    expect(() => adapter.onPropertyInspectorDidAppear(() => {})).not.toThrow();
    expect(() => adapter.registerAction("uuid", { onWillAppear: undefined })).not.toThrow();
    expect(() => adapter.onKeyDown(() => {})).not.toThrow();
    expect(() => adapter.onDialDown(() => {})).not.toThrow();
    expect(() => adapter.onDialRotate(() => {})).not.toThrow();
    expect(() => adapter.connect()).not.toThrow();
  });
});
