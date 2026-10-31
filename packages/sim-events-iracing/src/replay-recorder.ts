/**
 * The replay recorder (issue #1468): the controller subscriber that runs the
 * four replay recorders — `diffReplayLaps` (#1203), `diffReplayGreens`
 * (#1354), `diffReplaySessions` and `diffReplayIncidents` (#1426) — over a
 * state of its own, {@link ReplayRecorderState}, and publishes their
 * `replay.*` events for @iracedeck/replay-store's per-session file.
 *
 * **Why it is its own subscriber.** The recorders note moments of the live
 * session with the replay frame they happened at; they emit no Race Engineer
 * event and read none of the translator's state. Inside the translator their
 * state was reset by the translator's own wipes — the per-session reset and
 * the replay guard's — whose rules exist for dozens of Race Engineer
 * baselines, so every change to those wipes had to be re-checked against the
 * recorders. Here the recorders' resets are stated beside them, once.
 *
 * **Why it sees every tick.** A recorder must SEE the ticks it cannot record:
 * its gate (`diff/replay-record-gate.ts`) marks it unseeded on every replay /
 * no-session tick and it re-seeds silently on the first eligible tick after,
 * so a driver coming back from the garage or the replay view to a field that
 * crossed the line meanwhile produces no fabricated crossing. Behind the
 * translator's replay guard the early return would hide exactly those ticks.
 * The session record also records from some of them: out of the car at the
 * live edge of the in-session replay, which is how a session that begins
 * while the driver sits in the garage still gets its start. So this
 * subscriber has no guard; each recorder's gate is the only one.
 *
 * **The one "in a replay" answer** is the controller's debounced replay state
 * (#1324), read once per tick: it holds for `REPLAY_EXIT_GRACE_MS` after the
 * last `IsReplayPlaying: true` tick, so a seek's ~300 ms false blip is not a
 * trip to live (a blip tick neither seeds nor records), and it is true
 * throughout a saved replay (`SimMode === "replay"`), whatever the flag reads.
 *
 * **The reset points** — the translator's, reproduced exactly:
 *
 * - **Start** — {@link createInitialReplayRecorderState}.
 * - **Disconnect** — everything, the session record too, and the session
 *   identity baseline, so a reconnect seeds rather than compares. The
 *   "last tick in a replay" flag is deliberately kept, as the translator keeps
 *   its own across a disconnect: a reconnect that finds the driver in the
 *   garage resets again on the first live tick.
 * - **A session change** (`session-identity.ts`: a new `(SubSessionID,
 *   SessionNum)` outside a saved replay, #1509) — the baselines, BEFORE the
 *   recorders run on that tick; the session record is kept, since a session
 *   change is exactly when its next pair arrives and the pairs already
 *   published must stay published.
 * - **Entering a replay view** — the baselines, AFTER the recorders ran on
 *   that tick.
 * - **Leaving a replay view** — the baselines, AFTER the recorders ran on the
 *   first live tick, so that tick's seed is thrown away and the next tick
 *   seeds again: whatever changed between the first and the second live tick
 *   is never recorded.
 *
 * Every reset is {@link resetReplayRecorderBaselines} except the disconnect;
 * why the session record outlives them is in `replay-recorder-state.ts`.
 */
import type { IEventBus, SimEventMap, SimEventName } from "@iracedeck/event-bus";
import type { SDKController, TelemetryData } from "@iracedeck/iracing-sdk";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { diffReplayGreens } from "./diff/replay-greens.js";
import { diffReplayIncidents } from "./diff/replay-incidents.js";
import { diffReplayLaps } from "./diff/replay-laps.js";
import { diffReplaySessions } from "./diff/replay-sessions.js";
import type { PendingEvent } from "./diff/types.js";
import {
  createInitialReplayRecorderState,
  type ReplayRecorderState,
  resetReplayRecorderBaselines,
} from "./replay-recorder-state.js";
import {
  advanceSessionIdentity,
  createSessionIdentityBaseline,
  readSessionIdentity,
  type SessionIdentityBaseline,
} from "./session-identity.js";

/** The id the recorder subscribes to the controller under, beside the translator's `"__sim-events-iracing__"`. */
export const REPLAY_RECORDER_SUBSCRIPTION_ID = "__sim-events-iracing-replay-recorder__";

/** What the recorder reads from the controller. */
export type ReplayRecorderController = Pick<
  SDKController,
  "subscribe" | "unsubscribe" | "getSessionInfo" | "getReplayState"
>;

/** A running recorder. */
export type ReplayRecorder = {
  /** Unsubscribes from the controller; the recorder sees no tick after it. Idempotent. */
  stop(): void;
};

/** Everything the recorder carries from one tick to the next. */
type RecorderInstance = {
  state: ReplayRecorderState;
  sessionIdentity: SessionIdentityBaseline;
  /** The debounced replay state on the previous tick: the replay view's edges are read against it. */
  lastTickInReplay: boolean;
};

