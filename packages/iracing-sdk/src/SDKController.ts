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
import { type ReplaySeekHold, ReplayStateTracker } from "./replay-state-tracker.js";
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
 * `controller:reconnect`, the poll (its native disconnect on a dropped
 * connection included) and `subscribe`'s immediate telemetry read as
 * `controller:update`, and the native disconnect when iRacing terminates or
 * the last subscriber leaves as `controller:disconnect`.
 */
const UPDATE_ID = "controller:update";
const RECONNECT_ID = "controller:reconnect";
const DISCONNECT_ID = "controller:disconnect";
/** The prefix of the reporter id each context-boundary listener is called under (#1656). */
const BOUNDARY_LISTENER_ID_PREFIX = "controller:context-boundary:";

/**
 * A point past which nothing the plugin sent iRacing can be assumed to still
 * be in effect (#1656): the connection to iRacing was lost (a sim exit, a
 * dropped connection, the last subscriber leaving), the session number
 * changed, or a replay was entered or left (the debounced replay state,
 * {@link SDKController.getReplayState}). Only the connection loss is certain
 * to end such state; whether iRacing keeps it across the other three is not
 * measured, so a listener that holds sim-side state it cannot read back
 * clears it at all four, as the cheaper mistake.
 *
 * A seek is not one of its own, but it can read as two. A seek the plugin
 * makes is held (the replay engine's seek hold), so it never reads as leaving
 * the replay, and the -1 `SessionNum` a seek reads is skipped. A seek made
 * with iRacing's own replay controls is held only by the exit grace
 * (`REPLAY_EXIT_GRACE_MS`, 1 s): one whose blip outlasts it reads as
 * `replay-left` and then `replay-entered`, and a listener clears at both, on
 * the same rule.
 */
export type SimContextBoundary = "connection-lost" | "session-changed" | "replay-entered" | "replay-left";

/**
 * Called once per {@link SimContextBoundary} the controller passes, with the
 * moment it was passed (`Date.now()` clock): state a listener recorded at or
 * before `passedAtMs` is behind the boundary, state recorded after it is not.
 * That is the time the controller saw it, except for `replay-left`, which the
 * debounced state reports only once the exit grace has run out: there it is
 * the last moment the replay was on screen (the last replay sighting, or the
 * end of a seek hold of the plugin's own, or the plugin's own exit to live),
 * so something sent in that last second, already live, is kept.
 */
export type SimContextBoundaryListener = (boundary: SimContextBoundary, passedAtMs: number) => void;

/** Whatever reports {@link SimContextBoundary}s: `SDKController`, or a stand-in in a test. */
export interface SimContextBoundarySource {
  /** Registers `listener`; the returned function removes it. */
  onContextBoundary(listener: SimContextBoundaryListener): () => void;
}

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

