import {
  assembleIcon,
  ConnectionStateAwareAction,
  getGlobalBorderSettings,
  getGlobalColors,
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

import { INTERNAL_AUDIO_BUSES } from "./audio-buses.js";
import {
  AUDIO_CONTROLS_GLOBAL_KEYS,
  type AudioControlsSettings,
  type InternalAudioCategory,
  isInternalAudioCategory,
  parseAudioControlsSettings,
} from "./audio-controls-settings.js";
import { AudioDialSurface } from "./audio-dial-surface.js";
import { migrateSpotterMuteToSkipCall } from "./migrate-spotter-mute-to-skip-call.js";

// Re-export for test back-compat (@internal, tests import from this path).
export { AUDIO_CONTROLS_GLOBAL_KEYS };

type AudioCategory = "push-to-talk" | "voice-chat" | "master" | "race-engineer" | "radar";
type AudioAction = "volume-up" | "volume-down" | "mute" | "mute-driver";

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
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the audio controls action.
 */
export function generateAudioControlsSvg(settings: AudioControlsSettings, bindingMissing = false): string {
  const { category, action: audioAction } = settings;

  let iconKey: string;
  let defaultTitle: string;

  if (category === "push-to-talk") {
    iconKey = "push-to-talk";
    defaultTitle = AUDIO_CONTROLS_TITLES["push-to-talk"] || "TALK";
  } else {
    iconKey = `${category}-${audioAction}`;
    defaultTitle =
      AUDIO_CONTROLS_TITLES[`${category}-${audioAction}`] || AUDIO_CONTROLS_TITLES[iconKey] || "AUDIO\nCONTROLS";
  }

  const iconSvg = AUDIO_ICONS[iconKey] || AUDIO_ICONS["push-to-talk"];
  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
  const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);
  const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

  return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
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

  override async onWillAppear(ev: IDeckWillAppearEvent<AudioControlsSettings>): Promise<void> {
    // BEFORE super: the base stamps a missing `addedWithVersion` with its own
    // setSettings({...payload, addedWithVersion}). Migrating first (and handing
    // the base the migrated payload) makes that stamp write land last AND carry
    // the migrated dial — the other order would drop the stamp.
    await this.persistMigratedSettings(ev);
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);

    if (ev.action.isDial()) {
      await this.dialSurface.willAppear(ev.action, settings);

      return;
    }

    const activeKey = this.resolveGlobalKey(settings.category, settings.action);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

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

    const activeKey = this.resolveGlobalKey(settings.category, settings.action);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    await this.updateDisplay(ev, settings);
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
    } else if (isInternalAudioCategory(settings.category)) {
      // iRaceDeck's own audio buses (Race Engineer voice, Radar ticks): step
      // the global and apply it to the audio engine directly via the shared
      // helpers — no keyboard binding is involved, hence no entry in
      // AUDIO_CONTROLS_GLOBAL_KEYS. The dial surface (#782) steps the same
      // globals through the signed multi-step helpers.
      this.stepInternalVolume(settings.category, settings.action);
    } else {
      await this.executeControl(settings.category, settings.action);
    }
  }

  override async onKeyUp(ev: IDeckKeyUpEvent<AudioControlsSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.category === "push-to-talk") {
      this.logger.info("Key up received");
      await this.releaseBinding(ev.action.id);
    }
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<AudioControlsSettings>): Promise<void> {
    await this.dialSurface.willDisappear(ev.action.id);
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
   * Step an iRaceDeck-internal audio bus (Race Engineer voice or Radar ticks)
   * one detent up or down through the shared {@link INTERNAL_AUDIO_BUSES}
   * table — the same wiring the dial rotates, so the two surfaces can't drift.
   * The helper persists the new value and applies it to the audio engine;
   * Race Engineer stepping respects the master enable gate (the value updates
   * but Voice stays muted while the Race Engineer feature is off).
   *
   * These categories expose only volume-up / volume-down in the Property
   * Inspector, so a mute value here is a STALE persisted setting — a
   * hand-edited or imported profile, or a key whose PI has not been reopened.
   * It logs and no-ops, matching the dial's `doMute` / `doMuteDriver`. It used
   * to treat anything that wasn't `volume-down` as a step up, which turned
   * such a setting into a silent volume increase on every single press.
   */
  private stepInternalVolume(category: InternalAudioCategory, audioAction: AudioAction): void {
    if (audioAction !== "volume-up" && audioAction !== "volume-down") {
      this.logger.warn(`${audioAction} is not available for the ${category} category`);

      return;
    }

    const down = audioAction === "volume-down";
    const next = INTERNAL_AUDIO_BUSES[category].stepBy(down ? -1 : 1);
    this.logger.info(`${category} volume ${down ? "down" : "up"} → ${next}`);
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
    const activeKey = this.resolveGlobalKey(settings.category, settings.action);
    const svgDataUri = generateAudioControlsSvg(settings, this.isBindingMissing(activeKey));
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () =>
      generateAudioControlsSvg(
        settings,
        this.isBindingMissing(this.resolveGlobalKey(settings.category, settings.action)),
      ),
    );
  }
}
