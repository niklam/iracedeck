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
import type { IEventBus, SimEventMap, SimEventName } from "@iracedeck/event-bus";
import type { SDKController, TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { diffFlags } from "./diff/flags.js";
import { diffFuel } from "./diff/fuel.js";
import { diffIncidents } from "./diff/incidents.js";
import { diffLifecycle } from "./diff/lifecycle.js";
import { diffLimiter } from "./diff/limiter.js";
import { diffOvertakes } from "./diff/overtakes.js";
import { diffPitLane } from "./diff/pit-lane.js";
import { diffPitReadback } from "./diff/pit-readback.js";
import { diffRadar } from "./diff/radar.js";
import { diffToggles } from "./diff/toggles.js";
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
}

function handleTick(self: TranslatorInstance, telemetry: TelemetryData): void {
  // Suppress every semantic event while iRacing is in replay mode. The
  // engineer voice should be quiet whenever the user isn't actively in
  // the car — replay scrubbing fires phantom flag transitions and pit
  // toggles as the timeline jumps, which would queue audio that has no
  // relationship to the live session. Mirrors the existing
  // disconnect-resets-state pattern so when replay ends the diff
  // modules' first-tick / off-track seed branches reseed cleanly.
  if (telemetry.IsReplayPlaying === true) {
    if (!self.lastTickInReplay) {
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
  // diffPitReadback runs after diffToggles so it sees the per-tick toggle
  // emissions (`pitService.toggled` / `tireService.changed` /
  // `tireService.compoundChanged`) in `pending` — those signal user intent
  // and trigger an `entry-refire` readback.
  diffPitReadback(self.state, telemetry, now, emit, pending);
  diffIncidents(self.state, telemetry, now, emit);
  diffOvertakes(self.state, telemetry, playerCarIdx, isRaceSession, now, emit);
  diffFuel(self.state, telemetry, isRaceSession, emit);
  diffRadar(self.state, telemetry, emit);

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
