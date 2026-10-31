import { VOICE_PACK_DEV_BASE_URL_KEY } from "@iracedeck/app-constants";
import { type ILogger, silentLogger } from "@iracedeck/logger";
import { VOICE_PACK_CATALOG_URL } from "@iracedeck/voice-packs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { callLog, implement, resetRecorder } from "../../test-support/recorder.js";
import { warnIfCatalogOverride } from "./catalog-override-warning.js";

vi.mock("@iracedeck/voice-packs", async (io) =>
  (await import("../../test-support/module-mocks.js")).recordedModule(io),
);
vi.mock("@iracedeck/settings", async (io) => (await import("../../test-support/module-mocks.js")).recordedModule(io));

/** A silent logger that keeps its warnings. */
function logger(): ILogger & { warnings: string[] } {
  const warnings: string[] = [];

  return { ...silentLogger, warnings, warn: (message: string) => void warnings.push(message) };
}

describe("warnIfCatalogOverride (#1100, #1377)", () => {
  beforeEach(() => resetRecorder());

  function withOverride(value: unknown): void {
    implement("getGlobalSettings", () => ({ [VOICE_PACK_DEV_BASE_URL_KEY]: value }));
  }

  it.each([undefined, "", "   ", 42])("says nothing when no override is set (%j)", (value) => {
    withOverride(value);
    const log = logger();

    warnIfCatalogOverride(log);

    expect(log.warnings).toEqual([]);
    expect(callLog).not.toContain("resolveVoicePackCatalogUrl");
  });

  it("names the effective url when the override is active", () => {
    withOverride("https://dev.example.test/voices");
    const bases: unknown[] = [];
    implement("resolveVoicePackCatalogUrl", (p) => {
      bases.push((p as { base: unknown }).base);

      return "https://dev.example.test/voices/catalog.json";
    });
    const log = logger();

    warnIfCatalogOverride(log);

    expect(bases).toEqual(["https://dev.example.test/voices"]);
    expect(log.warnings).toEqual(["Voice pack catalog override active: https://dev.example.test/voices/catalog.json"]);
  });

  it("never calls a rejected override active: it resolved back to the published catalog", () => {
    withOverride("ftp://nope");
    implement("resolveVoicePackCatalogUrl", () => VOICE_PACK_CATALOG_URL);
    const log = logger();

    warnIfCatalogOverride(log);

    expect(log.warnings).toEqual(["Voice pack catalog override is set but has no effect; using the published catalog"]);
  });
});
