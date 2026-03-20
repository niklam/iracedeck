import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import masterMuteIconSvg from "@iracedeck/icons/audio-controls/master-mute.svg";
import masterVolumeDownIconSvg from "@iracedeck/icons/audio-controls/master-volume-down.svg";
import masterVolumeUpIconSvg from "@iracedeck/icons/audio-controls/master-volume-up.svg";
import voiceChatMuteIconSvg from "@iracedeck/icons/audio-controls/voice-chat-mute.svg";
import voiceChatVolumeDownIconSvg from "@iracedeck/icons/audio-controls/voice-chat-volume-down.svg";
import voiceChatVolumeUpIconSvg from "@iracedeck/icons/audio-controls/voice-chat-volume-up.svg";
import z from "zod";

import {
  CommonSettings,
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalColors,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "../shared/index.js";

type AudioCategory = "voice-chat" | "master";
type AudioAction = "volume-up" | "volume-down" | "mute";

/** Categories that support mute */
const MUTE_CATEGORIES: Set<AudioCategory> = new Set(["voice-chat"]);

/**
 * Flat record mapping "{category}-{action}" keys to imported SVGs.
 */
const AUDIO_ICONS: Record<string, string> = {
  "voice-chat-volume-up": voiceChatVolumeUpIconSvg,
  "voice-chat-volume-down": voiceChatVolumeDownIconSvg,
  "voice-chat-mute": voiceChatMuteIconSvg,
  "master-volume-up": masterVolumeUpIconSvg,
  "master-volume-down": masterVolumeDownIconSvg,
  "master-mute": masterMuteIconSvg,
};

/**
 * Label configuration for each category + action combination.
 */
const AUDIO_CONTROLS_LABELS: Record<AudioCategory, Record<AudioAction, { mainLabel: string; subLabel: string }>> = {
  "voice-chat": {
    "volume-up": { mainLabel: "VOICE", subLabel: "VOL UP" },
    "volume-down": { mainLabel: "VOICE", subLabel: "VOL DOWN" },
    mute: { mainLabel: "VOICE", subLabel: "MUTE" },
  },
  master: {
    "volume-up": { mainLabel: "MASTER", subLabel: "VOL UP" },
    "volume-down": { mainLabel: "MASTER", subLabel: "VOL DOWN" },
    mute: { mainLabel: "MASTER", subLabel: "VOLUME" },
  },
};

/**
 * @internal Exported for testing
 *
 * Mapping from category + action to global settings keys.
 */
export const AUDIO_CONTROLS_GLOBAL_KEYS: Record<string, string> = {
  "voice-chat-volume-up": "audioVoiceChatVolumeUp",
  "voice-chat-volume-down": "audioVoiceChatVolumeDown",
  "voice-chat-mute": "audioVoiceChatMute",
  "master-volume-up": "audioMasterVolumeUp",
  "master-volume-down": "audioMasterVolumeDown",
};

const AudioControlsSettings = CommonSettings.extend({
  category: z.enum(["voice-chat", "master"]).default("voice-chat"),
  action: z.enum(["volume-up", "volume-down", "mute"]).default("volume-up"),
});

type AudioControlsSettings = z.infer<typeof AudioControlsSettings>;

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the audio controls action.
 */
export function generateAudioControlsSvg(settings: AudioControlsSettings): string {
  const { category, action: audioAction } = settings;

  // For master category with mute, fall back to volume-up display
  const effectiveAction = category === "master" && audioAction === "mute" ? "volume-up" : audioAction;

  const iconKey = `${category}-${effectiveAction}`;
  const iconSvg = AUDIO_ICONS[iconKey] || AUDIO_ICONS["voice-chat-volume-up"];
  const labels = AUDIO_CONTROLS_LABELS[category][effectiveAction];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
  const svg = renderIconTemplate(iconSvg, { mainLabel: labels.mainLabel, subLabel: labels.subLabel, ...colors });

  return svgToDataUri(svg);
}

/**
 * Audio Controls Action
 * Provides volume and mute controls for voice chat and master audio
 * categories via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.audio-controls" })
export class AudioControls extends ConnectionStateAwareAction<AudioControlsSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("AudioControls"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<AudioControlsSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);

    this.sdkController.subscribe(ev.action.id, () => {
      this.updateConnectionState();
    });
  }

  override async onWillDisappear(ev: WillDisappearEvent<AudioControlsSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AudioControlsSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<AudioControlsSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);
    await this.executeControl(settings.category, settings.action);
  }

  override async onDialDown(ev: DialDownEvent<AudioControlsSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (MUTE_CATEGORIES.has(settings.category)) {
      await this.executeControl(settings.category, "mute");
    } else {
      await this.executeControl(settings.category, settings.action);
    }
  }

  override async onDialRotate(ev: DialRotateEvent<AudioControlsSettings>): Promise<void> {
    this.logger.info("Dial rotated");
    const settings = this.parseSettings(ev.payload.settings);
    const audioAction: AudioAction = ev.payload.ticks > 0 ? "volume-up" : "volume-down";
    await this.executeControl(settings.category, audioAction);
  }

  private parseSettings(settings: unknown): AudioControlsSettings {
    const parsed = AudioControlsSettings.safeParse(settings);

    return parsed.success ? parsed.data : AudioControlsSettings.parse({});
  }

  private async executeControl(category: AudioCategory, audioAction: AudioAction): Promise<void> {
    this.logger.info("Control executed");
    this.logger.debug(`Executing ${category} ${audioAction}`);

    const settingKey = this.resolveGlobalKey(category, audioAction);

    if (!settingKey) {
      this.logger.warn(`No global key mapping for ${category} ${audioAction}`);

      return;
    }

    const globalSettings = getGlobalSettings() as Record<string, unknown>;
    const binding = parseKeyBinding(globalSettings[settingKey]);

    if (!binding?.key) {
      this.logger.warn(`No key binding configured for ${settingKey}`);

      return;
    }

    this.logger.debug(`Key binding for ${settingKey}: ${formatKeyBinding(binding)} (code=${binding.code ?? "none"})`);

    await this.sendKeyBinding(binding);
  }

  private resolveGlobalKey(category: AudioCategory, audioAction: AudioAction): string | null {
    const key = `${category}-${audioAction}`;

    return AUDIO_CONTROLS_GLOBAL_KEYS[key] ?? null;
  }

  private async sendKeyBinding(binding: KeyBindingValue): Promise<void> {
    const combination: KeyCombination = {
      key: binding.key as KeyboardKey,
      modifiers: binding.modifiers.length > 0 ? (binding.modifiers as KeyboardModifier[]) : undefined,
      code: binding.code,
    };

    const success = await getKeyboard().sendKeyCombination(combination);

    if (success) {
      this.logger.info("Key sent successfully");
      this.logger.debug(`Key combination: ${formatKeyBinding(binding)}`);
    } else {
      this.logger.warn("Failed to send key");
      this.logger.debug(`Failed key combination: ${formatKeyBinding(binding)}`);
    }
  }

  private async updateDisplay(
    ev: WillAppearEvent<AudioControlsSettings> | DidReceiveSettingsEvent<AudioControlsSettings>,
    settings: AudioControlsSettings,
  ): Promise<void> {
    this.updateConnectionState();

    const svgDataUri = generateAudioControlsSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateAudioControlsSvg(settings));
  }
}
