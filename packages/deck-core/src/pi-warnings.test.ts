import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearWarning, reconcileWarnings, setWarning } from "./pi-warnings.js";

const { store, updateSpy } = vi.hoisted(() => {
  const store = { current: {} as Record<string, unknown> };
  const updateSpy = vi.fn((partial: Record<string, unknown>) => {
    store.current = { ...store.current, ...partial };
  });

  return { store, updateSpy };
});

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: () => store.current,
  updateGlobalSettings: updateSpy,
}));

function warnings(): Array<{ id: string; level: string; message: string }> {
  const raw = store.current._warnings;

  return typeof raw === "string" ? JSON.parse(raw) : [];
}

describe("pi-warnings store", () => {
  beforeEach(() => {
    store.current = {};
    updateSpy.mockClear();
  });

  it("adds a warning record keyed by id", () => {
    setWarning("a", "warning", "msg");
    expect(warnings()).toEqual([{ id: "a", level: "warning", message: "msg" }]);
  });

  it("replaces an existing record with the same id", () => {
    setWarning("a", "warning", "first");
    setWarning("a", "error", "second");
    expect(warnings()).toEqual([{ id: "a", level: "error", message: "second" }]);
  });

  it("keeps records with different ids side by side", () => {
    setWarning("a", "warning", "A");
    setWarning("b", "info", "B");
    expect(
      warnings()
        .map((w) => w.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("does not write when the record is unchanged", () => {
    setWarning("a", "warning", "msg");
    updateSpy.mockClear();
    setWarning("a", "warning", "msg");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("clears a warning by id", () => {
    setWarning("a", "warning", "A");
    setWarning("b", "info", "B");
    clearWarning("a");
    expect(warnings()).toEqual([{ id: "b", level: "info", message: "B" }]);
  });

  it("clearWarning is a no-op when the id is absent", () => {
    clearWarning("missing");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("tolerates a malformed _warnings cache", () => {
    store.current._warnings = "{not json";
    setWarning("a", "warning", "msg");
    expect(warnings()).toEqual([{ id: "a", level: "warning", message: "msg" }]);
  });

  it("drops malformed array entries instead of crashing on setWarning", () => {
    store.current._warnings = JSON.stringify([
      null,
      { id: "a", level: "warning", message: "m" },
      { bad: true },
      { id: "c", level: "bogus", message: "m" },
    ]);
    expect(() => setWarning("b", "info", "x")).not.toThrow();
    expect(warnings()).toEqual([
      { id: "a", level: "warning", message: "m" },
      { id: "b", level: "info", message: "x" },
    ]);
  });

  it("ignores malformed entries on clearWarning", () => {
    store.current._warnings = JSON.stringify([null, { id: "a", level: "warning", message: "m" }]);
    expect(() => clearWarning("a")).not.toThrow();
    expect(warnings()).toEqual([]);
  });
});

describe("reconcileWarnings", () => {
  beforeEach(() => {
    store.current = {};
    updateSpy.mockClear();
  });

  it("posts a producer's whole family in ONE write", () => {
    reconcileWarnings(
      ["a", "b"],
      [
        { id: "a", level: "error", message: "A" },
        { id: "b", level: "warning", message: "B" },
      ],
    );

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([
      { id: "a", level: "error", message: "A" },
      { id: "b", level: "warning", message: "B" },
    ]);
  });

  it("drops the scope's ids that the caller no longer returns", () => {
    reconcileWarnings(["a", "b"], [{ id: "a", level: "error", message: "A" }]);
    reconcileWarnings(["a", "b"], []);

    expect(warnings()).toEqual([]);
  });

  it("never touches another producer's records", () => {
    setWarning("elevation-mismatch", "warning", "other");
    updateSpy.mockClear();

    reconcileWarnings(["a"], [{ id: "a", level: "error", message: "A" }]);

    expect(warnings()).toEqual([
      { id: "elevation-mismatch", level: "warning", message: "other" },
      { id: "a", level: "error", message: "A" },
    ]);
  });

  it("writes nothing when the outcome is what is already stored", () => {
    reconcileWarnings(["a"], [{ id: "a", level: "error", message: "A" }]);
    updateSpy.mockClear();

    reconcileWarnings(["a"], [{ id: "a", level: "error", message: "A" }]);

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("writes nothing when another producer posted after us and nothing of ours changed", () => {
    // The reconciled list moves our records to the end, so an order-sensitive
    // comparison would rewrite the setting here for no change at all.
    reconcileWarnings(["a"], [{ id: "a", level: "error", message: "A" }]);
    setWarning("elevation-mismatch", "warning", "other");
    updateSpy.mockClear();

    reconcileWarnings(["a"], [{ id: "a", level: "error", message: "A" }]);

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("writes when only the level or the message changed", () => {
    reconcileWarnings(["a"], [{ id: "a", level: "error", message: "A" }]);
    updateSpy.mockClear();

    reconcileWarnings(["a"], [{ id: "a", level: "warning", message: "A" }]);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([{ id: "a", level: "warning", message: "A" }]);
  });

  it("is a no-op on an empty scope with nothing to post", () => {
    reconcileWarnings([], []);

    expect(updateSpy).not.toHaveBeenCalled();
  });
});
