import { silentLogger } from "@iracedeck/logger";
import { onGlobalSettingsChange } from "@iracedeck/settings";
import type { InstalledVoicePack, VoicePackInstaller, VoicePackLaunchStepDeps } from "@iracedeck/voice-packs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder, stub } from "../../test-support/recorder.js";
import { buildVoicePackLaunch } from "./launch.js";

vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));
vi.mock("@iracedeck/voice-packs", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);

/** An installed pack with `voiceCount` voices. */
function pack(id: string, voiceCount: number): InstalledVoicePack {
  return {
    id,
    label: id,
    version: "1.0.0",
    dir: `C:/packs/${id}`,
    voices: Array.from({ length: voiceCount }, (_, i) => ({
      id: `${id}::v${i}`,
      packVoiceId: `v${i}`,
      label: `v${i}`,
      script: null,
    })),
    clips: [],
    provenance: "catalog",
  };
}

/** Build the launch step over a fake scan, capturing the deps it handed `createVoicePackLaunchStep`. */
function setup(devVoicePacksRoot: string | undefined = undefined) {
  let deps: VoicePackLaunchStepDeps | undefined;
  const product = { start: vi.fn(), poke: vi.fn() };
  implement("createVoicePackLaunchStep", (d) => {
    deps = d as VoicePackLaunchStepDeps;

    return product;
  });
  const installed: InstalledVoicePack[] = [pack("default", 1), pack("empty", 0)];
  const providedByDev = new Set<string>();
  const service = {
    installed: () => installed,
    isProvidedByDevRoot: (id: string) => providedByDev.has(id),
  };
  const installer: VoicePackInstaller = stub("installer");
  const logger = { ...silentLogger };
  const launch = buildVoicePackLaunch({ service, devVoicePacksRoot, logger }, installer);

  if (deps === undefined) throw new Error("createVoicePackLaunchStep was not called");

  return { deps, product, launch, installer, logger, installed, providedByDev };
}

describe("buildVoicePackLaunch (#1377)", () => {
  beforeEach(() => resetRecorder());

  it("returns the launch step it built over the installer, the logger and the settings listener", () => {
    const { deps, product, launch, installer, logger } = setup();

    expect(launch).toBe(product);
    expect(deps.installer).toBe(installer);
    expect(deps.logger).toBe(logger);
    expect(deps.onSettingsChange).toBe(onGlobalSettingsChange);
  });

  it("takes the settle signal only when the step asks for it", () => {
    const { deps } = setup();

    // A thunk: building the step must not take the promise.
    expect(callLog).not.toContain("whenSettingsStoreSettled");
    void deps.settled();
    expect(callLog).toContain("whenSettingsStoreSettled");
  });

  it("counts a pack usable only while the last scan lists it with a voice", () => {
    const { deps, installed } = setup();

    expect(deps.isPackUsable("default")).toBe(true);
    expect(deps.isPackUsable("empty"), "listed, but with no voice").toBe(false);
    expect(deps.isPackUsable("missing")).toBe(false);

    // Read live off the scan, not captured at build.
    installed.splice(0);
    expect(deps.isPackUsable("default")).toBe(false);
  });

  it("asks the service live whether the development root provides a pack", () => {
    const { deps, providedByDev } = setup();

    expect(deps.isProvidedByDevRoot?.("staged")).toBe(false);
    providedByDev.add("staged");
    expect(deps.isProvidedByDevRoot?.("staged")).toBe(true);
  });

  it("passes the development root only when there is one", () => {
    expect(setup().deps).not.toHaveProperty("devRoot");
    expect(setup("C:/dev/voices").deps.devRoot).toBe("C:/dev/voices");
  });

  it("reads the Race Engineer gate as on only for a stored true", () => {
    const settings: Record<string, unknown> = {};
    implement("getGlobalSettings", () => settings);
    const { deps } = setup();

    expect(deps.isRaceEngineerEnabled()).toBe(false);
    settings.pitCrewRaceEngineerEnabled = "true";
    expect(deps.isRaceEngineerEnabled(), "a truthy non-boolean is not on").toBe(false);
    settings.pitCrewRaceEngineerEnabled = true;
    expect(deps.isRaceEngineerEnabled()).toBe(true);
  });
});
