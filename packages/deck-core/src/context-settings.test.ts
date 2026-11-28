import type { ILogger } from "@iracedeck/logger";
import { describe, expect, it, vi } from "vitest";

import { ContextSettings, type ContextSettingsUpdater } from "./context-settings.js";
import type { IDeckActionContext, IDeckEvent } from "./types.js";

type MockLogger = ILogger & { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

function createLogger(): MockLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as MockLogger;
}

type SetSettings = (settings: Record<string, unknown>) => Promise<void>;

/** A fake action context whose `setSettings` records every write. */
function fakeAction(id: string, setSettings = vi.fn<SetSettings>(async () => undefined)) {
  const action: IDeckActionContext = {
    id,
    setImage: async () => undefined,
    setTitle: async () => undefined,
    setSettings,
    isKey: () => true,
    isDial: () => false,
    setFeedback: async () => undefined,
    setFeedbackLayout: async () => undefined,
    setTriggerDescription: async () => undefined,
    dialCanvas: () => null,
    setDialCanvas: async () => undefined,
  };

  return { action, setSettings };
}

/** An event for `action` carrying `settings`, superseded when `superseded()` says so. */
function event(
  action: IDeckActionContext,
  settings: unknown,
  superseded?: () => boolean,
): IDeckEvent<Record<string, unknown>> {
  return {
    action,
    payload: { settings: settings as Record<string, unknown> },
    ...(superseded ? { isSuperseded: superseded } : {}),
  };
}

const addMarker: ContextSettingsUpdater = (s) => (s.marker === 1 ? undefined : { ...s, marker: 1 });

