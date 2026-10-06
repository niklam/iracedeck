/**
 * iRaceDeck Mirabox plugin — the VSD Craft entry point (#1349).
 *
 * Startup is `@iracedeck/plugin-runtime`'s `startPlugin`; this file builds
 * the host's adapter. The phases and their order:
 * `.claude/rules/plugin-structure.md`.
 */
import { VSDPlatformAdapter } from "@iracedeck/deck-adapter-mirabox";
import { startPlugin } from "@iracedeck/plugin-runtime";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `<plugin>/bin`: where this bundle and its build-time config.json live.
const binDir = dirname(fileURLToPath(import.meta.url));

// Tee logs to <plugin>/log/<YYYY.M.D>.log. The Stream Dock host discards plugin
// stdout, so file logging is what makes the debug toggle actually capture a log
// for support on Mirabox (issue #609). binDir is <plugin>/bin, so the log dir
// sits next to it under the plugin root — the same convention the host's own
// plugins use.
const adapter = new VSDPlatformAdapter(undefined, join(binDir, "..", "log"));

startPlugin({ adapter, binDir });
