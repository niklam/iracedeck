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
/** iRacing's *Mute a Driver* — silences whoever is transmitting on voice chat (#863). */
export const VOICE_CHAT_MUTE_DRIVER_KEY = "audioVoiceChatMuteDriver";
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
  "voice-chat-mute-driver": VOICE_CHAT_MUTE_DRIVER_KEY,
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
 * iRacing exposes no mute state. Voice chat is the only entry: iRacing has no
 * master-mute keybind, and its Spotter Silence binding skips the call
 * currently playing rather than muting the spotter (#1015), so it is the
 * separate Skip Spotter Call press ({@link DIAL_SKIP_CALL_BINDINGS}). The PI
 * never offers Mute / Unmute for master or spotter.
 */
export const DIAL_MUTE_BINDINGS: Partial<Record<KeybindDialCategory, string>> = {
  "voice-chat": VOICE_CHAT_MUTE_KEY,
};

/**
 * The mute map as a total record, for callers that can't accept the optional
 * values of {@link DIAL_MUTE_BINDINGS} (the comms catalog builds its
 * `keyBy` map from this).
 */
export function dialMuteBindingMap(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DIAL_MUTE_BINDINGS).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Mute a Driver binding per keybind category (#863) — a second table beside
 * {@link DIAL_MUTE_BINDINGS} rather than an exception inside it: a per-category
 * special case in `mute-unmute` would make one press action mean two different
 * things depending on the Mode, which the trigger description cannot honestly
 * label. Kept in the same `Partial<Record<KeybindDialCategory, string>>` shape
 * so "which categories offer this press" is a lookup, not a conditional, and
 * so the comms catalog derives the PI's availability from the same table the
 * surface dispatches from. One entry today: only iRacing's voice chat has a
 * per-driver mute (spotter and master have no such control).
 */
export const DIAL_MUTE_DRIVER_BINDINGS: Partial<Record<KeybindDialCategory, string>> = {
  "voice-chat": VOICE_CHAT_MUTE_DRIVER_KEY,
};

/**
 * The driver-mute map as a total record, for callers that can't accept the
 * optional values of {@link DIAL_MUTE_DRIVER_BINDINGS} (the comms catalog
 * builds its `keyBy` map from this) — the {@link dialMuteBindingMap} twin.
 */
export function dialMuteDriverBindingMap(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DIAL_MUTE_DRIVER_BINDINGS).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Skip Spotter Call binding per keybind category (#1015) — iRacing's
 * *Spotter Silence*, which cuts the spotter call currently playing. A one-shot,
 * not a mute: iRacing has no control that silences the spotter permanently.
 * Its own table beside {@link DIAL_MUTE_BINDINGS} for the #863 reason (one
 * press value must not mean different things per Mode), in the same shape so
 * the comms catalog derives the PI's availability from the table the surface
 * dispatches from. One entry: only the spotter has such a control.
 */
export const DIAL_SKIP_CALL_BINDINGS: Partial<Record<KeybindDialCategory, string>> = {
  spotter: SPOTTER_GLOBAL_KEYS.silence,
};

/**
 * The skip-call map as a total record, for callers that can't accept the
 * optional values of {@link DIAL_SKIP_CALL_BINDINGS} (the comms catalog builds
 * its `keyBy` map from this) — the {@link dialMuteBindingMap} twin.
 */
export function dialSkipCallBindingMap(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DIAL_SKIP_CALL_BINDINGS).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * What the dial PRESS runs. `push-to-talk` holds the PTT binding for the
 * duration of the press; `mute-unmute` taps the category's mute binding
 * (`DIAL_MUTE_BINDINGS`) or toggles the internal category's feature gate;
 * `mute-driver` taps the category's driver-mute binding
 * (`DIAL_MUTE_DRIVER_BINDINGS`, voice chat only — #863); `skip-call` taps the
 * category's skip-call binding (`DIAL_SKIP_CALL_BINDINGS`, spotter only —
 * #1015). Default `none` (blind-safe).
 */
export const DIAL_PRESS_ACTIONS = ["push-to-talk", "mute-unmute", "mute-driver", "skip-call", "none"] as const;
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
  // Same per-field .catch as the dial fields: the two surfaces share one
  // settings blob, so an unrecognized keypad value must not take the dial's
  // configuration down with it (or vice versa).
  category: z
    .enum(["push-to-talk", "voice-chat", "master", ...INTERNAL_AUDIO_CATEGORIES])
    .default("push-to-talk")
    .catch("push-to-talk"),
  action: z.enum(["volume-up", "volume-down", "mute", "mute-driver"]).default("volume-up").catch("volume-up"),
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
  // Fail-soft (unlike resolveRotationBinding): this feeds the touch-strip
  // render, so an unexpected category must degrade to "no bindings needed"
  // rather than throw and kill the strip.
  const bindings = isInternalAudioCategory(category) ? undefined : DIAL_ROTATION_BINDINGS[category];

  return bindings ? [bindings.up, bindings.down] : [];
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
 * has no mute at all; Mute a Driver (#863) needs the category's driver-mute
 * binding when it has one (voice chat only); Skip Spotter Call (#1015) needs
 * the category's skip-call binding when it has one (spotter only).
 */
export function pressBindingKeys(dial: AudioDialSettings): string[] {
  if (dial.pressAction === "push-to-talk") return [PUSH_TO_TALK_KEY];

  // Fail-soft like rotationBindingKeys: this feeds the touch-strip render, so
  // a category without the press degrades to "no bindings needed".
  if (dial.pressAction === "mute-unmute" && !isInternalAudioCategory(dial.category)) {
    const muteKey = DIAL_MUTE_BINDINGS[dial.category];

    return muteKey ? [muteKey] : [];
  }

  if (dial.pressAction === "mute-driver" && !isInternalAudioCategory(dial.category)) {
    const muteDriverKey = DIAL_MUTE_DRIVER_BINDINGS[dial.category];

    return muteDriverKey ? [muteDriverKey] : [];
  }

  if (dial.pressAction === "skip-call" && !isInternalAudioCategory(dial.category)) {
    const skipCallKey = DIAL_SKIP_CALL_BINDINGS[dial.category];

    return skipCallKey ? [skipCallKey] : [];
  }

  return [];
}
