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

import { SPOTTER_BINDING_KEYS } from "../../shared/spotter-bindings.js";

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
 * is a press action, not a rotate category. `spotter` (#809) is the iRacing
 * AI Spotter volume, driven by the AI Spotter Controls bindings.
 */
export const DIAL_CATEGORIES = ["voice-chat", "master", "spotter", "race-engineer", "radar"] as const;
export type DialCategory = (typeof DIAL_CATEGORIES)[number];

/**
 * The iRaceDeck-internal categories: they step plugin-owned volume globals
 * (Race Engineer voice, Radar ticks) and toggle a feature gate on Mute /
 * Unmute — no iRacing binding is ever involved. Every other category is an
 * iRacing one, reached through blind key bindings.
 */
const INTERNAL_DIAL_CATEGORIES: ReadonlySet<DialCategory> = new Set<DialCategory>(["race-engineer", "radar"]);

export function isInternalDialCategory(category: DialCategory): boolean {
  return INTERNAL_DIAL_CATEGORIES.has(category);
}

/** The up/down binding pair a keybind category's ROTATION taps. */
interface RotationBindings {
  /** Tapped once per clockwise detent (volume up / louder). */
  up: string;
  /** Tapped once per counter-clockwise detent (volume down / quieter). */
  down: string;
}

/**
 * Rotation bindings per iRacing category. Adding a keybind category is one
 * entry here (plus its mute binding below, if iRacing offers one) — the dial
 * surface never branches on the category name for rotation. The internal
 * categories are absent: they step plugin audio, not a binding.
 */
const DIAL_ROTATION_BINDINGS: Partial<Record<DialCategory, RotationBindings>> = {
  "voice-chat": { up: VOICE_CHAT_VOLUME_UP_KEY, down: VOICE_CHAT_VOLUME_DOWN_KEY },
  master: { up: MASTER_VOLUME_UP_KEY, down: MASTER_VOLUME_DOWN_KEY },
  spotter: { up: SPOTTER_BINDING_KEYS.louder, down: SPOTTER_BINDING_KEYS.quieter },
};

/**
 * Mute / Unmute binding per iRacing category. Voice chat taps iRacing's
 * voice-chat mute; the spotter taps Spotter Silence (#809). Both are blind
 * one-way taps — iRacing exposes no mute state for either. Master has no
 * entry because iRacing has no master-mute keybind, so the PI never offers
 * Mute / Unmute for it.
 */
export const DIAL_MUTE_BINDINGS: Partial<Record<DialCategory, string>> = {
  "voice-chat": VOICE_CHAT_MUTE_KEY,
  spotter: SPOTTER_BINDING_KEYS.silence,
};

/**
 * What the dial PRESS runs. `push-to-talk` holds the PTT binding for the
 * duration of the press; `mute-unmute` taps the category's mute binding
 * (voice-chat mute, spotter silence — see `DIAL_MUTE_BINDINGS`) or toggles
 * the Race Engineer / Radar feature gate (master offers no mute — iRacing has
 * no master-mute keybind). Default `none` (blind-safe).
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
  const bindings = DIAL_ROTATION_BINDINGS[category];

  return bindings ? [bindings.up, bindings.down] : [];
}

/**
 * The binding one rotate event should tap for a keybind category: the `up`
 * key for a clockwise turn (positive ticks), `down` for counter-clockwise.
 * `undefined` for the internal categories (they step plugin audio instead)
 * and for a zero tick delta.
 */
export function resolveRotationBinding(category: DialCategory, ticks: number): string | undefined {
  const bindings = DIAL_ROTATION_BINDINGS[category];

  if (!bindings || ticks === 0) return undefined;

  return ticks > 0 ? bindings.up : bindings.down;
}

/**
 * Binding keys the dial PRESS requires. PTT always needs its binding;
 * Mute/Unmute needs the category's mute binding when it has one (voice chat,
 * spotter) — the internal categories toggle the feature gate (no binding) and
 * master has no mute at all.
 */
export function pressBindingKeys(dial: AudioDialSettings): string[] {
  if (dial.pressAction === "push-to-talk") return [PUSH_TO_TALK_KEY];

  if (dial.pressAction === "mute-unmute") {
    const muteKey = DIAL_MUTE_BINDINGS[dial.category];

    return muteKey ? [muteKey] : [];
  }

  return [];
}
