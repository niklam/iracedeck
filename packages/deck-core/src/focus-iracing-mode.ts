/**
 * Focus iRacing Window mode (issue #977).
 *
 * The `focusIRacingWindow` global setting grew from a switch into a mode:
 *
 * - `always`   — before every key press, dial press and dial rotation (the
 *                adapter-level hooks in each plugin.ts), as since 3.0 (#930).
 * - `required` — only before something that needs the foreground: a keyboard
 *                binding, chat text, a touch gesture that taps a binding.
 * - `never`    — no focusing at all (the old "off").
 *
 * A leaf module on purpose: `global-settings.ts` needs it for the schema and
 * `window-focus-service.ts` needs it to read the cache, and the service already
 * imports the schema module, so the vocabulary can live in neither.
 */

export const FOCUS_IRACING_MODES = ["always", "required", "never"] as const;

export type FocusIRacingMode = (typeof FOCUS_IRACING_MODES)[number];

export const DEFAULT_FOCUS_IRACING_MODE: FocusIRacingMode = "always";

/**
 * Fold any persisted value into a mode. The transform IS the migration: a
 * file written before #977 holds `true` / `false` (or their string forms from a
 * Property Inspector), and every future read of such a file lands here. An
 * unknown value resolves to the default rather than throwing, because a single
 * throwing field aborts the whole settings parse (#896).
 */
export function parseFocusIRacingMode(value: unknown): FocusIRacingMode {
  if (value === true || value === "true") return "always";

  if (value === false || value === "false") return "never";

  if (typeof value === "string" && (FOCUS_IRACING_MODES as readonly string[]).includes(value)) {
    return value as FocusIRacingMode;
  }

  return DEFAULT_FOCUS_IRACING_MODE;
}
