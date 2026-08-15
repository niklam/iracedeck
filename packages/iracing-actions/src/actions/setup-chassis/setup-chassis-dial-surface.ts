/**
 * The dial surface of the Setup Chassis action (issue #800) — the dual-surface
 * pattern (Fuel Service #759 / Setup Brakes #775), behind a host interface.
 * Coexists with the keypad "paired adjust key styles" feature (#810).
 *
 * Self-contained leaf (owns the `dial` schema + dial key bindings; operates on
 * the `dial` sub-object). Rotating adjusts one of the 13 chassis setup values
 * via the same key bindings as the keypad surface; the touch strip shows the
 * live value. The press/touch gestures can open the Pit Stop black box (#953).
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

import { showBlackBox } from "../../shared/black-box.js";
import { dialAppearanceFields, renderDialBox, resolveDialBoxColors } from "../../shared/dial-box.js";
import { renderDialNameIcon } from "../../shared/dial-name-icon.js";
import {
  formatViewValue,
  type UnitsPreference,
  type ViewSettingId,
  withUnitsPreference,
} from "../../shared/setup-view.js";

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

/**
 * Setup Chassis gestures (#953), all defaulting to `none` per the dial gesture
 * convention:
 * - `show-pit-stop-black-box` opens iRacing's F7 Pit Stop black box (the
 *   screen the pending spring/shock values live on) via the deterministic
 *   #818 prime+target sequence.
 * - `toggle-spring-side` flips the dial's mode between the LR and RR spring
 *   (a non-spring mode jumps to LR) and persists it, so one dial covers both
 *   rear springs — the lit side-arrow shows which one is active.
 */
export const GESTURE_ACTIONS = ["show-pit-stop-black-box", "toggle-spring-side", "none"] as const;
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
    // `.catch("none")` on every gesture slot: a value from a newer version
    // must degrade to none instead of failing the field and resetting the
    // whole dial object via the outer `DialSettings.catch` (the
    // 2.0-contamination lesson — same rationale as `units` below).
    pressAction: z.enum(GESTURE_ACTIONS).default("none").catch("none"),
    longPressAction: z.enum(GESTURE_ACTIONS).default("none").catch("none"),
    tapAction: z.enum(GESTURE_ACTIONS).default("none").catch("none"),
    longTouchAction: z.enum(GESTURE_ACTIONS).default("none").catch("none"),
    /**
     * Units for the spring offset readout: `auto` follows the sim's
     * DisplayUnits; metric/imperial force it (#953). `.catch` so a value from
     * a newer version degrades to auto instead of resetting the whole dial.
     */
    units: z.enum(["auto", "metric", "imperial"]).default("auto").catch("auto"),
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
  "lr-spring": "LR SPR",
  "rr-spring": "RR SPR",
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

/**
 * Which spring side a rotation setting edits — drives the dash box's lit
 * side-arrow so the driver can tell LR from RR at a glance mid-race (#953).
 * Only the springs get markers; the other settings are side-less.
 */
