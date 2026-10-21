/**
 * Replay Control dial — the seam between the dial surface and its rotation
 * modes (#1316). The surface (`replay-control-dial-surface.ts`) owns the
 * per-context state, the in-replay guard, the press gestures, the hold preview
 * and every push to the dial's screen; a mode owns only what a turn does and
 * what the box reads while that mode is selected. A new mode is one module
 * exporting a {@link ReplayDialMode} plus one row in the surface's registry.
 *
 * #801 added Lap, Session, Incident and Track Order, and with them what a mode that
 * moves the replay by the record, by iRacing's search or by a key binding
 * needs from the surface: a waited record jump, the record step, the paced
 * search, a binding tap and the jump wait a camera tap sits behind. Design:
 * `docs/superpowers/specs/2026-10-12-issue-801-replay-control-dial-stepping.md`
 * ("The seam").
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import {
  type RecordStepResult,
  type RecordStepSource,
  type RecordStepSpec,
  type ReplayPosition,
  type ReplaySearchTarget,
  type ReplaySettledOutcome,
  type ReplaySpeed,
} from "@iracedeck/replay-engine";

import type { DialNeighbours, DialSideMarks } from "../../shared/dial-box.js";
import type { ReplayControlDialSettings } from "./replay-control-dial-settings.js";

/**
 * A replay speed in the shape `setPlaySpeed(speed, slowMotion)` takes: the
 * engine's type, re-exported here (#1467).
 */
export type { ReplaySpeed };

/**
 * What the surface hands a mode. Every command goes out through these helpers,
 * which press it through the replay command gate (`replay-engine`'s `replay-command-gate.ts`,
 * #1430): the gate takes the replay cursor from an in-flight replay jump, and
 * decides whether the command goes out now, waits for a jump or a search
 * under way to land, or is not sent at all — a mode never calls
 * `getCommands()` itself. The surface calls a mode only while a replay is on
 * screen.
 *
 * A mode that moves the replay by frames uses {@link position}, {@link step}
 * and {@link jumpTo}: the three share the plugin's one pending target
 * (`replay-engine`'s `replay-position-state.ts`), which is what keeps a move from being
 * measured from a frame the replay has already left, and a frame step from
 * being sent into a jump still under way.
 */
export interface ReplayDialModeIo {
  readonly logger: ILogger;
  /** The replay speed now: the latest telemetry, overlaid by a speed this plugin just sent that telemetry has not caught up with. */
  liveSpeed(): ReplaySpeed;
  /** The latest raw telemetry tick, for a field the surface does not model. */
  telemetry(): TelemetryData | null;
  /**
   * Presses one speed through the gate and records it as the live speed; a
   * non-zero target is also remembered as the resume speed. A speed asked for
   * while a jump or a search is under way waits in the gate's slot and goes
   * out when it has landed (true is returned at once): sent into a jump under
   * way, it would end the jump somewhere else and play from there. While it
   * waits it is what {@link liveSpeed} reads. A speed of 0 is a {@link pause}.
   */
  setSpeed(owner: string, target: ReplaySpeed): boolean;
  /**
   * Presses a pause through the gate. The speed that was playing stays the
   * remembered resume speed, so Press resumes it. While a jump is under way
   * nothing is sent and true is returned: the replay is paused for the jump
   * already, and a pause sent alone into a jump under way would end it
   * somewhere else. A mode therefore pauses before it moves, never after.
   */
  pause(owner: string): boolean;
  /**
   * Where the replay stands or is headed: the frame to measure a move from.
   * Null when nothing says — no target pending and a reading that is not the
   * replay's — and the move is then skipped, never guessed.
   */
  position(): ReplayPosition | null;
  /**
   * Sends one frame step (`1` the next frame, `-1` the previous) and records
   * where it lands. Refused, with nothing sent, unless the position is known
   * and nothing is under way ({@link ReplayPosition.seeking}): iRacing applies
   * one step per update, and a step sent into a jump ends it somewhere else.
   * A step sent while the reading still shows the replay playing records no
   * target: where it lands depends on where the pause catches the replay.
   */
  step(owner: string, direction: 1 | -1): boolean;
  /**
   * Sends the replay to an absolute frame and records it as the pending
   * target. Safe while a step or an earlier jump of any surface is under way:
   * iRacing lands on the newest target.
   */
  jumpTo(owner: string, frame: number): boolean;
}

/**
 * What the surface hands a mode that steps through the record, iRacing's
 * searches or a key binding (#801): {@link ReplayDialModeIo} and what Lap,
 * Session, Incident and Track Order need beside it. Kept apart so a mode that moves
 * the replay by speed or by frames is handed, and tested against, only what
 * it uses. The members that carry the turning dial's origin token
 * ({@link recordJump}, {@link queueSearch}) have it bound by the surface, so
 * a mode never handles the token: the surface hands each dial an `io` of its
 * own.
 */