export class SDKController implements SimContextBoundarySource {
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
  private livePositionsProvider: (() => readonly number[] | null) | null = null;
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
   * The context-boundary listeners (#1656), by reporter id. Not subscribers:
   * registering one starts no loop and removing the last stops none.
   */
  private readonly boundaryListeners = new Map<string, SimContextBoundaryListener>();
  private nextBoundaryListenerId = 0;
  /**
   * The last `SessionNum` a fresh read carried that names a session (a whole
   * number from 0), or null since the connection reset. A read of -1 (what
   * iRacing reports while it carries out a replay seek) or a missing field
   * leaves it as it was, so a seek that lands in the same session is not a
   * session change.
   */
  private lastSessionNum: number | null = null;
  /** The debounced replay state's `inReplay` at the last step, to see it change (#1656). */
  private lastInReplay = false;
  /**
   * The error boundary around every subscriber call and every piece of the
   * controller's own work (#1558), under the policy of
   * {@link SDKControllerOptions.onSubscriberError}.
   */
  private readonly boundary: ErrorBoundary;

  constructor(sdk: IRacingSDK, logger: ILogger = silentLogger, options: SDKControllerOptions = {}) {
    this.sdk = sdk;
    this.logger = logger;
    // A subscriber that unsubscribes itself and then throws leaves no error
    // keys behind: its `unsubscribe` ran before the throw was reported.
    this.boundary = createErrorBoundary({
      logger,
      now: options.now,
      policy: options.onSubscriberError,
      isRegistered: (id) => this.subscribers.has(id) || this.boundaryListeners.has(id),
    });
  }

  /**
   * Subscribe to telemetry updates. A callback that throws stays subscribed
   * and is called on the next delivery like any other (#1558).
   *
   * Subscribing an id that is already subscribed replaces its callback, and
   * forgets the old callback's error counts: the new one's first throw is a
   * first occurrence, logged in full. Nothing a subscriber or the immediate
   * read throws leaves `subscribe` under `"report"`, so the callback is never
   * registered without the caller getting control back.
   */
  subscribe(id: string, callback: TelemetryCallback): void {
    const wasEmpty = this.subscribers.size === 0;

    if (this.subscribers.has(id)) this.boundary.forget(id);

    this.subscribers.set(id, callback);

    // Start updates if this is the first subscriber. Checked before the `set`:
    // re-subscribing the sole subscriber leaves the size at 1, and starting
    // again would leak the running pair of intervals.
    const startHeld = wasEmpty ? this.start() : undefined;

    // Immediately notify the new subscriber of current state. The read is the
    // controller's own work, so a throw from it is reported as the poll's
    // would be, and the subscriber is still notified, with no telemetry. The
    // replay state needs no step here: the connect-time delivery or the last
    // poll has stepped it with a read as fresh as this one.
    let telemetry = null as TelemetryData | null;
    const readHeld = this.boundary.run(UPDATE_ID, () => {
      telemetry = this.sdk.getTelemetry();

      return undefined;
    });
    const held = this.boundary.call(id, () => callback(telemetry, this.isConnected));

    throwHeld(startHeld ?? readHeld ?? held);
  }

  /**
   * Unsubscribe from telemetry updates. Flushes the id's unreported error
   * counts as one `warn` line and drops them, since ids (action contexts)
   * come and go. When the last subscriber leaves, the loops stop and the SDK
   * disconnects; a throw from that disconnect is reported as
   * `controller:disconnect` (thrown after the reset under `"rethrow"`).
   */
  unsubscribe(id: string): void {
    this.subscribers.delete(id);
    this.boundary.forget(id);

    // Stop updates if no more subscribers
    if (this.subscribers.size === 0) {
      throwHeld(this.stop());
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
   * Stop the update and reconnect loops, disconnect and reset the connection
   * state. The native disconnect runs inside the boundary as
   * `controller:disconnect`, so a throw from it never skips the reset; under
   * `"rethrow"` it is returned held, to be thrown once the reset is done.
   */
  private stop(): HeldError {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    const disconnectHeld = this.boundary.run(DISCONNECT_ID, () => {
      this.sdk.disconnect();

      return undefined;
    });

    const resetHeld = this.resetConnection();

    return disconnectHeld ?? resetHeld;
  }

  /**
   * The one reset of the connection state, wherever the connection ends: the
   * last subscriber leaving (`stop`), a connect attempt that finds iRacing
   * gone (`tryConnect`), the poll noticing the drop (`update`) and the app
   * monitor's exit (`setReconnectEnabled(false)`). Forgets the cached read and
   * template context, resets the `SessionTick` dedupe so the next connection's
   * first frame always notifies (#493), starts the replay state live with
   * nothing sighted (#1324) and the session unknown, and then tells every
   * context-boundary listener the connection was lost (#1656), before any
   * subscriber hears of it. Returns the first listener error held under
   * `"rethrow"`.
   */
  private resetConnection(): HeldError {
    this.isConnected = false;
    this.lastValidTelemetry = null;
    this.lastTemplateContext = null;
    this.templateContextDirty = true;
    this.lastSessionTick = -1;
    this.replayState.reset();
    this.lastSessionNum = null;
    this.lastInReplay = false;

    return this.notifyBoundary("connection-lost", Date.now());
  }

  /**
   * Try to connect to iRacing. Runs only inside the error boundary, as
   * `controller:reconnect`, since `sdk.connect()` can throw.
   *
   * The update loop skips `update()` while the SDK reads disconnected, so a
   * dropped connection is noticed here, by the reconnect poll. A connection
   * the controller still holds while the SDK no longer reports it was lost,
   * whether or not the connect below finds iRacing back: iRacing can drop
   * and return between two polls, and a connect that succeeds at once must
   * still not carry the old connection's state (its `SessionTick` dedupe, its
   * replay state and session, the cached read, the director focus a
   * context-boundary listener keeps) into the new one. So the loss is reset,
   * told to the listeners and the subscribers first, and only then is the
   * connect attempted.
   */
  private tryConnect(): HeldError {
    const lostHeld = this.isConnected && !this.sdk.isConnected() ? this.loseConnection() : undefined;
    const wasConnected = this.isConnected;
    const connected = this.sdk.connect();

    // Notify subscribers if connection state changed
    if (connected !== wasConnected) {
      let held: HeldError;

      if (connected) {
        this.isConnected = true;
        this.logger.info("[SDKController] Connected to iRacing");
      } else {
        // The controller read connected and so did the SDK, yet the connect
        // failed: nothing of the last connection may reach a read made
        // meanwhile.
        this.logger.info("[SDKController] Disconnected from iRacing");
        held = this.resetConnection();
      }

      // Notify all subscribers of connection state change. The read this
      // delivers is a fresh one, stepped like a poll's (#1324).
      const telemetry = this.sdk.getTelemetry();

      if (connected && telemetry) held = this.stepFreshRead(telemetry);

      // Fan out before combining, so under "rethrow" a held listener error
      // never stops the subscribers from hearing of the change.
      const notified = this.notifySubscribers(telemetry);

      return lostHeld ?? held ?? notified;
    }

    return lostHeld;
  }

  /**
   * The connection the reconnect poll found dropped: reset (which tells the
   * context-boundary listeners) and tell the subscribers, as every other
   * loss does. Returns the first error held under `"rethrow"`.
   */
  private loseConnection(): HeldError {
    this.logger.info("[SDKController] Disconnected from iRacing");

    const resetHeld = this.resetConnection();
    // Fan out before combining, as in `update()`.
    const notified = this.notifySubscribers(null);

    return resetHeld ?? notified;
  }

  /**
   * Steps the replay state with one fresh telemetry read (#1324), then tells
   * the context-boundary listeners of each boundary the read crossed (#1656):
   * `SessionNum` moving from one session to another, and the debounced replay
   * state entering or leaving a replay. The replay boundaries follow the
   * debounced state, not the raw flag: the blip after a seek the plugin makes
   * is held and is no boundary, while a blip of a seek made with iRacing's
   * own controls that outlasts the exit grace reads as a leave and then an
   * enter (the {@link SimContextBoundary} type). The grace running out on a
   * paused replay is seen on the next poll, which steps whether or not the
   * tick advanced. A leave is told with the last moment the replay was on
   * screen, read before the step that drops it. `getSessionInfo` is cached
   * on the SDK by its update counter, so the per-poll read costs a header
   * check. Returns the first listener error held under `"rethrow"`.
   */
  private stepFreshRead(telemetry: TelemetryData): HeldError {
    const nowMs = Date.now();
    const lastShownAt = this.replayState.lastShownAt();

    this.replayState.step(telemetry, this.sdk.getSessionInfo(), nowMs);

    let held: HeldError;
    const sessionNum = telemetry.SessionNum;

    if (typeof sessionNum === "number" && Number.isInteger(sessionNum) && sessionNum >= 0) {
      const changed = this.lastSessionNum !== null && sessionNum !== this.lastSessionNum;

      this.lastSessionNum = sessionNum;

      if (changed) held = this.notifyBoundary("session-changed", nowMs);
    }

    const { inReplay } = this.replayState.read(nowMs);

    if (inReplay !== this.lastInReplay) {
      this.lastInReplay = inReplay;

      const replayHeld = inReplay
        ? this.notifyBoundary("replay-entered", nowMs)
        : this.notifyBoundary("replay-left", Math.min(lastShownAt ?? nowMs, nowMs));

      held ??= replayHeld;
    }

    return held;
  }

  /**
   * Tell every context-boundary listener of `boundary`, passed at
   * `passedAtMs`, in registration order, each inside the error boundary under
   * its own id, so a throw neither leaves the controller nor stops another
   * listener (#1558).
   */
  private notifyBoundary(boundary: SimContextBoundary, passedAtMs: number): HeldError {
    this.logger.debug(`[SDKController] Context boundary: ${boundary}`);

    return this.boundary.callEach(this.boundaryListeners, (listener) => listener(boundary, passedAtMs));
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
        // The native call runs in its own boundary step, so a throw from it
        // never skips the reset or the fan-out below.
        const disconnectHeld = this.boundary.run(UPDATE_ID, () => {
          this.sdk.disconnect();

          return undefined;
        });

        const resetHeld = this.resetConnection();

        // Fan out before combining, so under "rethrow" a held disconnect error
        // never stops the subscribers from hearing of the disconnect.
        const notified = this.notifySubscribers(null);

        return disconnectHeld ?? resetHeld ?? notified;
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
    const steppedHeld = this.stepFreshRead(telemetry);

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
      return steppedHeld;
    }

    this.lastSessionTick = tick ?? -1;

    // Cache the valid telemetry
    this.lastValidTelemetry = telemetry;
    this.templateContextDirty = true;

    const notified = this.notifySubscribers(telemetry);

    return steppedHeld ?? notified;
  }

  /**
   * Notify every subscriber, in subscription order, each inside the error
   * boundary (#1558). This is the only place the subscriber map is iterated,
   * and the order is load-bearing for the replay recorder (#1468):
   * `initializeSimEventsIracing` subscribes the translator before it, so every
   * event the recorder publishes on a tick comes after the translator's, the
   * order `sim-events-iracing`'s `tick-order.ts` checks the Race Engineer's
   * `endsOn` contracts against, and the recorder reads the replay state once
   * the translator's tick has run (`replay-recorder.ts`). The Elgato extension
   * does not depend on it: it ticks on `sim.onTick` (#1500). A throwing
   * subscriber does not stop the ones after it, and is reported under its own
   * id, so the controller work this runs inside never reports it again under a
   * `controller:` id; under
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
   * Registers a listener for each {@link SimContextBoundary} the controller
   * passes (#1656): told of a connection loss by the one connection reset,
   * before any subscriber hears of it, and of a session change or a replay
   * entered or left on the fresh read that shows it. It is not a subscriber:
   * registering starts no poll and removing the last stops none, so a holder
   * of sim-side state (`createSDK` wires the camera's director-focus record
   * here) can listen for the life of the process without keeping iRacing
   * connected. A listener's throw is reported like a subscriber's (#1558).
   * The returned function removes the listener.
   */
  onContextBoundary(listener: SimContextBoundaryListener): () => void {
    const id = `${BOUNDARY_LISTENER_ID_PREFIX}${this.nextBoundaryListenerId++}`;

    this.boundaryListeners.set(id, listener);

    return () => {
      if (this.boundaryListeners.delete(id)) this.boundary.forget(id);
    };
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
      // Only the native call runs inside the boundary: a throw from it must
      // not skip the reset or the fan-out, since with reconnecting disabled
      // no poll would ever correct a controller left reading connected.
      const disconnectHeld = this.boundary.run(DISCONNECT_ID, () => {
        this.sdk.disconnect();

        return undefined;
      });

      const resetHeld = this.resetConnection();

      // Fan out before combining, so under "rethrow" a held disconnect error
      // never stops the subscribers from hearing of the disconnect.
      const notified = this.notifySubscribers(null);

      throwHeld(disconnectHeld ?? resetHeld ?? notified);
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
   * Tells the replay state how long a seek of the plugin's own still holds
   * the replay (#1429): `hold.remainingMs` from `nowMs`, never past the last
   * replay sighting plus `hold.maxPastSightingMs`, or null once none is under
   * way. While iRacing carries out a seek the ticks read as the car until the
   * cursor lands, which outlasts the exit grace on a long jump or a sustained
   * dial spin; the replay engine's command gate, which knows its seek is out,
   * says so here at the end of each of its changes. The hold only extends a
   * replay the ticks have sighted, never makes one, its release restarts the
   * grace, and the cap stops moves sent from the car from renewing it. A
   * remaining duration, not a time, so the engine's clock need not be this
   * one. `nowMs` is injectable for tests.
   */
  noteReplaySeekHold(hold: ReplaySeekHold | null, nowMs: number = Date.now()): void {
    this.replayState.holdForSeek(hold, nowMs);
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
  setLivePositionsProvider(provider: (() => readonly number[] | null) | null): void {
    this.livePositionsProvider = provider;
  }

  /**
   * Current live per-car race order from the injected provider, or `null` when no
   * provider is set or it has no data yet.
   */
  getLiveRacePositions(): readonly number[] | null {
    return this.livePositionsProvider?.() ?? null;
  }
}
