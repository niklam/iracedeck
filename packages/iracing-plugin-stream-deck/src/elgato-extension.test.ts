import type StreamDeck from "@elgato/streamdeck";
import type { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import { initProfileSwitcher, updateGlobalSettings } from "@iracedeck/deck-core";
import { STREAM_DECK_ACTIONS } from "@iracedeck/plugin-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElgatoExtension } from "./elgato-extension.js";

vi.mock("@iracedeck/deck-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  initProfileSwitcher: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

type Device = { id: string; name: string; type: number; isConnected: boolean };

function fakes(devices: Device[]) {
  const sd = {
    devices: Object.assign([...devices], { onDeviceDidConnect: vi.fn(), onDeviceDidDisconnect: vi.fn() }),
  } as unknown as typeof StreamDeck;
  const adapter = {
    switchToBundledProfile: vi.fn(),
    switchToProfile: vi.fn(),
    createLogger: vi.fn(() => ({})),
  } as unknown as ElgatoPlatformAdapter;

  return { sd, adapter };
}

describe("createElgatoExtension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing until started", () => {
    const { sd } = fakes([]);

    createElgatoExtension(sd, fakes([]).adapter);

    expect(initProfileSwitcher).not.toHaveBeenCalled();
    expect(sd.devices.onDeviceDidConnect).not.toHaveBeenCalled();
  });

  it("starts the profile switcher and both device listeners (#736)", () => {
    const { sd, adapter } = fakes([]);

    createElgatoExtension(sd, adapter).start();

    expect(initProfileSwitcher).toHaveBeenCalledOnce();
    expect(adapter.createLogger).toHaveBeenCalledWith("ProfileSwitcher");
    expect(sd.devices.onDeviceDidConnect).toHaveBeenCalledOnce();
    expect(sd.devices.onDeviceDidDisconnect).toHaveBeenCalledOnce();
  });

  it("reports the first connected deck's type", () => {
    const { sd, adapter } = fakes([
      { id: "a", name: "A", type: 1, isConnected: false },
      { id: "b", name: "B", type: 7, isConnected: true },
    ]);

    expect(createElgatoExtension(sd, adapter).getConnectedDeviceType()).toBe(7);
  });

  it("publishes the connected decks once per change", () => {
    const { sd, adapter } = fakes([{ id: "b", name: "B", type: 7, isConnected: true }]);
    const extension = createElgatoExtension(sd, adapter);

    extension.refreshDevices();
    extension.refreshDevices();

    expect(updateGlobalSettings).toHaveBeenCalledExactlyOnceWith({
      _deckDevices: JSON.stringify([{ id: "b", name: "B", type: 7 }]),
    });
  });

  it("routes the window's profile buttons through the bundled-profile dispatch (#992)", () => {
    const { sd, adapter } = fakes([]);

    createElgatoExtension(sd, adapter).switchProfile("dev", "Default", 2);

    expect(adapter.switchToBundledProfile).toHaveBeenCalledWith("dev", "Default", 2);
  });

  it("works with every member detached from the object, as the bootstrap passes switchProfile", () => {
    const { sd, adapter } = fakes([{ id: "b", name: "B", type: 7, isConnected: true }]);
    const { switchProfile, start, getConnectedDeviceType, refreshDevices } = createElgatoExtension(sd, adapter);

    switchProfile("dev", "Default");
    start();
    refreshDevices();

    expect(adapter.switchToBundledProfile).toHaveBeenCalledWith("dev", "Default", undefined);
    expect(initProfileSwitcher).toHaveBeenCalledOnce();
    expect(getConnectedDeviceType()).toBe(7);
    expect(updateGlobalSettings).toHaveBeenCalledOnce();
  });

  it("wires the profile switcher to the adapter's profile switch and the device listeners to the deck push", () => {
    const { sd, adapter } = fakes([{ id: "b", name: "B", type: 7, isConnected: true }]);

    createElgatoExtension(sd, adapter).start();
    const [switcher] = vi.mocked(initProfileSwitcher).mock.calls[0];
    switcher("dev", "Default", 3);
    vi.mocked(sd.devices.onDeviceDidConnect).mock.calls[0][0]({} as never);

    expect(adapter.switchToProfile).toHaveBeenCalledWith("dev", "Default", 3);
    expect(updateGlobalSettings).toHaveBeenCalledOnce();
  });

  it("adds Switch Profile and nothing else", () => {
    const { sd, adapter } = fakes([]);

    expect(createElgatoExtension(sd, adapter).extraActions).toBe(STREAM_DECK_ACTIONS);
  });
});
