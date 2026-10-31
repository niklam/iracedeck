/**
 * The replay recorders' event stream, pinned across their move (issue #1468).
 *
 * `diffReplayLaps`, `diffReplayGreens`, `diffReplaySessions` and
 * `diffReplayIncidents` ran inside the translator's `handleTick` until #1468,
 * and their state (then the `replay*` members of `TranslatorState`) was reset
 * at five points that belonged to the translator, not to them. They now run
 * in a controller subscriber of their own (`replay-recorder.ts`) over
 * `ReplayRecorderState`, which keeps the same five points, named here by
 * where they lived in the translator (the recorder's own names are in the
 * header of `replay-recorder.ts`):
 *
 * - A. init (`createInitialState`);
 * - B. `handleDisconnect`: everything, the session record too — while
 *   `lastTickInReplay` survives it, so a reconnect that left the driver in the
 *   garage wipes again on the first live tick;
 * - C. `resetPerSessionState`, BEFORE the recorders, on a SessionNum or
 *   `WeekendInfo.SubSessionID` change outside a saved replay: the lap, green
 *   and incident baselines go, the session record stays;
 * - D. `wipeStateForReplay` on the replay guard's entry edge, AFTER the
 *   recorders ran on that tick: baselines go, the session record stays;
 * - E. the same wipe on the exit edge, AFTER the recorders ran: the first live
 *   tick's seed is thrown away, so whatever changed between the first and the
 *   second live tick is never recorded.
 *
 * This file drives the real init through its public surface only —
 * `initializeSimEventsIracing`, which starts the translator and the recorder,
 * with a real event bus and a fake SDK controller that serves its subscribers
 * in subscription order as `SDKController` does — and compares every
 * `replay.*` event published, in arrival order, with a committed golden file.
 * The golden is the stream the recorders produced while they still ran inside
 * the translator; the move left it unchanged, and it holds the recorder to
 * that behaviour. The tapes are the recorded fixtures that carry what the
 * recorders read, adapted into ticks, plus synthetic tapes built so that each
 * reset above decides their output: move or drop one and a named tape fails.
 *
 * The replay state is the SDK's real `ReplayStateTracker`, stepped once per
 * delivered tick with the faked `Date.now()` — the order `SDKController`
 * keeps (step, then notify) — so the entry and exit edges, the one-second exit
 * grace and a seek's blip are the production debounce, not a script.
 *
 * The golden file is `__golden__/replay-recorder-equivalence.jsonl`: per tape,
 * one header line (`tape`, `steps`, `about`) and one line per event (`tape`,
 * `step`, `event`, `data`). A difference FAILS; nothing rewrites it under a
 * plain `pnpm test`. To regenerate it after a deliberate behaviour change,
 * run `REPLAY_GOLDEN_UPDATE=1 pnpm test <this file>` and review the diff.
 */
import {
  _resetEventBus,
  getEventBus,
  type IEventBus,
  initializeEventBus,
  type SimEventName,
} from "@iracedeck/event-bus";
import {
  CarLeftRight,
  REPLAY_EXIT_GRACE_MS,
  ReplayStateTracker,
  type SDKController,
  SessionState,
  type TelemetryCallback,
  type TelemetryData,
  TrkLoc,
} from "@iracedeck/iracing-sdk";
import { silentLogger } from "@iracedeck/logger";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSimEventsIracing, initializeSimEventsIracing } from "./translator.js";

// ── The fake controller ────────────────────────────────────────────────────

type SessionInfo = Record<string, unknown> | null;

/**
 * The parts of `SDKController` the translator reads, with its delivery rules:
 * subscribers are called in subscription order (a `Map` in insertion order,
 * as `notifySubscribers` iterates), a new subscriber gets the current read at
 * once (`(null, false)` before the first connect), the replay state is stepped
 * with each fresh read before anyone is notified, and a dropped connection
 * resets it and delivers `(null, false)`.
 */
class FakeSdkController {
  private readonly subscribers = new Map<string, TelemetryCallback>();
  private readonly replayState = new ReplayStateTracker();
  private sessionInfo: SessionInfo = null;
  private telemetry: TelemetryData | null = null;
  private connected = false;

  subscribe(id: string, callback: TelemetryCallback): void {
    this.subscribers.set(id, callback);
    callback(this.telemetry, this.connected);
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
  }

  getSessionInfo(): SessionInfo {
    return this.sessionInfo;
  }

  getReplayState(nowMs: number = Date.now()): ReturnType<ReplayStateTracker["read"]> {
    return this.replayState.read(nowMs);
  }

  noteReplayLeftForLive(nowMs: number = Date.now()): void {
    this.replayState.noteLeftForLive(nowMs);
  }

