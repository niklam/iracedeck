import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";

import { buildManifest } from "../scripts/generate-audio-manifest.mjs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, "../manifest.json");

describe("audio-assets manifest", () => {
  it("is up to date with the file tree", () => {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    const regenerated = buildManifest();

    expect(regenerated).toEqual(committed);
  });

  it("every advertised special path exists in clips", () => {
    const committed = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    const known = new Set<string>(committed.clips);

    expect(known.has(committed.ambientLoop)).toBe(true);
    expect(known.has(committed.ticks.open)).toBe(true);
    expect(known.has(committed.ticks.close)).toBe(true);
  });
});
