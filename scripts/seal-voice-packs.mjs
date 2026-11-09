#!/usr/bin/env node
/**
 * Seal the committed voice-pack records: mark each pack's current version as
 * released (#1667).
 *
 * Usage: pnpm seal:voice-packs [<pack-id> ...]
 *
 * A pack's record (`packages/audio-assets/pack-records/<id>.json`) learns that
 * a version is published in exactly two places: the release hook, which seals
 * every pack on a stable or -rc release, and this command, for a pack published
 * between plugin releases. Run it on master, commit the records it wrote, and
 * only then dispatch the *Publish voice packs* workflow with `publish` on:
 * `scripts/publish-voice-packs.mjs --publish` refuses a pack whose current
 * version is not sealed, so a seal skipped here is a red workflow, never an
 * archive published under a version the tree does not know is out.
 *
 * It does what the hook does and nothing else: every pack in `VOICE_PACKS` is
 * first held to its record's four rules (`checkPackRecords`), and a problem in
 * any of them seals nothing and names the pack, the input that changed and the
 * command to run. Then `released` is set on each chosen record — the ones
 * named, or every pack when none is — that is not already sealed at its pack's
 * version; one that is stays byte-untouched, so re-running is safe. Nothing is
 * committed here.
 *
 * Design record: docs/superpowers/specs/2026-11-08-issue-1667-voice-pack-version-guard.md,
 * "Sealing: how the tree learns a version is released".
 */
import path from "node:path";
import url from "node:url";

import { sealPackRecords } from "../packages/audio-assets/src/build/pack-record.mjs";
import { VOICE_PACKS } from "../packages/audio-assets/src/build/voice-packs.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

export const USAGE = "usage: pnpm seal:voice-packs [<pack-id> ...]";

/** The records directory, as the commit hint names it. */
const PACK_RECORDS_REL = "packages/audio-assets/pack-records";

/**
 * @typedef {import("../packages/audio-assets/src/build/voice-packs.mjs").VoicePackDefinition} VoicePackDefinition
 * @typedef {import("../packages/audio-assets/src/build/pack-record.mjs").PackRoots} PackRoots
 */

/**
 * The command, with everything it reads and prints injectable so a test can
 * run it over a tree of its own. Returns the exit code: 0 when every chosen
 * pack is sealed (or was already), 1 for a usage error, an unknown pack, a
 * record problem or a write that failed — nothing is sealed in those cases.
 *
 * @param {readonly string[]} argv — everything after the script path: pack ids
 * @param {object} [options]
 * @param {readonly VoicePackDefinition[]} [options.packs] — the registry, `VOICE_PACKS`
 * @param {PackRoots} [options.roots] — where the tree is; the package's own by default
 * @param {string} [options.root] — the directory printed paths are relative to; the repo root
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.error]
 * @returns {number}
 */
export function sealVoicePacks(
  argv,
  { packs = VOICE_PACKS, roots = {}, root = repoRoot, log = console.log, error = console.error } = {},
) {
  const known = packs.map((pack) => pack.id);
  /** @type {string[]} */
  const ids = [];

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      log(USAGE);
      log(`Seals the current version of the named voice packs (all when none is named): ${known.join(", ")}.`);

      return 0;
    }

    if (arg.startsWith("-")) {
      error(`unknown option "${arg}" — ${USAGE}`);

      return 1;
    }

    if (!known.includes(arg)) {
      error(`unknown pack "${arg}" — known packs: ${known.join(", ")}`);

      return 1;
    }

    if (!ids.includes(arg)) ids.push(arg);
  }

  const chosen = ids.length === 0 ? [...known] : ids;
  let sealed;

  try {
    ({ sealed } = sealPackRecords({ packs, ...(ids.length === 0 ? {} : { ids }), ...roots }));
  } catch (err) {
    // A record problem comes with its problems formatted into the message; a
    // write that failed names the file. Either way nothing else is sealed.
    error(err instanceof Error ? err.message : String(err));

    return 1;
  }

  const relative = (file) => path.relative(root, file).split(path.sep).join("/");

  if (sealed.length === 0) {
    const versions = chosen.map((id) => `${id} ${packs.find((pack) => pack.id === id).version}`);

    log(`Nothing to seal: ${versions.join(", ")} ${chosen.length === 1 ? "is" : "are"} already sealed as released.`);

    return 0;
  }

  for (const { id, version, sha256, path: file } of sealed) {
    log(`Sealed ${relative(file)}: ${id} ${version} released (sha256 ${sha256})`);
  }

  log(
    `Commit ${PACK_RECORDS_REL}/ to master before dispatching the Publish voice packs workflow with publish on; ` +
      "a publish refuses a pack whose version is not sealed.",
  );

  return 0;
}

// Direct-exec guard, as in publish-voice-packs.mjs: only run when this file was
// executed as the entry script, so importing `sealVoicePacks` (the tests do)
// seals nothing at module-eval time.
const invokedPath = process.argv[1];
if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href || invokedPath === url.fileURLToPath(import.meta.url))
) {
  process.exitCode = sealVoicePacks(process.argv.slice(2));
}
