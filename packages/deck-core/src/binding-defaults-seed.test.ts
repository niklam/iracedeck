import { silentLogger } from "@iracedeck/logger";
import {
  _resetGlobalSettings,
  createMemorySettingsStore,
  initGlobalSettings,
  seedBindingDefaultsIfAbsent,
  type SettingsHost,
} from "@iracedeck/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetBindingDispatcher, initializeBindingDispatcher } from "./binding-dispatcher.js";

// The positive control for `seedBindingDefaultsIfAbsent` (#1277), which lives in
// `@iracedeck/settings` and cannot import the dispatcher (#1365). Only the native
// send is replaced: this drives the REAL binding dispatcher over the REAL
// settings cache, so a seeded value has to survive the same parse a key press
// does. `@iracedeck/settings` is deliberately NOT mocked here.
const { mockSendKeyCombination } = vi.hoisted(() => ({
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
}));

vi.mock("./keyboard-service.js", () => ({
  getKeyboard: () => ({ sendKeyCombination: mockSendKeyCombination }),
}));

function createMockAdapter(): SettingsHost {
  return {
    onDidReceiveGlobalSettings: () => {},
    setGlobalSettings: vi.fn<(settings: Record<string, unknown>) => void>(),
    getGlobalSettings: vi.fn<() => void>(),
  };
}

/** Let the async load inside initGlobalSettings settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Initialize against a settings file seeded with `initial` (issue #993). */
function initWithStore(initial: Record<string, unknown> = {}): void {
  initGlobalSettings(createMockAdapter(), silentLogger, createMemorySettingsStore(initial));
}

describe("seedBindingDefaultsIfAbsent (#1277)", () => {
  // What Camera Controls' Cycle by Track Order supplies (iracing-actions'
  // CAR_CYCLE_BINDING_DEFAULTS, read from key-bindings.json).
  const DEFAULTS = { replayControlNextCar: "V", replayControlPrevCar: "Shift+V" };

  beforeEach(() => {
    _resetGlobalSettings();
    _resetBindingDispatcher();
    mockSendKeyCombination.mockClear();
  });

  describe("positive control: the real binding dispatcher over the real cache", () => {
    it("reads both keys as missing before the seed, as set after it, and taps V / Shift+V", async () => {
      initWithStore({});
      await tick();
      const dispatcher = initializeBindingDispatcher(silentLogger);

      // The check can fail: with nothing stored both read as missing (#612) and a tap sends nothing.
      expect(dispatcher.isConfigured("replayControlNextCar")).toBe(false);
      expect(dispatcher.isConfigured("replayControlPrevCar")).toBe(false);
      expect(await dispatcher.tap("replayControlNextCar")).toBe(false);
      expect(mockSendKeyCombination).not.toHaveBeenCalled();

      seedBindingDefaultsIfAbsent(DEFAULTS, silentLogger);

      expect(dispatcher.isConfigured("replayControlNextCar")).toBe(true);
      expect(dispatcher.isConfigured("replayControlPrevCar")).toBe(true);
      expect(dispatcher.isKeyboardBound("replayControlPrevCar")).toBe(true);

      expect(await dispatcher.tap("replayControlNextCar")).toBe(true);
      expect(await dispatcher.tap("replayControlPrevCar")).toBe(true);
      expect(mockSendKeyCombination).toHaveBeenNthCalledWith(1, { key: "v", modifiers: undefined, code: "KeyV" });
      expect(mockSendKeyCombination).toHaveBeenNthCalledWith(2, { key: "v", modifiers: ["shift"], code: "KeyV" });
    });

    it("leaves a cleared binding reading as missing", async () => {
      initWithStore({ replayControlNextCar: "" });
      await tick();
      const dispatcher = initializeBindingDispatcher(silentLogger);

      seedBindingDefaultsIfAbsent(DEFAULTS, silentLogger);

      expect(dispatcher.isConfigured("replayControlNextCar")).toBe(false);
      expect(dispatcher.isConfigured("replayControlPrevCar")).toBe(true);
    });
  });
});
