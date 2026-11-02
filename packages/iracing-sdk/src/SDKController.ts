/**
 * SDK Controller - Manages the iRacing SDK connection
 * and notifies subscribers of telemetry updates
 */
import {
  createErrorBoundary,
  type ErrorBoundary,
  type ErrorPolicy,
  type HeldError,
  ILogger,
  silentLogger,
  throwHeld,
} from "@iracedeck/logger";

import { IRacingSDK } from "./IRacingSDK.js";
import { ReplayStateTracker } from "./replay-state-tracker.js";
import type { ReplayState } from "./telemetry-features.js";
import { buildTemplateContextFromData, type TemplateContext } from "./template-context.js";
import { SessionInfo, TelemetryData } from "./types.js";

export type TelemetryCallback = (telemetry: TelemetryData | null, isConnected: boolean) => void;

/**
 * Telemetry poll interval in milliseconds. iRacing writes shared memory at
 * ~60 Hz (16.67 ms); we poll at 100 Hz (10 ms) and dedupe by `SessionTick`
 * so subscribers see exactly one notification per real iRacing frame —
 * never a duplicate, never a drop.
 *
 * The original ~70 Hz target (14 ms) was theoretically enough to catch
 * every iRacing frame, but `setInterval` drift on Windows under load left
 * gaps where our poll could land before iRacing's next write — surfaced
 * by the frame-miss telemetry as steady "Missed 1 iRacing frame" entries.
 * 10 ms gives ~6 ms of headroom per iRacing frame, well above the typical
 * scheduler jitter, and the extra poll work is cheap because the dedupe
 * short-circuits before any subscriber callback or template-context
 * rebuild fires.
 *
 * Sub-100 ms features (sector timing, precise pit/lap edges, transient
 * `PlayerIncidents` flag detection) all depend on this cadence — see
 * issue #493.
 */
export const TELEMETRY_INTERVAL_MS = 10;

/**
 * The reporter ids of the controller's own work (#1558). The `controller:`
 * prefix keeps them apart from every subscriber id. Every connect attempt
 * (the first one in `start()`, the reconnect poll, re-enabling) runs as
 * `controller:reconnect`, the poll as `controller:update`, and the disconnect
 * when iRacing terminates as `controller:disconnect`.
 */
const UPDATE_ID = "controller:update";
const RECONNECT_ID = "controller:reconnect";
const DISCONNECT_ID = "controller:disconnect";

export interface SDKControllerOptions {
  /**
   * What a subscriber's throw does (#1558). Under `"report"`, the default and
   * what every plugin build runs, the throw goes to a bounded error reporter
   * under the subscriber's id and delivery carries on: nothing a subscriber
   * throws leaves the controller, and no subscriber's throw stops another.
   * The controller's own failures in its poll, its connect attempts and its
   * disconnect are reported the same way, under `controller:` ids. Under
   * `"rethrow"`, delivery still reaches every subscriber, and the first error
   * is then thrown out of the entry point that delivered (a timer callback,
   * `subscribe`, `setReconnectEnabled`), as is any error of the controller's
   * own; nothing is reported. A test that wants loudness chooses it. Never
   * read from the environment.
   */
  onSubscriberError?: ErrorPolicy;
  /** The reporter's clock, in milliseconds. Defaults to `Date.now()`, read on every call. */
  now?: () => number;
}

