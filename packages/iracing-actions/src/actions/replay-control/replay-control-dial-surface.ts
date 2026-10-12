/**
 * Replay Control — dial surface (issue #1316). Design:
 * `docs/superpowers/specs/2026-10-04-issue-1316-replay-control-dial.md`.
 *
 * Rotating runs the dial's rotation mode (`dial.mode`, one module per mode
 * behind `replay-control-dial-mode.ts`): Speed Control walks the replay speed
 * along a ladder the user shapes, and Frame Jog (#1317) steps the replay one
 * frame per detent. The press gestures are shared by every
 * mode — Play/Pause, Set 1x and play, Reverse direction, Jump to Live — so
 * changing the Mode never changes what a press does. The dial's screen is the
 * shared dash box, drawn from what the mode says it shows.
 *
 * Every command is a one-shot that first takes the replay cursor from an
 * in-flight Jump to Fastest Lap walk, and outside a replay nothing is sent:
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
  svgToDataUri,
} from "@iracedeck/deck-core";
import { getCommands } from "@iracedeck/deck-iracing";
import { replaySpeedFromTelemetry, type TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { type DialBoxArgs, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { type DialInputEvent, hasDialInputContext } from "../../shared/dial-context.js";
import { pushDialNameIcon } from "../../shared/dial-name-icon.js";
import type { DialPendingPreview } from "../../shared/dial-preview.js";
import { classifyDialReleaseForHost } from "../../shared/dial-release.js";
import { cancelReplayCursorOwner } from "../../shared/replay-cursor.js";
import type { ReplayDialMode, ReplayDialModeIo, ReplaySpeed } from "./replay-control-dial-mode.js";
import type {
  ReplayControlDialGesture,
  ReplayControlDialMode,
  ReplayControlDialSettings,
} from "./replay-control-dial-settings.js";
import { frameJogMode } from "./replay-control-frame-jog.js";
import { speedMode } from "./replay-control-speed-mode.js";
import { formatPlayCaption, formatSpeedDisplay } from "./replay-speed-format.js";
import {
  DIAL_SPEED_HOLD_MS,
  keepDialPendingSpeed,
  noteDialSpeedSent,
  rememberedSpeed,
  resolveLiveSpeed,
  reverseRememberedSpeed,
} from "./replay-speed-state.js";

/** The dash box's default accent — border, label and value, each overridable. */
const DIAL_ACCENT = "#3498db";

/** Background of the deck app's dial-slot name card (the keypad icons' panel colour). */
const NAME_CARD_BACKGROUND = "#2a3a4a";

const PAUSED: ReplaySpeed = { speed: 0, slowMotion: false };

/** How long past the pending-speed hold the lapse redraw waits, so the hold has run out when it looks. */
const HOLD_LAPSE_MARGIN_MS = 20;

/**
 * @internal Exported for testing
 *
 * The rotation modes, by `dial.mode`. Rotation, the box's label and its view
 * dispatch through this; a new mode is its module plus one row here.
 */
export const DIAL_MODES: Record<ReplayControlDialMode, ReplayDialMode> = {
  speed: speedMode,
  "frame-jog": frameJogMode,
};

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
  /** The action's own optimistic speed cache, so the keypad's speed icons follow a dial send at once. */
  setLocalSpeed(speed: number, slowMotion: boolean): void;
  /** The keypad's Jump to Live, which takes the replay cursor itself, under its own mode name (`jump-to-live`). */
  jumpToLive(): void;
  /** Redraws the keypad keys whose icon follows the replay speed. */
  refreshKeys(): void;
}

/** One reading of the replay: the telemetry and the replay speed it carries, decoded once. */
export interface ReplayDialReading {
  readonly telemetry: TelemetryData | null;
  /** `replaySpeedFromTelemetry` of {@link telemetry}; null without telemetry or without a speed in it. */
  readonly speed: ReplaySpeed | null;
}

/** What a gesture runs against. */
interface GestureEnv {
  readonly io: ReplayDialModeIo;
  readonly host: ReplayControlDialHost;
}

/** One thing a gesture slot can run. */
interface DialGesture {
  /** The slot's name in the Stream Deck app's dial hint (the trigger description). */
  readonly label: string;
  /** Runs it. Called only while a replay is on screen. */
  run(env: GestureEnv): void;
  /**
   * What a release would do right now, for the hold preview (#1120). Every
   * outcome here is computable from the live and the remembered speed, so
   * every gesture previews; called only while a replay is on screen.
   */
  preview(env: GestureEnv): string;
}

