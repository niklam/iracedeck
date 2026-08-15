/**
 * Audio Controls — dial surface (issue #782).
 *
 * The encoder half of the Audio Controls action, following the Fuel Service
 * dial-surface pattern (#759). Rotating adjusts the selected category's
 * volume; the press is configurable as Push to Talk (hold) or Mute/Unmute.
 * The touch strip shows a live 0–100 level bar for the iRaceDeck-internal
 * categories (Race Engineer, Radar) — their volumes are plugin-owned globals.
 * The iRacing categories (voice chat, master, spotter — #809) go through blind
 * key bindings and iRacing exposes no volume/mute state, so their strip shows
 * category identity only (a documented limitation, not an implementation gap).
 */
import {
  applyBindingWarning,
  type DeckFeedbackPayload,
  type DeckTriggerDescription,
  type IDeckActionContext,
  onGlobalSettingsChange,
  svgToDataUri,
} from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";

import { toggleRaceEngineerFeature, toggleRadarFeature } from "../../audio/audio-toggles.js";
import {
  isRaceEngineerEnabled,
  isRadarEnabled,
  readRaceEngineerVolume,
  readRadarVolume,
  stepRaceEngineerVolumeBy,
  stepRadarVolumeBy,
} from "../../audio/audio-volume.js";
import {
  type AudioControlsSettings,
  type AudioDialSettings,
  DIAL_MUTE_BINDINGS,
  type DialCategory,
  type DialPressAction,
  isInternalDialCategory,
  pressBindingKeys,
  PUSH_TO_TALK_KEY,
  resolveRotationBinding,
  rotationBindingKeys,
} from "./audio-controls-settings.js";

/** Cap on binding taps dispatched for one rotate event (a fast spin coalesces ticks). */
const MAX_TAPS_PER_EVENT = 5;

/**
 * Leading+trailing throttle window for feedback renders, honoring the
 * documented ≤10 setFeedback/sec/dial cap (a fast internal-volume spin fires
 * a render per detent plus a global-settings echo per persist).
 */
const RENDER_THROTTLE_MS = 100;

const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const GRAY = "#888888";
const BAND_BG = "#2a2f36";
const BAR_TRACK = "#1a1f26";

/** @internal Exported for testing */
export const CATEGORY_LABELS: Record<DialCategory, string> = {
  "voice-chat": "VOICE CHAT",
  master: "MASTER",
  spotter: "SPOTTER",
  "race-engineer": "RACE ENGINEER",
  radar: "RADAR",
};

const ROTATE_LABELS: Record<DialCategory, string> = {
  "voice-chat": "Adjust voice chat volume",
  master: "Adjust master volume",
  spotter: "Adjust spotter volume",
  "race-engineer": "Adjust Race Engineer volume",
  radar: "Adjust radar volume",
};

const PRESS_LABELS: Record<DialPressAction, string | undefined> = {
  "push-to-talk": "Push to talk (hold)",
  "mute-unmute": "Mute / unmute",
  none: undefined,
};

/**
 * @internal Exported for testing
 *
 * Everything the strip render needs, resolved by the surface so the renderer
 * stays pure. `volume`/`enabled` are set only for the internal categories.
 */
export interface AudioStripState {
  category: DialCategory;
  /** 0–100 volume for the internal categories; undefined for keybind ones. */
  volume?: number;
  /** Feature-gate state for the internal categories; undefined for keybind ones. */
  enabled?: boolean;
  /** True while the PTT binding is held (press action = push-to-talk). */
  pttHeld: boolean;
  /** True when a binding this dial's rotate/press needs is unconfigured (#612). */
  bindingMissing: boolean;
}

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current dial settings.
 */
export function buildAudioTriggerDescription(dial: AudioDialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = { rotate: ROTATE_LABELS[dial.category] };
  const pushLabel = PRESS_LABELS[dial.pressAction];

  if (pushLabel) description.push = pushLabel;

  return description;
}

/**
 * @internal Exported for testing
 *
 * Draws the 200×100 touch-strip slot as one self-drawn pixmap (the fuel
 * surface convention): a top band with the category label (red "ON AIR"
 * while PTT is held), then a live level bar + numeric value for the internal
 * categories, or a "Turn to adjust volume" hint for the keybind categories
 * (iRacing exposes no volume state — identity only, by design). Text y values
 * are BASELINES (the deck app's QT renderer ignores dominant-baseline).
 */
