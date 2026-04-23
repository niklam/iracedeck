// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import "./audio-device-select.js";

type SettingsCallback = (value: string) => void;
type SettingsHook = [() => Promise<string>, (value: string) => void];

interface MockSDPI {
  useGlobalSettings: (key: string, callback: SettingsCallback, debounceMs?: number | null) => SettingsHook;
}

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
  saves: Map<string, ReturnType<typeof vi.fn>>;
}

function installMockSDPI(): MockSDPIState {
  const state: MockSDPIState = {
    callbacks: new Map(),
    saves: new Map(),
  };

  const useGlobalSettings = (key: string, callback: SettingsCallback): SettingsHook => {
    state.callbacks.set(key, callback);
    const save = vi.fn((_value: string) => undefined);
    state.saves.set(key, save);

    return [async () => "", save];
  };

  const sdpi: MockSDPI = { useGlobalSettings };
  (window as unknown as Record<string, unknown>).SDPIComponents = sdpi;

  return state;
}

describe("ird-audio-device-select", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }

    mock = installMockSDPI();

    el = document.createElement("ird-audio-device-select");
    el.setAttribute("setting", "audioOutputDevice");
    el.setAttribute("devices", "_audioDeviceList");
    document.body.appendChild(el);
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  describe("DOM structure", () => {
    it("renders a native <select>", () => {
      expect(el.querySelector("select")).not.toBeNull();
    });

    it("includes the System Default option with value '-1'", () => {
      const opts = el.querySelectorAll("option");
      expect(opts.length).toBe(1);
      expect(opts[0].value).toBe("-1");
      expect(opts[0].textContent).toBe("System Default");
    });

    it("respects the default-label attribute", () => {
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }

      const custom = document.createElement("ird-audio-device-select");
      custom.setAttribute("default-label", "Default output");
      document.body.appendChild(custom);

      expect(custom.querySelector("option")!.textContent).toBe("Default output");
    });
  });

  describe("device-list population", () => {
    it("replaces options with devices from the _audioDeviceList global, keeping System Default first", () => {
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;
      devicesCallback(
        JSON.stringify([
          { index: 0, name: "Speaker A", isDefault: false },
          { index: 1, name: "Speaker B", isDefault: true },
        ]),
      );

      const opts = Array.from(el.querySelectorAll("option"));
      expect(opts.length).toBe(3);
      expect(opts[0].value).toBe("-1");
      expect(opts[1].value).toBe("0");
      expect(opts[1].textContent).toBe("Speaker A");
      expect(opts[2].value).toBe("1");
      expect(opts[2].textContent).toBe("Speaker B (Default)");
    });

    it("ignores malformed JSON without throwing", () => {
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;
      expect(() => devicesCallback("{not json}")).not.toThrow();

      // Still has just the System Default option
      const opts = el.querySelectorAll("option");
      expect(opts.length).toBe(1);
    });

    it("ignores non-array payloads", () => {
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;
      devicesCallback(JSON.stringify({ not: "an array" }));

      const opts = el.querySelectorAll("option");
      expect(opts.length).toBe(1);
    });
  });

  describe("selection state", () => {
    it("applies the persisted value from the setting callback", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;

      devicesCallback(JSON.stringify([{ index: 2, name: "Headset" }]));
      settingCallback("2");

      const select = el.querySelector("select") as HTMLSelectElement;
      expect(select.value).toBe("2");
    });

    it("re-applies the persisted value after the device list loads", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;

      settingCallback("1");
      devicesCallback(JSON.stringify([{ index: 1, name: "B" }]));

      const select = el.querySelector("select") as HTMLSelectElement;
      expect(select.value).toBe("1");
    });

    it("falls back to '-1' when the setting is empty or undefined", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      settingCallback("");

      const select = el.querySelector("select") as HTMLSelectElement;
      expect(select.value).toBe("-1");
    });
  });

  describe("change dispatching", () => {
    it("writes the selected value through the save hook", () => {
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;
      devicesCallback(JSON.stringify([{ index: 3, name: "X" }]));

      const select = el.querySelector("select") as HTMLSelectElement;
      select.value = "3";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      expect(mock.saves.get("audioOutputDevice")).toHaveBeenCalledWith("3");
    });

    it("bubbles a change event from the custom element", () => {
      const handler = vi.fn();
      el.addEventListener("change", handler);

      const select = el.querySelector("select") as HTMLSelectElement;
      select.value = "-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      expect(handler).toHaveBeenCalled();
    });
  });
});
