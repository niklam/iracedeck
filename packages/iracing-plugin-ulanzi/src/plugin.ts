/**
 * iRaceDeck Ulanzi plugin — the UlanziStudio entry point (#1349).
 *
 * Startup is `@iracedeck/plugin-runtime`'s `startPlugin`; this file builds
 * the host's adapter. The phases and their order:
 * `.claude/rules/plugin-structure.md`. Action UUIDs are the canonical
 * `com.iracedeck.sd.core.*` ones (UlanziStudio doesn't validate the UUID prefix).
 */
import { UlanziPlatformAdapter } from "@iracedeck/deck-adapter-ulanzi";
import { startPlugin } from "@iracedeck/plugin-runtime";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `<plugin>/bin`: where this bundle and its build-time config.json live.
const binDir = dirname(fileURLToPath(import.meta.url));

// Tee logs to <plugin>/log/<YYYY.M.D>.log. The UlanziStudio host discards plugin
// stdout, so file logging is what makes the debug toggle actually capture a log
// for support on Ulanzi (issue #609). binDir is <plugin>/bin, so the log dir
// sits next to it under the plugin root — the same convention the host's own
// plugins use.
const adapter = new UlanziPlatformAdapter(undefined, join(binDir, "..", "log"));

startPlugin({ adapter, binDir });
