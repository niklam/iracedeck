import { describe, expect, it } from "vitest";

import { migrateRespondPmToReply } from "./migrate-respond-pm.js";

describe("migrateRespondPmToReply", () => {
  it("rewrites mode=respond-pm to mode=reply", () => {
    const result = migrateRespondPmToReply({ mode: "respond-pm" });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({ mode: "reply" });
  });

  it("preserves other settings keys during migration", () => {
    const result = migrateRespondPmToReply({
      mode: "respond-pm",
      message: "hi",
      macroNumber: 3,
      keyText: "REPLY",
    });

    expect(result.changed).toBe(true);
    expect(result.migrated).toEqual({
      mode: "reply",
      message: "hi",
      macroNumber: 3,
      keyText: "REPLY",
    });
  });

  it("does not change settings whose mode is already reply", () => {
    const result = migrateRespondPmToReply({ mode: "reply" });

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({ mode: "reply" });
  });

  it("does not touch unrelated modes", () => {
    const result = migrateRespondPmToReply({ mode: "send-message", message: "hello" });

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({ mode: "send-message", message: "hello" });
  });

  it("handles missing mode key", () => {
    const result = migrateRespondPmToReply({ message: "hi" });

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({ message: "hi" });
  });

  it("handles empty raw settings", () => {
    const result = migrateRespondPmToReply({});

    expect(result.changed).toBe(false);
    expect(result.migrated).toEqual({});
  });

  it("handles null and undefined raw settings", () => {
    expect(migrateRespondPmToReply(null)).toEqual({ migrated: {}, changed: false });
    expect(migrateRespondPmToReply(undefined)).toEqual({ migrated: {}, changed: false });
  });

  it("handles non-object raw settings (string, number, boolean)", () => {
    expect(migrateRespondPmToReply("string").changed).toBe(false);
    expect(migrateRespondPmToReply(42).changed).toBe(false);
    expect(migrateRespondPmToReply(true).changed).toBe(false);
  });
});