  /** One fresh read: the SDK's session info is current, the replay state steps, then every subscriber hears it. */
  deliver(telemetry: TelemetryData, sessionInfo: SessionInfo): void {
    this.sessionInfo = sessionInfo;
    this.telemetry = telemetry;
    this.connected = true;
    this.replayState.step(telemetry, sessionInfo, Date.now());
    this.notify(telemetry);
  }

  /** The sim went away: no session, the replay state back to live, `(null, false)` to everyone. */
  disconnect(): void {
    this.sessionInfo = null;
    this.telemetry = null;
    this.connected = false;
    this.replayState.reset();
    this.notify(null);
  }

  private notify(telemetry: TelemetryData | null): void {
    for (const callback of [...this.subscribers.values()]) {
      callback(telemetry, this.connected);
    }
  }
}

// ── Tapes ──────────────────────────────────────────────────────────────────

type Step =
  | { kind: "tick"; atMs: number; telemetry: TelemetryData; sessionInfo: SessionInfo }
  | { kind: "disconnect"; atMs: number };

type Tape = {
  name: string;
  /** What the tape pins, carried into the golden file's header line for the reviewer. */
  about: string;
  steps: Step[];
};

/** The wall clock the tapes are laid on; a tick's `atMs` is added to it. */
const BASE_MS = Date.UTC(2026, 9, 31, 12, 0, 0);

/** iRacing's tick: the live frame counter advances 60 per second. */
const FRAME_MS = 1000 / 60;
const FRAMES_PER_SECOND = 60;

/** The fields every tick carries, as `translator.test.ts` defaults them, so the other diffs see a car. */
const TICK_DEFAULTS: Partial<TelemetryData> = {
  OnPitRoad: false,
  PlayerCarInPitStall: false,
  IsOnTrack: true,
  PlayerTrackSurface: TrkLoc.OnTrack,
  PlayerTrackSurfaceMaterial: 0,
  PlayerCarMyIncidentCount: 0,
  PlayerIncidents: 0,
  SessionFlags: 0,
  PitSvFlags: 0,
  PitSvTireCompound: 0,
  PlayerTireCompound: 0,
  EngineWarnings: 0,
  Speed: 0,
  CarLeftRight: CarLeftRight.Off,
  DRS_Status: 0,
  P2P_Status: false,
  RPM: 0,
  Lap: 0,
  LapDistPct: 0,
  FuelLevel: 10,
};

// `SessionFlags` values lifted from the 2026-09-17 capture (see `diff/caution.test.ts`).
const RACING = 0x10040000; // Servicible | StartHidden — green-flag running
const CAUTION = 0x10044000; // + Caution
const GREEN = 0x80040004 | 0; // Green | Servicible | StartGo — StartGo is the sign bit

/** Where a synthetic session's frame counter starts, so `replay.sessionStarted` frames read as frames. */
const FRAME_ORIGIN = 10_000;

/**
 * How far the end of the in-session replay's tape trails the live frame when
 * the driver is out of the car: the 2026-09 live-edge snapshots measure 57 to
 * 60 frames (`replay-live-edge-20260929.json`, #1162). A start read from the
 * garage is therefore ~1 s earlier than the one the car reads, which is what
 * leaves only the record's published list, not its latest-start refusal, to
 * stop a second publish after a trip between the two.
 */
const GARAGE_LAG_FRAMES = 58;

/** Where the driver is: in the car, in the garage at the live edge of the replay, or in a seek's false blip. */
type View = "car" | "garage" | "blip";

type Synth = {
  sub: number;
  sessionNum: number;
  uid: number;
  simMode: "full" | "replay";
  sessionState: number;
  flags: number;
  /** `SessionTime`, seconds; advances with the clock. */
  time: number;
  /** Added to the frame `FRAME_ORIGIN + time × 60`; moves when a session clock restarts, so the frame never jumps. */
  frameShift: number;
  completed: number[];
  lastLapTime: number[];
  playerIncidents: number;
  /** `CurDriverIncidentCount` of cars 1 and 2, read from the session info. */
  carIncidents: [number, number];
  view: View;
  /** `ReplayFrameNumEnd` out of the car: frames from the cursor to the end of the tape. */
  toEnd: number;
  /** Whether the tick has session info at all. */
  hasSessionInfo: boolean;
};

const SYNTH_DEFAULTS: Synth = {
  sub: 5000,
  sessionNum: 2,
  uid: 3,
  simMode: "full",
  sessionState: SessionState.Racing,
  flags: RACING,
  time: 600,
  frameShift: 0,
  completed: [4, 4, 4, -1],
  lastLapTime: [90.1, 91.2, 92.3, -1],
  playerIncidents: 0,
  carIncidents: [0, 0],
  view: "car",
  toEnd: 1,
  hasSessionInfo: true,
};

