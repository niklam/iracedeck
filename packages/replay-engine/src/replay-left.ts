/**
 * Leaving the replay is one engine event (#1467, Decision 5 of
 * `docs/superpowers/specs/2026-10-20-issue-1467-replay-engine-package.md`).
 *
 * The engine watches the controller's ticks and emits `replayLeft` once per
 * departure: `left` on the edge of the debounced replay state
 * (`getReplayState().inReplay`, held through `REPLAY_EXIT_GRACE_MS`, so a
 * replay blip is not a departure) going false, and `disconnected` on the first
 * tick without a connection or telemetry after a connected one. Every holder
 * of replay state registers here at module scope: the gate, the paced search
 * and the lap walks.
 *
 * **The edge is held through the plugin's own seek.** In a live session the
 * debounced state gives the replay up about a second into any long seek the
 * plugin makes itself; a lap walk's first probe on a long tape is one. So
 * while the state reads false and a move of the plugin's own stands, `left`
 * waits: a position target that has not read back holds it for that target's
 * own wait (`giveUpMs`), counted from the edge or, for a target sent after it
 * (a walk's next probe), from its send, so it gets its whole wait; a seek that
 * shows with no target holds it for {@link REPLAY_TARGET_GIVE_UP_MS} from the
 * edge. `left` goes out
 * once nothing holds it with the state still false; a state that reads true
 * again first emits nothing. The hold is bounded so the event can still fire
 * during a walk, which always has a target out. A disconnect is not held.
 *
 * The hold is re-judged on every tick and, should no tick come, once more by a
 * timer at the moment it lapses.
 *
 * Engine-internal: never in the `@iracedeck/event-bus` catalog.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";

import { now } from "./engine-clock.js";
import { engineLogger, type ReplayEngineController } from "./replay-engine-env.js";
import { pendingReplayTarget, REPLAY_TARGET_GIVE_UP_MS } from "./replay-position-state.js";
import { isSeeking } from "./replay-seek.js";

/** Why the replay was left: the user left it, or the sim went away. */
export type ReplayLeftReason = "left" | "disconnected";

/** One departure from the replay. */
export interface ReplayLeftEvent {
  readonly reason: ReplayLeftReason;
}

/** The id the watch subscribes to the controller under. */
export const REPLAY_LEFT_SUBSCRIBER_ID = "replay-engine";

/**
 * The name a departure takes the replay cursor under: a lap walk's claim is
 * cancelled by it (`lap-walk-owners.ts`), and the gate files the walk's fact
 * as ended by `replay-left`, not as a take by another press.
 */
export const REPLAY_LEFT_CANCEL = "replay-left";

/**
 * Who is told of a departure. Module wiring, registered once at load, not
 * state: {@link _resetReplayLeft} leaves it alone, as `_resetReplayCursor`
 * leaves the cursor's taken listeners, or the first reset would unwire the
 * gate, the paced search and the lap walks for every later test.
 */
const listeners = new Set<(event: ReplayLeftEvent) => void>();

/**
 * Runs `listener` on every departure from the replay: the gate, the paced
 * search and the lap walks register at load. Returns the unsubscribe.
 */
export function onReplayLeft(listener: (event: ReplayLeftEvent) => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function emit(reason: ReplayLeftReason): void {
  engineLogger("ReplayLeft").debug(`Replay left: ${reason}`);

  for (const listener of [...listeners]) {
    try {
      listener({ reason });
    } catch (err) {
      engineLogger("ReplayLeft").debug(`Replay left listener failed: ${String(err)}`);
    }
  }
}

/** The one watch's state. */
interface Watch {
  readonly controller: ReplayEngineController;
  /** The last tick had a connection and telemetry: a dropped one is then a disconnect. */
  connected: boolean;
  /** The replay has been on screen since the last departure: a state reading false is then a departure. */
  inReplay: boolean;
  /** When the state first read false since it last read true, while `left` waits; null when nothing waits. */
  edgeAt: number | null;
  /** Re-judges a hold at the moment it lapses, should no tick come first. */
  timer: ReturnType<typeof setTimeout> | null;
}

let watch: Watch | null = null;

function clearTimer(w: Watch): void {
  if (w.timer !== null) clearTimeout(w.timer);

  w.timer = null;
}

/**
 * Until when a move of the plugin's own holds a departure first read at
 * `edgeAt`, or null when nothing holds it: a standing target for its own
 * wait, else a seek that shows for {@link REPLAY_TARGET_GIVE_UP_MS}. A target
 * sent after the edge counts its wait from its send; one not sent yet, whose
 * `sentAt` is only when it was recorded, counts from the edge.
 */
function heldUntil(edgeAt: number, telemetry: TelemetryData | null): number | null {
  const target = pendingReplayTarget();

  if (target !== null) return (target.sent ? Math.max(edgeAt, target.sentAt) : edgeAt) + target.giveUpMs;

  if (isSeeking(telemetry)) return edgeAt + REPLAY_TARGET_GIVE_UP_MS;

  return null;
}

function readInReplay(controller: ReplayEngineController): boolean | null {
  try {
    return controller.getReplayState().inReplay;
  } catch {
    return null;
  }
}

function onTick(w: Watch, telemetry: TelemetryData | null, isConnected: boolean): void {
  if (watch !== w) return;

  if (!isConnected || telemetry === null) {
    clearTimer(w);
    w.edgeAt = null;
    w.inReplay = false;

    if (!w.connected) return;

    w.connected = false;
    emit("disconnected");

    return;
  }

  w.connected = true;

  const inReplay = readInReplay(w.controller);

  if (inReplay === null) return;

  if (inReplay) {
    clearTimer(w);
    w.inReplay = true;
    w.edgeAt = null;

    return;
  }

  if (!w.inReplay) return;

  w.edgeAt ??= now();

  const until = heldUntil(w.edgeAt, telemetry);
  const at = now();

  if (until !== null && at < until) {
    clearTimer(w);
    w.timer = setTimeout(() => {
      w.timer = null;
      onTimer(w);
    }, until - at);

    return;
  }

  clearTimer(w);
  w.inReplay = false;
  w.edgeAt = null;
  emit("left");
}

/** A hold lapsed with no tick: judge it on a fresh read, as a tick would. */
function onTimer(w: Watch): void {
  let telemetry: TelemetryData | null;
  let isConnected: boolean;

  try {
    telemetry = w.controller.getCurrentTelemetry();
    isConnected = w.controller.getConnectionStatus();
  } catch {
    return;
  }

  onTick(w, telemetry, isConnected);
}

/**
 * Watches `controller` for departures from the replay, replacing any watch
 * already standing, so there is one per process. Returns the stop.
 */
export function startReplayLeftWatch(controller: ReplayEngineController): () => void {
  stopReplayLeftWatch();

  const w: Watch = { controller, connected: false, inReplay: false, edgeAt: null, timer: null };

  watch = w;
  controller.subscribe(REPLAY_LEFT_SUBSCRIBER_ID, (telemetry, isConnected) => onTick(w, telemetry, isConnected));

  return () => {
    if (watch === w) stopReplayLeftWatch();
  };
}

/** Stops the watch, if one stands. */
export function stopReplayLeftWatch(): void {
  const w = watch;

  if (w === null) return;

  watch = null;
  clearTimer(w);

  try {
    w.controller.unsubscribe(REPLAY_LEFT_SUBSCRIBER_ID);
  } catch {
    // A controller that cannot unsubscribe has nothing more to deliver to a watch that no longer stands.
  }
}

/** @internal For tests: stops the watch. The listeners are module wiring and stay. */
export function _resetReplayLeft(): void {
  stopReplayLeftWatch();
}
