import { afterEach, describe, expect, it, vi } from "vitest";

import { FocusResult, PointerMoveResult } from "./defines.js";
import { getNativeLoadStatus, IRacingNative, loadNativeAddon, type NativeLoadResult } from "./index.js";

describe("loadNativeAddon (#1373)", () => {
  it("returns the addon and a native status when the loader succeeds", () => {
    const addon = { startup: () => true };
    const load = vi.fn(() => addon);

    expect(loadNativeAddon({ platform: "win32", forceMock: false, load })).toEqual({
      addon,
      status: { kind: "native" },
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps the thrown message when the loader throws, and returns no addon", () => {
    const load = vi.fn(() => {
      throw new Error("C:\\plugin\\bin\\iracing_native.node is not a valid Win32 application.");
    });

    expect(loadNativeAddon({ platform: "win32", forceMock: false, load })).toEqual({
      addon: null,
      status: { kind: "load-failed", error: "C:\\plugin\\bin\\iracing_native.node is not a valid Win32 application." },
    });
  });

  it("stringifies a thrown non-Error", () => {
    const result = loadNativeAddon({
      platform: "win32",
      forceMock: false,
      load: () => {
        throw "quarantined";
      },
    });

    expect(result.status).toEqual({ kind: "load-failed", error: "quarantined" });
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

describe("IRacingNative over its load outcome (#1373)", () => {
  const failed: NativeLoadResult<never> = {
    addon: null,
    status: { kind: "load-failed", error: "cannot load" },
  };
  const forced: NativeLoadResult<never> = { addon: null, status: { kind: "mock", reason: "forced" } };

  afterEach(() => vi.restoreAllMocks());

  describe("a failed load", () => {
    it("never connects: startup is false and the data side stays null", () => {
      const native = new IRacingNative(failed);

      expect(native.startup()).toBe(false);
      expect(native.isConnected()).toBe(false);
      expect(native.getHeader()).toBeNull();
      expect(native.getData(0)).toBeNull();
      expect(native.waitForData(0)).toBeNull();
      expect(native.getSessionInfoStr()).toBeNull();
    });

    it("stays disconnected across repeated startups, as the SDK's reconnect poll makes", () => {
      const native = new IRacingNative(failed);

      native.startup();
      native.startup();

      expect(native.isConnected()).toBe(false);
      expect(native.getHeader()).toBeNull();
    });

    it("still answers the input side with the mock's no-ops, and the elevation probe with no mismatch", async () => {
      const native = new IRacingNative(failed);
      vi.spyOn(console, "debug").mockImplementation(() => {});

      expect(() => native.sendScanKeys([0x1e])).not.toThrow();
      expect(() => native.sendScanKeyDown([0x1e])).not.toThrow();
      expect(() => native.sendScanKeyUp([0x1e])).not.toThrow();
      expect(() => native.sendScanKeySequence([[0x1e], [0x30]])).not.toThrow();
      expect(() => native.broadcastMsg(0, 0)).not.toThrow();
      expect(native.setClipboardText("hi")).toBe(true);
      expect(native.focusIRacingWindow()).toBe(FocusResult.AlreadyFocused);
      expect(native.moveMouseToIRacingWindow(0.5, 0.5)).toBe(PointerMoveResult.Moved);
      await expect(native.sendChatMessage("hello", 0, 0, 0)).resolves.toBe(true);
      expect(native.getElevationStatus().mismatch).toBe(false);
    });
  });

  // Positive control for the tests above: the same class over a forced mock
  // does start the rotating telemetry, so the nulls are the failed load's doing.
  it("serves the mock's telemetry over a forced mock, unchanged", () => {
    const native = new IRacingNative(forced);

    expect(native.startup()).toBe(true);
    expect(native.isConnected()).toBe(true);
    expect(native.getHeader()).not.toBeNull();
    expect(native.getData(0)).not.toBeNull();
  });

  it("delegates to the addon when it loaded", () => {
    const addon = { startup: vi.fn(() => true), isConnected: vi.fn(() => true) };
    const native = new IRacingNative({ addon, status: { kind: "native" } });

    expect(native.startup()).toBe(true);
    expect(native.isConnected()).toBe(true);
    expect(addon.startup).toHaveBeenCalledTimes(1);
    expect(addon.isConnected).toHaveBeenCalledTimes(1);
  });
});
