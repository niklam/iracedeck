import { describe, expect, it, vi } from "vitest";

import {
  createSettingsWindowCommandHandler,
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
});
