/**
 * In-memory iRacing SDK controller for the scenario harness.
 *
 * Implements the structural surface of `@iracedeck/iracing-sdk`'s
 * `SDKController` that `initializeSimEventsIracing` actually uses
 * (`subscribe`, `unsubscribe`, `getSessionInfo`). The translator runs
 * unmodified; the harness drives it by mutating the in-memory telemetry
 * snapshot and either ticking the loop on a timer or one-shot from the UI.
 *
 * The `private` fields on the real `SDKController` make TypeScript's
 * structural compatibility check fail, so callers cast through `unknown`
 * to `SDKController` when handing the mock to the translator — the same
 * pattern the existing translator tests use.
 */
import type { SessionInfo, TelemetryCallback, TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { silentLogger } from "@iracedeck/logger";

export type MockState = {
  telemetry: TelemetryData;
  sessionInfo: SessionInfo | null;
  isConnected: boolean;
  tickIntervalMs: number;
  running: boolean;
};

export type MockSDKControllerOptions = {
  logger?: ILogger;
  /**
   * Initial telemetry snapshot. Defaults to "in garage / engine off / no
   * flags / off-track" so the harness boots without firing spurious events.
   */
  initialTelemetry?: TelemetryData;
  /** Tick interval in ms when running. Default 250 (matches the real loop). */
  tickIntervalMs?: number;
};

const DEFAULT_TICK_INTERVAL_MS = 250;

/**
 * Minimum-viable telemetry snapshot. Field set covers everything the
 * translator's diff modules read; values represent "in garage, engine off,
 * no flags, no incidents". The full `TelemetryData` shape has many more
 * optional fields — left undefined and cast at the boundary, same as the
 * existing translator tests.
 */
function defaultTelemetry(): TelemetryData {
  return {
    OnPitRoad: false,
    PlayerCarInPitStall: false,
    IsOnTrack: false,
    PlayerTrackSurface: 0,
    PlayerTrackSurfaceMaterial: 0,
    PlayerCarMyIncidentCount: 0,
    SessionFlags: 0,
    SessionNum: 0,
    PitSvFlags: 0,
    PitSvTireCompound: 0,
    PlayerTireCompound: 0,
    EngineWarnings: 0,
    Speed: 0,
    CarLeftRight: 0,
    DRS_Status: 0,
    P2P_Status: false,
    RPM: 0,
    Lap: 0,
    LapDistPct: 0,
    FuelLevel: 10,
  } as unknown as TelemetryData;
}

export class MockSDKController {
  private telemetry: TelemetryData;
  private sessionInfo: SessionInfo | null = null;
  private isConnected = false;
  private tickIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private subscribers = new Map<string, TelemetryCallback>();
  private readonly logger: ILogger;
  private stateListeners = new Set<(state: MockState) => void>();

  constructor(options: MockSDKControllerOptions = {}) {
    this.telemetry = options.initialTelemetry ?? defaultTelemetry();
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.logger = options.logger ?? silentLogger;
  }

  // ── SDKController surface (structural — translator only uses these) ────────

  subscribe(id: string, callback: TelemetryCallback): void {
    this.subscribers.set(id, callback);
    // Mirror the real controller: deliver current state immediately so the
    // translator's diff state seeds correctly.
    callback(this.isConnected ? this.telemetry : null, this.isConnected);
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
  }

  getSessionInfo(): SessionInfo | null {
    return this.sessionInfo;
  }

  // ── Harness-only API ───────────────────────────────────────────────────────

  /** Toggle the simulated connection. Disconnect notifies subscribers with `(null, false)`. */
  setConnected(connected: boolean): void {
    if (this.isConnected === connected) return;

    this.isConnected = connected;
    this.logger.info(connected ? "Mock SDK connected" : "Mock SDK disconnected");

    // Notify subscribers so the translator sees the state change immediately,
    // not on the next tick — matches `tryConnect` in the real controller.
    for (const cb of this.subscribers.values()) {
      cb(connected ? this.telemetry : null, connected);
    }

    this.broadcastState();
  }

  /** Replace the telemetry snapshot wholesale. */
  setTelemetry(snapshot: TelemetryData): void {
    this.telemetry = snapshot;
    this.broadcastState();
  }

  /** Patch a partial telemetry snapshot into the current one. */
  mutateTelemetry(patch: Partial<TelemetryData>): void {
    this.telemetry = { ...this.telemetry, ...patch } as TelemetryData;
    this.broadcastState();
  }

  setSessionInfo(info: SessionInfo | null): void {
    this.sessionInfo = info;
    this.broadcastState();
  }

  /** Fire one synchronous tick to all subscribers using the current state. */
  tickOnce(): void {
    for (const cb of this.subscribers.values()) {
      cb(this.isConnected ? this.telemetry : null, this.isConnected);
    }
  }

  /** Start the auto-tick loop. No-op if already running. */
  start(intervalMs?: number): void {
    if (intervalMs !== undefined) this.tickIntervalMs = intervalMs;

    if (this.timer !== null) return;

    this.timer = setInterval(() => this.tickOnce(), this.tickIntervalMs);
    this.broadcastState();
  }

  stop(): void {
    if (this.timer === null) return;

    clearInterval(this.timer);
    this.timer = null;
    this.broadcastState();
  }

  setTickInterval(ms: number): void {
    if (ms === this.tickIntervalMs) return;

    this.tickIntervalMs = ms;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tickOnce(), this.tickIntervalMs);
    }

    this.broadcastState();
  }

  /** Subscribe to mock-state snapshots (for the WS bridge). Returns unsubscribe. */
  onStateChange(listener: (state: MockState) => void): () => void {
    this.stateListeners.add(listener);

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): MockState {
    return {
      telemetry: this.telemetry,
      sessionInfo: this.sessionInfo,
      isConnected: this.isConnected,
      tickIntervalMs: this.tickIntervalMs,
      running: this.timer !== null,
    };
  }

  private broadcastState(): void {
    const snapshot = this.getState();

    for (const listener of this.stateListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.logger.warn(`Mock state listener threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
