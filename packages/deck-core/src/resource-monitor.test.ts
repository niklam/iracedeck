import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProcessResourceSampler,
  initialResourceMonitorState,
  type ResourceLogLine,
  type ResourceMonitorState,
  resourceMonitorStep,
  type ResourceSample,
  resourceSessionSummary,
  startResourceMonitor,
} from "./resource-monitor.js";

const MB = 1024 * 1024;

const sample = (cpuPercent: number, elu: number, rssMb = 300, heapUsedMb = 60, heapTotalMb = 170): ResourceSample => ({
  cpuPercent,
  elu,
  rssBytes: rssMb * MB,
  heapUsedBytes: heapUsedMb * MB,
  heapTotalBytes: heapTotalMb * MB,
});

const HIGH_CPU = sample(80, 0.2);
const HIGH_LOOP = sample(10, 0.7);
const NORMAL = sample(10, 0.1);

/** Feed samples through the reducer; returns the final state and every non-debug line. */
function run(samples: ResourceSample[], inSession = true, from: ResourceMonitorState = initialResourceMonitorState()) {
  let state = from;
  const lines: ResourceLogLine[] = [];

  for (const s of samples) {
    const result = resourceMonitorStep(state, s, inSession);
    state = result.state;
    lines.push(...result.lines.filter((line) => line.level !== "debug"));
  }

  return { state, lines };
}

describe("resourceMonitorStep (#1338)", () => {
  it("writes one debug line per sample with the figures", () => {
    const { lines } = resourceMonitorStep(initialResourceMonitorState(), sample(12.34, 0.098, 340, 64, 172), true);

    expect(lines).toEqual([
      { level: "debug", message: "Resources: cpu 12.3% core, loop 9.8%, rss 340 MB, heap 64/172 MB" },
    ]);
  });

  it("WARNs once, with the numbers, after three consecutive high samples", () => {
    const { lines } = run([sample(60, 0.3), sample(70, 0.4), sample(80, 0.5, 400, 90, 200)]);

    expect(lines).toEqual([
      {
        level: "warn",
        message:
          "Plugin CPU use is high: 70.0% of one core, event loop 40.0% busy, over 3 min (rss 400 MB, heap 90/200 MB)",
      },
    ]);
  });

  it("does not repeat the WARN while use stays high", () => {
    const { lines } = run([HIGH_CPU, HIGH_CPU, HIGH_CPU, HIGH_CPU, HIGH_CPU, HIGH_CPU]);

    expect(lines.filter((line) => line.level === "warn")).toHaveLength(1);
  });

  it("says nothing for two high samples followed by a normal one", () => {
    expect(run([HIGH_CPU, HIGH_CPU, NORMAL]).lines).toEqual([]);
    // The run was broken: two more highs are still not three.
    expect(run([HIGH_CPU, HIGH_CPU, NORMAL, HIGH_CPU, HIGH_CPU]).lines).toEqual([]);
  });

  it("writes one recovery INFO on the first normal sample after a WARN, then re-arms", () => {
    const { lines } = run([HIGH_CPU, HIGH_CPU, HIGH_CPU, NORMAL, NORMAL, HIGH_CPU, HIGH_CPU, HIGH_CPU]);

    expect(lines.map((line) => [line.level, line.message.split(":")[0]])).toEqual([
      ["warn", "Plugin CPU use is high"],
      ["info", "Plugin CPU use back to normal"],
      ["warn", "Plugin CPU use is high"],
    ]);
    // The INFO line is parameter-free, per the logging rule.
    expect(lines[1].message).toBe("Plugin CPU use back to normal");
  });

  it("is triggered by CPU alone", () => {
    expect(run([HIGH_CPU, HIGH_CPU, HIGH_CPU]).lines.map((l) => l.level)).toEqual(["warn"]);
  });

  it("is triggered by the event loop alone", () => {
    expect(run([HIGH_LOOP, HIGH_LOOP, HIGH_LOOP]).lines.map((l) => l.level)).toEqual(["warn"]);
  });

  it("treats both thresholds as inclusive and anything below both as normal", () => {
    expect(run([sample(50, 0), sample(50, 0), sample(50, 0)]).lines.map((l) => l.level)).toEqual(["warn"]);
    expect(run([sample(0, 0.5), sample(0, 0.5), sample(0, 0.5)]).lines.map((l) => l.level)).toEqual(["warn"]);
    expect(run([sample(49.9, 0.49), sample(49.9, 0.49), sample(49.9, 0.49)]).lines).toEqual([]);
  });

  it("mixes CPU-high and loop-high samples into one run", () => {
    expect(run([HIGH_CPU, HIGH_LOOP, HIGH_CPU]).lines.map((l) => l.level)).toEqual(["warn"]);
  });
});

