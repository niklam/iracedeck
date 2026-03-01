import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetSDK, getCommands, getController, getSDK, initializeSDK, isSDKInitialized } from "./sdk-singleton.js";

// Mock the iracing-sdk createSDK function
vi.mock("@iracedeck/iracing-sdk", () => ({
  createSDK: vi.fn(() => ({
    sdk: { mockSdk: true },
    controller: { mockController: true },
    commands: { mockCommands: true },
  })),
}));

// Mock the logger
vi.mock("@iracedeck/logger", () => ({
  silentLogger: { mockLogger: true },
}));

describe("SDK Singleton", () => {
  afterEach(() => {
    _resetSDK();
    vi.clearAllMocks();
  });

  describe("isSDKInitialized", () => {
    it("should return false before initialization", () => {
      expect(isSDKInitialized()).toBe(false);
    });

    it("should return true after initialization", () => {
      initializeSDK();

      expect(isSDKInitialized()).toBe(true);
    });
  });

  describe("initializeSDK", () => {
    it("should return the SDK bundle", () => {
      const bundle = initializeSDK();

      expect(bundle).toHaveProperty("sdk");
      expect(bundle).toHaveProperty("controller");
      expect(bundle).toHaveProperty("commands");
    });

    it("should throw if called twice", () => {
      initializeSDK();

      expect(() => initializeSDK()).toThrow("SDK already initialized");
    });
  });

  describe("getSDK", () => {
    it("should throw if not initialized", () => {
      expect(() => getSDK()).toThrow("SDK not initialized");
    });

    it("should return the SDK bundle after initialization", () => {
      initializeSDK();
      const bundle = getSDK();

      expect(bundle).toHaveProperty("sdk");
      expect(bundle).toHaveProperty("controller");
      expect(bundle).toHaveProperty("commands");
    });
  });

  describe("getController", () => {
    it("should throw if not initialized", () => {
      expect(() => getController()).toThrow("SDK not initialized");
    });

    it("should return the controller after initialization", () => {
      initializeSDK();
      const controller = getController();

      expect(controller).toEqual({ mockController: true });
    });
  });

  describe("getCommands", () => {
    it("should throw if not initialized", () => {
      expect(() => getCommands()).toThrow("SDK not initialized");
    });

    it("should return the commands after initialization", () => {
      initializeSDK();
      const commands = getCommands();

      expect(commands).toEqual({ mockCommands: true });
    });
  });

  describe("_resetSDK", () => {
    it("should reset the SDK state", () => {
      initializeSDK();

      expect(isSDKInitialized()).toBe(true);

      _resetSDK();

      expect(isSDKInitialized()).toBe(false);
    });

    it("should allow re-initialization after reset", () => {
      initializeSDK();
      _resetSDK();

      expect(() => initializeSDK()).not.toThrow();
    });
  });
});
