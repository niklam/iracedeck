import type { ILogger } from "@iracedeck/logger";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { VoicePackFileSystem } from "./voice-pack-scanner.js";

/**
 * Depth cap for the clip walk. A pack's deepest legitimate clip is
 * `voice/<id>/<group>/<file>` — three directory levels — so this leaves room for
 * an extra nested group without ever letting a pathological tree turn a scan
 * into an unbounded walk.
 */
export const VOICE_PACK_MAX_DEPTH = 4;

/**
 * `node:fs` implementation of the scanner's port — the only file in the
 * voice-pack feature that touches the disk (issue #1034).
 *
 * Every method swallows its own errors and returns an empty or `undefined`
 * result. The packs directory is user-writable by design: a permission error, a
 * folder deleted mid-scan, or a file held open by another process must cost that
 * one entry, never the plugin's startup.
 */
export function createVoicePackFileSystem(logger: ILogger): VoicePackFileSystem {
  return {
    listDirectories(dir) {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch (err) {
        logger.debug(`Voice packs: cannot list "${dir}": ${err instanceof Error ? err.message : String(err)}`);

        return [];
      }
    },

    readTextFile(file) {
      try {
        return readFileSync(file, "utf-8");
      } catch {
        return undefined;
      }
    },

    listMp3Files(packDir) {
      const found: string[] = [];

      const walk = (dir: string, relative: string, depth: number): void => {
        if (depth > VOICE_PACK_MAX_DEPTH) return;

        let entries: Dirent[];

        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch (err) {
          logger.debug(`Voice packs: cannot walk "${dir}": ${err instanceof Error ? err.message : String(err)}`);

          return;
        }

        for (const entry of entries) {
          const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;

          // `isDirectory()` is false for a symlink, so a symlinked directory is
          // simply never descended into — a sideloaded pack's clip list can
          // never point outside the folder that becomes its audio root.
          if (entry.isDirectory()) {
            walk(join(dir, entry.name), childRelative, depth + 1);
            continue;
          }

          if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp3")) found.push(childRelative);
        }
      };

      walk(packDir, "", 1);
      found.sort();

      return found;
    },
  };
}
