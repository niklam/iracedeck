import { CALLOUT_SCRIPT_FILE, calloutScriptPath } from "@iracedeck/callout-script";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { buildManifest } from "../scripts/generate-audio-manifest.mjs";
import { BUNDLED_VOICE_IDS, PUBLISHED_VOICE_IDS, SHIPPED_FOLDERS } from "./build/index.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.json");
const BUNDLED_MANIFEST_PATH = path.join(PACKAGE_ROOT, "manifest.bundled.json");

describe("audio-assets manifest", () => {
  // Two manifests, one generator: `manifest.json` describes every AUTHORED
  // voice (what the harness and the generators read as "the authored voice"),
  // `manifest.bundled.json` only the slice a plugin distributable carries —
  // which is what the plugins import, and what the scanner's reserved-voice
  // list derives from (#1034 stage 3).
  it("manifest.json is up to date with the file tree — every authored voice", () => {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));

    expect(buildManifest({ voices: "all" })).toEqual(committed);
  });

  it("manifest.bundled.json is up to date — only the bundled voices", () => {
    const committed = JSON.parse(fs.readFileSync(BUNDLED_MANIFEST_PATH, "utf-8"));

    expect(buildManifest({ voices: "bundled" })).toEqual(committed);
  });

  // The two slices will differ by every voice at stage 3, and a caller that
  // does not say which one it means would get a plausible-looking manifest for
  // the wrong one — clips that are not there, surfacing only as an engineer
  // that says nothing. So the generator refuses instead of defaulting.
  it("refuses to build a manifest for an unnamed slice", () => {
    expect(() => buildManifest()).toThrow(/voices must be "all" or "bundled"/);
  });

  it("the bundled manifest names no voice outside BUNDLED_VOICE_IDS", () => {
    const bundled = buildManifest({ voices: "bundled" });
    const voiceClips = bundled.clips.filter((clip: string) => clip.startsWith("voice/"));

    for (const clip of voiceClips) {
      expect(BUNDLED_VOICE_IDS).toContain(clip.split("/")[1]);
    }
  });

  // The manifest is the list of CLIPS the engine resolves against. The
  // voice's `callouts.json` (#1064) sits inside the same `voice/<id>/` tree
  // and ships beside the clips, but it is read by the voice-pack service,
  // never played — listed here it would be a callout that resolves to
  // nothing. Each published voice's file must EXIST for this to prove anything.
  it("lists no callouts.json, though every published voice ships one beside its clips", () => {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));

    expect(PUBLISHED_VOICE_IDS.length).toBeGreaterThan(0);

    for (const voiceId of PUBLISHED_VOICE_IDS) {
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
    const manifest = buildManifest({ voices: "all" });
    const referenced = new Set(
      [...manifest.clips, manifest.ambientLoop, manifest.ticks.open, manifest.ticks.close].map(
        (clipPath) => clipPath.split("/")[0],
      ),
    );

    expect([...referenced].sort()).toEqual([...SHIPPED_FOLDERS].sort());
  });
});
