/**
 * Audio Controls — dial surface (issue #782).
 *
 * The encoder half of the Audio Controls action, following the Fuel Service
 * dial-surface pattern (#759). Rotating adjusts the selected category's
 * volume; the press is configurable as Push to Talk (hold), Mute/Unmute,
 * Mute a Driver (#863, voice chat only), or Skip Spotter Call (#1015, spotter
 * only). The dial's own screen — the Stream Deck+ touch strip or the Stream
 * Dock knob screen (#1013), each with its own drawing — shows a live 0–100
 * level bar for the iRaceDeck-internal categories (Race Engineer, Radar) —
 * their volumes are plugin-owned globals.
 * The iRacing categories (voice chat, master, spotter — #809) go through blind
 * key bindings and iRacing exposes no volume/mute state, so their strip shows
 * category identity only (a documented limitation, not an implementation gap).
 */
import { type DeckTriggerDescription, type IDeckActionContext, svgToDataUri } from "@iracedeck/deck-core";
import type { ILogger } from "@iracedeck/logger";
import { onGlobalSettingsChange } from "@iracedeck/settings";

import { tickIRacingVolumeStep } from "../../audio/volume-tick.js";
import { DialSurfaceBase } from "../../shared/dial-surface-base.js";
import { INTERNAL_AUDIO_BUSES } from "./audio-buses.js";
import {
  type AudioControlsSettings,
  type AudioDialSettings,
  DIAL_MUTE_BINDINGS,
  DIAL_MUTE_DRIVER_BINDINGS,
  DIAL_SKIP_CALL_BINDINGS,
  type DialCategory,
  type DialPressAction,
  isDialPressAvailable,
  isInternalAudioCategory,
  pressBindingKeys,
  PUSH_TO_TALK_KEY,
  resolveRotationBinding,
  rotationBindingKeys,
} from "./audio-controls-settings.js";
import { type AudioStripState, renderAudioCanvasFor } from "./audio-dial-render.js";

/** Cap on binding taps dispatched for one rotate event (a fast spin coalesces ticks). */
const MAX_TAPS_PER_EVENT = 5;

/**
 * Leading+trailing throttle window for feedback renders, honoring the
 * documented ≤10 setFeedback/sec/dial cap (a fast internal-volume spin fires
 * a render per detent plus a global-settings echo per persist).
 */
const RENDER_THROTTLE_MS = 100;

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
  "mute-driver": "Mute a driver",
  "skip-call": "Skip spotter call",
  none: undefined,
};

/**
 * @internal Exported for testing
 *
 * Computes the encoder trigger descriptions from the current dial settings.
 * The push is labelled only when it can fire for the dial's category: a stored
 * press its Mode does not offer (Master + Mute a Driver) is a value the PI
 * never writes, and advertising it would promise a press that only logs
 * (#1196).
 */
export function buildAudioTriggerDescription(dial: AudioDialSettings): DeckTriggerDescription {
  const description: DeckTriggerDescription = { rotate: ROTATE_LABELS[dial.category] };
  const pushLabel = isDialPressAvailable(dial) ? PRESS_LABELS[dial.pressAction] : undefined;

  if (pushLabel) description.push = pushLabel;

  return description;
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
 * warning semantics are unchanged).
 */
export interface AudioDialHost {
  readonly logger: ILogger;
  tapBinding(settingKey: string): Promise<boolean>;
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
export class AudioDialSurface extends DialSurfaceBase<AudioDialContext, AudioControlsSettings> {
  /**
   * Unsubscribe handle for the global-settings listener. Registered lazily on
   * the first dial appear and kept for the plugin lifetime (the action is a
   * singleton) — the internal categories' volume/gate can change from the PI
   * sliders, Pit Crew keys, or another Audio Controls instance, and the strip
   * must track it live.
   */
  private unsubscribeGlobalSettings: (() => void) | null = null;

  constructor(protected override readonly host: AudioDialHost) {
    super();
  }

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

    this.forgetContext(actionId);
  }

  async didReceiveSettings(action: IDeckActionContext, settings: AudioControlsSettings): Promise<void> {
    const ctx = this.ensureContext(action, settings);
    ctx.settings = settings;
    await this.applyTriggerDescription(ctx);
    this.scheduleRender(ctx);
  }