/** Practice, qualifying and the race of one event: three cars, car 0 the player, car 3 the pace car. */
function synthSessionInfo(s: Synth): SessionInfo {
  if (!s.hasSessionInfo) return null;

  return {
    WeekendInfo: { TrackID: 42, SimMode: s.simMode, SubSessionID: s.sub },
    SessionInfo: {
      Sessions: [
        { SessionNum: 0, SessionType: "Practice" },
        { SessionNum: 1, SessionType: "Qualify" },
        { SessionNum: 2, SessionType: "Race" },
      ],
    },
    DriverInfo: {
      DriverCarIdx: 0,
      PaceCarIdx: 3,
      Drivers: [
        { CarIdx: 0, CarNumber: "7", CarNumberRaw: 7, UserID: 100, CurDriverIncidentCount: s.playerIncidents },
        { CarIdx: 1, CarNumber: "42", CarNumberRaw: 42, UserID: 200, CurDriverIncidentCount: s.carIncidents[0] },
        { CarIdx: 2, CarNumber: "042", CarNumberRaw: 3042, UserID: 300, CurDriverIncidentCount: s.carIncidents[1] },
        { CarIdx: 3, CarNumber: "0", CarNumberRaw: 0, UserID: -1, CarIsPaceCar: 1 },
      ],
    },
  };
}

function synthTelemetry(s: Synth): TelemetryData {
  const liveFrame = FRAME_ORIGIN + s.frameShift + Math.round(s.time * FRAMES_PER_SECOND);
  const frames =
    s.view === "garage"
      ? { ReplayFrameNum: liveFrame - GARAGE_LAG_FRAMES - s.toEnd, ReplayFrameNumEnd: s.toEnd }
      : { ReplayFrameNum: 0, ReplayFrameNumEnd: liveFrame };

  return {
    ...TICK_DEFAULTS,
    SessionNum: s.sessionNum,
    SessionUniqueID: s.uid,
    SessionState: s.sessionState,
    SessionFlags: s.flags,
    SessionTime: s.time,
    IsReplayPlaying: s.view === "garage",
    IsOnTrack: s.view === "car",
    ...frames,
    PlayerCarIdx: 0,
    CarIdxLapCompleted: s.completed.slice(),
    CarIdxLastLapTime: s.lastLapTime.slice(),
    PlayerCarMyIncidentCount: s.playerIncidents,
  } as TelemetryData;
}

/** Builds a synthetic tape tick by tick; every tick advances the clock and `SessionTime` by one frame. */
class TapeBuilder {
  private readonly steps: Step[] = [];
  private clockMs = 0;
  private s: Synth;

  constructor(start: Partial<Synth> = {}) {
    this.s = { ...SYNTH_DEFAULTS, ...start };
  }

  tick(change: Partial<Synth> = {}): this {
    this.s = { ...this.s, ...change };
    this.steps.push({
      kind: "tick",
      atMs: this.clockMs,
      telemetry: synthTelemetry(this.s),
      sessionInfo: synthSessionInfo(this.s),
    });
    this.advance(FRAME_MS);

    return this;
  }

  ticks(count: number, change: Partial<Synth> = {}): this {
    this.tick(change);

    for (let i = 1; i < count; i++) this.tick();

    return this;
  }

  /** Time passes with no tick delivered (a disconnect, or a stretch that changes nothing). */
  wait(ms: number): this {
    this.advance(ms);

    return this;
  }

  /** The exit grace runs out: the next tick out of the replay is the first live one. */
  pastExitGrace(): this {
    return this.wait(REPLAY_EXIT_GRACE_MS);
  }

  disconnect(): this {
    this.steps.push({ kind: "disconnect", atMs: this.clockMs });
    this.advance(FRAME_MS);

    return this;
  }

  /** A new session's clock: `SessionTime` restarts at `time` while the frame counter runs on. */
  restartSessionClock(time: number): this {
    this.s.frameShift += Math.round(this.s.time * FRAMES_PER_SECOND) - Math.round(time * FRAMES_PER_SECOND);
    this.s.time = time;

    return this;
  }

  build(name: string, about: string): Tape {
    return { name, about, steps: this.steps };
  }

  private advance(ms: number): void {
    this.clockMs += ms;
    this.s.time += ms / 1000;
  }
}

// ── Synthetic tapes, one per reset path ─────────────────────────────────────

