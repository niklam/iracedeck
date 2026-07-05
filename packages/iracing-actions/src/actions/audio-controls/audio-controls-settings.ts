/**
 * Audio Controls settings schema (issue #782).
 *
 * One action, two surfaces (the #759 Fuel Service pattern): keypad settings
 * stay FLAT (`category` / `action`, shipped in stable 1.x); dial settings live
 * under the `dial` root object. The binding-key constants are shared by both
 * surfaces and by the comms catalog.
 */
import { CommonSettings } from "@iracedeck/deck-core";
import z from "zod";

/** Global-settings keys for the shared audio key bindings (both surfaces). */
export const PUSH_TO_TALK_KEY = "audioControlsPushToTalk";
export const VOICE_CHAT_VOLUME_UP_KEY = "audioVoiceChatVolumeUp";
export const VOICE_CHAT_VOLUME_DOWN_KEY = "audioVoiceChatVolumeDown";
export const VOICE_CHAT_MUTE_KEY = "audioVoiceChatMute";
export const MASTER_VOLUME_UP_KEY = "audioMasterVolumeUp";
export const MASTER_VOLUME_DOWN_KEY = "audioMasterVolumeDown";

/**
 * Mapping from keypad "{category}-{action}" keys to global settings keys.
 * The internal categories (race-engineer / radar) drive plugin audio and have
 * no entry — they never use a key binding.
 */
export const AUDIO_CONTROLS_GLOBAL_KEYS: Record<string, string> = {
  "push-to-talk": PUSH_TO_TALK_KEY,
  "voice-chat-volume-up": VOICE_CHAT_VOLUME_UP_KEY,
  "voice-chat-volume-down": VOICE_CHAT_VOLUME_DOWN_KEY,
  "voice-chat-mute": VOICE_CHAT_MUTE_KEY,
  "master-volume-up": MASTER_VOLUME_UP_KEY,
  "master-volume-down": MASTER_VOLUME_DOWN_KEY,
};

/**
 * What a dial ROTATION can control. No `push-to-talk` here — on the dial, PTT
 * is a press action, not a rotate category.
 */
export const DIAL_CATEGORIES = ["voice-chat", "master", "race-engineer", "radar"] as const;
export type DialCategory = (typeof DIAL_CATEGORIES)[number];

/**
 * What the dial PRESS runs. `push-to-talk` holds the PTT binding for the
 * duration of the press; `mute-unmute` taps the voice-chat mute binding or
 * toggles the Race Engineer / Radar feature gate (master offers no mute —
 * iRacing has no master-mute keybind). Default `none` (blind-safe).
 */
export const DIAL_PRESS_ACTIONS = ["push-to-talk", "mute-unmute", "none"] as const;
export type DialPressAction = (typeof DIAL_PRESS_ACTIONS)[number];

/**
 * Dial-surface settings, stored under the `dial` root key. All fields default,
 * so a keypad-only instance (or a fresh dial) parses `{}` to a full object.
 */
export const AudioDialSettings = z
  .object({
    category: z.enum(DIAL_CATEGORIES).default("voice-chat"),
    pressAction: z.enum(DIAL_PRESS_ACTIONS).default("none"),
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type AudioDialSettings = z.infer<typeof AudioDialSettings>;

export const AudioControlsSettings = CommonSettings.extend({
  category: z.enum(["push-to-talk", "voice-chat", "master", "race-engineer", "radar"]).default("push-to-talk"),
  action: z.enum(["volume-up", "volume-down", "mute"]).default("volume-up"),
  dial: AudioDialSettings,
});

export type AudioControlsSettings = z.infer<typeof AudioControlsSettings>;

/** Parses raw settings, falling back to full defaults when the parse fails. */
export function parseAudioControlsSettings(raw: unknown): AudioControlsSettings {
  const parsed = AudioControlsSettings.safeParse(raw);

  return parsed.success ? parsed.data : AudioControlsSettings.parse({});
}

/**
 * Binding keys the dial ROTATION requires for a category. Both volume keys are
 * required for the keybind categories; the internal categories (plugin audio)
 * require none.
 */
export function rotationBindingKeys(category: DialCategory): string[] {
  if (category === "voice-chat") return [VOICE_CHAT_VOLUME_UP_KEY, VOICE_CHAT_VOLUME_DOWN_KEY];

  if (category === "master") return [MASTER_VOLUME_UP_KEY, MASTER_VOLUME_DOWN_KEY];

  return [];
}

/**
 * Binding keys the dial PRESS requires. PTT always needs its binding;
 * Mute/Unmute needs the voice-chat mute binding only for the voice-chat
 * category (internal categories toggle the feature gate — no binding).
 */
export function pressBindingKeys(dial: AudioDialSettings): string[] {
  if (dial.pressAction === "push-to-talk") return [PUSH_TO_TALK_KEY];

  if (dial.pressAction === "mute-unmute" && dial.category === "voice-chat") return [VOICE_CHAT_MUTE_KEY];

  return [];
}
