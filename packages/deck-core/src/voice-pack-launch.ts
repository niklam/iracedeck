/**
 * The voice-pack LAUNCH step (#1034 stage 3): what the plugin does about voice
 * packs on its own, without a button press.
 *
 * In order: sweep the installer's working directories, seed any bundled pack
 * into an empty folder (a permanent rule that is a no-op in a release that
 * bundles nothing), wait for the settings load to settle, then ENSURE — make
 * `default` match the catalog and bring every other catalog-installed pack up
 * to date — and retry that on a schedule until it holds.
 *
 * Why the settle wait: the catalog client reads the `_devBaseUrl` override
 * from the settings cache, and an ensure fired before the load would silently
 * ignore it. It is a wait, not a gate — the fail-closed settings path settles
 * too, and the voice still arrives (spec, ruling 2).
 *
 * Why retry, and why harder while the Race Engineer is on (Niklas, 2026-09-07):
 * a missing `default` is a mute engineer, and a failed update is a voice whose
 * newer callouts are silent. Neither is benign, and the user who has the
 * engineer switched on is the one who notices.
 *
 * Silent by construction: nothing here opens a window — the structural test
 * over every `voice*.ts` module holds this one to that too.
 */
import type { ILogger } from "@iracedeck/logger";

import type {
  VoicePackInstaller,
  VoicePackInstallFailureCode,
  VoicePackInstallResult,
} from "./voice-pack-installer.js";
import type { VoicePackOffer } from "./voice-pack-status.js";

/** The pack iRaceDeck keeps current unasked — a PACK id (voice and pack ids merely coincide today). */
export const ENSURED_VOICE_PACK_ID = "default";

/** True for the pack the plugin manages itself: installed and refreshed at launch, un-removable in the settings window. */
export function isManagedVoicePack(id: string): boolean {
  return id === ENSURED_VOICE_PACK_ID;
}

/** Retry delays after the Nth consecutive failure, per Race Engineer gate state; then the steady interval repeats. */
export const VOICE_PACK_RETRY_DELAYS_MS = Object.freeze({
  engineerOn: Object.freeze([60_000, 120_000, 300_000, 600_000]),
  engineerOff: Object.freeze([300_000, 900_000, 3_600_000]),
});

export const VOICE_PACK_RETRY_STEADY_MS = Object.freeze({ engineerOn: 900_000, engineerOff: 3_600_000 });

/**
 * Failure codes a retry against the SAME catalog answer can plausibly clear: the
 * network, the disk, a lock, a bug. A hash mismatch (`verify`), a malformed
 * archive (`extract`) and an archive that is not the pack asked for
 * (`invalid-pack`) are the catalog's fault, not the connection's, and are not
 * retried until the catalog answer changes — the spec's *Stage 3 — dropping the
 * bundle* retry paragraph; a Rescan press or the next start re-runs the ensure.
 */
const TRANSIENT_FAILURES: ReadonlySet<VoicePackInstallFailureCode> = new Set<VoicePackInstallFailureCode>([
  "download",
  "storage",
  "promote",
  "busy",
  "internal",
]);

type InstallFailure = Extract<VoicePackInstallResult, { ok: false }>;

export type VoicePackLaunchOutcome =
  /** Everything the step is responsible for is at the catalog's digest. */
  | { state: "current" }
  | { state: "retry-scheduled"; inMs: number; reason: string }
  /** A failure a retry cannot fix (unsupported / not-in-catalog / invalid-pack). */
  | { state: "given-up"; reason: string };

