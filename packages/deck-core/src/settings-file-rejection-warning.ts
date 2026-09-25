/**
 * Maps a rejected settings file to a PI warning record (issue #1036).
 *
 * When `createFileSettingsStore`'s `load()` cannot parse the settings file it
 * moves the file aside and reports "no file", which sends the plugin to the
 * deck host's copy for the one-time migration. That copy is the settings as of
 * the last successful start (the plugin mirrors its whole cache to the host
 * once per start since #993), so the migration is a restore, not a reset —
 * but until this banner nothing said so, and to the user the settings simply
 * changed. Design: docs/superpowers/specs/2026-08-27-issue-1036-settings-file-rejection-banner.md.
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
 * The banner for a rejection. It names the parser's own reason — the position
 * in it is what turns a mystery into a ten-second fix — and the preserved copy,
 * because a file the user does not know exists is a file they cannot recover.
 *
 * It says the settings came from the deck software's copy. That is true on
 * every path but one: when the host never answers the migration read the start
 * falls back to schema defaults instead. That is a double failure the spec
 * accepts rather than a case worth a second wording (the rejection is reported
 * before the answer is known).
 */
export function evaluateSettingsFileRejectionWarning(rejection: SettingsFileRejection): PiWarning {
  const intro =
    `iRaceDeck could not read your settings file: ${rejection.reason}. ` +
    "Your settings were restored from the copy your deck software keeps, which may be older than your latest changes.";

  const recovery =
    rejection.preservedAt === undefined
      ? ` The file could not be set aside, and iRaceDeck will overwrite it on its next save — copy ${rejection.path} somewhere safe now to keep it.`
      : ` The rejected file is kept as ${rejection.preservedAt}. To get your changes back, fix the error in it, stop your deck software, and rename it to ${basename(rejection.path)}.`;

  return { id: SETTINGS_FILE_REJECTED_WARNING_ID, level: "error", message: intro + recovery };
}
