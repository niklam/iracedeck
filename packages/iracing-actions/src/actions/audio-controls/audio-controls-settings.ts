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

import { SPOTTER_GLOBAL_KEYS } from "../../shared/spotter-bindings.js";

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
 * The iRaceDeck-internal audio categories, shared by both surfaces: they step
 * plugin-owned volume globals (Race Engineer voice, Radar ticks) and toggle a
 * feature gate instead of sending anything to iRacing.
 */
export const INTERNAL_AUDIO_CATEGORIES = ["race-engineer", "radar"] as const;
export type InternalAudioCategory = (typeof INTERNAL_AUDIO_CATEGORIES)[number];

const INTERNAL_AUDIO_CATEGORY_SET: ReadonlySet<string> = new Set<string>(INTERNAL_AUDIO_CATEGORIES);

/** Type guard: is this (keypad or dial) category one of iRaceDeck's own audio buses? */
export function isInternalAudioCategory(category: string): category is InternalAudioCategory {
  return INTERNAL_AUDIO_CATEGORY_SET.has(category);
}

/**
 * What a dial ROTATION can control. No `push-to-talk` here — on the dial, PTT
 * is a press action, not a rotate category. `spotter` (#809) is the iRacing
 * AI Spotter volume, driven by the AI Spotter Controls bindings.
 */
export const DIAL_CATEGORIES = ["voice-chat", "master", "spotter", ...INTERNAL_AUDIO_CATEGORIES] as const;
export type DialCategory = (typeof DIAL_CATEGORIES)[number];

/** The dial categories that reach iRacing through blind key bindings. */
export type KeybindDialCategory = Exclude<DialCategory, InternalAudioCategory>;

/** The up/down binding pair a keybind category's ROTATION taps. */
interface RotationBindings {
  /** Tapped once per clockwise detent (volume up / louder). */
  up: string;
  /** Tapped once per counter-clockwise detent (volume down / quieter). */
  down: string;
}

/**
 * Rotation bindings per keybind category. A total record over
 * `KeybindDialCategory`, so adding a keybind category to `DIAL_CATEGORIES`
 * fails to compile until its pair is listed here.
 */
const DIAL_ROTATION_BINDINGS: Record<KeybindDialCategory, RotationBindings> = {
  "voice-chat": { up: VOICE_CHAT_VOLUME_UP_KEY, down: VOICE_CHAT_VOLUME_DOWN_KEY },
  master: { up: MASTER_VOLUME_UP_KEY, down: MASTER_VOLUME_DOWN_KEY },
  spotter: { up: SPOTTER_GLOBAL_KEYS.louder, down: SPOTTER_GLOBAL_KEYS.quieter },
};

/**
 * Mute / Unmute binding per keybind category — a blind one-way tap, since
 * iRacing exposes no mute state for either. Master has no entry: iRacing has
 * no master-mute keybind, so the PI never offers Mute / Unmute for it.
 */
export const DIAL_MUTE_BINDINGS: Partial<Record<KeybindDialCategory, string>> = {
  "voice-chat": VOICE_CHAT_MUTE_KEY,
  spotter: SPOTTER_GLOBAL_KEYS.silence,
};

/**
 * What the dial PRESS runs. `push-to-talk` holds the PTT binding for the
 * duration of the press; `mute-unmute` taps the category's mute binding
 * (`DIAL_MUTE_BINDINGS`) or toggles the internal category's feature gate.
 * Default `none` (blind-safe).
 */
export const DIAL_PRESS_ACTIONS = ["push-to-talk", "mute-unmute", "none"] as const;
export type DialPressAction = (typeof DIAL_PRESS_ACTIONS)[number];

/**
 * Dial-surface settings, stored under the `dial` root key. All fields default,
 * so a keypad-only instance (or a fresh dial) parses `{}` to a full object.
 */
export const AudioDialSettings = z
  .object({
    // .catch per field, not just .default: an unrecognized value (a dial
    // configured on a newer build, or a hand-edited profile) then degrades
    // only that field instead of failing the whole parse, which would drop the
    // instance to full defaults and silently reset the keypad half too.
    category: z.enum(DIAL_CATEGORIES).default("voice-chat").catch("voice-chat"),
    pressAction: z.enum(DIAL_PRESS_ACTIONS).default("none").catch("none"),
  })
  // prefault (not default): a missing `dial` parses {} THROUGH the schema so
  // the per-field defaults apply — same shape as a partially-persisted object.
  .prefault({});

export type AudioDialSettings = z.infer<typeof AudioDialSettings>;

export const AudioControlsSettings = CommonSettings.extend({
  category: z.enum(["push-to-talk", "voice-chat", "master", ...INTERNAL_AUDIO_CATEGORIES]).default("push-to-talk"),
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
 * Binding keys the dial ROTATION requires for a category: both volume keys
 * for a keybind category, none for the internal ones (plugin audio).
 */
export function rotationBindingKeys(category: DialCategory): string[] {
  if (isInternalAudioCategory(category)) return [];

  const { up, down } = DIAL_ROTATION_BINDINGS[category];

  return [up, down];
}

/**
 * The binding one rotate event taps for a keybind category: the `up` key for
 * a clockwise turn (positive ticks), `down` otherwise.
 */
export function resolveRotationBinding(category: KeybindDialCategory, ticks: number): string {
  const { up, down } = DIAL_ROTATION_BINDINGS[category];

  return ticks > 0 ? up : down;
}

/**
 * Binding keys the dial PRESS requires. PTT always needs its binding;
 * Mute / Unmute needs the keybind category's mute binding when it has one —
 * the internal categories toggle their feature gate (no binding) and master
 * has no mute at all.
 */
export function pressBindingKeys(dial: AudioDialSettings): string[] {
  if (dial.pressAction === "push-to-talk") return [PUSH_TO_TALK_KEY];

  if (dial.pressAction === "mute-unmute" && !isInternalAudioCategory(dial.category)) {
    const muteKey = DIAL_MUTE_BINDINGS[dial.category];

    return muteKey ? [muteKey] : [];
  }

  return [];
}
