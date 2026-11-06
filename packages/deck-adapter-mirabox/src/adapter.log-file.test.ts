import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VSDPlatformAdapter } from "./adapter.js";

// The adapter's per-day log file (#609), written by `@iracedeck/logger`'s
// shared `FileSink` (#1375, whose own tests cover naming, format and
// retention; that its name is the one the main-thread watchdog appends to is
// `@iracedeck/diagnostics`' test). What is checked here is this host's wiring
// of it: the directory it reports as its log location, and its label.
describe("VSDPlatformAdapter log file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vsd-log-"));
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the day's file into the directory it reports as its log location", () => {
    const adapter = new VSDPlatformAdapter(undefined, dir);
    adapter.createLogger("Scope").info("x");

    expect(adapter.logLocation).toEqual({ kind: "daily", dir });
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^\d{4}\.\d{1,2}\.\d{1,2}\.log$/)]);
  });

  it("tags the sink's console failure messages with the VSD label", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    new VSDPlatformAdapter(undefined, "\0invalid").createLogger("Scope").info("x");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[VSD FileSink\] write failed: /));
  });
});
