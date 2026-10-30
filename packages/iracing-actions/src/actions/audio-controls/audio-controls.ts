import {
  assembleIcon,
  ConnectionStateAwareAction,
  getDualPressThresholdMs,
  getGlobalBorderSettings,
  getGlobalGraphicSettings,
  getGlobalTitleSettings,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDialUpEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  type PressShape,
  resolveBorderSettings,
  resolveGraphicSettings,
  resolveIconColors,
  resolveTitleSettings,
} from "@iracedeck/deck-core";
import masterMuteIconSvg from "@iracedeck/icons/audio-controls/master-mute.svg";
import masterVolumeDownIconSvg from "@iracedeck/icons/audio-controls/master-volume-down.svg";
import masterVolumeUpIconSvg from "@iracedeck/icons/audio-controls/master-volume-up.svg";
import pushToTalkIconSvg from "@iracedeck/icons/audio-controls/push-to-talk.svg";
import raceEngineerVolumeDownIconSvg from "@iracedeck/icons/audio-controls/race-engineer-volume-down.svg";
import raceEngineerVolumeUpIconSvg from "@iracedeck/icons/audio-controls/race-engineer-volume-up.svg";
import radarVolumeDownIconSvg from "@iracedeck/icons/audio-controls/radar-volume-down.svg";
import radarVolumeUpIconSvg from "@iracedeck/icons/audio-controls/radar-volume-up.svg";
import voiceChatMuteDriverIconSvg from "@iracedeck/icons/audio-controls/voice-chat-mute-driver.svg";
import voiceChatMuteIconSvg from "@iracedeck/icons/audio-controls/voice-chat-mute.svg";
import voiceChatVolumeDownIconSvg from "@iracedeck/icons/audio-controls/voice-chat-volume-down.svg";
import voiceChatVolumeUpIconSvg from "@iracedeck/icons/audio-controls/voice-chat-volume-up.svg";
import { getGlobalColors } from "@iracedeck/settings";

import { tickIRacingVolumeStep } from "../../audio/volume-tick.js";
import {
  ADJUST_REPEAT_INTERVAL_MS,
  ADJUST_REPEAT_SAFETY_MS,
  persistFreshKeyStyleSeed,
} from "../../shared/adjust-styles.js";
import { RepeatController } from "../../shared/repeat-controller.js";
import {
  renderVolumeKeyIconOrNull,
  type VolumeKeyDescription,
  volumeKeyRepeats,
} from "../../shared/volume-key-styles.js";
import { INTERNAL_AUDIO_BUSES } from "./audio-buses.js";
import {
  AUDIO_CONTROLS_GLOBAL_KEYS,
  type AudioControlsSettings,
  isDialPressAvailable,
  isInternalAudioCategory,
  isKeypadControlAvailable,
  parseAudioControlsSettings,
} from "./audio-controls-settings.js";
import { AudioDialSurface } from "./audio-dial-surface.js";
import { migrateSpotterMuteToSkipCall } from "./migrate-spotter-mute-to-skip-call.js";

// Re-export for test back-compat (@internal, tests import from this path).
export { AUDIO_CONTROLS_GLOBAL_KEYS };

type AudioCategory = "push-to-talk" | "voice-chat" | "master" | "race-engineer" | "radar";
type AudioAction = "volume-up" | "volume-down" | "mute" | "mute-driver";
/** A keypad category with a volume pair: every one but Push to Talk. */
type VolumeCategory = Exclude<AudioCategory, "push-to-talk">;
type VolumeAction = "volume-up" | "volume-down";

/**
 * Flat record mapping "{category}-{action}" keys to imported SVGs.
 */
const AUDIO_ICONS: Record<string, string> = {
  "push-to-talk": pushToTalkIconSvg,
  "voice-chat-volume-up": voiceChatVolumeUpIconSvg,
  "voice-chat-volume-down": voiceChatVolumeDownIconSvg,
  "voice-chat-mute": voiceChatMuteIconSvg,
  "voice-chat-mute-driver": voiceChatMuteDriverIconSvg,
  "master-volume-up": masterVolumeUpIconSvg,
  "master-volume-down": masterVolumeDownIconSvg,
  "master-mute": masterMuteIconSvg,
  "race-engineer-volume-up": raceEngineerVolumeUpIconSvg,
  "race-engineer-volume-down": raceEngineerVolumeDownIconSvg,
  "radar-volume-up": radarVolumeUpIconSvg,
  "radar-volume-down": radarVolumeDownIconSvg,
};

