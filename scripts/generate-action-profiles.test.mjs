import { readFileSync } from "node:fs";

import {
  deviceProfileName,
  PROFILE_DEVICE_SUFFIXES as DECK_CORE_SUFFIXES,
  profileDisplayName,
} from "@iracedeck/deck-core";
import { describe, expect, it } from "vitest";

import { buildProfilesData, MANIFEST_FILE, OUTPUT_FILE, PROFILE_DEVICE_SUFFIXES } from "./generate-action-profiles.mjs";

const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf-8"));

describe("data/profiles.json", () => {
  it("matches the Elgato manifest Profiles (run `pnpm generate:action-profiles` if this fails)", () => {
    const committed = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8"));

    expect(committed).toEqual(buildProfilesData(manifest));
  });

  it("keeps the script's device-suffix list in sync with deck-core's PROFILE_DEVICE_SUFFIXES", () => {
    expect(new Set(PROFILE_DEVICE_SUFFIXES)).toEqual(new Set(Object.values(DECK_CORE_SUFFIXES)));
  });

  it("derives displayName exactly like deck-core's profileDisplayName", () => {
    for (const profile of buildProfilesData(manifest)) {
      expect(profile.displayName).toBe(profileDisplayName(profile.name));
    }
  });

  it("keeps every manifest profile name device-suffixed for its DeviceType (#753)", () => {
    const profiles = buildProfilesData(manifest);

    expect(profiles.length).toBeGreaterThan(0);

    for (const profile of profiles) {
      expect(profile.name, `"${profile.name}" must carry the device suffix`).not.toBe(profile.displayName);
      expect(profile.name).toBe(deviceProfileName(profile.displayName, profile.deviceType));
    }
  });
});
