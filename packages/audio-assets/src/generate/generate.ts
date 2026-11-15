#!/usr/bin/env tsx
/**
 * ElevenLabs voice generator for @iracedeck/audio-assets.
 *
 * Reads every `configs/<voice-id>.voice.json` file, iterates each voice's
 * groups × entries, skips any entry whose output MP3 already exists AND
 * whose content hash in `generate.manifest.json` matches the current one.
 * The hash (`entryHash`) is a pure function of the entry's OWN request — its
 * audio-affecting options and the raw `<group>/<entry-name>` reference
 * strings, never the hashes of the entries they name — so it's stable across
 * runs and re-cuts only that entry on a real config change. Remaining
 * entries are fetched from the ElevenLabs TTS API and written to
 * `packages/audio-assets/voice/<voice>/<group>/<name>.mp3`.
 *
 * Per-voice file shape
 *   Every voice is fully self-contained. There is no shared root config:
 *   `model_id`, `voice_settings`, `output_format`, language / normalization
 *   flags all live in each `<voice-id>.voice.json`. The intent is to let
 *   different ElevenLabs models or different speeds ride one to a voice
 *   without coupling them.
 *
 *   Per-entry overrides (within a voice file) fall back to the voice's
 *   value when omitted, so e.g. one entry can pin a different `model_id`
 *   or `language_code` without rewriting the rest.
 *
 *   Key parity across voices is deliberately NOT enforced (#1065 retired
 *   `voice-parity.test.ts`): a voice speaks from its own script, so a base
 *   only it has is referenced only by it, and a base only default has is
 *   a line that voice does not say. What `script-coverage.test.ts` holds
 *   each voice to instead is itself — every clip it authors in a group its
 *   script addresses is referenced, and everything it references is
 *   authored. Different text per voice is fine; so is a different clip set.
 *
 * Request-id chains
 *   `previous_request_ids` and `next_request_ids` array elements may be
 *   either:
 *     - a `<group>/<entry-name>` reference (e.g. `"acknowledgment/got-it"`)
 *       resolved at generate-time to that clip's `requestId` for the
 *       current voice from `generate.manifest.json`, or
 *     - a raw ElevenLabs request-id string (no `/`, passed through verbatim).
 *   References are resolved per-voice — the same chain block produces a
 *   per-voice link without duplication. The resolved provider IDs feed only
 *   the API call; the cache hash uses the *raw reference strings* alone, so
 *   neither re-cutting a dependency (a fresh provider ID) nor changing its
 *   config re-cuts a dependent (#1643). On `eleven_v4` no request ever
 *   returns the same take twice, so a clip on disk is the only copy of an
 *   approved take: a dependent keeps its take, conditioned on the superseded
 *   one, until someone re-cuts it on purpose (a seed bump).
 *
 *   The reference graph must be acyclic — `detectReferenceCycles` rejects
 *   cycles up front. A run orders each voice's entries dependencies first
 *   (`run-order.ts`: a stable topological sort, config order as the
 *   tie-break) and visits Default before the other voices. An entry whose
 *   dependency is out of date and not cut earlier in the same run is
 *   REFUSED, naming the dependency and the `--voice/--group/--entry` scope
 *   that cuts it, so no new take is ever conditioned on a superseded one; a
 *   dependency that fails or is refused in the run fails its dependents.
 *   See `runGeneration` in `run.ts`, which holds the whole loop.
 *
 *   Unknown reference names (typos) are caught at config-parse time with a
 *   list of valid `<group>/<entry-name>` candidates.
 *
 * Environment:
 *   ELEVENLABS_API_KEY — required unless --dry-run is passed
 *
 * `.env.local` or `.env` at the repo root is auto-loaded before env lookups,
 * matching the existing convention (see root .gitignore and the mirabox
 * plugin's MIRABOX_PLUGINS_DIR setup).
 *
 * Flags (any other argument refuses the run before anything is loaded, so a
 * typo such as `--dryrun` can never start a paid run — `cli-args.ts`):
 *   --dry-run                       Report which entries would be generated /
 *                                   skipped without calling the API, writing
 *                                   files, or updating the manifest.
 *   --voice <key>[,<key>...]        Only iterate the named voices. Repeatable;
 *                                   --voice default --voice titan == --voice default,titan.
 *   --group <name>[,<name>...]      Only iterate the named groups. Repeatable.
 *   --entry <name>[,<name>...]      Only iterate entries with these names, in
 *                                   whichever groups are iterated. Repeatable.
 *                                   The way to cut a SLICE of one large group
 *                                   (#1127: 21 of the 1,110 car numbers).
 *   --import <dir>                  Import takes cut outside the generator
 *                                   (#1643): every `ok` record of
 *                                   `<dir>/trial-manifest.json`, its file
 *                                   `<dir>/voice/<voice>/<group>/<name>.mp3`
 *                                   copied byte for byte and given a manifest
 *                                   row with the entry's current hash and the
 *                                   trial's request id, so nothing re-cuts it.
 *                                   Any unknown entry, missing file, model or
 *                                   speaker (voiceId) mismatch, driver-name
 *                                   alias or ungrandfathered pause mark
 *                                   refuses the whole import and writes
 *                                   nothing. Composes with --dry-run;
 *                                   refuses --voice/--group/--entry; needs no
 *                                   API key. See `import-takes.ts`.
 *
 * The three filters compose as an intersection: --voice default --group
 * numbers only touches voice/default/numbers/, and --group car-number --entry
 * 0,9,09 touches three clips of it. Manifest entries outside the filter are
 * left untouched, so a subsequent unscoped run still sees them as cache hits
 * — or, after a config change that reaches them, still reports them as out of
 * date. Unknown names exit non-zero with the list of valid choices; an entry
 * name is validated against the groups the scope iterates, so a slice that
 * would match nothing is refused rather than reported as a full cache hit.
 *
 * Usage (from repo root):
 *   pnpm --filter @iracedeck/audio-assets generate
 *   pnpm --filter @iracedeck/audio-assets generate:dry-run
 *   pnpm --filter @iracedeck/audio-assets generate --group acknowledgment
 *   pnpm --filter @iracedeck/audio-assets generate --voice default --group numbers
 *   pnpm --filter @iracedeck/audio-assets generate --voice default --group car-number --entry 0,1,2
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import { type GenerateArgs, parseGenerateArgs } from "./cli-args.ts";
import { detectReferenceCycles, loadVoiceConfigs } from "./config.ts";
import { synthesizeSpeech } from "./elevenlabs.ts";
import { importTakes } from "./import-takes.ts";
import { loadManifest, saveManifest } from "./manifest.ts";
import { loadGrandfatheredPauseMarks } from "./pause-marks.ts";
import { formatRunSummary, runGeneration } from "./run.ts";
import { formatScope, type Scope, validateScope } from "./scope.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const CONFIGS_DIR = path.join(packageRoot, "configs");
const MANIFEST_PATH = path.join(packageRoot, "generate.manifest.json");

/**
 * Load environment variables from `<repoRoot>/.env.local` (preferred) or
 * `<repoRoot>/.env` before any `process.env.*` lookups. Uses Node's built-in
 * `process.loadEnvFile()` — no dependency needed on >= 20.12.
 */
