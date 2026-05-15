/**
 * iRacing sim-event translator.
 *
 * Subscribes to `sdkController` ticks, diffs each snapshot against the
 * previous tick, and publishes semantic events through the shared
 * `@iracedeck/event-bus`. This is the only package allowed to import
 * `@iracedeck/iracing-sdk` for telemetry consumption — future sim
 * adapters (`sim-events-ac`, …) sit as parallel siblings and emit the
 * same event catalog.
 *
 * Lifecycle:
 *   - initializeSimEventsIracing(bus, sdkController, logger) subscribes
 *     under id "__sim-events-iracing__"; call once at plugin startup
 *     after initializeEventBus() and initializeSDK().
 *   - On each tick the translator stores the latest telemetry (available
 *     via getLatestTelemetry()) and invokes each diff module.
 *   - On disconnect it resets per-tick state so a later reconnect
 *     doesn't replay stale transitions.
 */
import type {
  IEventBus,
  PitReadbackSnapshot,
  SessionStartConditions,
  SimEventMap,
  SimEventName,
} from "@iracedeck/event-bus";
import { TrackWetness } from "@iracedeck/event-bus";
import type { SDKController, TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { diffDamage } from "./diff/damage.js";
import { diffFlags } from "./diff/flags.js";
import { diffFuel } from "./diff/fuel.js";
import { diffIncidents } from "./diff/incidents.js";
import { diffLifecycle } from "./diff/lifecycle.js";
import { diffLimiter } from "./diff/limiter.js";
import { diffOvertakes } from "./diff/overtakes.js";
import { diffPitLane } from "./diff/pit-lane.js";
import { buildSnapshot as buildReadbackSnapshot, diffPitReadback } from "./diff/pit-readback.js";
import { diffPitStatus } from "./diff/pit-status.js";
import { diffRadar } from "./diff/radar.js";
import { diffToggles } from "./diff/toggles.js";
import { diffTrackWetness } from "./diff/track-wetness.js";
import type { PendingEvent } from "./diff/types.js";
import { createInitialState, type TranslatorState } from "./state.js";

const SUBSCRIPTION_ID = "__sim-events-iracing__";

type TranslatorInstance = {
  bus: IEventBus;
  controller: SDKController;
  logger: ILogger;
  state: TranslatorState;
  latestTelemetry: TelemetryData | null;
  /** Cached pit speed limit (m/s) parsed from session YAML. 0 = not parsed. */
  pitSpeedLimitMps: number;
  pitSpeedLimitKey: string;
  /** Tracks the `IsReplayPlaying` edge so we can reset state on transition. */
  lastTickInReplay: boolean;
  /**
   * `driver.firstOnTrack` tracking. Connection-lifetime milestone — kept on
   * the instance, not `TranslatorState`, so it survives the per-tick state
   * resets the replay guard performs (seed-and-bail would otherwise re-run
   * on every replay exit and swallow the genuine first-on-track moment).
   * Both reset only on `handleDisconnect`. See `diffFirstOnTrack`.
   */
  firstOnTrackSeeded: boolean;
  firstOnTrackFired: boolean;
};

let instance: TranslatorInstance | null = null;

/**
 * Initialize the iRacing translator singleton. Subscribes to sdkController
 * and starts publishing events to the shared event bus. Throws on double
 * initialization — call once per plugin process.
 */
export function initializeSimEventsIracing(
  eventBus: IEventBus,
  sdkController: SDKController,
  logger: ILogger = silentLogger,
): void {
  if (instance) {
    throw new Error("sim-events-iracing already initialized. initializeSimEventsIracing() should only be called once.");
  }

  const self: TranslatorInstance = {
    bus: eventBus,
    controller: sdkController,
    logger,
    state: createInitialState(),
    latestTelemetry: null,
    pitSpeedLimitMps: 0,
    pitSpeedLimitKey: "",
    lastTickInReplay: false,
    firstOnTrackSeeded: false,
    firstOnTrackFired: false,
  };

  instance = self;

  sdkController.subscribe(SUBSCRIPTION_ID, (telemetry, isConnected) => {
    if (!isConnected) {
      handleDisconnect(self);

      return;
    }

    if (!telemetry) return;

    self.latestTelemetry = telemetry;
    handleTick(self, telemetry);
  });

  logger.info("sim-events-iracing translator initialized");
}

/** Returns the latest telemetry snapshot, or null if never received / disconnected. */
export function getLatestTelemetry(): TelemetryData | null {
  return instance?.latestTelemetry ?? null;
}

/**
 * Returns the current iRacing session type ("Race", "Practice", "Open Qualify",
 * "Lone Qualify", …) or empty string if session info is unavailable. Resolved
 * from the SDK's session YAML; action consumers use this to gate session-
 * specific behavior without taking a direct dependency on `@iracedeck/iracing-sdk`.
 */
export function getSessionType(): string {
  if (!instance || !instance.latestTelemetry) return "";

  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;

  return resolveSessionType(sessionInfo, instance.latestTelemetry);
}

export function isSimEventsIracingInitialized(): boolean {
  return instance !== null;
}

/**
 * Whether per-toggle pit-action confirmation scenarios are currently
 * allowed to fire (issue #476). Returns `false` while the cooldown set
 * by `pitLane.exited` (4500 ms) or by entering the pre-start grid window
 * (5000 ms) is still in effect — pit-actions stay silent during those
 * windows so iRacing's phantom flag-cascade emissions and the pending
 * readbacks don't double up. Plugin entry-points pass this as the
 * `getPitActionsAllowed` closure to `registerPitCrew`.
 */
export function isPitActionsAllowed(): boolean {
  if (!instance) return true;

  return Date.now() >= instance.state.pitActionCooldownUntil;
}

/**
 * Build a pit-readback snapshot from the latest telemetry tick (issue
 * #481). Returns `null` if no telemetry has arrived yet — callers (the
 * audio scenarios, via the resolver passed into `registerPitCrew`)
 * treat null as "no queued services known", which collapses to the
 * empty-fallback recap rather than speaking a stale or fabricated plan.
 *
 * Read at fire time so a deferred readback (busy-bus low-priority hold
 * or higher-priority preempt that stashed the readback for replay)
 * speaks the user's *current* queue, not the queue from the moment the
 * `pitService.readbackRequested` event was emitted.
 */
export function getReadbackSnapshot(): PitReadbackSnapshot | null {
  if (!instance || !instance.latestTelemetry) return null;

  return buildReadbackSnapshot(instance.latestTelemetry);
}

/**
 * Build the session-start ("car entry") conditions snapshot from the latest
 * telemetry tick + session info (issue #542). Returns `null` when telemetry
 * or session info is unavailable, or when track wetness is still `Unknown` —
 * the session-start scenario treats null as "skip the callout" rather than
 * speaking a nonsense line.
 *
 * Units are resolved here from iRacing's `DisplayUnits` so the engineer
 * matches the sim: pit speed and temperatures are converted into the user's
 * display unit and rounded to integers. Pit speed is rounded exactly (never
 * stepped) — the scenario decides whether it can speak the value.
 *
 * Read at fire time (same deferred-snapshot rationale as
 * {@link getReadbackSnapshot}).
 */
export function getSessionStartConditions(): SessionStartConditions | null {
  if (!instance || !instance.latestTelemetry) return null;

  const telemetry = instance.latestTelemetry;
  const sessionInfo = instance.controller.getSessionInfo() as Record<string, unknown> | null;

  if (!sessionInfo) return null;

  const wetness = telemetry.TrackWetness;

  if (typeof wetness !== "number" || wetness < TrackWetness.Dry || wetness > TrackWetness.ExtremelyWet) {
    return null;
  }

  // iRacing `DisplayUnits`: 0 = English (imperial), 1 = Metric. Undefined
  // (telemetry field absent) defaults to metric.
  const metric = telemetry.DisplayUnits !== 0;
  const pitSpeedLimitMps = resolvePitSpeedLimit(instance, sessionInfo, telemetry);
  const trackTempC = telemetry.TrackTempCrew ?? 0;
  const airTempC = telemetry.AirTemp ?? 0;
  const toDisplayTemp = (celsius: number): number => Math.round(metric ? celsius : celsius * 1.8 + 32);

  return {
    sessionType: classifySessionType(resolveSessionType(sessionInfo, telemetry)),
    pitSpeedLimit: Math.round(pitSpeedLimitMps * (metric ? 3.6 : 2.236936)),
    speedUnit: metric ? "kmh" : "mph",
    trackTemp: toDisplayTemp(trackTempC),
    airTemp: toDisplayTemp(airTempC),
    tempUnit: metric ? "celsius" : "fahrenheit",
    wetness: wetness as TrackWetness,
  };
}

/**
 * Reset the translator singleton.
 * @internal Exported for test isolation only.
 */
export function _resetSimEventsIracing(): void {
  if (instance) {
    try {
      instance.controller.unsubscribe(SUBSCRIPTION_ID);
    } catch {
      // Ignore — controller may be in a weird state in tests.
    }
  }

  instance = null;
}

// ── Internals ──────────────────────────────────────────────────────────────

function handleDisconnect(self: TranslatorInstance): void {
  // Publish a teardown signal for any active state that would otherwise
  // leave downstream consumers stuck in an active mode. Today that's just
  // radar (its tick loop keeps running until it sees a `radar.changed → clear`
  // transition); other active-state subsystems should plug in here the
  // same way. We publish via the live envelope shape so consumers don't
  // need a separate disconnect code path.
  if (self.state.radarState !== "clear" && self.latestTelemetry !== null) {
    publish(
      self,
      { event: "radar.changed", data: { from: self.state.radarState, to: "clear" } },
      self.latestTelemetry,
      Date.now(),
    );
  }

  // Fresh state so reconnect seeds cleanly.
  self.state = createInitialState();
  self.latestTelemetry = null;
  self.pitSpeedLimitMps = 0;
  self.pitSpeedLimitKey = "";
  // `driver.firstOnTrack` is a connection-lifetime milestone — cleared only
  // here so a genuine reconnect re-seeds (and a mid-drive reconnect stays
  // silent), while replay scrubbing within one connection does not.
  self.firstOnTrackSeeded = false;
  self.firstOnTrackFired = false;
}

/**
 * `driver.firstOnTrack` detection — issue #542.
 *
 * Runs on EVERY tick, including replay-mode ticks, BEFORE the replay guard
 * in `handleTick`. "Live on track" is `IsOnTrack && !IsReplayPlaying` — true
 * only when the driver is genuinely in the car, not watching a replay or
 * sitting in the session menu (where iRacing reports `IsReplayPlaying: true`
 * and `IsOnTrack: false`).
 *
 * The first tick after connect seeds `firstOnTrackFired` to the current
 * live-on-track value: a plugin that connects mid-drive seeds `true` and
 * stays silent (not the driver's first on-track moment), while a connect in
 * the garage / replay seeds `false` and fires on the genuine transition.
 * Tracking lives on the instance (not `TranslatorState`) so the replay
 * guard's per-tick resets can't re-run the seed and swallow the event.
 */
function diffFirstOnTrack(self: TranslatorInstance, telemetry: TelemetryData): void {
  const liveOnTrack = (telemetry.IsOnTrack ?? false) && telemetry.IsReplayPlaying !== true;

  if (!self.firstOnTrackSeeded) {
    self.firstOnTrackSeeded = true;
    self.firstOnTrackFired = liveOnTrack;

    return;
  }

  if (!self.firstOnTrackFired && liveOnTrack) {
    self.firstOnTrackFired = true;
    publish(self, { event: "driver.firstOnTrack", data: {} }, telemetry, Date.now());
  }
}

function handleTick(self: TranslatorInstance, telemetry: TelemetryData): void {
  // `driver.firstOnTrack` is detected on every tick — including replay ticks
  // — so the genuine garage/replay → live-on-track transition is never
  // missed. Must run before the replay guard's early return below.
  diffFirstOnTrack(self, telemetry);

  // Suppress every semantic event while iRacing is in replay mode. The
  // engineer voice should be quiet whenever the user isn't actively in
  // the car — replay scrubbing fires phantom flag transitions and pit
  // toggles as the timeline jumps, which would queue audio that has no
  // relationship to the live session. Mirrors the existing
  // disconnect-resets-state pattern so when replay ends the diff
  // modules' first-tick / off-track seed branches reseed cleanly.
  if (telemetry.IsReplayPlaying === true) {
    if (!self.lastTickInReplay) {
      // Publish the radar teardown signal before resetting state so the
      // radar engine receives a clear edge — otherwise it stays latched
      // through replay (the tick loop runs until it sees a `clear`).
      // Mirrors `handleDisconnect()`.
      if (self.state.radarState !== "clear") {
        publish(
          self,
          { event: "radar.changed", data: { from: self.state.radarState, to: "clear" } },
          telemetry,
          Date.now(),
        );
      }

      self.state = createInitialState();
      self.lastTickInReplay = true;
    }

    return;
  }

  if (self.lastTickInReplay) {
    self.state = createInitialState();
    self.lastTickInReplay = false;
  }

  const now = Date.now();
  const pending: PendingEvent[] = [];
  const emit = (ev: PendingEvent): void => {
    pending.push(ev);
  };

  const sessionInfo = self.controller.getSessionInfo() as Record<string, unknown> | null;
  const sessionType = resolveSessionType(sessionInfo, telemetry);
  const isRaceSession = sessionType === "Race";
  const playerCarIdx = resolvePlayerCarIdx(sessionInfo);
  const pitSpeedLimitMps = resolvePitSpeedLimit(self, sessionInfo, telemetry);

  // Diff modules — `diffLimiter` reads `state.lastInPitStall` to detect the
  // just-left-stall transition, so it must run BEFORE `diffPitLane` writes
  // the new stall flag. All other modules are independent.
  diffLifecycle(self.state, telemetry, emit);
  diffLimiter(self.state, telemetry, pitSpeedLimitMps, now, emit);
  diffPitLane(self.state, telemetry, emit);
  diffFlags(self.state, telemetry, emit);
  diffToggles(self.state, telemetry, now, emit);
  // diffPitStatus emits `pitService.statusChanged` for in-progress / complete
  // / positioning / can't-fix-that transitions (issue #479). Independent of
  // diffToggles' bit-flag world; placed adjacent for cohesion of the
  // pit-service event group.
  diffPitStatus(self.state, telemetry, emit);
  // diffPitReadback runs after diffToggles so it sees the per-tick toggle
  // emissions (`pitService.toggled` / `tireService.changed` /
  // `tireService.compoundChanged`) in `pending` — those signal user intent
  // and trigger an `entry-refire` readback.
  diffPitReadback(self.state, telemetry, now, emit, pending);
  diffIncidents(self.state, telemetry, now, emit);
  diffDamage(self.state, telemetry, now, emit);
  diffOvertakes(self.state, telemetry, playerCarIdx, isRaceSession, now, emit);
  diffFuel(self.state, telemetry, isRaceSession, emit);
  diffRadar(self.state, telemetry, emit);
  diffTrackWetness(self.state, telemetry, emit);

  for (const p of pending) {
    publish(self, p, telemetry, now);
  }
}

function publish(self: TranslatorInstance, pending: PendingEvent, telemetry: TelemetryData, timestamp: number): void {
  const envelope = {
    event: pending.event,
    timestamp,
    telemetry,
    data: pending.data,
  } as SimEventMap[SimEventName];
  self.bus.publish(envelope);
}

function resolveSessionType(sessionInfo: Record<string, unknown> | null, telemetry: TelemetryData): string {
  if (!sessionInfo) return "";

  const sessions = (sessionInfo.SessionInfo as Record<string, unknown> | undefined)?.Sessions as
    | Array<Record<string, unknown>>
    | undefined;
  const sessionNum = telemetry.SessionNum ?? 0;
  const current = sessions?.[sessionNum as number];

  return (current?.SessionType as string) ?? "";
}

/**
 * Collapse iRacing's raw `SessionType` string ("Practice", "Lone Practice",
 * "Offline Testing", "Open Qualify", "Lone Qualify", "Race", "Warmup", …)
 * into the three buckets the session-start callout records a line for.
 * "Offline Testing" maps to "practice" — a test session is practice-like and
 * "it's time to race" would be wrong there. Anything that isn't practice,
 * testing, or qualifying (warmup, heat, race) reads as "race".
 */
function classifySessionType(raw: string): "practice" | "qualifying" | "race" {
  if (raw.includes("Practice") || raw.includes("Testing")) return "practice";

  if (raw.includes("Qualify")) return "qualifying";

  return "race";
}

function resolvePlayerCarIdx(sessionInfo: Record<string, unknown> | null): number {
  if (!sessionInfo) return -1;

  const driverInfo = sessionInfo.DriverInfo as Record<string, unknown> | undefined;

  return (driverInfo?.DriverCarIdx as number) ?? -1;
}

function resolvePitSpeedLimit(
  self: TranslatorInstance,
  sessionInfo: Record<string, unknown> | null,
  telemetry: TelemetryData,
): number {
  if (!sessionInfo) return self.pitSpeedLimitMps;

  const weekend = sessionInfo.WeekendInfo as Record<string, unknown> | undefined;
  const trackId = `${String(weekend?.TrackID ?? "")}|${String(telemetry.SessionNum ?? "")}`;

  // Track or session changed — invalidate the cache. We re-parse below; if
  // the new session YAML is missing or malformed, the cached limit resets
  // to 0 so `diffLimiter` won't fire `limiter.speeding` against a stale
  // threshold from the previous track.
  if (trackId !== self.pitSpeedLimitKey) {
    self.pitSpeedLimitKey = trackId;
    self.pitSpeedLimitMps = 0;
  } else if (self.pitSpeedLimitMps > 0) {
    return self.pitSpeedLimitMps;
  }

  const raw = weekend?.TrackPitSpeedLimit;

  if (typeof raw === "string") {
    const match = /([\d.]+)\s*(kph|mph|kmh|km\/h)/i.exec(raw);

    if (match) {
      const value = parseFloat(match[1]!);
      const unit = match[2]!.toLowerCase();
      self.pitSpeedLimitMps = unit === "mph" ? value * 0.44704 : value / 3.6;
    }
  }

  return self.pitSpeedLimitMps;
}