export interface VoicePackLaunchStepDeps {
  installer: Pick<VoicePackInstaller, "sweep" | "seed" | "refreshCatalog" | "install" | "republishStatus">;
  /**
   * Resolves when the settings load settled — `() => whenSettingsStoreSettled()`.
   * A THUNK, evaluated inside `start()` after sweep and seed: `initGlobalSettings`
   * re-arms the signal, and the plugins construct this step long before they
   * call it, so a promise taken at construction would be the discarded pre-init one.
   */
  settled: () => Promise<void>;
  /** Live read of `pitCrewRaceEngineerEnabled`. */
  isRaceEngineerEnabled: () => boolean;
  logger: ILogger;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

export interface VoicePackLaunchStep {
  /** Plugin start. Never rejects. Resolves after the FIRST ensure completes (retries continue in the background). */
  start(): Promise<VoicePackLaunchOutcome>;
  /** Run the ensure again now — the Race Engineer gate flipping on, or Rescan. Joins an ensure in flight (it re-runs once that one finishes). */
  poke(): void;
  /**
   * Permanent shutdown — the plugin stopping, and tests. Cancels any scheduled
   * retry and refuses every later run: `poke()` is inert, no retry is armed, a
   * follow-up queued behind an in-flight ensure is dropped, and a `start()`
   * still waiting on the settle resolves without an ensure. Never call it for a
   * gate flip; that is `poke()`'s job.
   */
  stop(): void;
  /** The last outcome, for tests and logs. */
  lastOutcome(): VoicePackLaunchOutcome | undefined;
}

export function createVoicePackLaunchStep(deps: VoicePackLaunchStepDeps): VoicePackLaunchStep {
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let consecutiveFailures = 0;
  let inFlight: Promise<VoicePackLaunchOutcome> | undefined;
  let pokedWhileInFlight = false;
  let stopped = false;
  /** Set once `start()` has passed the settle wait; the ensure never runs before it. */
  let ready = false;
  let last: VoicePackLaunchOutcome | undefined;

  function scheduleFor(): number {
    const on = deps.isRaceEngineerEnabled();
    const delays = on ? VOICE_PACK_RETRY_DELAYS_MS.engineerOn : VOICE_PACK_RETRY_DELAYS_MS.engineerOff;
    const steady = on ? VOICE_PACK_RETRY_STEADY_MS.engineerOn : VOICE_PACK_RETRY_STEADY_MS.engineerOff;

    return delays[consecutiveFailures - 1] ?? steady;
  }

  function targets(packs: readonly VoicePackOffer[]): string[] {
    // `update` means a provenance record names this pack and its digest is behind — a pack the
    // catalog installed. `install` means nothing (or a record-less folder) is there; only the
    // managed pack is installed unasked, and for it a record-less folder is replaced by force.
    return packs
      .filter((pack) => pack.verdict === "update" || (isManagedVoicePack(pack.id) && pack.verdict === "install"))
      .map((pack) => pack.id);
  }

  function isPermanent(result: InstallFailure): boolean {
    return !TRANSIENT_FAILURES.has(result.code);
  }

  async function ensureOnce(retrying: boolean): Promise<VoicePackLaunchOutcome> {
    const catalog = await deps.installer.refreshCatalog({ bypassTtl: retrying });

    if (catalog.state !== "ok") return failed("the catalog could not be read");

    // Both guards below sit before `targets()`, so a catalog that cannot offer
    // the managed pack — or omits it — also skips pending updates of every other
    // pack: a catalog in that state is a publishing mistake, and the next start
    // retries the whole ensure.
    const unsupported = catalog.packs.find((pack) => isManagedVoicePack(pack.id) && pack.verdict === "unsupported");

    if (unsupported !== undefined) {
      return giveUp(`"${unsupported.id}" needs plugin ${unsupported.minPluginVersion ?? "?"} or newer`);
    }

    // A catalog with no entry for the managed pack is a publishing mistake, not
    // "up to date": there is nothing this step could install, and a reassuring
    // line would hide it.
    if (!catalog.packs.some((pack) => isManagedVoicePack(pack.id))) {
      deps.logger.debug(`Voice pack "${ENSURED_VOICE_PACK_ID}" is not in the catalog`);

      return giveUp(`the catalog names no "${ENSURED_VOICE_PACK_ID}" pack`);
    }

    const ids = targets(catalog.packs);

    if (ids.length === 0) return current();

    deps.logger.info("Voice packs: installing or updating");
    deps.logger.debug(`Voice packs to install or update: ${ids.join(", ")}`);

    const results = await Promise.all(ids.map(async (id) => ({ id, result: await deps.installer.install(id) })));
    const failures = results.filter((r): r is { id: string; result: InstallFailure } => !r.result.ok);

    if (failures.length === 0) return current();

    const permanent = failures.filter((f) => isPermanent(f.result));

    if (permanent.length === failures.length) {
      return giveUp(permanent.map((f) => `${f.id}: ${f.result.reason}`).join("; "));
    }

    return failed(failures.map((f) => `${f.id}: ${f.result.reason}`).join("; "));
  }

  function current(): VoicePackLaunchOutcome {
    consecutiveFailures = 0;
    deps.logger.info("Voice packs: up to date");

    return { state: "current" };
  }

  function giveUp(reason: string): VoicePackLaunchOutcome {
    consecutiveFailures = 0;
    deps.logger.warn(`Voice packs: cannot be brought up to date — ${reason}`);

    return { state: "given-up", reason };
  }

  function failed(reason: string): VoicePackLaunchOutcome {
    consecutiveFailures += 1;
    const inMs = scheduleFor();

    // Stopped mid-ensure: a retry that can never fire is not "scheduled".
    if (!arm(inMs)) return { state: "given-up", reason: "stopped" };

    deps.logger.warn("Voice packs: could not be brought up to date; will retry");
    deps.logger.debug(`Voice packs retry in ${inMs} ms — ${reason}`);

    return { state: "retry-scheduled", inMs, reason };
  }

  /** Arms the retry timer; false when stopped, in which case nothing is armed. */
  function arm(inMs: number): boolean {
    disarm();

    if (stopped) return false;

    timer = setTimer(() => {
      timer = undefined;
      void run(true);
    }, inMs);
    // A pending retry must not keep the process alive on its own.
    (timer as { unref?: () => void }).unref?.();

    return true;
  }

  function disarm(): void {
    if (timer === undefined) return;

    clearTimer(timer);
    timer = undefined;
  }

  async function run(retrying: boolean): Promise<VoicePackLaunchOutcome> {
    if (inFlight !== undefined) {
      pokedWhileInFlight = true;

      return inFlight;
    }

    disarm();
    inFlight = (async () => {
      try {
        return await ensureOnce(retrying);
      } catch (error: unknown) {
        deps.logger.error(`Voice pack launch step failed: ${String(error)}`);

        return failed(String(error));
      } finally {
        deps.installer.republishStatus();
      }
    })();

    try {
      last = await inFlight;
    } finally {
      inFlight = undefined;
    }

    if (pokedWhileInFlight && !stopped) {
      pokedWhileInFlight = false;
      void run(true);
    }

    return last;
  }

  async function guarded(what: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error: unknown) {
      deps.logger.error(`Voice pack startup ${what} failed: ${String(error)}`);
    }
  }

  return {
    async start() {
      // Every step is written never to reject; the guards keep a disk fault on
      // the startup path out of Node's unhandled-rejection handler. Each step
      // is guarded on its own so a sweep that throws still lets the seed run
      // and the settle wait happen — `whenSettingsStoreSettled` is documented
      // never to reject, but this module's guarantee must not rest on a dep's
      // promise.
      await guarded("sweep", () => deps.installer.sweep());
      await guarded("seed", () => deps.installer.seed());
      await guarded("settle wait", () => deps.settled());
      ready = true;

      if (stopped) return last ?? { state: "given-up", reason: "stopped" };

      return run(false);
    },
    poke() {
      if (stopped) return;

      // Before `start()` has passed the settle wait an ensure would run with no
      // sweep, no seed and the `_devBaseUrl` override unread — the very thing
      // the wait exists for. The first ensure is imminent and covers this poke.
      if (!ready) return;

      consecutiveFailures = 0;
      void run(true);
    },
    stop() {
      stopped = true;
      disarm();
    },
    lastOutcome() {
      return last;
    },
  };
}