export class SDKController {
  private readonly sdk: IRacingSDK;
  private readonly logger: ILogger;
  private subscribers = new Map<string, TelemetryCallback>();
  private updateInterval: NodeJS.Timeout | null = null;
  private reconnectInterval: NodeJS.Timeout | null = null;
  private isConnected = false;
  private lastValidTelemetry: TelemetryData | null = null;
  private reconnectEnabled = true;
  private templateContextDirty = true;
  private lastTemplateContext: TemplateContext | null = null;
  /**
   * `CamCarIdx` the cached template context was built for. The `focused` prefix
   * depends on the camera target, which can change without `SessionTick`
   * advancing (panning the camera on a paused/scrubbed replay) — so a change
   * here rebuilds the context even though the SessionTick dedupe left the tick
   * "unchanged" (issue #700).
   */
  private lastCamCarIdx: number | undefined;
  /**
   * Optional provider for the live per-car race order (1-based positions indexed
   * by carIdx). Injected from a higher layer (the iRacing translator's
   * `getLiveRacePositions`) because this package sits below it — see
   * `setLivePositionsProvider`. When set, the template context uses this
   * continuously-updating order for driver positions instead of iRacing's
   * start/finish-line-frozen `CarIdxPosition`.
   */
  private livePositionsProvider: (() => number[] | null) | null = null;
  /**
   * iRacing's `SessionTick` value at the last notified frame. We poll
   * faster than iRacing's native write rate (see TELEMETRY_INTERVAL_MS)
   * and skip notifying subscribers when the tick hasn't advanced, so each
   * real iRacing frame produces exactly one downstream notification. Reset
   * to `-1` on disconnect / stop so the next connection's first frame
   * always notifies.
   */
  private lastSessionTick = -1;
  /**
   * The one debounced replay state (#1324): whether a replay is on screen and
   * the frame it shows, held through the ~300 ms `IsReplayPlaying` blip after
   * every seek. Stepped on every poll that reads telemetry — in `update()`
   * before the `SessionTick` dedupe, and at the connect-time delivery — so a
   * subscriber reads this tick's answer and a repeated tick still counts: in
   * a paused replay the flag's return after a seek's blip can arrive on a
   * deduped tick, and skipping it would let the grace run out on a replay
   * that is still open. Never stepped on the re-delivery of
   * `lastValidTelemetry`, which would re-stamp a stale sighting with a fresh
   * time and stretch the grace. Reset with `lastSessionTick` so a reconnect
   * starts live with nothing sighted.
   */
  private readonly replayState = new ReplayStateTracker();
  /**
   * The error boundary around every subscriber call and every piece of the
   * controller's own work (#1558), under the policy of
   * {@link SDKControllerOptions.onSubscriberError}.
   */
  private readonly boundary: ErrorBoundary;

  constructor(sdk: IRacingSDK, logger: ILogger = silentLogger, options: SDKControllerOptions = {}) {
    this.sdk = sdk;
    this.logger = logger;
    this.boundary = createErrorBoundary({ logger, now: options.now, policy: options.onSubscriberError });
  }

  /**
   * Subscribe to telemetry updates. A callback that throws stays subscribed
   * and is called on the next delivery like any other (#1558).
   */
  subscribe(id: string, callback: TelemetryCallback): void {
    this.subscribers.set(id, callback);

    // Start updates if this is the first subscriber
    const startHeld = this.subscribers.size === 1 ? this.start() : undefined;

    // Immediately notify the new subscriber of current state. The replay
    // state needs no step here: the connect-time delivery or the last poll
    // has stepped it with a read as fresh as this one.
    const telemetry = this.sdk.getTelemetry();
    const held = this.boundary.call(id, () => callback(telemetry, this.isConnected));

    throwHeld(startHeld ?? held);
  }

  /**
   * Unsubscribe from telemetry updates. Flushes the id's unreported error
   * counts as one `warn` line and drops them, since ids (action contexts)
   * come and go.
   */
  unsubscribe(id: string): void {
    this.subscribers.delete(id);
    this.boundary.forget(id);

    // Stop updates if no more subscribers
    if (this.subscribers.size === 0) {
      this.stop();
    }
  }

  /**
   * Start the update and reconnect loops, then make the first connect attempt.
   *
   * Both intervals exist before the first `tryConnect()` (#1558): that attempt
   * delivers to subscribers, and whatever it throws must not leave the
   * controller without its loops. `start()` runs only for the first
   * subscriber, so a half-done start would never be retried.
   */
  private start(): HeldError {
    // Start reconnect polling (every 2 seconds when offline)
    this.reconnectInterval = setInterval(() => {
      throwHeld(
        this.boundary.run(RECONNECT_ID, () => {
          // Skip reconnection attempts if disabled (iRacing not running)
          if (!this.reconnectEnabled) {
            return undefined;
          }

          const sdkConnected = this.sdk.isConnected();

          // Reconnect if SDK disconnected, or if SDK reconnected but we haven't updated our state
          if (!sdkConnected || (sdkConnected && !this.isConnected)) {
            this.logger.info("[SDKController] Attempting reconnect...");

            return this.tryConnect();
          }

          return undefined;
        }),
      );
    }, 2000);

    // Start the telemetry poll. It runs every TELEMETRY_INTERVAL_MS (10 ms);
    // the SessionTick dedupe in update() then delivers at iRacing's ~60 Hz
    // write rate, one delivery per real frame (issue #493).
    this.updateInterval = setInterval(() => {
      throwHeld(this.boundary.run(UPDATE_ID, () => (this.sdk.isConnected() ? this.update() : undefined)));
    }, TELEMETRY_INTERVAL_MS);

    // Try initial connection
    return this.boundary.run(RECONNECT_ID, () => this.tryConnect());
  }