/**
 * Title text for each category + action combination (format: "subLabel\nmainLabel")
 */
const AUDIO_CONTROLS_TITLES: Record<string, string> = {
  "push-to-talk": "TALK",
  "voice-chat-volume-up": "VOL UP\nVOICE",
  "voice-chat-volume-down": "VOL DOWN\nVOICE",
  "voice-chat-mute": "MUTE\nVOICE",
  "voice-chat-mute-driver": "MUTE\nDRIVER",
  "master-volume-up": "VOL UP\nMASTER",
  "master-volume-down": "VOL DOWN\nMASTER",
  "master-mute": "MUTE\nMASTER",
  "race-engineer-volume-up": "VOL UP\nENGINEER",
  "race-engineer-volume-down": "VOL DOWN\nENGINEER",
  "radar-volume-up": "VOL UP\nRADAR",
  "radar-volume-down": "VOL DOWN\nRADAR",
};

/**
 * The glyph for a `{category}-{action}` pair with no entry of its own in
 * {@link AUDIO_ICONS} — a pair the PI never writes, such as Radar + Mute
 * (#1196). It draws what the stored action is, so the key does not pass for a
 * different control: before #1196 these fell back to the Push to Talk
 * microphone.
 */
const ACTION_GLYPHS: Record<AudioAction, string> = {
  "volume-up": masterVolumeUpIconSvg,
  "volume-down": masterVolumeDownIconSvg,
  mute: masterMuteIconSvg,
  "mute-driver": voiceChatMuteDriverIconSvg,
};

/** Title lines for a pair with no entry in {@link AUDIO_CONTROLS_TITLES}: "{action}\n{category}". */
const ACTION_TITLE_LABELS: Record<AudioAction, string> = {
  "volume-up": "VOL UP",
  "volume-down": "VOL DOWN",
  mute: "MUTE",
  "mute-driver": "MUTE DRIVER",
};

