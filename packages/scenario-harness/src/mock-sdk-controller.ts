/**
 * In-memory iRacing SDK controller for the scenario harness.
 *
 * Implements the structural surface of `@iracedeck/iracing-sdk`'s
 * `SDKController` that `initializeSimEventsIracing` actually uses
 * (`subscribe`, `unsubscribe`, `getSessionInfo`, `getReplayState`). The
 * translator runs unmodified; the harness drives it by mutating the in-memory
 * telemetry snapshot and either ticking the loop on a timer or one-shot from
 * the UI.
 *
 * The replay state the translator's guard reads (#1324) is the REAL rule, the
 * SDK's own `ReplayStateTracker`, stepped from the mock's snapshot and session
 * info on every tick delivered to a subscriber — the mock's tick is its poll,
 * and the real controller steps on every poll — and on the subscribe-time
 * delivery, which stands in for the connect-time step the real controller's
 * first subscriber triggers. So a `telemetrySequence` that closes a
 * replay-mode bracket (`IsReplayPlaying: false`) is still a replay to the
 * translator for `REPLAY_EXIT_GRACE_MS`, as it is in the sim, and a shortcut
 * holds that long before the step it expects live behaviour from.
 *
 * Delivery goes through the same error boundary as the real controller's
 * (#1558), `createErrorBoundary` from `@iracedeck/logger`: every subscriber
 * call, the subscribe-time one included, runs inside it, a throw goes to its
 * bounded reporter under the subscriber's id, and the next subscriber is
 * still called. `onSubscriberError` takes the same policy, `"report"` by
 * default. So a harness session behaves as the plugin does when a subscriber
 * has a bug: the throw is logged once, and the other subscribers carry on.
 *
 * The `private` fields on the real `SDKController` make TypeScript's
 * structural compatibility check fail, so callers cast through `unknown`
 * to `SDKController` when handing the mock to the translator — the same
 * pattern the existing translator tests use.
 */
import {
  type ReplayState,
  ReplayStateTracker,
  type SessionInfo,
  type TelemetryCallback,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { ErrorBoundary, ErrorPolicy, ILogger } from "@iracedeck/logger";
import { createErrorBoundary, silentLogger, throwHeld } from "@iracedeck/logger";

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
  /**
   * Tick interval in ms when running. Defaults to 14 ms to match the real
   * SDKController's poll rate (issue #493 — slightly faster than iRacing's
   * 60 Hz write rate).
   */
  tickIntervalMs?: number;
  /**
   * What a subscriber's throw does, as on the real `SDKController` (#1558).
   * Under `"report"`, the default, it goes to the bounded reporter under the
   * subscriber's id and delivery carries on, so nothing escapes `tickOnce`,
   * `subscribe` or `setConnected`. That is what the harness itself runs
   * (`main.ts`). Under `"rethrow"`, every subscriber is still called, then the
   * first error is thrown. A test that drives a real subscriber through the
   * mock (the translator, the Race Engineer) passes `"rethrow"`: under
   * `"report"` and the default `silentLogger`, a subscriber that threw on
   * every tick would leave a test asserting that nothing happened green.
   */
  onSubscriberError?: ErrorPolicy;
  /** The reporter's clock, in milliseconds. Defaults to `Date.now()`. */
  now?: () => number;
};

const DEFAULT_TICK_INTERVAL_MS = 14;

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
    // Capability field: iRacing only exposes it on cars that HAVE a limiter,
    // so its PRESENCE is what `hasPitLimiter` reads, not its value — whether
    // the limiter is engaged is the `EngineWarnings.PitSpeedLimiter` bit
    // (issue #1548). Present by default because most of the roster has one;
    // delete it (send null, see `mutateTelemetry`) to audition the no-limiter
    // callouts.
    dcPitSpeedLimiterToggle: false,
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

/**
 * A patch value that sets and clears bits of a bitfield rather than replacing
 * it (issue #1548): `setBits` are turned on and `clearBits` off, and every
 * other bit keeps the value the snapshot had (a field that was absent counts
 * as 0). It is how a shortcut patches one bit of `EngineWarnings` — the pit
 * limiter's — over whatever the panel's warning checkboxes or an earlier
 * button left there, which a whole-number patch would wipe.
 */
export type BitsPatch = { setBits?: number; clearBits?: number };

