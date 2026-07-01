import type StreamDeck from "@elgato/streamdeck";
import { describe, expect, it, vi } from "vitest";

import { ElgatoPlatformAdapter } from "./adapter.js";

/**
 * Build a minimal Stream Deck SDK mock covering the surfaces the adapter touches.
 * `ui.onSendToPlugin` captures its listener so tests can simulate a PI message.
 */
function createSdMock() {
  let sendToPluginListener: ((ev: unknown) => void) | undefined;

  const sd = {
    system: { openUrl: vi.fn().mockResolvedValue(undefined) },
    profiles: { switchToProfile: vi.fn().mockResolvedValue(undefined) },
    ui: {
      onSendToPlugin: vi.fn((listener: (ev: unknown) => void) => {
        sendToPluginListener = listener;
      }),
    },
  };

  return {
    sd: sd as unknown as typeof StreamDeck,
    switchToProfile: sd.profiles.switchToProfile,
    openUrl: sd.system.openUrl,
    /** Simulate a Property Inspector `sendToPlugin` message from the given device. */
    emitSendToPlugin(deviceId: string, payload: unknown) {
      sendToPluginListener?.({ action: { device: { id: deviceId } }, payload });
    },
  };
}

describe("ElgatoPlatformAdapter.openUrl", () => {
  it("delegates to streamDeck.system.openUrl", async () => {
    const { sd, openUrl } = createSdMock();
    const adapter = new ElgatoPlatformAdapter(sd);

    await adapter.openUrl("https://example.test/");

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://example.test/");
  });
});

describe("ElgatoPlatformAdapter.switchToProfile", () => {
  it("delegates to streamDeck.profiles.switchToProfile with device, profile, and page", async () => {
    const { sd, switchToProfile } = createSdMock();
    const adapter = new ElgatoPlatformAdapter(sd);

    await adapter.switchToProfile("dev-1", "iRaceDeck Default", 2);

    expect(switchToProfile).toHaveBeenCalledWith("dev-1", "iRaceDeck Default", 2);
  });
});

describe("ElgatoPlatformAdapter sendToPlugin → switchToProfile routing", () => {
  it("switches profile for the PI's device on a switchToProfile message", () => {
    const { sd, switchToProfile, emitSendToPlugin } = createSdMock();
    new ElgatoPlatformAdapter(sd);

    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay" });

    expect(switchToProfile).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay", undefined);
  });

  it("forwards an optional page", () => {
    const { sd, switchToProfile, emitSendToPlugin } = createSdMock();
    new ElgatoPlatformAdapter(sd);

    emitSendToPlugin("dev-1", { event: "switchToProfile", profile: "iRaceDeck Default", page: 3 });

    expect(switchToProfile).toHaveBeenCalledWith("dev-1", "iRaceDeck Default", 3);
  });

  it("defaults the profile to undefined when omitted (returns to the default profile)", () => {
    const { sd, switchToProfile, emitSendToPlugin } = createSdMock();
    new ElgatoPlatformAdapter(sd);

    emitSendToPlugin("dev-1", { event: "switchToProfile" });

    expect(switchToProfile).toHaveBeenCalledWith("dev-1", undefined, undefined);
  });

  it("ignores unrelated events and non-object payloads", () => {
    const { sd, switchToProfile, emitSendToPlugin } = createSdMock();
    new ElgatoPlatformAdapter(sd);

    emitSendToPlugin("dev-1", { event: "somethingElse" });
    emitSendToPlugin("dev-1", "not-an-object");
    emitSendToPlugin("dev-1", null);
    emitSendToPlugin("dev-1", ["array"]);

    expect(switchToProfile).not.toHaveBeenCalled();
  });
});
