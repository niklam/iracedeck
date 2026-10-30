/**
 * Replay Markers — dial surface (issue #1230). Design:
 * `docs/superpowers/specs/2026-09-25-issue-1230-replay-markers-dial.md`.
 *
 * Rotating jumps between the session's markers — clockwise forward in the
 * recording, one marker per detent, one jump per event — and the press
 * gestures run Add Marker or Delete Marker, the keypad's own operations
 * (`replay-markers-ops.ts`). A jump is the shared replay jump sequence, so a
 * turn leaves the replay the way the Replay jump playback setting says
 * (#1276). The dial's screen is the shared dash box: the marker count (or
 * `k / N` while a marker's moment plays), side marks lit where a turn would
 * jump, and from the car a caption naming the press.
 *
 * The surface holds the per-dial-context state; the owning ReplayMarkers
 * action routes `IDeck*` dial events here, and the surface reads the replay
 * context and the live telemetry through {@link ReplayMarkersDialHost}.
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
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import { type DialBoxArgs, type DialSideMarks, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { type DialInputEvent, hasDialInputContext } from "../../shared/dial-context.js";
import { pushDialNameIcon } from "../../shared/dial-name-icon.js";
import type { DialPendingPreview } from "../../shared/dial-preview.js";
import { classifyDialReleaseForHost, dialPressShape, touchPressShape } from "../../shared/dial-release.js";
import { getReplayBusyLook, registerReplayBusySurface } from "../../shared/replay-busy-indicator.js";
import { replayBusyDialMark } from "../../shared/replay-busy-mark.js";
import {
  addMarkerAt,
  CONFIRMATION_FLASH_MS,
  deleteMarkerAt,
  followMarkerJump,
  jumpToMarkerFrame,
  type MarkerDirection,
  markerIndexAt,
  previewAddMarker,
  previewDeleteMarker,
  type ReplayContextResult,
  resolveJumpTarget,
  resolveMarkerJumpAnchor,
  walkMarkers,
} from "./replay-markers-ops.js";
import type { ReplayMarkersDialGesture, ReplayMarkersDialSettings } from "./replay-markers-settings.js";

/** The dash box's label. */
const DIAL_LABEL = "MARKERS";

/** The dash box's default accent — border, label and value, each overridable. */
const DIAL_ACCENT = "#3498db";

/** Background of the deck app's dial-slot name card (the keypad icons' panel colour). */
const NAME_CARD_BACKGROUND = "#2a3a4a";

/** The names the dial's jumps claim the replay cursor under (#1203). */
const CURSOR_OWNER: Record<MarkerDirection, string> = {
  next: "dial-next",
  previous: "dial-previous",
};

/** Per-context runtime state. In memory only. */
interface ReplayMarkersDialContext {
  action: IDeckActionContext;
  dial: ReplayMarkersDialSettings;
  /** Timestamp (ms) the current dial-button press started; 0 when no press is in progress. */
  pressStart: number;
  /** Whether the dial was turned while held during the current press: the release then fires nothing. */
  rotatedWhilePressed: boolean;
  /** The Added / Deleted confirmation on the value slot, or null. */
  flash: string | null;
  flashTimer: ReturnType<typeof setTimeout> | null;
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
   * on screen, so a state that goes back before the flush (a busy look that
   * ended inside the window) replaces the frame that is waiting instead of
   * leaving it to be drawn.
   */
  queuedSig: string | null;
  /** The dial's unregister from the replay busy indicator (#1437); null while not registered. */
  unregisterBusy: (() => void) | null;
}

/** A dash-box frame and the signature it is compared by. */
interface BuiltFrame {
  args: DialBoxArgs;
  sig: string;
}

/** What the dial surface needs from the owning action. */
export interface ReplayMarkersDialHost {
  readonly logger: ILogger;
  /** The replay context, read fresh: connection, store, telemetry and frame, and the SubSessionID scope. */
  readReplayContext(): ReplayContextResult;
  /** The latest telemetry, read live: a jump polls it while it waits for the pause and for the landing. */
  readTelemetry(): TelemetryData | null;
}

/** What Add from the car is captioned with, and what its hold preview reads; 0 s back carries no sign. */
function addCaption(secondsBack: number): string {
  return secondsBack === 0 ? "ADD 0 s" : `ADD −${secondsBack} s`;
}

/** Human-readable label for a gesture slot (for trigger descriptions). */
function gestureLabel(gesture: Exclude<ReplayMarkersDialGesture, "none">): string {
  return gesture === "add" ? "Add marker" : "Delete marker";
}

