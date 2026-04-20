#!/usr/bin/env tsx
/**
 * ElevenLabs voice generator for @iracedeck/audio-assets.
 *
 * Reads generate.config.json, iterates voices × groups × entries, skips any
 * entry whose output MP3 already exists AND whose hash in
 * generate.manifest.json matches the current (voice, model, settings, text)
 * tuple. Remaining entries are fetched from the ElevenLabs TTS API and
 * written to packages/audio-assets/voice/<voice>/<group>/<name>.mp3.
 *
 * Environment:
 *   ELEVENLABS_API_KEY — required unless --dry-run is passed
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

import { loadConfig, type VoiceSettings } from "./config.ts";
import { synthesizeSpeech } from "./elevenlabs.ts";
import { loadManifest, saveManifest } from "./manifest.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");
const CONFIG_PATH = path.join(packageRoot, "generate.config.json");
const MANIFEST_PATH = path.join(packageRoot, "generate.manifest.json");

function entryHash(voiceId: string, model: string, settings: VoiceSettings, text: string): string {
  const raw = [voiceId, model, JSON.stringify(settings), text].join("|");

  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function textPreview(text: string, max = 60): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

async function main(): Promise<void> {
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
        const hash = entryHash(voice.id, config.model, config.voiceSettings, entry.text);

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
          const mp3 = await synthesizeSpeech({
            apiKey: apiKey!,
            voiceId: voice.id,
            text: entry.text,
            model: config.model,
            voiceSettings: config.voiceSettings,
          });
          mkdirSync(path.dirname(absPath), { recursive: true });
          writeFileSync(absPath, mp3);
          manifest.entries[relPath] = {
            hash,
            voiceId: voice.id,
            model: config.model,
            textPreview: textPreview(entry.text, 80),
            generatedAt: new Date().toISOString(),
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
