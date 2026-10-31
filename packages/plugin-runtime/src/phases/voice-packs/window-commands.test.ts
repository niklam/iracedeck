import { silentLogger } from "@iracedeck/logger";
import { openDirectoryInExplorer } from "@iracedeck/settings-window";
import type { VoicePackInstaller } from "@iracedeck/voice-packs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder } from "../../test-support/recorder.js";
import { buildVoicePackWindowCommands } from "./window-commands.js";

vi.mock("@iracedeck/settings-window", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/voice-packs", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);

/** Fake collaborators that write each call into one shared `order`, so a test can read what ran in which order. */
function setup() {
  const order: string[] = [];
  const service = {
    refresh: vi.fn(() => {
      order.push("service.refresh");

      return [];
    }),
  };
  const launch = {
    poke: vi.fn(() => {
      order.push("launch.poke");
    }),
  };
  const installer = {
    install: vi.fn<VoicePackInstaller["install"]>(() => new Promise(() => {})),
    remove: vi.fn<VoicePackInstaller["remove"]>(() => new Promise(() => {})),
  };
  const logger = { ...silentLogger, warn: vi.fn() };
  const commands = buildVoicePackWindowCommands({
    service,
    launch,
    installer,
    logger,
    voicePacksRoot: "C:/Users/test/AppData/Roaming/iRaceDeck/Voices",
  });

  return { order, service, launch, installer, logger, commands };
}

describe("buildVoicePackWindowCommands (#1377)", () => {
  beforeEach(() => resetRecorder());

  it("rescans, then pokes the launch step, on Rescan", () => {
    const { order, commands } = setup();

    commands.refreshVoicePacks();

    expect(order).toEqual(["service.refresh", "launch.poke"]);
  });

  it("hands an install to the installer without waiting on it", () => {
    const { installer, commands } = setup();

    // The installer's promise never settles here; the command returns regardless.
    expect(commands.installVoicePack("terse")).toBeUndefined();
    expect(installer.install).toHaveBeenCalledExactlyOnceWith("terse");
  });

  it("refuses to remove the managed pack, with a warning, and removes any other", () => {
    implement("isManagedVoicePack", (id) => id === "default");
    const { installer, logger, commands } = setup();

    commands.removeVoicePack("default");
    expect(installer.remove).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('Refused to remove the managed voice pack "default"');
    expect(callLog).toContain("isManagedVoicePack");

    // Positive control: any other pack does reach the installer.
    commands.removeVoicePack("other");
    expect(installer.remove).toHaveBeenCalledExactlyOnceWith("other");
  });

  it("opens the packs folder the scan named, with the directory opener", () => {
    const { commands } = setup();

    expect(commands.openDirectory).toBe(openDirectoryInExplorer);
    expect(commands.voicePacksPath).toBe("C:/Users/test/AppData/Roaming/iRaceDeck/Voices");
  });
});
