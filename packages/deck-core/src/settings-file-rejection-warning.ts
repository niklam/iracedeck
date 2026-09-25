/**
 * Maps a rejected settings file to a PI warning record (issue #1036).
 *
 * When `createFileSettingsStore`'s `load()` cannot parse the settings file it
 * moves the file aside and reports "no file", which sends the plugin to the
 * deck host's copy for the one-time migration. That copy is normally the
 * settings as of the last successful start (the plugin mirrors its whole cache
 * to the host once per start since #993), so the migration is a restore, not a
 * reset — but until this banner nothing said so, and to the user the settings
 * simply changed. Design: docs/superpowers/specs/2026-08-27-issue-1036-settings-file-rejection-banner.md.
 *
 * The decision is pure — the same split as `settings-window-warning.ts` and
 * `elevation-warning.ts` — and `settings-file-rejection-reporter.ts` is the
 * only part that writes the warning store.
 *
 * One id at level `error`: the condition speaks for the whole page, so it has
 * no placement filter and renders in the top strip. The message carries no
 * leading emoji (`ird-warnings` renders a per-level icon itself) and says
 * "deck software" rather than naming a host, because deck-core serves all
 * three plugins.
 */
import { basename } from "node:path";

import type { PiWarning } from "./pi-warnings.js";
import type { SettingsFileRejection } from "./settings-store.js";

/** Page-wide: the settings file was rejected this start. Rendered in the PI's top strip. */
export const SETTINGS_FILE_REJECTED_WARNING_ID = "settings-file-rejected";

/**
 * The banner for a rejection. It names where the mistake is — the part that
 * turns a mystery into a ten-second fix — and the preserved copy, because a
 * file the user does not know exists is a file they cannot recover.
 *
 * The location is the store's own (`locateJsonError`), never parsed out of the
 * reason: the hosts run different Node versions, and only the newest puts a
 * line and column in its message. The reason follows in parentheses for the
 * cases a position alone does not explain.
 *
 * What the settings were replaced WITH is worded for every outcome, because it
 * is decided after this is raised (the host's answer, or its silence): the
 * deck software's copy when it answers, defaults when it does not or holds
 * nothing.
 */
export function evaluateSettingsFileRejectionWarning(rejection: SettingsFileRejection): PiWarning {
  const where =
    rejection.location === undefined
      ? ""
      : ` The mistake is at, or just before, line ${rejection.location.line}, column ${rejection.location.column}.`;

  const message =
    `iRaceDeck could not use your settings file (${rejection.reason}).${where} ` +
    "Your settings were replaced with the copy your deck software keeps, which may be older than your latest " +
    "changes, or with defaults if it had none. " +
    `Your file is kept as ${rejection.preservedAt}. To get your changes back, fix the mistake in it, quit your ` +
    `deck software completely (including from the system tray), rename it to ${basename(rejection.path)} ` +
    "replacing the file there, and start your deck software again.";

  return { id: SETTINGS_FILE_REJECTED_WARNING_ID, level: "error", message };
}