describe("ContextSettings", () => {
  describe("the record", () => {
    it("starts at the appear's settings, is replaced by a settings change and dropped on disappear", async () => {
      const settings = new ContextSettings();
      const { action } = fakeAction("ctx");

      expect(settings.get("ctx")).toBeUndefined();

      settings.appear(event(action, { mode: "a" }));

      expect(settings.get("ctx")).toEqual({ mode: "a" });

      await settings.receive(event(action, { mode: "b" }));

      expect(settings.get("ctx")).toEqual({ mode: "b" });

      settings.disappear("ctx");

      expect(settings.get("ctx")).toBeUndefined();
    });

    it("is kept per context", () => {
      const settings = new ContextSettings();

      settings.appear(event(fakeAction("a").action, { mode: "a" }));
      settings.appear(event(fakeAction("b").action, { mode: "b" }));
      settings.disappear("a");

      expect(settings.get("a")).toBeUndefined();
      expect(settings.get("b")).toEqual({ mode: "b" });
    });

    it("records settings that are not an object as none", () => {
      const settings = new ContextSettings();

      settings.appear(event(fakeAction("ctx").action, undefined));

      expect(settings.get("ctx")).toEqual({});
    });
  });

  describe("update", () => {
    it("writes what the updater computes from the record, not from the event's payload", async () => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, { mode: "a" }));
      await settings.update(event(action, {}), (s) => ({ ...s, stamped: true }));

      // The event's own payload is stale and empty; the write carries the record.
      const written = await settings.update(event(action, { stale: true }), addMarker);

      expect(written).toBe(true);
      expect(setSettings).toHaveBeenLastCalledWith({ mode: "a", stamped: true, marker: 1 });
      expect(settings.get("ctx")).toEqual({ mode: "a", stamped: true, marker: 1 });
    });

    it("hands the updater the record itself, read-only, and never the event's payload", async () => {
      const settings = new ContextSettings();
      const { action } = fakeAction("ctx");
      const seen: unknown[] = [];

      settings.appear(event(action, { mode: "a" }));
      await settings.update(event(action, { mode: "stale" }), (s) => {
        seen.push(s);

        return undefined;
      });

      expect(seen).toEqual([{ mode: "a" }]);
    });

    it("writes nothing and resolves false when the updater returns undefined", async () => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, { marker: 1 }));

      await expect(settings.update(event(action, {}), addMarker)).resolves.toBe(false);
      expect(setSettings).not.toHaveBeenCalled();
    });

    it.each([
      ["never appeared", (s: ContextSettings) => s],
      [
        "has disappeared",
        (s: ContextSettings) => {
          s.appear(event(fakeAction("ctx").action, {}));
          s.disappear("ctx");

          return s;
        },
      ],
    ])("writes nothing for a context that %s, logged at debug", async (_case, prepare) => {
      const logger = createLogger();
      const settings = prepare(new ContextSettings(logger));
      const { action, setSettings } = fakeAction("ctx");
      const updater = vi.fn(addMarker);

      await expect(settings.update(event(action, {}), updater)).resolves.toBe(false);
      expect(updater).not.toHaveBeenCalled();
      expect(setSettings).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("ctx skipped: it has no settings record"));
    });

    it("sets the record before the write is awaited, so two writes in one tick both reach the host", async () => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, {}));

      const first = settings.update(event(action, {}), (s) => ({ ...s, a: 1 }));

      expect(settings.get("ctx")).toEqual({ a: 1 });

      const second = settings.update(event(action, {}), (s) => ({ ...s, b: 2 }));

      await Promise.all([first, second]);

      expect(setSettings.mock.calls.map(([s]) => s)).toEqual([{ a: 1 }, { a: 1, b: 2 }]);
    });

    it("on a rejected write warns, keeps the record, resolves false, and the next write carries the change", async () => {
      const logger = createLogger();
      const settings = new ContextSettings(logger);
      const setSettings = vi.fn<SetSettings>().mockRejectedValueOnce(new Error("socket closed"));
      const { action } = fakeAction("ctx", setSettings);

      setSettings.mockResolvedValue(undefined);
      settings.appear(event(action, {}));

      await expect(settings.update(event(action, {}), (s) => ({ ...s, a: 1 }))).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to write settings for ctx"));
      expect(settings.get("ctx")).toEqual({ a: 1 });

      await expect(settings.update(event(action, {}), (s) => ({ ...s, b: 2 }))).resolves.toBe(true);
      expect(setSettings).toHaveBeenLastCalledWith({ a: 1, b: 2 });
    });

    it("lets an updater's own throw reach the caller and writes nothing", async () => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, { mode: "a" }));

      await expect(
        settings.update(event(action, {}), () => {
          throw new Error("bad updater");
        }),
      ).rejects.toThrow("bad updater");
      expect(setSettings).not.toHaveBeenCalled();
      expect(settings.get("ctx")).toEqual({ mode: "a" });
    });
  });

  describe("a superseded write", () => {
    it("is parked, not written, and the record is left alone", async () => {
      const logger = createLogger();
      const settings = new ContextSettings(logger);
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, { mode: "a" }));

      await expect(
        settings.update(
          event(action, {}, () => true),
          addMarker,
        ),
      ).resolves.toBe(false);
      expect(setSettings).not.toHaveBeenCalled();
      expect(settings.get("ctx")).toEqual({ mode: "a" });
      expect(settings.parkedCount).toBe(1);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("ctx parked"));
    });

    it("is written when its isSuperseded says false", async () => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, {}));

      await expect(
        settings.update(
          event(action, {}, () => false),
          addMarker,
        ),
      ).resolves.toBe(true);
      expect(setSettings).toHaveBeenCalledWith({ marker: 1 });
    });

    it("is re-run on the newer settings when they are received, in the order parked", async () => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, { mode: "a" }));
      await settings.update(
        event(action, {}, () => true),
        (s) => ({ ...s, first: 1 }),
      );
      await settings.update(
        event(action, {}, () => true),
        (s) => ({ ...s, second: 2 }),
      );

      await settings.receive(event(action, { mode: "b" }));

      expect(setSettings.mock.calls.map(([s]) => s)).toEqual([
        { mode: "b", first: 1 },
        { mode: "b", first: 1, second: 2 },
      ]);
      expect(settings.get("ctx")).toEqual({ mode: "b", first: 1, second: 2 });
      expect(settings.parkedCount).toBe(0);
    });

    it("whose updater finds its change in the newer settings writes nothing on the re-run", async () => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, {}));
      await settings.update(
        event(action, {}, () => true),
        addMarker,
      );
      await settings.receive(event(action, { marker: 1 }));

      expect(setSettings).not.toHaveBeenCalled();
      expect(settings.parkedCount).toBe(0);
    });

    it("parks again when the settings event it is re-run on is itself superseded", async () => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");

      settings.appear(event(action, {}));
      await settings.update(
        event(action, {}, () => true),
        addMarker,
      );
      await settings.receive(event(action, { mode: "b" }, () => true));

      expect(setSettings).not.toHaveBeenCalled();
      expect(settings.parkedCount).toBe(1);

      await settings.receive(event(action, { mode: "c" }));

      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ mode: "c", marker: 1 });
    });

    it.each([
      ["a disappear", (s: ContextSettings, action: IDeckActionContext) => s.disappear(action.id)],
      ["a re-appear", (s: ContextSettings, action: IDeckActionContext) => s.appear(event(action, {}))],
    ])("is dropped by %s, never re-run on a later settings change", async (_case, drop) => {
      const settings = new ContextSettings();
      const { action, setSettings } = fakeAction("ctx");
      const updater = vi.fn(addMarker);

      settings.appear(event(action, {}));
      await settings.update(
        event(action, {}, () => true),
        updater,
      );
      drop(settings, action);

      expect(settings.parkedCount).toBe(0);

      settings.appear(event(action, {}));
      await settings.receive(event(action, { mode: "b" }));

      expect(updater).toHaveBeenCalledOnce();
      expect(setSettings).not.toHaveBeenCalled();
    });

    it("is kept per context: another context's settings change re-runs nothing", async () => {
      const settings = new ContextSettings();
      const first = fakeAction("a");
      const second = fakeAction("b");

      settings.appear(event(first.action, {}));
      settings.appear(event(second.action, {}));
      await settings.update(
        event(first.action, {}, () => true),
        addMarker,
      );
      await settings.receive(event(second.action, { mode: "b" }));

      expect(first.setSettings).not.toHaveBeenCalled();
      expect(second.setSettings).not.toHaveBeenCalled();
      expect(settings.parkedCount).toBe(1);
    });

    it("whose updater throws on the re-run is warned, and the others still run", async () => {
      const logger = createLogger();
      const settings = new ContextSettings(logger);
      const { action, setSettings } = fakeAction("ctx");
      let calls = 0;
      const throwsOnRerun: ContextSettingsUpdater = (s) => {
        calls += 1;

        if (calls > 1) throw new Error("bad updater");

        return { ...s, a: 1 };
      };

      settings.appear(event(action, {}));
      await settings.update(
        event(action, {}, () => true),
        throwsOnRerun,
      );
      await settings.update(
        event(action, {}, () => true),
        addMarker,
      );

      await expect(settings.receive(event(action, {}))).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("A parked settings write for ctx failed"));
      expect(setSettings).toHaveBeenCalledExactlyOnceWith({ marker: 1 });
    });
  });

  it("reads the logger through a function at each line, for an owner whose logger is replaced", async () => {
    const first = createLogger();
    const second = createLogger();
    let current: ILogger = first;
    const settings = new ContextSettings(() => current);

    current = second;
    await settings.update(event(fakeAction("ctx").action, {}), addMarker);

    expect(first.debug).not.toHaveBeenCalled();
    expect(second.debug).toHaveBeenCalledOnce();
  });
});
