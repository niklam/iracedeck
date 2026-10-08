/**
 * Resource monitor (#1338): the plugin reports its own CPU, event-loop and
 * memory use into its log, so a "the plugin uses a lot of CPU" report comes
 * with numbers attached.
 *
 * Once a minute, on an `unref`'d timer, it samples `process.cpuUsage()` (as a
 * delta, % of one core), `performance.eventLoopUtilization()` (as a delta) and
 * `process.memoryUsage()`. The decision is the pure reducer
 * {@link resourceMonitorStep}, so the rule unit-tests without timers:
 *
 * - **High:** CPU ≥ 50 % of one core, or event-loop utilisation ≥ 0.5, for
 *   three consecutive samples writes ONE `WARN` with the numbers. The logging
 *   rule keeps info lines parameter-free, so the numbers ride on the WARN — the
 *   line a support log needs.
 * - **Recovery:** the first sample below both thresholds after a WARN writes
 *   `INFO` "Plugin CPU use back to normal", then the rule re-arms.
 * - **Every sample:** one `debug` line with the figures.
 * - **Session summary:** at each iRacing exit, `INFO` "Resource summary for the
 *   iRacing session" plus a `debug` line with the time-weighted average and the
 *   peak CPU, the peak event-loop load and the peak RSS and heap.
 *
 * **Session edges.** A sample's figures cover the whole interval since the
 * previous one, so attributing it by whether iRacing is active when it is
 * taken would hand a minute that was mostly outside a session to the session,
 * or the other way round. Instead the monitor takes an extra sample at each
 * edge — iRacing starting and exiting — and restarts its minute there, so
 * every interval lies wholly inside or wholly outside a session. An edge
 * sample is PARTIAL: it is logged and counted towards the session, but it is
 * not a minute, so it neither extends nor breaks the run of high minutes. The
 * summary is written after the exit edge's sample.
 *
 * None of it is gated on `debugLogging`: users run with debug off, and the WARN
 * and INFO lines are what reaches their logs.
 *
 * The app-monitor hooks are injected rather than imported, the way the window
 * service receives `isIRacingActive` (#1176): `app-monitor` lives in
 * `@iracedeck/deck-iracing`, a layer above this package (#1351, #1367).
 *
 * Decision record: `docs/superpowers/specs/2026-10-04-issue-1338-built-in-profiling.md`.
 */
import type { ILogger } from "@iracedeck/logger";
import { type EventLoopUtilization, performance } from "node:perf_hooks";

/** One interval's reading. */
export interface ResourceSample {
  /** How long the interval was. */
  elapsedMs: number;
  /** CPU time used over the interval, as a % of one core (may exceed 100 on several cores). */
  cpuPercent: number;
  /** Event-loop utilisation over the interval, 0..1. */
  elu: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
}

export interface ResourceMonitorConfig {
  /** The sampling interval, used only to word the WARN's time span. */
  intervalMs: number;
  /** % of one core at or above which a sample is high. */
  cpuPercentThreshold: number;
  /** Event-loop utilisation at or above which a sample is high. */
  eluThreshold: number;
  /** How many consecutive high samples raise the WARN. */
  consecutiveHigh: number;
}

/** The spec's values (#1338). */
export const RESOURCE_MONITOR_DEFAULTS: ResourceMonitorConfig = {
  intervalMs: 60_000,
  cpuPercentThreshold: 50,
  eluThreshold: 0.5,
  consecutiveHigh: 3,
};

/** Running aggregates for the current iRacing session. */
export interface ResourceSessionStats {
  samples: number;
  /** Σ elapsed time of the session's samples, for the time-weighted average. */
  elapsedMs: number;
  /** Σ cpuPercent × elapsedMs. */
  cpuPercentMs: number;
  cpuPeak: number;
  eluPeak: number;
  rssPeak: number;
  heapUsedPeak: number;
  heapTotalPeak: number;
}

export interface ResourceMonitorState {
  /** The current run of consecutive high samples, newest last (at most `consecutiveHigh` kept). */
  highRun: ResourceSample[];
  /** A WARN has been written and recovery has not been seen yet. */
  alerted: boolean;
  session: ResourceSessionStats;
}

export interface ResourceLogLine {
  level: "debug" | "info" | "warn";
  message: string;
}

const EMPTY_SESSION: ResourceSessionStats = {
  samples: 0,
  elapsedMs: 0,
  cpuPercentMs: 0,
  cpuPeak: 0,
  eluPeak: 0,
  rssPeak: 0,
  heapUsedPeak: 0,
  heapTotalPeak: 0,
};

