import type { PiWarning } from "@iracedeck/app-constants";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder, stub } from "../../test-support/recorder.js";
import { createPropertyInspectorAppearHandler, createSettingsListener, pushVoicePackLists } from "./listeners.js";

vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));

const WARNINGS: PiWarning[] = [
  { id: "native-addon-iracing", level: "error", message: "iracing" },
  { id: "native-addon-audio", level: "error", message: "audio" },
];

describe("the settings phase's listeners (#1377)", () => {
  beforeEach(() => resetRecorder());

  it("pushes the three voice-pack lists in order", () => {
    pushVoicePackLists(stub("voicePacks"));

    expect(callLog).toEqual([
      "voicePacks.push.raceEngineerVoices",
      "voicePacks.push.driverNames",
      "voicePacks.push.packList",
    ]);
  });

  describe("createSettingsListener", () => {
    function listen(nativeAddonWarnings: readonly PiWarning[] = WARNINGS) {
      return createSettingsListener({
        audioDevices: stub("audioDevices"),
        storeReady: stub("storeReady"),
        voicePacks: stub("voicePacks"),
        nativeAddonWarnings,
      });
    }

    it("runs today's sequence on every arrival", () => {
      const listener = listen();

      listener({});

      expect(callLog).toEqual([
        "audioDevices.seedOnFirstArrival",
        "storeReady.runIfReady",
        "voicePacks.push.raceEngineerVoices",
        "voicePacks.push.driverNames",
        "voicePacks.push.packList",
        "migrateRaceEngineerVoiceId",
        "voicePacks.reassertVoiceScriptWarning",
        "setWarning",
        "setWarning",
        "audioDevices.applySaved",
      ]);
    });

    it("sets each native addon banner as computed, and the saved device from the arrival", () => {
      const banners: unknown[][] = [];
      const saved: unknown[] = [];
      implement("setWarning", (...args) => banners.push(args));
      implement("audioDevices.applySaved", (value) => saved.push(value));
      const listener = listen();

      listener({ audioOutputDevice: "0a0b" });
      listener({});

      expect(banners).toEqual([
        ["native-addon-iracing", "error", "iracing"],
        ["native-addon-audio", "error", "audio"],
        ["native-addon-iracing", "error", "iracing"],
        ["native-addon-audio", "error", "audio"],
      ]);
      expect(saved).toEqual(["0a0b", undefined]);
    });

    it("sets no banner when every addon loaded", () => {
      listen([])({});

      expect(callLog).not.toContain("setWarning");
      // Positive control: the tail still ran.
      expect(callLog.at(-1)).toBe("audioDevices.applySaved");
    });
  });

  it("re-pushes the devices, the voice-pack lists and the installer status when a PI appears", () => {
    createPropertyInspectorAppearHandler({ audioDevices: stub("audioDevices"), voicePacks: stub("voicePacks") })();

    expect(callLog).toEqual([
      "audioDevices.pushIfChanged",
      "voicePacks.push.raceEngineerVoices",
      "voicePacks.push.driverNames",
      "voicePacks.push.packList",
      "voicePacks.installer.republishStatus",
    ]);
  });
});
