/**
 * The callout-script artifact (#1064): how a voice's `scenarios` / `frames` /
 * `pools` / `fragments` (the last since #1065), authored in
 * `configs/<voice-id>.voice.json`, become the committed
 * `voice/<voice-id>/callouts.json` the plugin and the voice packs ship.
 *
 * The authored file is generator-only — it carries the ElevenLabs voice id, the
 * TTS settings and the whole `groups` block of lines, none of which may reach
 * a user — so `scripts/generate-callout-scripts.mjs` extracts just the four
 * runtime maps, under a `schema` header, into an artifact that lives INSIDE the
 * voice tree. That placement is what lets it ride every path a voice already
 * travels (the plugin build's copy, the packer, the installer's seed, the
 * scanner) with no extra wiring. A freshness test
 * (`src/callout-scripts.test.ts`) fails when the artifact drifts from its
 * config, naming `CALLOUT_SCRIPTS_GENERATE_COMMAND`.
 *
 * Pure functions only; the script owns the file system.
 */
import { CALLOUT_SCRIPT_SCHEMA_VERSION, calloutScriptPath } from "@iracedeck/callout-script";
import path from "node:path";

import { audioAssetsPath } from "./index.mjs";

/**
 * @typedef {import("@iracedeck/callout-script").CalloutScript} CalloutScript
 * @typedef {import("../generate/config.ts").VoiceConfig} VoiceConfig
 */

/** What the freshness test tells a developer to run. */
export const CALLOUT_SCRIPTS_GENERATE_COMMAND = "pnpm generate:callout-scripts";

/**
 * Where a voice's artifact lives: `voice/<voice-id>/callouts.json` under
 * `root`, which is this package by default. The relative shape is the
 * grammar's own (`calloutScriptPath`), so the generator writes the file to
 * exactly the path every reader opens.
 *
 * @param {string} voiceId
 * @param {string} [root]
 * @returns {string}
 */
export function calloutScriptArtifactPath(voiceId, root = audioAssetsPath) {
  return path.join(root, calloutScriptPath(voiceId));
}

/**
 * Extract the script from a parsed voice config.
 *
 * The four maps are copied as they are — key order included. Their key order
 * is the author's, and it is load-bearing: the published callout reference
 * (#1066) reads the artifact in that order, so nothing here sorts. (Within an
 * entry, the keys already sit in the schema's order — `comment`, `test`,
 * `skip`, `frame`, `sequence` — because that is how the config parse emits
 * them.) An absent map is an empty map: a clips-only voice extracts to a valid
 * script whose every callout is skipped, which is what "absent means skipped"
 * looks like on disk.
 *
 * @param {VoiceConfig} voiceConfig
 * @returns {CalloutScript}
 */
export function buildCalloutScript(voiceConfig) {
  return {
    schema: CALLOUT_SCRIPT_SCHEMA_VERSION,
    scenarios: { ...(voiceConfig.scenarios ?? {}) },
    frames: { ...(voiceConfig.frames ?? {}) },
    pools: { ...(voiceConfig.pools ?? {}) },
    // Optional in the grammar, always present in the artifact: the generator
    // writes the whole shape so an author reading the file sees every key.
    fragments: { ...(voiceConfig.fragments ?? {}) },
  };
}

/**
 * The artifact's bytes: two-space indented, LF, trailing newline, keys as
 * given. The same shape `manifest.json` and `changelog.json` take, so the
 * committed file is prettier-clean and diffs one line per change.
 *
 * @param {CalloutScript} script
 * @returns {string}
 */
export function serializeCalloutScript(script) {
  return `${JSON.stringify(script, null, 2)}\n`;
}
