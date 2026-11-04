import { describe, expect, it, vi } from "vitest";

import {
  availableProfilesForDevice,
  deviceProfileEntries,
  profileEntriesEqual,
  type ProfileEntry,
} from "./profile-entries.js";

vi.mock("../actions/data/profiles.json", () => ({
  default: [
    { name: "iRaceDeck Default XL", deviceType: 2, displayName: "iRaceDeck Default" },
    { name: "iRaceDeck Replay XL", deviceType: 2, displayName: "iRaceDeck Replay" },
    { name: "iRaceDeck Race Admin Per Car XL", deviceType: 2, displayName: "iRaceDeck Race Admin Per Car" },
    { name: "iRaceDeck Car Selector XL", deviceType: 2, displayName: "iRaceDeck Car Selector" },
    { name: "iRaceDeck Pit Actions Mini", deviceType: 1, displayName: "iRaceDeck Pit Actions" },
  ],
}));

describe("availableProfilesForDevice", () => {
  it("filters the generated profiles by device type, returning manifest names in file order", () => {
    expect(availableProfilesForDevice(2)).toEqual([
      "iRaceDeck Default XL",
      "iRaceDeck Replay XL",
      "iRaceDeck Race Admin Per Car XL",
      "iRaceDeck Car Selector XL",
    ]);
    expect(availableProfilesForDevice(1)).toEqual(["iRaceDeck Pit Actions Mini"]);
  });

  it("returns empty for a device type that ships no bundled profile", () => {
    expect(availableProfilesForDevice(99)).toEqual([]);
  });

  it("returns empty when the device type is unknown", () => {
    expect(availableProfilesForDevice(undefined)).toEqual([]);
  });
});

describe("deviceProfileEntries", () => {
  it("pairs each manifest name with its clean display label (#753)", () => {
    expect(deviceProfileEntries(2)).toEqual([
      { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
      { name: "iRaceDeck Replay XL", label: "iRaceDeck Replay" },
      { name: "iRaceDeck Race Admin Per Car XL", label: "iRaceDeck Race Admin Per Car" },
      { name: "iRaceDeck Car Selector XL", label: "iRaceDeck Car Selector" },
    ]);
    expect(deviceProfileEntries(1)).toEqual([{ name: "iRaceDeck Pit Actions Mini", label: "iRaceDeck Pit Actions" }]);
  });

  it("returns empty for an unknown or profile-less device type", () => {
    expect(deviceProfileEntries(undefined)).toEqual([]);
    expect(deviceProfileEntries(99)).toEqual([]);
  });

  it("lists the same manifest names as availableProfilesForDevice, so a PI choice resolves at press time", () => {
    for (const deviceType of [1, 2, 99]) {
      expect(deviceProfileEntries(deviceType).map((e) => e.name)).toEqual(availableProfilesForDevice(deviceType));
    }
  });
});

describe("profileEntriesEqual", () => {
  const entries: ProfileEntry[] = [
    { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
    { name: "iRaceDeck Replay XL", label: "iRaceDeck Replay" },
  ];

  it("matches an identical persisted list", () => {
    const persisted = entries.map((e) => ({ ...e }));

    expect(profileEntriesEqual(persisted, entries)).toBe(true);
  });

  it("treats two empty lists as equal", () => {
    expect(profileEntriesEqual([], [])).toBe(true);
  });

  it("rejects a length mismatch", () => {
    expect(profileEntriesEqual([{ ...entries[0] }], entries)).toBe(false);
  });

  it("rejects a differing name or label", () => {
    expect(profileEntriesEqual([{ ...entries[0] }, { ...entries[1], label: "Other" }], entries)).toBe(false);
    expect(profileEntriesEqual([{ ...entries[0] }, { ...entries[1], name: "Other XL" }], entries)).toBe(false);
  });

  it("rejects legacy plain-string entries so they get re-pushed as objects", () => {
    expect(profileEntriesEqual(["iRaceDeck Default XL"], [entries[0]])).toBe(false);
  });
});
