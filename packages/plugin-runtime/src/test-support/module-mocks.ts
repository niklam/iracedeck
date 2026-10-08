/**
 * The `vi.mock` factories every phase test (and the order test) uses (#1349).
 *
 * `vi.mock` is hoisted per test file, so each file still names every module it
 * mocks, one line each — but the bodies live here, so a module's mock changes
 * in one place. From `src/phases/` the block reads:
 *
 * ```typescript
 * vi.mock("@iracedeck/deck-core", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/diagnostics", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/settings-window", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/replay-store", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/app-updates", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/voice-packs", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/settings", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/deck-iracing", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/event-bus", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/sim-events-iracing", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/audio-service", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/audio-scenarios", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/iracing-native", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/audio-native", async (io) => (await import("../test-support/module-mocks.js")).recordedModule(io));
 * vi.mock("@iracedeck/rasterizer", async () => (await import("../test-support/module-mocks.js")).rasterizerMock());
 * vi.mock("@iracedeck/race-engineer-wiring", async () => (await import("../test-support/module-mocks.js")).raceEngineerWiringMock());
 * vi.mock("../actions.js", async () => (await import("../test-support/module-mocks.js")).actionsMock());
 * ```
 *
 * (`./test-support/…` and `./actions.js` from `src/`.) This module imports
 * nothing but the recorder: importing a module it mocks from here would load
 * the mock from inside its own factory. `@iracedeck/audio-scenarios/pit-crew`,
 * `@iracedeck/logger` and `node:*` stay real.
 */
import { recordingModule, stub } from "./recorder.js";

/**
 * The real module with every function and class export recorded and every
 * other export (constants, schemas, enums) kept real. Pass the factory's
 * `importOriginal` argument.
 */
export async function recordedModule(importOriginal: () => Promise<unknown>): Promise<Record<string, unknown>> {
  return recordingModule((await importOriginal()) as Record<string, unknown>);
}

/** `@iracedeck/rasterizer`: only `createSvgRasterizer`, recorded. Never loads resvg. */
export function rasterizerMock(): Record<string, unknown> {
  return { createSvgRasterizer: stub("createSvgRasterizer") };
}

/** `@iracedeck/race-engineer-wiring`: the two calls the bootstrap makes, recorded. */
export function raceEngineerWiringMock(): Record<string, unknown> {
  return { createIracingSimRuntime: stub("createIracingSimRuntime"), wireRaceEngineer: stub("wireRaceEngineer") };
}

/** The plugin-level hooks `src/actions.ts` re-exports, each mocked as a recorded stub under its own name. */
export const ACTION_HOOKS = [
  "applyRaceEngineerAudio",
  "applyRadarEnabled",
  "applyRadarVolume",
  "armFeatureGateSync",
  "isAudioPreviewKind",
  "migrateLfeIntensityBindingKeys",
  "runAudioPreview",
  "stopRaceEngineerPlayback",
  "syncFeatureGates",
] as const;

/** The UUIDs of `actionsMock()`'s `SHARED_ACTIONS`, in order. */
export const MOCK_SHARED_ACTION_UUIDS = ["shared.a", "shared.b"] as const;

/** The UUIDs of `actionsMock()`'s `STREAM_DECK_ACTIONS`, in order. */
export const MOCK_STREAM_DECK_ACTION_UUIDS = ["sd.switch-profile"] as const;

/**
 * `src/actions.ts`, so no test loads `@iracedeck/iracing-actions`: the hooks
 * recorded, the binding-default maps empty, and two short action lists whose
 * entries create an empty handler. Keep it in step with `actions.ts`'s
 * exports — when a phase reads a name missing here, Vitest throws
 * `No "X" export is defined on the "…" mock` at the first access.
 */
export function actionsMock(): Record<string, unknown> {
  const entry = (uuid: string) => ({ uuid, scope: uuid, create: () => ({}) });

  return {
    ...Object.fromEntries(ACTION_HOOKS.map((name) => [name, stub(name)])),
    CAR_CYCLE_BINDING_DEFAULTS: {},
    SETUP_CHASSIS_BINDING_KEY_RENAMES: {},
    SHARED_ACTIONS: MOCK_SHARED_ACTION_UUIDS.map(entry),
    STREAM_DECK_ACTIONS: MOCK_STREAM_DECK_ACTION_UUIDS.map(entry),
  };
}
