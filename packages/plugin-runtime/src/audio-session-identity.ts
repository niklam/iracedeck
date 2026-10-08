/**
 * The name and icon the Windows Volume Mixer shows for a plugin's audio
 * session instead of the deck host's executable ("Node") — issue #1253.
 *
 * One definition for all three plugins, because the identity is a fact about
 * the plugin folder layout they share: every plugin carries the logo at
 * `<plugin>/imgs/plugin/iracedeck.ico` (the Elgato plugin commits it, the
 * Mirabox and Ulanzi builds copy it), and its bundle runs from `<plugin>/bin/`.
 * The shape matches `@iracedeck/audio-service`'s `AudioSessionIdentity`, which
 * stays ignorant of where a plugin keeps its files.
 */
import { join } from "node:path";

/** The display name every plugin gives its audio session. */
export const AUDIO_SESSION_DISPLAY_NAME = "iRaceDeck";

/** The session icon's file name inside `<plugin>/imgs/plugin/`. */
export const AUDIO_SESSION_ICON_FILE = "iracedeck.ico";

/**
 * Resolve a plugin's audio session identity from its `bin/` directory.
 *
 * @param binDir - Absolute path of the plugin's `bin/` directory (where the
 *   bundled `plugin.js` runs from). The icon path must be absolute, since
 *   Windows resolves it outside our process's working directory.
 */
export function pluginAudioSessionIdentity(binDir: string): { displayName: string; iconPath: string } {
  return {
    displayName: AUDIO_SESSION_DISPLAY_NAME,
    iconPath: join(binDir, "..", "imgs", "plugin", AUDIO_SESSION_ICON_FILE),
  };
}
