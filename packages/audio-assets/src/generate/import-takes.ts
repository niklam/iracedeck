import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { type Entry, entryHash, type VoiceConfig } from "./config.ts";
import { clipRelPath, type Manifest } from "./manifest.ts";
import { invalidateProcessedCache, type RunLog, textPreview } from "./run.ts";

/**
 * One take in an out-of-band trial's record: `key` is the clip's path
 * without `.mp3` (`voice/<voice>/<group>/<name>`), `requestId` the
 * ElevenLabs request id the take was cut under. Other fields a trial script
 * writes (`inTrialRefs`, `crossModelRefs`, `seed`, …) are kept but not read,
 * except `text`, which must match the entry's config text when present.
 */
export const TrialRecordSchema = z.looseObject({
  key: z.string().min(1),
  status: z.enum(["ok", "error"]),
  requestId: z.string().nullable().optional(),
  text: z.string().optional(),
});

/** `trial-manifest.json`, the shape #1572's trial script writes: one model for every record. */
export const TrialManifestSchema = z.looseObject({
  model: z.string().min(1),
  records: z.array(TrialRecordSchema),
});

export type TrialManifest = z.infer<typeof TrialManifestSchema>;

export const TRIAL_MANIFEST_FILE = "trial-manifest.json";

/**
 * Take `--import <dir>` (or `--import=<dir>`) out of the CLI arguments.
 * Throws on a missing or flag-like value and on a second `--import`.
 */
export function parseImportArg(argv: readonly string[]): { importDir: string | null; rest: string[] } {
  let importDir: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;

    if (arg === "--import") {
      value = argv[++i];
    } else if (arg.startsWith("--import=")) {
      value = arg.slice("--import=".length);
    } else {
      rest.push(arg);
      continue;
    }

    if (value === undefined || value.length === 0 || value.startsWith("-")) {
      throw new Error(`--import: expected a directory (got ${value === undefined ? "nothing" : `"${value}"`})`);
    }

    if (importDir !== null) throw new Error("--import: give one directory");

    importDir = value;
  }

  return { importDir, rest };
}

export interface ImportOptions {
  /** The trial's root: `trial-manifest.json` plus `voice/<voice>/<group>/<name>.mp3`. */
  dir: string;
  voiceConfigs: Map<string, VoiceConfig>;
  /** `generate.manifest.json`, mutated in place unless a dry run or a refusal. */
  manifest: Manifest;
  /** The package root the clips are imported into (`<root>/voice/…`). */
  root: string;
  dryRun: boolean;
  /** Called once, after every take is in place. */
  persistManifest: (manifest: Manifest) => void;
  now?: () => Date;
  log?: RunLog;
}

export interface ImportResult {
  /** Takes imported (or that would be, in a dry run). */
  imported: number;
  /** Records whose status is not `ok`. */
  skipped: number;
  /** Every reason the import was refused or stopped; empty on success. */
  problems: string[];
}

const KEY = /^voice\/([^/]+)\/([^/]+)\/([^/]+)$/;

type PlannedTake = {
  source: string;
  relPath: string;
  voice: VoiceConfig;
  entry: Entry;
  requestId: string;
};

const consoleLog: RunLog = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

/**
 * `generate --import <dir>` (#1643): bring takes cut outside the generator —
 * an out-of-band trial's approved takes — into the voice tree, frozen. Each
 * `ok` record's file is copied byte for byte to
 * `voice/<voice>/<group>/<name>.mp3` and given a manifest row whose hash is
 * the entry's CURRENT `entryHash` and whose request id is the trial's, so the
 * next run sees it as a cache hit and nothing re-cuts it: on `eleven_v4` a
 * re-cut would be a different take, never the approved one.
 *
 * Every record is validated before anything is written, and any problem
 * refuses the whole import, naming every problem: an unknown voice, group or
 * entry; a missing file or request id; a trial model that is not the entry's
 * resolved `model_id` (the row's hash would then describe a request the take
 * was not cut with); text that is not the entry's config text; one key
 * imported twice. Records whose status is not `ok` are skipped, said so.
 */
