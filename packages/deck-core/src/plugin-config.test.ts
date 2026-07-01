import { afterEach, describe, expect, it } from "vitest";

import {
  _resetPluginConfig,
  getFeatureFlag,
  getPlatformFeatures,
  getPluginPlatform,
  getPluginVersion,
  initPluginConfig,
  isPluginConfigInitialized,
  type PlatformFeatures,
} from "./plugin-config.js";

const ALL_TRUE_FEATURES: PlatformFeatures = {
  capabilities: { svgFilters: true, svgMasks: true, svgPatterns: true },
  features: { borderGlow: true, profiles: true },
};

const ALL_FALSE_FEATURES: PlatformFeatures = {
  capabilities: { svgFilters: false, svgMasks: false, svgPatterns: false },
  features: { borderGlow: false, profiles: false },
};

describe("plugin-config", () => {
  afterEach(() => {
    _resetPluginConfig();
  });

  describe("initPluginConfig", () => {
    it("should initialize with the provided config", () => {
      initPluginConfig({ version: "1.13.0", platform: "stream-deck" });

      expect(getPluginVersion()).toBe("1.13.0");
      expect(getPluginPlatform()).toBe("stream-deck");
    });

    it("should throw if called twice", () => {
      initPluginConfig({ version: "1.13.0", platform: "stream-deck" });

      expect(() => initPluginConfig({ version: "1.14.0", platform: "mirabox" })).toThrow("already initialized");
    });
  });

  describe("getPluginVersion", () => {
    it("should throw if not initialized", () => {
      expect(() => getPluginVersion()).toThrow("not initialized");
    });

    it("should return the version string", () => {
      initPluginConfig({ version: "2.0.0", platform: "stream-deck" });

      expect(getPluginVersion()).toBe("2.0.0");
    });
  });

  describe("getPluginPlatform", () => {
    it("should throw if not initialized", () => {
      expect(() => getPluginPlatform()).toThrow("not initialized");
    });

    it("should return stream-deck platform", () => {
      initPluginConfig({ version: "1.0.0", platform: "stream-deck" });

      expect(getPluginPlatform()).toBe("stream-deck");
    });

    it("should return mirabox platform", () => {
      initPluginConfig({ version: "1.0.0", platform: "mirabox" });

      expect(getPluginPlatform()).toBe("mirabox");
    });
  });

  describe("isPluginConfigInitialized", () => {
    it("should return false before initialization", () => {
      expect(isPluginConfigInitialized()).toBe(false);
    });

    it("should return true after initialization", () => {
      initPluginConfig({ version: "1.0.0", platform: "stream-deck" });

      expect(isPluginConfigInitialized()).toBe(true);
    });
  });

  describe("_resetPluginConfig", () => {
    it("should allow re-initialization after reset", () => {
      initPluginConfig({ version: "1.0.0", platform: "stream-deck" });
      _resetPluginConfig();

      initPluginConfig({ version: "2.0.0", platform: "mirabox" });

      expect(getPluginVersion()).toBe("2.0.0");
      expect(getPluginPlatform()).toBe("mirabox");
    });
  });

  describe("getPlatformFeatures", () => {
    it("should throw if not initialized", () => {
      expect(() => getPlatformFeatures()).toThrow("not initialized");
    });

    it("should return undefined when featureFlags not provided", () => {
      initPluginConfig({ version: "1.0.0", platform: "stream-deck" });
      expect(getPlatformFeatures()).toBeUndefined();
    });

    it("should return the full platform features object when provided", () => {
      initPluginConfig({ version: "1.0.0", platform: "stream-deck", featureFlags: ALL_TRUE_FEATURES });
      expect(getPlatformFeatures()).toEqual(ALL_TRUE_FEATURES);
    });
  });

  describe("getFeatureFlag", () => {
    it("should return undefined when featureFlags not provided", () => {
      initPluginConfig({ version: "1.0.0", platform: "stream-deck" });
      expect(getFeatureFlag("borderGlow")).toBeUndefined();
    });

    it("should return true when flag is enabled", () => {
      initPluginConfig({ version: "1.0.0", platform: "stream-deck", featureFlags: ALL_TRUE_FEATURES });
      expect(getFeatureFlag("borderGlow")).toBe(true);
    });

    it("should return false when flag is disabled", () => {
      initPluginConfig({ version: "1.0.0", platform: "mirabox", featureFlags: ALL_FALSE_FEATURES });
      expect(getFeatureFlag("borderGlow")).toBe(false);
    });
  });
});