  async rotate(action: IDeckActionContext, settings: AudioControlsSettings, ticks: number): Promise<void> {
    const ctx = this.inputContext(action, settings, "rotate");

    if (!ctx) return;

    ctx.settings = settings;

    if (ticks === 0) return;

    const category = settings.dial.category;

    // Internal categories step the plugin-owned volume globals directly (the
    // #590 deferral this closes) — one signed multi-step persist+apply. The
    // step helper ticks each applied detent itself (#1455), so nothing ticks
    // here.
    if (isInternalAudioCategory(category)) {
      const next = INTERNAL_AUDIO_BUSES[category].stepBy(ticks);
      this.host.logger.debug(`${category} volume → ${next} (ticks=${ticks})`);
      this.scheduleRender(ctx);

      return;
    }

    // Keybind categories tap the volume binding once per detent, capped so a
    // fast spin can't queue a long tap burst (iRacing steps a fixed amount per
    // press — there is no absolute-volume command to scale instead). Each tap
    // that was sent ticks once (#1455), so the ticks share the taps' cap.
    const key = resolveRotationBinding(category, ticks);
    const direction = ticks > 0 ? "up" : "down";

    if (this.host.isBindingMissing(key)) {
      this.host.logger.debug(`Rotate ignored — ${key} binding not configured`);

      return;
    }

    const taps = Math.min(Math.abs(ticks), MAX_TAPS_PER_EVENT);

    for (let i = 0; i < taps; i++) {
      if (await this.host.tapBinding(key)) tickIRacingVolumeStep(direction);
    }
  }

