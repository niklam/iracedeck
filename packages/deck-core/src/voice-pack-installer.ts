/**
 * "Install this pack" — the composition of the voice-pack install modules
 * (issue #1034, stage 2; #1100).
 *
 * Five modules each own one step and were each proven in isolation: the
 * catalog says WHAT to fetch, the downloader fetches and hashes it, the archive
 * module unpacks it without trusting a byte, the storage module owns the disk
 * choreography around it, and the scanner decides what is a pack. This module
 * owns the ORDER those steps run in, the decisions between them, and the one
 * property none of them can establish alone:
 *
 *   A failure at any step leaves the previously installed pack untouched and
 *   playable. Nothing is removed until a complete, verified replacement is
 *   staged.
 *
 * The pipeline, per the spec's *Install pipeline* section, is: decide (the
 * catalog's `sha256` against the installed `.install.json` — equal means
 * nothing to do, and that comparison is the whole answer to "don't re-download
 * on every plugin version"), lock, download while hashing, verify, extract to a
 * staging directory, validate the content, stop playback, promote, refresh.
 * Every step before `promote` works in `.tmp`, which the scanner never reads,
 * so up to that point the installed pack is not merely intact but is also the
 * only thing the engine can see. `promote` is two renames whose rollback the
 * storage module owns; this module's job there is to discard the staged copy
 * and tell the truth about where the previous one ended up.
 *
 * Everything platform-shaped is injected, in the shape `voice-pack-service.ts`
 * established with `applyRoots` / `applyManifest` / `onPacksChanged`: stopping
 * playback, publishing status, refreshing the scan, the catalog, the clock.
 * `deck-core` must not import the audio service, the settings singleton or a
 * deck adapter, and a module with no way to reach them cannot be wrong about
 * how to use them. Every injected callback is wrapped: a throwing progress
 * setter must cost one status update, never the install it was describing.
 *
 * Never throws and never rejects. Both callers end the plugin process on an
 * exception — module-scope startup (seed and sweep), and the settings window's
 * `sendToPlugin` frame, whose `ws.on("message")` listener has no try/catch. The
 * result is the only channel, and it is a discriminated union whose `reason`
 * is written for the person reading the Race Engineer card rather than the
 * log; the log gets the module's own `detail`.
 *
 * Opens no window, on any outcome. The install runs while iRacing is running —
 * deferring it would hand a driver who updates and immediately races a mute
 * engineer for exactly the session they would notice it in — so progress and
 * failure are passive: a run-scoped global the settings window and the warning
 * banner read, and nothing else. `voice-pack-no-window.test.ts` enforces this
 * structurally over every module of the feature, this one included.
 */
import type { ILogger } from "@iracedeck/logger";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

import type { PiWarningLevel } from "./pi-warnings.js";
import { extractVoicePackArchive, type VoicePackArchiveFileSystem } from "./voice-pack-archive.js";
import type { VoicePackCatalogGetOptions } from "./voice-pack-catalog-service.js";
import { isVoicePackOfferable, type VoicePackCatalogEntry } from "./voice-pack-catalog.js";
import { VOICE_PACK_PROVENANCE_FILE } from "./voice-pack-constants.js";
import { downloadVoicePack, type VoicePackDownloadFailure } from "./voice-pack-download.js";
import { packId, parseVoicePackManifest, type VoicePackManifest } from "./voice-pack-manifest.js";
import { parseVoicePackProvenance, type VoicePackProvenance } from "./voice-pack-provenance.js";
import type { VoicePackFileRead, VoicePackFileSystem } from "./voice-pack-scanner.js";
import type { VoicePackCatalogState, VoicePackInstallState, VoicePackStatus } from "./voice-pack-status.js";
import type {
  CreateVoicePackStagingResult,
  PromoteVoicePackResult,
  SweepVoicePacksResult,
  VoicePackStorage,
} from "./voice-pack-storage.js";

/**
 * The pack manifest's file name, as the archive carries it and the scanner
 * opens it. The scanner keeps a private copy of the same string; the shared
 * home for it would be `voice-pack-constants.ts`, which is not this change's
 * to edit — the two are one string and this comment is the link between them.
 */
export const VOICE_PACK_MANIFEST_FILE = "voice-pack.json";

/**
 * How often download progress reaches the status setter, at most.
 *
 * The downloader reports after EVERY chunk and deliberately does not throttle
 * (its comment says why: a throttle there would be a second clock disagreeing
 * with this one). Each publish here is a global-settings write — run-scoped, so
 * no disk write, but still a synchronous fan-out to every settings listener in
 * the plugin and a loopback push to every open Property Inspector — and a CDN
 * delivering 12.5 MB in 16 KB chunks would otherwise fire it eight hundred
 * times. Once a second is what a progress bar needs and is already the rate
 * the spec names for the banner.
 */
export const VOICE_PACK_PROGRESS_INTERVAL_MS = 1_000;

/**
 * Bundled-clip copies between turns of the event loop during a seed. The seed
 * runs at plugin start, which on a deck-host auto-update happens mid-session
 * with telemetry polled every 10 ms; fifteen hundred synchronous file writes
 * in one go would hold the loop for all of them. Same reasoning as the
 * extractor's `SLICES_PER_TURN`, applied to files rather than archive slices.
 */
const SEED_FILES_PER_TURN = 64;

/**
 * A clip the scenario engine can reach: `voice/<voice-id>/<group>/<name>.mp3`,
 * exactly that depth, lowercase extension. This is the scanner's own
 * `USABLE_CLIP` grammar, mirrored rather than imported because the scanner
 * does not export it. It has to be checked HERE, before the swap, and not left
 * to the scanner afterwards: the scanner would report a pack with no reachable
 * clip as a problem, correctly — but by then the pack it replaced would be in
 * the trash. A working voice must never be swapped for a mute one.
 */
