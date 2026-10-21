/**
 * The incident comparison (#1426): after a Next / Previous Incident press,
 * where iRacing's search landed against the incidents iRaceDeck recorded.
 * Design: `docs/superpowers/specs/2026-10-12-issue-1426-replay-record-steps.md`
 * ("The comparison", under "Recording incidents").
 *
 * The keys keep sending iRacing's search; this only watches it and writes one
 * debug line, which is the capture for the later decision to switch the keys
 * to the record. It sends nothing and holds no claim on the replay cursor, so
 * no origin token is passed anywhere: the search it watches carries the key's.
 * Any other replay command ends the watch, as the gate's landing wait reports
 * (`superseded`), and nothing is compared then.
 *
 * Landed is the gate's judgement (`waitForReplaySearchLanding`, #1430): the
 * frame jumped by more than playback explains, then held two reads 50 ms
 * apart, out of a seek. The camera car is read on the later of two reads, 50
 * ms apart, because a search moves the camera one sample after the frame.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import type { ILogger } from "@iracedeck/logger";
import { type IncidentListing, REPLAY_FILE_FRAME_LAG, type ReplayIncident } from "@iracedeck/replay-store";

import { sleep } from "./engine-clock.js";
import { type ReplayPressResult, replaySearchCouldRunMs, waitForReplaySearchLanding } from "./replay-command-gate.js";
import {
  readFastestLapSearchDelayMs,
  REPLAY_JUMP_MAX_WAIT_MS,
  STABILIZATION_POLL_INTERVAL_MS,
  STABILIZATION_TIMEOUT_MULTIPLIER,
} from "./replay-timing.js";

/** An incident listing, widened with the case where no store was initialized. */
export type ObservedIncidentListing = IncidentListing | { hit: false; reason: "no store" };

/** Where the replay was when the key was pressed. */
export interface IncidentSearchPress {
  /** What opens the log line: the mode's name ("Next incident"). */
  readonly label: string;
  /** The cursor at the press (the debounced replay frame), or null when there was none. */
  readonly frame: number | null;
  /** `CamCarIdx` at the press, or null when telemetry did not say. */
  readonly camCarIdx: number | null;
}

/** What the observer reads through. It sends nothing. */
export interface IncidentObserverHost {
  readonly logger: Pick<ILogger, "debug" | "error">;
  /** A fresh telemetry read. */
  readTelemetry(): TelemetryData | null;
  /** The recorded incidents, read once the search has landed. */
  listIncidents(): ObservedIncidentListing;
}

/**
 * @internal Exported for testing
 *
 * The recorded incident nearest `frame`; on a tie the earlier one. Null for an
 * empty list. `lagFrames` is added to each recorded frame first: incidents are
 * stored in live numbering, and the replay shows the same moment about
 * `REPLAY_FILE_FRAME_LAG` frames later.
 */
export function nearestIncident(
  incidents: readonly ReplayIncident[],
  frame: number,
  lagFrames = 0,
): ReplayIncident | null {
  let best: ReplayIncident | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const incident of incidents) {
    const distance = Math.abs(incident.frame + lagFrames - frame);

    if (distance < bestDistance) {
      best = incident;
      bestDistance = distance;
    }
  }

  return best;
}

function show(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The part of the line every outcome shares. */
function pressPart(press: IncidentSearchPress): string {
  return `press frame=${show(press.frame)} camCar=${show(press.camCarIdx)}`;
}

/**
 * Watches the search a Next / Previous Incident press sent and logs the
 * comparison at debug. Call it synchronously right after the press, with the
 * gate's result for it: only a search that went out now is watched, and the
 * gate's record of it is taken at the call. A press the gate held, took over
 * or did not send, and one the SDK refused, logs that nothing is compared.
 * Never rejects: a failure is logged.
 */
export function observeIncidentSearch(
  result: ReplayPressResult,
  press: IncidentSearchPress,
  host: IncidentObserverHost,
): Promise<void> {
  const { label } = press;
  const { logger } = host;

  if (result.kind !== "sent" || !result.ok) {
    const what = result.kind === "sent" ? "refused" : result.kind;

    logger.debug(`${label} comparison: search ${what}; ${pressPart(press)}; nothing compared`);

    return Promise.resolve();
  }

  // Both read now: the gate's record of the search is the one this press made,
  // and how long it could still run counts from its send.
  const patienceMs = replaySearchCouldRunMs() ?? readFastestLapSearchDelayMs() * STABILIZATION_TIMEOUT_MULTIPLIER;
  const landing = waitForReplaySearchLanding({ patienceMs, hardBoundMs: REPLAY_JUMP_MAX_WAIT_MS });

  return landing
    .then(async (outcome) => {
      if (outcome !== "landed") {
        logger.debug(`${label} comparison: search ${outcome}; ${pressPart(press)}; nothing compared`);

        return;
      }

      const first = host.readTelemetry();

      await sleep(STABILIZATION_POLL_INTERVAL_MS);

      const later = host.readTelemetry() ?? first;
      const landedFrame = finiteOrNull(later?.ReplayFrameNum);
      const landedCar = finiteOrNull(later?.CamCarIdx);
      const landed = `landed frame=${show(landedFrame)} camCar=${show(landedCar)}`;

      if (landedFrame === null) {
        logger.debug(`${label} comparison: ${pressPart(press)}; ${landed}; no frame to compare`);

        return;
      }

      const listing = host.listIncidents();

      if (!listing.hit) {
        logger.debug(`${label} comparison: ${pressPart(press)}; ${landed}; no recorded incident (${listing.reason})`);

        return;
      }

      // Incidents are recorded in live numbering; the replay shows the same
      // moment about REPLAY_FILE_FRAME_LAG frames later, so the nearest is
      // picked on the corrected frame and both differences are logged.
      const nearest = nearestIncident(listing.incidents, landedFrame, REPLAY_FILE_FRAME_LAG);

      if (nearest === null) {
        logger.debug(`${label} comparison: ${pressPart(press)}; ${landed}; no recorded incident (none recorded)`);

        return;
      }

      logger.debug(
        `${label} comparison: ${pressPart(press)}; ${landed}; ` +
          `nearest recorded incident frame=${nearest.frame} carIdx=${nearest.carIdx} delta=${nearest.delta} ` +
          `source=${nearest.source}; difference=${landedFrame - nearest.frame} frames ` +
          `(${landedFrame - nearest.frame - REPLAY_FILE_FRAME_LAG} after the ${REPLAY_FILE_FRAME_LAG}-frame lag)`,
      );
    })
    .catch((error: unknown) => {
      logger.error(`${label} comparison failed: ${error instanceof Error ? error.message : String(error)}`);
    });
}