export function renderAudioStripSvg(state: AudioStripState): string {
  const bandColor = state.pttHeld ? RED : BAND_BG;
  const bandText = state.pttHeld ? "ON AIR" : CATEGORY_LABELS[state.category];

  const parts = [
    `<rect x="0" y="0" width="200" height="30" fill="${bandColor}"/>`,
    `<text x="100" y="21" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="16" font-weight="bold">${bandText}</text>`,
  ];

  if (state.volume !== undefined) {
    const barX = 8;
    const barY = 50;
    const barW = 184;
    const barH = 32;
    const on = state.enabled !== false;
    const fillW = Math.max(0, Math.min(barW, (state.volume / 100) * barW));
    const valueText = on ? String(Math.round(state.volume)) : "OFF";

    parts.push(`<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="8" fill="${BAR_TRACK}"/>`);

    if (fillW > 0) {
      parts.push(
        `<rect x="${barX}" y="${barY}" width="${fillW.toFixed(1)}" height="${barH}" rx="8" fill="${on ? GREEN : GRAY}"/>`,
      );
    }

    parts.push(
      `<text x="100" y="${barY + barH / 2 + 6}" text-anchor="middle" fill="${WHITE}" font-family="Arial, sans-serif" font-size="17" font-weight="bold">${valueText}</text>`,
    );
  } else {
    parts.push(
      `<text x="100" y="70" text-anchor="middle" fill="${GRAY}" font-family="Arial, sans-serif" font-size="13">Turn to adjust volume</text>`,
    );
  }

  const content = parts.join("");

  // Missing binding: dim the slot and draw the centered #612 warning triangle
  // over it (same convention as the Fuel Service strip box).
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">${
    state.bindingMissing ? applyBindingWarning(content) : content
  }</svg>`;
}

/** Per-context runtime state. */
interface AudioDialContext {
  settings: AudioControlsSettings;
  action: IDeckActionContext;
  /** True while the PTT binding is held for this context. */
  pttHeld: boolean;
  /** Trailing-throttle timer for feedback renders, or null when idle. */
  renderTimer: ReturnType<typeof setTimeout> | null;
  /** Whether a render was requested during the current throttle window. */
  renderQueued: boolean;
}

/**
 * What the dial surface needs from the owning action: scoped logging and the
 * base-class binding delegates (which must stay on the action so #612
 * readiness/warning semantics are unchanged).
 */
export interface AudioDialHost {
  readonly logger: ILogger;
  tapBinding(settingKey: string): Promise<void>;
  holdBinding(actionId: string, settingKey: string): Promise<void>;
  releaseBinding(actionId: string): Promise<void>;
  isBindingMissing(keys: string | string[] | null | undefined): boolean;
}

/**
 * The dial surface of the Audio Controls action. One instance per
 * AudioControls instance; holds every dial context's runtime state and all
 * dial-side behavior. The owning action routes events here after parsing
 * settings.
 */
export class AudioDialSurface {
  private contextsState = new Map<string, AudioDialContext>();
  /**
   * Unsubscribe handle for the global-settings listener. Registered lazily on
   * the first dial appear and kept for the plugin lifetime (the action is a
   * singleton) — the internal categories' volume/gate can change from the PI
   * sliders, Pit Crew keys, or another Audio Controls instance, and the strip
   * must track it live.
   */
  private unsubscribeGlobalSettings: (() => void) | null = null;

  constructor(private readonly host: AudioDialHost) {}

  async willAppear(action: IDeckActionContext, settings: AudioControlsSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;
    this.ensureGlobalListener();
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx);
  }

  async willDisappear(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (ctx) {
      // SAFETY: never leave the PTT key held after the context is gone.
      if (ctx.pttHeld) await this.host.releaseBinding(actionId);

      if (ctx.renderTimer !== null) clearTimeout(ctx.renderTimer);
    }

    this.contextsState.delete(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, settings: AudioControlsSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx);
  }

  async rotate(action: IDeckActionContext, settings: AudioControlsSettings, ticks: number): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;

    if (ticks === 0) return;

    const category = settings.dial.category;

    // Internal categories step the plugin-owned volume globals directly (the
    // #590 deferral this closes) — one signed multi-step persist+apply.
    if (isInternalDialCategory(category)) {
      const next = category === "race-engineer" ? stepRaceEngineerVolumeBy(ticks) : stepRadarVolumeBy(ticks);
      this.host.logger.debug(`${category} volume → ${next} (ticks=${ticks})`);
      this.scheduleRender(ctx);

      return;
    }

    // Keybind categories tap the volume binding once per detent, capped so a
    // fast spin can't queue a long tap burst (iRacing steps a fixed amount per
    // press — there is no absolute-volume command to scale instead).
    const key = resolveRotationBinding(category, ticks);

    if (!key) {
      this.host.logger.warn(`Rotate ignored — no volume binding for the ${category} category`);

      return;
    }

    if (this.host.isBindingMissing(key)) {
      this.host.logger.debug(`Rotate ignored — ${key} binding not configured`);

      return;
    }

    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);

    for (let i = 0; i < taps; i++) {
      await this.host.tapBinding(key);
    }
  }

  async down(action: IDeckActionContext, settings: AudioControlsSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;
    const press = settings.dial.pressAction;

    if (press === "none") return;

    if (press === "push-to-talk") {
      if (this.host.isBindingMissing(PUSH_TO_TALK_KEY)) {
        this.host.logger.warn("PTT press ignored — push-to-talk binding not configured");

        return;
      }

      ctx.pttHeld = true;
      this.host.logger.info("Audio dial PTT held");
      await this.host.holdBinding(action.id, PUSH_TO_TALK_KEY);
      this.scheduleRender(ctx);

      return;
    }

    // Mute / Unmute fires immediately on dialDown (no long-press slot exists,
    // so no release-time classification is needed).
    this.host.logger.info("Audio dial mute pressed");
    await this.doMute(ctx);
  }

  async up(actionId: string): Promise<void> {
    const ctx = this.contextsState.get(actionId);

    if (!ctx?.pttHeld) return;

    ctx.pttHeld = false;
    this.host.logger.info("Audio dial PTT released");
    await this.host.releaseBinding(actionId);
    this.scheduleRender(ctx);
  }

  /**
   * Runs Mute / Unmute for the current category: the iRacing categories with
   * a mute binding (voice chat mute, spotter silence — #809) tap it blind; the
   * internal categories toggle their feature gate with semantics identical to
   * the Pit Crew toggle keys (shared pathway). Master has no mute (no iRacing
   * keybind exists) — the PI never offers it, so a reached master here is a
   * stale persisted value: log + no-op.
   */
  private async doMute(ctx: AudioDialContext): Promise<void> {
    const category = ctx.settings.dial.category;
    const muteKey = DIAL_MUTE_BINDINGS[category];

    if (muteKey) {
      if (this.host.isBindingMissing(muteKey)) {
        this.host.logger.warn(`Mute press ignored — ${muteKey} binding not configured`);

        return;
      }

      await this.host.tapBinding(muteKey);

      return;
    }

    if (category === "race-engineer") {
      toggleRaceEngineerFeature(this.host.logger);
      this.scheduleRender(ctx);

      return;
    }

    if (category === "radar") {
      toggleRadarFeature(this.host.logger);
      this.scheduleRender(ctx);

      return;
    }

    this.host.logger.warn(`Mute / Unmute is not available for the ${category} category`);
  }

  private ensureContext(action: IDeckActionContext, settings: AudioControlsSettings): AudioDialContext {
    let ctx = this.contextsState.get(action.id);

    if (!ctx) {
      ctx = { settings, action, pttHeld: false, renderTimer: null, renderQueued: false };
      this.contextsState.set(action.id, ctx);
    }

    ctx.action = action;

    return ctx;
  }

  private ensureGlobalListener(): void {
    if (this.unsubscribeGlobalSettings) return;

    this.unsubscribeGlobalSettings = onGlobalSettingsChange(() => {
      for (const ctx of this.contextsState.values()) this.scheduleRender(ctx);
    });
  }

  /**
   * Leading+trailing render throttle per context: the first request renders
   * immediately; requests inside the window coalesce into one trailing render.
   * Keeps a fast spin (render per detent + a global-settings echo per persist)
   * under the ≤10 setFeedback/sec/dial cap.
   */
  private scheduleRender(ctx: AudioDialContext): void {
    if (!__FEATURE_DIAL_FEEDBACK__) return;

    if (ctx.renderTimer !== null) {
      ctx.renderQueued = true;

      return;
    }

    void this.renderFeedback(ctx);
    ctx.renderTimer = setTimeout(() => {
      ctx.renderTimer = null;

      if (ctx.renderQueued) {
        ctx.renderQueued = false;
        this.scheduleRender(ctx);
      }
    }, RENDER_THROTTLE_MS);
  }

  /** Pushes the encoder trigger descriptions for a dial (Elgato only). */
  private async applyTriggerDescription(ctx: AudioDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildAudioTriggerDescription(ctx.settings.dial));
  }

  /** Resolve everything the strip renderer needs for this context. */
  private stripState(ctx: AudioDialContext): AudioStripState {
    const category = ctx.settings.dial.category;
    const internal = isInternalDialCategory(category);

    return {
      category,
      volume: internal ? (category === "race-engineer" ? readRaceEngineerVolume() : readRadarVolume()) : undefined,
      enabled: internal ? (category === "race-engineer" ? isRaceEngineerEnabled() : isRadarEnabled()) : undefined,
      pttHeld: ctx.pttHeld,
      bindingMissing: this.host.isBindingMissing([
        ...rotationBindingKeys(category),
        ...pressBindingKeys(ctx.settings.dial),
      ]),
    };
  }

  private async renderFeedback(ctx: AudioDialContext): Promise<void> {
    if (!__FEATURE_DIAL_FEEDBACK__ || !ctx.action.isDial()) return;

    const feedback: DeckFeedbackPayload = { box: svgToDataUri(renderAudioStripSvg(this.stripState(ctx))) };
    await ctx.action.setFeedback(feedback);
  }
}
