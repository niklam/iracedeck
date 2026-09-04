import { CALLOUT_SCRIPT_FILE, calloutScriptPath } from "@iracedeck/callout-script";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { buildManifest } from "../scripts/generate-audio-manifest.mjs";
import { BUNDLED_VOICE_IDS, SHIPPED_FOLDERS } from "./build/index.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.json");

describe("audio-assets manifest", () => {
  it("is up to date with the file tree", () => {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    const regenerated = buildManifest();

    expect(regenerated).toEqual(committed);
  });

  // The manifest is the list of CLIPS the engine resolves against. The
  // voice's `callouts.json` (#1064) sits inside the same `voice/<id>/` tree
  // and ships beside the clips, but it is read by the voice-pack service,
  // never played — listed here it would be a callout that resolves to
  // nothing. The bundled voice's file must EXIST for this to prove anything.
  it("lists no callouts.json, though every bundled voice ships one beside its clips", () => {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));

    expect(BUNDLED_VOICE_IDS.length).toBeGreaterThan(0);

    for (const voiceId of BUNDLED_VOICE_IDS) {
      expect(fs.existsSync(path.join(PACKAGE_ROOT, calloutScriptPath(voiceId)))).toBe(true);
    }

    expect(committed.clips.filter((clip: string) => clip.endsWith(`/${CALLOUT_SCRIPT_FILE}`))).toEqual([]);
    expect(committed.clips.every((clip: string) => clip.endsWith(".mp3"))).toBe(true);
  });

  it("every advertised special path exists in clips", () => {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    const known = new Set<string>(committed.clips);

    expect(known.has(committed.ambientLoop)).toBe(true);
    expect(known.has(committed.ticks.open)).toBe(true);
    expect(known.has(committed.ticks.close)).toBe(true);
  });
});

describe("what the plugin build ships", () => {
  // The allow-list and the manifest have to agree, and neither can tell on its
  // own. A manifest root that is not shipped means clips that resolve to
  // nothing at runtime — the engineer simply silent. A shipped folder that no
  // manifest path references is dead weight in every plugin download.
  //
  // This exists because the copy step used to be a skip-list, which had already
  // leaked `configs/` and `.turbo/` into released plugins and was about to add
  // `dist/` — 16 MB of staged voice pack, in the feature meant to make the
  // download smaller.
  it("ships exactly the folders the manifest resolves against", () => {
    const manifest = buildManifest();
    const referenced = new Set(
      [...manifest.clips, manifest.ambientLoop, manifest.ticks.open, manifest.ticks.close].map(
        (clipPath) => clipPath.split("/")[0],
      ),
    );

    expect([...referenced].sort()).toEqual([...SHIPPED_FOLDERS].sort());
  });
});
