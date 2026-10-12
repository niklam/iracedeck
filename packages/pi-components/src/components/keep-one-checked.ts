/**
 * A group of `sdpi-checkbox`es that never loses its last tick (issue #1316).
 *
 * Replay Control's dial builds its speed ladder from a grid of checkboxes, one
 * setting per box. A grid with nothing ticked would be a ladder of 0x alone — a
 * dial that does nothing — so the last ticked box must refuse to clear.
 *
 * The refusal has to happen before the component hears about the click. An
 * `sdpi-checkbox` saves on its inner input's `change`, at once, so unticking and
 * then re-ticking the box from a listener would store `false` and then `true`:
 * the plugin would see a map that ticks nothing in between. Cancelling the
 * `click` instead makes the browser put the tick back by itself and fire no
 * `input` or `change` at all, so nothing is saved.
 *
 * `click` is also the one event that reaches a listener outside the
 * component: it crosses the shadow root, where the inner input's `change` does
 * not. One listener on the group, in the capture phase, sees a click on the
 * box, on its label text, and the click the label then forwards to the input.
 * All three are judged by the same state, because the component's `value` does
 * not change until the `change` that follows them.
 *
 * Inline PI scripts call `window.irdKeepOneChecked(group)`.
 */

/** The part of an `sdpi-checkbox` the guard reads. */
type Checkable = Element & { value?: unknown };

/** The selector of the boxes a group guards, unless the caller names another. */
const DEFAULT_SELECTOR = "sdpi-checkbox";

/**
 * Whether a box shows as ticked. The component renders `value ?? default`: its
 * stored value, or its `default` attribute while nothing has been stored.
 */
export function isTicked(box: Checkable): boolean {
  return Boolean(box.value ?? box.getAttribute("default"));
}

/** Keep at least one box of the group ticked: a click that would clear the last one is cancelled. */
export function keepOneChecked(group: HTMLElement, selector: string = DEFAULT_SELECTOR): void {
  group.addEventListener(
    "click",
    (event) => {
      const target = event.target;

      if (!(target instanceof Element)) return;

      const box = target.closest(selector);

      // Not a box of this group, or a box the click would tick rather than clear.
      if (!box || !group.contains(box) || !isTicked(box)) return;

      const ticked = Array.from(group.querySelectorAll(selector)).filter(isTicked);

      if (ticked.length > 1) return;

      event.preventDefault();
    },
    true,
  );
}

/** The window surface `installKeepOneChecked` needs; injectable for testing. */
type InstallTarget = { irdKeepOneChecked?: (group: HTMLElement, selector?: string) => void };

declare global {
  interface Window {
    /** Keep at least one `sdpi-checkbox` of a group ticked (issue #1316). */
    irdKeepOneChecked?: (group: HTMLElement, selector?: string) => void;
  }
}

/** Expose the guard as `window.irdKeepOneChecked`. Idempotent. */
export function installKeepOneChecked(win: InstallTarget = window): void {
  if (win.irdKeepOneChecked) return;

  win.irdKeepOneChecked = keepOneChecked;
}
