import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { loadVoiceConfigs, type VoiceConfig } from "./config.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const CONFIGS_DIR = path.join(PACKAGE_ROOT, "configs");

const DEFAULT_VOICE_ID = "default";

/**
 * Collect the set of `<group>/<entry-name>` keys for a voice. This is the
 * unit of parity: every voice pack must offer the same set of clips, even
 * if the wording differs between voices.
 */
function clipKeys(voice: VoiceConfig): Set<string> {
  const keys = new Set<string>();

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      keys.add(`${groupName}/${entry.name}`);
    }
  }

  return keys;
}

function diff(reference: Set<string>, other: Set<string>): { missing: string[]; extra: string[] } {
  const missing = [...reference].filter((k) => !other.has(k)).sort();
  const extra = [...other].filter((k) => !reference.has(k)).sort();

  return { missing, extra };
}

describe("voice-parity", () => {
  const voiceConfigs = loadVoiceConfigs(CONFIGS_DIR);

  it("includes the canonical default voice", () => {
    expect(voiceConfigs.has(DEFAULT_VOICE_ID)).toBe(true);
  });

  const defaultVoice = voiceConfigs.get(DEFAULT_VOICE_ID);

  if (!defaultVoice) return;

  const defaultKeys = clipKeys(defaultVoice);

  for (const [voiceId, voice] of voiceConfigs) {
    if (voiceId === DEFAULT_VOICE_ID) continue;

    it(`voice "${voiceId}" has the same <group>/<entry> keys as default`, () => {
      const keys = clipKeys(voice);
      const { missing, extra } = diff(defaultKeys, keys);

      // Build a single message so the test failure shows both gaps at once.
      const parts: string[] = [];

      if (missing.length > 0) parts.push(`missing in "${voiceId}":\n  ${missing.join("\n  ")}`);

      if (extra.length > 0) parts.push(`extra in "${voiceId}" (not in default):\n  ${extra.join("\n  ")}`);

      expect(parts, parts.join("\n\n")).toEqual([]);
    });
  }
});
