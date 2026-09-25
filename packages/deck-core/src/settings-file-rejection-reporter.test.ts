import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSettingsFileRejectionReporter } from "./settings-file-rejection-reporter.js";
import { SETTINGS_FILE_REJECTED_WARNING_ID } from "./settings-file-rejection-warning.js";

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

const REJECTION = {
  path: "C:/x/global-settings.json",
  reason: "Unexpected end of JSON input",
  preservedAt: "C:/x/global-settings.corrupt-1.json",
};

describe("createSettingsFileRejectionReporter", () => {
  beforeEach(() => {
    store.current = {};
    updateSpy.mockClear();
  });

  it("posts the evaluator's banner", () => {
    createSettingsFileRejectionReporter()(REJECTION);

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({ id: SETTINGS_FILE_REJECTED_WARNING_ID, level: "error" });
    expect(warnings()[0].message).toContain("C:/x/global-settings.corrupt-1.json");
  });

  it("leaves other producers' banners in place", () => {
    store.current = {
      _warnings: JSON.stringify([{ id: "elevation-mismatch", level: "error", message: "elevated" }]),
    };

    createSettingsFileRejectionReporter()(REJECTION);

    expect(warnings().map((w) => w.id)).toEqual(["elevation-mismatch", SETTINGS_FILE_REJECTED_WARNING_ID]);
  });

  it("writes nothing when the same rejection is reported again", () => {
    const report = createSettingsFileRejectionReporter();

    report(REJECTION);
    report(REJECTION);

    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});