const CATEGORY_TITLE_LABELS: Record<VolumeCategory, string> = {
  "voice-chat": "VOICE",
  master: "MASTER",
  "race-engineer": "ENGINEER",
  radar: "RADAR",
};

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the audio controls action. A pair that
 * can do nothing when pressed (see {@link isKeypadControlAvailable}) always
 * carries the warning overlay, whatever `bindingMissing` says: no binding can
 * make it work, but the key must not look like one that does (#1196).
 */
export function generateAudioControlsSvg(settings: AudioControlsSettings, bindingMissing = false): string {
  const { category, action: audioAction } = settings;

  let iconSvg: string;
  let defaultTitle: string;

  if (category === "push-to-talk") {
    iconSvg = AUDIO_ICONS["push-to-talk"];
    defaultTitle = AUDIO_CONTROLS_TITLES["push-to-talk"];
  } else {
    const key = `${category}-${audioAction}`;
    iconSvg = AUDIO_ICONS[key] ?? ACTION_GLYPHS[audioAction];
    defaultTitle =
      AUDIO_CONTROLS_TITLES[key] ?? `${ACTION_TITLE_LABELS[audioAction]}\n${CATEGORY_TITLE_LABELS[category]}`;
  }

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({
    graphicSvg: iconSvg,
    colors,
    title,
    border,
    graphic,
    bindingMissing: bindingMissing || !isKeypadControlAvailable(settings),
  });
}

/** A keypad pair that is one half of a volume pair: any category but Push to Talk, with Volume Up or Down. */
function volumePair(
  settings: Pick<AudioControlsSettings, "category" | "action">,
): { category: VolumeCategory; action: VolumeAction } | null {
  const { category, action } = settings;

  if (category === "push-to-talk" || (action !== "volume-up" && action !== "volume-down")) return null;

  return { category, action };
}

/**
 * @internal Exported for testing
 *
 * The volume key a keypad pair is, for its paired +/− style (#1453), or null
 * for a pair that is not a volume key (Push to Talk, the mutes). iRacing's
 * volumes (Master, Voice Chat) have no level; Race Engineer and Radar read
 * theirs through {@link INTERNAL_AUDIO_BUSES}, the table the dial shares.
 */
export function describeAudioVolumeKey(
  settings: Pick<AudioControlsSettings, "category" | "action">,
): VolumeKeyDescription | null {
  const pair = volumePair(settings);

  if (!pair) return null;

  const label = CATEGORY_TITLE_LABELS[pair.category];
  const direction = pair.action === "volume-up" ? "increase" : "decrease";

  if (!isInternalAudioCategory(pair.category)) return { label, direction };

  const bus = INTERNAL_AUDIO_BUSES[pair.category];

  return { label, direction, readLevel: () => ({ level: bus.read(), enabled: bus.isEnabled() }) };
}

/**
 * @internal Exported for testing
 *
 * The keypad icon: a volume key in a paired style draws through the shared
 * volume module (#1453); every other key, and a volume key on Legacy, draws
 * {@link generateAudioControlsSvg} as before.
 */
export function renderAudioControlsIcon(settings: AudioControlsSettings, bindingMissing = false): string {
  const description = describeAudioVolumeKey(settings);

  if (description) {
    const styled = renderVolumeKeyIconOrNull({
      description,
      keyStyle: settings.keyStyle,
      pairPosition: settings.pairPosition,
      colorSourceSvg: AUDIO_ICONS[`${settings.category}-${settings.action}`],
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });

    if (styled) return styled;
  }

  return generateAudioControlsSvg(settings, bindingMissing);
}

/**
 * @internal Exported for testing
 *
 * The shape of an Audio Controls press, for the press sounds (#269). Push to
 * Talk makes no sound on either surface: a click as the microphone opens is
 * the sound most likely to be transmitted. Every keypad volume step makes
 * none either, since its #1455 tick is its press sound (a repeating style's
 * hold changes nothing to bleep for). A press that does nothing — a keypad
 * pair or a dial press the action cannot fire (#1196), or a dial press of
 * `none` — makes no sound. What is left acts once, on the down event, the dial
 * included (it fires at `dialDown`, #1120 decision 2): a `tap`.
 */
export function audioControlsPressShape(settings: AudioControlsSettings, surface: "key" | "dial"): PressShape {
  if (surface === "dial") {
    const { dial } = settings;

    return dial.pressAction === "push-to-talk" || !isDialPressAvailable(dial) ? { kind: "none" } : { kind: "tap" };
  }

  if (settings.category === "push-to-talk" || volumePair(settings) || !isKeypadControlAvailable(settings)) {
    return { kind: "none" };
  }

  return { kind: "tap" };
}

/**
 * Audio Controls Action
 * One action, two surfaces (#782): on a keypad button it provides volume and
 * mute controls for the iRacing (voice chat, master) and iRaceDeck (Race
 * Engineer, Radar) audio categories — Voice Chat also offers Mute a Driver
 * (#863), a blind tap of iRacing's per-driver mute; on a dial/knob it routes
 * every event to the {@link AudioDialSurface} (rotate = volume, press = PTT /
 * Mute–Unmute / Mute a Driver / Skip Spotter Call).
 */
export const AUDIO_CONTROLS_UUID = "com.iracedeck.sd.core.audio-controls" as const;

export class AudioControls extends ConnectionStateAwareAction<AudioControlsSettings> {
  /** The dial half of the action; all IDeck dial events route here (#782). */
  private readonly dialSurface = new AudioDialSurface({
    logger: this.logger,
    tapBinding: (settingKey) => this.tapBinding(settingKey),
    holdBinding: (actionId, settingKey) => this.holdBinding(actionId, settingKey),
    releaseBinding: (actionId) => this.releaseBinding(actionId),
    isBindingMissing: (keys) => this.isBindingMissing(keys),
  });

  /** Hold-to-repeat for volume keys in a paired style (#1453); Legacy keys step once per press. */
  private readonly repeat = new RepeatController(this.logger);

  override async onWillAppear(ev: IDeckWillAppearEvent<AudioControlsSettings>): Promise<void> {
    // BEFORE super: the base stamps a missing `addedWithVersion` with its own
    // setSettings({...payload, addedWithVersion}). Migrating first (and handing
    // the base the migrated payload) makes that stamp write land last AND carry
    // the migrated dial — the other order would drop the stamp.
    await this.persistMigratedSettings(ev);

    // The fresh-key seed (#1453) joins the same pre-super step, for the same
    // reason: the stamp then carries the seeded style. A seed and the
    // migration never both apply — an empty payload has nothing to migrate.
    if (!ev.action.isDial()) await persistFreshKeyStyleSeed(ev, this.logger);

    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.willAppear(ev.action, settings);

      return;
    }

    // Unconditional: a pair with no binding (the internal categories, or one
    // the PI never writes, #1196) must clear the key, not leave the one the
    // previous key declared deciding this key's readiness.
    this.setActiveBinding(this.resolveGlobalKey(settings.category, settings.action));

    await this.updateDisplay(ev, settings);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<AudioControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    // No persistMigratedSettings here — see its doc comment. parseSettings
    // still migrates the read, which is harmless for a transient pair.
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.didReceiveSettings(ev.action, settings);

      return;
    }

    this.repeat.clear(ev.action.id);
    this.setActiveBinding(this.resolveGlobalKey(settings.category, settings.action));

    await this.updateDisplay(ev, settings);
  }

  /** The press sounds' shape of a key press (#269); see {@link audioControlsPressShape}. */
  keyPressShape(ev: IDeckKeyDownEvent<AudioControlsSettings>): PressShape {
    return audioControlsPressShape(this.parseSettings(ev.payload.settings), "key");
  }

  /** The press sounds' shape of a dial press (#269); see {@link audioControlsPressShape}. */
  dialPressShape(ev: IDeckDialDownEvent<AudioControlsSettings>): PressShape {
    return audioControlsPressShape(this.parseSettings(ev.payload.settings), "dial");
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<AudioControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.category === "push-to-talk") {
      const settingKey = this.resolveGlobalKey(settings.category, settings.action);

      if (!settingKey) {
        this.logger.warn("No global key mapping for push-to-talk");

        return;
      }

      await this.holdBinding(ev.action.id, settingKey);

      return;
    }

    const pair = volumePair(settings);

    if (pair) {
      // Hold-to-repeat in every paired style (#1453): armed SYNCHRONOUSLY,
      // before the first step's await, so a racing keyUp always finds the
      // timers to clear (the setup actions' pattern). Every step, the first
      // and each repeat, goes through performVolumeStep; a step that did not
      // happen (a level at its limit, a binding that did not send) ends the
      // repeat.
      if (volumeKeyRepeats(settings.keyStyle)) {
        this.repeat.onKeyDown(ev.action.id, {
          holdMs: getDualPressThresholdMs(),
          intervalMs: ADJUST_REPEAT_INTERVAL_MS,
          safetyMs: ADJUST_REPEAT_SAFETY_MS,
          execute: () => this.performVolumeStep(pair.category, pair.action),
        });
      }

      await this.performVolumeStep(pair.category, pair.action);
    } else if (isInternalAudioCategory(settings.category)) {
      // These categories expose only volume-up / volume-down in the Property
      // Inspector, so a mute value here is a STALE persisted setting — a
      // hand-edited or imported profile, or a key whose PI has not been
      // reopened. It logs and no-ops, matching the dial's `doMute` /
      // `doMuteDriver`. It used to treat anything that wasn't `volume-down` as
      // a step up, which turned such a setting into a silent volume increase
      // on every single press.
      this.logger.warn(`${settings.action} is not available for the ${settings.category} category`);
    } else {
      await this.executeControl(settings.category, settings.action);
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<AudioControlsSettings>): Promise<void> {
    this.repeat.onKeyUp(ev.action.id);
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.category === "push-to-talk") {
      this.logger.info("Key up received");
      await this.releaseBinding(ev.action.id);
    }
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<AudioControlsSettings>): Promise<void> {
    await this.dialSurface.willDisappear(ev.action.id);
    this.repeat.clear(ev.action.id);
    await this.releaseBinding(ev.action.id);
    await super.onWillDisappear(ev);
  }

  override async onDialRotate(ev: IDeckDialRotateEvent<AudioControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.rotate(ev.action, settings, ev.payload.ticks);
  }

  override async onDialDown(ev: IDeckDialDownEvent<AudioControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);
    await this.dialSurface.down(ev.action, settings);
  }

  override async onDialUp(ev: IDeckDialUpEvent<AudioControlsSettings>): Promise<void> {
    await this.dialSurface.up(ev.action.id);
  }

  /**
   * Every read goes through the #1015 migration, so a legacy spotter
   * Mute / Unmute dial dispatches as Skip Spotter Call even before (or
   * without) the persisted rewrite landing.
   */
  private parseSettings(settings: unknown): AudioControlsSettings {
    return parseAudioControlsSettings(migrateSpotterMuteToSkipCall(settings).migrated);
  }

  /**
   * Persist the #1015 migration (a legacy spotter `mute-unmute` press becomes
   * `skip-call`) so the legacy pair is dropped from the stored settings before
   * the PI can open on this instance — its "unavailable press falls back to
   * None" rule would otherwise overwrite the user's choice — and hand the
   * migrated object on as `ev.payload.settings`, so the base class's
   * `addedWithVersion` stamp (which writes from the payload) keeps it.
   *
   * willAppear ONLY, never didReceiveSettings. The PI cannot open before
   * willAppear, so this one point catches every stored legacy dial; and the PI
   * itself produces the legacy pair transiently during an ordinary Mode switch
   * (e.g. Voice Chat + Mute / Unmute → Spotter: sdpi saves `dial.category`
   * first, and the press falls back to None up to one poll tick later).
   * Persisting on that echo would rewrite it to a Skip Spotter Call the user
   * never chose.
   *
   * Logs and swallows a failed persist: {@link parseSettings} migrates every
   * read, so dispatch stays right either way.
   */
  private async persistMigratedSettings(ev: IDeckWillAppearEvent<AudioControlsSettings>): Promise<void> {
    const { migrated, changed } = migrateSpotterMuteToSkipCall(ev.payload.settings);

    if (!changed) return;

    try {
      await ev.action.setSettings(migrated);
    } catch (err) {
      this.logger.warn(
        `Failed to persist migrated audio-controls settings: ${err instanceof Error ? err.message : err}`,
      );
    }

    ev.payload.settings = migrated as AudioControlsSettings;
  }

  /**
   * One volume step of a keypad volume key — the first press and every
   * hold-to-repeat step alike (#1453) — and whether it happened.
   *
   * iRacing's volumes (Master, Voice Chat) tap the key binding: true when the
   * press was sent. iRaceDeck's own (Race Engineer voice, Radar ticks) step
   * the global one detent through the shared {@link INTERNAL_AUDIO_BUSES}
   * table — the same wiring the dial rotates, so the two surfaces can't drift
   * — which persists it and applies it to the audio engine (Race Engineer
   * stepping respects the master gate: the value updates but Voice stays
   * muted while the feature is off): true when the level moved, false at 0
   * or 100.
   *
   * The volume step tick (#1455): an iRacing step ticks here, after a tap
   * that was sent (only while the sim is connected — see
   * {@link tickIRacingVolumeStep}); an iRaceDeck step ticks inside the shared
   * step helper, so it is not ticked here a second time.
   */
  private async performVolumeStep(category: VolumeCategory, audioAction: VolumeAction): Promise<boolean> {
    const down = audioAction === "volume-down";

    if (isInternalAudioCategory(category)) {
      const bus = INTERNAL_AUDIO_BUSES[category];
      const before = bus.read();
      const next = bus.stepBy(down ? -1 : 1);
      this.logger.info(`${category} volume ${down ? "down" : "up"} → ${next}`);

      return next !== before;
    }

    const settingKey = this.resolveGlobalKey(category, audioAction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${category} ${audioAction}`);

      return false;
    }

    const sent = await this.tapBinding(settingKey);

    if (sent) tickIRacingVolumeStep(down ? "down" : "up");

    return sent;
  }

  private async executeControl(category: AudioCategory, audioAction: AudioAction): Promise<void> {
    const settingKey = this.resolveGlobalKey(category, audioAction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${category} ${audioAction}`);

      return;
    }

    await this.tapBinding(settingKey);
  }

  private resolveGlobalKey(category: AudioCategory, audioAction: AudioAction): string | null {
    if (category === "push-to-talk") {
      return AUDIO_CONTROLS_GLOBAL_KEYS["push-to-talk"] ?? null;
    }

    const key = `${category}-${audioAction}`;

    return AUDIO_CONTROLS_GLOBAL_KEYS[key] ?? null;
  }

  private async updateDisplay(
    ev: IDeckWillAppearEvent<AudioControlsSettings> | IDeckDidReceiveSettingsEvent<AudioControlsSettings>,
    settings: AudioControlsSettings,
  ): Promise<void> {
    const svgDataUri = this.renderIcon(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    // The base class re-runs this on every global-settings change, which is
    // what keeps a Race Engineer / Radar key's level current whoever changes
    // it: this key, its partner, the dial, the Settings window, a Pit Crew
    // toggle (#1453).
    this.setRegenerateCallback(ev.action.id, () => this.renderIcon(settings));
  }

  private renderIcon(settings: AudioControlsSettings): string {
    return renderAudioControlsIcon(
      settings,
      this.isBindingMissing(this.resolveGlobalKey(settings.category, settings.action)),
    );
  }
}