type ActiveGesture = Exclude<ReplayControlDialGesture, "none">;

function flipped(speed: ReplaySpeed): ReplaySpeed {
  return { speed: -speed.speed, slowMotion: speed.slowMotion };
}

function describeSpeed(speed: ReplaySpeed): string {
  return formatSpeedDisplay(speed.speed, speed.slowMotion);
}

function playCaption(speed: ReplaySpeed): string {
  return formatPlayCaption(speed.speed, speed.slowMotion);
}

/**
 * The one table behind every gesture slot: its dial-hint label, what it runs
 * and what its hold preview reads. A new gesture is one row here, one value in
 * `REPLAY_DIAL_GESTURES` and one option in the PI. Every send the surface
 * makes itself takes the replay cursor under a `dial-` owner name; Jump to
 * Live runs the keypad's own path instead, which takes it under that mode's
 * name, `jump-to-live`.
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
    run({ io, host }) {
      host.jumpToLive();
      io.logger.info("Dial jumped to live");
    },
    preview: () => "LIVE",
  },
};

/** Per-context runtime state. In memory only. */
interface ReplayControlDialContext {
  action: IDeckActionContext;
  dial: ReplayControlDialSettings;
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
   * Signature of a built frame waiting in the throttle, or null. While one
   * waits, "would the screen change" is asked against it rather than the frame
   * on screen, so a state that goes back before the flush replaces the frame
   * that is waiting instead of leaving it to be drawn.
   */
  queuedSig: string | null;
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
  const pushLabel = dial.pressAction === "none" ? undefined : GESTURES[dial.pressAction].label;
  const holdLabel = dial.longPressAction === "none" ? undefined : GESTURES[dial.longPressAction].label;

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  if (dial.tapAction !== "none") description.touch = GESTURES[dial.tapAction].label;

  if (dial.longTouchAction !== "none") description.longTouch = GESTURES[dial.longTouchAction].label;

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
   * What a rotation mode and a gesture send through. One for every dial: the
   * replay speed, its pending overlay and the remembered speed are each one
   * value (`replay-speed-state.ts`), because iRacing has one replay speed.
   */
  private readonly io: ReplayDialModeIo;

  /**
   * The one timer that fires when a sent speed's hold runs out, or null. When
   * iRacing does not act on a send (paused at the end of a saved recording) no
   * tick follows it, so nothing else would take the sent speed off the dials,
   * or out of the action's speed cache, where the send put it for the keys.
   * Like the hold preview's timer it decides nothing and sends nothing: it
   * redraws from a fresh reading and hands the action that reading's speed.
   */
  private holdLapseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether a synchronous entry ({@link withReading}) is running. */
  private inEntry = false;

  /** The reading the running entry works from, once it has asked for one; null between entries. */
  private entryReading: ReplayDialReading | null = null;

  constructor(private readonly host: ReplayControlDialHost) {
    const send: ReplayDialModeIo["send"] = (owner, run) => {
      // Takes the cursor from an in-flight Jump to Fastest Lap walk (#1203): a
      // speed change mid-walk would make the walk misread its own probes. A
      // cursor take drops the dial's pending speed, since another action's
      // command supersedes it; the dial's own take keeps it.
      keepDialPendingSpeed(() => cancelReplayCursorOwner(owner));

      return run(getCommands().replay);
    };

    this.io = {
      logger: host.logger,
      liveSpeed: () => resolveLiveSpeed(this.reading().speed, Date.now()),
      telemetry: () => this.reading().telemetry,
      send,
      setSpeed: (owner, target) => {
        const sent = send(owner, (replay) => replay.setPlaySpeed(target.speed, target.slowMotion));

        if (sent) this.noteSpeedSent(target);

        return sent;
      },
      pause: (owner) => {
        const sent = send(owner, (replay) => replay.pause());

        // 0x through the same pending hold a speed uses, so the live speed
        // reads paused at once and a second detent inside the hold does not
        // pause again. The remembered speed is left alone: it is what was playing.
        if (sent) this.noteSpeedSent(PAUSED);

        return sent;
      },
    };
  }