  /**
   * Stop the update and reconnect loops
   */
  private stop(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    this.sdk.disconnect();
    this.isConnected = false;
    this.lastTemplateContext = null;
    this.templateContextDirty = true;
    this.lastSessionTick = -1;
    this.replayState.reset();
  }

  /**
   * Try to connect to iRacing. Runs only inside the error boundary, as
   * `controller:reconnect`, since `sdk.connect()` can throw.
   */
  private tryConnect(): HeldError {
    const wasConnected = this.isConnected;
    const connected = this.sdk.connect();

    // Update connection state
    this.isConnected = connected;

    // Notify subscribers if connection state changed
    if (connected !== wasConnected) {
      if (connected) {
        this.logger.info("[SDKController] Connected to iRacing");
      } else {
        this.logger.info("[SDKController] Disconnected from iRacing");
        // The update loop skips `update()` while the SDK reads disconnected,
        // so this is where a dropped connection is noticed: the replay state
        // must not report the last tick's replay to a read made meanwhile.
        this.replayState.reset();
      }

      // Notify all subscribers of connection state change. The read this
      // delivers is a fresh one, stepped like a poll's (#1324).
      const telemetry = this.sdk.getTelemetry();

      if (connected && telemetry) this.stepReplayState(telemetry);

      return this.notifySubscribers(telemetry);
    }

    return undefined;
  }

  /**
   * Steps the replay state with one fresh telemetry read (#1324).
   * `getSessionInfo` is cached on the SDK by its update counter, so the
   * per-poll read costs a header check.
   */
  private stepReplayState(telemetry: TelemetryData): void {
    this.replayState.step(telemetry, this.sdk.getSessionInfo(), Date.now());
  }

  /**
   * Update telemetry and notify subscribers. Runs only inside the error
   * boundary, as `controller:update`.
   */
  private update(): HeldError {
    // Only update if SDK thinks it's connected
    if (!this.sdk.isConnected()) {
      // SDK not connected, but we might have thought we were
      if (this.isConnected) {
        this.logger.info("[SDKController] Disconnected from iRacing");
        this.sdk.disconnect();
        this.isConnected = false;
        this.lastValidTelemetry = null;
        this.lastTemplateContext = null;
        this.templateContextDirty = true;
        this.lastSessionTick = -1;
        this.replayState.reset();

        return this.notifySubscribers(null);
      }

      return undefined;
    }

    // SDK is connected, get telemetry
    const telemetry = this.sdk.getTelemetry();

    // Check if telemetry is null (could happen during buffer update)
    if (!telemetry) {
      // Use last valid telemetry if available to avoid blinking. The replay
      // state is NOT stepped with it: that read was stepped when it was fresh.
      if (this.lastValidTelemetry) {
        return this.notifySubscribers(this.lastValidTelemetry);
      }

      return undefined;
    }

    // Every fresh read steps the replay state, before the dedupe below: a
    // repeated tick carries the flag too (#1324).
    this.stepReplayState(telemetry);

    // Dedupe by iRacing's `SessionTick`. We poll faster than iRacing's
    // 60 Hz write rate (see TELEMETRY_INTERVAL_MS) so the same tick will
    // be read by 1–2 polls in a row; firing subscribers only on a tick
    // change keeps downstream work (template context rebuild, action
    // re-renders) at iRacing's native cadence regardless of poll rate.
    // `SessionTick` undefined falls through (no field on this build of
    // the SDK headers) — we still notify so we don't silently break
    // legacy paths.
    const tick = telemetry.SessionTick;

    if (tick !== undefined && tick === this.lastSessionTick) {
      return undefined;
    }

    this.lastSessionTick = tick ?? -1;

    // Cache the valid telemetry
    this.lastValidTelemetry = telemetry;
    this.templateContextDirty = true;

    return this.notifySubscribers(telemetry);
  }

  /**
   * Notify every subscriber, in subscription order, each inside the error
   * boundary (#1558). This is the only place the subscriber map is iterated,
   * and the order is load-bearing: the Elgato extension relies on the
   * translator subscribing first. A throwing subscriber does not stop the ones
   * after it, and is reported under its own id, so the controller work this
   * runs inside never reports it again under a `controller:` id; under
   * `"rethrow"` the first error is returned, to be thrown once the entry
   * point's work is done.
   */
  private notifySubscribers(data: TelemetryData | null): HeldError {
    return this.boundary.callEach(this.subscribers, (callback) => callback(data, this.isConnected));
  }