  async down(action: IDeckActionContext, settings: AudioControlsSettings): Promise<void> {
    const ctx = this.inputContext(action, settings, "down");

    if (!ctx) return;

    ctx.settings = settings;
    const press = settings.dial.pressAction;

    if (press === "none") return;

    if (press === "push-to-talk") {
      // Push to Talk holds a key until the release, and a Mirabox knob press
      // never reports its release (the adapter completes the press at its
      // dialDown), so there is no hold to transmit for. The PI does not
      // offer it where the extended gestures are compiled out; a value stored
      // before (or copied from a Stream Deck+ profile) does nothing.
      if (!__FEATURE_DIAL_EXTENDED_GESTURES__) {
        this.host.logger.info("PTT press ignored — push-to-talk needs a release this host does not send");

        return;
      }

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

    // Mute a Driver (#863) fires immediately on dialDown, like Mute / Unmute:
    // no long-press slot exists, so no release-time classification is needed.
    if (press === "mute-driver") {
      this.host.logger.info("Audio dial mute-driver pressed");
      await this.doMuteDriver(ctx);

      return;
    }

    // Skip Spotter Call (#1015) fires immediately on dialDown, like the mutes.
    if (press === "skip-call") {
      this.host.logger.info("Audio dial skip-call pressed");
      await this.doSkipCall(ctx);

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
   * Runs Mute / Unmute for the current category: the internal categories flip
   * their feature gate with semantics identical to the Pit Crew toggle keys
   * (shared pathway); voice chat taps its mute binding blind. Master has no
   * mute (no iRacing keybind exists) and spotter's silence binding is Skip
   * Spotter Call, not a mute (#1015) — the PI offers Mute / Unmute for neither,
   * so a reached master or spotter here is a stale persisted value (a spotter
   * one is normally rewritten by the #1015 migration first): log + no-op.
   */
  private async doMute(ctx: AudioDialContext): Promise<void> {
    const category = ctx.settings.dial.category;

    if (isInternalAudioCategory(category)) {
      INTERNAL_AUDIO_BUSES[category].toggle(this.host.logger);
      this.scheduleRender(ctx);

      return;
    }

    const muteKey = DIAL_MUTE_BINDINGS[category];

    if (!muteKey) {
      this.host.logger.warn(`Mute / Unmute is not available for the ${category} category`);

      return;
    }

    if (this.host.isBindingMissing(muteKey)) {
      this.host.logger.warn(`Mute press ignored — the ${category} mute binding (${muteKey}) is not configured`);

      return;
    }

    await this.host.tapBinding(muteKey);
  }

  /**
   * Runs Mute a Driver (#863) for the current category: a blind tap of the
   * category's driver-mute binding — iRacing's *Mute a Driver*, which silences
   * whoever is transmitting on voice chat. Only voice chat has one, and the PI
   * offers the press for that Mode alone, so any other category reached here
   * is a stale persisted value (the `doMute` master precedent): log + no-op.
   * There is no readback, so nothing to render.
   */
  private async doMuteDriver(ctx: AudioDialContext): Promise<void> {
    const category = ctx.settings.dial.category;
    const muteDriverKey = isInternalAudioCategory(category) ? undefined : DIAL_MUTE_DRIVER_BINDINGS[category];

    if (!muteDriverKey) {
      this.host.logger.warn(`Mute a Driver is not available for the ${category} category`);

      return;
    }

    if (this.host.isBindingMissing(muteDriverKey)) {
      this.host.logger.warn(
        `Mute a Driver press ignored — the ${category} driver-mute binding (${muteDriverKey}) is not configured`,
      );

      return;
    }

    await this.host.tapBinding(muteDriverKey);
  }

  /**
   * Runs Skip Spotter Call (#1015) for the current category: a blind tap of
   * iRacing's *Spotter Silence*, which cuts the spotter call currently playing
   * — a one-shot, since iRacing has no permanent spotter mute. Only spotter
   * has the binding and the PI offers the press for that Mode alone, so any
   * other category reached here is a stale persisted value: log + no-op.
   */
  private async doSkipCall(ctx: AudioDialContext): Promise<void> {
    const category = ctx.settings.dial.category;
    const skipCallKey = isInternalAudioCategory(category) ? undefined : DIAL_SKIP_CALL_BINDINGS[category];

    if (!skipCallKey) {
      this.host.logger.warn(`Skip Spotter Call is not available for the ${category} category`);

      return;
    }

    if (this.host.isBindingMissing(skipCallKey)) {
      this.host.logger.warn(
        `Skip Spotter Call press ignored — the ${category} skip-call binding (${skipCallKey}) is not configured`,
      );

      return;
    }

    await this.host.tapBinding(skipCallKey);
  }

  /** A new context for a lifecycle event (`willAppear`, `didReceiveSettings`); the base stores it. */
  protected override createContext(action: IDeckActionContext, settings: AudioControlsSettings): AudioDialContext {
    return { settings, action, pttHeld: false, renderTimer: null, renderQueued: false };
  }

  /**
   * An existing context refreshes its action only: `willAppear`,
   * `didReceiveSettings` and the input members assign `ctx.settings`
   * themselves, at their call sites.
   */
  protected override refreshContext(
    ctx: AudioDialContext,
    action: IDeckActionContext,
    _settings: AudioControlsSettings,
  ): void {
    ctx.action = action;
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
    if (!__FEATURE_DIAL_EXTENDED_GESTURES__ || !ctx.action.isDial()) return;

    await ctx.action.setTriggerDescription(buildAudioTriggerDescription(ctx.settings.dial));
  }

  /** Resolve everything the strip renderer needs for this context. */
  private stripState(ctx: AudioDialContext): AudioStripState {
    const category = ctx.settings.dial.category;
    const bus = isInternalAudioCategory(category) ? INTERNAL_AUDIO_BUSES[category] : undefined;

    return {
      category,
      volume: bus?.read(),
      enabled: bus?.isEnabled(),
      pttHeld: ctx.pttHeld,
      bindingMissing:
        this.isPressUnavailable(ctx.settings.dial) ||
        this.host.isBindingMissing([...rotationBindingKeys(category), ...pressBindingKeys(ctx.settings.dial)]),
    };
  }

  /**
   * Whether the stored press is one this dial can never fire (#1196): a press
   * its category does not offer, or Push to Talk on a host that never sends
   * the release it needs (see {@link down}). Either is a value the PI would
   * not write here, so the screen warns rather than passing for a working
   * press. `none` is a choice, not a fault.
   */
  private isPressUnavailable(dial: AudioDialSettings): boolean {
    if (dial.pressAction === "none") return false;

    if (dial.pressAction === "push-to-talk" && !__FEATURE_DIAL_EXTENDED_GESTURES__) return true;

    return !isDialPressAvailable(dial);
  }

  /** Pushes the dial's own screen — the strip or the knob drawing (#1013); nothing when it has none. */
  private async renderFeedback(ctx: AudioDialContext): Promise<void> {
    const canvas = ctx.action.dialCanvas();

    if (!canvas) return;

    const state = this.stripState(ctx);
    await ctx.action.setDialCanvas(svgToDataUri(renderAudioCanvasFor(canvas, state)));
  }
}
