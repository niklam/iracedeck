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

    it("includes the System Default option with the empty-string value", () => {
      const opts = el.querySelectorAll("option");
      expect(opts.length).toBe(1);
      expect(opts[0].value).toBe("");
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
          { index: 0, name: "Speaker A", id: "AAAA", isDefault: false },
          { index: 1, name: "Speaker B", id: "BBBB", isDefault: true },
        ]),
      );

      const opts = Array.from(el.querySelectorAll("option"));
      expect(opts.length).toBe(3);
      expect(opts[0].value).toBe("");
      expect(opts[1].value).toBe("AAAA");
      expect(opts[1].textContent).toBe("Speaker A");
      expect(opts[2].value).toBe("BBBB");
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

    it("skips devices missing the stable id field", () => {
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;
      devicesCallback(
        JSON.stringify([
          { index: 0, name: "Headset", id: "AAAA" },
          { index: 1, name: "Legacy device" }, // no id
        ]),
      );

      const opts = Array.from(el.querySelectorAll("option"));
      expect(opts.length).toBe(2); // System Default + the one with id
      expect(opts[1].value).toBe("AAAA");
    });
  });

  describe("selection state", () => {
    it("applies the persisted id from the setting callback", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;

      devicesCallback(JSON.stringify([{ index: 2, name: "Headset", id: "DEADBEEF" }]));
      settingCallback("DEADBEEF");

      const select = el.querySelector("select") as HTMLSelectElement;
      expect(select.value).toBe("DEADBEEF");
    });

    it("re-applies the persisted id after the device list loads", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;

      settingCallback("CAFE0001");
      devicesCallback(JSON.stringify([{ index: 1, name: "B", id: "CAFE0001" }]));

      const select = el.querySelector("select") as HTMLSelectElement;
      expect(select.value).toBe("CAFE0001");
    });

    it("selects System Default (empty value) when the setting is the empty string", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      settingCallback("");

      const select = el.querySelector("select") as HTMLSelectElement;
      expect(select.value).toBe("");
    });

    it("falls back to System Default when the persisted device id is no longer in the current device list", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;

      // Persisted selection was the unplugged headset; the current
      // enumeration only contains the built-in speakers.
      settingCallback("MISSING-ID");
      devicesCallback(
        JSON.stringify([
          { index: 0, name: "Built-in", id: "AAAA" },
          { index: 1, name: "Speakers", id: "BBBB" },
        ]),
      );

      const select = el.querySelector("select") as HTMLSelectElement;
      expect(select.value).toBe("");
    });

    it("treats a legacy numeric-index value as unknown and falls back to System Default", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;

      // A pre-#427 install persisted "1" (the index). Under the id-based
      // scheme that's just an unknown value; user re-picks once.
      settingCallback("1");
      devicesCallback(JSON.stringify([{ index: 0, name: "Speakers", id: "AAAA" }]));

      const select = el.querySelector("select") as HTMLSelectElement;
      expect(select.value).toBe("");
    });

    it("persists the System Default fallback when the saved id is not in the list", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;
      const save = mock.saves.get("audioOutputDevice")!;

      // Persisted selection is an unplugged headset; the current
      // enumeration doesn't contain it, so the fallback must be written
      // through so the plugin doesn't keep retrying the missing device.
      settingCallback("MISSING-ID");
      devicesCallback(JSON.stringify([{ index: 0, name: "Built-in", id: "AAAA" }]));

      expect(save).toHaveBeenCalledWith("");
    });

    it("does not re-persist when the saved value is already System Default", () => {
      const settingCallback = mock.callbacks.get("audioOutputDevice")!;
      const save = mock.saves.get("audioOutputDevice")!;

      // Nothing to persist — the dropdown was already showing System
      // Default, and there is nothing stale to clear. Writing back "" here
      // would turn every fresh PI load into a redundant setting write.
      settingCallback("");

      expect(save).not.toHaveBeenCalled();
    });
  });

  describe("change dispatching", () => {
    it("writes the selected id through the save hook", () => {
      const devicesCallback = mock.callbacks.get("_audioDeviceList")!;
      devicesCallback(JSON.stringify([{ index: 3, name: "X", id: "XYZ123" }]));

      const select = el.querySelector("select") as HTMLSelectElement;
      select.value = "XYZ123";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      expect(mock.saves.get("audioOutputDevice")).toHaveBeenCalledWith("XYZ123");
    });

    it("writes the empty string when System Default is selected", () => {
      const select = el.querySelector("select") as HTMLSelectElement;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      expect(mock.saves.get("audioOutputDevice")).toHaveBeenCalledWith("");
    });

    it("dispatches exactly one change event per user selection (no double-fire from native bubble)", () => {
      const handler = vi.fn();
      el.addEventListener("change", handler);

      const select = el.querySelector("select") as HTMLSelectElement;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
