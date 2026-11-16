/**
 * Pause marks in clip text (#1518). ElevenLabs reads a hyphen as a pause and
 * often fills it with a hesitation sound ("ahhmm…"); a dash, an ellipsis, a
 * colon and a semicolon do the same. A pause an entry genuinely needs is
 * written as a period, even where the sentence then reads oddly ("Change.
 * You're behind"), so the generator refuses to send any of these marks and
 * `clip-text.test.ts` holds every config to the same rule. `previous_text` and
 * `next_text` are held to it too: they are sent as conditioning, and the
 * car-number seam (#1127) showed conditioning text bleeding into the audio.
 *
 * The rule is for new and edited text only: the clips that carried a mark when
 * it landed are not changed. `pause-marks.grandfathered.json` freezes each of
 * them by its TEXT, not its cache hash, so a change elsewhere that re-cuts it —
 * a dependency's new take, a voice-wide setting — still works, while an edit to
 * its text or a new line under another name is refused. The list only shrinks.
 *
 * A line written after the rule may carry a mark only when Niklas has heard
 * its take and approved it with the mark (#1643): `pause-marks.approved.json`
 * holds each such approval by its text, as the grandfathered list does, so an
 * edit to the text voids it. Unlike the grandfathered list it is no freeze: it
 * grows by one entry per approval, and on nothing else.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { Entry, VoiceConfig } from "./config.ts";
import { clipRelPath } from "./manifest.ts";

// The ASCII hyphen-minus; the soft hyphen; every Unicode hyphen and dash
// (U+2010–U+2015, the two- and three-em dashes); the minus sign; the small and
// fullwidth hyphen-minus; the ellipsis character or a run of two or more
// periods, spaced or not; the colon; the semicolon.
const PAUSE_MARK = /[-­‐-―⸺⸻−﹘﹣－…:;]|\.(?:\s*\.)+/g;

// An SSML `<break time="0.3s" />` is markup ElevenLabs does not speak, so its
// attributes are not held to the rule.
const SSML_BREAK = /<break\b[^>]*\/>/g;

/** The pause marks in `text`, in order of appearance; empty when it is clean. */
export function findPauseMarks(text: string): string[] {
  return text.replace(SSML_BREAK, " ").match(PAUSE_MARK) ?? [];
}

/** The pause marks in every text field the generator sends for `entry`. */
export function findEntryPauseMarks(entry: Entry): string[] {
  return [entry.text, entry.previous_text, entry.next_text].flatMap((text) =>
    text === undefined ? [] : findPauseMarks(text),
  );
}

/** One message naming the marks, for the generator's refusal and the test's report. */
export function describePauseMarks(marks: readonly string[]): string {
  const unique = [...new Set(marks)].map((mark) => JSON.stringify(mark)).join(", ");

  return `text carries pause marks ${unique}: ElevenLabs reads them as a pause and may fill it with a hesitation sound. Write a period where a pause is needed (#1518).`;
}

/** A list of entries exempt from the rule: voice id → `<group>/<name>` → the exact `text` exempted. */
export type PauseMarkList = Record<string, Record<string, string>>;

/** `pause-marks.grandfathered.json`: each entry's `text` when the rule landed. */
export type GrandfatheredPauseMarks = PauseMarkList;

/** `pause-marks.approved.json`: each entry's `text` as Niklas approved its take, marks and all. */
export type ApprovedPauseMarks = PauseMarkList;

export const GRANDFATHERED_FILE = "pause-marks.grandfathered.json";

export const APPROVED_FILE = "pause-marks.approved.json";

const PauseMarkListSchema = z.record(z.string(), z.record(z.string(), z.string()));

