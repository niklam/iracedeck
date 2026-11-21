/**
 * Records the session's camera groups into the catalog and publishes
 * `_cameraCatalog` (#1653, spec decisions 3 and 4).
 *
 * Two inputs, one output:
 *
 * - `onTick` is an `sdkController.subscribe` callback, the shape of
 *   `replay-session-subscriber.ts`. A new session info is detected by
 *   REFERENCE: the controller returns the same parsed object until iRacing
 *   publishes a new YAML, so a tick with an unchanged session info costs one
 *   comparison. A new one carrying a `TrackID` and a non-empty
 *   `CameraInfo.Groups` is recorded — live or in a replay, which records under
 *   the replay's own track — and becomes the `current` session.
 * - `onCatalogChange` is subscribed to the catalog service: the load
 *   finishing, an observation that changed the catalog, a removal.
 *
 * `_cameraCatalog` is published through `publish` (the plugin binds
 * `updateGlobalSettings({ [CAMERA_CATALOG_KEY]: json })`) only when its JSON
 * differs from the last one published, and only at the spec's triggers: the
 * catalog loading, any catalog change, a change of the current session's
 * track or group list, and `current: null` on disconnect. Nothing else
 * publishes, and nothing is published before the catalog has loaded.
 *
 * Never before global settings are initialised (`canPublish`): a write then
 * reaches no listener and would only set the dedupe marker. A trigger that
 * finds them not initialised leaves the publish pending; the next trigger or
 * tick that finds them ready sends it. The plugin wires this after
 * `initGlobalSettings`, so in practice that never waits.
 */
import { CAMERA_CATALOG_KEY, type CameraCatalogViewCurrent } from "@iracedeck/app-constants";
import {
  readCameraGroupNames,
  readTrackConfigName,
  readTrackDisplayName,
  readTrackId,
  type SessionInfo,
  type TelemetryCallback,
} from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";

import type { CameraCatalogService } from "./camera-catalog-service.js";
import { toCameraCatalogView } from "./camera-catalog.js";

export interface CameraCatalogPublisherOptions {
  catalog: Pick<CameraCatalogService, "isLoaded" | "getCatalog" | "observe">;
  /** `() => getController().getSessionInfo()`; the same object until the YAML updates. */
  getSessionInfo: () => SessionInfo | null;
  /** Write the view's JSON as `_cameraCatalog`; the plugin binds `updateGlobalSettings`. */
  publish: (partial: Record<string, unknown>) => void;
  /** Whether global settings are initialised; the plugin binds `isGlobalSettingsInitialized`. */
  canPublish: () => boolean;
  logger: ILogger;
}

export interface CameraCatalogPublisher {
  /** The `sdkController.subscribe` callback. */
  readonly onTick: TelemetryCallback;
  /** The catalog service's change listener. */
  readonly onCatalogChange: () => void;
}

function sameCurrent(a: CameraCatalogViewCurrent | null, b: CameraCatalogViewCurrent | null): boolean {
  if (a === null || b === null) return a === b;

  return a.trackId === b.trackId && a.groups.length === b.groups.length && a.groups.every((g, i) => g === b.groups[i]);
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/** Create the publisher. Pure: it subscribes nothing; the plugin wires both inputs. */
export function createCameraCatalogPublisher(options: CameraCatalogPublisherOptions): CameraCatalogPublisher {
  const { catalog, getSessionInfo, publish, canPublish, logger } = options;
  /** The session info last read, by reference; null on disconnect, so a reconnect reads afresh. */
  let lastSessionInfo: SessionInfo | null = null;
  let current: CameraCatalogViewCurrent | null = null;
  /** A trigger fired that has not been published yet. */
  let pending = false;
  let lastPublished: string | undefined;

  /** Publish when a trigger is pending, the catalog has loaded and settings are initialised; skip an unchanged JSON. */
  const flush = (): void => {
    if (!pending || !catalog.isLoaded() || !canPublish()) return;

    const json = JSON.stringify(toCameraCatalogView(catalog.getCatalog(), current));

    // Marked done only once the write returned: a write that throws leaves the
    // publish pending for the next trigger instead of recording it as sent.
    if (json !== lastPublished) {
      publish({ [CAMERA_CATALOG_KEY]: json });
      lastPublished = json;
    }

    pending = false;
  };

  const setCurrent = (next: CameraCatalogViewCurrent | null): void => {
    if (sameCurrent(current, next)) return;

    current = next;
    pending = true;
  };

  const onTick: TelemetryCallback = (_telemetry, isConnected) => {
    try {
      if (!isConnected) {
        lastSessionInfo = null;
        setCurrent(null);
        flush();

        return;
      }

      const sessionInfo = getSessionInfo();

      if (sessionInfo === lastSessionInfo) {
        flush();

        return;
      }

      lastSessionInfo = sessionInfo;

      const trackId = readTrackId(sessionInfo);
      const groups = readCameraGroupNames(sessionInfo);

      if (trackId === null || groups.length === 0) {
        // Nothing to describe yet (no session loaded, or no camera list in it).
        setCurrent(null);
        flush();

        return;
      }

      // `current` first, so the publish an observation's change triggers
      // already carries this session; the flush below then has nothing left.
      setCurrent({ trackId, groups });
      catalog.observe({
        trackId,
        trackName: readTrackDisplayName(sessionInfo),
        trackConfig: readTrackConfigName(sessionInfo),
        groups,
      });
      flush();
    } catch (error: unknown) {
      logger.error("The camera catalog could not follow the session");
      logger.debug(`Camera catalog tick error: ${describeError(error)}`);
    }
  };

  const onCatalogChange = (): void => {
    try {
      pending = true;
      flush();
    } catch (error: unknown) {
      logger.error("The camera catalog could not be published");
      logger.debug(`Camera catalog publish error: ${describeError(error)}`);
    }
  };

  return { onTick, onCatalogChange };
}
