import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetCpuProfileCapture,
  captureFileStem,
  type CpuProfile,
  createCpuProfileCapture,
  formatCpuProfileSummary,
  getCpuProfileCapture,
  initializeCpuProfileCapture,
  type InspectorSessionLike,
  isCpuProfileCaptureInitialized,
  PROFILE_CAPTURE_STATUS_KEY,
  pruneCpuProfiles,
  summarizeCpuProfile,
} from "./cpu-profile-capture.js";
import { createSettingsWindowCommandHandler } from "./settings-window-commands.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Transpile the capture module and its constants leaf into `dir` as plain ES
 * modules and return the module's URL. Node's own type stripping cannot load
 * the source directly: it does not map the `./cpu-profile-capture-constants.js`
 * specifier onto the `.ts` file beside it.
 */
function transpileCaptureModule(dir: string): string {
  const ts = createRequire(join(HERE, "..", "package.json"))("typescript") as typeof import("typescript");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));

  for (const name of ["cpu-profile-capture", "cpu-profile-capture-constants"]) {
    const output = ts.transpileModule(readFileSync(join(HERE, `${name}.ts`), "utf-8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    writeFileSync(join(dir, `${name}.js`), output);
  }

  return pathToFileURL(join(dir, "cpu-profile-capture.js")).href;
}

function makeLogger() {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withLevel: () => logger,
    createScope: () => logger,
  };

  return logger;
}

/** A profile of `(root)` → `hot` / `(idle)`, with a sample every 1000 µs. */
function syntheticProfile(): CpuProfile {
  const frame = (functionName: string, url = "", lineNumber = 0, columnNumber = 0) => ({
    functionName,
    url,
    lineNumber,
    columnNumber,
  });

  return {
    nodes: [
      { id: 1, callFrame: frame("(root)"), children: [2, 3, 4, 5] },
      { id: 2, callFrame: frame("hot", "file:///plugin.js", 9, 4) },
      { id: 3, callFrame: frame("(idle)") },
      { id: 4, callFrame: frame("(garbage collector)") },
      // The same function reached through a second caller path: merged.
      { id: 5, callFrame: frame("hot", "file:///plugin.js", 9, 4) },
    ],
    startTime: 0,
    endTime: 10_000,
    // 10 samples at 0..9 ms; the last runs to endTime.
    samples: [2, 2, 5, 3, 3, 3, 3, 3, 4, 2],
    timeDeltas: [0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };
}

describe("captureFileStem", () => {
  it("is the ISO time made filename-safe, so it still sorts chronologically", () => {
    expect(captureFileStem(new Date("2026-10-04T12:30:05.123Z"))).toBe("cpu-2026-10-04T12-30-05-123Z");
  });
});

describe("summarizeCpuProfile", () => {
  it("computes wall, busy and self time per function, merging caller paths", () => {
    const summary = summarizeCpuProfile(syntheticProfile());

    expect(summary.wallUs).toBe(10_000);
    expect(summary.sampleCount).toBe(10);
    expect(summary.busyUs).toBe(5000);
    expect(summary.entries.map((e) => [e.functionName, e.selfUs])).toEqual([
      ["(idle)", 5000],
      ["hot", 4000],
      ["(garbage collector)", 1000],
    ]);
    expect(summary.entries[1]).toMatchObject({ url: "file:///plugin.js", line: 10, column: 5 });
    expect(summary.entries[0].label).toMatch(/waiting/);
    expect(summary.entries[2].label).toMatch(/garbage collection/);
  });

  it("formats the top entries with their positions, labelling the pseudo-frames", () => {
    const text = formatCpuProfileSummary(summarizeCpuProfile(syntheticProfile()), {
      stem: "cpu-x",
      samplingIntervalUs: 1000,
    });

    expect(text).toContain("Wall time:  0.01 s");
    expect(text).toContain("Busy time:  0.01 s (50.0% of wall time)");
    expect(text).toMatch(/4\.0 ms {2}40\.0% {2}hot {2}file:\/\/\/plugin\.js:10:5/);
    expect(text).toMatch(/\(idle\) {2}\[not code: the thread was waiting for work\]/);
  });

  it("treats only V8's own pseudo-frames as labelled, never a function that shares an Object.prototype name", () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: 0, columnNumber: 0 }, children: [2, 3] },
        { id: 2, callFrame: { functionName: "toString", url: "", lineNumber: 4, columnNumber: 2 } },
        { id: 3, callFrame: { functionName: "constructor", url: "", lineNumber: 0, columnNumber: 0 } },
      ],
      startTime: 0,
      endTime: 2000,
      samples: [2, 3],
      timeDeltas: [0, 1000],
    };
    const summary = summarizeCpuProfile(profile);

    for (const entry of summary.entries) expect(entry.label).toBeUndefined();

    const text = formatCpuProfileSummary(summary, { stem: "cpu-x", samplingIntervalUs: 1000 });

    expect(text).toMatch(/toString {2}\(native\):5:3/);
    expect(text).not.toContain("[function");
  });

  it("keeps only the top N", () => {
    const text = formatCpuProfileSummary(summarizeCpuProfile(syntheticProfile()), {
      stem: "cpu-x",
      samplingIntervalUs: 1000,
      top: 1,
    });

    expect(text).toContain("(idle)");
    expect(text).not.toContain("hot");
  });
});