function syntheticTapes(): Tape[] {
  const tapes: Tape[] = [];

  // A — the initial state: the first tick ever seeds silently however far the
  // counters already are, and the session record starts empty.
  tapes.push(
    new TapeBuilder({ sessionState: SessionState.ParadeLaps })
      .tick() // 0: seeds every baseline, the session record's first reading
      .tick() // 1: the second agreeing reading publishes the session
      .tick({ sessionState: SessionState.Racing, flags: GREEN }) // 2: the start
      .tick({ completed: [5, 4, 4, -1] }) // 3: car 0 crosses
      .tick({ lastLapTime: [89.9, 91.2, 92.3, -1] }) // 4: its lap time lands
      .tick({ playerIncidents: 2, carIncidents: [4, 0] }) // 5: incidents, player and car 1
      .build("A: the initial state", "the first tick seeds silently; every recorder then records on the next ones"),
  );

  // B — a disconnect wipes everything: what moved while the sim was away is a
  // seed on the reconnect tick, never an event, and the session is published
  // a second time.
  tapes.push(
    new TapeBuilder({ sessionState: SessionState.ParadeLaps, flags: CAUTION })
      .tick() // 0
      .tick() // 1: session published
      .disconnect() // 2
      .wait(5000)
      .tick({
        sessionState: SessionState.Racing,
        flags: GREEN,
        completed: [5, 4, 4, -1],
        playerIncidents: 3,
        carIncidents: [2, 0],
      }) // 3: re-seeds: no start, no crossing, no incident
      .tick() // 4: the same session is published again — the record was wiped too
      .tick({ completed: [5, 5, 4, -1] }) // 5: car 1 crosses
      .build(
        "B: a disconnect wipes every recorder",
        "the reconnect tick re-seeds laps, greens and incidents; the session record is wiped and publishes the same pair again",
      ),
  );

  // B — the disconnect leaves `lastTickInReplay` alone: a sim lost while the
  // driver sat in the garage and found again with him in the car wipes once
  // more on the first live tick, throwing away its seed.
  tapes.push(
    new TapeBuilder()
      .tick() // 0
      .tick() // 1: session published
      .ticks(2, { view: "garage", completed: [2, 2, 2, -1] }) // 2–3: the guard's entry edge
      .disconnect() // 4
      .wait(3000)
      .tick({ view: "car", completed: [4, 4, 4, -1] }) // 5: seeds, then the exit wipe drops the seed
      .tick({ completed: [5, 4, 4, -1], playerIncidents: 1 }) // 6: re-seeds: nothing; the session again
      .tick({ completed: [5, 5, 4, -1], playerIncidents: 2 }) // 7: car 1 crosses, the player's incident
      .build(
        "B: a reconnect after a disconnect in the garage",
        "lastTickInReplay outlives the disconnect, so the first live tick after it seeds and is wiped: a change on the second tick is lost",
      ),
  );

  // C — a SubSessionID change alone (SessionNum and SessionUniqueID stay):
  // only `resetPerSessionState` re-seeds the recorders, since their own
  // (SessionNum, SessionUniqueID) check sees no change.
  tapes.push(
    new TapeBuilder({ flags: CAUTION })
      .tick() // 0
      .tick() // 1: session (5000, 2, 3) published
      .tick({ sub: 6000, flags: GREEN, completed: [5, 4, 4, -1], playerIncidents: 1, carIncidents: [1, 0] }) // 2
      .tick() // 3: session (6000, 2, 3) published
      .tick({ completed: [5, 5, 4, -1], playerIncidents: 3 }) // 4: car 1 crosses, the player's incident
      .build(
        "C: a subsession change re-seeds the recorders",
        "the reset before the recorders swallows the crossing, the restart and the incidents on the tick SubSessionID changes",
      ),
  );

  // C — the session record survives a session change: its latest start
  // refuses a new pair read against the old session's clock.
  tapes.push(
    new TapeBuilder({ sessionNum: 1, uid: 2 })
      .tick() // 0
      .tick() // 1: session (5000, 1, 2) published
      .ticks(3, { sessionNum: 2, uid: 3 }) // 2–4: the new pair on the old clock: refused
      .restartSessionClock(0.5)
      .tick() // 5: the new clock's first reading
      .tick() // 6: session (5000, 2, 3) published, from its own start
      .build(
        "C: the session record survives a SessionNum change",
        "the latest start kept across the reset refuses the new session's first readings, taken on the old clock",
      ),
  );

  // C — the published list survives a session change: a pair already
  // published is never published again, even read with a later start.
  tapes.push(
    new TapeBuilder()
      .tick() // 0
      .tick() // 1: session (5000, 2, 3) published
      .ticks(2, { sub: 5001 }) // 2–3: session (5001, 2, 3) published
      .ticks(3, { sub: 5000, frameShift: 100 }) // 4–6: (5000, 2, 3) again, 100 frames later: nothing
      .build(
        "C: the published list survives a subsession round trip",
        "a pair published before two subsession resets is not published again when it comes back",
      ),
  );

  // C — on a garage tick: the reset runs on replay ticks too (not in a saved
  // replay), and the record follows the new pair from the garage.
  tapes.push(
    new TapeBuilder({ sessionNum: 1, uid: 2, view: "garage" })
      .tick() // 0
      .tick() // 1: session (5000, 1, 2) published from the garage
      .restartSessionClock(2)
      .ticks(2, { sessionNum: 2, uid: 3, sessionState: SessionState.GetInCar }) // 2–3: (5000, 2, 3) published
      .ticks(2, { view: "car" }) // 4–5: in the car, inside the exit grace
      .pastExitGrace()
      .ticks(3) // 6–8: live: nothing published again
      .build(
        "C: a session change in the garage",
        "the per-session reset on a replay tick keeps the record; the new pair is published from the garage once",
      ),
  );

  // D — the entry edge: the tick that opens the replay is not recorded (the
  // recorders' own gate), and the record keeps its published pair through
  // the wipe that follows the recorders on that tick.
  tapes.push(
    new TapeBuilder()
      .tick() // 0
      .tick() // 1: session published (in the car)
      .tick({ view: "garage", completed: [5, 4, 4, -1], playerIncidents: 1 }) // 2: entry edge: nothing
      .ticks(4) // 3–6: the garage at the live edge: refused, the pair is published
      .ticks(2, { view: "car" }) // 7–8: inside the exit grace
      .pastExitGrace()
      .tick() // 9: live: seeds, then the exit wipe
      .tick() // 10: re-seeds
      .tick({ completed: [5, 5, 4, -1] }) // 11: car 1 crosses
      .build(
        "D: entering the replay",
        "the entry tick records nothing, and the session record's published pair outlives the entry wipe",
      ),
  );

  // D and E — the session record across trips between the garage and the
  // car: first seen from the garage, then read ~1 s later from the car, where
  // only the published list stops a second publish.
  tapes.push(
    new TapeBuilder({ view: "garage", sessionState: SessionState.GetInCar })
      .tick() // 0
      .tick() // 1: session published from the garage (start 58 frames early)
      .ticks(3, { view: "car" }) // 2–4: inside the exit grace
      .pastExitGrace()
      .ticks(4) // 5–8: live, the car's later start: nothing
      .ticks(4, { view: "garage" }) // 9–12: entry edge and the garage: nothing
      .ticks(2, { view: "car" }) // 13–14
      .pastExitGrace()
      .ticks(4) // 15–18: live again: nothing
      .build(
        "D and E: the session record across garage trips",
        "a pair published from the garage is published once, through both replay wipes and the car's later start",
      ),
  );

  // E — the exit edge: the first live tick's seed is wiped after the
  // recorders ran, so a crossing, a restart or an incident between the first
  // and the second live tick is never recorded.
  tapes.push(
    new TapeBuilder()
      .tick() // 0
      .tick() // 1: session published
      .ticks(3, { view: "garage", completed: [2, 2, 2, -1], flags: RACING }) // 2–4: the cursor's counters
      .ticks(2, { view: "car", completed: [5, 5, 5, -1], flags: CAUTION }) // 5–6: inside the exit grace
      .pastExitGrace()
      .tick() // 7: the first live tick: seeds, then the exit wipe
      .tick({ completed: [6, 5, 5, -1], flags: GREEN, playerIncidents: 2, carIncidents: [3, 0] }) // 8: lost
      .tick({ completed: [6, 6, 5, -1], playerIncidents: 4, carIncidents: [5, 0] }) // 9: recorded
      .build(
        "E: leaving the replay",
        "the exit wipe follows the recorders on the first live tick, so the second live tick only re-seeds",
      ),
  );

  // The exit grace (#1324): a seek's ~300 ms false blip is not a trip to the
  // car, so the counters it shows are neither a seed nor a crossing.
  tapes.push(
    new TapeBuilder({ view: "garage" })
      .tick() // 0
      .tick() // 1: session published from the garage
      .ticks(18, { view: "blip", completed: [5, 4, 4, -1] }) // 2–19: the blip, 300 ms
      .tick({ completed: [6, 4, 4, -1] }) // 20: still inside the grace
      .ticks(2, { view: "garage", completed: [3, 3, 3, -1] }) // 21–22: the replay again
      .build("a seek's blip in the garage", "the debounced replay state holds through the blip: nothing is recorded"),
  );

  // A saved replay (`SimMode` `replay`): never recorded, not even at the
  // tape's end, and a tick without session info changes nothing.
  tapes.push(
    new TapeBuilder({ view: "garage", simMode: "replay" })
      .tick() // 0
      .tick() // 1
      .tick({ completed: [5, 4, 4, -1], playerIncidents: 1 }) // 2
      .tick({ hasSessionInfo: false }) // 3: no session info: the controller keeps the saved-replay answer
      .ticks(2, { hasSessionInfo: true, completed: [5, 5, 4, -1] }) // 4–5
      .build("a saved replay", "a saved replay records nothing, its live-edge ticks included"),
  );

  return tapes;
}

