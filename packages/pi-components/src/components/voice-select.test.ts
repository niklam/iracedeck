// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import "./voice-select.js";

type SettingsCallback = (value: string) => void;

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
  saves: Map<string, ReturnType<typeof vi.fn>>;
}

function installMockSDPI(): MockSDPIState {
  const state: MockSDPIState = { callbacks: new Map(), saves: new Map() };

  const useGlobalSettings = (key: string, callback: SettingsCallback): [() => Promise<string>, unknown] => {
    state.callbacks.set(key, callback);

    const save = vi.fn();
    state.saves.set(key, save);

    return [async () => "", save];
  };

  (window as unknown as Record<string, unknown>).SDPIComponents = { useGlobalSettings };

  return state;
}

describe("ird-voice-select", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    mock = installMockSDPI();
    el = document.createElement("ird-voice-select");
    document.body.appendChild(el);
  });

  const publishVoices = (voices: string[]): void =>
    void mock.callbacks.get("_raceEngineerVoices")?.(JSON.stringify(voices));
  const publishChoice = (value: string): void => void mock.callbacks.get("raceEngineerVoice")?.(value);
  const save = (): ReturnType<typeof vi.fn> => mock.saves.get("raceEngineerVoice")!;
  const selected = (): string => (el.querySelector("select") as HTMLSelectElement).value;

  it("selects the saved voice when it is in the list", () => {
    publishChoice("nina");
    publishVoices(["default", "nina"]);

    expect(selected()).toBe("nina");
    expect(save()).not.toHaveBeenCalled();
  });

  it("seeds a choice on a fresh install, where there is none to lose", () => {
    publishChoice("");
    publishVoices(["default"]);

    expect(selected()).toBe("default");
    expect(save()).toHaveBeenCalledWith("default");
  });

  describe("the default anchor (#1034)", () => {
    // The dropdown's half of `resolveActiveRaceEngineerVoice`'s anchor. Without
    // it both fell to the first option, which a pack named `aria` wins — and the
    // dropdown would then disagree with what the plugin actually plays.

    beforeEach(() => {
      el.setAttribute("default", "default");
    });

    it("shows the default voice rather than an alphabetically earlier pack", () => {
      publishChoice("");
      publishVoices(["aria", "default"]);

      expect(selected()).toBe("default");
      expect(save()).toHaveBeenCalledWith("default");
    });

    it("falls through to the first entry when the anchor is not installed", () => {
      publishChoice("");
      publishVoices(["aria", "zeta"]);

      expect(selected()).toBe("aria");
    });

    it("never overrides a voice the user actually chose", () => {
      publishChoice("aria");
      publishVoices(["aria", "default"]);

      expect(selected()).toBe("aria");
      expect(save()).not.toHaveBeenCalled();
    });
  });

  describe("a voice that leaves the list (#1034)", () => {
    // The list became a function of what is on disk. A pack folder locked by a
    // sync client or an AV scanner is reported as a problem while the scan
    // SUCCEEDS, so one press of Rescan can shrink the list without the user
    // having removed anything.

    it("shows the fallback but does NOT overwrite the saved voice", () => {
      publishChoice("nina");
      publishVoices(["default", "nina"]);
      publishVoices(["default"]);

      expect(selected()).toBe("default");
      expect(save()).not.toHaveBeenCalled();
    });

    it("restores the user's voice when the pack comes back", () => {
      publishChoice("nina");
      publishVoices(["default", "nina"]);
      publishVoices(["default"]);
      publishVoices(["default", "nina"]);

      expect(selected()).toBe("nina");
      expect(save()).not.toHaveBeenCalled();
    });
  });
});
