/**
 * The banner for a `cameras.json` that could not be parsed (#1653).
 *
 * `createFileSettingsStore` moves such a file aside as
 * `cameras.corrupt-<iso>.json`, reports it through `onRejected`, and the
 * catalog starts empty. Without this banner the remembered groups would simply
 * vanish from every picker.
 *
 * The decision is pure — the shape of `@iracedeck/settings`'
 * `settings-file-rejection-warning.ts` — and the reporter below is the one part
 * that writes the warning store, through an injected `setWarning`.
 *
 * One id at level `warning`, page-wide (no placement filter): the catalog is
 * an observation the plugin rebuilds by itself, so losing it is worth saying
 * but is not an error the user must act on. Set-only, like the settings-file
 * banner: `_warnings` is run-scoped, so a start whose file parses has nothing
 * to clear, and a start that rejects the file raises it again.
 *
 * The message carries no leading emoji (`ird-warnings` draws the level icon).
 */
import type { PiWarning, PiWarningLevel } from "@iracedeck/app-constants";
import type { SettingsFileRejection } from "@iracedeck/settings";
import { setWarning as settingsSetWarning } from "@iracedeck/settings";

/** Page-wide: `cameras.json` was set aside this start. */
export const CAMERA_CATALOG_REJECTED_WARNING_ID = "camera-catalog-rejected";

/** The banner for a rejected `cameras.json`. Names the preserved copy, so the user can find it. */
export function evaluateCameraCatalogRejectionWarning(
  rejection: Pick<SettingsFileRejection, "preservedAt">,
): PiWarning {
  const message =
    "iRaceDeck could not read its list of remembered camera groups. " +
    `The file was kept as ${rejection.preservedAt}. ` +
    "iRaceDeck starts a fresh list from the next session, and your keys keep their camera groups.";

  return { id: CAMERA_CATALOG_REJECTED_WARNING_ID, level: "warning", message };
}

export interface CameraCatalogRejectionReporterOptions {
  /** Defaults to `@iracedeck/settings`' `setWarning`; injected in tests. */
  setWarning?: (id: string, level: PiWarningLevel, message: string) => void;
}

/** Create the catalog store's `onRejected` handler. */
export function createCameraCatalogRejectionReporter(
  options: CameraCatalogRejectionReporterOptions = {},
): (rejection: SettingsFileRejection) => void {
  const set = options.setWarning ?? settingsSetWarning;

  return (rejection) => {
    const warning = evaluateCameraCatalogRejectionWarning(rejection);

    set(warning.id, warning.level, warning.message);
  };
}
