// Builds the pack-author reference the website renders (issue #1066): the
// Race Engineer's contracts and vocabulary as the engine enumerates them, the
// bundled voice's script, and the recording script off its clips, in one
// committed JSON.
//
// Composition only: `registerCatalogEngine` (catalog-engine.mjs) provides the
// registered engine off the built dist, `buildPackReference` (the package's
// pure builder) owns the shape and the sorting, and this module reads the
// three source files and hands everything over. The generator script is left
// with file I/O and a summary; the freshness test rebuilds through the same
// function and compares text.
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { BUNDLED_VOICE, importAudioScenarios, registerCatalogEngine } from "./catalog-engine.mjs";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

/** Where the artifact is written, relative to the repository root. */
export const PACK_REFERENCE_PATH = "packages/website/src/data/pack-reference.json";

/** The command that regenerates the artifact, named in the freshness test's failure. */
export const PACK_REFERENCE_GENERATE_COMMAND = "pnpm generate:pack-reference";

/** The bundled voice's callout script — what each callout says, and the fragments and frames it uses. */
export const BUNDLED_SCRIPT_PATH = `packages/audio-assets/voice/${BUNDLED_VOICE}/callouts.json`;

/** The bundled voice's authored config — the text of every recorded line, under `groups`. */
export const BUNDLED_VOICE_CONFIG_PATH = `packages/audio-assets/configs/${BUNDLED_VOICE}.voice.json`;

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
  const { version } = readJson("package.json");
  const script = readJson(BUNDLED_SCRIPT_PATH);
  const { groups } = readJson(BUNDLED_VOICE_CONFIG_PATH);

  return audioScenarios.buildPackReference({
    catalogVersion: version,
    contracts: engine.contracts(),
    vocabulary: engine.vocabulary(),
    script,
    groups,
    manifestClips: manifest.clips,
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
 * callout and no var accounts for, and, inside a group that IS drawn from,
 * the single lines with neither a direct consumer nor a var naming their
 * group. Either is recorded for nothing, or is a var whose description the
 * `viaVar` heuristic could not read.
 *
 * @param {import("@iracedeck/audio-scenarios").PackReference} reference
 */
export function summarizePackReference(reference) {
  const lines = reference.recordingScript.flatMap((group) => group.lines.map((line) => ({ group: group.group, line })));
  const unconsumed = (line) => line.usedBy.length === 0 && line.viaVar.length === 0;
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