const USABLE_CLIP = /^voice\/([^/]+)\/[^/]+\/[^/]+\.mp3$/;

export type VoicePackInstallOutcome =
  /** The pack was not installed before. */
  | "installed"
  /** A previous version was moved to the trash. */
  | "updated"
  /** The installed copy already matches the catalog's digest; nothing was downloaded. */
  | "unchanged";

/**
 * Where an install stopped.
 *
 * - `invalid-id` — not a pack id; refused before anything is looked up.
 * - `busy` — a removal of the same pack is in flight. (A second INSTALL of the
 *   same pack is not a failure — it joins the one in flight; see
 *   {@link VoicePackInstaller.install}.)
 * - `not-in-catalog` — the catalog has no entry for the id, or could not be
 *   read at all.
 * - `unsupported` — the entry needs a newer plugin than this one.
 * - `storage` — the working directories could not be prepared, or the
 *   archive could not be read back. The disk, not the network.
 * - `download` — the downloader failed for any reason but the digest.
 * - `verify` — every byte arrived and the digest is wrong, either in flight or
 *   when the archive was read back from disk. Never retried automatically.
 * - `extract` — the archive was refused: a hostile name, a cap, a damaged
 *   entry, or a write into the staging directory failed.
 * - `invalid-pack` — the archive unpacked but is not the pack that was asked
 *   for, or is not a usable pack at all.
 * - `promote` — the swap failed. The result's `reason` says where the previous
 *   pack is; the storage module guarantees it is intact.
 * - `internal` — something threw that was written not to. A bug, reported as
 *   a failed install rather than a dead plugin.
 */
export const VOICE_PACK_INSTALL_FAILURE_CODES = [
  "invalid-id",
  "busy",
  "not-in-catalog",
  "unsupported",
  "storage",
  "download",
  "verify",
  "extract",
  "invalid-pack",
  "promote",
  "internal",
] as const;

export type VoicePackInstallFailureCode = (typeof VOICE_PACK_INSTALL_FAILURE_CODES)[number];

export type VoicePackInstallResult =
  | { ok: true; outcome: VoicePackInstallOutcome }
  | {
      ok: false;
      code: VoicePackInstallFailureCode;
      /** For a human, path-free: what happened and what they can do. The same text goes to the status payload. */
      reason: string;
      /** For the log: the failing module's own account. */
      detail?: string;
    };

export type VoicePackRemoveResult =
  | { ok: true; /** `false` when nothing was installed under that id. */ removed: boolean }
  | { ok: false; code: "invalid-id" | "busy" | "storage"; reason: string };

export type VoicePackSeedResult =
  | { outcome: "skipped"; reason: "nothing-bundled" | "packs-present" }
  | { outcome: "attempted"; results: readonly { id: string; result: VoicePackInstallResult }[] };

/**
 * A pack the plugin ships inside its own distributable, to be seeded by copy.
 *
 * `entry` is the pack's CATALOG entry — the same document the website
 * publishes, compiled into the plugin build — and its `sha256` is what the
 * seed records as provenance. That is load-bearing: the seeded copy must
 * compare equal to the catalog on the very next check, or every user
 * downloads the pack they were just handed for free. It is a claim, not a
 * measurement — nothing here hashes the copied tree — and it holds because the
 * bundle and the entry are built from one source tree by one packer.
 *
 * `audioDir` is the plugin's own `assets/audio`, which holds `voice/<id>/…` for
 * every bundled voice and no `voice-pack.json`; the seed writes that manifest
 * itself from the entry.
 */
export interface BundledVoicePack {
  entry: VoicePackCatalogEntry;
  audioDir: string;
}

/**
 * The one disk operation no sibling port offers: reading a file's bytes.
 *
 * Needed twice. The extractor takes the whole archive as a `Uint8Array`, and
 * the downloader writes to disk — so the archive is read back, and hashed
 * again on the way, which is what makes "verifying" a phase with content
 * rather than a label. And the seed reads each bundled clip so it can write it
 * through the SAME port the extractor writes through, inheriting that port's
 * refusal of a pre-planted destination for free. The `node:fs` implementation
 * is {@link createVoicePackInstallerFileSystem}, the only disk access in this
 * module.
 */
export interface VoicePackInstallerFileSystem {
  /** The file's bytes, or `undefined` for anything unreadable. */
  readFile(file: string): Promise<Uint8Array | undefined>;
}

/**
 * What the installer needs from the catalog. `get()` is the state the UI
 * renders — `VoicePackCatalogService.get()` verbatim. `entry()` is the raw
 * entry behind an offer, because an offer carries no `url` and no `sha256`:
 * the catalog service exposes the former today and not the latter, so the
 * plugin supplies both halves and this module names what it needs rather
 * than what happens to exist.
 */
export interface VoicePackInstallerCatalog {
  get(options?: VoicePackCatalogGetOptions): Promise<VoicePackCatalogState>;
  entry(id: string): Promise<VoicePackCatalogEntry | undefined>;
}

/**
 * The `_warnings` banner, as this module needs it: post a record under an id,
 * retire it by that id. The plugin binds `setWarning` / `clearWarning`; the
 * shape is named here rather than imported for the reason every other port
 * is — this module must not reach the settings singleton those two live on.
 *
 * What it carries, and why it is a banner and not an `installs` record: the
 * outcome of a REMOVE. The Installed Voices list, where Remove lives, renders
 * `_voicePacks` and nothing else, and the catalog card renders an `installs`
 * record only on a row the catalog has — which, in the release that publishes
 * one pack and bundles it, is never a pack the user can press Remove on. A
 * removal failure recorded there would render nowhere. The banner is on the
 * same page, is the shape every surface already renders, and needs no new
 * key. One record per pack, so two packs failing to remove are two banners
 * that clear independently.
 */