// ── Recorded fixtures, adapted into ticks ───────────────────────────────────

type FixtureRecord = { t: number } & Record<string, unknown>;

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./diff/__fixtures__/${name}`, import.meta.url), "utf-8")) as T;
}

/**
 * The captures record a tick only on a change; the sim keeps ticking in
 * between with the same values. Each record is held until the next one, a
 * tick every quarter second, and the last one for two seconds more.
 */
const HOLD_S = 0.25;
const TAIL_S = 2;

/** What a captured record lacks and every tick needs for the recorders to read anything. */
type FixtureSession = { sessionNum: number; uid: number; sessionInfo: SessionInfo };

/**
 * One capture as a tape. A record's own fields are kept as captured; what no
 * capture carries is made up the one way the other fixture tests make it:
 * `SessionTime` is the capture time, the frame is the live counter at 60 per
 * second from it (`ReplayFrameNumEnd` in the car; out of it, the cursor at the
 * live edge, `ReplayFrameNumEnd` 1, on a tape that trails the live frame by
 * `GARAGE_LAG_FRAMES`), and the session identity is fixed.
 */
function captureTape(
  name: string,
  about: string,
  records: readonly FixtureRecord[],
  session: FixtureSession,
  transform: (record: FixtureRecord) => Record<string, unknown> = (record) => record,
): Tape {
  const steps: Step[] = [];

  records.forEach((record, i) => {
    const until = records[i + 1]?.t ?? record.t + TAIL_S;
    const { t: _t, ...fields } = transform(record);

    for (let k = 0; record.t + k * HOLD_S < until - 1e-9; k++) {
      const time = record.t + k * HOLD_S;
      const frame = FRAME_ORIGIN + Math.round(time * FRAMES_PER_SECOND);
      const inReplayView = fields.IsReplayPlaying === true;

      steps.push({
        kind: "tick",
        atMs: time * 1000,
        sessionInfo: session.sessionInfo,
        telemetry: {
          ...TICK_DEFAULTS,
          ...fields,
          SessionNum: session.sessionNum,
          SessionUniqueID: session.uid,
          SessionTime: time,
          IsReplayPlaying: inReplayView,
          ...(inReplayView
            ? { ReplayFrameNum: frame - GARAGE_LAG_FRAMES - 1, ReplayFrameNumEnd: 1 }
            : { ReplayFrameNum: 0, ReplayFrameNumEnd: frame }),
        } as TelemetryData,
      });
    }
  });

  return { name, about, steps };
}

/** The trimmed captures' roster: 20 cars at their own indices, the pace car (raw index 64) at slot 20. */
function trimmedRoster(sessionType: string): SessionInfo {
  const drivers: Array<Record<string, unknown>> = [];

  for (let carIdx = 0; carIdx < 20; carIdx++) {
    drivers.push({ CarIdx: carIdx, CarNumberRaw: carIdx + 1, UserID: 1000 + carIdx });
  }

  drivers.push({ CarIdx: 20, CarNumberRaw: 0, UserID: -1, CarIsPaceCar: 1 });

  return {
    SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: sessionType }] },
    WeekendInfo: { TrackID: 42, SimMode: "full", SubSessionID: 0 },
    DriverInfo: { DriverCarIdx: 0, PaceCarIdx: 20, Drivers: drivers },
  };
}

/** `irsdk_padCarNum`: a number written with leading zeros is its digit count × 1000 plus its value. */
function carNumberRaw(carNumber: string): number {
  const value = Number.parseInt(carNumber, 10);

  return carNumber.length > 1 && carNumber.startsWith("0") ? carNumber.length * 1000 + value : value;
}

/** Slot 20 of a trimmed per-car array back at the pace car's real index, 64; the slots between read as empty. */
function widenPaceSlot(values: readonly number[], empty: number): number[] {
  const widened = Array<number>(65).fill(empty);

  for (let carIdx = 0; carIdx < 20; carIdx++) widened[carIdx] = values[carIdx]!;

  widened[64] = values[20]!;

  return widened;
}

function fixtureTapes(): Tape[] {
  const tapes: Tape[] = [];

  tapes.push(
    captureTape(
      "fixture: replay-laps-crossings-20260917",
      "three crossings of the field and the pace car's one, which is skipped",
      loadFixture<FixtureRecord[]>("replay-laps-crossings-20260917.json"),
      { sessionNum: 0, uid: 1, sessionInfo: trimmedRoster("Race") },
    ),
  );

  tapes.push(
    captureTape(
      "fixture: replay-greens-standing-20260918",
      "a standing start: Warmup straight to Racing",
      loadFixture<FixtureRecord[]>("replay-greens-standing-20260918.json"),
      {
        sessionNum: 0,
        uid: 1,
        sessionInfo: {
          WeekendInfo: { SimMode: "full", SubSessionID: 0 },
          SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
        },
      },
    ),
  );

  tapes.push(
    captureTape(
      "fixture: caution-restart-20260917",
      "an oval race under green with two cautions and two restarts, every crossing of the field",
      loadFixture<FixtureRecord[]>("caution-restart-20260917.json"),
      { sessionNum: 0, uid: 1, sessionInfo: trimmedRoster("Race") },
    ),
  );

  tapes.push(
    captureTape(
      "fixture: caution-road-20260918",
      "a road race with two cautions and one restart, every crossing of the field",
      loadFixture<FixtureRecord[]>("caution-road-20260918.json"),
      { sessionNum: 0, uid: 1, sessionInfo: trimmedRoster("Race") },
    ),
  );

  // The one capture with its own session YAML: the roster's `CarNumber` gives
  // `CarNumberRaw` by the SDK's padding rule, and the pace car keeps its real
  // index, 64, so the per-car arrays are widened back to it.
  const formation = loadFixture<{ sessionInfo: Record<string, unknown>; ticks: FixtureRecord[] }>(
    "rolling-start-formation-20260917.json",
  );
  const formationInfo = structuredClone(formation.sessionInfo);
  const formationDrivers = (formationInfo.DriverInfo as { Drivers: Array<Record<string, unknown>> }).Drivers;

  for (const driver of formationDrivers) driver.CarNumberRaw = carNumberRaw(driver.CarNumber as string);

  formationInfo.WeekendInfo = { ...(formationInfo.WeekendInfo as Record<string, unknown>), SimMode: "full" };
  tapes.push(
    captureTape(
      "fixture: rolling-start-formation-20260917",
      "a rolling start: the formation, the green and the field's first crossing",
      formation.ticks,
      { sessionNum: 0, uid: 1, sessionInfo: formationInfo },
      (record) => {
        const widened: Record<string, unknown> = { ...record };

        for (const [key, value] of Object.entries(record)) {
          if (key.startsWith("CarIdx") && Array.isArray(value)) {
            widened[key] = widenPaceSlot(value as number[], key === "CarIdxPosition" ? 0 : -1);
          }
        }

        return widened;
      },
    ),
  );

  // The two 2026-10-11 captures carry the driver's trips between the garage
  // (`IsReplayPlaying` true, out of the car) and the car — the replay guard's
  // real edges — though nothing else a recorder reads; their session's start
  // is the record they exercise.
  const playerOnly = (sessionType: string): SessionInfo => ({
    SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: sessionType }] },
    WeekendInfo: { TrackID: 42, SimMode: "full", SubSessionID: 0 },
    DriverInfo: { DriverCarIdx: 0, Drivers: [{ CarIdx: 0, CarNumberRaw: 7, UserID: 100 }] },
  });

  tapes.push(
    captureTape(
      "fixture: tire-temps-stops-20261011",
      "a test session that starts in the garage and returns to it: the session's start, published once",
      loadFixture<FixtureRecord[]>("tire-temps-stops-20261011.json"),
      { sessionNum: 0, uid: 1, sessionInfo: playerOnly("Testing") },
    ),
  );

  tapes.push(
    captureTape(
      "fixture: tire-temps-tow-20261011",
      "a race from the garage to a tow: the session's start, published once",
      loadFixture<FixtureRecord[]>("tire-temps-tow-20261011.json"),
      { sessionNum: 0, uid: 1, sessionInfo: playerOnly("Race") },
    ),
  );

  // Four single snapshots out of the car in a live session's replay, three
  // scrubbed back and one at the live edge. Each is delivered as recorded and
  // then one frame on, as the replay plays it (`ReplayPlaySpeed` 1: the cursor
  // advances; 0: the tape's end does), so the edge one gets the second
  // agreeing reading the record needs.
  type Snapshot = { sessionInfo: Record<string, unknown>; telemetry: Record<string, number | boolean> };
  const snapshots = loadFixture<Snapshot[]>("replay-live-edge-20260929.json");
  const snapshotSteps: Step[] = [];

  snapshots.forEach((snapshot, i) => {
    const recorded = snapshot.telemetry;
    const playing = recorded.ReplayPlaySpeed !== 0;
    const next = {
      ...recorded,
      SessionTime: (recorded.SessionTime as number) + 1 / FRAMES_PER_SECOND,
      ReplayFrameNum: (recorded.ReplayFrameNum as number) + (playing ? 1 : 0),
      ReplayFrameNumEnd: (recorded.ReplayFrameNumEnd as number) + (playing ? 0 : 1),
    };

    for (const [k, telemetry] of [recorded, next].entries()) {
      snapshotSteps.push({
        kind: "tick",
        atMs: i * 10_000 + k * FRAME_MS,
        sessionInfo: snapshot.sessionInfo,
        telemetry: { ...TICK_DEFAULTS, ...telemetry } as TelemetryData,
      });
    }
  });
  tapes.push({
    name: "fixture: replay-live-edge-20260929",
    about: "out-of-car snapshots: only the one at the live edge is read, and publishes its session's start",
    steps: snapshotSteps,
  });

  return tapes;
}

// ── Running a tape ─────────────────────────────────────────────────────────

const REPLAY_EVENTS = [
  "replay.lapStarted",
  "replay.lapTimed",
  "replay.greenFlag",
  "replay.sessionStarted",
  "replay.incident",
] as const satisfies readonly SimEventName[];

type RecordedEvent = { tape: string; step: number; event: string; data: unknown };
type TapeHeader = { tape: string; steps: number; about: string };

function recordReplayEvents(bus: IEventBus, tape: string, currentStep: () => number): RecordedEvent[] {
  const events: RecordedEvent[] = [];

  for (const name of REPLAY_EVENTS) {
    bus.subscribe(name, (ev) => {
      events.push({ tape, step: currentStep(), event: ev.event, data: structuredClone(ev.data) });
    });
  }

  return events;
}

function runTape(tape: Tape): RecordedEvent[] {
  let step = -1;
  const bus = getEventBus();
  const events = recordReplayEvents(bus, tape.name, () => step);
  const controller = new FakeSdkController();

  vi.setSystemTime(BASE_MS);
  initializeSimEventsIracing(bus, controller as unknown as SDKController, silentLogger);

  tape.steps.forEach((s, i) => {
    step = i;
    vi.setSystemTime(BASE_MS + Math.round(s.atMs));

    if (s.kind === "tick") controller.deliver(s.telemetry, s.sessionInfo);
    else controller.disconnect();
  });

  return events;
}

// ── The golden file ────────────────────────────────────────────────────────

const GOLDEN_URL = new URL("./__golden__/replay-recorder-equivalence.jsonl", import.meta.url);
const UPDATE_GOLDEN = process.env.REPLAY_GOLDEN_UPDATE === "1";

type Golden = Map<string, { header: TapeHeader; events: RecordedEvent[] }>;

function readGolden(): Golden {
  const golden: Golden = new Map();

  if (UPDATE_GOLDEN && !existsSync(GOLDEN_URL)) return golden;

  for (const line of readFileSync(GOLDEN_URL, "utf-8").split("\n")) {
    if (line.trim() === "") continue;

    const entry = JSON.parse(line) as TapeHeader | RecordedEvent;

    if ("event" in entry) golden.get(entry.tape)!.events.push(entry);
    else golden.set(entry.tape, { header: entry, events: [] });
  }

  return golden;
}

function writeGolden(results: ReadonlyArray<{ tape: Tape; events: RecordedEvent[] }>): void {
  const lines: string[] = [];

  for (const { tape, events } of results) {
    const header: TapeHeader = { tape: tape.name, steps: tape.steps.length, about: tape.about };

    lines.push(JSON.stringify(header));

    for (const event of events) lines.push(JSON.stringify(event));
  }

  writeFileSync(fileURLToPath(GOLDEN_URL), `${lines.join("\n")}\n`, "utf-8");
}

// ── The tests ──────────────────────────────────────────────────────────────

const TAPES: Tape[] = [...fixtureTapes(), ...syntheticTapes()];

describe("the replay recorders' event stream (issue #1468)", () => {
  const golden = readGolden();
  const results: Array<{ tape: Tape; events: RecordedEvent[] }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    initializeEventBus(silentLogger);
  });

  afterEach(() => {
    _resetSimEventsIracing();
    _resetEventBus();
    vi.useRealTimers();
  });

  afterAll(() => {
    if (!UPDATE_GOLDEN) return;

    // A run that left a tape out — a `-t` filter, or a tape that threw — would
    // replace the committed golden with a subset, so it writes nothing.
    const ran = new Set(results.map(({ tape }) => tape.name));
    const missing = TAPES.filter((tape) => !ran.has(tape.name)).map((tape) => tape.name);

    if (missing.length > 0) {
      throw new Error(
        `REPLAY_GOLDEN_UPDATE: golden not written, ${missing.length} tape(s) did not run: ${missing.join(", ")}`,
      );
    }

    writeGolden(results);
  });

  it("has one golden entry per tape, and no other", () => {
    expect(new Set(TAPES.map((tape) => tape.name)).size).toBe(TAPES.length);

    if (UPDATE_GOLDEN) return;

    expect([...golden.keys()]).toEqual(TAPES.map((tape) => tape.name));
  });

  for (const tape of TAPES) {
    it(`replays "${tape.name}" to the golden events`, () => {
      const events = runTape(tape);

      results.push({ tape, events });

      if (UPDATE_GOLDEN) return;

      const expected = golden.get(tape.name);

      expect(expected, `no golden entry for "${tape.name}"`).toBeDefined();
      expect(tape.steps.length).toBe(expected!.header.steps);
      expect(events).toEqual(expected!.events);
    });
  }
});
