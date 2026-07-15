/**
 * The dial (encoder) surface of Camera Controls (issue #803).
 *
 * On a Stream Deck+ dial, rotation cycles the camera or the focused car — the
 * dial's `mode` selects the target (camera / sub-camera / car / driving) and
 * the turn direction replaces the keypad cycle modes' explicit next/previous
 * setting (clockwise = next, counter-clockwise = previous). The touch strip
 * shows the LIVE camera focus: the focused car number (from `CamCarIdx` + the
 * session driver list) and the active camera group name (from `CamGroupNumber`
 * + the session YAML `CameraInfo`), falling back to a mode-identity label when
 * out of a session.
 *
 * Everything the dial does is an iRacing SDK camera command, so — unlike the
 * Setup dials — the surface taps no key bindings and never shows a
 * missing-binding warning. It reuses the keypad's own cycle / focus dispatch
 * through the host interface rather than duplicating any camera logic.
 */
import {
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import {
  type CameraGroup,
  getCameraGroupsFromSessionInfo,
  getCarNumberFromSessionInfo,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { z } from "zod";

import { dialAppearanceFields, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";

/**
 * Minimum gap (ms) between change-driven feedback pushes. Cycling a car or a
 * camera moves `CamCarIdx` / `CamGroupNumber`, and the strip re-renders the
 * moment the readout changes — but no more than once per this window so a burst
 * of telemetry can't exceed the documented ≤10 `setFeedback`/sec/dial cap
 * (mirrors the Setup Brakes dial).
 */
const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

/** The cycle target the dial rotates through — mirrors the keypad cycle modes. */
export const DIAL_MODES = ["camera", "sub-camera", "car", "driving"] as const;
export type DialMode = (typeof DIAL_MODES)[number];

/**
 * The keypad `target` value each dial mode maps to. The surface routes rotation
 * through the host's `cycle` delegate (the keypad's own `executeCycle`), so it
 * never duplicates the camera dispatch.
 */
export type DialCycleTarget = "cycle-camera" | "cycle-sub-camera" | "cycle-car" | "cycle-driving";

const MODE_TO_TARGET: Record<DialMode, DialCycleTarget> = {
  camera: "cycle-camera",
  "sub-camera": "cycle-sub-camera",
  car: "cycle-car",
  driving: "cycle-driving",
};

/** Rotation direction; clockwise (`ticks > 0`) advances, counter-clockwise goes back. */
export type Direction = "next" | "previous";

/**
 * The actions a dial-button / touch gesture (Push, Long Press, Tap Display,
 * Long Touch) can run, plus the "none" sentinel. Both real gestures reuse the
 * keypad's own iRacing API dispatch: `focus-my-car` centers the camera on the
 * player's car (the keypad Focus Your Car mode); `change-camera` switches to
 * the next camera angle (the keypad Cycle Camera dispatch).
 */
export const GESTURE_ACTIONS = ["none", "focus-my-car", "change-camera"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

/** Fallback identity label drawn when no live focus is available (out of session). */
const MODE_IDENTITY: Record<DialMode, string> = {
  camera: "CAMERA",
  "sub-camera": "SUB CAM",
  car: "CAR",
  driving: "DRIVING",
};

/**
 * Per-mode accent for the dash box's border / label / value (the DEFAULT color,
 * each independently overridable per dial, issue #811) so multiple camera dials
 * stay distinguishable at a glance.
 */
const MODE_COLOR: Record<DialMode, string> = {
  camera: "#3498db",
  "sub-camera": "#9b59b6",
  car: "#2ecc71",
  driving: "#e67e22",
};

/** Friendly mode name for the encoder trigger description ("Cycle …"). */
const MODE_LABEL: Record<DialMode, string> = {
  camera: "Cameras",
  "sub-camera": "Sub-Cameras",
  car: "Cars",
  driving: "Driving Cameras",
};

/**
 * Dial-surface settings, stored under the `dial` root key. All fields default,
 * so a keypad-only instance (or a fresh dial) parses `{}` to a full object.
 */
export const DialSettings = z
  .object({
    // Which cycle target rotation drives. Default "car" — the marquee
    // broadcast/spectate flip-through-the-field use case (issue #803).
    mode: z.enum(DIAL_MODES).default("car"),
    // Push (short press) — fires on dialUp. Default None (blind-safe rule).
    pressAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Long Press (held dial button past the threshold, no rotation) — fires on dialUp.
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Tap Display (touch-strip tap, hold === false). Default None for VR safety.
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Long Touch (touch-strip tap, hold === true). Default None for VR safety.
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

/** The live camera-focus readout resolved from telemetry + the session YAML. */
export interface FocusReadout {
  /** Active camera group name (from `CamGroupNumber` + `CameraInfo`), or null. */
  groupName: string | null;
  /** Focused car's display number (from `CamCarIdx` + the driver list), or null. */
  carNumber: string | null;
}

/**
 * @internal Exported for testing
 *
 * Resolves the focused car number and camera group name from the live camera
 * telemetry (`CamCarIdx` / `CamGroupNumber`) against the session driver list
 * and camera-group list. Every field independently degrades to `null` when its
 * source is unavailable (out of session, missing driver, unknown group).
 */
export function computeFocusReadout(telemetry: TelemetryData | null, sessionInfo: unknown): FocusReadout {
  if (!telemetry) return { groupName: null, carNumber: null };

  const groups: CameraGroup[] = getCameraGroupsFromSessionInfo(sessionInfo);
  const camGroup = telemetry.CamGroupNumber;
  const groupName =
    typeof camGroup === "number" ? (groups.find((g) => g.groupNum === camGroup)?.groupName ?? null) : null;

  const camCarIdx = telemetry.CamCarIdx;
  const carNumber =
    typeof camCarIdx === "number" && camCarIdx >= 0 ? getCarNumberFromSessionInfo(sessionInfo, camCarIdx) : null;

  return { groupName, carNumber };
}

/**
 * @internal Exported for testing
 *
 * The dash-box label + value for the current focus. With a live focus the label
 * is the camera group name and the value is the `#`-prefixed car number; with no
 * live data the label falls back to the mode identity and the value is empty
 * (the identity-only, label-only box).
 */
export function formatReadout(
  mode: DialMode,
  telemetry: TelemetryData | null,
  sessionInfo: unknown,
): { label: string; value: string } {
  const { groupName, carNumber } = computeFocusReadout(telemetry, sessionInfo);

  return {
    label: groupName ? groupName.toUpperCase() : MODE_IDENTITY[mode],
    value: carNumber ? `#${carNumber}` : "",
  };
}

/** Human-readable label for a gesture slot (for the trigger description). */
function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "focus-my-car":
      return "Focus My Car";
    case "change-camera":
      return "Change Camera";
    case "none":
      return undefined;
  }
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current dial settings.
 * `rotate` names the cycled target; `push` carries the press action with the
 * long-press as a "(hold: …)" hint; `touch` / `longTouch` carry the touch-strip
 * gestures.
 */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: `Cycle ${MODE_LABEL[dial.mode]}`,
  };

  const pushLabel = gestureLabel(dial.pressAction);
  const holdLabel = gestureLabel(dial.longPressAction);

  if (pushLabel && holdLabel) {
    description.push = `${pushLabel} (hold: ${holdLabel})`;
  } else if (pushLabel) {
    description.push = pushLabel;
  } else if (holdLabel) {
    description.push = `Hold: ${holdLabel}`;
  }

  const tapLabel = gestureLabel(dial.tapAction);

  if (tapLabel) {
    description.touch = tapLabel;
  }

  const longTouchLabel = gestureLabel(dial.longTouchAction);

  if (longTouchLabel) {
    description.longTouch = longTouchLabel;
  }

  return description;
}

/** Per-context runtime state. */
interface CameraDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  /** Timestamp (ms) the current dial-button press started (dialDown). */
  pressStart: number;
  /**
   * Whether the dial was rotated while the button was held during the current
   * press. Set in rotate (pressed === true), read once at dialUp so a
   * push+turn cycles without also firing the press gesture on release.
   */
  rotatedWhilePressed: boolean;
  /** Signature of the DISPLAYED readout at the last change-driven render. */
  lastRenderSig: string | null;
  /** Timestamp (ms) of the last change-driven feedback push (throttle gate). */
  lastChangeRenderAt: number;
}

/**
 * The delegates the surface needs from its owning action. Camera cycling and
 * focus stay on the action (the SDK camera commands), so the dial reuses the
 * SAME dispatch as the keypad rather than duplicating it. Deliberately NO
 * `setActiveBinding` / `tapBinding`: the surface issues no key bindings, and
 * readiness state is one value per action-class instance that a dial context
 * would bleed onto the keypad buttons (see global-settings.md).
 */
export interface CameraDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  getSessionInfo(): unknown;
  /** Cycle the given target one step (the keypad's own `executeCycle`). */
  cycle(target: DialCycleTarget, direction: Direction): void;
  /** Center the camera on the player's car (the keypad Focus Your Car mode). */
  focusMyCar(): void;
  /** Switch to the next camera angle (the keypad Cycle Camera dispatch). */
  changeCamera(): void;
}

/**
 * Owns all per-dial-context state, dispatches rotations and gestures, and
 * renders the touch-strip focus readout. The owning action routes every dial
 * lifecycle/input event here and forwards telemetry ticks per subscribed
 * context.
 */
export class CameraDialSurface {
  private readonly contextsState = new Map<string, CameraDialContext>();

  constructor(private readonly host: CameraDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    // The deck-app image for the dial: just the action name. Without this the
    // app falls back to keypad iconography for the dial slot.
    action
      .setImage(renderDialNameIcon({ line1: "CAMERA", line2: "CONTROLS", backgroundColor: "#2a3a4a" }))
      .catch((err) => {
        this.host.logger.debug(`Dial name icon push failed: ${String(err)}`);
      });

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  willDisappear(actionId: string): void {
    this.contextsState.delete(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);
    // Bust the memo so the next render reflects the new mode even if it happens
    // to format to the same readout string as the previous one.
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): void {
    const ctx = this.ensureContext(action, dial);

    if (ticks === 0) return;

    // A pressed rotation still cycles; the guard makes the dialUp classifier
    // skip the press gesture so holding-and-turning never also fires it. The
    // readout settles a beat later from telemetry.
    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    // One cycle step per rotate event (direction from the tick sign). The camera
    // cycle commands compute the next car/group from the CURRENT telemetry, which
    // only advances after a sim tick — so re-issuing them N times in one event
    // would re-target the same next car/group, not step N. Reusing the keypad's
    // single-step `executeCycle` (the #803 mandate: reuse, don't duplicate) makes
    // one detent = one step; a continued spin arrives as further rotate events.
    const direction: Direction = ticks > 0 ? "next" : "previous";
    this.host.cycle(MODE_TO_TARGET[dial.mode], direction);
    this.host.logger.info("Camera dial rotated");
    this.host.logger.debug(`${dial.mode} ${direction}`);
  }

  down(action: IDeckActionContext, dial: DialSettings): void {
    const ctx = this.ensureContext(action, dial);

    // Record the press start and clear the push+turn guard. Fire nothing and
    // start no timer — press vs long-press is classified once at dialUp.
    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    // Consume the press start immediately so a stray dialUp without a preceding
    // dialDown can't reclassify. A 0 sentinel means "no press in progress".
    const pressStartMs = ctx.pressStart;
    ctx.pressStart = 0;

    if (pressStartMs === 0) return;

    const kind = classifyDialRelease({
      pressStartMs,
      nowMs: Date.now(),
      rotatedWhilePressed: ctx.rotatedWhilePressed,
      thresholdMs: getDualPressThresholdMs(),
    });

    if (kind === "push-turn") return;

    const gesture = kind === "long" ? ctx.dial.longPressAction : ctx.dial.pressAction;

    if (gesture === "none") return;

    this.host.logger.info(kind === "long" ? "Camera dial long-pressed" : "Camera dial pressed");
    this.doGesture(gesture);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    // hold === true → Long Touch slot; hold === false → Tap Display slot.
    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Camera dial long touch" : "Camera dial tap");
    this.doGesture(gesture);
  }

  onTelemetry(actionId: string, _telemetry: TelemetryData | null): void {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    const sig = this.displayedSignature(ctx);

    if (sig === ctx.lastRenderSig) return;

    // Changed but feedback-throttled: do nothing and do NOT advance
    // lastRenderSig, so the throttled feedback still fires next window.
    if (Date.now() - ctx.lastChangeRenderAt < CHANGE_RENDER_MIN_INTERVAL_MS) return;

    // Advance the baseline SYNCHRONOUSLY before the async render: 60 Hz ticks
    // arriving while the setFeedback push is still in flight would otherwise each
    // fire another push inside the same 100 ms window, defeating the ≤10
    // setFeedback/sec/dial throttle.
    ctx.lastRenderSig = sig;
    ctx.lastChangeRenderAt = Date.now();
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial feedback render failed: ${String(err)}`);
    });
  }

  /**
   * Re-renders every dial context (readout memo busted). Called by the owning
   * action on global-settings changes so a dash-box appearance edit (issue #811)
   * redraws the strip even while iRacing is offline (no telemetry ticks arrive).
   */
  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      ctx.lastRenderSig = null;
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): CameraDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = {
        dial,
        action,
        pressStart: 0,
        rotatedWhilePressed: false,
        lastRenderSig: null,
        lastChangeRenderAt: 0,
      };
      this.contextsState.set(action.id, ctx);
    } else {
      ctx.action = action;
      ctx.dial = dial;
    }

    return ctx;
  }

  /** Runs a configured press / touch gesture through the keypad's own dispatch. */
  private doGesture(gesture: GestureSlot): void {
    switch (gesture) {
      case "focus-my-car":
        this.host.logger.info("Camera dial focus my car");
        this.host.focusMyCar();

        return;
      case "change-camera":
        this.host.logger.info("Camera dial change camera");
        this.host.changeCamera();

        return;
      case "none":
        return;
    }
  }

  /** A compact signature of the displayed readout; a feedback push is due when it changes. */
  private displayedSignature(ctx: CameraDialContext): string {
    const { label, value } = formatReadout(ctx.dial.mode, this.host.getTelemetry(), this.host.getSessionInfo());

    return [ctx.dial.mode, label, value].join("|");
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: CameraDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  /** Pushes the touch-strip feedback (the full-cell focus dash box) when this is a dial. */
  private async renderFeedback(ctx: CameraDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const { label, value } = formatReadout(ctx.dial.mode, this.host.getTelemetry(), this.host.getSessionInfo());
    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      abbr: label,
      value,
      colors: resolveDialBoxColors(ctx.dial.colors, MODE_COLOR[ctx.dial.mode]),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    // Reset the change-detector baseline so this pushed feedback doesn't
    // immediately re-fire the render-on-change path on the next telemetry tick.
    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
