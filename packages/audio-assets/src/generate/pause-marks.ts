/**
 * Pause marks in spoken clip text (#1518). ElevenLabs reads a hyphen as a
 * pause and often fills it with a hesitation sound ("ahhmm…"); a dash, an
 * ellipsis, a colon and a semicolon do the same. A pause an entry genuinely
 * needs is written as a period, even where the sentence then reads oddly
 * ("Change. You're behind"), so the generator refuses to send any of these
 * marks and `clip-text.test.ts` holds every config to the same rule.
 *
 * The clips that already carried a mark when the rule landed are
 * grandfathered only while they stay exactly as generated — the entry's hash
 * in `generate.manifest.json` still matches — so none of them can be re-cut
 * before its text is fixed. Their rewrite is #1519.
 */
import path from "node:path";

import { buildEntryLookup, entryHash, type VoiceConfig } from "./config.ts";
import type { Manifest } from "./manifest.ts";

// The ASCII hyphen-minus; every Unicode hyphen and dash (U+2010–U+2015); the
// minus sign; the small and fullwidth hyphen-minus; the ellipsis character or
// a run of two or more periods; the colon; the semicolon.
const PAUSE_MARK = /[-‐-―−﹘﹣－…:;]|\.{2,}/g;

// An SSML `<break time="0.3s" />` is markup ElevenLabs does not speak, so its
// attributes are not held to the rule.
const SSML_BREAK = /<break\b[^>]*\/>/g;

/** The pause marks in `text`, in order of appearance; empty when it is clean. */
export function findPauseMarks(text: string): string[] {
  return text.replace(SSML_BREAK, " ").match(PAUSE_MARK) ?? [];
}

/** One message naming the marks, for the generator's refusal and the test's report. */
export function describePauseMarks(marks: readonly string[]): string {
  const unique = [...new Set(marks)].map((mark) => JSON.stringify(mark)).join(", ");

  return `text carries pause marks ${unique}: ElevenLabs reads them as a pause and may fill it with a hesitation sound. Write a period where a pause is needed (#1518).`;
}

export type PauseMarkEntry = {
  /** `voice/<voice-id>/<group>/<name>.mp3`, the manifest's key. */
  relPath: string;
  text: string;
  marks: string[];
  /** True while the entry's clip is exactly as generated, which is what grandfathers it. */
  generated: boolean;
};

/** Every entry of `voice` whose spoken text carries a pause mark, and whether its clip is grandfathered. */
export function pauseMarkEntries(voiceId: string, voice: VoiceConfig, manifest: Manifest): PauseMarkEntry[] {
  const lookup = buildEntryLookup(voice);
  const memo = new Map<string, string>();
  const found: PauseMarkEntry[] = [];

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      const marks = findPauseMarks(entry.text);

      if (marks.length === 0) continue;

      const relPath = path.posix.join("voice", voiceId, groupName, `${entry.name}.mp3`);
      const generated = manifest.entries[relPath]?.hash === entryHash(entry, groupName, voice, lookup, memo);

      found.push({ relPath, text: entry.text, marks, generated });
    }
  }

  return found;
}
