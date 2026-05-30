import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearWarning, setWarning } from "./pi-warnings.js";

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
});
