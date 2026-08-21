/**
 * Maps a settings-window lifecycle outcome to a PI warning record (issue #1005).
 *
 * Both failure paths used to be log-only: the user pressed *Open iRaceDeck
 * Settings* and nothing happened. Since #1003 moved every plugin-global
 * setting into that window, a window that will not open is the difference
 * between "mildly annoying" and "no way to reach your settings", so the
 * condition has to reach the Property Inspector.
 *
 * The decision is pure and takes the status by structure, so it lives beside
 * the controller without depending on it at runtime (the status type is
 * imported for typing only) and all three plugins share the exact same
 * wording — the same shape as `evaluateElevationWarning`.
 *
 * Two ids, because they belong in different parts of a Property Inspector and
 * the placement filters are keyed by id: the page-wide `error` renders in the
 * top strip, the button-scoped `warning` directly above the Open Settings
 * button. They are NOT alternatives — a dead service raises both at once, one
 * explaining the page and one marking the button unusable — so this returns a
 * LIST, and the caller reconciles it against `settingsWindowWarningScope`.
 *
 * The messages intentionally carry NO leading emoji — the `ird-warnings`
 * banner renders a per-level icon itself, so adding one here would double it.
 * They also say "deck software" rather than naming one host, because deck-core
 * serves the Stream Deck, Mirabox, and Ulanzi plugins alike.
 */
import type { PiWarning } from "./pi-warnings.js";
import type { SettingsWindowStatus } from "./settings-window.js";

/** Page-wide: the service never bound. Rendered in the PI's top strip. */
export const SETTINGS_WINDOW_SERVER_WARNING_ID = "settings-window-server";

/** Button-scoped: the service is fine, nothing would open the page. Rendered above the Open Settings button. */
export const SETTINGS_WINDOW_OPEN_WARNING_ID = "settings-window-open";

/**
 * Server never bound. Nothing can be served, so there is no fallback UI to
 * offer — the settings file is the only remaining route, hence the path.
 *
 * The Property Inspector sentence is not padding, it is the part the user most
 * needs: with no settings service a PI has no channel to the plugin and falls
 * back to the deck host's own copy, which `initGlobalSettings` ignores outright
 * once the store is ready ("the store is truth", #993). A binding changed there
 * is echoed by the host, shown as saved, and silently never applied. Somebody
 * who did not know that would spend the evening re-binding a key that cannot
 * take.
 */
export const SETTINGS_WINDOW_SERVER_FAILURE_MESSAGE =
  "iRaceDeck could not start its settings service. The Settings window cannot open, and changes made in a " +
  "Property Inspector — key bindings included — will not take effect until this is fixed. " +
  "A firewall or security tool blocking local connections is the usual cause; " +
  "restart your deck software to try again.";

/**
 * Server is fine; the chromeless app window AND the default-browser tab
 * fallback both failed — i.e. no browser on the machine would open the page.
 *
 * Rarely reachable by construction, and deliberately kept anyway (#1005): the
 * host openers resolve on send rather than on display, so the ordinary
 * no-browser case is indistinguishable from success and this fires only when
 * the opener itself rejects. It is a defensive net — correct whenever it does
 * appear, and not a guarantee that a window which failed to appear is
 * explained. See `openUrl` in `settings-window-launcher.ts`.
 */
export const SETTINGS_WINDOW_OPEN_FAILURE_MESSAGE =
  "iRaceDeck could not open the Settings window. " +
  "The settings service is running, but no browser on this PC would open the page. " +
  "Restart your deck software to try again.";

/**
 * Shown above the button while the service is down, so it is visibly unusable
 * BEFORE a press is wasted on it. Deliberately short and path-free: the
 * page-wide error is on screen at the same time and already carries the cause,
 * the advice and the settings-file path, so repeating any of it would put the
 * same long text on the page twice — which is what splitting the two
 * placements exists to avoid.
 *
 * It cannot be raised by the press itself, which is the tempting design: with
 * no service there is no loopback channel, so the only thing that ever reaches
 * a Property Inspector is the plugin's once-per-start deck-host mirror. A
 * banner raised after that mirror has gone out has no route to the page at all.
 */
export const SETTINGS_WINDOW_OPEN_BLOCKED_MESSAGE =
  "The Settings window cannot open while iRaceDeck's settings service is not running. " +
  "See the error at the top of this panel.";

/**
 * The records a status is entitled to speak for — everything it does NOT
 * return within this scope should be cleared.
 *
 * A server-stage report speaks for both: a dead service decides the page-wide
 * error AND the note above the button, and a healthy one retires whatever an
 * earlier press this run left behind. (Nothing from an EARLIER run can be left
 * behind: `_warnings` is run-scoped since #1014, so every start begins with a
 * clean slate and the first server report is what fills it.) An open-stage
 * report speaks only for its own record; it must never clear the error, which
 * stays accurate regardless of what any single press did.
 */
export function settingsWindowWarningScope(stage: SettingsWindowStatus["stage"]): readonly string[] {
  return stage === "server"
    ? [SETTINGS_WINDOW_SERVER_WARNING_ID, SETTINGS_WINDOW_OPEN_WARNING_ID]
    : [SETTINGS_WINDOW_OPEN_WARNING_ID];
}

export interface SettingsWindowWarningContext {
  /**
   * The plugin's settings-file path, when known. Appended to the message so
   * the banner names something the user can act on — back the file up, or edit
   * it with the deck software stopped. Omitted when unknown rather than
   * rendered as a blank or a placeholder.
   */
  storePath?: string | undefined;
}

/**
 * Every banner that should be showing as a result of this status, within the
 * scope the status speaks for. Empty means "clear that scope".
 *
 * A failed server start yields TWO: the page-wide error, and the short note
 * that marks the Open Settings button as unusable. One condition, two
 * placements — the button lives a full scroll from the top strip in an action
 * PI, so a user down there would otherwise press a button that does nothing and
 * see no explanation anywhere near it.
 */
export function evaluateSettingsWindowWarnings(
  status: SettingsWindowStatus,
  context: SettingsWindowWarningContext,
): PiWarning[] {
  if (status.ok) return [];

  if (status.stage === "server") {
    return [
      {
        id: SETTINGS_WINDOW_SERVER_WARNING_ID,
        level: "error",
        message: withStorePath(SETTINGS_WINDOW_SERVER_FAILURE_MESSAGE, context.storePath),
      },
      { id: SETTINGS_WINDOW_OPEN_WARNING_ID, level: "warning", message: SETTINGS_WINDOW_OPEN_BLOCKED_MESSAGE },
    ];
  }

  return [
    {
      id: SETTINGS_WINDOW_OPEN_WARNING_ID,
      level: "warning",
      message: withStorePath(SETTINGS_WINDOW_OPEN_FAILURE_MESSAGE, context.storePath),
    },
  ];
}

function withStorePath(message: string, storePath: string | undefined): string {
  if (storePath === undefined || storePath === "") return message;

  return `${message} Your settings file is at ${storePath}.`;
}
