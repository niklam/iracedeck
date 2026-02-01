import streamDeck, {
  action,
  DialDownEvent,
  DialRotateEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  WillAppearEvent,
  WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  ConnectionStateAwareAction,
  createSDLogger,
  formatKeyBinding,
  getGlobalSettings,
  getKeyboard,
  type KeyBindingValue,
  type KeyboardKey,
  type KeyboardModifier,
  type KeyCombination,
  LogLevel,
  parseKeyBinding,
  renderIconTemplate,
  svgToDataUri,
} from "@iracedeck/stream-deck-shared";
import z from "zod";

import audioControlsTemplate from "../../icons/audio-controls.svg";

const WHITE = "#ffffff";
const GRAY = "#888888";
const GREEN = "#2ecc71";
const RED = "#e74c3c";
const YELLOW = "#f1c40f";

type AudioCategory = "spotter" | "voice-chat" | "master";
type AudioAction = "volume-up" | "volume-down" | "mute";

/** Categories that support mute/silence */
const MUTE_CATEGORIES: Set<AudioCategory> = new Set(["spotter", "voice-chat"]);

/**
 * Label configuration for each category + action combination.
 */
const AUDIO_CONTROLS_LABELS: Record<AudioCategory, Record<AudioAction, { line1: string; line2: string }>> = {
  spotter: {
    "volume-up": { line1: "SPOTTER", line2: "VOL UP" },
    "volume-down": { line1: "SPOTTER", line2: "VOL DOWN" },
    mute: { line1: "SPOTTER", line2: "SILENCE" },
  },
  "voice-chat": {
    "volume-up": { line1: "VOICE", line2: "VOL UP" },
    "volume-down": { line1: "VOICE", line2: "VOL DOWN" },
    mute: { line1: "VOICE", line2: "MUTE" },
  },
  master: {
    "volume-up": { line1: "MASTER", line2: "VOL UP" },
    "volume-down": { line1: "MASTER", line2: "VOL DOWN" },
    mute: { line1: "MASTER", line2: "VOLUME" },
  },
};

/**
 * SVG icon content for each category + action combination.
 */
const AUDIO_CONTROLS_ICONS: Record<AudioCategory, Record<AudioAction, string>> = {
  spotter: {
    "volume-up": `
    <path d="M20 20v12h6l8 8V12l-8 8h-6z" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M40 17a8 8 0 0 1 0 18" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M44 12a14 14 0 0 1 0 28" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="54,22 58,16 62,22" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "volume-down": `
    <path d="M20 20v12h6l8 8V12l-8 8h-6z" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M40 17a8 8 0 0 1 0 18" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M44 12a14 14 0 0 1 0 28" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="54,16 58,22 62,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    mute: `
    <path d="M20 20v12h6l8 8V12l-8 8h-6z" fill="none" stroke="${GRAY}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M40 17a8 8 0 0 1 0 18" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="18" y1="14" x2="50" y2="38" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>`,
  },
  "voice-chat": {
    "volume-up": `
    <rect x="30" y="10" width="12" height="20" rx="6" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <path d="M24 24v4a12 12 0 0 0 24 0v-4" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="36" y1="40" x2="36" y2="44" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="54,22 58,16 62,22" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "volume-down": `
    <rect x="30" y="10" width="12" height="20" rx="6" fill="none" stroke="${WHITE}" stroke-width="2"/>
    <path d="M24 24v4a12 12 0 0 0 24 0v-4" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <line x1="36" y1="40" x2="36" y2="44" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <polyline points="54,16 58,22 62,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    mute: `
    <rect x="30" y="10" width="12" height="20" rx="6" fill="none" stroke="${GRAY}" stroke-width="2"/>
    <path d="M24 24v4a12 12 0 0 0 24 0v-4" fill="none" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>
    <line x1="36" y1="40" x2="36" y2="44" stroke="${GRAY}" stroke-width="2" stroke-linecap="round"/>
    <line x1="22" y1="14" x2="50" y2="42" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>`,
  },
  master: {
    "volume-up": `
    <path d="M16 20v12h8l10 10V10L24 20h-8z" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M40 15a12 12 0 0 1 0 22" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M44 10a18 18 0 0 1 0 32" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="54,22 58,16 62,22" fill="none" stroke="${GREEN}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "volume-down": `
    <path d="M16 20v12h8l10 10V10L24 20h-8z" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M40 15a12 12 0 0 1 0 22" fill="none" stroke="${WHITE}" stroke-width="2" stroke-linecap="round"/>
    <path d="M44 10a18 18 0 0 1 0 32" fill="none" stroke="${WHITE}" stroke-width="1.5" stroke-linecap="round"/>
    <polyline points="54,16 58,22 62,16" fill="none" stroke="${YELLOW}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    mute: `
    <path d="M16 20v12h8l10 10V10L24 20h-8z" fill="none" stroke="${GRAY}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M40 15a12 12 0 0 1 0 22" fill="none" stroke="${GRAY}" stroke-width="1.5" stroke-linecap="round"/>
    <line x1="14" y1="14" x2="52" y2="38" stroke="${RED}" stroke-width="2.5" stroke-linecap="round"/>`,
  },
};

/**
 * @internal Exported for testing
 *
 * Mapping from category + action to global settings keys.
 */
export const AUDIO_CONTROLS_GLOBAL_KEYS: Record<string, string> = {
  "spotter-volume-up": "audioSpotterVolumeUp",
  "spotter-volume-down": "audioSpotterVolumeDown",
  "spotter-mute": "audioSpotterSilence",
  "voice-chat-volume-up": "audioVoiceChatVolumeUp",
  "voice-chat-volume-down": "audioVoiceChatVolumeDown",
  "voice-chat-mute": "audioVoiceChatMute",
  "master-volume-up": "audioMasterVolumeUp",
  "master-volume-down": "audioMasterVolumeDown",
};

const AudioControlsSettings = z.object({
  category: z.enum(["spotter", "voice-chat", "master"]).default("spotter"),
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

  const iconContent = AUDIO_CONTROLS_ICONS[category][effectiveAction];
  const labels = AUDIO_CONTROLS_LABELS[category][effectiveAction];

  const svg = renderIconTemplate(audioControlsTemplate, {
    iconContent,
    labelLine1: labels.line1,
    labelLine2: labels.line2,
  });

  return svgToDataUri(svg);
}

/**
 * Audio Controls Action
 * Provides volume and mute controls for spotter, voice chat, and master audio
 * categories via keyboard shortcuts.
 */
@action({ UUID: "com.iracedeck.sd.core.audio-controls" })
export class AudioControls extends ConnectionStateAwareAction<AudioControlsSettings> {
  protected override logger = createSDLogger(streamDeck.logger.createScope("AudioControls"), LogLevel.Info);

  override async onWillAppear(ev: WillAppearEvent<AudioControlsSettings>): Promise<void> {
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
  }
}
