import { describe, expect, it, vi } from "vitest";

import { FEATURE_STARTUP_GATES } from "./feature-startup-policy.js";
import {
  createSettingsWindowCommandHandler,
  enableFeatureWrites,
  parseSettingsWindowBounds,
  SETTINGS_WINDOW_BOUNDS_KEY,
} from "./settings-window-commands.js";

describe("parseSettingsWindowBounds", () => {
  it("accepts a well-formed bounds object", () => {
    expect(parseSettingsWindowBounds({ width: 1200, height: 800, x: 10, y: 20 })).toEqual({
      width: 1200,
      height: 800,
      x: 10,
      y: 20,
    });
  });

  it("accepts size without position", () => {
    expect(parseSettingsWindowBounds({ width: 1200, height: 800 })).toEqual({ width: 1200, height: 800 });
  });

  it("drops an off-screen position (beyond the 16-bit virtual-screen range) but keeps the size", () => {
    expect(parseSettingsWindowBounds({ width: 1200, height: 800, x: 40_000, y: 20 })).toEqual({
      width: 1200,
      height: 800,
    });
    expect(parseSettingsWindowBounds({ width: 1200, height: 800, x: 20, y: -40_000 })).toEqual({
      width: 1200,
      height: 800,
    });
    expect(parseSettingsWindowBounds({ width: 1200, height: 800, x: 32_767, y: -32_767 })).toEqual({
      width: 1200,
      height: 800,
      x: 32_767,
      y: -32_767,
    });
    expect(parseSettingsWindowBounds({ width: 1200, height: 800, x: "10", y: 20 })).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it("rejects absurd or malformed values so a bad persisted blob can't produce an unusable window", () => {
    expect(parseSettingsWindowBounds({ width: 50, height: 800 })).toBeUndefined();
    expect(parseSettingsWindowBounds({ width: 1200, height: -1 })).toBeUndefined();
    expect(parseSettingsWindowBounds({ width: "1200", height: 800 })).toBeUndefined();
    expect(parseSettingsWindowBounds({ width: 20000, height: 800 })).toBeUndefined();
    expect(parseSettingsWindowBounds("nope")).toBeUndefined();
    expect(parseSettingsWindowBounds(undefined)).toBeUndefined();
  });
});

describe("createSettingsWindowCommandHandler", () => {
  it("persists windowBounds under the passthrough key via the injected writer", () => {
    const write = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: write });

    handle({ event: "windowBounds", width: 1300, height: 900, x: 5, y: 6 });

    expect(write).toHaveBeenCalledWith({ [SETTINGS_WINDOW_BOUNDS_KEY]: { width: 1300, height: 900, x: 5, y: 6 } });
  });

  it("ignores windowBounds that fail validation — no partial writes", () => {
    const write = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: write });

    handle({ event: "windowBounds", width: 1, height: 1 });

    expect(write).not.toHaveBeenCalled();
  });

  it("routes switchToProfile with an explicit deviceId to the injected switcher", () => {
    const switchProfile = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: vi.fn(), switchProfile });

    handle({ event: "switchToProfile", deviceId: "dev-9", profile: "iRaceDeck Replay", page: 2 });

    expect(switchProfile).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay", 2);
  });

  it("drops switchToProfile without a deviceId — the window has no implicit device", () => {
    const switchProfile = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: vi.fn(), switchProfile });

    handle({ event: "switchToProfile", profile: "iRaceDeck Replay" });

    expect(switchProfile).not.toHaveBeenCalled();
  });

  it("routes audioPreview to the injected preview runner", () => {
    const previewAudio = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: vi.fn(), previewAudio });

    handle({ event: "audioPreview", kind: "voice" });

    expect(previewAudio).toHaveBeenCalledWith("voice");
  });

  it("drops audioPreview without a string kind — validation of the kind itself is the runner's job", () => {
    const previewAudio = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: vi.fn(), previewAudio });

    handle({ event: "audioPreview" });
    handle({ event: "audioPreview", kind: 3 });

    expect(previewAudio).not.toHaveBeenCalled();
  });

  it("ignores unknown events", () => {
    const write = vi.fn();
    const switchProfile = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: write, switchProfile });

    handle({ event: "somethingElse" });
    handle({});

    expect(write).not.toHaveBeenCalled();
    expect(switchProfile).not.toHaveBeenCalled();
  });

  it("routes openSettingsFolder to the injected opener with the PLUGIN's store path — never a path from the page", () => {
    const openFolder = vi.fn();
    const handle = createSettingsWindowCommandHandler({
      writeSettings: vi.fn(),
      openFolder,
      storePath: "C:\\s\\global-settings.json",
    });

    handle({ event: "openSettingsFolder", path: "C:\\Windows\\evil" });

    expect(openFolder).toHaveBeenCalledWith("C:\\s\\global-settings.json");
  });

  it("routes voicePackRefresh to the injected refresher (#1034)", () => {
    const refreshVoicePacks = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: vi.fn(), refreshVoicePacks });

    handle({ event: "voicePackRefresh" });

    expect(refreshVoicePacks).toHaveBeenCalledTimes(1);
  });

  it("takes nothing from a voicePackRefresh payload — the page names no directory", () => {
    const refreshVoicePacks = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: vi.fn(), refreshVoicePacks });

    handle({ event: "voicePackRefresh", root: "anything at all" });

    expect(refreshVoicePacks).toHaveBeenCalledWith();
  });

  it("ignores voicePackRefresh when no refresher is injected", () => {
    const handle = createSettingsWindowCommandHandler({ writeSettings: vi.fn() });

    expect(() => handle({ event: "voicePackRefresh" })).not.toThrow();
  });
});

