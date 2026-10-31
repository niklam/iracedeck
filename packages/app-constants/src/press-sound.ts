/**
 * Press sounds (issue #269): the `pressSound` global-setting key, its values
 * and its default.
 *
 * - `none`       — no sound (the default, labelled "No sound").
 * - `taps`       — a single bleep when a press acts as a tap.
 * - `long-press` — a double bleep when a hold passes the long-press threshold.
 * - `both`       — the single and the double bleep.
 *
 * In the `app-constants` leaf because the settings schema, deck-core's press
 * sound wrapper and the settings window's select all name the same four values
 * (spec `2026-10-28-issue-269-press-sounds.md`). The values are persisted: a
 * value never changes once shipped, only its label in the partial may.
 */

/** The global-settings key the press sound mode is stored under. */
export const PRESS_SOUND_KEY = "pressSound";

/** The `pressSound` values, in the order the settings window lists them. */
export const PRESS_SOUND_MODES = ["none", "taps", "long-press", "both"] as const;

/** Which press sounds play. */
export type PressSoundMode = (typeof PRESS_SOUND_MODES)[number];

/**
 * Default `pressSound` mode: `none`, so nothing new plays until the driver asks
 * for it. Shared by the `GlobalSettingsSchema` field and deck-core's reader so
 * the two can never disagree. Changing it reaches new installs only: every
 * write persists the whole parsed cache, so an existing user keeps what they
 * have (`global-settings.md`).
 */
export const DEFAULT_PRESS_SOUND_MODE: PressSoundMode = "none";
