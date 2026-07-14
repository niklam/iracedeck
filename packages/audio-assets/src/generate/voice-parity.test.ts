import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { loadVoiceConfigs, type VoiceConfig } from "./config.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const CONFIGS_DIR = path.join(PACKAGE_ROOT, "configs");

const DEFAULT_VOICE_ID = "default";

/** Strip the `-NN` variant suffix from an entry name (`blue-01` → `blue`). */
function stripVariantSuffix(name: string): string {
  return name.replace(/-\d{2}$/, "");
}

/**
 * Collect the set of `<group>/<base>` keys for a voice, where `base` is the
 * entry name with any `-NN` variant suffix stripped. This is the unit of the
 * relaxed parity check (issue #664): pools are derived per-voice from the
 * clips that actually exist, so a voice may carry a different number of
 * variants of a line, or omit a callout entirely — neither is an error.
 */
function baseKeys(voice: VoiceConfig): Set<string> {
  const keys = new Set<string>();

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      keys.add(`${groupName}/${stripVariantSuffix(entry.name)}`);
    }
  }

  return keys;
}

describe("voice-parity", () => {
  const voiceConfigs = loadVoiceConfigs(CONFIGS_DIR);

  it("includes the canonical default voice", () => {
    expect(voiceConfigs.has(DEFAULT_VOICE_ID)).toBe(true);
  });

  const defaultVoice = voiceConfigs.get(DEFAULT_VOICE_ID);

  if (!defaultVoice) return;

  const defaultBases = baseKeys(defaultVoice);

  // Soft typo guard: a base the canonical default voice doesn't know is
  // referenced by no pool, so it would never play — almost certainly a
  // misspelling (`blu-01` for `blue-01`). MISSING bases are deliberately
  // allowed: a voice that omits a callout simply doesn't play it.
  for (const [voiceId, voice] of voiceConfigs) {
    if (voiceId === DEFAULT_VOICE_ID) continue;

    it(`voice "${voiceId}" has no <group>/<base> keys unknown to default (typo guard)`, () => {
      const extra = [...baseKeys(voice)].filter((k) => !defaultBases.has(k)).sort();

      expect(extra, `extra in "${voiceId}" (not in default — probable typo):\n  ${extra.join("\n  ")}`).toEqual([]);
    });
  }
});