describe("enableFeatureWrites", () => {
  it("moves the Race Engineer gate and its startup policy together", () => {
    // The load-bearing test of #1061's opt-in. Writing the gate alone turns the
    // engineer on for this session, and `applyStartupFeatureGates` turns it
    // straight back off on the next start for every install carrying the
    // `always-off` that `migrateStartupPolicies` derived from the retired
    // pre-#1007 boolean — i.e. essentially every upgraded install. The failure
    // is invisible until the NEXT start, which is why it is pinned rather than
    // trusted.
    expect(enableFeatureWrites("race-engineer")).toEqual({
      pitCrewRaceEngineerEnabled: true,
      pitCrewRaceEngineerStartupPolicy: "remember-last",
    });
  });

  it("writes the policy the Pit Crew toggle can still override, never always-on", () => {
    // `always-on` would force the gate at every start and override a later
    // deliberate silence from the deck key — the defect #1007 removed.
    expect(enableFeatureWrites("race-engineer")).not.toMatchObject({
      pitCrewRaceEngineerStartupPolicy: "always-on",
    });
  });

  it("derives both keys from the gate table, so a rename cannot leave it behind", () => {
    const gate = FEATURE_STARTUP_GATES.find((candidate) => candidate.gateKey === "pitCrewRaceEngineerEnabled");

    expect(gate, "the Race Engineer gate is gone from FEATURE_STARTUP_GATES").toBeDefined();
    expect(Object.keys(enableFeatureWrites("race-engineer") ?? {})).toEqual([gate?.gateKey, gate?.policyKey]);
  });

  it("opts the changelog in at `features`, matching the button's own words", () => {
    // The button reads "I want to read about new features"; `always` would also
    // open for patch releases, so it would promise less than it delivers.
    expect(enableFeatureWrites("changelog-updates")).toEqual({ changelogNotification: "features" });
  });

  it("turns on window focus with the single key it needs", () => {
    expect(enableFeatureWrites("focus-iracing-window")).toEqual({ focusIRacingWindow: true });
  });

  it("knows nothing about a feature it was not taught", () => {
    expect(enableFeatureWrites("anything-else")).toBeUndefined();
    expect(enableFeatureWrites(undefined)).toBeUndefined();
    expect(enableFeatureWrites({ toString: () => "race-engineer" })).toBeUndefined();
  });
});

describe("the enableFeature command", () => {
  it("writes both Race Engineer keys in ONE call, so they cannot half-land", () => {
    const writeSettings = vi.fn();

    createSettingsWindowCommandHandler({ writeSettings })({ event: "enableFeature", feature: "race-engineer" });

    expect(writeSettings).toHaveBeenCalledTimes(1);
    expect(writeSettings).toHaveBeenCalledWith({
      pitCrewRaceEngineerEnabled: true,
      pitCrewRaceEngineerStartupPolicy: "remember-last",
    });
  });

  it("plays one voice preview for the Race Engineer, which has no other audible confirmation", () => {
    const previewAudio = vi.fn();

    createSettingsWindowCommandHandler({ writeSettings: vi.fn(), previewAudio })({
      event: "enableFeature",
      feature: "race-engineer",
    });

    expect(previewAudio).toHaveBeenCalledWith("voice");
  });

  it("plays nothing for the other two, which change something the user can see", () => {
    const previewAudio = vi.fn();
    const handle = createSettingsWindowCommandHandler({ writeSettings: vi.fn(), previewAudio });

    handle({ event: "enableFeature", feature: "changelog-updates" });
    handle({ event: "enableFeature", feature: "focus-iracing-window" });

    expect(previewAudio).not.toHaveBeenCalled();
  });

  it("still writes when no preview runner is wired at all", () => {
    const writeSettings = vi.fn();

    expect(() =>
      createSettingsWindowCommandHandler({ writeSettings })({ event: "enableFeature", feature: "race-engineer" }),
    ).not.toThrow();
    expect(writeSettings).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a feature it does not know", () => {
    const writeSettings = vi.fn();

    createSettingsWindowCommandHandler({ writeSettings })({ event: "enableFeature", feature: "delete-everything" });

    expect(writeSettings).not.toHaveBeenCalled();
  });
});
