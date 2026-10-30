/**
 * Replay Control — dial surface (issue #1316). Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 *
 * Rotating runs the dial's rotation mode (`dial.mode`, one module per mode
 * behind `replay-control-dial-mode.ts`): Speed Control walks the replay speed
 * along a ladder the user shapes, Frame Jog (#1317) steps the replay one
 * frame per detent, Lap, Session, Incident and Track Order (#801) step
 * through the replay record, iRacing's own searches and its Next / Previous
 * Car binding, and Car # and Position (#1448) switch the camera along the
 * field by car number and by race order. The press gestures are shared by every mode — Play/Pause, Set
 * 1x and play, Reverse direction, Jump to Live, Jump to Race Start, Jump to My
 * Car — so changing the Mode never changes what a specific pick does; the one
 * exception is the Mode default, Long Press's default, which runs Jump to My
 * Car in Track Order, Car # and Position and Set 1x and play elsewhere (#801,
 * #1448). The dial's screen
 * is the shared dash box, drawn from what the mode says it shows.
 *
 * Every command is a one-shot pressed through the replay command gate
 * (`replay-engine`'s `replay-command-gate.ts`, #1430), which takes the replay cursor from
 * an in-flight replay jump and sends the command, holds it until a jump or a
 * search under way has landed, or drops it; outside a replay nothing is sent:
 * iRacing ignores replay commands from the car.
 *
 * The surface holds the per-dial-context state; the owning ReplayControl
 * action routes `IDeck*` dial events here and is read through
 * {@link ReplayControlDialHost}.
 */