describe("pruneCpuProfiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-profiles-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps exactly the newest five pairs and never touches other files", async () => {
    const stems = Array.from({ length: 7 }, (_, i) => captureFileStem(new Date(Date.UTC(2026, 9, 4, 12, i))));

    for (const stem of stems) {
      writeFileSync(join(dir, `${stem}.cpuprofile`), "{}");
      writeFileSync(join(dir, `${stem}.txt`), "");
    }

    const others = ["notes.txt", "cpu-mine.txt", `${stems[0]}.log`, `${stems[0]}.cpuprofile.bak`, "heap.heapsnapshot"];

    for (const name of others) writeFileSync(join(dir, name), "keep me");

    await pruneCpuProfiles(dir, 5);

    const kept = stems.slice(2).flatMap((stem) => [`${stem}.cpuprofile`, `${stem}.txt`]);

    expect(readdirSync(dir).sort()).toEqual([...kept, ...others].sort());
  });

  it("is a no-op on a missing folder", async () => {
    await expect(pruneCpuProfiles(join(dir, "missing"), 5)).resolves.toBeUndefined();
  });
});

/** A session double that hands back `profile` on `Profiler.stop`. */
function fakeSession(profile: CpuProfile, calls: string[] = []): InspectorSessionLike {
  return {
    connect: () => calls.push("connect"),
    disconnect: () => calls.push("disconnect"),
    post: (method, params, callback) => {
      calls.push(method === "Profiler.setSamplingInterval" ? `${method}:${JSON.stringify(params)}` : method);
      callback(null, method === "Profiler.stop" ? { profile } : {});
    },
  };
}

