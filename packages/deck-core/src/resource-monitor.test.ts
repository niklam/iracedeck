import { type EventLoopUtilization, performance } from "node:perf_hooks";
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

const sample = (
  cpuPercent: number,
  elu: number,
  rssMb = 300,
  heapUsedMb = 60,
  heapTotalMb = 170,
  elapsedMs = 60_000,
): ResourceSample => ({
  elapsedMs,
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

describe("partial (edge) samples (#1338)", () => {
  it("count towards the session but neither extend nor break a run of high minutes", () => {
    const short = sample(95, 0.9, 300, 60, 170, 5000);
    const { state: afterTwo } = run([HIGH_CPU, HIGH_CPU]);
    const edge = resourceMonitorStep(afterTwo, short, true, undefined, true);

    expect(edge.lines).toEqual([
      { level: "debug", message: "Resources: cpu 95.0% core, loop 90.0%, rss 300 MB, heap 60/170 MB (partial, 5 s)" },
    ]);
    expect(edge.state.highRun).toHaveLength(2);
    expect(edge.state.session.samples).toBe(3);
    // The third full high minute after the edge still completes the run.
    expect(run([HIGH_CPU], true, edge.state).lines.map((l) => l.level)).toEqual(["warn"]);
  });

  it("do not count as the recovery sample after a WARN", () => {
    const { state } = run([HIGH_CPU, HIGH_CPU, HIGH_CPU]);
    const edge = resourceMonitorStep(state, sample(1, 0, 300, 60, 170, 5000), true, undefined, true);

    expect(edge.lines.filter((l) => l.level !== "debug")).toEqual([]);
    expect(edge.state.alerted).toBe(true);
  });
});

describe("resourceSessionSummary (#1338)", () => {
  it("reports the time-weighted average and the peaks of the in-session samples, then starts over", () => {
    const { state } = run([
      sample(10, 0.1, 300, 50, 100),
      sample(30, 0.4, 350, 80, 160),
      // A 30 s edge sample weighs half a minute in the average.
      sample(40, 0.2, 320, 70, 200, 30_000),
    ]);
    // A sample outside the session does not count.
    const { state: withOutside } = run([sample(99, 0.99, 999, 999, 999)], false, state);

    const summary = resourceSessionSummary(withOutside);

    // (10×60 + 30×60 + 40×30) / 150 = 24.0
    expect(summary.lines).toEqual([
      { level: "info", message: "Resource summary for the iRacing session" },
      {
        level: "debug",
        message:
          "Resource summary: 3 samples over 2.5 min, cpu avg 24.0% peak 40.0% core, loop peak 40.0%, rss peak 350 MB, heap peak 80/200 MB",
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

    expect(reading.elapsedMs).toBeGreaterThanOrEqual(29);
    expect(reading.cpuPercent).toBeGreaterThan(0);
    expect(reading.elu).toBeGreaterThanOrEqual(0);
    expect(reading.elu).toBeLessThanOrEqual(1);
    expect(reading.rssBytes).toBeGreaterThan(0);
    expect(reading.heapUsedBytes).toBeLessThanOrEqual(reading.heapTotalBytes);
  });

  it("reads each counter once per sample and diffs the readings, so no slice between samples is lost", () => {
    // Every absolute read advances the counters, as real time would.
    let cpuReads = 0;
    let eluReads = 0;
    const cpuUsage = vi.spyOn(process, "cpuUsage").mockImplementation((previous?: NodeJS.CpuUsage) => {
      if (previous) throw new Error("the sampler must diff by hand, never ask for a delta");

      cpuReads++;

      return { user: cpuReads * 1000, system: cpuReads * 500 };
    });
    const elu = vi
      .spyOn(performance, "eventLoopUtilization")
      .mockImplementation((current?: EventLoopUtilization, previous?: EventLoopUtilization) => {
        if (current && previous) {
          const active = current.active - previous.active;
          const idle = current.idle - previous.idle;

          return { active, idle, utilization: active / (active + idle) };
        }

        eluReads++;

        return { active: eluReads * 10, idle: eluReads * 30, utilization: 0.25 };
      });

    try {
      const sampler = createProcessResourceSampler();
      const first = sampler();
      const second = sampler();

      // One absolute read at creation and one per sample.
      expect(cpuReads).toBe(3);
      expect(eluReads).toBe(3);

      // Each delta is exactly one step of the counters: nothing between two
      // samples went missing into a second, discarded read.
      for (const reading of [first, second]) {
        expect((reading.cpuPercent * reading.elapsedMs) / 100).toBeCloseTo(1.5, 6);
        expect(reading.elu).toBeCloseTo(0.25, 6);
      }
    } finally {
      cpuUsage.mockRestore();
      elu.mockRestore();
    }
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

  /** A sampler that reports how long since its previous call, at a fixed CPU load. */
  function clockSampler(cpuPercent = 10): () => ResourceSample {
    let last = Date.now();

    return () => {
      const now = Date.now();
      const elapsedMs = now - last;

      last = now;

      return sample(cpuPercent, 0.1, 300, 60, 170, elapsedMs);
    };
  }

  function edges() {
    let start: (() => void) | undefined;
    let end: (() => void) | undefined;

    return {
      onSessionStart: (listener: () => void) => {
        start = listener;

        return () => {
          start = undefined;
        };
      },
      onSessionEnd: (listener: () => void) => {
        end = listener;

        return () => {
          end = undefined;
        };
      },
      start: () => start?.(),
      end: () => end?.(),
    };
  }

  it("samples on its interval and WARNs through the logger", () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const monitor = startResourceMonitor({ logger, sampler: () => HIGH_CPU, isSessionActive: () => true });

    expect(logger.info).toHaveBeenCalledWith("Resource monitor started");

    vi.advanceTimersByTime(3 * 60_000);

    expect(logger.debug).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^Plugin CPU use is high: 80\.0% of one core/));

    monitor.stop();
    vi.advanceTimersByTime(10 * 60_000);

    expect(logger.debug).toHaveBeenCalledTimes(3);
  });

  it("samples at each session edge and restarts its minute there, so every interval is wholly in or out", () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const hooks = edges();
    const monitor = startResourceMonitor({
      logger,
      sampler: clockSampler(),
      isSessionActive: () => false,
      onSessionStart: hooks.onSessionStart,
      onSessionEnd: hooks.onSessionEnd,
    });
    const debugLines = () => logger.debug.mock.calls.map(([m]) => m as string);

    vi.advanceTimersByTime(60_000 + 20_000); // one full minute outside, then 20 s more
    hooks.start(); // edge: the 20 s outside are closed off as a partial sample

    expect(debugLines()).toHaveLength(2);
    expect(debugLines()[1]).toMatch(/\(partial, 20 s\)$/);

    vi.advanceTimersByTime(59_000);

    expect(debugLines()).toHaveLength(2); // the minute restarted at the edge

    vi.advanceTimersByTime(1000 + 60_000 + 15_000); // two full minutes inside, then 15 s
    hooks.end(); // edge: the 15 s inside are a partial sample, then the summary

    expect(debugLines().slice(-2)).toEqual([
      expect.stringMatching(/\(partial, 15 s\)$/),
      // Two full minutes plus the 15 s edge, never the 80 s from before the start.
      expect.stringMatching(/^Resource summary: 3 samples over 2\.3 min, /),
    ]);
    expect(logger.info.mock.calls.at(-1)?.[0]).toBe("Resource summary for the iRacing session");

    vi.advanceTimersByTime(59_000);

    expect(debugLines()).toHaveLength(6); // the minute restarted at the exit too

    monitor.stop();
  });

  it("ignores an edge that does not change sides", () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const hooks = edges();
    const monitor = startResourceMonitor({
      logger,
      sampler: clockSampler(),
      isSessionActive: () => true,
      onSessionStart: hooks.onSessionStart,
      onSessionEnd: hooks.onSessionEnd,
    });

    vi.advanceTimersByTime(10_000);
    hooks.start();

    expect(logger.debug).not.toHaveBeenCalled();

    hooks.end();
    hooks.end();

    // One partial sample at the first exit, then its summary; the second exit is no edge.
    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith("Resource summary for the iRacing session");

    monitor.stop();
  });

  it("unsubscribes both edges on stop", () => {
    const unsubscribeStart = vi.fn();
    const unsubscribeEnd = vi.fn();
    const monitor = startResourceMonitor({
      logger: makeLogger(),
      sampler: () => NORMAL,
      onSessionStart: () => unsubscribeStart,
      onSessionEnd: () => unsubscribeEnd,
    });

    monitor.stop();

    expect(unsubscribeStart).toHaveBeenCalled();
    expect(unsubscribeEnd).toHaveBeenCalled();
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