export function importTakes(options: ImportOptions): ImportResult {
  const { dir, voiceConfigs, manifest, root, dryRun, persistManifest } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? consoleLog;
  const refuse = (problems: string[]): ImportResult => {
    for (const problem of problems) log.error(`[import] REFUSED: ${problem}`);

    log.error(`[import] Nothing was imported: ${problems.length} problem(s) in ${dir}.`);

    return { imported: 0, skipped: 0, problems };
  };

  const trialPath = path.join(dir, TRIAL_MANIFEST_FILE);

  if (!existsSync(trialPath)) return refuse([`${trialPath} does not exist`]);

  let trial: TrialManifest;

  try {
    const parsed = TrialManifestSchema.safeParse(JSON.parse(readFileSync(trialPath, "utf-8")));

    if (!parsed.success) {
      return refuse(
        parsed.error.issues.map((issue) => `${TRIAL_MANIFEST_FILE} ${z.core.toDotPath(issue.path)}: ${issue.message}`),
      );
    }

    trial = parsed.data;
  } catch (err) {
    return refuse([`${TRIAL_MANIFEST_FILE} is not JSON: ${err instanceof Error ? err.message : String(err)}`]);
  }

  const problems: string[] = [];
  const planned: PlannedTake[] = [];
  const skippedKeys: string[] = [];
  const seen = new Set<string>();

  for (const record of trial.records) {
    if (record.status !== "ok") {
      skippedKeys.push(`${record.key} (status ${record.status})`);
      continue;
    }

    const match = KEY.exec(record.key);

    if (!match) {
      problems.push(`${record.key}: not a voice/<voice>/<group>/<name> key`);
      continue;
    }

    const [, voiceName, groupName, entryName] = match as unknown as [string, string, string, string];

    if (seen.has(record.key)) {
      problems.push(`${record.key}: imported twice`);
      continue;
    }

    seen.add(record.key);

    const voice = voiceConfigs.get(voiceName);
    const entry = voice?.groups[groupName]?.find((candidate) => candidate.name === entryName);

    if (!voice || !entry) {
      const missing = !voice ? `voice "${voiceName}"` : !voice.groups[groupName] ? `group "${groupName}"` : "entry";

      problems.push(`${record.key}: unknown entry (no ${missing} in configs/)`);
      continue;
    }

    const source = path.join(dir, `${record.key}.mp3`);

    if (!existsSync(source) || !statSync(source).isFile()) problems.push(`${record.key}: ${source} does not exist`);

    if (!record.requestId) problems.push(`${record.key}: the record has no requestId`);

    const model = entry.model_id ?? voice.model_id;

    if (trial.model !== model) {
      problems.push(`${record.key}: cut with model "${trial.model}", but the config resolves it to "${model}"`);
    }

    if (record.text !== undefined && record.text !== entry.text) {
      problems.push(
        `${record.key}: cut from text ${JSON.stringify(record.text)}, but the config says ${JSON.stringify(entry.text)}`,
      );
    }

    planned.push({
      source,
      relPath: clipRelPath(voiceName, groupName, entryName),
      voice,
      entry,
      requestId: record.requestId ?? "",
    });
  }

  if (problems.length > 0) return refuse(problems);

  for (const key of skippedKeys) log.info(`[import] ${key}  —  skipped`);

  let imported = 0;

  for (const take of planned) {
    log.info(`${dryRun ? "[dry-run] WOULD IMPORT" : "[import]"} ${take.relPath} from ${take.source}`);

    if (dryRun) {
      imported++;
      continue;
    }

    const target = path.join(root, take.relPath);

    try {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(take.source, target);
      invalidateProcessedCache(root, take.relPath);
    } catch (err) {
      // Keep the rows of the takes already copied: their bytes are on disk,
      // and a row left stale would have the next run re-cut them.
      const problem = `${take.relPath}: copy failed: ${err instanceof Error ? err.message : String(err)}`;

      log.error(`[import] FAILED: ${problem}`);

      if (imported > 0) persistManifest(manifest);

      return { imported, skipped: skippedKeys.length, problems: [problem] };
    }

    manifest.entries[take.relPath] = {
      hash: entryHash(take.entry, take.voice),
      voiceId: take.voice.id,
      model: trial.model,
      textPreview: textPreview(take.entry.text, 80),
      generatedAt: now().toISOString(),
      requestId: take.requestId,
    };
    imported++;
  }

  if (!dryRun && imported > 0) persistManifest(manifest);

  return { imported, skipped: skippedKeys.length, problems: [] };
}
