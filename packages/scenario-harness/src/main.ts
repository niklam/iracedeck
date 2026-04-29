/**
 * Boot entry for the scenario harness.
 *
 * Wires the same packages the production plugins use, but with a mock SDK
 * controller and a mock platform adapter. End state: a local HTTP+WS
 * server on 127.0.0.1:5750 driving the real audio engine and the real
 * sim-events translator from a web UI. See `let-s-plan-a-development-mellow-lake.md`
 * for the full design.
 */
import { AudioNative } from "@iracedeck/audio-native";
import { initializeAudioScenarios } from "@iracedeck/audio-scenarios";
import { registerPitCrew, setRadarEnabled } from "@iracedeck/audio-scenarios/pit-crew";
import { AudioBus, initializeAudio } from "@iracedeck/audio-service";
import { initGlobalSettings, onGlobalSettingsChange, resolveActiveRaceEngineerVoice } from "@iracedeck/deck-core";
import { initializeEventBus } from "@iracedeck/event-bus";
import type { SDKController } from "@iracedeck/iracing-sdk";
import { createConsoleLogger, LogLevel } from "@iracedeck/logger";
import { initializeSimEventsIracing, isPitActionsAllowed } from "@iracedeck/sim-events-iracing";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAudioAssetsManifest, resolveAudioAssetsBasePath, seedGlobalSettings } from "./bootstrap-settings.js";
import { MockPlatformAdapter } from "./mock-platform-adapter.js";
import { MockSDKController } from "./mock-sdk-controller.js";
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from "./server.js";

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
  const audioBasePath = resolveAudioAssetsBasePath();
  logger.debug(`Audio base path: ${audioBasePath}`);
  const audioNative = new AudioNative();
  const audio = initializeAudio(logger.createScope("Audio"), audioNative, audioBasePath);
  audio.init();

  // ── Audio scenarios ──────────────────────────────────────────────────────
  const adapter = new MockPlatformAdapter(logger);
  const manifest = getAudioAssetsManifest();
  const { raceEngineerVoices } = seedGlobalSettings(adapter);

  initializeAudioScenarios(eventBus, audio, manifest, logger.createScope("AudioScenarios"), () =>
    resolveActiveRaceEngineerVoice(raceEngineerVoices),
  );
  // Wire the pit-action cooldown so the harness sees the same suppression
  // window the production plugins do. Other closures keep their defaults.
  registerPitCrew(eventBus, undefined, undefined, undefined, () => isPitActionsAllowed());

  // ── deck-core global-settings pipeline ──────────────────────────────────
  // Done AFTER seeding so the listener delivers the seeded values to the
  // scenario engine on the very first tick.
  initGlobalSettings(adapter, logger.createScope("GlobalSettings"));

  // ── Settings → radar/audio sync ─────────────────────────────────────────
  // The production Pit Crew action does this on mount + on every settings
  // change. The harness has no actions, so we wire the same plumbing
  // here: the radar engine ships disabled, and bus volumes default to
  // 1.0 — neither matches the seeded `radarEnabled: true` /
  // `radarVolume: 100` until something pushes the values down. Same for
  // `audioOutputDevice` — the device selector setting is only meaningful
  // if something routes it to the audio engine.
  let currentAudioDeviceId = "";
  const applyAudioSettings = (settings: Record<string, unknown>): void => {
    // Match the production Pit Crew helper's `=== true` semantic so the
    // harness behaves identically to the shipped plugin (radar off until
    // explicitly enabled — #378).
    const radarEnabled = settings.radarEnabled === true;
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
