import { beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder } from "../../test-support/recorder.js";
import { createAudioDeviceSync } from "./audio-devices.js";

vi.mock("@iracedeck/deck-core", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/audio-service", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/iracing-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/audio-native", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);

/** The audio service calls, without the `getAudio` lookups that precede each. */
function audioCalls(): string[] {
  return callLog.filter((name) => name !== "getAudio");
}

const HEADSET = { index: 1, name: "Headset", id: "0a0b", isDefault: false };
const SPEAKERS = { index: 0, name: "Speakers", id: "0c0d", isDefault: true };

describe("createAudioDeviceSync (#1377)", () => {
  let devices: unknown[];
  let pushes: unknown[];

  beforeEach(() => {
    resetRecorder();
    devices = [SPEAKERS];
    pushes = [];
    implement("getAudio().getAudioDevices", () => devices);
    implement("updateGlobalSettings", (partial) => pushes.push(partial));
  });

  describe("pushIfChanged", () => {
    it("publishes the enumeration as JSON, then skips an identical one", () => {
      const sync = createAudioDeviceSync();

      sync.pushIfChanged();
      sync.pushIfChanged();

      expect(pushes).toEqual([{ _audioDeviceList: JSON.stringify([SPEAKERS]) }]);
      // Positive control: it did enumerate both times.
      expect(callLog.filter((n) => n === "getAudio().getAudioDevices")).toHaveLength(2);
    });

    it("publishes again when the enumeration changes (a headset plugged in)", () => {
      const sync = createAudioDeviceSync();

      sync.pushIfChanged();
      devices = [SPEAKERS, HEADSET];
      sync.pushIfChanged();

      expect(pushes).toEqual([
        { _audioDeviceList: JSON.stringify([SPEAKERS]) },
        { _audioDeviceList: JSON.stringify([SPEAKERS, HEADSET]) },
      ]);
    });
  });

  describe("seedOnFirstArrival", () => {
    it("enumerates on the first call only, even when the hardware changed since", () => {
      const sync = createAudioDeviceSync();

      sync.seedOnFirstArrival();
      devices = [SPEAKERS, HEADSET];
      sync.seedOnFirstArrival();

      expect(pushes).toEqual([{ _audioDeviceList: JSON.stringify([SPEAKERS]) }]);
    });

    it("shares the dedupe with pushIfChanged: a seed after an identical push writes nothing", () => {
      const sync = createAudioDeviceSync();

      sync.pushIfChanged();
      sync.seedOnFirstArrival();

      expect(pushes).toHaveLength(1);
      expect(callLog.filter((n) => n === "getAudio().getAudioDevices")).toHaveLength(2);
    });
  });

  describe("applySaved", () => {
    it("does nothing for System Default on the first arrival: the audio service already starts there (#849)", () => {
      createAudioDeviceSync().applySaved("");

      expect(callLog).toEqual([]);
    });

    it("treats a missing or non-string value as System Default", () => {
      const sync = createAudioDeviceSync();

      sync.applySaved(undefined);
      sync.applySaved(3);

      expect(callLog).toEqual([]);
    });

    it("selects a saved device by id, once per change", () => {
      const ids: unknown[] = [];
      implement("getAudio().setAudioDeviceById", (id) => {
        ids.push(id);

        return true;
      });
      const sync = createAudioDeviceSync();

      sync.applySaved("0a0b");
      sync.applySaved("0a0b");

      expect(ids).toEqual(["0a0b"]);
      expect(audioCalls()).toEqual(["getAudio().setAudioDeviceById"]);
    });

    it("falls back to System Default for a stale id and keeps the saved setting", () => {
      implement("getAudio().setAudioDeviceById", () => false);
      const indexes: unknown[] = [];
      implement("getAudio().setAudioDevice", (index) => indexes.push(index));
      const sync = createAudioDeviceSync();

      sync.applySaved("dead");

      expect(audioCalls()).toEqual(["getAudio().setAudioDeviceById", "getAudio().setAudioDevice"]);
      expect(indexes).toEqual([-1]);
      // The persisted id is never rewritten, so the device re-binds when it reappears.
      expect(pushes).toEqual([]);
    });

    it("returns to System Default when the saved device is cleared", () => {
      implement("getAudio().setAudioDeviceById", () => true);
      const indexes: unknown[] = [];
      implement("getAudio().setAudioDevice", (index) => indexes.push(index));
      const sync = createAudioDeviceSync();

      sync.applySaved("0a0b");
      sync.applySaved("");

      expect(audioCalls()).toEqual(["getAudio().setAudioDeviceById", "getAudio().setAudioDevice"]);
      expect(indexes).toEqual([-1]);
    });

    it("retries a stale id after another device was chosen in between", () => {
      const ids: unknown[] = [];
      implement("getAudio().setAudioDeviceById", (id) => {
        ids.push(id);

        return id !== "dead";
      });
      const sync = createAudioDeviceSync();

      sync.applySaved("dead");
      sync.applySaved("0a0b");
      sync.applySaved("dead");

      expect(ids).toEqual(["dead", "0a0b", "dead"]);
    });
  });
});