/** @internal Exported for testing */
export function initialResourceMonitorState(): ResourceMonitorState {
  return { highRun: [], alerted: false, session: { ...EMPTY_SESSION } };
}

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);
const pct = (fraction: number): string => (fraction * 100).toFixed(1);

function minutes(ms: number): string {
  const value = ms / 60_000;

  return Number.isInteger(value) ? `${value} min` : `${value.toFixed(1)} min`;
}

/**
 * One sample in, the next state and the log lines out.
 *
 * @param inSession whether the sample's whole interval lies inside an iRacing session
 * @param partial an edge sample, shorter than an interval: logged and counted
 *   towards the session, but it does not take part in the high/normal rule
 * @internal Exported for testing
 */
export function resourceMonitorStep(
  state: ResourceMonitorState,
  sample: ResourceSample,
  inSession: boolean,
  config: ResourceMonitorConfig = RESOURCE_MONITOR_DEFAULTS,
  partial = false,
): { state: ResourceMonitorState; lines: ResourceLogLine[] } {
  const lines: ResourceLogLine[] = [
    {
      level: "debug",
      message:
        `Resources: cpu ${sample.cpuPercent.toFixed(1)}% core, loop ${pct(sample.elu)}%, ` +
        `rss ${mb(sample.rssBytes)} MB, heap ${mb(sample.heapUsedBytes)}/${mb(sample.heapTotalBytes)} MB` +
        (partial ? ` (partial, ${(sample.elapsedMs / 1000).toFixed(0)} s)` : ""),
    },
  ];

  const session = inSession
    ? {
        samples: state.session.samples + 1,
        elapsedMs: state.session.elapsedMs + sample.elapsedMs,
        cpuPercentMs: state.session.cpuPercentMs + sample.cpuPercent * sample.elapsedMs,
        cpuPeak: Math.max(state.session.cpuPeak, sample.cpuPercent),
        eluPeak: Math.max(state.session.eluPeak, sample.elu),
        rssPeak: Math.max(state.session.rssPeak, sample.rssBytes),
        heapUsedPeak: Math.max(state.session.heapUsedPeak, sample.heapUsedBytes),
        heapTotalPeak: Math.max(state.session.heapTotalPeak, sample.heapTotalBytes),
      }
    : state.session;

  if (partial) return { state: { ...state, session }, lines };

  const high = sample.cpuPercent >= config.cpuPercentThreshold || sample.elu >= config.eluThreshold;

  if (!high) {
    if (state.alerted) lines.push({ level: "info", message: "Plugin CPU use back to normal" });

    return { state: { highRun: [], alerted: false, session }, lines };
  }

  const highRun = [...state.highRun, sample].slice(-config.consecutiveHigh);

  if (state.alerted || highRun.length < config.consecutiveHigh) {
    return { state: { highRun, alerted: state.alerted, session }, lines };
  }

  const cpu = highRun.reduce((sum, s) => sum + s.cpuPercent, 0) / highRun.length;
  const elu = highRun.reduce((sum, s) => sum + s.elu, 0) / highRun.length;

  lines.push({
    level: "warn",
    message:
      `Plugin CPU use is high: ${cpu.toFixed(1)}% of one core, event loop ${pct(elu)}% busy, ` +
      `over ${minutes(config.consecutiveHigh * config.intervalMs)} ` +
      `(rss ${mb(sample.rssBytes)} MB, heap ${mb(sample.heapUsedBytes)}/${mb(sample.heapTotalBytes)} MB)`,
  });

  return { state: { highRun, alerted: true, session }, lines };
}

/**
 * The session summary at an iRacing exit; the session's aggregates start over.
 * A session that took no sample writes nothing.
 *
 * @internal Exported for testing
 */
export function resourceSessionSummary(state: ResourceMonitorState): {
  state: ResourceMonitorState;
  lines: ResourceLogLine[];
} {
  const s = state.session;
  const next = { ...state, session: { ...EMPTY_SESSION } };

  if (s.samples === 0) return { state: next, lines: [] };

  const average = s.elapsedMs > 0 ? s.cpuPercentMs / s.elapsedMs : 0;

  return {
    state: next,
    lines: [
      { level: "info", message: "Resource summary for the iRacing session" },
      {
        level: "debug",
        message:
          `Resource summary: ${s.samples} samples over ${minutes(s.elapsedMs)}, cpu avg ${average.toFixed(1)}% ` +
          `peak ${s.cpuPeak.toFixed(1)}% core, loop peak ${pct(s.eluPeak)}%, ` +
          `rss peak ${mb(s.rssPeak)} MB, heap peak ${mb(s.heapUsedPeak)}/${mb(s.heapTotalPeak)} MB`,
      },
    ],
  };
}

