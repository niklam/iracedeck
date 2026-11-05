import { FileSink } from "@iracedeck/logger/file-sink";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchdogDailyLogFileName } from "./main-thread-watchdog.js";

/**
 * On the Mirabox and Ulanzi hosts the main-thread watchdog's worker appends its
 * stall reports to the day's log file the plugin's own `FileSink`
 * (`@iracedeck/logger/file-sink`) writes (#1330). The worker must stay
 * self-contained, so it cannot import the sink's naming and keeps its own copy,
 * `watchdogDailyLogFileName`. This holds the two to one name: if they drift
 * apart, a stall report lands in a file nobody reads beside the support log.
 *
 * It is a fact about these two packages alone, so it lives here, where both are
 * already dependencies, rather than in each adapter that wires a sink (#1375).
 */
describe("the watchdog's daily log file name (#1330)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watchdog-daily-log-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  // Single-digit month and day (unpadded in both), two-digit ones, and both
  // sides of a year boundary, in local time.
  it.each([
    "2025-12-31T23:30:00",
    "2026-01-01T00:30:00",
    "2026-05-05T12:00:00",
    "2026-10-31T23:30:00",
    "2026-12-09T08:00:00",
  ])("is the file the logger's FileSink writes on %s", (localTime) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(localTime));

    new FileSink(dir, "Test").write("INFO", "x");

    expect(readdirSync(dir)).toEqual([watchdogDailyLogFileName(new Date())]);
  });

  it("names a different file on each side of midnight (positive control)", () => {
    expect(watchdogDailyLogFileName(new Date("2025-12-31T23:30:00"))).toBe("2025.12.31.log");
    expect(watchdogDailyLogFileName(new Date("2026-01-01T00:30:00"))).toBe("2026.1.1.log");
  });
});