  /**
   * Get current connection status
   */
  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /**
   * Enable or disable reconnection attempts.
   * Used by app monitor to pause reconnection when iRacing is not running.
   *
   * When disabled, actively disconnects if currently connected (since iRacing
   * has terminated and the connection is no longer valid).
   */
  setReconnectEnabled(enabled: boolean): void {
    this.reconnectEnabled = enabled;
    this.logger.info(`[SDKController] Reconnect ${enabled ? "enabled" : "disabled"}`);

    if (!enabled && this.isConnected) {
      // iRacing terminated - disconnect immediately and notify subscribers
      this.logger.info("[SDKController] Disconnecting (app terminated)");
      throwHeld(
        this.boundary.run(DISCONNECT_ID, () => {
          this.sdk.disconnect();
          this.isConnected = false;
          this.lastValidTelemetry = null;
          this.lastTemplateContext = null;
          this.templateContextDirty = true;
          // Reset dedupe state so the first frame of the next iRacing session
          // is never suppressed by a stale tick value (issue #493 follow-up).
          this.lastSessionTick = -1;
          this.replayState.reset();

          return this.notifySubscribers(null);
        }),
      );
    } else if (enabled && this.subscribers.size > 0 && !this.isConnected) {
      // Re-enabling and we have subscribers - try to connect immediately.
      // `sdk.connect()` can throw, so the attempt runs inside the same
      // boundary as the reconnect poll's.
      throwHeld(this.boundary.run(RECONNECT_ID, () => this.tryConnect()));
    }
  }

  /**
   * Get current telemetry (for synchronous access)
   * Returns cached telemetry if fresh read fails
   */
  getCurrentTelemetry(): TelemetryData | null {
    const telemetry = this.sdk.getTelemetry();

    if (telemetry) {
      this.lastValidTelemetry = telemetry;

      return telemetry;
    }

    // Return cached telemetry if available
    return this.lastValidTelemetry;
  }

  /**
   * Get session info (YAML data parsed to object)
   */
  getSessionInfo(): SessionInfo | null {
    return this.sdk.getSessionInfo();
  }

  /**
   * The debounced replay state as of `nowMs` (#1324): whether a replay is on
   * screen and the frame it shows. Every "in a replay" decision reads this,
   * never `telemetry.IsReplayPlaying`, which drops for ~300 ms after each
   * seek. The grace runs on wall time, so a read between ticks sees it
   * expire; `nowMs` is injectable for tests.
   */
  getReplayState(nowMs: number = Date.now()): ReplayState {
    return this.replayState.read(nowMs);
  }

  /**
   * Tells the replay state that the plugin's own `goToEnd` was just sent:
   * outside a saved replay the command leaves the replay for the car
   * at once, so the grace is dropped rather than holding the old replay frame
   * for a second (#1230). In a saved replay it is only a seek and nothing
   * changes. Call it only for a command that was actually sent; whether it
   * changed anything is not reported, since no caller has a use for it.
   * `nowMs` is injectable for tests.
   */
  noteReplayLeftForLive(nowMs: number = Date.now()): void {
    this.replayState.noteLeftForLive(nowMs);
  }

  /**
   * Get the current template context (lazy-built, cached per tick).
   * Returns null when not connected or no telemetry available.
   */
  getCurrentTemplateContext(): TemplateContext | null {
    const telemetry = this.getCurrentTelemetry();

    if (!telemetry) return null;

    const camCarIdx = telemetry.CamCarIdx;

    if (this.templateContextDirty || !this.lastTemplateContext || camCarIdx !== this.lastCamCarIdx) {
      const sessionInfo = this.getSessionInfo();
      // The order goes in as a provider: the lazy context asks for it only when a
      // driver or session variable is read (#1339).
      this.lastTemplateContext = buildTemplateContextFromData(telemetry, sessionInfo, () =>
        this.getLiveRacePositions(),
      );
      this.lastCamCarIdx = camCarIdx;
      this.templateContextDirty = false;
    }

    return this.lastTemplateContext;
  }

  /**
   * Inject the live per-car race-order provider (see {@link livePositionsProvider}).
   * Called once during plugin init with the iRacing translator's
   * `getLiveRacePositions`. Passing `null` clears it — template positions then fall
   * back per car to iRacing's official `CarIdxPosition`.
   */
  setLivePositionsProvider(provider: (() => number[] | null) | null): void {
    this.livePositionsProvider = provider;
  }

  /**
   * Current live per-car race order from the injected provider, or `null` when no
   * provider is set or it has no data yet.
   */
  getLiveRacePositions(): number[] | null {
    return this.livePositionsProvider?.() ?? null;
  }
}
