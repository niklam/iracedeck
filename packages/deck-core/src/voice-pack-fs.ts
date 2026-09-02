import type { ILogger } from "@iracedeck/logger";
import { type Dirent, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { VoicePackArchiveFileSystem } from "./voice-pack-archive.js";
import type { VoicePackFileSystem } from "./voice-pack-scanner.js";

/**
 * Depth cap for the clip walk, counted with the pack folder itself as depth 1.
 * A pack's deepest legitimate clip is `voice/<id>/<group>/<file>` — three
 * directory levels below the pack folder — which is EXACTLY what a cap of 4
 * reaches. There is deliberately no headroom: a clip nested any deeper could
 * never match `buildManifestPool`'s `^voice/<id>/<group>/<base>…\.mp3$`, so
 * listing it would only grow the manifest with paths no pool can ever use,
 * while a pathological tree would turn a scan into an unbounded walk.
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
        return { ok: true, text: readFileSync(file, "utf-8") };
      } catch (err) {
        // "Missing" and "unreadable" are reported separately, because they need
        // different words in front of a user: a permission error, a directory of
        // that name, or a file another process holds is a pack iRaceDeck could
        // not OPEN — not a folder that is no pack at all. Collapsing them told
        // the user "no voice-pack.json" about a file sitting in front of them.
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        const missing = code === "ENOENT";

        // The full message carries the absolute path, so it stays in the log. The
        // reason handed back is the errno alone: it is shown in the settings
        // window and rides the deck host's settings copy.
        if (!missing) {
          logger.debug(`Voice packs: cannot read "${file}": ${err instanceof Error ? err.message : String(err)}`);
        }

        return { ok: false, missing, reason: code ?? "unknown error" };
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

/**
 * `node:fs` implementation of the extractor's port (issue #1034, stage 2) —
 * how every file of a staged pack reaches the disk, whether unpacked from a
 * downloaded archive or copied from the plugin's own bundle.
 *
 * Same contract as the scanner's adapter above: every error is swallowed into
 * a result, the full message with its path goes to the log at debug, and the
 * `reason` handed back is the errno alone, because the extractor puts it in a
 * sentence that is shown in the settings window and rides the deck host's
 * settings copy.
 *
 * `writeFile` opens with `wx` — create, exclusively — rather than `w`. The
 * extractor writes into a staging directory it was given empty, so any file
 * already at a destination is something that arrived by another route between
 * the directory being emptied and this write: a leftover, or a planted
 * symlink. With `w`, a symlink there would be FOLLOWED and its target
 * overwritten with archive bytes, which turns an archive-name check that
 * passed into a write somewhere the name never pointed. `O_EXCL` fails on an
 * existing path without resolving it (`CREATE_NEW` on Windows, the same
 * refusal), so the planted link costs the install and nothing else — and
 * the extractor refuses the whole archive on the first such failure, which is
 * the right outcome for a staging directory that is not in the state it was
 * handed over in.
 */
export function createVoicePackArchiveFileSystem(logger: ILogger): VoicePackArchiveFileSystem {
  const failed = (op: string, path: string, err: unknown): { ok: false; reason: string } => {
    logger.debug(`Voice packs: ${op} "${path}" failed: ${err instanceof Error ? err.message : String(err)}`);

    return { ok: false, reason: (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown error" };
  };

  return {
    ensureDirectory(dir) {
      try {
        mkdirSync(dir, { recursive: true });

        return { ok: true };
      } catch (err) {
        return failed("mkdir", dir, err);
      }
    },

    writeFile(file, bytes) {
      try {
        writeFileSync(file, bytes, { flag: "wx" });

        return { ok: true };
      } catch (err) {
        return failed("write", file, err);
      }
    },
  };
}