/** Reads the process's counters as deltas since the previous call. */
export type ResourceSampler = () => ResourceSample;

/**
 * The real sampler: CPU and event-loop deltas since the previous call (or
 * since creation), memory as of now.
 *
 * Each counter is read ONCE per sample and diffed against the previous
 * reading by hand. Reading a delta and then a fresh baseline would drop
 * whatever ran between the two reads from every interval.
 *
 * @internal Exported for testing
 */
export function createProcessResourceSampler(): ResourceSampler {
  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();
  let lastElu: EventLoopUtilization = performance.eventLoopUtilization();

  return () => {
    const cpu = process.cpuUsage();
    const at = performance.now();
    const elu = performance.eventLoopUtilization();
    const cpuMicros = cpu.user - lastCpu.user + (cpu.system - lastCpu.system);
    const eluDelta = performance.eventLoopUtilization(elu, lastElu);
    const elapsedMs = Math.max(1, at - lastAt);
    const memory = process.memoryUsage();

    lastCpu = cpu;
    lastAt = at;
    lastElu = elu;

    return {
      elapsedMs,
      cpuPercent: (cpuMicros / 1000 / elapsedMs) * 100,
      elu: eluDelta.utilization,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
    };
  };
}

export interface ResourceMonitorOptions {
  logger: ILogger;
  /** Subscribe to iRacing starting; the plugin binds deck-iracing's `onIRacingStarted`. Returns an unsubscribe. */
  onSessionStart?: (listener: () => void) => () => void;
  /** Subscribe to iRacing exits; the plugin binds deck-iracing's `onIRacingTerminated`. Returns an unsubscribe. */
  onSessionEnd?: (listener: () => void) => () => void;
  /**
   * Whether iRacing is active when the monitor starts; the plugin binds
   * `isIRacingActive`. After that the edges decide. Without it the monitor
   * starts inside a session unless it was given an `onSessionStart` to wait for.
   */
  isSessionActive?: () => boolean;
  config?: Partial<ResourceMonitorConfig>;
  sampler?: ResourceSampler;
}

export interface ResourceMonitor {
  /** Take a full-interval sample now, outside the timer (tests). */
  sampleNow(): void;
  stop(): void;
}

/**
 * Start the monitor for the rest of the run. Call once, after logging is up.
 * The timer is `unref`'d, so it never keeps the plugin alive.
 */
export function startResourceMonitor(options: ResourceMonitorOptions): ResourceMonitor {
  const { logger } = options;
  const config: ResourceMonitorConfig = { ...RESOURCE_MONITOR_DEFAULTS, ...options.config };
  const sampler = options.sampler ?? createProcessResourceSampler();
  let state = initialResourceMonitorState();
  let inSession = options.isSessionActive ? options.isSessionActive() : !options.onSessionStart;
  let timer: ReturnType<typeof setInterval> | undefined;

  const emit = (lines: ResourceLogLine[]): void => {
    for (const line of lines) logger[line.level](line.message);
  };

  const take = (partial: boolean): void => {
    try {
      const result = resourceMonitorStep(state, sampler(), inSession, config, partial);
      state = result.state;
      emit(result.lines);
    } catch (err) {
      logger.debug(`Resource sample failed: ${String(err)}`);
    }
  };

  const startTimer = (): void => {
    if (timer !== undefined) clearInterval(timer);

    timer = setInterval(() => take(false), config.intervalMs);
    timer.unref();
  };

  /** Close the interval that ends at the edge, switch sides, and start a fresh minute. */
  const edge = (starting: boolean): void => {
    if (starting === inSession) return;

    take(true);
    inSession = starting;
    startTimer();

    if (!starting) {
      const result = resourceSessionSummary(state);
      state = result.state;
      emit(result.lines);
    }
  };

  startTimer();

  const unsubscribeStart = options.onSessionStart?.(() => edge(true));
  const unsubscribeEnd = options.onSessionEnd?.(() => edge(false));

  logger.info("Resource monitor started");

  return {
    sampleNow: () => take(false),
    stop: () => {
      if (timer !== undefined) clearInterval(timer);

      timer = undefined;
      unsubscribeStart?.();
      unsubscribeEnd?.();
    },
  };
}
