import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { profilesDirFor, requireLogLocation } from "./log-location.js";
import { createFakeAdapter } from "./test-support/fake-host.js";

describe("profilesDirFor (#1338)", () => {
  it("puts profiles beside a fixed log file (Elgato: <cwd>/logs/profiles)", () => {
    expect(profilesDirFor({ kind: "file", path: join("C:", "sd", "logs", "com.iracedeck.sd.core.0.log") })).toBe(
      join("C:", "sd", "logs", "profiles"),
    );
  });

  it("puts profiles inside a daily log directory (Mirabox, Ulanzi: <plugin>/log/profiles)", () => {
    expect(profilesDirFor({ kind: "daily", dir: join("C:", "plugin", "log") })).toBe(
      join("C:", "plugin", "log", "profiles"),
    );
  });
});

describe("requireLogLocation", () => {
  it("returns the adapter's location", () => {
    expect(requireLogLocation(createFakeAdapter({ kind: "daily", dir: "D" }))).toEqual({ kind: "daily", dir: "D" });
  });

  it("refuses an adapter that writes no log file, naming the fix", () => {
    expect(() => requireLogLocation({ ...createFakeAdapter(), logLocation: undefined })).toThrow(/log directory/);
  });
});
