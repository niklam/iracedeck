#!/usr/bin/env tsx
/**
 * ElevenLabs voice generator for @iracedeck/audio-assets.
 *
 * Reads generate.config.json, iterates voices × groups × entries, skips any
 * entry whose output MP3 already exists AND whose hash in
 * generate.manifest.json matches the current (voice + model + settings +
 * text + seed + all other audio-affecting options) tuple. Remaining entries
 * are fetched from the ElevenLabs TTS API and written to
 * packages/audio-assets/voice/<voice>/<group>/<name>.mp3.
 *
 * Environment:
 *   ELEVENLABS_API_KEY — required unless --dry-run is passed
 *
 * `.env.local` or `.env` at the repo root is auto-loaded before env lookups,
 * matching the existing convention (see root .gitignore and the mirabox
 * plugin's MIRABOX_PLUGINS_DIR setup).
 *
 * Flags:
 *   --dry-run    Report which entries would be generated / skipped without
 *                calling the API, writing files, or updating the manifest.
 *
 * Usage (from repo root):
 *   pnpm --filter @iracedeck/audio-assets generate
 *   pnpm --filter @iracedeck/audio-assets generate:dry-run
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";

import { type Config, type Entry, loadConfig, resolveVoiceSettings, type Voice } from "./config.ts";
import { type SynthesizeOptions, synthesizeSpeech } from "./elevenlabs.ts";
import { loadManifest, saveManifest } from "./manifest.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(packageRoot, "../..");
const CONFIG_PATH = path.join(packageRoot, "generate.config.json");
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

/**
 * Construct the complete `synthesizeSpeech` options for one entry, resolving
 * global config + per-voice override + per-entry fields in that order.
 * `apiKey` is injected separately at the call site (or omitted for hashing).
 */
function buildSynthesizeOptions(config: Config, voice: Voice, entry: Entry): Omit<SynthesizeOptions, "apiKey"> {
  // Resolve the 3-level voice_settings stack (config → voice → entry) and
  // split off language_code so it ships as the top-level body field per the
  // ElevenLabs API contract — `voice_settings` itself stays clean.
  const merged = resolveVoiceSettings(config, voice, entry);
  const { language_code, ...voice_settings } = merged;

  return {
    voice_id: voice.id,
    text: entry.text,
    model_id: config.model_id,
    voice_settings,
    seed: entry.seed,
    previous_text: entry.previous_text,
    next_text: entry.next_text,
    previous_request_ids: entry.previous_request_ids,
    next_request_ids: entry.next_request_ids,
    language_code,
    apply_text_normalization: config.apply_text_normalization,
    apply_language_text_normalization: config.apply_language_text_normalization,
    pronunciation_dictionary_locators: config.pronunciation_dictionary_locators,
    use_pvc_as_ivc: voice.use_pvc_as_ivc,
    output_format: config.output_format,
    enable_logging: config.enable_logging,
    optimize_streaming_latency: config.optimize_streaming_latency,
  };
}

/**
 * Sort-keyed JSON so hashes are insensitive to property insertion order.
 * Arrays preserve order (order matters for them semantically).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",") + "}";
}

/**
 * Hash every option that influences the generated audio. `enable_logging`
 * and `apiKey` are excluded because they don't change the output.
 */
function entryHash(options: Omit<SynthesizeOptions, "apiKey">): string {
  const { enable_logging: _omitted, ...hashable } = options;

  return createHash("sha256").update(stableStringify(hashable)).digest("hex").slice(0, 16);
}

function textPreview(text: string, max = 60): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

async function main(): Promise<void> {
  loadDotenv();

  const dryRun = process.argv.slice(2).includes("--dry-run");
  const apiKey = process.env.ELEVENLABS_API_KEY;

  if (!dryRun && !apiKey) {
    console.error("ELEVENLABS_API_KEY environment variable is required.");
    process.exit(1);
  }

  const config = loadConfig(CONFIG_PATH);
  const manifest = loadManifest(MANIFEST_PATH);

  if (dryRun) console.log("[dry-run] No API calls, no file writes, no manifest changes.");

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [voiceName, voice] of Object.entries(config.voices)) {
    for (const [groupName, entries] of Object.entries(config.groups)) {
      for (const entry of entries) {
        const relPath = path.posix.join("voice", voiceName, groupName, `${entry.name}.mp3`);
        const absPath = path.join(packageRoot, relPath);
        const synthOptions = buildSynthesizeOptions(config, voice, entry);
        const hash = entryHash(synthOptions);

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

        try {
          const { mp3, requestId } = await synthesizeSpeech({ apiKey: apiKey!, ...synthOptions });

          mkdirSync(path.dirname(absPath), { recursive: true });
          writeFileSync(absPath, mp3);
          manifest.entries[relPath] = {
            hash,
            voiceId: voice.id,
            model: config.model_id,
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
