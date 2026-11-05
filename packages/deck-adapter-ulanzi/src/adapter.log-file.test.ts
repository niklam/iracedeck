import { watchdogDailyLogFileName } from "@iracedeck/diagnostics";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UlanziPlatformAdapter } from "./adapter.js";

// The adapter's per-day log file (#609), written by `@iracedeck/logger`'s
// shared `FileSink` (#1375, whose own tests cover naming, format and
// retention). What is checked here is this host's wiring of it.
describe("UlanziPlatformAdapter log file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ulanzi-log-"));
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  // The main-thread watchdog's worker appends to this file on its own (#1330)
  // and must stay self-contained, so it keeps its own copy of the name. This
  // fails if the two drift apart.
  it.each(["2026-01-01T00:30:00", "2026-05-05T12:00:00", "2026-10-31T23:30:00", "2026-12-09T08:00:00"])(
    "names the day's file in its log location as the main-thread watchdog does (%s)",
    (localTime) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(localTime));

      const adapter = new UlanziPlatformAdapter(undefined, dir);
      adapter.createLogger("Scope").info("x");

      expect(adapter.logLocation).toEqual({ kind: "daily", dir });
      expect(readdirSync(dir)).toEqual([watchdogDailyLogFileName(new Date())]);
    },
  );

  it("tags the sink's console failure messages with the Ulanzi label", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    new UlanziPlatformAdapter(undefined, "\0invalid").createLogger("Scope").info("x");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[Ulanzi FileSink\] write failed: /));
  });
});
