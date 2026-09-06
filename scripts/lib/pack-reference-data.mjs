// Builds the pack-author reference the website renders (issue #1066): the
// Race Engineer's contracts and vocabulary as the engine enumerates them, the
// bundled voice's script, and the recording script off its clips, in one
// committed JSON.
//
// Composition only: `registerCatalogEngine` (catalog-engine.mjs) provides the
// registered engine and the manifest off the built dist, `buildPackReference`
// (the package's pure builder) owns the shape and the sorting, and this module
// reads the two source files the engine does not (the bundled script and the
// voice config — `PACK_REFERENCE_SOURCES` names all four), adds the plugin's
// list of clips it plays by path, and hands everything over. The generator
// script is left with file I/O and a summary; the freshness test rebuilds
// through the same function and compares text.
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { AUDIO_MANIFEST_PATH, BUNDLED_VOICE, importAudioScenarios, registerCatalogEngine } from "./catalog-engine.mjs";
import { PLUGIN_PLAYED_CLIPS } from "./lint-pack-run.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

/** Where the artifact is written, relative to the repository root. */
export const PACK_REFERENCE_PATH = "packages/website/src/data/pack-reference.json";

/** The command that regenerates the artifact, named in the freshness test's failure. */
export const PACK_REFERENCE_GENERATE_COMMAND = "pnpm generate:pack-reference";

/** The bundled voice's callout script — what each callout says, and the fragments and frames it uses. */
export const BUNDLED_SCRIPT_PATH = `packages/audio-assets/voice/${BUNDLED_VOICE}/callouts.json`;

/** The bundled voice's authored config — the text of every recorded line, under `groups`. */
export const BUNDLED_VOICE_CONFIG_PATH = `packages/audio-assets/configs/${BUNDLED_VOICE}.voice.json`;

/** The catalog whose `contracts()` and `vocabulary()` the reference publishes — the source tree, not the dist the scripts load it from. */
export const CATALOG_SOURCE_PATH = "packages/audio-scenarios/src/catalog/pit-crew";

/**
 * What the generator reads, repo-relative, recorded in the artifact as
 * `_meta.generatedFrom` — the provenance shape `changelog.json` and
 * `getting-started.json` carry. Paths only, never a version: the artifact is
 * freshness-tested against a rebuild, and a version stamp would make every
 * release bump commit stale it on `master`.
 */
export const PACK_REFERENCE_SOURCES = Object.freeze([
  CATALOG_SOURCE_PATH,
  BUNDLED_SCRIPT_PATH,
  BUNDLED_VOICE_CONFIG_PATH,
  AUDIO_MANIFEST_PATH,
]);

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(repoRoot, relative), "utf-8"));
}

/**
 * Register the catalog and build the reference from the committed sources.
 * Needs the built `@iracedeck/audio-scenarios` dist — see catalog-engine.mjs.
 *
 * @returns {Promise<import("@iracedeck/audio-scenarios").PackReference>}
 */
export async function buildPackReferenceData() {
  // The engine's active voice is irrelevant here — nothing fires, and the
  // builder is told which voice's clips to read explicitly below.
  const { engine, manifest, audioScenarios } = await registerCatalogEngine();
  const script = readJson(BUNDLED_SCRIPT_PATH);
  const { groups } = readJson(BUNDLED_VOICE_CONFIG_PATH);

  return audioScenarios.buildPackReference({
    generatedFrom: PACK_REFERENCE_SOURCES,
    contracts: engine.contracts(),
    vocabulary: engine.vocabulary(),
    script,
    groups,
    manifestClips: manifest.clips,
    // The clips plugin code plays by path, written onto their recording
    // lines as `playedBy` — the one list the linter exempts by, so the site
    // renders the artifact and keeps no list of its own.
    pluginPlayed: PLUGIN_PLAYED_CLIPS,
    voice: BUNDLED_VOICE,
  });
}

/**
 * Serialise the artifact exactly as it is committed — the package's own
 * serialisation, so the freshness test and the generator cannot drift.
 *
 * @param {import("@iracedeck/audio-scenarios").PackReference} reference
 * @returns {Promise<string>}
 */
export async function serializePackReferenceData(reference) {
  const { serializePackReference } = await importAudioScenarios();

  return serializePackReference(reference);
}

/**
 * What the generator prints and the coordinator reads: the counts, the lines
 * the config has no text for, and what nothing draws from — a whole group no
 * callout, no var and no plugin code accounts for, and, inside a group that
 * IS drawn from, the single lines with no direct consumer, no var naming
 * their group and no `playedBy`. Either is recorded for nothing, or is a var
 * whose description the `viaVar` heuristic could not read.
 *
 * @param {import("@iracedeck/audio-scenarios").PackReference} reference
 */
export function summarizePackReference(reference) {
  const lines = reference.recordingScript.flatMap((group) => group.lines.map((line) => ({ group: group.group, line })));
  const unconsumed = (line) => line.usedBy.length === 0 && line.viaVar.length === 0 && line.playedBy === null;
  const groupsWithoutConsumer = reference.recordingScript
    .filter((group) => group.lines.every(unconsumed))
    .map((group) => group.group);

  return {
    callouts: reference.callouts.length,
    skipped: reference.callouts.filter((c) => c.skip).map((c) => c.id),
    vars: reference.vocabulary.vars.length,
    conds: reference.vocabulary.conds.length,
    cases: reference.vocabulary.cases.length,
    groups: reference.recordingScript.length,
    lines: lines.length,
    takes: lines.reduce((total, { line }) => total + line.takes, 0),
    linesWithoutText: lines
      .filter(({ line }) => line.texts.length === 0)
      .map(({ group, line }) => `${group}/${line.base}`),
    groupsWithoutConsumer,
    /** Lines nothing draws from inside a group something else does — `group/base`. */
    linesWithoutConsumer: lines
      .filter(({ group, line }) => !groupsWithoutConsumer.includes(group) && unconsumed(line))
      .map(({ group, line }) => `${group}/${line.base}`),
    unusedVocabulary: [
      ...reference.vocabulary.vars.filter((v) => v.usedBy.length === 0).map((v) => `var ${v.name}`),
      ...reference.vocabulary.conds.filter((c) => c.usedBy.length === 0).map((c) => `cond ${c.name}`),
      ...reference.vocabulary.cases.filter((c) => c.usedBy.length === 0).map((c) => `case ${c.name}`),
    ],
  };
}
