import { describe, expect, it, vi } from "vitest";

import {
  callAddonSetDeviceReroutedCallback,
  callAddonSetSessionIdentity,
  getNativeLoadStatus,
  loadNativeAddon,
} from "./index.js";

describe("callAddonSetSessionIdentity (#1253)", () => {
  it("reports false instead of throwing when the loaded binary predates setSessionIdentity", () => {
    expect(callAddonSetSessionIdentity({}, "iRaceDeck", "C:/plugin/imgs/plugin/iracedeck.ico")).toBe(false);
  });

  it("forwards both arguments and the result to a binary that has it", () => {
    const setSessionIdentity = vi.fn<(displayName: string, iconPath?: string) => boolean>(() => true);

    expect(callAddonSetSessionIdentity({ setSessionIdentity }, "iRaceDeck", "C:/icon.ico")).toBe(true);
    expect(setSessionIdentity).toHaveBeenCalledWith("iRaceDeck", "C:/icon.ico");
  });

  it("passes on the binary's refusal", () => {
    const setSessionIdentity = vi.fn<(displayName: string, iconPath?: string) => boolean>(() => false);

    expect(callAddonSetSessionIdentity({ setSessionIdentity }, "iRaceDeck")).toBe(false);
    expect(setSessionIdentity).toHaveBeenCalledWith("iRaceDeck", undefined);
  });
});

describe("callAddonSetDeviceReroutedCallback (#1330)", () => {
  it("does nothing instead of throwing when the loaded binary predates setDeviceReroutedCallback", () => {
    expect(() => callAddonSetDeviceReroutedCallback({}, () => {})).not.toThrow();
  });

  it("forwards the callback to a binary that has it", () => {
    const setDeviceReroutedCallback = vi.fn<(callback: (() => void) | null) => void>();
    const callback = (): void => {};

    callAddonSetDeviceReroutedCallback({ setDeviceReroutedCallback }, callback);

    expect(setDeviceReroutedCallback).toHaveBeenCalledWith(callback);
  });

  it("forwards a clear (null) to a binary that has it", () => {
    const setDeviceReroutedCallback = vi.fn<(callback: (() => void) | null) => void>();

    callAddonSetDeviceReroutedCallback({ setDeviceReroutedCallback }, null);

    expect(setDeviceReroutedCallback).toHaveBeenCalledWith(null);
  });
});

describe("loadNativeAddon (#1373)", () => {
  it("returns the addon and a native status when the loader succeeds", () => {
    const addon = { initAudioEngine: () => true };
    const load = vi.fn(() => addon);

    expect(loadNativeAddon({ platform: "win32", forceMock: false, load })).toEqual({
      addon,
      status: { kind: "native" },
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the thrown message when the loader throws, and returns no addon", () => {
    const load = vi.fn(() => {
      throw new Error("The specified module could not be found.");
    });

    expect(loadNativeAddon({ platform: "win32", forceMock: false, load })).toEqual({
      addon: null,
      status: { kind: "load-failed", error: "The specified module could not be found." },
    });
  });

  it("reports a forced mock without calling the loader", () => {
    const load = vi.fn();

    expect(loadNativeAddon({ platform: "win32", forceMock: true, load })).toEqual({
      addon: null,
      status: { kind: "mock", reason: "forced" },
    });
    expect(load).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"])("reports the platform mock on %s without calling the loader", (platform) => {
    const load = vi.fn();

    expect(loadNativeAddon({ platform, forceMock: false, load })).toEqual({
      addon: null,
      status: { kind: "mock", reason: "platform" },
    });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("getNativeLoadStatus (#1373)", () => {
  // The suite forces the mock (#1084), so the module's own load never tried the `.node`.
  it("reports the module's load as a mock under the test suite", () => {
    expect(getNativeLoadStatus()).toEqual({
      kind: "mock",
      reason: process.platform === "win32" ? "forced" : "platform",
    });
  });
});
