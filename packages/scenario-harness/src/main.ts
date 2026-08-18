/**
 * Boot entry for the scenario harness.
 *
 * Wires the same packages the production plugins use, but with a mock SDK
 * controller and a mock platform adapter. End state: a local HTTP+WS
 * server on 127.0.0.1:5750 driving the real audio engine and the real
 * sim-events translator from a web UI. See `let-s-plan-a-development-mellow-lake.md`
 * for the full design.
 */
import { processAndCopyAudioAssets, wipeProcessedCache } from "@iracedeck/audio-assets/build";
import { AudioNative } from "@iracedeck/audio-native";
import { initializeAudioScenarios } from "@iracedeck/audio-scenarios";
import {
  type CornerNameSnapshot,
  type LapCompletedSnapshot,
  registerPitCrew,
  setRadarEnabled,
} from "@iracedeck/audio-scenarios/pit-crew";
import { AudioBus, initializeAudio } from "@iracedeck/audio-service";
import {
  createMemorySettingsStore,
  initGlobalSettings,
  onGlobalSettingsChange,
  resolveActiveRaceEngineerVoice,
} from "@iracedeck/deck-core";
import { initializeEventBus } from "@iracedeck/event-bus";
import type { SDKController } from "@iracedeck/iracing-sdk";
import { createConsoleLogger, LogLevel } from "@iracedeck/logger";
import {
  getLiveGaps,
  getReadbackSnapshot,
  initializeSimEventsIracing,
  isPitActionsAllowed,
} from "@iracedeck/sim-events-iracing";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAudioAssetsManifest, seedGlobalSettings } from "./bootstrap-settings.js";
import { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController } from "./mock-sdk-controller.js";
import { getHarnessQualifyingInvalidationSnapshot } from "./qualifying-invalidation-snapshot.js";
import { getHarnessRaceStartSnapshot } from "./race-start-snapshot.js";
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from "./server.js";
import { getHarnessSessionStartSnapshot } from "./session-start-snapshot.js";

/**
 * Resolve the package root from the running module's URL. Works whether
 * we're invoked via `tsx watch src/main.ts` (running from `src/`) or via
 * `node dist/main.js` (running from `dist/`) — in both cases the package
 * root is one directory up.
 */
function resolvePackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  return resolve(here, "..");
}

/** Coerce a settings value to a 0..100 volume integer. Mirrors pit-crew. */
function clampVolume(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 100;

  if (!Number.isFinite(n)) return 100;

  return Math.max(0, Math.min(100, Math.round(n)));
}

