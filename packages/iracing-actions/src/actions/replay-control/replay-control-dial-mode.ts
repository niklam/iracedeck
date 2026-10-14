/**
 * Replay Control dial — the seam between the dial surface and its rotation
 * modes (#1316). The surface (`replay-control-dial-surface.ts`) owns the
 * per-context state, the in-replay guard, the press gestures, the hold preview
 * and every push to the dial's screen; a mode owns only what a turn does and
 * what the box reads while that mode is selected. A new mode is one module
 * exporting a {@link ReplayDialMode} plus one row in the surface's registry.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import type { DialSideMarks } from "../../shared/dial-box.js";
import type { ReplayPosition } from "../../shared/replay-position-state.js";
import type { ReplayControlDialSettings } from "./replay-control-dial-settings.js";

/**
 * A replay speed in the shape `setPlaySpeed(speed, slowMotion)` takes and
 * `replaySpeedFromTelemetry` returns: in slow motion `speed` is the signed
 * divisor (−¼x is `{ speed: -4, slowMotion: true }`), and paused is
 * `{ speed: 0, slowMotion: false }`.
 */
export interface ReplaySpeed {
  speed: number;
  slowMotion: boolean;
}

/**
 * What the surface hands a mode. Every command goes out through these helpers,
 * which press it through the replay command gate (`shared/replay-command-gate.ts`,
 * #1430): the gate takes the replay cursor from an in-flight replay jump, and
 * decides whether the command goes out now, waits for a jump or a search
 * under way to land, or is not sent at all — a mode never calls
 * `getCommands()` itself. The surface calls a mode only while a replay is on
 * screen.
 *
 * A mode that moves the replay by frames uses {@link position}, {@link step}
 * and {@link jumpTo}: the three share the plugin's one pending target
 * (`shared/replay-position-state.ts`), which is what keeps a move from being
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

/** What the dash box reads in a mode, under the mode's label. All of it goes into the displayed signature. */
export interface ReplayDialModeView {
  /** The value slot. */
  value: string;
  /** The small line along the bottom; empty for none. */
  caption: string;
  /** Lit where a turn that way would do something. */
  sides: DialSideMarks;
}

/**
 * One rotation mode of the Replay Control dial. It holds no state of its own:
 * what it reads comes from `dial`, `io` and the replay speed state every dial
 * shares (`replay-speed-state.ts`).
 */
export interface ReplayDialMode {
  /** The box's label, e.g. `SPEED`: shown in a replay and, dimmed, outside one. */
  readonly label: string;
  /** What a turn does, for the Stream Deck app's dial hint (the Rotate trigger description). */
  readonly rotateDescription: string;
  /**
   * A turn of `ticks` detents (never 0; positive is clockwise). Scales by
   * `ticks` and sends at most one command per event unless the mode documents
   * otherwise.
   */
  rotate(ticks: number, dial: ReplayControlDialSettings, io: ReplayDialModeIo): void;
  /** What the box shows now. Pure: called on every tick and compared, so it sends nothing. */
  view(dial: ReplayControlDialSettings, io: ReplayDialModeIo): ReplayDialModeView;
}