export interface VoicePackInstallerWarnings {
  set(id: string, level: PiWarningLevel, message: string): void;
  clear(id: string): void;
}

export interface VoicePackInstallerDeps {
  storage: VoicePackStorage;
  /** The scanner's port: how `.install.json`, a staged manifest and the bundled clip tree are read. */
  packFs: VoicePackFileSystem;
  /** The extractor's port: how every staged file is written — `createVoicePackArchiveFileSystem`. */
  archiveFs: VoicePackArchiveFileSystem;
  fs: VoicePackInstallerFileSystem;
  catalog: VoicePackInstallerCatalog;
  /** Packs shipped inside this build, for {@link VoicePackInstaller.seed}. Absent or empty in a release that bundles nothing. */
  bundled?: readonly BundledVoicePack[];
  /** The running plugin version (`getPluginVersion()`), for `isVoicePackOfferable`. */
  getPluginVersion: () => string;
  /**
   * Stop voice playback. Called immediately before the swap, and only then:
   * a callout may hold one of the installed pack's clips open, and on Windows
   * a directory with an open file inside cannot be renamed. Never called for
   * a download that fails, so a bad network day costs nobody a callout.
   */
  stopPlayback: () => void | Promise<void>;
  /** Publish the `_voicePackStatus` payload — the plugin writes it as a run-scoped global. */
  publishStatus: (status: VoicePackStatus) => void;
  /** Where a Remove's outcome is shown — see {@link VoicePackInstallerWarnings}. */
  warnings: VoicePackInstallerWarnings;
  /** Re-scan the packs directory and reload the engine — `VoicePackService.refresh`. */
  refreshPacks: () => void;
  now?: () => number;
  /** Injected `fetch`, so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Cancels an in-flight download — the plugin stopping. */
  signal?: AbortSignal;
  logger: ILogger;
}

export interface VoicePackInstaller {
  /**
   * Install or update `id` from the catalog.
   *
   * A second call for the same id while one is in flight JOINS it — same
   * promise, same outcome, no second download. The alternative, refusing with
   * `busy`, would make a double-click on the Install button report an error
   * about the very install it started.
   */
  install(id: string): Promise<VoicePackInstallResult>;
  /**
   * The Remove command: retire `<root>/<id>` to the trash and refresh.
   *
   * A second call for the same id while a removal is in flight JOINS it, for
   * the reason a second install joins an install. Its outcome reaches the
   * user through the `_warnings` banner (see {@link VoicePackInstallerWarnings}):
   * a failure is posted under the pack's id, and is retired by the next
   * operation on that pack that succeeds — a removal or an install — or, for
   * a removal refused because an install was in flight, the moment that
   * install settles either way, since its statement is then no longer true.
   */
  remove(id: string): Promise<VoicePackRemoveResult>;
  /**
   * Plugin start: an empty packs directory plus a bundled pack means install
   * it by copying. A no-op when nothing is bundled or any pack is present.
   */
  seed(): Promise<VoicePackSeedResult>;
  /** Plugin start: empty `.tmp` and `.trash` of everything safe to delete. */
  sweep(): Promise<SweepVoicePacksResult>;
  /**
   * Re-ask the catalog and republish. Opening the window, and the Rescan
   * button — which passes `bypassTtl` so a press after a fixed connection is
   * a request, not a five-minute wait on the failure TTL.
   */
  refreshCatalog(options?: VoicePackCatalogGetOptions): Promise<VoicePackCatalogState>;
  /** The current payload. */
  status(): VoicePackStatus;
  /**
   * Publish the current payload again. `_voicePackStatus` is run-scoped, and
   * a run-scoped key owes a re-assertion on every Property Inspector
   * appearance — the same contract `_voicePacks` keeps.
   */
  republishStatus(): void;
}

type Staged = Extract<CreateVoicePackStagingResult, { ok: true }>;

type InstallFailure = Extract<VoicePackInstallResult, { ok: false }>;

type Busy = { kind: "install" | "remove" | "seed"; promise: Promise<unknown> };

/**
 * The digest recorded for the pack installed at `dir`, or `undefined` when
 * there is no usable record — a sideload, a hand-edited file, or a record that
 * names some OTHER pack (a folder copied from one id to another carries the
 * first pack's provenance, and treating that digest as this pack's would skip
 * an install the user asked for).
 *
 * Exported because the catalog service needs the same answer for its
 * `getInstalledSha` and the two must agree: the service's verdict is what
 * puts an Install or Update button on the card, and this is what decides
 * whether pressing it downloads anything. One implementation, handed to both.
 */
export function readInstalledVoicePackSha(fs: VoicePackFileSystem, dir: string, id: string): string | undefined {
  const read = fs.readTextFile(join(dir, VOICE_PACK_PROVENANCE_FILE));

  if (!read.ok) return undefined;

  const record = parseVoicePackProvenance(read.text);

  return record?.id === id ? record.sha256 : undefined;
}

export type ValidateStagedVoicePackResult = { ok: true; manifest: VoicePackManifest } | { ok: false; reason: string };

/**
 * Is what landed in the staging directory the pack that was asked for?
 *
 * Three questions, in the order a reader can act on them: is there a manifest
 * and does it parse; is it THIS pack — an archive whose manifest disagrees with
 * the catalog entry that offered it is refused, whatever else it contains,
 * because the id is where it will be installed and what the user will select;
 * and can the engine reach at least one clip of a declared voice. `written` is
 * the extractor's own account of what it wrote (or the seed's), so the last
 * check costs no directory walk and cannot be answered by a file that arrived
 * some other way.
 *
 * @internal Exported for testing
 */
