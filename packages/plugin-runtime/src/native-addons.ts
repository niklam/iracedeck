/**
 * What the plugin says when a native addon failed to load (#1373).
 *
 * Both native packages report how their `.node` loaded (`getNativeLoadStatus()`),
 * read once by `initCore` into `Core.nativeAddons`. This module turns those two
 * statuses into everything the plugin says about them, and touches nothing:
 * the log lines `initCore` writes, the Property Inspector banners the settings
 * phase re-asserts on every settings arrival, and the snapshot's view.
 *
 * Only `load-failed` says anything. A `native` or `mock` status logs nothing
 * new, raises no banner and clears none: nothing else writes these ids, and
 * the condition is fixed for the run.
 *
 * Decision record: `docs/superpowers/specs/2026-10-20-issue-1373-native-load-failure.md`.
 */
import type { PiWarning } from "@iracedeck/app-constants";
import type { NativeLoadStatus as AudioNativeLoadStatus } from "@iracedeck/audio-native";
import type { NativeLoadStatus as IRacingNativeLoadStatus } from "@iracedeck/iracing-native";

/** The two addons' load statuses, as `initCore` read them at startup. */
export interface NativeAddonStatuses {
  readonly iracing: IRacingNativeLoadStatus;
  readonly audio: AudioNativeLoadStatus;
}

type NativeAddon = keyof NativeAddonStatuses;

/** The `_warnings` id of each addon's banner. */
export const NATIVE_ADDON_WARNING_IDS: Readonly<Record<NativeAddon, string>> = {
  iracing: "native-addon-iracing",
  audio: "native-addon-audio",
};

/** Listed in this order everywhere: the log, the banners, the snapshot. */
const ADDONS: readonly NativeAddon[] = ["iracing", "audio"];

/** The log line's subject and consequence. Names the file, which a support log needs. */
const LOG_SUBJECT: Readonly<Record<NativeAddon, string>> = {
  iracing: "iRacing native addon (iracing_native.node) failed to load; iRacing will read as not running",
  audio: "Audio native addon (audio_native.node) failed to load; the Race Engineer and the radar will be silent",
};

/**
 * Each banner says what does not work and the two remedies a user can act on,
 * and points at the log for the rest. No file path: it would sit under the
 * Windows profile, and the log line carries it.
 */
const REMEDY =
  "Reinstall the plugin and check that your antivirus has not quarantined it. The plugin log has the details.";

const BANNER: Readonly<Record<NativeAddon, string>> = {
  iracing: `iRaceDeck could not load its iRacing component, so keys cannot read or control iRacing. ${REMEDY}`,
  audio: `iRaceDeck could not load its audio component, so the Race Engineer and the radar are silent. ${REMEDY}`,
};

/** The failed addons, in order, with their error messages. */
function failures(statuses: NativeAddonStatuses): { addon: NativeAddon; error: string }[] {
  return ADDONS.flatMap((addon) => {
    const status = statuses[addon];

    return status.kind === "load-failed" ? [{ addon, error: status.error }] : [];
  });
}

/** One `error` line per failed addon, naming it and carrying the load error. Empty when none failed. */
export function nativeLoadErrorLines(statuses: NativeAddonStatuses): string[] {
  return failures(statuses).map(({ addon, error }) => `${LOG_SUBJECT[addon]}: ${error}`);
}

/** One `error`-level banner per failed addon, under that addon's own id. Empty when none failed. */
export function evaluateNativeAddonWarnings(statuses: NativeAddonStatuses): PiWarning[] {
  return failures(statuses).map(({ addon }) => ({
    id: NATIVE_ADDON_WARNING_IDS[addon],
    level: "error",
    message: BANNER[addon],
  }));
}

/** A load status as the Telemetry Snapshot records it: the kind, and a mock's reason. */
export type NativeAddonSnapshot =
  { kind: "native" } | { kind: "mock"; reason: "platform" | "forced" } | { kind: "load-failed" };

/**
 * The statuses for the snapshot's `environment` section. A failed load keeps
 * only its kind: the error text names the `.node` path, and that section
 * never holds a path.
 */
export function snapshotNativeAddons(statuses: NativeAddonStatuses): Record<NativeAddon, NativeAddonSnapshot> {
  const view = (status: NativeAddonStatuses[NativeAddon]): NativeAddonSnapshot =>
    status.kind === "mock" ? { kind: "mock", reason: status.reason } : { kind: status.kind };

  return { iracing: view(statuses.iracing), audio: view(statuses.audio) };
}
