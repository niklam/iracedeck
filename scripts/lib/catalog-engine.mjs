// A registered Race Engineer catalog for root tooling (issue #1066): the
// scenario engine with every pit-crew contract and its vocabulary registered,
// off the BUILT `@iracedeck/audio-scenarios` dist, against the real runtime
// manifest — what `pnpm generate:pack-reference` and `pnpm lint:pack` read
// their `contracts()` / `vocabulary()` from.
//
// Requires `pnpm build` (or a scoped `turbo run build --filter=@iracedeck/audio-scenarios`)
// first: the root scripts are plain Node and cannot import TypeScript sources.
//
// The bus, the audio service and the logger are stubs shaped like the ones in
// `packages/audio-scenarios/src/catalog/pit-crew/bundled-scripts.test.ts`:
// nothing here ever fires a callout, so a subscribe that records nothing and
// an audio service that plays nothing are all the registration needs.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

// Set BEFORE anything that could reach a native addon is imported: the catalog
// imports `@iracedeck/sim-events-iracing`, which reaches `@iracedeck/iracing-sdk`,
// which `require()`s the iRacing addon in module scope unless the mock is
// forced. That is why the dist is loaded with a dynamic `import()` below rather
// than a static import (which would be hoisted above this line).
// `!!process.env.IRACEDECK_MOCK` is the test both native consumers make, so
// any non-empty value forces the mock (see .claude/rules/testing.md).
process.env.IRACEDECK_MOCK = "1";

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

/** The runtime manifest — every bundled clip, the ambient loop and the ticks. */
export const AUDIO_MANIFEST_PATH = "packages/audio-assets/manifest.json";

/** The bundled voice: the one whose script and clips ship in every plugin. */
export const BUNDLED_VOICE = "default";

const AUDIO_SCENARIOS_DIST = "packages/audio-scenarios/dist";

/**
 * Import one module of the built `@iracedeck/audio-scenarios` dist, with a
 * message naming the fix when it is not there.
 *
 * @param {string} relative - Path inside the dist, e.g. `index.js`.
 */
async function importDist(relative) {
  const file = path.join(repoRoot, AUDIO_SCENARIOS_DIST, relative);

  if (!existsSync(file)) {
    throw new Error(
      `${AUDIO_SCENARIOS_DIST}/${relative} is missing — the root scripts read the BUILT package. Run \`pnpm build\` first.`,
    );
  }

  return import(url.pathToFileURL(file).href);
}

/**
 * The built `@iracedeck/audio-scenarios` package itself — for a caller that
 * needs one of its pure exports (the reference serialiser, the script
 * compiler) without registering anything.
 *
 * @returns {Promise<typeof import("@iracedeck/audio-scenarios")>}
 */
export function importAudioScenarios() {
  return importDist("index.js");
}

function createLogger() {
  const noop = () => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: (message) => console.warn(`[catalog] ${message}`),
    error: (message) => console.error(`[catalog] ${message}`),
    createScope: () => logger,
    withLevel: () => logger,
  };

  return logger;
}

/** An event bus that records subscriptions and delivers nothing — the registration subscribes, nothing publishes. */
function createBus() {
  const handlers = new Map();

  return {
    subscribe: (name, handler) => {
      let set = handlers.get(name);

      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }

      set.add(handler);

      return () => {
        handlers.get(name)?.delete(handler);
      };
    },
    unsubscribe: (name, handler) => {
      handlers.get(name)?.delete(handler);
    },
    publish: (event) => {
      for (const handler of Array.from(handlers.get(event.event) ?? [])) handler(event);
    },
  };
}

/** An audio service that accepts everything and plays nothing. */
function createFakeAudio() {
  const noop = () => {};

  return {
    init: () => true,
    destroy: noop,
    playOnChannel: () => true,
    stopChannel: noop,
    stopAllChannels: noop,
    setChannelVolume: noop,
    setBusVolume: noop,
    getBusVolume: () => 1.0,
    isChannelPlaying: () => false,
    onChannelComplete: noop,
    playVoiceSequence: noop,
    cancelVoiceSequence: noop,
    onVoiceSequenceComplete: noop,
    seekChannelRandom: noop,
    getAudioDevices: () => [],
    setAudioDevice: () => true,
  };
}

/**
 * @typedef {{
 *   engine: import("@iracedeck/audio-scenarios").IScenarioEngine,
 *   manifest: import("@iracedeck/audio-scenarios").AudioAssetsManifest,
 *   audioScenarios: typeof import("@iracedeck/audio-scenarios"),
 * }} CatalogEngine
 */

/** The one registration this process makes — see `registerCatalogEngine`. */
let registration = /** @type {Promise<CatalogEngine> | null} */ (null);

/**
 * The whole pit-crew catalog registered on an engine, with the dist module it
 * came from so a caller can reach the package's other exports (the reference
 * builder, the script compiler) without a second dist lookup.
 *
 * Registered ONCE per process and shared by every later call: the catalog's
 * own sub-engines (radar, spotter, pit speeding) are module singletons bound
 * to the first bus they see, and a second `registerPitCrew` on another bus
 * throws. The catalog is static, so one registration answers every caller.
 * The engine reports the bundled voice as active, and nothing here changes
 * that: neither caller fires a callout — the generator names the voice whose
 * clips it reads explicitly, and the linter reads a pack's files — so there
 * is no consumer for a voice switch, and none is offered.
 *
 * @returns {Promise<CatalogEngine>}
 */
export function registerCatalogEngine() {
  if (!registration) {
    // A failed registration (a missing dist, say) is not cached, so the next
    // call after `pnpm build` gets a fresh attempt.
    registration = register().catch((error) => {
      registration = null;
      throw error;
    });
  }

  return registration;
}

/** @returns {Promise<CatalogEngine>} */
async function register() {
  const audioScenarios = await importAudioScenarios();
  const { registerPitCrew } = await importDist("catalog/pit-crew/index.js");
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, AUDIO_MANIFEST_PATH), "utf-8"));
  const logger = createLogger();
  const bus = createBus();

  // A fresh engine, whatever this process did with the singleton before.
  audioScenarios._resetAudioScenarios();

  const engine = audioScenarios.initializeAudioScenarios(bus, createFakeAudio(), manifest, logger, () => BUNDLED_VOICE);
  registerPitCrew(bus, { logger });

  return { engine, manifest, audioScenarios };
}
