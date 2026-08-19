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
 * ONE warning id covers both failures rather than two. They are mutually
 * exclusive by construction — `open()` starts the server first, so a dead
 * server fails at the server stage and never reaches the launch — and a single
 * state-driven record means the user can never be shown two banners for one
 * broken thing, with the later state simply replacing the earlier one.
 *
 * The messages intentionally carry NO leading emoji — the `ird-warnings`
 * banner renders a per-level icon itself, so adding one here would double it.
 * They also say "deck software" rather than naming one host, because deck-core
 * serves the Stream Deck, Mirabox, and Ulanzi plugins alike.
 */
import type { PiWarning } from "./pi-warnings.js";
import type { SettingsWindowStatus } from "./settings-window.js";

export const SETTINGS_WINDOW_WARNING_ID = "settings-window";

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
 */
export const SETTINGS_WINDOW_OPEN_FAILURE_MESSAGE =
  "iRaceDeck could not open the Settings window. " +
  "The settings service is running, but no browser on this PC would open the page. " +
  "Restart your deck software to try again.";

export interface SettingsWindowWarningContext {
  /**
   * The plugin's settings-file path, when known. Appended to the message so
   * the banner names something the user can act on — back the file up, or edit
   * it with the deck software stopped. Omitted when unknown rather than
   * rendered as a blank or a placeholder.
   */
  storePath?: string | undefined;
}

export function evaluateSettingsWindowWarning(
  status: SettingsWindowStatus,
  context: SettingsWindowWarningContext,
): PiWarning | null {
  if (status.ok) return null;

  const level = status.stage === "server" ? "error" : "warning";
  const message =
    status.stage === "server" ? SETTINGS_WINDOW_SERVER_FAILURE_MESSAGE : SETTINGS_WINDOW_OPEN_FAILURE_MESSAGE;

  return { id: SETTINGS_WINDOW_WARNING_ID, level, message: withStorePath(message, context.storePath) };
}

function withStorePath(message: string, storePath: string | undefined): string {
  if (storePath === undefined || storePath === "") return message;

  return `${message} Your settings file is at ${storePath}.`;
}