describe("createCpuProfileCapture (injected session)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-capture-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const statusesOf = (write: ReturnType<typeof vi.fn>) =>
    write.mock.calls.map(([partial]) => JSON.parse((partial as Record<string, string>)[PROFILE_CAPTURE_STATUS_KEY]));

  it("profiles at 1 ms, saves both files into a folder it creates, and publishes capturing then saved", async () => {
    const calls: string[] = [];
    const write = vi.fn();
    const logger = makeLogger();
    const profilesDir = join(dir, "logs", "profiles");
    const capture = createCpuProfileCapture({
      profilesDir,
      logger,
      writeSettings: write,
      durationMs: 1,
      now: () => new Date("2026-10-04T12:30:05.123Z"),
      openSession: async () => fakeSession(syntheticProfile(), calls),
    });

    const result = await capture.capture();

    expect(result).toEqual({
      ok: true,
      profileFile: join(profilesDir, "cpu-2026-10-04T12-30-05-123Z.cpuprofile"),
      summaryFile: join(profilesDir, "cpu-2026-10-04T12-30-05-123Z.txt"),
    });
    expect(calls).toEqual([
      "connect",
      "Profiler.enable",
      'Profiler.setSamplingInterval:{"interval":1000}',
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable",
      "disconnect",
    ]);
    expect(JSON.parse(readFileSync(join(profilesDir, "cpu-2026-10-04T12-30-05-123Z.cpuprofile"), "utf-8"))).toEqual(
      syntheticProfile(),
    );
    expect(statusesOf(write)).toEqual([
      { state: "capturing", startedAt: Date.parse("2026-10-04T12:30:05.123Z"), durationMs: 1 },
      {
        state: "saved",
        startedAt: Date.parse("2026-10-04T12:30:05.123Z"),
        file: "cpu-2026-10-04T12-30-05-123Z.cpuprofile",
      },
    ]);
    expect(logger.info.mock.calls.map(([m]) => m)).toEqual(["CPU profile capture started", "CPU profile saved"]);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(profilesDir));
    expect(capture.isCapturing()).toBe(false);
  });

  it("prunes after each save", async () => {
    let minute = 0;
    const capture = createCpuProfileCapture({
      profilesDir: dir,
      logger: makeLogger(),
      writeSettings: vi.fn(),
      durationMs: 1,
      keep: 2,
      now: () => new Date(Date.UTC(2026, 9, 4, 12, minute++)),
      openSession: async () => fakeSession(syntheticProfile()),
    });

    for (let i = 0; i < 4; i++) await capture.capture();

    expect(readdirSync(dir).sort()).toEqual([
      "cpu-2026-10-04T12-02-00-000Z.cpuprofile",
      "cpu-2026-10-04T12-02-00-000Z.txt",
      "cpu-2026-10-04T12-03-00-000Z.cpuprofile",
      "cpu-2026-10-04T12-03-00-000Z.txt",
    ]);
  });

  it("fails with the reason, and WARNs, when the inspector is unavailable", async () => {
    const write = vi.fn();
    const logger = makeLogger();
    const capture = createCpuProfileCapture({
      profilesDir: dir,
      logger,
      writeSettings: write,
      durationMs: 1,
      openSession: async () => {
        throw new Error("Inspector is not available");
      },
    });

    const result = await capture.capture();

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("Inspector is not available") });
    expect(statusesOf(write).at(-1)).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("inspector is not available"),
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^CPU profile capture failed: /));
    expect(capture.isCapturing()).toBe(false);
  });

  it("fails with the reason when the profile cannot be written", async () => {
    const blocker = join(dir, "not-a-folder");
    writeFileSync(blocker, "");
    const write = vi.fn();
    const capture = createCpuProfileCapture({
      profilesDir: join(blocker, "profiles"),
      logger: makeLogger(),
      writeSettings: write,
      durationMs: 1,
      openSession: async () => fakeSession(syntheticProfile()),
    });

    const result = await capture.capture();

    expect(result.ok).toBe(false);
    expect(statusesOf(write).at(-1)).toMatchObject({ state: "failed", reason: expect.stringMatching(/written/) });
  });

  it("reports the capture's real start when a last-resort failure ends it", async () => {
    const write = vi.fn();
    const logger = makeLogger();
    const times = [new Date("2026-10-04T12:00:00.000Z"), new Date("2026-10-04T12:05:00.000Z")];
    const capture = createCpuProfileCapture({
      profilesDir: dir,
      logger,
      writeSettings: write,
      durationMs: 1,
      now: () => times.shift() ?? new Date("2026-10-04T13:00:00.000Z"),
      openSession: async () => fakeSession(syntheticProfile()),
      summarize: () => {
        throw new Error("summary bug");
      },
    });

    const result = await capture.capture();

    expect(result).toEqual({ ok: false, reason: "summary bug" });
    expect(statusesOf(write).at(-1)).toEqual({
      state: "failed",
      startedAt: Date.parse("2026-10-04T12:00:00.000Z"),
      reason: "summary bug",
    });
    expect(logger.warn).toHaveBeenCalledWith("CPU profile capture failed: summary bug");
    expect(capture.isCapturing()).toBe(false);
  });

  it("refuses a second request while one is running, without touching the published state", async () => {
    const write = vi.fn();
    const capture = createCpuProfileCapture({
      profilesDir: dir,
      logger: makeLogger(),
      writeSettings: write,
      durationMs: 50,
      openSession: async () => fakeSession(syntheticProfile()),
    });

    const first = capture.capture();
    const second = await capture.capture();

    expect(second).toEqual({ ok: false, reason: "a capture is already running", busy: true });
    expect(capture.isCapturing()).toBe(true);
    expect((await first).ok).toBe(true);
    expect(statusesOf(write).map((s) => s.state)).toEqual(["capturing", "saved"]);
  });
});

