#!/usr/bin/env node
/**
 * Generates `voice/<voice-id>/callouts.json` for every authored voice in
 * `configs/` (#1064).
 *
 * Each `configs/<voice-id>.voice.json` may carry a callout script under its
 * `scenarios`, `frames` and `pools` keys. That file never ships — it holds the
 * ElevenLabs voice id, the TTS settings and every line of text — so this
 * script extracts just those three maps, under a `schema` header, into the
 * committed artifact inside the voice tree that the plugin build copies, the
 * voice-pack packer stages and the scanner reads. A voice that authors none of
 * the keys gets an artifact with empty maps: a valid, clips-only voice.
 *
 * The configs are loaded through `loadVoiceConfigs`, so the full config
 * schema runs and a malformed entry fails here, naming the file and the path,
 * rather than at the artifact. The extracted script is then checked once more
 * with the grammar's own parser before anything is written — the two schemas
 * are meant to agree, and this is where a disagreement would surface.
 *
 * Usage: pnpm generate:callout-scripts
 *        pnpm --filter @iracedeck/audio-assets generate:callout-scripts
 *
 * Runs under `tsx` (the package script does this), because `config.ts` is a
 * TypeScript source executed in place, like the generator it belongs to.
 *
 * Run this after editing a voice config's script keys. A freshness test
 * (`src/callout-scripts.test.ts`) fails CI if a committed artifact drifts from
 * its config.
 */
import { parseCalloutScript } from "@iracedeck/callout-script";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import {
  buildCalloutScript,
  calloutScriptArtifactPath,
  serializeCalloutScript,
} from "../src/build/callout-scripts.mjs";
import { audioAssetsPath } from "../src/build/index.mjs";
import { loadVoiceConfigs } from "../src/generate/config.ts";

const CONFIGS_DIR = path.join(audioAssetsPath, "configs");

/**
 * Extract and write one artifact per `<voice-id>.voice.json` in `configsDir`,
 * under `outputRoot`. Returns the files written, in voice-id order.
 *
 * Nothing is written until every config has loaded and every script has
 * validated, so a bad config never leaves a half-regenerated tree behind.
 *
 * @param {object} [options]
 * @param {string} [options.configsDir] — holds `<voice-id>.voice.json`; the package's `configs/` by default
 * @param {string} [options.outputRoot] — where `voice/<voice-id>/callouts.json` is written; the package by default
 * @param {(line: string) => void} [options.log]
 * @returns {string[]}
 */
export function generateCalloutScripts({
  configsDir = CONFIGS_DIR,
  outputRoot = audioAssetsPath,
  log = console.log,
} = {}) {
  const configs = loadVoiceConfigs(configsDir);

  if (configs.size === 0) {
    throw new Error(`No voice configs found in ${configsDir} (expected at least one *.voice.json).`);
  }

  /** @type {{ voiceId: string; file: string; text: string; script: import("@iracedeck/callout-script").CalloutScript }[]} */
  const artifacts = [];

  for (const [voiceId, config] of configs) {
    const script = buildCalloutScript(config);
    const result = parseCalloutScript(script);

    if (!result.ok) {
      throw new Error(
        `configs/${voiceId}.voice.json: the extracted callout script is not one the plugin accepts:\n  ` +
          result.problems.join("\n  "),
      );
    }

    artifacts.push({
      voiceId,
      file: calloutScriptArtifactPath(voiceId, outputRoot),
      text: serializeCalloutScript(script),
      script,
    });
  }

  for (const { file, text, script } of artifacts) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf-8");

    log(`Generated ${file}`);
    log(
      `  scenarios: ${Object.keys(script.scenarios).length}, frames: ${Object.keys(script.frames).length}, ` +
        `pools: ${Object.keys(script.pools).length}`,
    );
  }

  return artifacts.map(({ file }) => file);
}

/**
 * The CLI entry. A failure — a malformed config, an empty `configs/` — is one
 * line on stderr and a non-zero exit code, as `pack-voice.mjs` reports its
 * own: the author who typed the mistake reads the message, not an uncaught
 * exception's stack trace with the message buried in it.
 *
 * @internal Exported for testing.
 * @param {object} [deps]
 * @param {() => unknown} [deps.generate]
 * @param {(line: string) => void} [deps.error]
 * @returns {number} the process exit code
 */
export function main({ generate = generateCalloutScripts, error = console.error } = {}) {
  try {
    generate();

    return 0;
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));

    return 1;
  }
}

// Direct-exec guard: only run when this file was executed as the entry script.
// Tolerate a missing argv[1] (a test runner importing this module) so importing
// `generateCalloutScripts` never runs it at module-eval time.
const invokedPath = process.argv[1];

if (
  invokedPath &&
  (import.meta.url === url.pathToFileURL(invokedPath).href || invokedPath === url.fileURLToPath(import.meta.url))
) {
  process.exitCode = main();
}
