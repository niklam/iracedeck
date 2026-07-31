import { type ILogger, LogLevel } from "@iracedeck/logger";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileSink, withFileSink } from "./file-logger.js";

describe("FileSink", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ulanzi-log-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes to a per-day file named with unpadded month and day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00"));

    const sink = new FileSink(dir);
    sink.write("INFO", "[Scope] hello");

    // Computed with the same (faked) clock and the same non-padded formula the
    // sink uses — guards against a future `padStart` regressing the convention.
    const now = new Date();
    const expected = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.log`;

    expect(readdirSync(dir)).toEqual([expected]);
    expect(readFileSync(join(dir, expected), "utf-8")).toContain("INFO [Scope] hello");
  });

  it("appends successive lines to the same file", () => {
    const sink = new FileSink(dir);
    sink.write("INFO", "first");
    sink.write("DEBUG", "second");

    const [file] = readdirSync(dir);
    const contents = readFileSync(join(dir, file), "utf-8").trim().split("\n");

    expect(contents).toHaveLength(2);
    expect(contents[0]).toContain("INFO first");
    expect(contents[1]).toContain("DEBUG second");
  });

  it("creates the log directory if it does not exist", () => {
    const nested = join(dir, "deeper", "log");
    const sink = new FileSink(nested);

    sink.write("INFO", "made it");

    expect(readdirSync(nested)).toHaveLength(1);
  });

  it("does not throw when the path is unwritable", () => {
    // A path whose parent is a file, not a directory — mkdirSync will throw, and
    // the sink must swallow it (logging never crashes the plugin).
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new FileSink("\0invalid");

    expect(() => sink.write("INFO", "boom")).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("FileSink pruning", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ulanzi-log-"));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T12:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes log files older than the retention window on first write", () => {
    writeFileSync(join(dir, "2026.7.16.log"), "15 days old\n");
    writeFileSync(join(dir, "2026.7.17.log"), "exactly 14 days old\n");
    writeFileSync(join(dir, "2025.12.31.log"), "ancient\n");

    const sink = new FileSink(dir);
    sink.write("INFO", "today");

    expect(readdirSync(dir).sort()).toEqual(["2026.7.17.log", "2026.7.31.log"]);
  });

  it("leaves files that do not match the per-day log name pattern untouched", () => {
    writeFileSync(join(dir, "notes.log"), "not a per-day log\n");
    writeFileSync(join(dir, "readme.txt"), "hello\n");

    const sink = new FileSink(dir);
    sink.write("INFO", "today");

    expect(readdirSync(dir).sort()).toEqual(["2026.7.31.log", "notes.log", "readme.txt"]);
  });

  it("prunes only on the first write of a sink", () => {
    const sink = new FileSink(dir);
    sink.write("INFO", "first");

    writeFileSync(join(dir, "2020.1.1.log"), "appeared after the first write\n");
    sink.write("INFO", "second");

    expect(readdirSync(dir)).toContain("2020.1.1.log");
  });

  it("swallows prune failures and still writes the log line", () => {
    // A directory named like an expired log file — unlink throws on it, and the
    // sink must swallow that (logging never crashes the plugin) and still write.
    mkdirSync(join(dir, "2020.1.1.log"));
    // spyOn returns the spy already installed by an earlier test — clear its
    // recorded calls so this assertion can only see the prune failure.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    errorSpy.mockClear();

    const sink = new FileSink(dir);
    expect(() => sink.write("INFO", "still logged")).not.toThrow();

    expect(readFileSync(join(dir, "2026.7.31.log"), "utf-8")).toContain("INFO still logged");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("withFileSink", () => {
  let dir: string;
  let sink: FileSink;

  const makeBase = (): Record<string, ReturnType<typeof vi.fn>> => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: vi.fn(),
    createScope: vi.fn(),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ulanzi-log-"));
    sink = new FileSink(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readLog = (): string => {
    const files = readdirSync(dir);

    return files.length ? readFileSync(join(dir, files[0]), "utf-8") : "";
  };

  it("forwards every call to the base logger", () => {
    const base = makeBase();
    const logger = withFileSink(base as unknown as ILogger, "Scope", () => LogLevel.Info, sink);

    logger.info("hi");

    expect(base.info).toHaveBeenCalledWith("hi");
  });

  it("writes to the file only when the level passes the threshold", () => {
    const base = makeBase();
    let level = LogLevel.Info;
    const logger = withFileSink(base as unknown as ILogger, "Scope", () => level, sink);

    logger.debug("suppressed");
    expect(readLog()).toBe("");

    level = LogLevel.Debug;
    logger.debug("captured");
    expect(readLog()).toContain("DEBUG [Scope] captured");
  });

  it("prefixes file lines with the scope, matching createConsoleLogger", () => {
    const base = makeBase();
    const logger = withFileSink(base as unknown as ILogger, "Scope", () => LogLevel.Info, sink);

    logger.info("message");

    expect(readLog()).toContain("INFO [Scope] message");
  });

  it("chains scopes with a colon in the file prefix", () => {
    const base = makeBase();
    base.createScope.mockReturnValue(makeBase() as unknown as ILogger);
    const logger = withFileSink(base as unknown as ILogger, "Parent", () => LogLevel.Info, sink);

    logger.createScope("Child").info("nested");

    expect(base.createScope).toHaveBeenCalledWith("Child");
    expect(readLog()).toContain("INFO [Parent:Child] nested");
  });

  it("honours withLevel for file gating", () => {
    const base = makeBase();
    base.withLevel.mockReturnValue(makeBase() as unknown as ILogger);
    const logger = withFileSink(base as unknown as ILogger, "Scope", () => LogLevel.Info, sink);

    logger.withLevel(LogLevel.Debug).debug("via withLevel");

    expect(readLog()).toContain("DEBUG [Scope] via withLevel");
  });
});
