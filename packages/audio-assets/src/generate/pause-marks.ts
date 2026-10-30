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
 * it landed are not changed. They are listed in `pause-marks.grandfathered.json`,
 * which may only shrink, and each stays allowed only while its clip is exactly
 * as generated — so none can be re-cut without its text being fixed first.
 */
import type { Entry, VoiceConfig } from "./config.ts";
import { buildEntryLookup, entryHash } from "./config.ts";
import { clipRelPath, type Manifest } from "./manifest.ts";

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

export type PauseMarkEntry = {
  /** `<group>/<name>`, the allow-list's key within a voice. */
  key: string;
  relPath: string;
  text: string;
  marks: string[];
  /** True while the clip is exactly as generated — the generator's own cache hit. */
  generated: boolean;
};

/** Every entry of `voice` whose text fields carry a pause mark, and whether its clip is as generated. */
export function pauseMarkEntries(
  voiceId: string,
  voice: VoiceConfig,
  manifest: Manifest,
  clipExists: (relPath: string) => boolean,
): PauseMarkEntry[] {
  const lookup = buildEntryLookup(voice);
  const memo = new Map<string, string>();
  const found: PauseMarkEntry[] = [];

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      const marks = findEntryPauseMarks(entry);

      if (marks.length === 0) continue;

      const relPath = clipRelPath(voiceId, groupName, entry.name);
      const generated =
        manifest.entries[relPath]?.hash === entryHash(entry, groupName, voice, lookup, memo) && clipExists(relPath);

      found.push({ key: `${groupName}/${entry.name}`, relPath, text: entry.text, marks, generated });
    }
  }

  return found;
}

/** `pause-marks.grandfathered.json`: voice id → group → entry names. */
export type GrandfatheredPauseMarks = Record<string, Record<string, string[]>>;

/**
 * Hold one voice's offenders to the allow-list. `refused` is every offender the
 * list does not grandfather — new or renamed, or listed but changed since its
 * clip was generated. `stale` is every listed entry that no longer carries a
 * mark or no longer exists, so the list can only shrink.
 */
export function checkPauseMarks(
  offenders: readonly PauseMarkEntry[],
  grandfathered: Record<string, string[]> | undefined,
): { refused: PauseMarkEntry[]; stale: string[] } {
  const listed = new Set(
    Object.entries(grandfathered ?? {}).flatMap(([group, names]) => names.map((name) => `${group}/${name}`)),
  );
  const refused = offenders.filter((entry) => !listed.has(entry.key) || !entry.generated);
  const offending = new Set(offenders.map((entry) => entry.key));
  const stale = [...listed].filter((key) => !offending.has(key));

  return { refused, stale };
}