/**
 * @internal Exported for testing
 *
 * The encoder trigger descriptions for the current dial settings. The dial-button
 * long press has no SDK field of its own, so it rides on `push` as a
 * "(hold: …)" hint, as on every dial.
 */
export function buildTriggerDescription(dial: ReplayMarkersDialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = { rotate: "Next / previous marker" };
  const pushLabel = dial.pressAction === "none" ? undefined : gestureLabel(dial.pressAction);
  const holdLabel = dial.longPressAction === "none" ? undefined : gestureLabel(dial.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  if (dial.tapAction !== "none") description.touch = gestureLabel(dial.tapAction);

  if (dial.longTouchAction !== "none") description.longTouch = gestureLabel(dial.longTouchAction);

  return description;
}

/**
 * @internal Exported for testing
 *
 * What the dash box shows, without the colours: everything here goes into the
 * displayed signature, so a playing replay whose display does not change
 * pushes nothing.
 *
 * - no context (no store, no telemetry): the label alone, the whole box dimmed;
 * - `NONE` with no markers, `k / N` in a replay while marker *k*'s moment plays
 *   (at it, or up to 2 s past it), `N` otherwise;
 * - the side marks lit where a turn from `anchorFrame` would jump — the same
 *   {@link resolveJumpTarget} the rotation calls, so the screen cannot promise a
 *   jump the dial will not make (out of a replay neither is lit);
 * - from the car, a caption naming the press when it adds. "From the car" is
 *   the context's debounced `inReplay`, so the caption does not flash in the
 *   ~300 ms after each seek while `IsReplayPlaying` reads false.
 */
export function resolveDialView(
  context: ReplayContextResult,
  anchorFrame: number,
  dial: ReplayMarkersDialSettings,
): { value: string; sides: DialSideMarks; caption: string; dimmed: boolean } {
  if (!context.ok) return { value: "", sides: { left: false, right: false }, caption: "", dimmed: true };

  const { inReplay } = context;
  const markers = context.store.markers.list(context.scope);
  const sides = {
    left: resolveJumpTarget("previous", context, anchorFrame) !== null,
    right: resolveJumpTarget("next", context, anchorFrame) !== null,
  };
  const playing = inReplay ? markerIndexAt(markers, anchorFrame) : -1;
  let value = String(markers.length);

  if (markers.length === 0) {
    value = "NONE";
  } else if (playing !== -1) {
    value = `${playing + 1} / ${markers.length}`;
  }

  return {
    value,
    sides,
    caption: !inReplay && dial.pressAction === "add" ? addCaption(dial.secondsBack) : "",
    dimmed: false,
  };
}

/**
 * The dial surface of the Replay Markers action. One instance per action;
 * holds every dial context's state and all dial-side behaviour.
 */
export class ReplayMarkersDialSurface {
  private readonly contexts = new Map<string, ReplayMarkersDialContext>();
  /** Every push to a dial's screen goes through this: at most 10 per second per dial (rule 6). */
  private readonly renderThrottle = new IconUpdateThrottle();

  constructor(private readonly host: ReplayMarkersDialHost) {}

  async willAppear(action: IDeckActionContext, dial: ReplayMarkersDialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The deck-app image for the dial slot: the action name (#775); strip only.
    pushDialNameIcon(
      action,
      { line1: "REPLAY", line2: "MARKERS", backgroundColor: NAME_CARD_BACKGROUND },
      this.host.logger,
    );
    this.registerBusy(ctx);
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx, true);
  }

  willDisappear(actionId: string): void {
    const ctx = this.contexts.get(actionId);

    if (!ctx) return;

    // The context is going away: no revert frame for the preview, no flash end, no busy look.
    ctx.holdPreview.dispose();
    this.clearFlash(ctx);
    ctx.unregisterBusy?.();
    ctx.unregisterBusy = null;
    this.renderThrottle.clear(actionId);
    this.contexts.delete(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, dial: ReplayMarkersDialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    this.registerBusy(ctx);
    // The long-press gesture may have changed mid-hold: drop a preview computed
    // for the old one without a frame of its own — the render below is the revert.
    ctx.holdPreview.dispose();
    ctx.preview = null;
    this.clearFlash(ctx);
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx, true);
  }

  /**
   * Registers the dial with the replay busy indicator (#1437) under its
   * context id, the token its detents' jumps carry. A detent is a jump, so the
   * box draws working; Add and Delete send no replay command. The indicator's
   * redraw goes through {@link scheduleIfChanged}, so the throttle stays in
   * front of it and a tick whose look draws the same frame pushes nothing.
   */
  private registerBusy(ctx: ReplayMarkersDialContext): void {
    if (ctx.unregisterBusy !== null) return;

    ctx.unregisterBusy = registerReplayBusySurface({
      token: ctx.action.id,
      drawsWorking: true,
      redraw: () => {
        if (this.contexts.get(ctx.action.id) === ctx) this.scheduleIfChanged(ctx);
      },
    });
  }

  /**
   * A turn: one marker per detent from where the keypad's Next / Previous
   * would land (the shared walk's first step, {@link resolveJumpTarget}), no
   * per-event cap, stopping at the end of the list; one jump per event, to
   * the last marker reached. The jump is started here and
   * finishes on its own ({@link followMarkerJump}), drawing nothing when it
   * does: the screen follows the replay through {@link onTick}. A further
   * detent before it has landed takes the cursor from it and steps on from its
   * marker. Push + turn is a plain turn — it only marks the press so its
   * release fires nothing.
   */
  rotate(action: IDeckActionContext, dial: ReplayMarkersDialSettings, ticks: number, pressed: boolean): void {
    const ctx = this.inputContext(action, dial, "rotate");

    if (!ctx) return;

    if (pressed) {
      ctx.rotatedWhilePressed = true;
      // The release will fire nothing, so a showing preview goes at once (#1120).
      ctx.holdPreview.rotated();
    }

    if (ticks === 0) return;

    const direction: MarkerDirection = ticks > 0 ? "next" : "previous";
    const context = this.host.readReplayContext();

    if (!context.ok) {
      this.host.logger.debug(`Dial ${direction}: ${context.reason}; ignoring`);

      return;
    }

    // The replay's pending target (#1230, #1430): a jump any surface sent
    // that the replay has not reached yet.
    const anchor = resolveMarkerJumpAnchor(context.frame, context.telemetry);
    const first = resolveJumpTarget(direction, context, anchor);

    if (!first) {
      this.host.logger.debug(
        context.inReplay
          ? `Dial ${direction}: no marker that way (anchor=${anchor})`
          : `Dial ${direction}: replay not playing, and iRacing ignores replay commands from the car`,
      );

      return;
    }

    const target = walkMarkers(context.store.markers.list(context.scope), first, direction, Math.abs(ticks));
    // Takes the replay cursor and records the target before it returns, so
    // the render below and the next detent both read it; a paused replay has
    // its seek by then too. A Replay Markers detent carries the dial's own
    // origin token (#1430).
    const jump = jumpToMarkerFrame(
      CURSOR_OWNER[direction],
      target.frame,
      () => this.host.readTelemetry(),
      Date.now(),
      ctx.action.id,
    );
    this.host.logger.info(`Dial jumped to ${direction} marker`);
    this.host.logger.debug(`ticks=${ticks}, anchor=${anchor}, target=${target.frame}`);
    followMarkerJump(this.host.logger, `Dial ${direction} marker`, target.frame, jump);
    this.scheduleRender(ctx);
  }

  /**
   * The press shape of a dial press (#269): released, with the gestures the
   * release fires and the threshold it classifies with, or `none` when no
   * context would take the press. `down` and `touchTap` refresh the context from these settings, so they are the ones the release and the touch read.
   */
  pressShape(action: IDeckActionContext, dial: ReplayMarkersDialSettings): PressShape {
    if (!this.contexts.has(action.id)) return { kind: "none" };

    return dialPressShape({
      pressGesture: dial.pressAction,
      longPressGesture: dial.longPressAction,
      thresholdMs: getDualPressThresholdMs(),
    });
  }

  /** The press shape of a touch (#269): the slot `touchTap` fires for it, or `none`. */
  touchShape(action: IDeckActionContext, dial: ReplayMarkersDialSettings, hold: boolean): PressShape {
    if (!this.contexts.has(action.id)) return { kind: "none" };

    return touchPressShape({ tapGesture: dial.tapAction, longTouchGesture: dial.longTouchAction, hold });
  }

  down(action: IDeckActionContext, dial: ReplayMarkersDialSettings): void {
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

    if (!ctx) return;

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

    this.host.logger.info(kind === "long" ? "Replay markers dial long-pressed" : "Replay markers dial pressed");
    this.runGesture(ctx, gesture);
  }

  touchTap(action: IDeckActionContext, dial: ReplayMarkersDialSettings, hold: boolean): void {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__) return;

    const ctx = this.inputContext(action, dial, "touchTap");

    if (!ctx) return;

    // hold → the Long Touch slot; a plain tap → Tap Display.
    const gesture = hold ? ctx.dial.longTouchAction : ctx.dial.tapAction;

    if (gesture === "none") return;

    this.host.logger.info(hold ? "Replay markers dial long touch" : "Replay markers dial tap");
    this.runGesture(ctx, gesture);
  }

  /**
   * Per SDK tick: settle a landed jump, and redraw only when what the screen
   * shows would change — a playing replay with an unchanged display pushes
   * nothing. A changed tick hands the frame it built to the flush, so it is
   * built once.
   */
  onTick(actionId: string): void {
    const ctx = this.contexts.get(actionId);

    if (ctx) this.scheduleIfChanged(ctx);
  }

  /**
   * Queues a push when what the dial would show differs from what it shows,
   * or from a built frame already waiting in the throttle. The frame is built
   * once and handed to the flush.
   */
  private scheduleIfChanged(ctx: ReplayMarkersDialContext): void {
    if (!ctx.action.dialCanvas()) return;

    const frame = this.buildFrame(ctx, this.host.readReplayContext());

    if (frame.sig !== (ctx.queuedSig ?? ctx.lastRenderSig)) this.scheduleRender(ctx, false, frame);
  }

  /** Runs Add or Delete with the keypad's own operations; a press that changes nothing shows nothing. */
  private runGesture(ctx: ReplayMarkersDialContext, gesture: Exclude<ReplayMarkersDialGesture, "none">): void {
    const context = this.host.readReplayContext();

    if (!context.ok) {
      this.host.logger.debug(`Dial ${gesture}: ${context.reason}; ignoring`);

      return;
    }

    if (gesture === "add") {
      const { marker, added } = addMarkerAt(context, ctx.dial.secondsBack);
      this.host.logger.info(added ? "Marker added" : "Marker not added");
      this.host.logger.debug(`frame=${marker.frame} current=${context.frame} secondsBack=${ctx.dial.secondsBack}`);

      if (added) {
        const markers = context.store.markers.list(context.scope);
        const k = markers.findIndex((m) => m.frame === marker.frame) + 1;
        this.flash(ctx, `ADDED ${k} / ${markers.length}`);
      }

      return;
    }

    const removed = deleteMarkerAt(context, ctx.dial.deleteWindow);
    this.host.logger.info(removed ? "Marker deleted" : "No marker near the current frame");
    this.host.logger.debug(`current=${context.frame} removed=${removed?.frame ?? "none"}`);

    if (removed) this.flash(ctx, "DELETED");
  }

  /**
   * The long-press outcome, when it is knowable: the marker Delete would
   * remove, or the marker Add would store. Null when the release would do
   * nothing — no marker within the window, a duplicate Add — and when there is
   * no telemetry, which previews nothing rather than a default (#1120, trap 2).
   */
  private resolvePreview(ctx: ReplayMarkersDialContext): DialPendingPreview | null {
    const gesture = ctx.dial.longPressAction;

    if (gesture === "none") return null;

    const context = this.host.readReplayContext();

    if (!context.ok) return null;

    const color = resolveDialBoxColors(ctx.dial.colors, DIAL_ACCENT).value;

    if (gesture === "add") {
      return previewAddMarker(context, ctx.dial.secondsBack) ? { text: addCaption(ctx.dial.secondsBack), color } : null;
    }

    const target = previewDeleteMarker(context, ctx.dial.deleteWindow);

    if (!target) return null;

    const markers = context.store.markers.list(context.scope);
    const k = markers.findIndex((m) => m.frame === target.frame) + 1;

    return { text: `DELETE ${k} / ${markers.length}`, color };
  }

  /** The hold-preview threshold callback: draws the outcome and says whether it did. Fires nothing. */
  private showHoldPreview(ctx: ReplayMarkersDialContext): boolean {
    const preview = this.resolvePreview(ctx);

    if (!preview) return false;

    ctx.preview = preview;
    this.host.logger.debug(`Replay markers dial hold preview: ${preview.text}`);
    this.scheduleRender(ctx);

    return true;
  }

  /** The hold-preview cancel callback: back to the normal screen. */
  private revertHoldPreview(ctx: ReplayMarkersDialContext): void {
    ctx.preview = null;
    this.scheduleRender(ctx);
  }

  private flash(ctx: ReplayMarkersDialContext, text: string): void {
    this.clearFlash(ctx);
    ctx.flash = text;
    ctx.flashTimer = setTimeout(() => {
      ctx.flashTimer = null;
      ctx.flash = null;
      this.scheduleRender(ctx);
    }, CONFIRMATION_FLASH_MS);
    this.scheduleRender(ctx);
  }

  private clearFlash(ctx: ReplayMarkersDialContext): void {
    if (ctx.flashTimer !== null) clearTimeout(ctx.flashTimer);

    ctx.flashTimer = null;
    ctx.flash = null;
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
    dial: ReplayMarkersDialSettings,
    event: DialInputEvent,
  ): ReplayMarkersDialContext | undefined {
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
  private ensureContext(action: IDeckActionContext, dial: ReplayMarkersDialSettings): ReplayMarkersDialContext {
    const existing = this.contexts.get(action.id);

    if (existing) {
      existing.action = action;
      existing.dial = dial;

      return existing;
    }

    const created: ReplayMarkersDialContext = {
      action,
      dial,
      pressStart: 0,
      rotatedWhilePressed: false,
      flash: null,
      flashTimer: null,
      preview: null,
      holdPreview: NOOP_HOLD_PREVIEW,
      lastRenderSig: null,
      queuedSig: null,
      unregisterBusy: null,
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

  /** The dash-box arguments for the current state; `pending` and the flash ride every render. */
  private boxArgs(ctx: ReplayMarkersDialContext, context: ReplayContextResult): DialBoxArgs {
    const anchor = context.ok ? resolveMarkerJumpAnchor(context.frame, context.telemetry) : 0;
    const view = resolveDialView(context, anchor, ctx.dial);
    const value = ctx.flash ?? view.value;
    // The busy look (#1437), part of the signature as kind and position: the
    // caption's text (Add's, from the car) stays beside it.
    const mark = ctx.unregisterBusy === null ? undefined : replayBusyDialMark(getReplayBusyLook(ctx.action.id));

    return {
      abbr: DIAL_LABEL,
      value,
      colors: resolveDialBoxColors(ctx.dial.colors, DIAL_ACCENT),
      // A dimmed box with an empty value slot enlarges its label into that
      // space, where the side marks would overlap it: draw none there.
      ...(view.dimmed && value === "" ? {} : { sideMarker: view.sides }),
      caption: view.caption,
      dimmed: view.dimmed,
      pending: ctx.preview,
      ...(mark ? { captionMark: mark } : {}),
    };
  }

  /**
   * The frame for the current state and its signature — built from what is
   * displayed, never the raw replay frame, so an unchanged display is
   * recognised as such.
   */
  private buildFrame(ctx: ReplayMarkersDialContext, context: ReplayContextResult): BuiltFrame {
    const args = this.boxArgs(ctx, context);

    return { args, sig: JSON.stringify(args) };
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
  private scheduleRender(ctx: ReplayMarkersDialContext, force = false, built?: BuiltFrame): void {
    if (force) ctx.lastRenderSig = null;

    // Set before the schedule: outside its window the throttle flushes at once.
    ctx.queuedSig = built?.sig ?? null;
    this.renderThrottle.schedule(ctx.action.id, () => this.renderIfChanged(ctx, built));
  }

  private async renderIfChanged(ctx: ReplayMarkersDialContext, built?: BuiltFrame): Promise<void> {
    // The throttle runs only the latest schedule, so nothing is waiting any more.
    ctx.queuedSig = null;

    // A context that went away (or was replaced) since the schedule draws nothing.
    if (this.contexts.get(ctx.action.id) !== ctx) return;

    // The dial's own screen decides the drawing; none, nothing to draw (#1013).
    const canvas = ctx.action.dialCanvas();

    if (!canvas) return;

    const { args, sig } = built ?? this.buildFrame(ctx, this.host.readReplayContext());

    if (sig === ctx.lastRenderSig) return;

    ctx.lastRenderSig = sig;

    try {
      await ctx.action.setDialCanvas(svgToDataUri(renderDialBox(canvas, args)));
    } catch (err) {
      // Pushes run from timers with no caller left to catch a rejection; the
      // next tick retries, since this frame never reached the screen.
      ctx.lastRenderSig = null;
      this.host.logger.debug(`Replay markers dial render failed: ${String(err)}`);
    }
  }

  /** Pushes the encoder trigger descriptions (Elgato only). */
  private async applyTriggerDescription(ctx: ReplayMarkersDialContext): Promise<void> {
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }
}
