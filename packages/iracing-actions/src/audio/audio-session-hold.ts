/**
 * The audio session hold (issue #1347): decides when the plugin keeps the
 * audio device open instead of opening it per sound.
 *
 * The audio service owns the hold — a set of reasons; while one is taken the
 * device stays open and the 5 s idle stop is not armed. This module owns the
 * one reason the plugin has for taking it, `"iracing-session"`, and holds it
 * exactly while both of these are true:
 *
 * - **iRacing is running.** Seeded from the app monitor's `isIRacingActive()`
 *   when the controller starts, so a plugin started with iRacing already up
 *   takes the hold at once, then driven by the monitor's started and
 *   terminated edges alone. The started edge is the host's LAUNCH event, not
 *   the telemetry connection: the open lands at the plugin's quietest moment,
 *   25–60 s before the connection, rather than at connect, the busiest moment
 *   of a run and where both #1330 freezes happened. On a host that delivers no
 *   app-monitoring events (Ulanzi) the started edge IS the SDK connection, so
 *   there the device opens at connect.
 * - **The Race Engineer or the Radar master gate is on, or press sounds are**
 *   (#269), each read live on every evaluation. With all three off nothing
 *   plays during a session, so a held stream would only cost: Windows keeps
 *   its "audio stream in use" power request for a device nobody will hear.
 *   Press sounds count because without the hold a driver with both master
 *   gates off would pay a device start on the first press after every five
 *   idle seconds, so the sound would arrive late on exactly the sporadic
 *   presses of a race. Every global-settings change re-evaluates, so toggling
 *   any of the three mid-session takes or releases the hold.
 *
 * Without the hold a race opened the device once per burst of callouts — 16
 * times in 18 minutes on 2026-10-04 — and each open initialises the driver.
 *
 * Every dependency is injected: the module imports no app monitor, no audio
 * service and no settings, so the composition root decides whose edges, gates
 * and device it follows, and a test drives it with plain fakes.
 *
 * It writes no info lines of its own. The audio service logs the device being
 * held and released; this module only says why, at debug.
 */
import type { ILogger } from "@iracedeck/logger";

/** The reason this controller takes the audio service's hold under. */
export const IRACING_SESSION_HOLD_REASON = "iracing-session";

/**
 * The part of the audio service the controller drives. Structural, so the
 * controller depends on neither `@iracedeck/audio-service` nor its singleton.
 */
export interface AudioHoldTarget {
  /** Keep the device open until `reason` is released. */
  hold(reason: string): void;
  /** Give `reason` back; the last release arms the idle stop. */
  release(reason: string): void;
}

/** A subscription that hands back its own unsubscribe. */
type Subscribe = (listener: () => void) => () => void;

export interface AudioSessionHoldDeps {
  /** The audio service, or anything that holds and releases like it. */
  audio: AudioHoldTarget;
  /** The app monitor's started edge: once per iRacing session. */
  onIRacingStarted: Subscribe;
  /** The app monitor's terminated edge: once per iRacing exit. */
  onIRacingTerminated: Subscribe;
  /** Whether iRacing is running now. Read once, when the controller starts. */
  isIRacingActive: () => boolean;
  /** The Race Engineer master gate, read live. */
  isRaceEngineerEnabled: () => boolean;
  /** The Radar master gate, read live. */
  isRadarEnabled: () => boolean;
  /** Whether a press sound plays at all (the Press sound setting is not `none`), read live (#269). */
  isPressSoundEnabled: () => boolean;
  /** Fires for every global-settings write; the listener ignores the settings it is handed. */
  onGlobalSettingsChange: Subscribe;
  logger: ILogger;
}

/**
 * Start following iRacing and the three gates, taking and releasing the
 * audio hold as they change. Call once per plugin, after the app monitor is
 * initialised.
 *
 * Faults are contained, in the start call and in all three listeners. The
 * settings listener runs inside `updateGlobalSettings`' fan-out, which has no
 * try/catch and persists only after the fan-out returns, so a throw from here
 * would abort every later listener and lose the write that triggered it; the
 * app-monitor listeners run inside the host's launch and terminate handlers.
 * Same reasoning as `syncFeatureGates`.
 *
 * @returns A stop function: unsubscribes, and releases the hold if this
 * controller holds it. The plugin never stops; tests do.
 */
