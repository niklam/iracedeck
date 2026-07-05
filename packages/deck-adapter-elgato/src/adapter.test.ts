import type StreamDeck from "@elgato/streamdeck";
import { _resetProfileSwitcher, initProfileSwitcher, requestProfileSwitchBack } from "@iracedeck/deck-core";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    /** Simulate a Property Inspector `sendToPlugin` message from the given device (an XL by default). */
    emitSendToPlugin(deviceId: string, payload: unknown, deviceType: number | undefined = 2) {
      sendToPluginListener?.({ action: { device: { id: deviceId, type: deviceType } }, payload });
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
  afterEach(() => {
    _resetProfileSwitcher();
  });

  /** Create the adapter and wire the profile switcher exactly as plugin.ts does. */
  function setup() {
    const mock = createSdMock();
    const adapter = new ElgatoPlatformAdapter(mock.sd);

    initProfileSwitcher((deviceId, profile, page) => adapter.switchToProfile(deviceId, profile, page));

    return mock;
  }

  it("switches profile for the PI's device, resolving the device-suffixed name (#753)", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    // The accordion sends clean display names; the adapter appends the
    // pressing device's suffix (an XL here).
    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay" });

    expect(switchToProfile).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay XL", undefined);
  });

  it("passes an already-suffixed profile name through unchanged", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay XL" });

    expect(switchToProfile).toHaveBeenCalledWith("dev-9", "iRaceDeck Replay XL", undefined);
  });

  it("passes the profile name through unchanged when the device has no suffix", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    // Device type 10 (Studio) has no bundled-profile suffix; 99 is unknown.
    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay" }, 10);
    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Default" }, 99);

    expect(switchToProfile).toHaveBeenNthCalledWith(1, "dev-9", "iRaceDeck Replay", undefined);
    expect(switchToProfile).toHaveBeenNthCalledWith(2, "dev-9", "iRaceDeck Default", undefined);
  });

  it("forwards an optional page", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-1", { event: "switchToProfile", profile: "iRaceDeck Default", page: 3 });

    expect(switchToProfile).toHaveBeenCalledWith("dev-1", "iRaceDeck Default XL", 3);
  });

  it("defaults the profile to undefined when omitted (returns to the default profile)", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-1", { event: "switchToProfile" });

    expect(switchToProfile).toHaveBeenCalledWith("dev-1", undefined, undefined);
  });

  it("records accordion switches in the profile history so Back can walk them (#762)", async () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Default" });
    emitSendToPlugin("dev-9", { event: "switchToProfile", profile: "iRaceDeck Replay" });

    await requestProfileSwitchBack("dev-9");

    expect(switchToProfile).toHaveBeenLastCalledWith("dev-9", "iRaceDeck Default XL", undefined);
  });

  it("ignores unrelated events and non-object payloads", () => {
    const { switchToProfile, emitSendToPlugin } = setup();

    emitSendToPlugin("dev-1", { event: "somethingElse" });
    emitSendToPlugin("dev-1", "not-an-object");
    emitSendToPlugin("dev-1", null);
    emitSendToPlugin("dev-1", ["array"]);

    expect(switchToProfile).not.toHaveBeenCalled();
  });
});