export interface ReplayDialStepIo extends ReplayDialModeIo {
  /**
   * One waited jump to `frame` through the shared jump sequence
   * (`replay-engine`'s `replay-jump-playback.ts`, #1276), carrying the turning dial's
   * origin token: the replay cursor is claimed and the frame recorded as the
   * pending target at the call, before the pause a moving replay is sent, so
   * a turn made while it runs steps on from where it is headed and its own
   * jump takes the cursor over. Ends as the Replay jump playback setting
   * says. Resolves once the jump has ended, however it ended; a cancellation
   * or a timeout is logged, never thrown. Unlike {@link jumpTo}, a one-shot
   * that waits for nothing.
   */
  recordJump(owner: string, frame: number): Promise<void>;
  /**
   * The record step (#1426's `findRecordStep`) of `steps` entries from where
   * the replay is headed, else the cursor (`resolveReplayWalkStart`). A miss
   * names why, "no cursor" included; nothing is sent.
   */
  recordStep(step: RecordStepSpec, steps: number): RecordStepResult;
  /**
   * What a record lookup reads — the store, the camera car, the session info —
   * from this entry's reading, for a view, which reads the record in memory
   * and waits for nothing.
   */
  recordSource(): RecordStepSource;
  /** The session info the SDK holds, or null. */
  sessionInfo(): unknown;
  /**
   * Adds a turn of `ticks` detents to the paced search
   * (`replay-search-queue.ts`) under `owner`, carrying the turning dial's
   * origin token; the runner works in the background.
   */
  queueSearch(owner: string, target: ReplaySearchTarget, ticks: number): void;
  /** Whether the paced search is working for `target`: a Lap or Session turn then adds to its count. */
  isSearchRunning(target: ReplaySearchTarget): boolean;
  /** What the paced search has left for `target` (signed), or null when no run is for it. */
  pendingSearch(target: ReplaySearchTarget): number | null;
  /** Taps one of the action's key bindings by its global setting key; resolves to whether it went out. */
  tapBinding(settingKey: string): Promise<boolean>;
  /** Whether any of the given global binding keys is unset (#612). */
  isBindingMissing(keys: string | readonly string[]): boolean;
  /**
   * Switches the camera to the player's car: the keypad's Jump to My Car
   * switch, with no cursor taken, since the engine's camera-switch waiter the
   * dial's gesture goes through has cancelled only the two walks (#1467). With
   * no player's car, or no number for it, it logs why and sends nothing.
   */
  jumpToMyCar(): void;
  /** Whether a position jump is under way: a pending target standing, or a seek showing. A search is not one. */
  isJumpUnderWay(): boolean;
  /**
   * Waits until no jump has been under way on three reads 50 ms apart, with
   * no claim and bounded by the longest any jump waits
   * (`REPLAY_JUMP_MAX_WAIT_MS`): a jump that starts meanwhile is waited for
   * too. Takes no cursor and sends nothing.
   */
  waitForJumpsToSettle(): Promise<ReplaySettledOutcome>;
  /** Whether the dial this `io` was handed for is still on screen, with a replay to act on. */
  isStillOnScreen(): boolean;
  /**
   * Whether the loaded session is a saved replay (`WeekendInfo.SimMode`
   * "replay", the controller's sticky answer, #604): there the per-car
   * telemetry arrays are the replay's own wherever the cursor is.
   */
  isSavedReplay(): boolean;
}

/** What the dash box reads in a mode, under the mode's label. All of it goes into the displayed signature. */
export interface ReplayDialModeView {
  /**
   * The value slot. Null when this reading cannot say — a tick read mid-seek,
   * which shows frame 0 and replay time 0 — and the box keeps the value it
   * last drew for the dial (#801).
   */
  value: string | null;
  /**
   * The small line along the bottom; empty for none. Null when this reading
   * cannot say — a tick read mid-seek — and the box keeps the caption it last
   * drew for the dial, as it keeps a null value (#801).
   */
  caption: string | null;
  /**
   * Lay the value out as if a caption were shown, whether or not one is (the
   * box's `reserveCaptionLine`): for a mode whose caption comes and goes, so
   * the value keeps its size and place when it does (#801).
   */
  reserveCaption?: boolean;
  /**
   * Short texts the box draws dimmed beside the value (#801: Track Order's
   * cars on track behind and ahead). They belong to the value: when the value
   * is null they keep what the box last drew, as the side marks do.
   */
  neighbours?: DialNeighbours | null;
  /** Lit where a turn that way would do something. */
  sides: DialSideMarks;
  /** Whether a key binding the mode taps is unset: the box draws the missing-binding warning (#612). */
  bindingMissing?: boolean;
}

/**
 * One rotation mode of the Replay Control dial. It holds no state of its own:
 * what it reads comes from `dial`, `io` and the replay speed state every dial
 * shares (`replay-speed-state.ts`) — save Track Order's one tap waiting behind a jump,
 * which is one for the whole plugin (#801). `Io` is what the mode is handed:
 * {@link ReplayDialStepIo} for the modes that need it.
 */
export interface ReplayDialMode<Io extends ReplayDialModeIo = ReplayDialModeIo> {
  /** The box's label, e.g. `SPEED`: shown in a replay and, dimmed, outside one. */
  readonly label: string;
  /** What a turn does, for the Stream Deck app's dial hint (the Rotate trigger description). */
  readonly rotateDescription: string;
  /**
   * A turn of `ticks` detents (never 0; positive is clockwise). Scales by
   * `ticks` and sends at most one command per event unless the mode documents
   * otherwise. A turn that waits for something may return a promise: the
   * surface logs a rejection and redraws once it settles, and a further turn
   * meanwhile is the mode's to take (#801).
   */
  rotate(ticks: number, dial: ReplayControlDialSettings, io: Io): void | Promise<void>;
  /** What the box shows now. Pure: called on every tick and compared, so it sends nothing. */
  view(dial: ReplayControlDialSettings, io: Io): ReplayDialModeView;
}