function loadDotenv(): void {
  for (const candidate of [".env.local", ".env"]) {
    const p = path.join(repoRoot, candidate);

    if (existsSync(p)) {
      process.loadEnvFile(p);

      return;
    }
  }
}

function fail(err: unknown): never {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

async function main(): Promise<void> {
  // First, before anything is loaded: an argument the generator does not
  // read (a `--dryrun` typo) refuses the run rather than being ignored into
  // a paid one.
  let args: GenerateArgs;

  try {
    args = parseGenerateArgs(process.argv.slice(2));
  } catch (err) {
    fail(err);
  }

  const { scope, dryRun, importDir } = args;

  loadDotenv();

  if (importDir !== null) {
    await runImport(importDir, scope, dryRun);

    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!dryRun && !apiKey) {
    console.error("ELEVENLABS_API_KEY environment variable is required.");
    process.exit(1);
  }

  const voiceConfigs = loadVoiceConfigs(CONFIGS_DIR);

  if (voiceConfigs.size === 0) {
    console.error(`No voice configs found in ${CONFIGS_DIR} (expected at least one *.voice.json).`);
    process.exit(1);
  }

  try {
    validateScope(scope, voiceConfigs);

    // Reject reference cycles up front — a cyclic graph has no
    // dependencies-first order and can't be generated from an empty manifest.
    for (const [voiceName, voice] of voiceConfigs) detectReferenceCycles(voiceName, voice);
  } catch (err) {
    fail(err);
  }

  const scopeSummary = formatScope(scope);

  if (scopeSummary) console.log(`[scope] ${scopeSummary}`);

  if (dryRun) console.log("[dry-run] No API calls, no file writes, no manifest changes.");

  const result = await runGeneration({
    voiceConfigs,
    manifest: loadManifest(MANIFEST_PATH),
    scope,
    dryRun,
    root: packageRoot,
    synthesize: (options) => synthesizeSpeech({ apiKey: apiKey!, ...options }),
    persistManifest: (manifest) => saveManifest(MANIFEST_PATH, manifest),
    grandfathered: loadGrandfatheredPauseMarks(packageRoot),
  });

  console.log();

  for (const line of formatRunSummary(result, dryRun)) console.log(line);

  // A clip whose row never reached the manifest fails the run too: the next
  // run would pay to cut it again (#1643).
  if (result.totals.failed > 0 || result.totals.refused > 0 || result.unsavedRows.length > 0) process.exitCode = 1;
}

/** `--import <dir>`: no API call, so no key; every record of the trial, so no scope. */
async function runImport(importDir: string, scope: Scope, dryRun: boolean): Promise<void> {
  if (scope.voices || scope.groups || scope.entries) {
    fail(
      "--import imports every ok record of the trial and cannot be combined with --voice, --group or --entry. " +
        "To import fewer takes, give it a directory holding only those records.",
    );
  }

  const voiceConfigs = loadVoiceConfigs(CONFIGS_DIR);

  if (dryRun) console.log("[dry-run] No file writes, no manifest changes.");

  const dir = path.resolve(importDir);
  const result = importTakes({
    dir,
    voiceConfigs,
    manifest: loadManifest(MANIFEST_PATH),
    root: packageRoot,
    dryRun,
    persistManifest: (manifest) => saveManifest(MANIFEST_PATH, manifest),
    grandfathered: loadGrandfatheredPauseMarks(packageRoot),
  });

  console.log();
  console.log(
    `Done. ${result.imported} ${dryRun ? "would be imported" : "imported"}, ${result.skipped} skipped (not ok), ` +
      `${result.problems.length} problem(s)`,
  );

  if (result.problems.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