describe("the shared capture service (#1338)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-capture-shared-"));
    _resetCpuProfileCapture();
  });

  afterEach(() => {
    _resetCpuProfileCapture();
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (write = vi.fn()) => ({
    profilesDir: dir,
    logger: makeLogger(),
    writeSettings: write,
    durationMs: 50,
    openSession: async () => fakeSession(syntheticProfile()),
  });

  it("throws before it is initialized, then hands every consumer the same instance", () => {
    expect(isCpuProfileCaptureInitialized()).toBe(false);
    expect(() => getCpuProfileCapture()).toThrow("CPU profile capture not initialized");

    const created = initializeCpuProfileCapture(options());

    expect(isCpuProfileCaptureInitialized()).toBe(true);
    expect(getCpuProfileCapture()).toBe(created);
    expect(getCpuProfileCapture()).toBe(getCpuProfileCapture());
  });

  it("refuses a second initialization", () => {
    initializeCpuProfileCapture(options());

    expect(() => initializeCpuProfileCapture(options())).toThrow("already initialized");
  });

  it("refuses a key's request while a capture started from the settings window runs", async () => {
    initializeCpuProfileCapture(options());
    const handle = createSettingsWindowCommandHandler({
      writeSettings: vi.fn(),
      captureCpuProfile: () => {
        void getCpuProfileCapture().capture();
      },
    });

    handle({ event: "captureCpuProfile" });

    // What the Telemetry Control key does on a press.
    const fromKey = await getCpuProfileCapture().capture();

    expect(fromKey).toEqual({ ok: false, reason: "a capture is already running", busy: true });
    expect(getCpuProfileCapture().status().state).toBe("capturing");

    // Let the window's capture finish before the folder is removed.
    await vi.waitFor(() => expect(getCpuProfileCapture().status().state).toBe("saved"));
  });

  it("tells status listeners every published state, and stops after unsubscribe", async () => {
    const capture = initializeCpuProfileCapture(options());
    const heard: string[] = [];
    const unsubscribe = capture.onStatus((status) => heard.push(status.state));

    expect(capture.status()).toEqual({ state: "idle" });

    await capture.capture();

    expect(heard).toEqual(["capturing", "saved"]);
    expect(capture.status().state).toBe("saved");

    unsubscribe();
    await capture.capture();

    expect(heard).toEqual(["capturing", "saved"]);
  });

  it("keeps publishing when a status listener throws", async () => {
    const write = vi.fn();
    const capture = initializeCpuProfileCapture(options(write));

    capture.onStatus(() => {
      throw new Error("listener bug");
    });

    expect((await capture.capture()).ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

/**
 * The real capture in a child Node process, importing the module transpiled
 * from source. A child, so the profiler and the busy loop never share a thread
 * with the test runner.
 */
function runCaptureChild(
  moduleUrl: string,
  profilesDir: string,
): Promise<{ first: unknown; second: unknown; statuses: unknown[] }> {
  const script = `
    import { createCpuProfileCapture } from ${JSON.stringify(moduleUrl)};

    const quiet = () => {};
    const logger = { trace: quiet, debug: quiet, info: quiet, warn: quiet, error: quiet };
    logger.withLevel = () => logger;
    logger.createScope = () => logger;
    const statuses = [];

    let done = false;
    function busyFunctionForTheProfiler() {
      const end = performance.now() + 20;
      let n = 0;
      while (performance.now() < end) n += Math.sqrt(n + 1);
      return n;
    }
    const tick = () => {
      if (done) return;
      busyFunctionForTheProfiler();
      setImmediate(tick);
    };
    tick();

    const capture = createCpuProfileCapture({
      profilesDir: ${JSON.stringify(profilesDir)},
      logger,
      writeSettings: (partial) => statuses.push(JSON.parse(partial._profileCaptureStatus)),
      durationMs: 2000,
    });
    const pending = capture.capture();
    const second = await capture.capture();
    const first = await pending;
    done = true;
    process.stdout.write(JSON.stringify({ first, second, statuses }));
  `;

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--no-warnings", "--input-type=module", "-e", script],
      { timeout: 20000 },
      (err, stdout, stderr) => (err ? reject(new Error(`${String(err)}\n${stderr}`)) : resolve(JSON.parse(stdout))),
    );
  });
}

describe("createCpuProfileCapture in a real process", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ird-capture-real-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a DevTools-readable profile and a summary naming the busy function, refusing a concurrent request", async () => {
    const profilesDir = join(dir, "profiles");
    mkdirSync(dir, { recursive: true });

    const moduleDir = join(dir, "module");
    mkdirSync(moduleDir, { recursive: true });

    const { first, second, statuses } = await runCaptureChild(transpileCaptureModule(moduleDir), profilesDir);

    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual({ ok: false, reason: "a capture is already running", busy: true });
    expect((statuses as { state: string }[]).map((s) => s.state)).toEqual(["capturing", "saved"]);

    const { profileFile, summaryFile } = first as { profileFile: string; summaryFile: string };

    expect(existsSync(profileFile)).toBe(true);

    const profile = JSON.parse(readFileSync(profileFile, "utf-8")) as CpuProfile;

    expect(Array.isArray(profile.nodes)).toBe(true);
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(profile.samples?.length).toBeGreaterThan(500);
    expect(profile.endTime - profile.startTime).toBeGreaterThanOrEqual(1_900_000);

    const text = readFileSync(summaryFile, "utf-8");
    const topLines = text.split("\n").filter((line) => / ms +\d+\.\d%/.test(line));

    expect(topLines.length).toBeGreaterThan(0);
    expect(topLines.length).toBeLessThanOrEqual(30);
    expect(text).toMatch(/busyFunctionForTheProfiler {2}file:\/\/.*:\d+:\d+/);
  }, 30000);
});