/**
 * A telemetry patch, where `null` DELETES the key rather than setting it
 * (issue #1051). `Partial<TelemetryData>` cannot express that — its values are
 * `T | undefined` — so the sentinel could not be written without a cast, and
 * every call site already casts, which is exactly what hid the mismatch: the
 * type disagreed with the method body and nothing failed to compile. A numeric
 * field also takes a {@link BitsPatch} (issue #1548).
 */
export type TelemetryPatch = {
  [K in keyof TelemetryData]?: TelemetryData[K] | null | BitsPatchFor<TelemetryData[K]>;
};

/**
 * {@link BitsPatch} where a field's value can be a number, never otherwise.
 * Distributive, so the `TelemetryData` index signature — whose value is a
 * union that includes `number` — takes one too, and a boolean field does not.
 */
type BitsPatchFor<V> = V extends number ? BitsPatch : never;

/** A plain object: not null and not an array (the `CarIdx*` fields are arrays, patched whole). */
function isPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a patch value is a {@link BitsPatch}: a plain object whose keys are
 * `setBits` and/or `clearBits`, at least one, each an integer from 0 to
 * 0xFFFFFFFF (telemetry bitfields are 32 bits, and JS bitwise operators would
 * silently truncate a wider value). `mutateTelemetry` refuses any other plain
 * object, since no telemetry field holds one.
 */
export function isBitsPatch(value: unknown): value is BitsPatch {
  if (!isPlainObject(value)) return false;

  const entries = Object.entries(value);

  return (
    entries.length > 0 &&
    entries.every(
      ([key, bits]) =>
        (key === "setBits" || key === "clearBits") &&
        Number.isInteger(bits) &&
        (bits as number) >= 0 &&
        (bits as number) <= 0xffffffff,
    )
  );
}

/**
 * `current` with `patch`'s bits cleared and set; an absent `current` counts as
 * 0. The result is unsigned (`>>> 0`), so touching a field whose bit 31 is set
 * (`SessionFlags`' `StartGo`) does not turn it negative.
 */
