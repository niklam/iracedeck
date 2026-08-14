/**
 * The dial surface of the Setup Chassis action (issue #800) — the dual-surface
 * pattern (Fuel Service #759 / Setup Brakes #775), behind a host interface.
 * Coexists with the keypad "paired adjust key styles" feature (#810).
 *
 * Self-contained leaf (owns the `dial` schema + dial key bindings; operates on
 * the `dial` sub-object). Rotating adjusts one of the 13 chassis setup values
 * via the same key bindings as the keypad surface; the touch strip shows the
 * live value. Setup Chassis has no natural toggle, so no press gesture is
 * offered.
 *
 * Four settings (the four shocks) have no telemetry, so they render label-only
 * via the dash box's identity-only branch (#782). The seven diff/ARB/
 * power-steering settings show the live `dc*` value, and the LR/RR springs
 * show the pending next-pit-stop offset from `dpWeightJacker*` (#953).
 */
import {
  classifyDialRelease,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  getDualPressThresholdMs,
  type IDeckActionContext,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import z from "zod";

import { dialAppearanceFields, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import { formatViewValue, type ViewSettingId } from "../../shared/setup-view.js";

const CHANGE_RENDER_MIN_INTERVAL_MS = 100;

export const ROTATION_SETTINGS = [
  "differential-preload",
  "differential-entry",
  "differential-middle",
  "differential-exit",
  "front-arb",
  "rear-arb",
  "lr-spring",
  "rr-spring",
  "lf-shock",
  "rf-shock",
  "lr-shock",
  "rr-shock",
  "power-steering",
] as const;
export type SetupChassisDialSetting = (typeof ROTATION_SETTINGS)[number];

/** Setup Chassis has no natural toggle gesture, so `none` is the only option. */
export const GESTURE_ACTIONS = ["none"] as const;
export type GestureSlot = (typeof GESTURE_ACTIONS)[number];

export type SetupChassisDirection = "increase" | "decrease";

const DIAL_ROTATION_KEYS: Record<string, string> = {
  "differential-preload-increase": "setupChassisDifferentialPreloadIncrease",
  "differential-preload-decrease": "setupChassisDifferentialPreloadDecrease",
  "differential-entry-increase": "setupChassisDifferentialEntryIncrease",
  "differential-entry-decrease": "setupChassisDifferentialEntryDecrease",
  "differential-middle-increase": "setupChassisDifferentialMiddleIncrease",
  "differential-middle-decrease": "setupChassisDifferentialMiddleDecrease",
  "differential-exit-increase": "setupChassisDifferentialExitIncrease",
  "differential-exit-decrease": "setupChassisDifferentialExitDecrease",
  "front-arb-increase": "setupChassisFrontArbIncrease",
  "front-arb-decrease": "setupChassisFrontArbDecrease",
  "rear-arb-increase": "setupChassisRearArbIncrease",
  "rear-arb-decrease": "setupChassisRearArbDecrease",
  "lr-spring-increase": "setupChassisLrSpringIncrease",
  "lr-spring-decrease": "setupChassisLrSpringDecrease",
  "rr-spring-increase": "setupChassisRrSpringIncrease",
  "rr-spring-decrease": "setupChassisRrSpringDecrease",
  "lf-shock-increase": "setupChassisLfShockIncrease",
  "lf-shock-decrease": "setupChassisLfShockDecrease",
  "rf-shock-increase": "setupChassisRfShockIncrease",
  "rf-shock-decrease": "setupChassisRfShockDecrease",
  "lr-shock-increase": "setupChassisLrShockIncrease",
  "lr-shock-decrease": "setupChassisLrShockDecrease",
  "rr-shock-increase": "setupChassisRrShockIncrease",
  "rr-shock-decrease": "setupChassisRrShockDecrease",
  "power-steering-increase": "setupChassisPowerSteeringIncrease",
  "power-steering-decrease": "setupChassisPowerSteeringDecrease",
};

export function rotationKey(setting: SetupChassisDialSetting, direction: SetupChassisDirection): string | undefined {
  return DIAL_ROTATION_KEYS[`${setting}-${direction}`];
}

export const DialSettings = z
  .object({
    setting: z.enum(ROTATION_SETTINGS).default("differential-preload"),
    pressAction: z.enum(GESTURE_ACTIONS).default("none"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none"),
    // Dash-box appearance overrides (colors, issue #811).
    ...dialAppearanceFields,
  })
  .prefault({});

export type DialSettings = z.infer<typeof DialSettings>;

export function seedDialFromLegacySetting(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  if (obj.dial !== undefined) return null;

  const legacy = obj.setting;

  if (typeof legacy !== "string" || !(ROTATION_SETTINGS as readonly string[]).includes(legacy)) return null;

  return { ...obj, dial: { setting: legacy } };
}

/** The shocks have no `view-*` entry (no telemetry readback) → identity-only. */
const VIEW_ID: Record<SetupChassisDialSetting, ViewSettingId | undefined> = {
  "differential-preload": "view-diff-preload",
  "differential-entry": "view-diff-entry",
  "differential-middle": "view-diff-middle",
  "differential-exit": "view-diff-exit",
  "front-arb": "view-anti-roll-front",
  "rear-arb": "view-anti-roll-rear",
  "lr-spring": "view-lr-spring-offset",
  "rr-spring": "view-rr-spring-offset",
  "lf-shock": undefined,
  "rf-shock": undefined,
  "lr-shock": undefined,
  "rr-shock": undefined,
  "power-steering": "view-power-steering",
};

const MODE_ABBR: Record<SetupChassisDialSetting, string> = {
  "differential-preload": "PRELD",
  "differential-entry": "D-IN",
  "differential-middle": "D-MID",
  "differential-exit": "D-OUT",
  "front-arb": "FARB",
  "rear-arb": "RARB",
  "lr-spring": "LRSPR",
  "rr-spring": "RRSPR",
  "lf-shock": "LF",
  "rf-shock": "RF",
  "lr-shock": "LR",
  "rr-shock": "RR",
  "power-steering": "PWR",
};

const MODE_COLOR: Record<SetupChassisDialSetting, string> = {
  "differential-preload": "#3498db",
  "differential-entry": "#3498db",
  "differential-middle": "#3498db",
  "differential-exit": "#3498db",
  "front-arb": "#e67e22",
  "rear-arb": "#e67e22",
  "lr-spring": "#2ecc71",
  "rr-spring": "#2ecc71",
  "lf-shock": "#9b59b6",
  "rf-shock": "#9b59b6",
  "lr-shock": "#9b59b6",
  "rr-shock": "#9b59b6",
  "power-steering": "#f39c12",
};

const MODE_LABEL: Record<SetupChassisDialSetting, string> = {
  "differential-preload": "Diff Preload",
  "differential-entry": "Diff Entry",
  "differential-middle": "Diff Middle",
  "differential-exit": "Diff Exit",
  "front-arb": "Front ARB",
  "rear-arb": "Rear ARB",
  "lr-spring": "LR Spring",
  "rr-spring": "RR Spring",
  "lf-shock": "LF Shock",
  "rf-shock": "RF Shock",
  "lr-shock": "LR Shock",
  "rr-shock": "RR Shock",
  "power-steering": "Power Steering",
};

/** @internal Exported for testing */
export function formatDialValue(setting: SetupChassisDialSetting, telemetry: TelemetryData | null): string {
  const viewId = VIEW_ID[setting];

  if (!viewId) return "";

  return formatViewValue(viewId, telemetry).replace(/%$/, "");
}

/** @internal Exported for testing */
export function buildTriggerDescription(dial: DialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = {
    rotate: `Adjust ${MODE_LABEL[dial.setting]}`,
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

function gestureLabel(action: GestureSlot): string | undefined {
  switch (action) {
    case "none":
      return undefined;
  }
}

interface SetupChassisDialContext {
  dial: DialSettings;
  action: IDeckActionContext;
  pressStart: number;
  rotatedWhilePressed: boolean;
  lastRenderSig: string | null;
  lastChangeRenderAt: number;
}

export interface SetupChassisDialHost {
  readonly logger: ILogger;
  getTelemetry(): TelemetryData | null;
  tapBinding(settingKey: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

export class SetupChassisDialSurface {
  private readonly contextsState = new Map<string, SetupChassisDialContext>();

  constructor(private readonly host: SetupChassisDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    action
      .setImage(renderDialNameIcon({ line1: "SETUP", line2: "CHASSIS", backgroundColor: "#3a1a2a" }))
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
    ctx.lastRenderSig = null;

    await this.applyTriggerDescription(ctx);
    await this.renderFeedback(ctx);
  }

  async rotate(action: IDeckActionContext, dial: DialSettings, ticks: number, pressed: boolean): Promise<void> {
    const ctx = this.ensureContext(action, dial);

    if (pressed) {
      ctx.rotatedWhilePressed = true;
    }

    const direction: SetupChassisDirection = ticks > 0 ? "increase" : "decrease";
    await this.dispatchRotation(ctx, direction);
  }

  down(action: IDeckActionContext, dial: DialSettings): void {
    const ctx = this.ensureContext(action, dial);

    ctx.pressStart = Date.now();
    ctx.rotatedWhilePressed = false;
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

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

    const action = kind === "long" ? ctx.dial.longPressAction : ctx.dial.pressAction;

    if (action === "none") return;

    this.host.logger.info(kind === "long" ? "Setup chassis dial long-pressed" : "Setup chassis dial pressed");
    await this.doGesture(action);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    const gesture = hold ? dial.longTouchAction : dial.tapAction;

    if (gesture === "none") return;

    this.ensureContext(action, dial);
    this.host.logger.info(hold ? "Setup chassis dial long touch" : "Setup chassis dial tap");
    await this.doGesture(gesture);
  }

  onTelemetry(actionId: string, _telemetry: TelemetryData | null): void {
    const ctx = this.contextsState.get(actionId);

    if (!ctx) return;

    const sig = this.displayedSignature(ctx);

    if (sig === ctx.lastRenderSig) return;

    if (Date.now() - ctx.lastChangeRenderAt < CHANGE_RENDER_MIN_INTERVAL_MS) return;

    ctx.lastRenderSig = sig;
    ctx.lastChangeRenderAt = Date.now();
    this.renderFeedback(ctx).catch((err) => {
      this.host.logger.debug(`Dial feedback render failed: ${String(err)}`);
    });
  }

  refreshAll(): void {
    for (const ctx of this.contextsState.values()) {
      ctx.lastRenderSig = null;
      this.renderFeedback(ctx).catch((err) => {
        this.host.logger.debug(`Dial feedback refresh failed: ${String(err)}`);
      });
    }
  }

  private ensureContext(action: IDeckActionContext, dial: DialSettings): SetupChassisDialContext {
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

  private async dispatchRotation(ctx: SetupChassisDialContext, direction: SetupChassisDirection): Promise<void> {
    const key = rotationKey(ctx.dial.setting, direction);

    if (!key) {
      this.host.logger.warn(`No global key mapping for ${ctx.dial.setting} ${direction}`);

      return;
    }

    this.host.logger.info("Setup chassis dial rotated");
    this.host.logger.debug(`${ctx.dial.setting} ${direction}`);
    await this.host.tapBinding(key);
  }

  private async doGesture(action: GestureSlot): Promise<void> {
    if (action === "none") return;
  }

  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  private displayedSignature(ctx: SetupChassisDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry());

    return [ctx.dial.setting, value, this.computeBindingMissing(ctx.dial) ? "warn" : ""].join("|");
  }

  private async applyTriggerDescription(ctx: SetupChassisDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildTriggerDescription(ctx.dial));
  }

  private async renderFeedback(ctx: SetupChassisDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (!ctx.action.isDial()) return;

    const setting = ctx.dial.setting;
    const boxSvg = renderDialBox({
      width: 200,
      height: 100,
      abbr: MODE_ABBR[setting],
      value: formatDialValue(setting, this.host.getTelemetry()),
      colors: resolveDialBoxColors(ctx.dial.colors, MODE_COLOR[setting]),
      identityLabelScale: 0.22,
      bindingMissing: this.computeBindingMissing(ctx.dial),
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
