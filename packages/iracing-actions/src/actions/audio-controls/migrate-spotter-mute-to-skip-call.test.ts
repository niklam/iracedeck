import { describe, expect, it } from "vitest";

import { migrateSpotterMuteToSkipCall } from "./migrate-spotter-mute-to-skip-call.js";

describe("migrateSpotterMuteToSkipCall", () => {
  it("rewrites a spotter Mute / Unmute press to skip-call", () => {
    const result = migrateSpotterMuteToSkipCall({ dial: { category: "spotter", pressAction: "mute-unmute" } });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({ dial: { category: "spotter", pressAction: "skip-call" } });
  });

  it("preserves every other key, known and unknown, at both levels", () => {
    const result = migrateSpotterMuteToSkipCall({
      category: "voice-chat",
      action: "mute",
      futureRootKey: { nested: true },
      dial: { category: "spotter", pressAction: "mute-unmute", futureDialKey: 7 },
    });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({
      category: "voice-chat",
      action: "mute",
      futureRootKey: { nested: true },
      dial: { category: "spotter", pressAction: "skip-call", futureDialKey: 7 },
    });
  });

  it("does not mutate the input", () => {
    const input = { dial: { category: "spotter", pressAction: "mute-unmute" } };
    migrateSpotterMuteToSkipCall(input);

    expect(input).toEqual({ dial: { category: "spotter", pressAction: "mute-unmute" } });
  });

  it.each(["voice-chat", "master", "race-engineer", "radar"])("leaves %s Mute / Unmute untouched", (category) => {
    const raw = { dial: { category, pressAction: "mute-unmute" } };
    const result = migrateSpotterMuteToSkipCall(raw);

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual(raw);
  });

  it.each(["push-to-talk", "mute-driver", "skip-call", "none"])(
    "leaves a spotter %s press untouched",
    (pressAction) => {
      const raw = { dial: { category: "spotter", pressAction } };
      const result = migrateSpotterMuteToSkipCall(raw);

      expect(result.changed).toBe(false);
      expect(result.migrated).toEqual(raw);
    },
  );

  it("leaves keypad-only settings with no dial untouched", () => {
    const raw = { category: "voice-chat", action: "mute" };
    const result = migrateSpotterMuteToSkipCall(raw);

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual(raw);
  });

  it("does not rewrite keypad fields that happen to hold the legacy pair", () => {
    const raw = { category: "spotter", pressAction: "mute-unmute" };
    const result = migrateSpotterMuteToSkipCall(raw);

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual(raw);
  });

  it("leaves a non-object dial untouched", () => {
    const raw = { dial: "spotter" };
    const result = migrateSpotterMuteToSkipCall(raw);

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual(raw);
  });

  it.each([undefined, null, "string", 42, true])("is safe on non-object input %s", (raw) => {
    expect(migrateSpotterMuteToSkipCall(raw)).toEqual({ migrated: {}, changed: false });
  });
});
