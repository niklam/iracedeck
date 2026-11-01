import type StreamDeck from "@elgato/streamdeck";
import type { ElgatoPlatformAdapter } from "@iracedeck/deck-adapter-elgato";
import { getFeatureFlag, initProfileSwitcher, requestProfileSwitch } from "@iracedeck/deck-core";
import { type HostSim, STREAM_DECK_ACTIONS } from "@iracedeck/plugin-runtime";
import { getGlobalSettings, updateGlobalSettings } from "@iracedeck/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createElgatoExtension } from "./elgato-extension.js";

vi.mock("@iracedeck/deck-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentProfile: vi.fn(() => undefined),
  getFeatureFlag: vi.fn(() => true),
  initProfileSwitcher: vi.fn(),
  requestProfileSwitch: vi.fn(async () => undefined),
}));

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGlobalSettings: vi.fn(),
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
    createLogger: vi.fn(() => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  } as unknown as ElgatoPlatformAdapter;

  return { sd, adapter };
}

/** A `HostSim` that records its listeners, so a test can fire a tick by hand. */
function fakeSim() {
  const tickListeners: Array<() => void> = [];
  const unsubscribeTick = vi.fn();
  const sim = {
    getSessionKind: vi.fn<HostSim["getSessionKind"]>(() => null),
    getRawSessionType: vi.fn<HostSim["getRawSessionType"]>(() => ""),
    onTick: vi.fn<HostSim["onTick"]>((listener) => {
      tickListeners.push(listener);

      return unsubscribeTick;
    }),
    onSimTerminated: vi.fn<HostSim["onSimTerminated"]>(() => () => undefined),
  };
  const tick = (): void => tickListeners.forEach((listener) => listener());

  return { sim, tick, unsubscribeTick };
}

describe("createElgatoExtension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing until started", () => {
    const { sd } = fakes([]);
    const { sim } = fakeSim();

    createElgatoExtension(sd, fakes([]).adapter);

    expect(initProfileSwitcher).not.toHaveBeenCalled();
    expect(sd.devices.onDeviceDidConnect).not.toHaveBeenCalled();
    expect(sim.onTick).not.toHaveBeenCalled();
    expect(sim.onSimTerminated).not.toHaveBeenCalled();
  });

  it("starts the profile switcher and both device listeners (#736)", () => {
    const { sd, adapter } = fakes([]);

    createElgatoExtension(sd, adapter).start({ sim: fakeSim().sim });

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
    start({ sim: fakeSim().sim });
    refreshDevices();

    expect(adapter.switchToBundledProfile).toHaveBeenCalledWith("dev", "Default", undefined);
    expect(initProfileSwitcher).toHaveBeenCalledOnce();
    expect(getConnectedDeviceType()).toBe(7);
    expect(updateGlobalSettings).toHaveBeenCalledOnce();
  });

  it("wires the profile switcher to the adapter's profile switch and the device listeners to the deck push", () => {
    const { sd, adapter } = fakes([{ id: "b", name: "B", type: 7, isConnected: true }]);

    createElgatoExtension(sd, adapter).start({ sim: fakeSim().sim });
    const [switcher] = vi.mocked(initProfileSwitcher).mock.calls[0];
    switcher("dev", "Default", 3);
    vi.mocked(sd.devices.onDeviceDidConnect).mock.calls[0][0]({} as never);

    expect(adapter.switchToProfile).toHaveBeenCalledWith("dev", "Default", 3);
    expect(updateGlobalSettings).toHaveBeenCalledOnce();
  });

  it("starts the session-kind profile switch on the context sim's ticks and exit (#1111, #1500)", () => {
    const { sd, adapter } = fakes([]);
    const { sim } = fakeSim();

    createElgatoExtension(sd, adapter).start({ sim });

    expect(sim.onTick).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(sim.onSimTerminated).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(adapter.createLogger).toHaveBeenCalledWith("SessionProfile");
  });

  it("reads the session kind through the context sim on each tick, never before one (#1500)", () => {
    const { sd, adapter } = fakes([]);
    const { sim, tick } = fakeSim();

    const enabled = { profileAutoSwitchEnabled: true } as ReturnType<typeof getGlobalSettings>;

    // Two ticks read the settings twice; the Once forms leave nothing behind for later tests.
    vi.mocked(getGlobalSettings).mockReturnValueOnce(enabled).mockReturnValueOnce(enabled);
    createElgatoExtension(sd, adapter).start({ sim });

    expect(sim.getSessionKind).not.toHaveBeenCalled();

    tick();
    tick();

    expect(sim.getSessionKind).toHaveBeenCalledTimes(2);
    // A tick with no kind names the raw session type, also read through the context.
    expect(sim.getRawSessionType).toHaveBeenCalled();
  });

  it("leaves the session-kind profile switch off when the build has no profiles", () => {
    const { sd, adapter } = fakes([]);

    const { sim } = fakeSim();

    vi.mocked(getFeatureFlag).mockReturnValueOnce(false);
    createElgatoExtension(sd, adapter).start({ sim });

    expect(getFeatureFlag).toHaveBeenCalledWith("profiles");
    expect(sim.onTick).not.toHaveBeenCalled();
    expect(sim.onSimTerminated).not.toHaveBeenCalled();
  });

  it("switches each connected deck to its variant of the mapped profile, on page 0, through the switcher's history", () => {
    const { sd, adapter } = fakes([
      { id: "xl", name: "XL", type: 2, isConnected: true },
      { id: "gone", name: "Gone", type: 0, isConnected: false },
    ]);

    const { sim, tick } = fakeSim();

    // The fake sim is this test's own; the settings mock is shared, so it is a
    // Once form and leaves nothing behind for later tests.
    sim.getSessionKind.mockReturnValue("race");
    vi.mocked(getGlobalSettings).mockReturnValueOnce({
      profileAutoSwitchEnabled: true,
      profileForSessionKindRace: "iRaceDeck Race",
    } as ReturnType<typeof getGlobalSettings>);

    createElgatoExtension(sd, adapter).start({ sim });
    tick();

    expect(requestProfileSwitch).toHaveBeenCalledExactlyOnceWith("xl", "iRaceDeck Race XL", 0);
  });

  it("starts the session-kind profile switch when the build names no profiles flag", () => {
    const { sd, adapter } = fakes([]);

    const { sim } = fakeSim();

    vi.mocked(getFeatureFlag).mockReturnValueOnce(undefined);
    createElgatoExtension(sd, adapter).start({ sim });

    expect(sim.onTick).toHaveBeenCalledOnce();
  });

  it("adds Switch Profile and nothing else", () => {
    const { sd, adapter } = fakes([]);

    expect(createElgatoExtension(sd, adapter).extraActions).toBe(STREAM_DECK_ACTIONS);
  });
});
