import { describe, expect, it } from "vitest";

import { profileEntriesEqual, type ProfileEntry } from "./profile-entries.js";

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