export function startAudioSessionHold(deps: AudioSessionHoldDeps): () => void {
  const { logger } = deps;

  /** Whether iRacing is running, as far as the edges have said. */
  let running = false;
  /**
   * Whether the hold is ours: `hold` returned and no `release` has since. A
   * settings change fires for every global-settings write, so this is what
   * makes the steady state one comparison and no call into the audio service.
   */
  let held = false;
  let evaluating = false;
  let evaluateAgain = false;
  let stopped = false;

  /** Bring the hold in line with the conditions above. Throws what its collaborators throw. */
  function apply(trigger: string): void {
    // The gates are read only while iRacing runs: with it closed the answer is
    // already no, and a gate reader that throws cannot get in the way of the
    // release when iRacing exits.
    const wanted = running && (deps.isRaceEngineerEnabled() || deps.isRadarEnabled() || deps.isPressSoundEnabled());

    if (wanted === held) return;

    // Called on `deps.audio`, never as a detached function: the audio service
    // is a class instance and its methods read `this`.
    if (wanted) {
      logger.debug(`Taking the audio hold (${trigger})`);
      deps.audio.hold(IRACING_SESSION_HOLD_REASON);
    } else {
      logger.debug(`Releasing the audio hold (${trigger})`);
      deps.audio.release(IRACING_SESSION_HOLD_REASON);
    }

    // LAST, once the call has returned. Recording it first would make a
    // swallowed fault permanent: the controller would believe the device is
    // held (or released), every later evaluation would short-circuit, and the
    // hold would stay out of step with iRacing for the rest of the run.
    // Recording it last leaves the failed change pending, and the next
    // evaluation — any settings write, or the next edge — retries it.
    held = wanted;
  }

  function evaluate(trigger: string): void {
    if (stopped) return;

    // `held` is recorded only after the audio call returns, so an evaluation
    // that arrived DURING that call (a settings write made while the device
    // opens) would see the change as still pending and make it a second time.
    // It is deferred instead, and the loop below runs it once the call is back.
    if (evaluating) {
      evaluateAgain = true;

      return;
    }

    evaluating = true;

    try {
      do {
        evaluateAgain = false;
        apply(trigger);
      } while (evaluateAgain);
    } catch (error: unknown) {
      // A throw also ends the loop, so a fault can never spin it; the change
      // stays pending for the next evaluation.
      logger.error("Updating the audio session hold failed");
      logger.debug(String(error));
    } finally {
      evaluating = false;
    }
  }

  const unsubscribes = [
    deps.onIRacingStarted(() => {
      running = true;
      evaluate("iRacing started");
    }),
    deps.onIRacingTerminated(() => {
      running = false;
      evaluate("iRacing exited");
    }),
    deps.onGlobalSettingsChange(() => evaluate("settings changed")),
  ];

  // The state at startup, read once. From here on the two edges are the only
  // source: re-reading it per evaluation would let a settings write take the
  // hold on an SDK connection the started edge has not reported yet, which is
  // the open-at-connect this controller exists to avoid.
  try {
    running = deps.isIRacingActive();
  } catch (error: unknown) {
    logger.error("Reading whether iRacing is running failed");
    logger.debug(String(error));
  }

  evaluate("plugin start");

  return () => {
    if (stopped) return;

    stopped = true;

    // Each on its own, so one failing unsubscribe neither keeps the others
    // subscribed nor leaves the device held.
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch (error: unknown) {
        logger.error("Unsubscribing the audio session hold failed");
        logger.debug(String(error));
      }
    }

    if (!held) return;

    try {
      logger.debug("Releasing the audio hold (stopped)");
      deps.audio.release(IRACING_SESSION_HOLD_REASON);
      held = false;
    } catch (error: unknown) {
      logger.error("Updating the audio session hold failed");
      logger.debug(String(error));
    }
  };
}
