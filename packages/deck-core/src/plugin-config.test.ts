import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  _resetPluginConfig,
  getDevVoicePacksRoot,
  getFeatureFlag,
  getPlatformFeatures,
  getPluginPlatform,
  getPluginVersion,
  initPluginConfig,
  isPluginConfigInitialized,
  type PlatformFeatureFlags,
  type PlatformFeatures,
} from "./plugin-config.js";

const ALL_TRUE_FEATURES: PlatformFeatures = {
  features: { dialExtendedGestures: true, profiles: true, pngRasterization: true, trafficRejoin: true },
};

const ALL_FALSE_FEATURES: PlatformFeatures = {
  features: { dialExtendedGestures: false, profiles: false, pngRasterization: false, trafficRejoin: false },
};

/**
 * Every `PlatformFeatureFlags` key, as a value the files below are held to:
 * `satisfies` fails `pnpm typecheck` on a key the interface lacks or a key it
 * has and this list does not, so the list and the type cannot drift apart.
 */
const FLAG_NAMES = Object.keys({
  dialExtendedGestures: true,
  profiles: true,
  pngRasterization: true,
  trafficRejoin: true,
} satisfies Record<keyof PlatformFeatureFlags, true>).sort();

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/** The committed per-plugin flag files the shared Rollup factory reads (`platform-feature-flags.md`). */
const PLUGIN_FLAG_FILES = ["iracing-plugin-stream-deck", "iracing-plugin-mirabox", "iracing-plugin-ulanzi"].map(
  (pkg) => `packages/${pkg}/platform-features.json`,
);

function readFeatures(relative: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(path.join(repoRoot, relative), "utf-8")) as { features: Record<string, unknown> })
    .features;
}

describe("the committed platform-features.json files", () => {
  it.each(PLUGIN_FLAG_FILES)("%s declares exactly the PlatformFeatureFlags keys, each a boolean", (file) => {
    const features = readFeatures(file);

    expect(Object.keys(features).sort()).toEqual(FLAG_NAMES);

    for (const [name, value] of Object.entries(features)) expect(typeof value, name).toBe("boolean");
  });

  it.each(PLUGIN_FLAG_FILES)(
    "%s keeps the trafficRejoin development flag off, so no release build carries the rejoin warnings (#1113)",
    (file) => {
      expect(readFeatures(file).trafficRejoin).toBe(false);
    },
  );

  it("names in feature-flags.local.json.example only flags every plugin sets alike, since the local file merges over all three", () => {
    const example = readFeatures("feature-flags.local.json.example");

    for (const name of Object.keys(example)) {
      expect(FLAG_NAMES, name).toContain(name);
      expect(new Set(PLUGIN_FLAG_FILES.map((file) => readFeatures(file)[name])).size, name).toBe(1);
    }
  });
});

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
      expect(getFeatureFlag("dialExtendedGestures")).toBeUndefined();
    });

    it("should return true when flag is enabled", () => {
      initPluginConfig({ version: "1.0.0", platform: "stream-deck", featureFlags: ALL_TRUE_FEATURES });
      expect(getFeatureFlag("dialExtendedGestures")).toBe(true);
    });

    it("should return false when flag is disabled", () => {
      initPluginConfig({ version: "1.0.0", platform: "mirabox", featureFlags: ALL_FALSE_FEATURES });
      expect(getFeatureFlag("dialExtendedGestures")).toBe(false);
    });
  });

  describe("getDevVoicePacksRoot", () => {
    it("returns undefined when the build carried no development voice root", () => {
      initPluginConfig({ version: "3.3.0", platform: "stream-deck" });
      expect(getDevVoicePacksRoot()).toBeUndefined();
    });

    it("returns the absolute path a development build carries", () => {
      initPluginConfig({
        version: "3.3.0",
        platform: "stream-deck",
        devVoicePacksRoot: "C:\\repo\\packages\\audio-assets\\dist\\voice-packs",
      });
      expect(getDevVoicePacksRoot()).toBe("C:\\repo\\packages\\audio-assets\\dist\\voice-packs");
    });

    it("throws before initPluginConfig, like the other readers", () => {
      expect(() => getDevVoicePacksRoot()).toThrow(/not initialized/);
    });
  });
});