describe("resourceSessionSummary (#1338)", () => {
  it("reports the average and peaks of the in-session samples, then starts over", () => {
    const { state } = run([
      sample(10, 0.1, 300, 50, 100),
      sample(30, 0.4, 350, 80, 160),
      sample(20, 0.2, 320, 70, 200),
    ]);
    // A sample while iRacing is not active does not count.
    const { state: withOutside } = run([sample(99, 0.99, 999, 999, 999)], false, state);

    const summary = resourceSessionSummary(withOutside);

    expect(summary.lines).toEqual([
      { level: "info", message: "Resource summary for the iRacing session" },
      {
        level: "debug",
        message:
          "Resource summary: 3 samples, cpu avg 20.0% peak 30.0% core, loop peak 40.0%, rss peak 350 MB, heap peak 80/200 MB",
      },
    ]);
    expect(summary.state.session.samples).toBe(0);
    expect(resourceSessionSummary(summary.state).lines).toEqual([]);
  });

  it("keeps the alert state across a summary", () => {
    const { state } = run([HIGH_CPU, HIGH_CPU, HIGH_CPU]);

    expect(resourceSessionSummary(state).state.alerted).toBe(true);
  });
});

describe("createProcessResourceSampler", () => {
  it("reads plausible deltas from this process", () => {
    const sampler = createProcessResourceSampler();
    const end = performance.now() + 30;

    while (performance.now() < end) {
      // Burn a little CPU so the delta is non-zero.
    }

    const reading = sampler();

    expect(reading.cpuPercent).toBeGreaterThan(0);
    expect(reading.elu).toBeGreaterThanOrEqual(0);
    expect(reading.elu).toBeLessThanOrEqual(1);
    expect(reading.rssBytes).toBeGreaterThan(0);
    expect(reading.heapUsedBytes).toBeLessThanOrEqual(reading.heapTotalBytes);
  });
});

describe("startResourceMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("samples on its interval, WARNs through the logger, and summarises at a session end", () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    let endSession: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const monitor = startResourceMonitor({
      logger,
      sampler: () => HIGH_CPU,
      isSessionActive: () => true,
      onSessionEnd: (listener) => {
        endSession = listener;

        return unsubscribe;
      },
    });

    expect(logger.info).toHaveBeenCalledWith("Resource monitor started");

    vi.advanceTimersByTime(3 * 60_000);

    expect(logger.debug).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^Plugin CPU use is high: 80\.0% of one core/));

    endSession?.();

    expect(logger.info).toHaveBeenCalledWith("Resource summary for the iRacing session");

    monitor.stop();
    vi.advanceTimersByTime(10 * 60_000);

    expect(logger.debug).toHaveBeenCalledTimes(4); // three samples + the summary detail
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("survives a sampler that throws", () => {
    const logger = makeLogger();
    const monitor = startResourceMonitor({
      logger,
      sampler: () => {
        throw new Error("boom");
      },
    });

    expect(() => monitor.sampleNow()).not.toThrow();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("boom"));
    monitor.stop();
  });
});
