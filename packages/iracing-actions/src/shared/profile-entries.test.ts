import { describe, expect, it, vi } from "vitest";

import {
  availableProfilesForDevice,
  deviceProfileEntries,
  deviceProfilesUpdate,
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

describe("deviceProfilesUpdate (#1761)", () => {
  const xlEntries: ProfileEntry[] = [
    { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
    { name: "iRaceDeck Replay XL", label: "iRaceDeck Replay" },
    { name: "iRaceDeck Race Admin Per Car XL", label: "iRaceDeck Race Admin Per Car" },
    { name: "iRaceDeck Car Selector XL", label: "iRaceDeck Car Selector" },
  ];
  const always = (): boolean => true;

  it("returns the settings it is handed plus the device's entries", () => {
    const current = { mode: "select-car", addedWithVersion: "3.10.0", driverTarget: "viewed-car" };

    expect(deviceProfilesUpdate(2, always)(current)).toEqual({ ...current, _deviceProfiles: xlEntries });
  });

  it("never mutates the settings it is handed", () => {
    const current = Object.freeze({ mode: "select-car" });

    expect(() => deviceProfilesUpdate(2, always)(current)).not.toThrow();
    expect(current).toEqual({ mode: "select-car" });
  });

  it("returns undefined when the stored entries already match, so nothing is written", () => {
    const current = { mode: "select-car", _deviceProfiles: xlEntries.map((e) => ({ ...e })) };

    expect(deviceProfilesUpdate(2, always)(current)).toBeUndefined();
  });

  it("replaces a stale or legacy plain-string list", () => {
    expect(deviceProfilesUpdate(1, always)({ _deviceProfiles: xlEntries })).toEqual({
      _deviceProfiles: [{ name: "iRaceDeck Pit Actions Mini", label: "iRaceDeck Pit Actions" }],
    });
    expect(deviceProfilesUpdate(2, always)({ _deviceProfiles: ["iRaceDeck Default"] })).toEqual({
      _deviceProfiles: xlEntries,
    });
  });

  it("treats a non-array stored value as no list", () => {
    expect(deviceProfilesUpdate(2, always)({ _deviceProfiles: "garbage" })).toEqual({ _deviceProfiles: xlEntries });
  });

  it("returns undefined when the Mode, judged on the settings it runs on, does not apply", () => {
    const applies = vi.fn((s: Readonly<Record<string, unknown>>) => s.mode === "select-car");
    const update = deviceProfilesUpdate(2, applies);

    expect(update({ mode: "yellow" })).toBeUndefined();
    expect(applies).toHaveBeenLastCalledWith({ mode: "yellow" });
    // The same updater re-run on newer settings decides again from those.
    expect(update({ mode: "select-car" })).toEqual({ mode: "select-car", _deviceProfiles: xlEntries });
  });

  it("writes nothing over a missing list for a device that ships no profile, and clears a stale one", () => {
    const update = deviceProfilesUpdate(99, always);

    expect(update({})).toBeUndefined();
    expect(update({ _deviceProfiles: [] })).toBeUndefined();
    expect(update({ _deviceProfiles: xlEntries })).toEqual({ _deviceProfiles: [] });
  });
});