/**
 * Subscribe the replay recorder to `controller` and publish its `replay.*`
 * events to `bus`. Subscribed after the translator, it sees each tick after
 * the translator has. `logger` takes the green and session records' debug
 * lines.
 */
export function startReplayRecorder(
  bus: IEventBus,
  controller: ReplayRecorderController,
  logger: ILogger = silentLogger,
): ReplayRecorder {
  const self: RecorderInstance = {
    state: createInitialReplayRecorderState(),
    sessionIdentity: createSessionIdentityBaseline(),
    lastTickInReplay: false,
  };

  controller.subscribe(REPLAY_RECORDER_SUBSCRIPTION_ID, (telemetry, isConnected) => {
    if (!isConnected) {
      // A fresh record and a fresh identity baseline, so a reconnect seeds
      // cleanly. `lastTickInReplay` is NOT reset: the translator never reset
      // its own here, and the equivalence golden pins the result (tape "B: a
      // reconnect after a disconnect in the garage" — the first live tick after
      // such a reconnect is a replay exit, and resets again).
      self.state = createInitialReplayRecorderState();
      self.sessionIdentity = createSessionIdentityBaseline();

      return;
    }

    if (!telemetry) return;

    handleTick(self, bus, controller, logger, telemetry);
  });

  let stopped = false;

  return {
    stop(): void {
      if (stopped) return;

      stopped = true;
      controller.unsubscribe(REPLAY_RECORDER_SUBSCRIPTION_ID);
    },
  };
}

function handleTick(
  self: RecorderInstance,
  bus: IEventBus,
  controller: ReplayRecorderController,
  logger: ILogger,
  telemetry: TelemetryData,
): void {
  const replayState = controller.getReplayState();
  const inReplay = replayState.inReplay;
  const emit = (pending: PendingEvent): void => publish(bus, pending, telemetry);
  const readSessionInfo = (): Record<string, unknown> | null =>
    controller.getSessionInfo() as Record<string, unknown> | null;

  // A session change resets the baselines BEFORE the recorders read this
  // tick, so the new session's first tick seeds rather than compares against
  // the old one's.
  const identity = readSessionIdentity(self.sessionIdentity, telemetry, readSessionInfo);

  if (identity.change) {
    self.state = resetReplayRecorderBaselines(self.state);
  }

  self.sessionIdentity = advanceSessionIdentity(self.sessionIdentity, identity);

  // The replay lap record (issue #1203). Its gate marks the recorder unseeded
  // on every replay / no-session tick and re-seeds silently on the first
  // eligible tick after.
  diffReplayLaps(self.state, telemetry, readSessionInfo(), inReplay, emit);

  // The replay green record (issue #1354), the lap record's sibling on the
  // same gate (`resolveReplayRecordTick`): it has to SEE a replay / no-session
  // tick to mark itself unseeded and drop its caution latch, so a driver who
  // sat in the garage through the green, or glanced at the replay across a
  // restart, gets no entry rather than one stamped with the frame he came
  // back on. It judges "a race session" itself, with the strict reading
  // (`resolveSessionType(…) === "Race"`, so a warmup session is not one).
  diffReplayGreens(self.state, telemetry, readSessionInfo(), inReplay, emit, logger);

  // The replay session record (issue #1426), on the second class of tick the
  // gate knows (`resolveReplayLiveTick`): in the car, or out of it at the live
  // edge of the in-session replay. It reads the controller's saved-replay
  // answer (`replayState.replayOnlySession`), not the session identity's
  // per-tick `replayOnlySession`: that one reads false on any tick whose
  // session info is null, while the controller keeps its answer through such
  // a tick, and at the end of a saved replay's tape the out-of-car gate would
  // otherwise take the tick as the live edge of a live session.
  diffReplaySessions(self.state, telemetry, readSessionInfo(), inReplay, replayState.replayOnlySession, emit, logger);

  // The replay incident record (issue #1426), on the lap and green records'
  // in-car gate: an ineligible tick must unseed it, so a count that rose
  // behind the replay view is not stamped with the frame the driver came back
  // on.
  diffReplayIncidents(self.state, telemetry, readSessionInfo(), inReplay, emit);

  // The replay view's edges, AFTER the recorders. The entry reset changes
  // nothing today — the in-car gate has just unseeded the lap, green and
  // incident baselines on this replay tick, and the session record is kept —
  // but it is where the translator reset, so it stays.
  if (inReplay && !self.lastTickInReplay) {
    self.state = resetReplayRecorderBaselines(self.state);
    self.lastTickInReplay = true;
  } else if (!inReplay && self.lastTickInReplay) {
    self.state = resetReplayRecorderBaselines(self.state);
    self.lastTickInReplay = false;
  }
}

/** Publish one recorder event in the translator's live envelope. */
function publish(bus: IEventBus, pending: PendingEvent, telemetry: TelemetryData): void {
  const envelope = {
    event: pending.event,
    timestamp: Date.now(),
    telemetry,
    data: pending.data,
  } as SimEventMap[SimEventName];
  bus.publish(envelope);
}
