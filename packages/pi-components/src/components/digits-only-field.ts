/**
 * Digits-only text field for Property Inspector pages (issue #1353).
 *
 * A car number is typed into an `sdpi-textfield`, which is always a text input:
 * the component sets its inner input's type itself and reads no `type` or
 * `inputmode` attribute. Keeping the field to digits therefore takes a filter,
 * and the filter has to correct two values. The component copies every
 * keystroke into its own `value` — the one it saves — before a listener on the
 * element runs, so rewriting only the inner input leaves the rejected character
 * stored while the field no longer shows it.
 *
 * Inline PI scripts call `window.irdDigitsOnly(field)`. Leading zeros are kept:
 * `07` and `7` are different car numbers.
 */

/** The part of an `sdpi-textfield` the filter reads and writes. */
type DigitsField = HTMLElement & { value?: unknown };

/** Restrict a text field to digits, in both what it shows and what it stores. */
export function restrictToDigits(field: DigitsField): void {
  field.addEventListener("input", () => {
    const input = (field.shadowRoot ?? field).querySelector("input");

    if (!input) return;

    const digits = input.value.replace(/[^0-9]/g, "");

    if (input.value === digits) return;

    input.value = digits;
    field.value = digits;
  });
}

/** The window surface `installDigitsOnlyField` needs; injectable for testing. */
type InstallTarget = { irdDigitsOnly?: (field: HTMLElement) => void };

declare global {
  interface Window {
    /** Restrict an `sdpi-textfield` to digits, leading zeros kept (issue #1353). */
    irdDigitsOnly?: (field: HTMLElement) => void;
  }
}

/** Expose the filter as `window.irdDigitsOnly`. Idempotent. */
export function installDigitsOnlyField(win: InstallTarget = window): void {
  if (win.irdDigitsOnly) return;

  win.irdDigitsOnly = restrictToDigits;
}
