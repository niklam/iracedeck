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
 */
import { readFileSync } from "node:fs";
import path from "node:path";

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

/** `pause-marks.grandfathered.json`: voice id → `<group>/<name>` → the entry's `text` when the rule landed. */
export type GrandfatheredPauseMarks = Record<string, Record<string, string>>;

export const GRANDFATHERED_FILE = "pause-marks.grandfathered.json";

export function loadGrandfatheredPauseMarks(packageRoot: string): GrandfatheredPauseMarks {
  return JSON.parse(readFileSync(path.join(packageRoot, GRANDFATHERED_FILE), "utf-8")) as GrandfatheredPauseMarks;
}

/**
 * Whether `entry` may carry its marks: it is listed, its `text` is the frozen
 * one, and its conditioning text is clean — none of the frozen entries had a
 * mark there, so one appearing is an edit.
 */
export function isGrandfathered(entry: Entry, frozenText: string | undefined): boolean {
  return (
    frozenText === entry.text &&
    [entry.previous_text, entry.next_text].every((text) => text === undefined || findPauseMarks(text).length === 0)
  );
}

export type RefusedPauseMarkEntry = { key: string; relPath: string; text: string; marks: string[] };

/**
 * Hold one voice to its list. `refused` is every entry with a mark that the
 * list does not grandfather — new, renamed, copied from another voice, or
 * edited. `stale` is every listed key whose entry is gone or whose text no
 * longer matches, so the list can only shrink.
 */
export function checkPauseMarks(
  voiceId: string,
  voice: VoiceConfig,
  grandfathered: Record<string, string> | undefined,
): { refused: RefusedPauseMarkEntry[]; stale: string[] } {
  const listed = grandfathered ?? {};
  const refused: RefusedPauseMarkEntry[] = [];
  const current = new Map<string, string>();

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      const key = `${groupName}/${entry.name}`;

      current.set(key, entry.text);

      const marks = findEntryPauseMarks(entry);

      if (marks.length === 0 || isGrandfathered(entry, listed[key])) continue;

      refused.push({ key, relPath: clipRelPath(voiceId, groupName, entry.name), text: entry.text, marks });
    }
  }

  const stale = Object.entries(listed)
    .filter(([key, text]) => current.get(key) !== text)
    .map(([key]) => key);

  return { refused, stale };
}
