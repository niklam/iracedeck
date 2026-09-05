#!/usr/bin/env tsx
/**
 * ElevenLabs voice generator for @iracedeck/audio-assets.
 *
 * Reads every `configs/<voice-id>.voice.json` file, iterates each voice's
 * groups × entries, skips any entry whose output MP3 already exists AND
 * whose content hash in `generate.manifest.json` matches the current one.
 * The hash (`entryHash`) is a pure function of config content — the entry's
 * own audio-affecting options plus the recursive hashes of its request-id
 * dependencies — so it's stable across runs and re-cuts only on a real
 * config change. Remaining entries are fetched from the ElevenLabs TTS API
 * and written to `packages/audio-assets/voice/<voice>/<group>/<name>.mp3`.
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
 *   the API call; the cache hash uses the *raw reference strings* plus the
 *   referenced entries' content hashes, so re-cutting a dependency (which
 *   gets a fresh provider ID) does NOT thrash every dependent — only a real
 *   config change to a dependency cascades.
 *
 *   The reference graph must be acyclic — `detectReferenceCycles` rejects
 *   cycles up front. Run dependencies before dependents, either by ordering
 *   groups in the config so deps come first, or by scoping with
 *   `--voice <v> --group <g>`. A reference whose target is missing from the
 *   manifest fails that entry loudly with the offending ref, the lookup
 *   path, and a suggested command.
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
 * Flags:
 *   --dry-run                       Report which entries would be generated /
 *                                   skipped without calling the API, writing
 *                                   files, or updating the manifest.
 *   --voice <key>[,<key>...]        Only iterate the named voices. Repeatable;
 *                                   --voice default --voice titan == --voice default,titan.
 *   --group <name>[,<name>...]      Only iterate the named groups. Repeatable.
 *
 * Voice and group filters compose as an intersection: --voice default --group
 * numbers only touches voice/default/numbers/. Manifest entries outside the
 * filter are left untouched, so a subsequent unscoped run still sees them
 * as cache hits. Unknown names exit non-zero with the list of valid choices.
 *
 * Usage (from repo root):
 *   pnpm --filter @iracedeck/audio-assets generate
 *   pnpm --filter @iracedeck/audio-assets generate:dry-run
 *   pnpm --filter @iracedeck/audio-assets generate --group acknowledgment
 *   pnpm --filter @iracedeck/audio-assets generate --voice default --group numbers
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import {
  buildEntryLookup,
  buildEntryOptions,
  detectReferenceCycles,
  entryHash,
  loadVoiceConfigs,
  resolveEntryRequestIds,
} from "./config.ts";
import { type SynthesizeOptions, synthesizeSpeech } from "./elevenlabs.ts";
import { loadManifest, saveManifest } from "./manifest.ts";
import { formatScope, parseScopeArgs, type Scope, validateScope } from "./scope.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const CONFIGS_DIR = path.join(packageRoot, "configs");
const MANIFEST_PATH = path.join(packageRoot, "generate.manifest.json");
const CACHE_ROOT = path.join(packageRoot, ".cache");

/**
 * Drop the processed mp3 for `relPath` from every filter-hash subdir under
 * `.cache/`. The build helper's mtime check (cache.mtime > source.mtime)
 * is correct in the normal case, but breaks under git checkout / `cp -p`
 * which can preserve an older source mtime even though content changed.
 * Explicit deletion when we know the source is fresh removes that hazard
 * entirely. No-op when `.cache/` doesn't exist yet (clean tree).
 */
function invalidateProcessedCache(relPath: string): void {
  if (!existsSync(CACHE_ROOT)) return;

  for (const entry of readdirSync(CACHE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const cachedPath = path.join(CACHE_ROOT, entry.name, relPath);
    rmSync(cachedPath, { force: true });
  }
}

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

function textPreview(text: string, max = 60): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

async function main(): Promise<void> {
  loadDotenv();

  let scope: Scope;
  let remaining: string[];

  try {
    ({ scope, remaining } = parseScopeArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const dryRun = remaining.includes("--dry-run");
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
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Reject reference cycles up front — `entryHash` recurses through
  // dependencies, and a cyclic graph can't be generated from an empty
  // manifest anyway. Fail fast with the cycle path before any API work.
  try {
    for (const [voiceName, voice] of voiceConfigs) {
      detectReferenceCycles(voiceName, voice);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const manifest = loadManifest(MANIFEST_PATH);

  const scopeSummary = formatScope(scope);

  if (scopeSummary) console.log(`[scope] ${scopeSummary}`);

  if (dryRun) console.log("[dry-run] No API calls, no file writes, no manifest changes.");

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [voiceName, voice] of voiceConfigs) {
    if (scope.voices && !scope.voices.includes(voiceName)) continue;

    // `entryHash` hashes dependencies recursively — build the lookup and a
    // shared memo once per voice so each entry is hashed at most once.
    const lookup = buildEntryLookup(voice);
    const hashMemo = new Map<string, string>();

    for (const [groupName, entries] of Object.entries(voice.groups)) {
      if (scope.groups && !scope.groups.includes(groupName)) continue;

      for (const entry of entries) {
        const relPath = path.posix.join("voice", voiceName, groupName, `${entry.name}.mp3`);
        const absPath = path.join(packageRoot, relPath);

        // The cache key is a pure function of config content (this entry's
        // own settings + the recursive hashes of its references) — it does
        // NOT depend on the manifest or any volatile provider request ID,
        // so it's stable across runs and cycle-safe.
        const hash = entryHash(entry, groupName, voice, lookup, hashMemo);
        const manifestEntry = manifest.entries[relPath];

        if (manifestEntry?.hash === hash && existsSync(absPath)) {
          skipped++;
          continue;
        }

        const prefix = dryRun ? "[dry-run] WOULD GENERATE" : "[generate]";
        console.log(`${prefix} ${relPath}  —  "${textPreview(entry.text)}"`);

        if (dryRun) {
          generated++;
          continue;
        }

        let synthOptions: Omit<SynthesizeOptions, "apiKey">;

        try {
          // Resolve `<group>/<entry-name>` references to concrete provider
          // request IDs for the API call. Can fail if a dependency isn't in
          // the manifest yet (first-ever run, or wrong --group scope order);
          // treat as a per-entry failure so the rest of the run continues.
          synthOptions = resolveEntryRequestIds(buildEntryOptions(entry, voice), voiceName, manifest);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[generate] ${relPath}  —  FAILED: ${message}`);
          failed++;
          continue;
        }

        try {
          const { mp3, requestId } = await synthesizeSpeech({ apiKey: apiKey!, ...synthOptions });

          mkdirSync(path.dirname(absPath), { recursive: true });
          writeFileSync(absPath, mp3);
          invalidateProcessedCache(relPath);
          manifest.entries[relPath] = {
            hash,
            voiceId: voice.id,
            model: synthOptions.model_id,
            textPreview: textPreview(entry.text, 80),
            generatedAt: new Date().toISOString(),
            requestId,
          };
          // Persist after every success so a partial failure mid-run doesn't
          // lose progress / force re-fetches on the next invocation.
          saveManifest(MANIFEST_PATH, manifest);
          generated++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[generate] ${relPath}  —  FAILED: ${message}`);
          failed++;
        }
      }
    }
  }

  console.log();
  const verb = dryRun ? "would be generated" : "generated";
  console.log(`Done. ${generated} ${verb}, ${skipped} skipped (cache hit), ${failed} failed`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