/** Read and validate one list; a malformed file throws, naming it. */
export function loadPauseMarkList(packageRoot: string, file: string): PauseMarkList {
  const parsed = PauseMarkListSchema.safeParse(JSON.parse(readFileSync(path.join(packageRoot, file), "utf-8")));

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${z.core.toDotPath(issue.path) || "(root)"}: ${issue.message}`);

    throw new Error(`${file} must map each voice id to "<group>/<name>" → text: ${issues.join("; ")}`);
  }

  return parsed.data;
}

export function loadGrandfatheredPauseMarks(packageRoot: string): GrandfatheredPauseMarks {
  return loadPauseMarkList(packageRoot, GRANDFATHERED_FILE);
}

export function loadApprovedPauseMarks(packageRoot: string): ApprovedPauseMarks {
  return loadPauseMarkList(packageRoot, APPROVED_FILE);
}

/**
 * Whether `entry` is the line a list exempts: its `text` is the listed one and
 * its conditioning text is clean. Neither list exempts a mark there (none of
 * the frozen entries had one, and an approval is of the take's text), so one
 * appearing is an edit.
 */
function matchesListedText(entry: Entry, listedText: string | undefined): boolean {
  return (
    listedText === entry.text &&
    [entry.previous_text, entry.next_text].every((text) => text === undefined || findPauseMarks(text).length === 0)
  );
}

/** Whether `entry` may carry its marks as the frozen line of `pause-marks.grandfathered.json`. */
export function isGrandfathered(entry: Entry, frozenText: string | undefined): boolean {
  return matchesListedText(entry, frozenText);
}

/** Whether `entry` may carry its marks as the line Niklas approved in `pause-marks.approved.json`. */
export function isApproved(entry: Entry, approvedText: string | undefined): boolean {
  return matchesListedText(entry, approvedText);
}

/**
 * Where an entry stands under the rule: `clean` with no mark; `approved` or
 * `grandfathered` when that list holds its exact text (an approval wins, so an
 * approved line is cut without the grandfathered warning); `refused` otherwise.
 */
export type PauseMarkStanding = "clean" | "approved" | "grandfathered" | "refused";

/** The one decision the generator, `--import` and `clip-text.test.ts` share. */
export function pauseMarkStanding(
  entry: Entry,
  listed: { grandfathered: string | undefined; approved: string | undefined },
): PauseMarkStanding {
  if (findEntryPauseMarks(entry).length === 0) return "clean";

  if (isApproved(entry, listed.approved)) return "approved";

  if (isGrandfathered(entry, listed.grandfathered)) return "grandfathered";

  return "refused";
}

export type RefusedPauseMarkEntry = { key: string; relPath: string; text: string; marks: string[] };

/**
 * Hold one voice to its lists. `refused` is every entry with a mark that
 * neither list exempts — new, renamed, copied from another voice, or edited.
 * `stale` is every grandfathered key whose entry is gone or whose text no
 * longer matches, so that list can only shrink; `staleApproved` is the same
 * for the approved list, since an edit voids an approval.
 */
export function checkPauseMarks(
  voiceId: string,
  voice: VoiceConfig,
  grandfathered: Record<string, string> | undefined,
  approved?: Record<string, string>,
): { refused: RefusedPauseMarkEntry[]; stale: string[]; staleApproved: string[] } {
  const frozen = grandfathered ?? {};
  const approvals = approved ?? {};
  const refused: RefusedPauseMarkEntry[] = [];
  const current = new Map<string, string>();

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      const key = `${groupName}/${entry.name}`;

      current.set(key, entry.text);

      if (pauseMarkStanding(entry, { grandfathered: frozen[key], approved: approvals[key] }) !== "refused") continue;

      refused.push({
        key,
        relPath: clipRelPath(voiceId, groupName, entry.name),
        text: entry.text,
        marks: findEntryPauseMarks(entry),
      });
    }
  }

  const staleIn = (list: Record<string, string>): string[] =>
    Object.entries(list)
      .filter(([key, text]) => current.get(key) !== text)
      .map(([key]) => key);

  return { refused, stale: staleIn(frozen), staleApproved: staleIn(approvals) };
}