async function main(): Promise<void> {
  const logger = createConsoleLogger("ScenarioHarness", LogLevel.Debug);
  logger.info("Booting scenario harness");

  // ── Event bus + sim-events translator ────────────────────────────────────
  const eventBus = initializeEventBus(logger.createScope("EventBus"));
  const controller = new MockSDKController({ logger: logger.createScope("MockSDK") });
  initializeSimEventsIracing(eventBus, controller as unknown as SDKController, logger.createScope("SimEventsIracing"));

  // ── Audio engine ────────────────────────────────────────────────────────
  // Process audio-assets through the same radio-engineer ffmpeg filter
  // the plugin build applies, so the harness auditions the exact clips
  // shipped to users (issue: harness was previously playing raw,
  // unfiltered TTS output). The destination lives under the harness's
  // own .cache/ — the underlying ffmpeg cache is shared with the plugin
  // build via `packages/audio-assets/.cache/<filter-hash>/`, so the very
  // first run after a plugin build is a fast cache-hit copy.
  const audioLog = logger.createScope("Audio");
  const audioBasePath = join(resolvePackageRoot(), ".cache", "audio");
  audioLog.info("Processing audio assets (radio filter — first run takes a moment)");
  await processAndCopyAudioAssets({ destRoot: audioBasePath, logger: (m) => audioLog.info(m) });
  audioLog.debug(`Audio base path: ${audioBasePath}`);
  const audioNative = new AudioNative();
  const audio = initializeAudio(audioLog, audioNative, audioBasePath);
  audio.init();

  // ── Audio scenarios ──────────────────────────────────────────────────────
  const adapter = new MockPlatformAdapter(logger);
  const manifest = getAudioAssetsManifest();
  const { raceEngineerVoices } = seedGlobalSettings(adapter);

  initializeAudioScenarios(eventBus, audio, manifest, logger.createScope("AudioScenarios"), () =>
    resolveActiveRaceEngineerVoice(raceEngineerVoices),
  );

  // Cache the most recent `lap.completed` payload so the lap-time scenario's
  // var resolvers can read frozen lap data at fire time (issue #555). Mirrors
  // the production plugin pattern — subscribed BEFORE `registerPitCrew` so
  // this listener runs before the scenario engine's, guaranteeing the cache
  // is up-to-date by the time the scenario evaluates its `where:` predicate.
  let lastLapCompleted: LapCompletedSnapshot | null = null;
  eventBus.subscribe("lap.completed", (ev) => {
    lastLapCompleted = ev.data;
  });

  // Cache the most recent `cornerName.approaching` payload so the corner-name
  // scenario's clip resolver can read it at fire time (issue #888). Same
  // subscribe-before-registerPitCrew ordering as the lap-time cache above.
  let lastCornerName: CornerNameSnapshot | null = null;
  eventBus.subscribe("cornerName.approaching", (ev) => {
    lastCornerName = ev.data;
  });

  // Wire the pit-action cooldown so the harness sees the same suppression
  // window the production plugins do, the readback-snapshot resolver so
  // deferred replays speak the current queue (issue #481), the
  // session-start snapshot resolver so the session-start composer can fire
  // the brief (issue #542), and the lap-time snapshot resolver so the
  // best-lap composer can fire (issue #555). Other closures keep their
  // defaults.
  registerPitCrew(
    eventBus,
    undefined,
    undefined,
    undefined,
    () => isPitActionsAllowed(),
    undefined,
    () => getReadbackSnapshot(),
    undefined, // getDamageCalloutEnabled
    undefined, // getPitStatusCalloutEnabled
    undefined, // getTrackConditionsCalloutEnabled
    undefined, // getIncidentCalloutEnabled
    undefined, // getSessionStartCalloutEnabled
    () => getHarnessSessionStartSnapshot(),
    undefined, // getLapTimeCalloutEnabled
    () => lastLapCompleted,
    undefined, // getPositionCalloutEnabled
    undefined, // getQualifyingInvalidationCalloutEnabled
    () => getHarnessQualifyingInvalidationSnapshot(),
    undefined, // getRaceStatusCalloutEnabled
    undefined, // getRaceFinishedFired
    undefined, // getRaceEndCalloutEnabled
    undefined, // getRaceFinishedSnapshot
    undefined, // getRaceStartCalloutEnabled
    () => getHarnessRaceStartSnapshot(),
    undefined, // getOvertakeCalloutEnabled
    undefined, // getOvertakeDriverName
    undefined, // getLivePosition
    undefined, // getOvertakeGate
    undefined, // getPitBoxCalloutEnabled
    undefined, // getSetupWarningMismatch
    undefined, // getSpotterCalloutEnabled
    undefined, // getSpotterTrackDirection
    undefined, // getSpotterStillThereIntervalMs
    undefined, // getSpotterNearestCarGapMeters
    undefined, // getPitWindowCalloutEnabled
    undefined, // getRollingStartCalloutEnabled
    undefined, // getStartLightCalloutEnabled
    undefined, // getFuelCalloutEnabled
    undefined, // getCornerNameCalloutEnabled (issue #888)
    () => lastCornerName, // getCornerNameSnapshot (issue #888)
    undefined, // getOpponentPitCalloutEnabled (issue #622)
    undefined, // getOpponentPitLivePosition (issue #622) — payload position via the pending stash
    undefined, // getGapCalloutEnabled (issue #933)
    undefined, // getGapCooldownMs (issue #933)
    // The harness boots the REAL translator, so its live gaps are the real
    // ones — wiring them here is what lets the spoken "gap is N seconds"
    // readout clause be auditioned at all (issue #933).
    () => getLiveGaps(),
  );

  // ── deck-core global-settings pipeline ──────────────────────────────────
  // Done AFTER seeding so the listener delivers the seeded values to the
  // scenario engine on the very first tick.
  initGlobalSettings(adapter, logger.createScope("GlobalSettings"), createMemorySettingsStore());

  // ── Settings → radar/audio sync ─────────────────────────────────────────
  // The production Pit Crew action does this on mount + on every settings
  // change. The harness has no actions, so we wire the same plumbing
  // here: the radar engine ships disabled, and bus volumes default to
  // 1.0 — neither matches the seeded `pitCrewRadarEnabled: true` /
  // `radarVolume: 100` until something pushes the values down. Same for
  // `audioOutputDevice` — the device selector setting is only meaningful
  // if something routes it to the audio engine.
  let currentAudioDeviceId = "";
  const applyAudioSettings = (settings: Record<string, unknown>): void => {
    // Match the production Pit Crew helper's `=== true` semantic so the
    // harness behaves identically to the shipped plugin (radar off until
    // explicitly enabled — #378). Key renamed from `radarEnabled` for #515.
    const radarEnabled = settings.pitCrewRadarEnabled === true;
    setRadarEnabled(radarEnabled);

    const radarVol = clampVolume(settings.radarVolume);
    audio.setBusVolume(AudioBus.Alerts, radarVol / 100);

    const voiceVol = clampVolume(settings.raceEngineerVolume);
    audio.setBusVolume(AudioBus.Voice, voiceVol / 100);

    const desiredDevice = typeof settings.audioOutputDevice === "string" ? settings.audioOutputDevice : "";

    if (desiredDevice !== currentAudioDeviceId) {
      currentAudioDeviceId = desiredDevice;

      if (desiredDevice === "") {
        audio.setAudioDevice(-1);
      } else {
        const ok = audio.setAudioDeviceById(desiredDevice);

        // Stale or unplugged id: fall back to system default. Mirrors
        // the plugin's behaviour — we do NOT rewrite the persisted
        // setting, so the device re-binds automatically when it
        // reappears in the enumeration.
        if (!ok) audio.setAudioDevice(-1);
      }
    }
  };
  applyAudioSettings(adapter.readSettings());
  const unsubscribeSettings = onGlobalSettingsChange((settings) =>
    applyAudioSettings(settings as Record<string, unknown>),
  );

  // ── Mock controller starts ticking ───────────────────────────────────────
  controller.start();

  // ── Server ──────────────────────────────────────────────────────────────
  const packageRoot = resolvePackageRoot();
  const { app } = await startServer(
    {
      controller,
      adapter,
      bus: eventBus,
      audio,
      packageRoot,
      logger: logger.createScope("Server"),
      // Live refresh writes into the same dest dir the audio engine reads
      // from. `wipe: false` skips the rmSync — Windows holds file locks on
      // any clip currently loaded by miniaudio, and overwriting in place
      // is plenty since the only stale state we'd risk is a clip removed
      // from source still lingering in dest, which is fine for a dev tool.
      refreshAudioAssets: () =>
        processAndCopyAudioAssets({ destRoot: audioBasePath, logger: (m) => audioLog.info(m), wipe: false }),
      wipeAudioCache: async () => {
        await wipeProcessedCache();
        audioLog.info("Wiped ffmpeg cache; full reprocess on next refresh/restart");
        await processAndCopyAudioAssets({ destRoot: audioBasePath, logger: (m) => audioLog.info(m), wipe: false });
      },
    },
    { host: DEFAULT_HOST, port: DEFAULT_PORT },
  );

  // ── Graceful shutdown ───────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    unsubscribeSettings();
    controller.stop();

    try {
      audio.destroy();
    } catch (err) {
      logger.warn(`Audio shutdown threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await app.close();
    } catch (err) {
      logger.warn(`Server close threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(`Open http://${DEFAULT_HOST}:${DEFAULT_PORT}/ to use the harness`);
}

main().catch((err) => {
  console.error("Scenario harness failed to boot:", err);
  process.exit(1);
});
