import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildProfilesData, MANIFEST_FILE, OUTPUT_FILE } from "./generate-action-profiles.mjs";

describe("data/profiles.json", () => {
  it("matches the Elgato manifest Profiles (run `pnpm generate:action-profiles` if this fails)", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));
    const committed = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));

    expect(committed).toEqual(buildProfilesData(manifest));
  });
});