  async willAppear(action: IDeckActionContext, dial: ReplayControlDialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The deck-app image for the dial slot: the action name (#775); strip only.
    pushDialNameIcon(
      action,
      { line1: "REPLAY", line2: "CONTROL", backgroundColor: NAME_CARD_BACKGROUND },
      this.host.logger,
    );
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx, true);
  }

  willDisappear(actionId: string): void {
    const ctx = this.contexts.get(actionId);

    if (!ctx) return;

    // The context is going away: no revert frame for the preview.
    ctx.holdPreview.dispose();
    this.renderThrottle.clear(actionId);
    this.contexts.delete(actionId);

    // No dial left to redraw.
    if (this.contexts.size === 0) this.clearHoldLapseTimer();
  }

  async didReceiveSettings(action: IDeckActionContext, dial: ReplayControlDialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The long-press gesture may have changed mid-hold: drop a preview computed
    // for the old one without a frame of its own — the render below is the revert.
    ctx.holdPreview.dispose();
    ctx.preview = null;
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx, true);
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

      DIAL_MODES[ctx.dial.mode].rotate(ticks, ctx.dial, this.io);
      this.renderAll();
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

    const gesture = kind === "long" ? ctx.dial.longPressAction : ctx.dial.pressAction;

    if (gesture === "none") return;

    this.host.logger.info(kind === "long" ? "Replay control dial long-pressed" : "Replay control dial pressed");
    this.runGesture(gesture);
  }

  touchTap(action: IDeckActionContext, dial: ReplayControlDialSettings, hold: boolean): void {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

    const ctx = this.inputContext(action, dial, "touchTap");

    if (!ctx) return;

    // hold → the Long Touch slot; a plain tap → Tap Display.
    const gesture = hold ? ctx.dial.longTouchAction : ctx.dial.tapAction;

    if (gesture === "none") return;

    this.host.logger.info(hold ? "Replay control dial long touch" : "Replay control dial tap");
    this.withReading(() => this.runGesture(gesture));
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

    if (ctx) this.withReading(() => this.scheduleIfChanged(ctx), tick);
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
   * Whether a command would do anything: a replay on screen (the debounced
   * state, so the ~300 ms after a seek still count) and telemetry to read the
   * speed from. Without both, every input is a no-op and the box dims.
   */
  private isReplayOnScreen(): boolean {
    return this.host.inReplay() && this.reading().telemetry !== null;
  }

  /** Runs a gesture slot's assignment; outside a replay it sends nothing. */
  private runGesture(gesture: ActiveGesture): void {
    if (!this.isReplayOnScreen()) {
      this.host.logger.debug(`Dial ${gesture}: no replay on screen, and iRacing ignores replay commands from the car`);

      return;
    }

    GESTURES[gesture].run({ io: this.io, host: this.host });
    this.renderAll();
  }

  /**
   * A speed this surface just sent, a pause included: it stands for the live
   * speed until telemetry reports it (`replay-speed-state.ts`), and the
   * action's own cache takes it too so the keypad's speed icons follow at once.
   */
  private noteSpeedSent(speed: ReplaySpeed): void {
    noteDialSpeedSent(speed, Date.now());
    this.host.setLocalSpeed(speed.speed, speed.slowMotion);
    this.host.refreshKeys();
    this.armHoldLapseTimer();
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
   * again, read fresh, and everything that took the sent speed is put right
   * from it: the action's speed cache, so a Play/Pause key does not keep
   * showing (and deciding from) a speed that never played, and every dial
   * still showing it — a dial whose frame did not change is left alone. A
   * send that took reads back as the same speed, and nothing changes.
   */
  private settleLapsedHold(): void {
    const live = this.io.liveSpeed();

    this.host.setLocalSpeed(live.speed, live.slowMotion);
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
    const gesture = ctx.dial.longPressAction;

    if (gesture === "none" || !this.isReplayOnScreen()) return null;

    return {
      text: GESTURES[gesture].preview({ io: this.io, host: this.host }),
      color: resolveDialBoxColors(ctx.dial.colors, DIAL_ACCENT).value,
    };
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
      pressStart: 0,
      rotatedWhilePressed: false,
      preview: null,
      holdPreview: NOOP_HOLD_PREVIEW,
      lastRenderSig: null,
      queuedSig: null,
    };
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
      };
    }

    const view = mode.view(ctx.dial, this.io);

    return {
      abbr: mode.label,
      value: view.value,
      colors,
      sideMarker: view.sides,
      caption: view.caption,
      dimmed: false,
      pending: ctx.preview,
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