const SIDE_MARKER: Partial<Record<SetupChassisDialSetting, "left" | "right">> = {
  "lr-spring": "left",
  "rr-spring": "right",
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
export function formatDialValue(
  setting: SetupChassisDialSetting,
  telemetry: TelemetryData | null,
  units: UnitsPreference = "auto",
): string {
  const viewId = VIEW_ID[setting];

  if (!viewId) return "";

  return formatViewValue(viewId, withUnitsPreference(telemetry, units)).replace(/%$/, "");
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
    case "show-pit-stop-black-box":
      return "Show Pit Stop Box";
    case "toggle-spring-side":
      return "Switch LR/RR";
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
  /** Atomic multi-chord sequence (#818) — the show-black-box gesture's dispatch. */
  tapBindingSequence(settingKeys: string[], holdMs?: number): Promise<boolean>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

export class SetupChassisDialSurface {
  private readonly contextsState = new Map<string, SetupChassisDialContext>();

  constructor(private readonly host: SetupChassisDialHost) {}

  async willAppear(action: IDeckActionContext, dial: DialSettings): Promise<void> {
    const ctx = this.ensureContext(action, dial);
    ctx.dial = dial;

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
    ctx.dial = dial;
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

  async up(actionId: string, rawSettings?: unknown): Promise<void> {
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
    await this.doGesture(action, ctx, rawSettings);
  }

  async touchTap(action: IDeckActionContext, dial: DialSettings, hold: boolean, rawSettings?: unknown): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    // Read the gesture from ctx.dial, not the event payload — the same
    // stale-settings model `up()` follows (see ensureContext).
    const ctx = this.ensureContext(action, dial);
    const gesture = hold ? ctx.dial.longTouchAction : ctx.dial.tapAction;

    if (gesture === "none") return;

    this.host.logger.info(hold ? "Setup chassis dial long touch" : "Setup chassis dial tap");
    await this.doGesture(gesture, ctx, rawSettings);
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

  /**
   * Look up or create the per-context state. An EXISTING context keeps its
   * `dial` — settings changes only flow in through `willAppear` /
   * `didReceiveSettings` (which assign `ctx.dial` explicitly). Event payloads
   * must not refresh it: hosts with per-context settings caches can deliver
   * stale settings in dial events, which would silently undo the
   * `toggle-spring-side` gesture's plugin-side setSettings (#953).
   */
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

  private async doGesture(action: GestureSlot, ctx: SetupChassisDialContext, rawSettings?: unknown): Promise<void> {
    if (action === "none") return;

    if (action === "show-pit-stop-black-box") {
      this.host.logger.info("Setup chassis dial showing Pit Stop black box");
      await showBlackBox("pit-stop", {
        isConfigured: (key) => !this.host.isBindingMissing(key),
        tapSequence: (keys, holdMs) => this.host.tapBindingSequence(keys, holdMs),
        logger: this.host.logger,
      });

      return;
    }

    if (action === "toggle-spring-side") {
      const next: SetupChassisDialSetting = ctx.dial.setting === "lr-spring" ? "rr-spring" : "lr-spring";
      this.host.logger.info("Setup chassis dial switched spring side");
      this.host.logger.debug(`${ctx.dial.setting} -> ${next}`);

      // Persist by merging over the RAW settings so the keypad half of the
      // instance's settings object survives untouched. The host never echoes
      // plugin-side setSettings back as didReceiveSettings, so the local dial
      // state and the strip are updated here.
      const raw =
        rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)
          ? (rawSettings as Record<string, unknown>)
          : null;

      if (raw) {
        const rawDial =
          raw.dial && typeof raw.dial === "object" && !Array.isArray(raw.dial)
            ? (raw.dial as Record<string, unknown>)
            : {};
        await ctx.action.setSettings({ ...raw, dial: { ...rawDial, setting: next } });
      } else {
        // No settings in the event payload — flip only in memory. Persisting a
        // merge over {} would replace the whole stored object with just the
        // dial half, wiping the keypad settings.
        this.host.logger.warn("Dial event carried no settings; spring-side flip not persisted");
      }

      ctx.dial = { ...ctx.dial, setting: next };
      ctx.lastRenderSig = null;
      await this.applyTriggerDescription(ctx);
      await this.renderFeedback(ctx);
    }
  }

  private computeBindingMissing(dial: DialSettings): boolean {
    const keys = [rotationKey(dial.setting, "increase"), rotationKey(dial.setting, "decrease")].filter(
      (key): key is string => key !== undefined,
    );

    return this.host.isBindingMissing(keys);
  }

  private displayedSignature(ctx: SetupChassisDialContext): string {
    const value = formatDialValue(ctx.dial.setting, this.host.getTelemetry(), ctx.dial.units);

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
      value: formatDialValue(setting, this.host.getTelemetry(), ctx.dial.units),
      colors: resolveDialBoxColors(ctx.dial.colors, MODE_COLOR[setting]),
      identityLabelScale: 0.22,
      bindingMissing: this.computeBindingMissing(ctx.dial),
      sideMarker: SIDE_MARKER[setting],
    });
    const feedback: DeckFeedbackPayload = { box: svgToDataUri(boxSvg) };
    await ctx.action.setFeedback(feedback);

    ctx.lastRenderSig = this.displayedSignature(ctx);
    ctx.lastChangeRenderAt = Date.now();
  }
}
