/**
 * Where `@elgato/streamdeck` writes the plugin's log (#1330).
 *
 * The SDK does not expose its log path, but the main-thread watchdog's worker
 * must append to that same file, so the derivation is repeated here and
 * checked against the SDK's own code in `log-file.test.ts`: the SDK's logger is
 * a `FileTarget` with `dest: <cwd>/logs` and `fileName: getPluginUUID()`, and
 * `FileTarget` always writes index 0, renaming older files away from it.
 */
import { basename, join } from "node:path";

/**
 * The plugin UUID as `@elgato/streamdeck`'s (unexported) `getPluginUUID`
 * derives it: the working directory's name, cut at its last `.sdPlugin`.
 */
export function elgatoPluginUuid(cwd: string): string {
  const name = basename(cwd);
  const suffixIndex = name.lastIndexOf(".sdPlugin");

  return suffixIndex < 0 ? name : name.substring(0, suffixIndex);
}

/** The file the Stream Deck SDK's logger is writing: `<cwd>/logs/<plugin UUID>.0.log`. */
export function elgatoPluginLogFile(cwd: string = process.cwd()): string {
  return join(cwd, "logs", `${elgatoPluginUuid(cwd)}.0.log`);
}
