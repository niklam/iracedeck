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

  /**
   * Writes one line through a real `FileSink` at `localTime` (a fresh directory
   * per call) and compares the one file it created with what `name` returns
   * for that moment. The agreement test and its control share it, so the
   * control exercises the very comparison the agreement rests on.
   */
  function sinkFileMatches(localTime: string, name: (now: Date) => string): boolean {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(localTime));
    const caseDir = mkdtempSync(join(dir, "case-"));

    new FileSink(caseDir, "Test").write("INFO", "x");
    const written = readdirSync(caseDir);

    expect(written).toHaveLength(1);

    return written[0] === name(new Date());
  }

  // Single-digit month and day (unpadded in both), two-digit ones, and both
  // sides of a year boundary, in local time.
  it.each([
    "2025-12-31T23:30:00",
    "2026-01-01T00:30:00",
    "2026-05-05T12:00:00",
    "2026-10-31T23:30:00",
    "2026-12-09T08:00:00",
  ])("is the file the logger's FileSink writes on %s", (localTime) => {
    expect(sinkFileMatches(localTime, watchdogDailyLogFileName)).toBe(true);
  });

  // The drift this file exists to catch: a copy that zero-pads month and day.
  // It names the same file as the sink on a two-digit date and a different one
  // on a single-digit date, which is why the cases above include both.
  it("fails for a name that drifted from the sink's (positive control)", () => {
    const padded = (now: Date) =>
      `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}.log`;

    expect(sinkFileMatches("2026-10-31T23:30:00", padded)).toBe(true);
    expect(sinkFileMatches("2026-05-05T12:00:00", padded)).toBe(false);
    expect(sinkFileMatches("2026-01-01T00:30:00", padded)).toBe(false);
  });
});