export function validateStagedVoicePack(
  id: string,
  manifest: VoicePackFileRead,
  written: readonly string[],
): ValidateStagedVoicePackResult {
  if (!manifest.ok) {
    return {
      ok: false,
      reason: manifest.missing
        ? `it has no ${VOICE_PACK_MANIFEST_FILE}`
        : `its ${VOICE_PACK_MANIFEST_FILE} could not be read (${manifest.reason})`,
    };
  }

  const parsed = parseVoicePackManifest(manifest.text);

  if (!parsed.ok) return { ok: false, reason: `its ${VOICE_PACK_MANIFEST_FILE} is invalid — ${parsed.reason}` };

  if (parsed.manifest.id !== id) {
    return { ok: false, reason: `it is the pack "${parsed.manifest.id}", not "${id}"` };
  }

  const reachable = new Set<string>();

  for (const path of written) {
    const voice = USABLE_CLIP.exec(path)?.[1];

    if (voice !== undefined) reachable.add(voice);
  }

  if (!parsed.manifest.voices.some((voice) => reachable.has(voice.id))) {
    return { ok: false, reason: "it has no playable clips under voice/<voice-id>/ for any voice it declares" };
  }

  return { ok: true, manifest: parsed.manifest };
}

/**
 * The manifest the seed writes for a bundled pack, from its catalog entry.
 * Sorted keys and a trailing newline, like every JSON artifact this repo
 * writes. Only the manifest's own fields: the entry's `url`, `bytes` and
 * `description` describe the ARCHIVE, and this directory was not extracted
 * from one.
 */
function seedManifestText(entry: VoicePackCatalogEntry): string {
  const manifest: VoicePackManifest = {
    schema: 1,
    id: entry.id,
    label: entry.label,
    version: entry.version,
    voices: entry.voices.map((voice) => ({ id: voice.id, label: voice.label })),
  };
  const ordered = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));

  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Words for a downloader failure. The downloader's `reason` says what happened
 * to the connection; these say what the user can do about it, and never name a
 * host, a path or a number of bytes.
 */
function describeDownloadFailure(failure: VoicePackDownloadFailure): string {
  switch (failure) {
    case "http":
      return "The download server refused the request. Try again later.";
    case "transport":
      return "The download failed — check your internet connection and try again.";
    case "timeout":
      return "The download stalled — check your internet connection and try again.";
    case "too-large":
      return "The download was larger than the catalog says this pack is, so it was discarded. Try again later.";
    case "sink":
      return "The archive could not be saved. Check free disk space and try again.";
    case "hash-mismatch":
      return "The downloaded archive does not match the catalog, so it was discarded. Try again later.";
    case "aborted":
      return "The download was cancelled.";
    case "invalid-request":
      return "The catalog entry for this pack is invalid.";
    case "insecure-redirect":
      return "The download server redirected to an insecure address, so the download was refused. Try again later.";
  }
}

/**
 * Words for a failed swap, decided by where the PREVIOUS pack is now — the one
 * fact the user needs, and the one the storage result is precise about.
 */