function applyBits(current: number | undefined, patch: BitsPatch): number {
  return (((current ?? 0) & ~(patch.clearBits ?? 0)) | (patch.setBits ?? 0)) >>> 0;
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
  private readonly replayState = new ReplayStateTracker();
  private readonly boundary: ErrorBoundary;

  constructor(options: MockSDKControllerOptions = {}) {
    this.telemetry = options.initialTelemetry ?? defaultTelemetry();
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.logger = options.logger ?? silentLogger;
    // As on the real controller: a subscriber that unsubscribes itself and
    // then throws leaves no error keys behind.
    this.boundary = createErrorBoundary({
      logger: this.logger,
      now: options.now,
      policy: options.onSubscriberError,
      isRegistered: (id) => this.subscribers.has(id),
    });
  }

  // ── SDKController surface (structural — translator only uses these) ────────

  /**
   * As on the real controller, subscribing an id that is already subscribed
   * replaces its callback and forgets the old callback's error counts.
   */
  subscribe(id: string, callback: TelemetryCallback): void {
    if (this.subscribers.has(id)) this.boundary.forget(id);

    this.subscribers.set(id, callback);
    // Mirror the real controller: deliver current state immediately so the
    // translator's diff state seeds correctly.
    this.stepReplayState();
    throwHeld(this.boundary.call(id, () => this.deliver(callback)));
  }

  /** As on the real controller, flushes the id's unreported error counts and drops them. */
  unsubscribe(id: string): void {
    this.subscribers.delete(id);
    this.boundary.forget(id);
  }

  getSessionInfo(): SessionInfo | null {
    return this.sessionInfo;
  }

  /**
   * The debounced replay state as of `nowMs` (#1324), as the real controller
   * answers it: stepped on every delivered tick, re-evaluated at read time so
   * the exit grace expires between ticks too.
   */
  getReplayState(nowMs: number = Date.now()): ReplayState {
    return this.replayState.read(nowMs);
  }

  /** The real controller's `goToEnd` hook (#1230, #1324); nothing in the harness sends one today. */
  noteReplayLeftForLive(nowMs: number = Date.now()): void {
    this.replayState.noteLeftForLive(nowMs);
  }

  /** The real controller's seek hold (#1429), by the same tracker rule; nothing in the harness pushes one today. */
  noteReplaySeekHold(remainingMs: number | null, nowMs: number = Date.now()): void {
    this.replayState.holdForSeek(remainingMs, nowMs);
  }

  // ── Harness-only API ───────────────────────────────────────────────────────

  /** Toggle the simulated connection. Disconnect notifies subscribers with `(null, false)`. */
  setConnected(connected: boolean): void {
    if (this.isConnected === connected) return;

    this.isConnected = connected;
    this.logger.info(connected ? "Mock SDK connected" : "Mock SDK disconnected");

    // Notify subscribers so the translator sees the state change immediately,
    // not on the next tick — matches `tryConnect` in the real controller.
    this.deliverToAll();

    this.broadcastState();
  }

  /** Replace the telemetry snapshot wholesale. */
  setTelemetry(snapshot: TelemetryData): void {
    this.telemetry = snapshot;
    this.broadcastState();
  }

  /**
   * Patch a partial telemetry snapshot into the current one.
   *
   * An explicit `null` DELETES the key rather than setting it. JSON has no
   * `undefined`, so without this a patch could never make a field absent — and
   * absence is exactly what iRacing's capability fields mean: `hasPitLimiter`,
   * `hasVisor` and `hasWipers` all read whether a `dc*` field EXISTS, not what
   * it holds. No `TelemetryData` field takes null as a legitimate value, so the
   * sentinel is unambiguous.
   *
   * A {@link BitsPatch} value sets and clears bits of the field's current
   * value rather than replacing it (issue #1548). No `TelemetryData` field
   * holds a plain object, so that shape is unambiguous too — and any other
   * plain object is a malformed bits patch, refused with an error naming its
   * key before anything is written, rather than stored where a number
   * belongs.
   *
   * @throws Error when a value is a plain object that is not a valid {@link BitsPatch},
   *   or a bits patch aimed at a field that holds something other than a number
   */
  mutateTelemetry(patch: TelemetryPatch): void {
    const current = this.telemetry as unknown as Record<string, unknown>;

    for (const [key, value] of Object.entries(patch)) {
      if (isPlainObject(value) && !isBitsPatch(value)) {
        throw new Error(
          `telemetry patch key "${key}": an object value must be a bits patch — { setBits?, clearBits? }, at least one, each an integer from 0 to 0xFFFFFFFF — got ${JSON.stringify(value)}`,
        );
      }

      // A bits patch belongs on a numeric field: on a boolean or an array it
      // would store a number where the readers expect something else.
      if (isBitsPatch(value) && current[key] !== undefined && typeof current[key] !== "number") {
        throw new Error(
          `telemetry patch key "${key}": a bits patch needs a numeric field, but it holds ${JSON.stringify(current[key])}`,
        );
      }
    }

    const next = { ...current, ...patch } as Record<string, unknown>;

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else if (isBitsPatch(value)) next[key] = applyBits(current[key] as number | undefined, value);
    }

    this.telemetry = next as TelemetryData;
    this.broadcastState();
  }

  setSessionInfo(info: SessionInfo | null): void {
    this.sessionInfo = info;
    this.broadcastState();
  }

  /** Fire one synchronous tick to all subscribers using the current state. */
  tickOnce(): void {
    this.deliverToAll();
  }

  /**
   * One tick to every subscriber: the replay state steps first, as the real
   * controller steps it on the poll before any callback runs, and a
   * disconnected tick resets it, as the real controller resets it wherever
   * the connection drops. Each call runs inside the error boundary.
   */
  private deliverToAll(): void {
    this.stepReplayState();
    throwHeld(this.boundary.callEach(this.subscribers, (callback) => this.deliver(callback)));
  }

  /** One subscriber's view of the current state. Callers run it inside the error boundary. */
  private deliver(callback: TelemetryCallback): void {
    callback(this.isConnected ? this.telemetry : null, this.isConnected);
  }

  private stepReplayState(): void {
    if (this.isConnected) {
      this.replayState.step(this.telemetry, this.sessionInfo, Date.now());
    } else {
      this.replayState.reset();
    }
  }

  /**
   * Start the auto-tick loop. If already running and a new `intervalMs` is
   * provided, reroutes through `setTickInterval` so the timer's cadence
   * actually changes — without this, calling `start(500)` while already
   * ticking at 250 ms would update the recorded interval but keep the
   * timer firing at the old rate.
   */
  start(intervalMs?: number): void {
    if (this.timer !== null) {
      if (intervalMs !== undefined) this.setTickInterval(intervalMs);

      return;
    }

    if (intervalMs !== undefined) this.tickIntervalMs = intervalMs;

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
