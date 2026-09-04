/**
 * Which voices iRaceDeck distributes, and how (#1034, stage 2).
 *
 * The ONE list separating "ships inside the plugin" from "downloadable from the
 * catalog". Every entry here is published: `scripts/pack-voice.mjs` packs it
 * into an archive and writes `catalog/<id>.json`, from which the website builds
 * `voice-catalog.json`. `bundled` additionally keeps the pack's clips inside the
 * plugin distributable, which is what lets an upgrade install a voice by copy
 * with no network in the way. Stage 3 of the rollout is the one-word edit that
 * flips `default` to `bundled: false` — nothing else changes, because `default`
 * is a catalog entry like any other rather than a special case.
 *
 * `version` is the PACK's version, independent of the plugin's. It is what a
 * user reads; the catalog's `sha256` is what decides whether a download is due.
 * Bump it whenever the pack's clips change: an archive with new bytes under an
 * old version number would be two different packs wearing one name.
 *
 * `voices` lists voice IDS only. Each must have `configs/<id>.voice.json` — the
 * per-voice source of truth, whose `label` is what the pack declares for that
 * voice — and a `voice/<id>/` clip tree. Naming the voice here as well would be
 * a second copy of a string the config already owns.
 *
 * `minPluginVersion` is deliberately absent from `default`: no plugin older than
 * the one that introduced the catalog can read the catalog at all, so there is
 * no runtime to exclude. Set it on a pack that needs a NEWER runtime than the
 * catalog's first reader — deck-core compares it with semver and keeps such a
 * pack listed but not offered.
 *
 * The typedef below is what THIS package's scripts and tests see (they import
 * the `.mjs` directly, so TypeScript infers from the JSDoc); `index.d.ts`
 * restates it for consumers of the `./build` export. Keep the two in step.
 *
 * @typedef {object} VoicePackDefinition
 * @property {string} id
 * @property {string} label
 * @property {string} version
 * @property {string} [description]
 * @property {string} [author]
 * @property {readonly string[]} voices
 * @property {string} [minPluginVersion]
 * @property {boolean} bundled
 */

/** @type {readonly VoicePackDefinition[]} */
export const VOICE_PACKS = Object.freeze([
  Object.freeze({
    id: "default",
    label: "Default",
    version: "1.0.0",
    description: "The Race Engineer voice iRaceDeck ships with.",
    author: "iRaceDeck",
    voices: Object.freeze(["default"]),
    bundled: true,
  }),
]);

/**
 * Voice ids whose clips stay inside the plugin distributable — what the plugin
 * build's audio copy step filters `voice/` down to.
 */
export const BUNDLED_VOICE_IDS = Object.freeze(
  VOICE_PACKS.filter((pack) => pack.bundled).flatMap((pack) => [...pack.voices]),
);