function describePromoteFailure(result: Extract<PromoteVoicePackResult, { ok: false }>): string {
  if (result.previous === "none") return "The pack could not be moved into place, so nothing was installed. Try again.";

  if (typeof result.previous === "object") {
    return (
      "The new version could not be moved into place, and the previous version could not be put back. " +
      "It is kept, intact, in the .trash folder inside the voice packs folder and will not be deleted; " +
      "install the pack again to replace it."
    );
  }

  return (
    "The new version could not be moved into place. The currently installed version was left unchanged; " +
    "close anything that may be using its files and try again."
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * Compose the install pipeline over injected ports.
 */
export function createVoicePackInstaller(deps: VoicePackInstallerDeps): VoicePackInstaller {
  const { storage, packFs, archiveFs, fs, catalog, logger, now = () => Date.now() } = deps;

  const installs: Record<string, VoicePackInstallState> = {};
  let catalogState: VoicePackCatalogState = { state: "unknown" };
  const progressPublishedAt = new Map<string, number>();
  const busy = new Map<string, Busy>();
  /**
   * Packs whose removal banner says "being installed". That is a statement
   * about an install in flight, so it is retired the moment that install
   * settles — whichever way — rather than waiting for a success that a failed
   * install would never deliver.
   */
  const removalRefusedForInstall = new Set<string>();

  const removalWarningId = (id: string): string => `voice-pack-remove:${id}`;

  /** Post a Remove's failure where the user can see it. Wrapped like every other injected callback. */
  function reportRemovalFailure(id: string, level: PiWarningLevel, reason: string): void {
    try {
      deps.warnings.set(removalWarningId(id), level, `Voice pack "${id}" was not removed. ${reason}`);
    } catch (err) {
      logger.warn("Voice packs: posting the removal banner threw; continuing");
      logger.debug(errorText(err));
    }
  }

  function clearRemovalFailure(id: string): void {
    removalRefusedForInstall.delete(id);

    try {
      deps.warnings.clear(removalWarningId(id));
    } catch (err) {
      logger.warn("Voice packs: clearing the removal banner threw; continuing");
      logger.debug(errorText(err));
    }
  }

  /**
   * Run an injected callback, and report rather than propagate whatever it
   * throws. Every callback here is somebody else's code — the audio service,
   * the settings singleton, the scan — and a bug in any of them must read as a
   * warning in the log, never as a rejected install or a dead plugin.
   */
  async function guarded<T>(what: string, run: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (err) {
      logger.warn(`Voice packs: ${what} threw; continuing`);
      logger.debug(errorText(err));

      return undefined;
    }
  }

  function status(): VoicePackStatus {
    return { catalog: catalogState, installs: { ...installs } };
  }

  function publish(): void {
    try {
      deps.publishStatus(status());
    } catch (err) {
      logger.warn("Voice packs: publishing status threw; continuing");
      logger.debug(errorText(err));
    }
  }

  /** A phase change publishes at once and restarts the progress clock. */
  function setPhase(id: string, state: VoicePackInstallState): void {
    installs[id] = state;
    progressPublishedAt.delete(id);
    publish();
  }

  function clearInstall(id: string): void {
    delete installs[id];
    progressPublishedAt.delete(id);
  }

  /**
   * Leading-edge only, on purpose. A trailing publish would need a timer, and
   * what it would buy is a fresher count during a gap in which no bytes
   * arrived — a gap in which the count did not change, so the stale one is
   * the truth. The final byte count is published by the phase change that
   * follows the last chunk, which is where a trailing edge would have landed
   * anyway.
   */
  function onProgress(id: string, totalBytes: number): (progress: { receivedBytes: number }) => void {
    return ({ receivedBytes }) => {
      installs[id] = { phase: "downloading", receivedBytes, totalBytes };
      const at = now();
      const last = progressPublishedAt.get(id);

      if (last !== undefined && at - last < VOICE_PACK_PROGRESS_INTERVAL_MS) return;

      progressPublishedAt.set(id, at);
      publish();
    };
  }

  function failed(id: string, code: VoicePackInstallFailureCode, reason: string, detail?: string): InstallFailure {
    logger.warn("Voice pack install failed");
    logger.debug(`Voice pack "${id}": ${code}: ${reason}${detail === undefined ? "" : ` (${detail})`}`);
    setPhase(id, { phase: "failed", error: reason });

    return { ok: false, code, reason, ...(detail === undefined ? {} : { detail }) };
  }

  async function refreshCatalogState(options?: VoicePackCatalogGetOptions): Promise<VoicePackCatalogState> {
    catalogState = (await guarded("the catalog check", () => catalog.get(options))) ?? { state: "unknown" };

    return catalogState;
  }

  /**
   * One operation per pack id at a time. An install joins an install; anything
   * else waits for nothing and is refused as `busy`, because a removal landing
   * in the middle of an install would be undone by the install's own swap a
   * moment later, and the user would see their Remove silently reversed.
   */
  function occupy<T>(id: string, kind: Busy["kind"], run: () => Promise<T>): Promise<T> {
    const promise = run().finally(() => {
      if (busy.get(id)?.promise === promise) busy.delete(id);

      // A Remove refused while THIS install was in flight said so in a
      // banner; the install has now settled, so the banner has nothing left
      // to describe.
      if (kind !== "remove" && removalRefusedForInstall.has(id)) clearRemovalFailure(id);
    });
    busy.set(id, { kind, promise });

    return promise;
  }

  function installedSha(id: string): string | undefined {
    return readInstalledVoicePackSha(packFs, storage.packDir(id), id);
  }

  /**
   * Download, verify, extract and validate into a staging directory. Every
   * failure discards what it made — the archive, the staging tree — and the
   * installed pack has not been looked at.
   */
  async function stageFromCatalog(id: string, entry: VoicePackCatalogEntry): Promise<Staged | InstallFailure> {
    const opened = await storage.openDownload(id, entry.sha256);

    if (!opened.ok) {
      return failed(
        id,
        "storage",
        "The download folder could not be prepared. Check that the voice packs folder is writable and try again.",
        `openDownload: ${opened.code}`,
      );
    }

    const downloaded = await downloadVoicePack({
      url: entry.url,
      expectedSha256: entry.sha256,
      maxBytes: entry.bytes,
      sink: opened.sink,
      onProgress: onProgress(id, entry.bytes),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    });
    const closed = await opened.close();

    if (!downloaded.ok) {
      await opened.discard();

      return failed(
        id,
        downloaded.failure === "hash-mismatch" ? "verify" : "download",
        describeDownloadFailure(downloaded.failure),
        `${downloaded.failure}: ${downloaded.reason}`,
      );
    }

    if (!closed.ok) {
      await opened.discard();

      return failed(
        id,
        "storage",
        "The archive could not be saved. Check free disk space and try again.",
        `close: ${closed.code}`,
      );
    }

    // The downloader hashed the bytes it handed to the sink. What is extracted
    // is what the DISK hands back, and the two are the same only if the write
    // was faithful and nothing rewrote the file in between — a scanner
    // "cleaning" it, another plugin's overlapping download of the same name.
    // Hashing the read-back is the cheap way to know, and it is what makes the
    // verifying phase a verification.
    //
    // BUT NOTE WHAT THIS COSTS, because the module one layer down promises the
    // opposite. `voice-pack-download.ts` hashes as the stream flows and says so
    // in its own comment: buffering the whole archive to hash it afterwards
    // would hold it in memory inside a process that is also rendering keys and
    // playing audio during a race. This line then reads the entire file into
    // one buffer and hands that buffer to the extractor, so peak memory during
    // an install IS the whole archive plus the extractor's per-entry buffers —
    // bounded by `VOICE_PACK_DOWNLOAD_CEILING_BYTES` (128 MB), not by streaming.
    //
    // Harmless at today's ~8 MB pack, which is exactly why it needs writing
    // down rather than leaving for a reader to infer from the layer below: a
    // multi-voice pack approaches that ceiling with no code change and no new
    // review. The fix — hash incrementally over a read stream and give the
    // extractor a streaming source — is issue #1102.
    setPhase(id, { phase: "verifying", totalBytes: entry.bytes });
    const archive = await fs.readFile(opened.path);

    if (archive === undefined) {
      await opened.discard();

      return failed(id, "storage", "The downloaded archive could not be read back. Try again.", "readFile failed");
    }

    const onDisk = createHash("sha256").update(archive).digest("hex");

    if (onDisk !== entry.sha256) {
      await opened.discard();

      return failed(
        id,
        "verify",
        "The archive changed on disk after it was downloaded, so it was discarded. Try again.",
        `read-back digest ${onDisk.slice(0, 12)}… != ${entry.sha256.slice(0, 12)}…`,
      );
    }

    const staging = await storage.createStagingDir(id, entry.sha256);

    if (!staging.ok) {
      await opened.discard();

      return failed(
        id,
        "storage",
        "The unpacking folder could not be prepared. Check that the voice packs folder is writable and try again.",
        `createStagingDir: ${staging.code}`,
      );
    }

    setPhase(id, { phase: "extracting", totalBytes: entry.bytes });
    const extracted = await extractVoicePackArchive({ archive, targetDir: staging.dir, fs: archiveFs });

    // The archive has served its purpose either way; a leftover is the
    // sweep's problem, not a failure.
    await opened.discard();

    if (!extracted.ok) {
      await staging.discard();

      return failed(
        id,
        "extract",
        `The archive could not be unpacked: ${extracted.reason}. The installed voice is unchanged.`,
        `${extracted.code} after ${extracted.written.length} files`,
      );
    }

    return finishStaging(id, staging, extracted.written, {
      schema: 1,
      source: "catalog",
      id,
      version: entry.version,
      sha256: entry.sha256,
      url: entry.url,
      installedAt: new Date(now()).toISOString(),
    });
  }

  /**
   * Copy a bundled pack's clips into a staging directory, through the same
   * write port the extractor uses, and give it the manifest the bundle does
   * not carry.
   */
  async function stageFromBundle(pack: BundledVoicePack): Promise<Staged | InstallFailure> {
    const { entry, audioDir } = pack;
    const id = entry.id;
    const staging = await storage.createStagingDir(id, entry.sha256);

    if (!staging.ok) {
      return failed(
        id,
        "storage",
        "The unpacking folder could not be prepared. Check that the voice packs folder is writable and try again.",
        `createStagingDir: ${staging.code}`,
      );
    }

    const discardAndFail = async (
      code: VoicePackInstallFailureCode,
      reason: string,
      detail: string,
    ): Promise<InstallFailure> => {
      await staging.discard();

      return failed(id, code, reason, detail);
    };

    const manifest = archiveFs.writeFile(
      join(staging.dir, VOICE_PACK_MANIFEST_FILE),
      new TextEncoder().encode(seedManifestText(entry)),
    );

    if (!manifest.ok) {
      return discardAndFail(
        "storage",
        "The bundled voice could not be copied. Check free disk space and try again.",
        `write manifest: ${manifest.reason}`,
      );
    }

    const written: string[] = [VOICE_PACK_MANIFEST_FILE];
    const prefixes = entry.voices.map((voice) => `voice/${voice.id}/`);
    const clips = packFs.listMp3Files(audioDir).filter((clip) => prefixes.some((prefix) => clip.startsWith(prefix)));

    if (clips.length === 0) {
      // Not a disk problem: the build shipped an entry for a voice whose clips
      // it did not include. Nothing to retry.
      return discardAndFail("invalid-pack", "The bundled voice has no clips to copy.", `no clips under ${audioDir}`);
    }

    for (const [index, clip] of clips.entries()) {
      const segments = clip.split("/");
      const bytes = await fs.readFile(join(audioDir, ...segments));

      if (bytes === undefined) {
        return discardAndFail(
          "storage",
          "A bundled clip could not be read. Reinstall the plugin and try again.",
          `read ${clip} failed`,
        );
      }

      const destination = join(staging.dir, ...segments);
      const made = archiveFs.ensureDirectory(dirname(destination));

      if (!made.ok) {
        return discardAndFail(
          "storage",
          "The bundled voice could not be copied. Check free disk space and try again.",
          `mkdir for ${clip}: ${made.reason}`,
        );
      }

      const wrote = archiveFs.writeFile(destination, bytes);

      if (!wrote.ok) {
        return discardAndFail(
          "storage",
          "The bundled voice could not be copied. Check free disk space and try again.",
          `write ${clip}: ${wrote.reason}`,
        );
      }

      written.push(clip);

      if ((index + 1) % SEED_FILES_PER_TURN === 0) await nextTurn();
    }

    return finishStaging(id, staging, written, {
      schema: 1,
      source: "bundled-seed",
      id,
      version: entry.version,
      sha256: entry.sha256,
      installedAt: new Date(now()).toISOString(),
    });
  }

  /**
   * The two staging paths converge here: validate what landed, then record
   * where it came from — into the STAGED directory, before the swap, so the
   * record is inside the pack the instant the pack exists (the storage module
   * says why that ordering, and not the spec's, is the safe one).
   */
  async function finishStaging(
    id: string,
    staging: Staged,
    written: readonly string[],
    provenance: VoicePackProvenance,
  ): Promise<Staged | InstallFailure> {
    const validated = validateStagedVoicePack(
      id,
      packFs.readTextFile(join(staging.dir, VOICE_PACK_MANIFEST_FILE)),
      written,
    );

    if (!validated.ok) {
      await staging.discard();

      return failed(
        id,
        "invalid-pack",
        `This is not a usable voice pack: ${validated.reason}. The installed voice is unchanged.`,
      );
    }

    const recorded = await storage.writeProvenance(staging.dir, provenance);

    if (!recorded.ok) {
      await staging.discard();

      return failed(
        id,
        "storage",
        "The pack's install record could not be written. Check free disk space and try again.",
        `writeProvenance: ${recorded.code}`,
      );
    }

    return staging;
  }

  /**
   * The swap, and everything that follows it.
   *
   * `stopFirst` is false for the seed: it runs only into an empty packs
   * directory, so there is no previous pack whose clip could be held open, and
   * cutting a callout at plugin start for a rename that cannot contend with
   * anything would be a cost with nothing bought.
   */
  async function promoteStaged(id: string, staging: Staged, stopFirst: boolean): Promise<VoicePackInstallResult> {
    setPhase(id, { phase: "swapping" });

    if (stopFirst) await guarded("stopping playback", deps.stopPlayback);

    const promoted = await storage.promote(id, staging.dir);

    if (!promoted.ok) {
      await staging.discard();

      // Only the one outcome that MOVED the installed pack needs a rescan: the
      // engine is still advertising clips under `<root>/<id>`, and that path
      // is now empty. In every other failure the pack is where it was.
      if (typeof promoted.previous === "object") await guarded("the pack refresh", deps.refreshPacks);

      return failed(id, "promote", describePromoteFailure(promoted), `${promoted.step}: ${promoted.code}`);
    }

    await guarded("the pack refresh", deps.refreshPacks);
    clearInstall(id);
    // A removal that failed on the previous copy is moot: that copy is in the
    // trash now, moved by the very rename the removal could not make.
    clearRemovalFailure(id);
    // The verdicts changed — this pack's offer is now `installed` — and the
    // card must not go on showing an Install button for a pack that is.
    await refreshCatalogState();
    publish();
    logger.info("Voice pack installed");
    logger.debug(`Voice pack "${id}": ${promoted.trashedAt === undefined ? "first install" : "updated"}`);

    return { ok: true, outcome: promoted.trashedAt === undefined ? "installed" : "updated" };
  }

  async function runInstall(id: string): Promise<VoicePackInstallResult> {
    const entry = await guarded("the catalog entry lookup", () => catalog.entry(id));

    if (entry === undefined) {
      return failed(id, "not-in-catalog", "This pack is not in the voice catalog. Refresh the catalog and try again.");
    }

    const pluginVersion = (await guarded("the plugin version lookup", deps.getPluginVersion)) ?? "";

    if (!isVoicePackOfferable(entry, pluginVersion)) {
      return failed(
        id,
        "unsupported",
        entry.minPluginVersion === undefined
          ? "This pack cannot be installed on this iRaceDeck build."
          : `This pack needs iRaceDeck ${entry.minPluginVersion} or newer.`,
        `plugin ${pluginVersion || "(unknown)"}, pack needs ${entry.minPluginVersion ?? "(any)"}`,
      );
    }

    if (installedSha(id) === entry.sha256) {
      clearInstall(id);
      publish();
      logger.info("Voice pack already up to date");
      logger.debug(`Voice pack "${id}": installed digest matches the catalog; nothing to download`);

      return { ok: true, outcome: "unchanged" };
    }

    logger.info("Voice pack install started");
    logger.debug(`Voice pack "${id}" ${entry.version}: ${entry.bytes} bytes from ${entry.url}`);
    // Published BEFORE the lock, so a plugin waiting on another ecosystem's
    // install of the same pack shows the download it is waiting for rather
    // than nothing. There is no "waiting" phase, and adding one would be a
    // change to the status shape for a state that resolves itself.
    setPhase(id, { phase: "downloading", receivedBytes: 0, totalBytes: entry.bytes });

    const lock = await storage.acquireLock(id);

    try {
      // The lock may have been held by another plugin installing exactly this
      // pack, in which case the work is done and the digest now matches.
      if (lock.acquired && installedSha(id) === entry.sha256) {
        clearInstall(id);
        publish();
        logger.info("Voice pack was installed by another plugin");

        return { ok: true, outcome: "unchanged" };
      }

      const staged = await stageFromCatalog(id, entry);

      if (!staged.ok) return staged;

      return await promoteStaged(id, staged, true);
    } finally {
      await lock.release();
    }
  }

  async function runSeed(pack: BundledVoicePack): Promise<VoicePackInstallResult> {
    const id = pack.entry.id;
    logger.info("Seeding a bundled voice pack");
    logger.debug(`Voice pack "${id}" ${pack.entry.version}: copying from ${pack.audioDir}`);

    // The same lock the install path holds, over the same id — and the seed
    // needs it MORE. The packs root is shared by all three ecosystems and the
    // staging path is a function of (id, sha256), so two plugins seeding the
    // same bundled pack — both started at login, both finding the folder
    // empty — copy into ONE directory. Each one's `createStagingDir` empties
    // it, and each one's startup sweep deletes it, because the sweep spares a
    // `.tmp` entry only under a live lock. None of that errors: the copy
    // recreates its parents and carries on, and the validation that follows
    // checks the list of files THIS process wrote, not the disk — so the loser
    // promotes a pack silently short of every clip the winner deleted. Held,
    // the lock makes the other plugin's sweep keep the tree and its seed wait,
    // and the re-check below then finds the pack in place.
    //
    // Correctness still does not depend on the lock being granted — the
    // storage module says why, and its promise there is narrower than it
    // reads: it covers the SWAP, where the second arrival finds identical
    // content, and says nothing about two processes sharing a staging
    // directory, which is exactly the gap this lock closes in the common
    // case. `acquired: false` is proceeded past, as everywhere.
    const lock = await storage.acquireLock(id);

    try {
      // The lock may have been held by the other plugin's seed of exactly
      // this pack, in which case the work is done and the digest now matches.
      if (installedSha(id) === pack.entry.sha256) {
        clearInstall(id);
        publish();
        logger.info("Voice pack was seeded by another plugin");

        return { ok: true, outcome: "unchanged" };
      }

      const staged = await stageFromBundle(pack);

      if (!staged.ok) return staged;

      return await promoteStaged(id, staged, false);
    } finally {
      await lock.release();
    }
  }

  /** The promise the signature makes, kept at the one place a throw could escape. */
  function neverThrows(id: string, run: () => Promise<VoicePackInstallResult>): Promise<VoicePackInstallResult> {
    return run().catch((err: unknown) => {
      logger.error(`Voice pack "${id}" install failed unexpectedly: ${errorText(err)}`);

      return failed(id, "internal", "Something went wrong inside iRaceDeck. The installed voice is unchanged.");
    });
  }

  return {
    async install(id) {
      if (!packId.safeParse(id).success) {
        // Unreachable from the page — the command handler validates ids
        // before routing — so this is a programming error, and it is logged
        // as one rather than published: a record keyed by something that is
        // not an id would render on no row and be cleared by nothing.
        logger.warn("Voice pack install refused: not a pack id");
        logger.debug(`Voice pack install refused for ${JSON.stringify(id)}`);

        return { ok: false, code: "invalid-id", reason: "That is not a voice pack id." };
      }

      const current = busy.get(id);

      // A seed is an install by another route, and its result is an install
      // result; joining it is as right as joining an install.
      if (current !== undefined && current.kind !== "remove") return current.promise as Promise<VoicePackInstallResult>;

      if (current !== undefined) {
        // Published on the row the button was pressed on, as the failed
        // install it is, so a press that does nothing is not a mystery. The
        // removal's own success clears it, and Retry after that is exactly
        // the install that was wanted.
        return failed(id, "busy", "This pack is being removed. Wait a moment and try again.");
      }

      return occupy(id, "install", () => neverThrows(id, () => runInstall(id)));
    },

    async remove(id) {
      if (!packId.safeParse(id).success) {
        // Same as the install path: unreachable from the page, logged as the
        // programming error it is, and put in front of no user — an id that
        // is not one cannot be named in a banner either.
        logger.warn("Voice pack removal refused: not a pack id");
        logger.debug(`Voice pack removal refused for ${JSON.stringify(id)}`);

        return { ok: false, code: "invalid-id", reason: "That is not a voice pack id." };
      }

      const current = busy.get(id);

      // A second Remove of the same pack joins the one in flight, for the
      // reason a second Install joins an install: a double-click must not
      // report an error about the very removal it started — and it must not
      // report it as an INSTALL, which is what a plain "busy" check did.
      if (current?.kind === "remove") return current.promise as Promise<VoicePackRemoveResult>;

      if (current !== undefined) {
        const reason = "This pack is being installed. Wait for it to finish and try again.";

        // `info`, not `warning`: nothing is wrong, and the banner retires
        // itself when that install settles (see `occupy`).
        removalRefusedForInstall.add(id);
        reportRemovalFailure(id, "info", reason);
        logger.warn("Voice pack removal refused: an install of the same pack is in flight");

        return { ok: false, code: "busy", reason };
      }

      return occupy(id, "remove", async (): Promise<VoicePackRemoveResult> => {
        try {
          // Same reason as before a swap: a callout holding one of the pack's
          // clips open would make the rename fail on Windows.
          await guarded("stopping playback", deps.stopPlayback);

          const retired = await storage.retire(id);

          if (!retired.ok) {
            const reason =
              "The pack could not be moved to the trash. Close anything that may be using its files and try again.";

            logger.warn("Voice pack removal failed");
            logger.debug(`Voice pack "${id}": retire: ${retired.code}`);
            reportRemovalFailure(id, "warning", reason);

            return { ok: false, code: "storage", reason };
          }

          await guarded("the pack refresh", deps.refreshPacks);
          // A failure recorded for this pack is about a pack that no longer
          // exists; and the verdict flips back to `install`. The same goes
          // for a banner about an earlier removal of it.
          clearInstall(id);
          clearRemovalFailure(id);
          await refreshCatalogState();
          publish();

          return { ok: true, removed: retired.trashedAt !== undefined };
        } catch (err) {
          const reason = "Something went wrong inside iRaceDeck. Nothing was removed.";

          logger.error(`Voice pack "${id}" removal failed unexpectedly: ${errorText(err)}`);
          reportRemovalFailure(id, "warning", reason);

          return { ok: false, code: "storage", reason };
        }
      });
    },

    async seed() {
      try {
        const bundled = deps.bundled ?? [];

        if (bundled.length === 0) return { outcome: "skipped", reason: "nothing-bundled" };

        // "Empty" means no pack directory at all; the installer's own `.tmp`
        // and `.trash` do not count. The rule is the spec's, and it is
        // deliberately not "the bundled pack is absent": a user who removed
        // the seeded copy and kept another pack has made a choice, and a start
        // that re-seeded over it would be the plugin arguing with them.
        const present = packFs.listDirectories(storage.root).filter((name) => !name.startsWith("."));

        if (present.length > 0) return { outcome: "skipped", reason: "packs-present" };

        const results: { id: string; result: VoicePackInstallResult }[] = [];

        for (const pack of bundled) {
          const id = pack.entry.id;

          if (busy.has(id)) {
            results.push({ id, result: { ok: false, code: "busy", reason: "This pack is already being installed." } });
            continue;
          }

          results.push({ id, result: await occupy(id, "seed", () => neverThrows(id, () => runSeed(pack))) });
        }

        return { outcome: "attempted", results };
      } catch (err) {
        logger.error(`Voice pack seed failed unexpectedly: ${errorText(err)}`);

        return { outcome: "attempted", results: [] };
      }
    },

    async sweep() {
      try {
        return await storage.sweep();
      } catch (err) {
        logger.error(`Voice pack sweep failed unexpectedly: ${errorText(err)}`);

        return { removed: 0, failed: 0, kept: 0 };
      }
    },

    async refreshCatalog(options) {
      const state = await refreshCatalogState(options);
      publish();

      return state;
    },

    status,

    republishStatus: publish,
  };
}

/**
 * `node:fs/promises` implementation of {@link VoicePackInstallerFileSystem} —
 * the only disk access in this module. Swallows its own error and answers
 * `undefined`, like every other `voice-pack-*` adapter: the full message with
 * its path goes to the log at debug, and the caller reports a path-free
 * failure of its own.
 */
export function createVoicePackInstallerFileSystem(logger: ILogger): VoicePackInstallerFileSystem {
  return {
    async readFile(file) {
      try {
        return await readFile(file);
      } catch (err) {
        logger.debug(`Voice packs: cannot read "${file}": ${err instanceof Error ? err.message : String(err)}`);

        return undefined;
      }
    },
  };
}