import {
  createHoldPreview,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type HoldPreview,
  IconUpdateThrottle,
  type IDeckActionContext,
  NOOP_HOLD_PREVIEW,
  type PressShape,
  svgToDataUri,
} from "@iracedeck/deck-core";
import { replaySpeedFromTelemetry, type ReplayState, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import {
  beginReplayJump,
  currentReplayCursorOwner,
  describeReplayJump,
  DIAL_SPEED_HOLD_MS,
  findRecordStep,
  formatPlayCaption,
  formatSpeedDisplay,
  getReplayGateRecord,
  isReplayMoveUnderWay,
  isReplaySearchRunning,
  isSeeking,
  keepDialPendingSpeed,
  onReplaySearchChange,
  onReplaySpeedChanged,
  pendingReplaySearch,
  pressReplayCommand,
  queueReplaySearch,
  readReplayPosition,
  type RecordStepResult,
  type RecordStepSource,
  type RecordStepSpec,
  rememberedSpeed,
  REPLAY_JUMP_MAX_WAIT_MS,
  REPLAY_TARGET_GIVE_UP_MS,
  type ReplayGateCommand,
  type ReplayPressResult,
  resolveReplayWalkStart,
  reverseRememberedSpeed,
  runReplayJump,
  shownReplaySpeed,
  waitForReplaySettled,
} from "@iracedeck/replay-engine";

import { type DialBoxArgs, type DialNeighbours, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { type DialInputEvent, hasDialInputContext } from "../../shared/dial-context.js";
import { pushDialNameIcon } from "../../shared/dial-name-icon.js";
import type { DialPendingPreview } from "../../shared/dial-preview.js";
import { classifyDialReleaseForHost, dialPressShape, touchPressShape } from "../../shared/dial-release.js";
import { getReplayBusyLook, registerReplayBusySurface } from "../../shared/replay-busy-indicator.js";
import { replayBusyDialMark } from "../../shared/replay-busy-mark.js";
import { carNumberMode, racePositionMode } from "./replay-control-camera-car-modes.js";
import type {
  ReplayDialMode,
  ReplayDialModeIo,
  ReplayDialModeView,
  ReplayDialStepIo,
  ReplaySpeed,
} from "./replay-control-dial-mode.js";
import {
  REPLAY_DIAL_MODES,
  type ReplayControlDialGesture,
  type ReplayControlDialMode,
  type ReplayControlDialSettings,
} from "./replay-control-dial-settings.js";
import { frameJogMode } from "./replay-control-frame-jog.js";
import { incidentMode } from "./replay-control-incident-mode.js";
import { lapMode } from "./replay-control-lap-mode.js";
import { sessionMode } from "./replay-control-session-mode.js";
import { speedMode } from "./replay-control-speed-mode.js";
import { jumpToMyCarFromDial, trackOrderMode } from "./replay-control-track-order-mode.js";

/** The dash box's default accent — border, label and value, each overridable. */
const DIAL_ACCENT = "#3498db";

/** Background of the deck app's dial-slot name card (the keypad icons' panel colour). */
const NAME_CARD_BACKGROUND = "#2a3a4a";

/** How long past the pending-speed hold the lapse redraw waits, so the hold has run out when it looks. */
const HOLD_LAPSE_MARGIN_MS = 20;

/**
 * How often (ms) the dials are redrawn while a step or a jump has not read
 * back. Display only: a paused replay may deliver no tick when it lands, and
 * the box would keep showing where the move was headed. Nothing is decided or
 * sent on it, so its length changes how soon the screen follows and no more.
 */
const POSITION_FOLLOW_MS = 50;

/**
 * @internal Exported for testing
 *
 * The rotation modes, by `dial.mode`. Rotation, the box's label and its view
 * dispatch through this; a new mode is its module plus one row here.
 */
export const DIAL_MODES: Record<ReplayControlDialMode, ReplayDialMode<ReplayDialStepIo>> = {
  speed: speedMode,
  "frame-jog": frameJogMode,
  lap: lapMode,
  session: sessionMode,
  incident: incidentMode,
  "track-order": trackOrderMode,
  "car-number": carNumberMode,
  "race-position": racePositionMode,
};

/**
 * @internal Exported for testing
 *
 * Every mode's box label, in `REPLAY_DIAL_MODES` order: each must clear the
 * side marks on both canvases (`labelClearsSideMarks`, #801), which a test
 * checks over this list so a new mode cannot be missed.
 */
export const REPLAY_DIAL_MODE_LABELS: readonly string[] = REPLAY_DIAL_MODES.map((mode) => DIAL_MODES[mode].label);

/** What the dial surface needs from the owning action. */
export interface ReplayControlDialHost {
  readonly logger: ILogger;
  /**
   * Whether a replay is on screen: the controller's debounced replay state
   * (#1324), never raw `IsReplayPlaying`, which reads false for ~300 ms after
   * every seek.
   */
  inReplay(): boolean;
  /**
   * A fresh reading of the telemetry (`getCurrentTelemetry()`, a native
   * read), or null without one. Never the last tick a subscriber was handed:
   * ticks are delivered only when `SessionTick` advances, and on a paused or
   * scrubbed replay the content changes without it.
   */
  telemetry(): TelemetryData | null;
  /**
   * The keypad's Jump to Live, which takes the replay cursor itself, under its
   * own mode name (`jump-to-live`). `origin` is the dial's context id, the
   * press's origin token (#1437), so the dial's own box shows the jump.
   */
  jumpToLive(origin: string): void;
  /**
   * The keypad's Jump to Race Start press (#1354): its guards, its record
   * lookup and its fallback, and the replay cursor taken by the jump it starts.
   * `origin` is the dial's context id, as for {@link jumpToLive}.
   */
  jumpToRaceStart(origin: string): void;
  /** Whether that press has a race session to aim at; false is the one case a Jump to Race Start key greys for. */
  canJumpToRaceStart(): boolean;
  /**
   * The camera switched to the player's car (#801): the keypad's Jump to My
   * Car switch, the bare send. The dial's gesture hands it to the engine's
   * one camera-switch waiter (`jumpToMyCarFromDial`, #1467), as the keypad's
   * key does: only the two walks are cancelled, and during a position jump it
   * waits for the landing as the one waiting camera switch.
   */
  jumpToMyCar(): void;
  /** Whether that press has a car to switch to: the player's car and its number in the session info. */
  canJumpToMyCar(): boolean;
  /**
   * The camera switched to the car with raw number `carNumberRaw`
   * (`camera.switchNum`), the bare send of the Car # and Position modes
   * (#1448), which hand it to the engine's camera-switch waiter as a Track
   * Order turn does. Returns the SDK's answer.
   */
  switchToCarNumber(carNumberRaw: number): boolean;
  /** The canonical live race order (`getLiveRacePositions`, `race-positions.md`), or null: the Position mode's (#1448). */
  racePositions(): number[] | null;
  /** Redraws the keypad keys whose icon follows the replay speed. */
  refreshKeys(): void;
  /**
   * The controller's debounced replay state at `nowMs` (#1324): where a Lap
   * or Session turn steps from when no jump of the plugin's is headed
   * anywhere (`resolveReplayWalkStart`).
   */
  replayState(nowMs: number): ReplayState;
  /** The session info the SDK holds, or null. */
  sessionInfo(): unknown;
  /**
   * What a record lookup reads besides its anchor, with the camera car from
   * `telemetry`: the keypad's own record-step source (#1426), so a Lap or
   * Session turn and a key press read the same record the same way.
   */
  recordSource(telemetry: TelemetryData | null): RecordStepSource;
  /** Taps one of the action's key bindings (#801's Track Order mode); resolves to whether it went out. */
  tapBinding(settingKey: string): Promise<boolean>;
  /** Whether any of the given global binding keys is unset (#612). Stateless, so a dial may ask it. */
  isBindingMissing(keys: string | readonly string[]): boolean;
}

/** One reading of the replay: the telemetry and the replay speed it carries, decoded once. */
export interface ReplayDialReading {
  readonly telemetry: TelemetryData | null;
  /** `replaySpeedFromTelemetry` of {@link telemetry}; null without telemetry or without a speed in it. */
  readonly speed: ReplaySpeed | null;
}

/** What a gesture previews against. */
interface GestureEnv {
  readonly io: ReplayDialModeIo;
  readonly host: ReplayControlDialHost;
  /** The dial's context id: the press's origin token. */
  readonly origin: string;
}

/** What a gesture runs against: also the pressed dial's own `io`, for a gesture that waits as a mode's turn does. */
interface GestureRunEnv extends GestureEnv {
  readonly dialIo: ReplayDialStepIo;
}

/** One thing a gesture slot can run. */
interface DialGesture {
  /** The slot's name in the Stream Deck app's dial hint (the trigger description). */
  readonly label: string;
  /** Runs it. Called only while a replay is on screen. */
  run(env: GestureRunEnv): void;
  /**
   * What a release would do right now, for the hold preview (#1120), or null
   * when it would do nothing, which previews nothing rather than a promise.
   * The speed gestures are computable from the live and the remembered speed
   * and always preview; called only while a replay is on screen.
   */
  preview(env: GestureEnv): string | null;
}

/** A gesture that runs something itself: not None, and not the Mode default, which resolves to one of these. */
type ActiveGesture = Exclude<ReplayControlDialGesture, "none" | "mode-default">;

/** The rotation modes whose turns move the camera from car to car: their Mode default is Jump to My Car. */
const CAMERA_CAR_MODES: ReadonlySet<ReplayControlDialMode> = new Set<ReplayControlDialMode>([
  "track-order",
  "car-number",
  "race-position",
]);

/**
 * @internal Exported for testing
 *
 * What a gesture slot runs in `mode`: its own pick, or for `mode-default`
 * the mode's (#801, the maintainer's second test round): Jump to My Car in
 * the camera-car modes, Track Order, Car # and Position (#1448), whose turns
 * move the camera from car to car, and Set 1x and Play in every other mode.
 * Null for None.
 */
export function resolveDialGesture(
  gesture: ReplayControlDialGesture,
  mode: ReplayControlDialMode,
): ActiveGesture | null {
  if (gesture === "none") return null;

  if (gesture !== "mode-default") return gesture;

  return CAMERA_CAR_MODES.has(mode) ? "jump-to-my-car" : "set-1x-play";
}

function flipped(speed: ReplaySpeed): ReplaySpeed {
  return { speed: -speed.speed, slowMotion: speed.slowMotion };
}

function describeSpeed(speed: ReplaySpeed): string {
  return formatSpeedDisplay(speed.speed, speed.slowMotion);
}

function playCaption(speed: ReplaySpeed): string {
  return formatPlayCaption(speed.speed, speed.slowMotion);
}

/** The gesture slots whose run is a jump or a search: the dial's box shows working for them (#1437). */
const JUMP_GESTURES: ReadonlySet<ReplayControlDialGesture> = new Set(["jump-to-live", "jump-to-race-start"]);

/**
 * @internal Exported for testing
 *
 * Whether the dial's box draws working for `gesture` (#1437): only for a
 * gesture whose own command is a jump or a search. Every gesture carries the
 * dial's token, but a speed gesture's own command is never under way, and the
 * one jump that can carry its token, the short one the gate sends when its
 * press takes over from a search, is not something to draw. A turn (Frame Jog,
 * Speed Control) carries no token at all. A speed gesture held behind
 * something under way still shows waiting, and one given up not done.
 */
export function gestureDrawsWorking(gesture: ReplayControlDialGesture): boolean {
  return JUMP_GESTURES.has(gesture);
}

/**
 * @internal Exported for testing
 *
 * Whether a turn in each rotation mode draws working on the dial's box
 * (#1437): only where the turn is a jump or a search under the dial's token,
 * Lap's, Session's and Incident's record jump or paced search (#801), which
 * the spec's "Dials" names with a Replay Markers detent. Speed Control and
 * Frame Jog send under no token, and Track Order, Car # and Position send no
 * replay command at all (a key binding tap, a camera switch), so their turns
 * put nothing under the token to draw. A record over every mode, so a new one
 * does not compile until it says.
 */
export const TURN_DRAWS_WORKING: Readonly<Record<ReplayControlDialMode, boolean>> = {
  speed: false,
  "frame-jog": false,
  lap: true,
  session: true,
  incident: true,
  "track-order": false,
  "car-number": false,
  "race-position": false,
};

/**
 * @internal Exported for testing
 *
 * Whether a mode's caption gives way to the busy mark (#1437): only the play
 * state, Speed Control's and Frame Jog's, which says nothing worth keeping
 * while the replay is moved for the dial. The stepping modes' caption stays
 * beside the mark: #801's pending count (`+3`) is progress, which the mark
 * cannot show (spec, "Dials"), and Lap's replay time and Session's lap of the
 * session go on saying where the replay is; Position's caption is the camera
 * car's number (#1448). A record over every mode, so a new one does not
 * compile until it says.
 */
export const CAPTION_GIVES_WAY_TO_MARK: Readonly<Record<ReplayControlDialMode, boolean>> = {
  speed: true,
  "frame-jog": true,
  lap: false,
  session: false,
  incident: false,
  "track-order": false,
  "car-number": false,
  "race-position": false,
};

/**
 * The one table behind every gesture slot: its dial-hint label, what it runs
 * and what its hold preview reads. A new gesture is one row here, one value in
 * `REPLAY_DIAL_GESTURES` and one option in the PI. Every send the surface
 * makes itself takes the replay cursor under a `dial-` owner name; Jump to
 * Live and Jump to Race Start run the keypad's own paths instead, which take
 * it themselves: under the mode's name (`jump-to-live`), and as the replay
 * jump the race-start press starts once its guards have passed. Jump to My
 * Car is a camera switch and takes no cursor: it cancels only the two walks
 * and waits behind a position jump, as a Track Order turn does. The Mode
 * default has no row: it resolves to one ({@link resolveDialGesture}).
 */
const GESTURES: Record<ActiveGesture, DialGesture> = {
  // A playing replay pauses; a paused one resumes the remembered speed.
  "play-pause": {
    label: "Play/Pause",
    run({ io }) {
      const live = io.liveSpeed();

      if (live.speed !== 0) {
        const success = io.pause("dial-play-pause");
        io.logger.info("Dial paused the replay");
        io.logger.debug(`Result: ${success}, was ${describeSpeed(live)}`);

        return;
      }

      const resume = rememberedSpeed();
      const success = io.setSpeed("dial-play-pause", resume);
      io.logger.info("Dial resumed the replay");
      io.logger.debug(`Result: ${success}, at ${describeSpeed(resume)}`);
    },
    preview: ({ io }) => (io.liveSpeed().speed !== 0 ? "PAUSE" : playCaption(rememberedSpeed())),
  },
  // 1x forward whatever the state: the way back from any speed or direction.
  "set-1x-play": {
    label: "Set 1x and play",
    run({ io }) {
      const success = io.setSpeed("dial-set-1x", { speed: 1, slowMotion: false });
      io.logger.info("Dial set the replay to 1x");
      io.logger.debug(`Result: ${success}`);
    },
    preview: () => playCaption({ speed: 1, slowMotion: false }),
  },
  // Playing: the same speed the other way. Paused: the REMEMBERED speed flips
  // and the replay stays paused, so the next Play/Pause resumes the other way.
  reverse: {
    label: "Reverse direction",
    run({ io }) {
      const live = io.liveSpeed();

      if (live.speed !== 0) {
        const success = io.setSpeed("dial-reverse", flipped(live));
        io.logger.info("Dial reversed the replay");
        io.logger.debug(`Result: ${success}, from ${describeSpeed(live)}`);

        return;
      }

      const resume = reverseRememberedSpeed();
      io.logger.info("Dial reversed the resume direction");
      io.logger.debug(`Paused; nothing sent, resumes at ${describeSpeed(resume)}`);
    },
    preview: ({ io }) => {
      const live = io.liveSpeed();

      return playCaption(flipped(live.speed !== 0 ? live : rememberedSpeed()));
    },
  },
  "jump-to-live": {
    label: "Jump to Live",
    run({ io, host, origin }) {
      host.jumpToLive(origin);
      io.logger.info("Dial jumped to live");
    },
    preview: () => "LIVE",
  },
  // The counterpart of Jump to Live at the other end of a race review (#1354).
  // The keypad's own press: with no race session in the replay it sends
  // nothing, so the hold previews nothing either.
  "jump-to-race-start": {
    label: "Jump to Race Start",
    run({ io, host, origin }) {
      host.jumpToRaceStart(origin);
      io.logger.info("Dial pressed Jump to Race Start");
    },
    preview: ({ host }) => (host.canJumpToRaceStart() ? "START" : null),
  },
  // The player's car on camera (#801): a camera switch, not a replay command,
  // made as a Track Order turn makes one: only the two walks cancelled, and
  // behind a position jump it waits for the landing, as the one switch that
  // waits. With no car of the player's to switch to it sends nothing, so the
  // hold previews nothing either.
  "jump-to-my-car": {
    label: "Jump to My Car",
    run({ io, dialIo }) {
      io.logger.info("Dial pressed Jump to My Car");
      jumpToMyCarFromDial(dialIo).catch((error: unknown) => {
        io.logger.warn(`Dial Jump to My Car failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    preview: ({ host }) => (host.canJumpToMyCar() ? "MY CAR" : null),
  },
};

/** Per-context runtime state. In memory only. */
interface ReplayControlDialContext {
  action: IDeckActionContext;
  dial: ReplayControlDialSettings;
  /**
   * What this dial's turns and views go through: the surface's shared `io`
   * and the stepping members, those that carry an origin token bound to this
   * dial's context id (#801), so a mode never handles the token.
   */
  readonly io: ReplayDialStepIo;
  /** Timestamp (ms) the current dial-button press started; 0 when no press is in progress. */
  pressStart: number;
  /** Whether the dial was turned while held during the current press: the release then fires nothing. */
  rotatedWhilePressed: boolean;
  /**
   * The long-press outcome the screen is previewing (#1120), or null. Read by
   * every render and part of the displayed signature, so a tick mid-hold
   * redraws it instead of wiping it, and the revert is an ordinary render.
   */
  preview: DialPendingPreview | null;
  holdPreview: HoldPreview;
  /** Signature of the last frame pushed; a render whose signature matches pushes nothing. */
  lastRenderSig: string | null;
  /**
   * The value, side marks and caption the box last showed in a replay, kept
   * for a tick whose reading cannot say (a mode's view returns a null value or
   * caption mid-seek, #801), which leaves them as they were. Null before any,
   * and after the mode changes.
   */
  shownView: {
    readonly mode: ReplayControlDialMode;
    readonly value: string;
    readonly sides: ReplayDialModeView["sides"];
    readonly caption: string;
    readonly neighbours: DialNeighbours | null;
  } | null;
  /**
   * Signature of a built frame waiting in the throttle, or null. While one
   * waits, "would the screen change" is asked against it rather than the frame
   * on screen, so a state that goes back before the flush replaces the frame
   * that is waiting instead of leaving it to be drawn.
   */
  queuedSig: string | null;
  /** The dial's registration with the replay busy indicator (#1437), and what it registered with; null while none. */
  busy: { readonly drawsWorking: boolean; readonly unregister: () => void } | null;
  /**
   * Whether the input that last went to the gate under the dial's token
   * draws working ({@link gestureDrawsWorking}, {@link TURN_DRAWS_WORKING}),
   * or null before one has: the box's look follows the gesture or the turn
   * that made the press, not the dial's slots. A gesture that sends nothing
   * (Reverse on a paused replay, Jump to My Car) did not go to the gate and
   * leaves it as it was.
   */
  lastInputDrawsWorking: boolean | null;
}

/** A dash-box frame and the signature it is compared by. */
interface BuiltFrame {
  args: DialBoxArgs;
  sig: string;
}

/**
 * @internal Exported for testing
 *
 * The encoder trigger descriptions for the current dial settings: the
 * rotation from the selected mode, the presses from the slots. The dial-button
 * long press has no SDK field of its own, so it rides on `push` as a
 * "(hold: …)" hint, as on every dial.
 */
export function buildTriggerDescription(dial: ReplayControlDialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = { rotate: DIAL_MODES[dial.mode].rotateDescription };
  // The Mode default is labelled as what it runs in this mode; the settings
  // carry the mode, so a Mode change redraws the hint.
  const label = (gesture: ReplayControlDialGesture): string | undefined => {
    const active = resolveDialGesture(gesture, dial.mode);

    return active === null ? undefined : GESTURES[active].label;
  };
  const pushLabel = label(dial.pressAction);
  const holdLabel = label(dial.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  const touchLabel = label(dial.tapAction);
  const longTouchLabel = label(dial.longTouchAction);

  if (touchLabel) description.touch = touchLabel;

  if (longTouchLabel) description.longTouch = longTouchLabel;

  return description;
}

/**
 * The dial surface of the Replay Control action. One instance per action;
 * holds every dial context's state and all dial-side behaviour.
 */
export class ReplayControlDialSurface {
  private readonly contexts = new Map<string, ReplayControlDialContext>();
  /** Every push to a dial's screen goes through this: at most 10 per second per dial (rule 6). */
  private readonly renderThrottle = new IconUpdateThrottle();

  /**
   * What a gesture sends through, and the base of every dial's own `io`
   * ({@link dialIo}). One for every dial: the replay speed, its pending
   * overlay and the remembered speed are each one value
   * (`replay-speed-state.ts`), because iRacing has one replay speed.
   */
  private readonly io: ReplayDialModeIo;

  /**
   * The one timer that fires when a sent speed's hold runs out, or null. When
   * iRacing does not act on a send (paused at the end of a saved recording) no
   * tick follows it, so nothing else would take the sent speed off the dials,
   * or off the keys, which show it from the engine's speed state
   * (`replay-speed-state`) as the dials do. Like the hold preview's timer it
   * decides nothing and sends nothing: a fresh reading settles the lapsed
   * hold, and the keys (`refreshKeys`) and the dials redraw from it.
   */
  private holdLapseTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The origin token of the gesture running now (the state seam, #1430): the
   * dial's context id for a push, a touch or a long press, and none for a
   * detent, so a spin is never drawn as busy.
   */
  private pressOrigin: string | undefined = undefined;

  /**
   * The gesture running now and the dial it runs on, beside
   * {@link pressOrigin}; null outside one. The press funnel reads it to turn
   * the box's look off working only when a gesture that does not draw working
   * actually presses something (#1437).
   */
  private runningGesture: { readonly ctx: ReplayControlDialContext; readonly gesture: ActiveGesture } | null = null;

  /** When the host's debounced state last said a replay is on screen (ms), or null before it ever did. */
  private replaySeenAt: number | null = null;

  /** The timer that keeps the dials following a move that has not read back ({@link armPositionFollow}), or null. */
  private positionFollowTimer: ReturnType<typeof setTimeout> | null = null;

  /** The replay frame the last tick carried and whether it read as paused, for {@link tracePausedFrame}; null before one and out of a replay. */
  private lastTick: { readonly frame: number; readonly paused: boolean } | null = null;

  /** The paced search's change subscription while any dial is on screen (#801), or null. */
  private searchUnsubscribe: (() => void) | null = null;

  /** Whether a synchronous entry ({@link withReading}) is running. */
  private inEntry = false;

  /** The reading the running entry works from, once it has asked for one; null between entries. */
  private entryReading: ReplayDialReading | null = null;

  constructor(private readonly host: ReplayControlDialHost) {
    // Every command is pressed through the gate, which takes the replay cursor
    // from an in-flight replay jump (#1203) as every command did. A cursor take
    // drops the dial's pending speed, since another action's command
    // supersedes it; the dial's own take keeps it.
    const press = (owner: string, command: ReplayGateCommand): ReplayPressResult => {
      // A gesture that draws working registered so before it ran; one that
      // does not takes the working look off here, as its press goes to the
      // gate, so a gesture that never gets this far leaves the look alone.
      const running = this.runningGesture;

      if (running && !gestureDrawsWorking(running.gesture)) {
        running.ctx.lastInputDrawsWorking = false;
        this.syncBusyRegistration(running.ctx);
      }

      return keepDialPendingSpeed(() =>
        // A detent carries no token and is a repeat of the turn, never "pressing again" behind a search. A speed
        // the dial sends is the speed its Play/Pause resumes (`rememberSpeed`).
        pressReplayCommand(command, {
          by: owner,
          origin: this.pressOrigin,
          repeat: this.pressOrigin === undefined,
          rememberSpeed: true,
        }),
      );
    };

    const position: ReplayDialModeIo["position"] = () => readReplayPosition(this.reading().telemetry);

    this.io = {
      logger: host.logger,
      // A speed waiting in the gate for a move under way is what the dial has
      // asked the replay to do, like one sent that telemetry has not shown yet:
      // read as live, it makes a second Play/Pause take the first back, a jog
      // turn pause before it moves, and a speed step walk on from it.
      liveSpeed: () => shownReplaySpeed(this.reading().speed, Date.now()),
      telemetry: () => this.reading().telemetry,
      position,
      step: (owner, direction) => {
        const from = position();

        // The guard is here as well as in the mode: a step into a jump under
        // way ends it thousands of frames off, so no mode sends one; the gate
        // would turn it into a jump.
        if (from === null || from.seeking) return false;

        const result = press(owner, { kind: "step", direction });

        if (result.kind !== "sent") return result.kind !== "not-sent";

        if (result.ok) this.armPositionFollow();

        return result.ok;
      },
      jumpTo: (owner, frame) => {
        // A jump that does not go out leaves the target before it standing:
        // the replay is still headed there.
        const result = press(owner, { kind: "jump", frame });
        const sent = result.kind === "sent" && result.ok;

        if (sent) this.armPositionFollow();

        return sent;
      },
      setSpeed: (owner, target) => {
        if (target.speed === 0) return this.io.pause(owner);

        // A speed sent into a jump still under way ends the jump thousands of
        // frames on, and one sent into a search on its way cancels it. The gate
        // holds it until what is under way has landed and sends it then; the
        // follow timer keeps the dials drawn meanwhile. A speed that goes out
        // is the speed state's: the gate records it.
        const result = press(owner, { kind: "speed", speed: target.speed, slowMotion: target.slowMotion });

        if (result.kind === "sent") return result.ok;

        if (result.kind === "not-sent") return false;

        host.logger.debug(`Replay speed held: ${describeSpeed(target)} waits for what is under way to land`);
        this.armPositionFollow();

        return true;
      },
      pause: (owner) => {
        const result = press(owner, { kind: "pause" });

        // The gate records a pause that went out as 0x, through the same
        // pending hold a speed uses, so the live speed reads paused at once and
        // a second detent inside the hold does not pause again. The remembered
        // speed is left alone: it is what was playing.
        if (result.kind === "sent") return result.ok;

        // Not sent into a jump under way, which has paused the replay already;
        // held behind a search on a moving replay, it goes out on the landing.
        if (result.kind === "not-sent") host.logger.debug(`Pause not sent: ${result.reason}`);

        return true;
      },
    };

    // Every speed the engine records as sent (#1467) — the dial's own, a speed
    // the gate held and sent on the landing, the paced search's pause and
    // closing speed (#801), a record jump's pause and landing, a key's press —
    // is drawn on the dials and arms the lapse of its hold. For the surface's
    // life: a run outlives the page its dial was turned on.
    onReplaySpeedChanged(() => this.noteSpeedSent());
  }

  async willAppear(action: IDeckActionContext, dial: ReplayControlDialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The deck-app image for the dial slot: the action name (#775); strip only.
    pushDialNameIcon(
      action,
      { line1: "REPLAY", line2: "CONTROL", backgroundColor: NAME_CARD_BACKGROUND },
      this.host.logger,
    );
    this.syncBusyRegistration(ctx);
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx, true);
  }

  willDisappear(actionId: string): void {
    const ctx = this.contexts.get(actionId);

    if (!ctx) return;

    // The context is going away: no revert frame for the preview, no busy look.
    ctx.holdPreview.dispose();
    this.unregisterBusy(ctx);
    this.renderThrottle.clear(actionId);
    this.contexts.delete(actionId);

    if (this.contexts.size === 0) {
      this.searchUnsubscribe?.();
      this.searchUnsubscribe = null;
    }

    // The lapse timer is left running: the pending speed it answers for
    // outlives the dial, and a dial that comes back inside the hold (a page
    // flip and back) draws that speed and needs the redraw. With no dial on
    // screen it draws nothing and still has the keys redraw from the settled
    // speed (`refreshKeys`).
  }

  async didReceiveSettings(action: IDeckActionContext, dial: ReplayControlDialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The long-press gesture may have changed mid-hold: drop a preview computed
    // for the old one without a frame of its own — the render below is the revert.
    ctx.holdPreview.dispose();
    ctx.preview = null;
    // Before any gesture or turn, the mode or the push slot may have changed what it draws.
    this.syncBusyRegistration(ctx);
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx, true);
  }

  /**
   * Registers the dial with the replay busy indicator (#1437) under its
   * context id, the token its presses and its stepping turns carry, or
   * re-registers it when whether it draws working changed. That follows the
   * gesture or turn that last went to the gate; before one has, a stepping
   * mode's turn or else the push slot's gesture, whichever is most likely
   * behind a fact the dial finds standing when it appears (a page turned back
   * mid-jump).
   * The indicator's redraw goes through {@link scheduleIfChanged}, so the
   * throttle stays in front of it and a tick whose look draws the same frame
   * pushes nothing.
   */
  private syncBusyRegistration(ctx: ReplayControlDialContext): void {
    const drawsWorking =
      ctx.lastInputDrawsWorking ?? (TURN_DRAWS_WORKING[ctx.dial.mode] || gestureDrawsWorking(ctx.dial.pressAction));

    if (ctx.busy?.drawsWorking === drawsWorking) return;

    const previous = ctx.busy;
    const unregister = registerReplayBusySurface({
      token: ctx.action.id,
      drawsWorking,
      redraw: () => {
        if (this.contexts.get(ctx.action.id) === ctx) this.withReading(() => this.scheduleIfChanged(ctx));
      },
    });

    ctx.busy = { drawsWorking, unregister };
    // The new entry first, as the keys do: the old one's unregister is then a
    // no-op, where unregistering first would clear a not done the box is showing.
    previous?.unregister();
  }

  private unregisterBusy(ctx: ReplayControlDialContext): void {
    ctx.busy?.unregister();
    ctx.busy = null;
  }

  /**
   * A turn: handed to the dial's rotation mode with its whole `ticks`, which
   * the mode scales by. Push + turn is a plain turn — it only marks the press
   * so its release fires nothing.
   */
  rotate(action: IDeckActionContext, dial: ReplayControlDialSettings, ticks: number, pressed: boolean): void {
    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;

    this.withReading(() => {
      if (pressed) {
        ctx.rotatedWhilePressed = true;
        // The release will fire nothing, so a showing preview goes at once (#1120).
        ctx.holdPreview.rotated();
      }

      if (ticks === 0) return;

      if (!this.isReplayOnScreen()) {
        this.host.logger.debug("Dial rotate: no replay on screen, and iRacing ignores replay commands from the car");

        return;
      }

      // A turn that jumps or searches under the dial's token draws working,
      // decided before it goes out, as a gesture's is; a tokenless turn puts
      // nothing under the token and leaves the registration as it is.
      if (TURN_DRAWS_WORKING[ctx.dial.mode]) {
        ctx.lastInputDrawsWorking = true;
        this.syncBusyRegistration(ctx);
      }

      const turn = DIAL_MODES[ctx.dial.mode].rotate(ticks, ctx.dial, ctx.io);

      if (turn !== undefined) this.followTurn(turn);

      this.renderAll();
    });
  }

  /**
   * A turn that waits for something (#801): a rejection is logged, never
   * left unhandled, and every dial is redrawn once it settles, since the
   * replay it moved may deliver no tick when it lands. A further turn
   * meanwhile is not dropped here: the mode takes it.
   */
  private followTurn(turn: Promise<void>): void {
    void turn
      .catch((error: unknown) => {
        this.host.logger.error(
          `Replay control dial turn failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.withReading(() => this.renderAll()));
  }

  /**
   * One waited record jump to `frame` (#801): the shared jump sequence
   * (#1276), claimed and its frame recorded as the pending target now, as the
   * dial's own cursor take, so the pending speed it sent stands. Its pause and
   * the speed it leaves the replay at are the dial's resume speed too
   * (`rememberSpeed`); the gate records them and the dials and keys redraw
   * from that. Logs how it ended.
   */
  private async recordJump(owner: string, frame: number, origin: string): Promise<void> {
    const telemetry = this.reading().telemetry;
    const jump = keepDialPendingSpeed(() =>
      beginReplayJump(owner, telemetry, undefined, Date.now(), { frame, origin, rememberSpeed: true }),
    );

    this.armPositionFollow();

    try {
      const outcome = await runReplayJump(jump, {
        frame,
        readTelemetry: () => this.host.telemetry(),
      });

      const report = describeReplayJump(outcome, frame);

      if (report.warn !== null) this.host.logger.warn(`Replay control dial (${owner}): ${report.warn}`);

      this.host.logger.debug(`Replay control dial (${owner}): ${report.detail}`);
    } finally {
      jump.end();
    }
  }

  /**
   * Where a record step of `steps` entries lands (#801), measured from where
   * the replay is headed while a jump of the plugin's stands, else from the
   * debounced cursor (`resolveReplayWalkStart`). With no cursor to step from
   * it is a miss, and the turn goes to the search.
   */
  private recordStep(step: RecordStepSpec, steps: number): RecordStepResult {
    const now = Date.now();
    const start = resolveReplayWalkStart(this.host.replayState(now), this.reading().telemetry, now);

    if (start.frame === null) return { hit: false, reason: start.reason };

    this.host.logger.debug(`Replay control dial: ${step.label} x${steps} from ${start.from} frame ${start.frame}`);

    return findRecordStep(step, start.frame, this.recordSource(), steps);
  }

  /** What a record lookup reads: the action's record-step source, with the camera car from the running entry's reading. */
  private recordSource(): RecordStepSource {
    return this.host.recordSource(this.reading().telemetry);
  }

  /**
   * A dial's own `io` (#801): the shared one and what the stepping modes need
   * beside it. The members that carry an origin token — the record jump and
   * the paced search — have this dial's context id `origin` bound, and the
   * check a waiting camera switch (a Track Order tap, or the Jump to My Car
   * gesture's switch) makes before it goes out asks `isCurrent` whether
   * the context it was built for is still the one on screen.
   */
  private dialIo(origin: string, isCurrent: () => boolean): ReplayDialStepIo {
    const host = this.host;

    return {
      ...this.io,
      recordJump: (owner, frame) => this.recordJump(owner, frame, origin),
      recordStep: (step, steps) => this.recordStep(step, steps),
      recordSource: () => this.recordSource(),
      sessionInfo: () => host.sessionInfo(),
      queueSearch: (owner, target, ticks) => queueReplaySearch({ target, ticks, origin, owner }),
      isSearchRunning: (target) => isReplaySearchRunning(target),
      pendingSearch: (target) => {
        const pending = pendingReplaySearch();

        return pending !== null && pending.target === target ? pending.count : null;
      },
      tapBinding: (settingKey) => host.tapBinding(settingKey),
      isBindingMissing: (keys) => host.isBindingMissing(keys),
      jumpToMyCar: () => host.jumpToMyCar(),
      switchToCarNumber: (carNumberRaw) => host.switchToCarNumber(carNumberRaw),
      racePositions: () => host.racePositions(),
      isJumpUnderWay: () => {
        const telemetry = this.reading().telemetry;

        // A target standing (settled against this reading first), or a seek showing in a replay.
        return this.io.position()?.seeking === true || (host.inReplay() && isSeeking(telemetry));
      },
      // With no claim: the wait takes no cursor, cancels nothing, and ends only
      // settled or at the bound, whatever jump starts meanwhile.
      waitForJumpsToSettle: () =>
        waitForReplaySettled({ jumpsOnly: true, reads: 3, timeoutMs: REPLAY_JUMP_MAX_WAIT_MS }),
      isStillOnScreen: () => isCurrent() && this.isReplayOnScreen(),
      isSavedReplay: () => host.replayState(Date.now()).replayOnlySession,
    };
  }

  /**
   * The press shape of a dial press (#269): released, with the gestures the
   * release fires and the threshold it classifies with, or `none` when no
   * context would take the press. `down` and `touchTap` refresh the context from these settings, so they are the ones the release and the touch read; a slot resolves through {@link resolveDialGesture} as it does there.
   */
  pressShape(action: IDeckActionContext, dial: ReplayControlDialSettings): PressShape {
    if (!this.contexts.has(action.id)) return { kind: "none" };

    return dialPressShape({
      pressGesture: resolveDialGesture(dial.pressAction, dial.mode),
      longPressGesture: resolveDialGesture(dial.longPressAction, dial.mode),
      thresholdMs: getDualPressThresholdMs(),
    });
  }

  /** The press shape of a touch (#269): the slot `touchTap` fires for it, or `none`. */
  touchShape(action: IDeckActionContext, dial: ReplayControlDialSettings, hold: boolean): PressShape {
    if (!this.contexts.has(action.id)) return { kind: "none" };

    return touchPressShape({
      tapGesture: resolveDialGesture(dial.tapAction, dial.mode),
      longTouchGesture: resolveDialGesture(dial.longTouchAction, dial.mode),
      hold,
    });
  }

  down(action: IDeckActionContext, dial: ReplayControlDialSettings): void {
    const ctx = this.inputContext(action, dial, "down");

    if (!ctx) return;

    // Record the press; fire nothing — press versus long press is classified at release.
    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
    // The one timer armed here only draws (#1120).
    ctx.holdPreview.down();
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contexts.get(actionId);

    if (ctx) this.withReading(() => this.release(ctx));
  }

  /** A release: the preview goes, the press is classified, and its gesture slot runs. */
  private release(ctx: ReplayControlDialContext): void {
    // Disarm and revert FIRST — every early return below still needs the
    // screen put back (#1120, trap 4).
    ctx.holdPreview.up();

    // Consume the press start so a stray dialUp cannot reclassify; 0 = no press.
    const pressStartMs = ctx.pressStart;
    ctx.pressStart = 0;

    if (pressStartMs === 0) return;

    const kind = classifyDialReleaseForHost({
      pressStartMs,
      nowMs: Date.now(),
      rotatedWhilePressed: ctx.rotatedWhilePressed,
      thresholdMs: getDualPressThresholdMs(),
    });

    if (kind === "push-turn") return;

    const gesture = resolveDialGesture(
      kind === "long" ? ctx.dial.longPressAction : ctx.dial.pressAction,
      ctx.dial.mode,
    );

    if (gesture === null) return;

    this.host.logger.info(kind === "long" ? "Replay control dial long-pressed" : "Replay control dial pressed");
    this.runGesture(gesture, ctx);
  }

  touchTap(action: IDeckActionContext, dial: ReplayControlDialSettings, hold: boolean): void {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

    const ctx = this.inputContext(action, dial, "touchTap");

    if (!ctx) return;

    // hold → the Long Touch slot; a plain tap → Tap Display.
    const gesture = resolveDialGesture(hold ? ctx.dial.longTouchAction : ctx.dial.tapAction, ctx.dial.mode);

    if (gesture === null) return;

    this.host.logger.info(hold ? "Replay control dial long touch" : "Replay control dial tap");
    this.withReading(() => this.runGesture(gesture, ctx));
  }

  /**
   * Per SDK tick: redraw only when what the screen shows would change — a
   * paused replay, or one playing at a steady speed, pushes nothing. A changed
   * tick hands the frame it built to the flush, so it is built once. The frame
   * is evaluated against `tick`, the reading the owning action was just
   * handed, so this path takes no telemetry read of its own.
   */
  onTick(actionId: string, tick: ReplayDialReading): void {
    const ctx = this.contexts.get(actionId);

    if (!ctx) return;

    this.tracePausedFrame(tick);
    this.withReading(() => this.scheduleIfChanged(ctx), tick);
  }

  /**
   * Logs, at debug, every move of the replay frame between two ticks of which
   * at least one read as paused. A paused replay moves only when something
   * moves it — a frame step, a jump, the replay bar — so together with the
   * command lines the log reads as what was sent and where the replay went,
   * which is the only way to tell a command iRacing took as asked from one it
   * did not (#1317: a fast Frame Jog turn sent the replay to its start). A
   * tick that reads as playing next to a paused one is logged too, with its
   * raw speed and `IsReplayPlaying`: for about 300 ms after a seek the
   * snapshot is not the replay's, and that is exactly the stretch in question.
   * One frame for every dial, since there is one replay; a tick every dial is
   * handed logs once. A replay playing from tick to tick is only followed.
   */
  private tracePausedFrame(tick: ReplayDialReading): void {
    const telemetry = tick.telemetry;
    const frame = telemetry?.ReplayFrameNum;

    if (!telemetry || frame === undefined || !this.host.inReplay()) {
      this.lastTick = null;

      return;
    }

    const previous = this.lastTick;
    const paused = tick.speed?.speed === 0;

    this.lastTick = { frame, paused };

    if (previous === null || previous.frame === frame || !(paused || previous.paused)) return;

    const moved = frame - previous.frame;

    this.host.logger.debug(
      `Paused replay moved: frame ${previous.frame} -> ${frame} (${moved > 0 ? "+" : ""}${moved}), ` +
        `time=${telemetry.ReplaySessionTime?.toFixed(3) ?? "n/a"}, speed=${telemetry.ReplayPlaySpeed ?? "n/a"}, ` +
        `replaying=${telemetry.IsReplayPlaying ?? "n/a"}`,
    );
  }

  /**
   * Runs one synchronous entry — a turn, a release, a touch, a tick, the hold
   * preview's threshold, the lapse timer, a flush that builds its own frame —
   * against ONE reading of the replay: `tick` where the entry was handed one,
   * otherwise a fresh read taken the first time the entry asks. Everything the
   * entry does synchronously sees that reading, and it is dropped when the
   * entry returns or throws, so no entry ever works from an earlier one's. An
   * entry started inside another (a flush the throttle runs at once) shares
   * the outer one's reading.
   */
  private withReading<T>(run: () => T, tick?: ReplayDialReading): T {
    if (this.inEntry) return run();

    this.inEntry = true;
    this.entryReading = tick ?? null;

    try {
      return run();
    } finally {
      this.inEntry = false;
      this.entryReading = null;
    }
  }

  /**
   * The reading to decide from now: the running entry's, taken on first use,
   * or — for a caller outside any entry — a fresh one that is not kept.
   */
  private reading(): ReplayDialReading {
    if (!this.inEntry) return this.readFresh();

    this.entryReading ??= this.readFresh();

    return this.entryReading;
  }

  private readFresh(): ReplayDialReading {
    const telemetry = this.host.telemetry();

    return { telemetry, speed: telemetry ? replaySpeedFromTelemetry(telemetry) : null };
  }

  /**
   * Whether a command would do anything: a replay on screen and telemetry to
   * read the speed from. Without both, every input is a no-op and the box
   * dims. A replay is on screen by the debounced state (so the ~300 ms after a
   * seek still count), and also while a move of the plugin's own is under
   * way: a jump under way holds iRacing's raw flag false, and a turn that
   * keeps retargeting one shows it true for a tick or two in every 400 ms, so
   * the debounce's grace is not something to rest a long turn on.
   */
  private isReplayOnScreen(): boolean {
    const now = Date.now();
    const inReplay = this.host.inReplay();

    if (inReplay) this.replaySeenAt = now;

    return (inReplay || this.isMoveUnderWay(now)) && this.reading().telemetry !== null;
  }

  /**
   * Whether the plugin is moving the replay right now: a target that has not
   * read back, a search on its way, a press waiting in the gate, or a claim on
   * the replay cursor. It holds the replay on screen only for
   * {@link REPLAY_TARGET_GIVE_UP_MS} past the last moment the debounced state
   * said so. A move sent while only this holds would otherwise renew its own
   * target, and with it the hold, for as long as the dial is turned from the
   * car.
   */
  private isMoveUnderWay(now: number): boolean {
    if (this.replaySeenAt === null || now - this.replaySeenAt >= REPLAY_TARGET_GIVE_UP_MS) return false;

    return currentReplayCursorOwner() !== null || isReplayMoveUnderWay() || this.io.position()?.seeking === true;
  }

  /** Runs a gesture slot's assignment for the dial `ctx`; outside a replay it sends nothing. */
  private runGesture(gesture: ActiveGesture, ctx: ReplayControlDialContext): void {
    if (!this.isReplayOnScreen()) {
      this.host.logger.debug(`Dial ${gesture}: no replay on screen, and iRacing ignores replay commands from the car`);

      return;
    }

    // A gesture that jumps draws working, registered before it runs so its
    // press's first notice already reads it. Any other gesture changes the look
    // only if one of its presses reaches the gate, in the press funnel: one
    // that sends nothing leaves a search the dial's turn started drawn working.
    if (gestureDrawsWorking(gesture)) {
      ctx.lastInputDrawsWorking = true;
      this.syncBusyRegistration(ctx);
    }

    const origin = ctx.action.id;

    // A gesture's commands carry the dial's own origin token; a detent's carry none.
    this.pressOrigin = origin;
    this.runningGesture = { ctx, gesture };

    try {
      GESTURES[gesture].run({ io: this.io, host: this.host, dialIo: ctx.io, origin });
    } finally {
      this.pressOrigin = undefined;
      this.runningGesture = null;
    }

    this.renderAll();
  }

  /**
   * A speed the engine just recorded as sent, a pause included: it stands for
   * the live speed until telemetry reports it (`replay-speed-state.ts`), so
   * the dials on screen are drawn from it at once — a paused replay may
   * deliver no tick — and the lapse of its hold is armed. The keys redraw from
   * the action's own subscription. Inside an entry (a dial's own gesture) the
   * entry draws when it ends, so nothing is drawn mid-gesture.
   */
  private noteSpeedSent(): void {
    if (!this.inEntry) this.withReading(() => this.renderAll());

    this.armHoldLapseTimer();
  }

  /**
   * Redraws the dials every {@link POSITION_FOLLOW_MS} while the gate has a
   * move under way or a press waiting: a paused replay may deliver no tick
   * when it lands, and the box would keep showing where the move was headed.
   * Like the lapse timer it decides nothing and sends nothing — the gate sends
   * a held speed on the landing — and there is one timer for the surface,
   * since there is one replay position.
   */
  private armPositionFollow(): void {
    if (this.positionFollowTimer !== null) return;

    this.positionFollowTimer = setTimeout(() => {
      this.positionFollowTimer = null;
      this.withReading(() => {
        // Not a seek the reading merely shows: a move given up stops the redraw.
        const underWay = this.io.position()?.seeking === true || getReplayGateRecord().waiting !== null;

        this.renderAll();

        if (underWay) this.armPositionFollow();
      });
    }, POSITION_FOLLOW_MS);
  }

  /**
   * (Re)arms the lapse timer for the send just made: one timer for the
   * surface, since the pending speed is one value, moved by every send.
   */
  private armHoldLapseTimer(): void {
    this.clearHoldLapseTimer();
    this.holdLapseTimer = setTimeout(() => {
      this.holdLapseTimer = null;
      this.withReading(() => this.settleLapsedHold());
    }, DIAL_SPEED_HOLD_MS + HOLD_LAPSE_MARGIN_MS);
  }

  /**
   * The hold of the last send has run out. The live speed is telemetry's
   * again, read fresh, and everything that showed the sent speed is redrawn
   * from it: the keys, so a Play/Pause key does not keep showing (and deciding
   * from) a speed that never played, and every dial still showing it — a dial
   * whose frame did not change is left alone. A send that took reads back as
   * the same speed, and nothing changes.
   */
  private settleLapsedHold(): void {
    // The read settles the lapsed hold, and a provisional resume speed, before anything redraws from it.
    this.io.liveSpeed();
    this.host.refreshKeys();
    this.renderAll();
  }

  private clearHoldLapseTimer(): void {
    if (this.holdLapseTimer !== null) clearTimeout(this.holdLapseTimer);

    this.holdLapseTimer = null;
  }

  /**
   * The long-press outcome, when a release would do something: null for None
   * and outside a replay or without telemetry, which previews nothing rather
   * than a default (#1120, trap 2).
   */
  private resolvePreview(ctx: ReplayControlDialContext): DialPendingPreview | null {
    const gesture = resolveDialGesture(ctx.dial.longPressAction, ctx.dial.mode);

    if (gesture === null || !this.isReplayOnScreen()) return null;

    const text = GESTURES[gesture].preview({ io: this.io, host: this.host, origin: ctx.action.id });

    if (text === null) return null;

    return { text, color: resolveDialBoxColors(ctx.dial.colors, DIAL_ACCENT).value };
  }

  /** The hold-preview threshold callback: draws the outcome and says whether it did. Fires nothing. */
  private showHoldPreview(ctx: ReplayControlDialContext): boolean {
    return this.withReading(() => {
      const preview = this.resolvePreview(ctx);

      if (!preview) return false;

      ctx.preview = preview;
      this.host.logger.debug(`Replay control dial hold preview: ${preview.text}`);
      this.scheduleRender(ctx);

      return true;
    });
  }

  /** The hold-preview cancel callback: back to the normal screen. */
  private revertHoldPreview(ctx: ReplayControlDialContext): void {
    ctx.preview = null;
    this.scheduleRender(ctx);
  }

  /**
   * The context an INPUT event (rotate, down, touchTap) acts on: the existing
   * one, refreshed exactly as {@link ensureContext} refreshes it, or `undefined`
   * — never a new one (#1329). A late event the host delivers after
   * `willDisappear` is dropped here, before it can re-create the entry or act
   * on a context that is gone.
   */
  private inputContext(
    action: IDeckActionContext,
    dial: ReplayControlDialSettings,
    event: DialInputEvent,
  ): ReplayControlDialContext | undefined {
    return hasDialInputContext(this.contexts, action.id, event, this.host.logger)
      ? this.ensureContext(action, dial)
      : undefined;
  }

  /**
   * Gets or creates a context, refreshing its dial settings and action from the
   * event — for the LIFECYCLE events (`willAppear`, `didReceiveSettings`) only;
   * input events go through {@link inputContext}, which never creates a context
   * (#1329). This surface writes no settings of its own, so the payload is
   * authoritative (rule 10 applies only to surfaces that persist plugin-side).
   */
  private ensureContext(action: IDeckActionContext, dial: ReplayControlDialSettings): ReplayControlDialContext {
    const existing = this.contexts.get(action.id);

    if (existing) {
      existing.action = action;
      existing.dial = dial;

      return existing;
    }

    const created: ReplayControlDialContext = {
      action,
      dial,
      // The context, not only its id: a dial that left and came back is a new one.
      io: this.dialIo(action.id, () => this.contexts.get(action.id) === created),
      pressStart: 0,
      rotatedWhilePressed: false,
      preview: null,
      holdPreview: NOOP_HOLD_PREVIEW,
      lastRenderSig: null,
      shownView: null,
      queuedSig: null,
      busy: null,
      lastInputDrawsWorking: null,
    };

    // The paced search's count is drawn on the box (#801): redraw on its every
    // change while any dial is on screen.
    this.searchUnsubscribe ??= onReplaySearchChange(() => this.withReading(() => this.renderAll()));
    // The real helper only where the extended gestures exist (#1120).
    created.holdPreview = __FEATURE_DIAL_EXTENDED_GESTURES__
      ? createHoldPreview({
          // The same threshold the release classifier reads, read at press time.
          thresholdMs: () => getDualPressThresholdMs(),
          onThreshold: () => this.showHoldPreview(created),
          onCancel: () => this.revertHoldPreview(created),
        })
      : NOOP_HOLD_PREVIEW;
    this.contexts.set(action.id, created);

    return created;
  }

  /**
   * The dash-box arguments for the current state. In a replay the selected
   * mode says what the box reads, and `pending` rides every render. Outside
   * one (or with no telemetry) the box is the mode's label alone, dimmed.
   */
  private boxArgs(ctx: ReplayControlDialContext): DialBoxArgs {
    const colors = resolveDialBoxColors(ctx.dial.colors, DIAL_ACCENT);
    const mode = DIAL_MODES[ctx.dial.mode];
    // The busy look (#1437), part of the signature as kind and position.
    const look = ctx.busy === null ? undefined : replayBusyDialMark(getReplayBusyLook(ctx.action.id));
    const mark: Pick<DialBoxArgs, "captionMark"> = look ? { captionMark: look } : {};

    if (!this.isReplayOnScreen()) {
      // A dimmed box with an empty value slot enlarges its label into that
      // space, where the side marks would overlap it: draw none there. And no
      // pending preview: a replay that ended mid-hold leaves a release that
      // will do nothing, so the box must not keep claiming an outcome.
      return {
        abbr: mode.label,
        value: "",
        colors,
        caption: "",
        dimmed: true,
        pending: null,
        // A fact the gate still holds when the replay is left ends there, on its own wait.
        ...mark,
      };
    }

    const view = mode.view(ctx.dial, ctx.io);
    // A tick read mid-seek (#801): the box keeps what this mode last showed,
    // the value with its side marks and neighbours, and the caption, each
    // where it cannot say.
    const shown = ctx.shownView?.mode === ctx.dial.mode ? ctx.shownView : null;
    const value = view.value ?? shown?.value ?? "";
    const sides = view.value === null ? (shown?.sides ?? view.sides) : view.sides;
    const neighbours = view.value === null ? (shown?.neighbours ?? null) : (view.neighbours ?? null);
    const caption = view.caption ?? shown?.caption ?? "";

    ctx.shownView = { mode: ctx.dial.mode, value, sides, caption, neighbours };

    // The play state gives way to the mark and is not drawn; its line stays
    // reserved, so the value keeps the place the caption gave it. Any other
    // caption, the pending count first, is drawn beside the mark.
    const givesWay = look !== undefined && caption !== "" && CAPTION_GIVES_WAY_TO_MARK[ctx.dial.mode];

    return {
      abbr: mode.label,
      value,
      colors,
      sideMarker: sides,
      caption: givesWay ? "" : caption,
      ...(view.reserveCaption === true || givesWay ? { reserveCaptionLine: true } : {}),
      ...(neighbours === null ? {} : { neighbours }),
      dimmed: false,
      pending: ctx.preview,
      ...(view.bindingMissing === true ? { bindingMissing: true } : {}),
      ...mark,
    };
  }

  /**
   * The frame for the current state and its signature — built from what is
   * displayed, never the raw replay frame or tick, so an unchanged display is
   * recognised as such.
   */
  private buildFrame(ctx: ReplayControlDialContext): BuiltFrame {
    const args = this.boxArgs(ctx);

    return { args, sig: JSON.stringify(args) };
  }

  /** Redraws every dial whose frame changed: the replay speed they show is one value. */
  private renderAll(): void {
    for (const ctx of this.contexts.values()) this.scheduleIfChanged(ctx);
  }

  /**
   * Queues a push when what the dial would show differs from what it shows
   * (or from a built frame already waiting in the throttle). The frame is
   * built first, and handed to the flush so it is built once, because a
   * schedule stamps the throttle's window even when its flush then pushes
   * nothing: an unconditional one after a detent that changed nothing would
   * hold the next real change back by up to 100 ms.
   */
  private scheduleIfChanged(ctx: ReplayControlDialContext): void {
    // The dial's own screen decides the drawing; none, nothing to compare (#1013).
    if (!ctx.action.dialCanvas()) return;

    const frame = this.buildFrame(ctx);

    if (frame.sig !== (ctx.queuedSig ?? ctx.lastRenderSig)) this.scheduleRender(ctx, false, frame);
  }

  /**
   * Queues a push of the dial's screen through the throttle. The flush pushes
   * only when the signature differs from the last frame; `force` makes the next
   * flush push regardless (appear, settings). `built` is a frame the caller
   * already built from the current state (a tick); without it the flush builds
   * from the state at that moment. Either way the throttle keeps only the
   * latest schedule, so a flush never draws an older state than the last one
   * queued.
   */
  private scheduleRender(ctx: ReplayControlDialContext, force = false, built?: BuiltFrame): void {
    if (force) ctx.lastRenderSig = null;

    // Set before the schedule: outside its window the throttle flushes at once.
    ctx.queuedSig = built?.sig ?? null;
    this.renderThrottle.schedule(ctx.action.id, () => this.renderIfChanged(ctx, built));
  }

  private async renderIfChanged(ctx: ReplayControlDialContext, built?: BuiltFrame): Promise<void> {
    // The throttle runs only the latest schedule, so nothing is waiting any more.
    ctx.queuedSig = null;

    // A context that went away (or was replaced) since the schedule draws nothing.
    if (this.contexts.get(ctx.action.id) !== ctx) return;

    // The dial's own screen decides the drawing; none, nothing to draw (#1013).
    const canvas = ctx.action.dialCanvas();

    if (!canvas) return;

    // A flush that was not handed a frame builds its own, from one fresh reading.
    const { args, sig } = built ?? this.withReading(() => this.buildFrame(ctx));

    if (sig === ctx.lastRenderSig) return;

    ctx.lastRenderSig = sig;

    try {
      await ctx.action.setDialCanvas(svgToDataUri(renderDialBox(canvas, args)));
    } catch (err) {
      // Pushes run from timers with no caller left to catch a rejection; the
      // next tick retries, since this frame never reached the screen.
      ctx.lastRenderSig = null;
      this.host.logger.debug(`Replay control dial render failed: ${String(err)}`);
    }
  }

  /** Pushes the encoder trigger descriptions (Elgato only). */
  private async applyTriggerDescription(ctx: ReplayControlDialContext): Promise<void> {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }
}
