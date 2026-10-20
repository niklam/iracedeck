import { describe, expect, it } from "vitest";

import {
  evaluateNativeAddonWarnings,
  NATIVE_ADDON_WARNING_IDS,
  type NativeAddonStatuses,
  nativeLoadErrorLines,
  snapshotNativeAddons,
} from "./native-addons.js";

const IRACING_ERROR = "\\\\?\\C:\\Users\\someone\\plugin\\bin\\iracing_native.node is not a valid Win32 application.";
const AUDIO_ERROR = "The specified module could not be found.";

const HEALTHY: NativeAddonStatuses = { iracing: { kind: "native" }, audio: { kind: "native" } };
const BOTH_FAILED: NativeAddonStatuses = {
  iracing: { kind: "load-failed", error: IRACING_ERROR },
  audio: { kind: "load-failed", error: AUDIO_ERROR },
};

/** Every status that is not a failed load: these say nothing. */
const SILENT: [string, NativeAddonStatuses][] = [
  ["both native", HEALTHY],
  ["both forced mocks", { iracing: { kind: "mock", reason: "forced" }, audio: { kind: "mock", reason: "forced" } }],
  [
    "both platform mocks",
    { iracing: { kind: "mock", reason: "platform" }, audio: { kind: "mock", reason: "platform" } },
  ],
  ["one native, one forced", { iracing: { kind: "native" }, audio: { kind: "mock", reason: "forced" } }],
];

describe("nativeLoadErrorLines (#1373)", () => {
  it.each(SILENT)("logs nothing for %s", (_name, statuses) => {
    expect(nativeLoadErrorLines(statuses)).toEqual([]);
  });

  it("logs one line per failed addon, iRacing first, each naming its addon and carrying its error", () => {
    const lines = nativeLoadErrorLines(BOTH_FAILED);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^iRacing native addon \(iracing_native\.node\) failed to load/);
    expect(lines[0].endsWith(`: ${IRACING_ERROR}`)).toBe(true);
    expect(lines[1]).toMatch(/^Audio native addon \(audio_native\.node\) failed to load/);
    expect(lines[1].endsWith(`: ${AUDIO_ERROR}`)).toBe(true);
  });

  it("logs only the addon that failed", () => {
    const lines = nativeLoadErrorLines({ iracing: { kind: "native" }, audio: BOTH_FAILED.audio });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("audio_native.node");
    expect(lines[0]).toContain(AUDIO_ERROR);
  });
});

describe("evaluateNativeAddonWarnings (#1373)", () => {
  it.each(SILENT)("raises nothing for %s", (_name, statuses) => {
    expect(evaluateNativeAddonWarnings(statuses)).toEqual([]);
  });

  it("raises one error-level banner per failed addon, under its own id", () => {
    const warnings = evaluateNativeAddonWarnings(BOTH_FAILED);

    expect(warnings.map((w) => [w.id, w.level])).toEqual([
      ["native-addon-iracing", "error"],
      ["native-addon-audio", "error"],
    ]);
    expect(NATIVE_ADDON_WARNING_IDS).toEqual({ iracing: "native-addon-iracing", audio: "native-addon-audio" });
  });

  it("raises only the failed addon's banner", () => {
    expect(
      evaluateNativeAddonWarnings({ iracing: BOTH_FAILED.iracing, audio: { kind: "mock", reason: "forced" } }).map(
        (w) => w.id,
      ),
    ).toEqual(["native-addon-iracing"]);
  });

  it("says what does not work and the two remedies, and points at the log", () => {
    const [iracing, audio] = evaluateNativeAddonWarnings(BOTH_FAILED);

    expect(iracing.message).toBe(
      "iRaceDeck could not load its iRacing component, so keys cannot read or control iRacing. Reinstall the plugin and check that your antivirus has not quarantined it. The plugin log has the details.",
    );
    expect(audio.message).toBe(
      "iRaceDeck could not load its audio component, so the Race Engineer and the radar are silent. Reinstall the plugin and check that your antivirus has not quarantined it. The plugin log has the details.",
    );
  });

  // The banner sits under the Windows profile's settings; the log line carries the path.
  it("puts no part of the load error in a banner", () => {
    for (const warning of evaluateNativeAddonWarnings(BOTH_FAILED)) {
      expect(warning.message).not.toContain("someone");
      expect(warning.message).not.toContain("\\");
      expect(warning.message).not.toContain(AUDIO_ERROR);
    }
  });

  // `ird-warnings` prepends its own level icon (global-settings.md).
  it("starts no message with an emoji", () => {
    for (const warning of evaluateNativeAddonWarnings(BOTH_FAILED)) {
      expect(warning.message).toMatch(/^[A-Za-z]/);
    }
  });
});

describe("snapshotNativeAddons (#1373)", () => {
  it("keeps each kind, and a mock's reason", () => {
    expect(snapshotNativeAddons({ iracing: { kind: "native" }, audio: { kind: "mock", reason: "platform" } })).toEqual({
      iracing: { kind: "native" },
      audio: { kind: "mock", reason: "platform" },
    });
  });

  it("drops a failed load's error text", () => {
    expect(snapshotNativeAddons(BOTH_FAILED)).toEqual({
      iracing: { kind: "load-failed" },
      audio: { kind: "load-failed" },
    });
  });
});
