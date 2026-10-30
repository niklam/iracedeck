import path from "node:path";
import { describe, expect, it } from "vitest";

import { audioAssetsPath } from "./build/index.mjs";
import { loadVoiceConfigs } from "./generate/config.ts";
import { loadManifest } from "./generate/manifest.ts";
import { describePauseMarks, pauseMarkEntries } from "./generate/pause-marks.ts";

// No pause marks in spoken clip text (#1518): ElevenLabs reads a hyphen, dash,
// ellipsis, colon or semicolon as a pause and may fill it with a hesitation
// sound. The generator refuses such text; this holds every committed config to
// the same rule, so an entry added without generating (a copied Terse line, a
// hand-edited manifest) is caught too. The clips that carried a mark before the
// rule stay only while they are exactly as generated, and #1519 rewrites them.

const configs = loadVoiceConfigs(path.join(audioAssetsPath, "configs"));
const manifest = loadManifest(path.join(audioAssetsPath, "generate.manifest.json"));

describe("spoken clip text", () => {
  it("finds the voice configs", () => {
    expect(configs.size).toBeGreaterThan(0);
  });

  it.each([...configs.keys()])("%s carries no pause mark outside an already generated clip", (voiceId) => {
    const refused = pauseMarkEntries(voiceId, configs.get(voiceId)!, manifest)
      .filter((entry) => !entry.generated)
      .map((entry) => `${entry.relPath} ${JSON.stringify(entry.text)}: ${describePauseMarks(entry.marks)}`);

    expect(refused).toEqual([]);
  });
});
