import { setWarning } from "@iracedeck/settings";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_CATALOG_REJECTED_WARNING_ID,
  createCameraCatalogRejectionReporter,
  evaluateCameraCatalogRejectionWarning,
} from "./camera-catalog-warning.js";

vi.mock("@iracedeck/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@iracedeck/settings")>()),
  setWarning: vi.fn(),
}));

const rejection = {
  path: "C:\\Users\\u\\AppData\\Local\\iRaceDeck\\Settings\\Stream Deck\\cameras.json",
  reason: "Unexpected token",
  preservedAt:
    "C:\\Users\\u\\AppData\\Local\\iRaceDeck\\Settings\\Stream Deck\\cameras.corrupt-2026-11-08T12-00-00-000Z.json",
};

describe("evaluateCameraCatalogRejectionWarning (#1653)", () => {
  it("is one page-wide warning naming the preserved copy and what happens next", () => {
    const warning = evaluateCameraCatalogRejectionWarning(rejection);

    expect(warning.id).toBe(CAMERA_CATALOG_REJECTED_WARNING_ID);
    expect(warning.id).toBe("camera-catalog-rejected");
    expect(warning.level).toBe("warning");
    expect(warning.message).toContain("could not read its list of remembered camera groups");
    expect(warning.message).toContain(`kept as ${rejection.preservedAt}`);
    expect(warning.message).toContain("starts a fresh list from the next session");
  });

  it("starts with a letter, never an emoji (ird-warnings draws the icon)", () => {
    expect(evaluateCameraCatalogRejectionWarning(rejection).message).toMatch(/^[A-Za-z]/);
  });
});

describe("createCameraCatalogRejectionReporter (#1653)", () => {
  afterEach(() => {
    vi.mocked(setWarning).mockReset();
  });

  it("sets the banner through the injected writer", () => {
    const set = vi.fn<(id: string, level: string, message: string) => void>();

    createCameraCatalogRejectionReporter({ setWarning: set })(rejection);

    const warning = evaluateCameraCatalogRejectionWarning(rejection);

    expect(set).toHaveBeenCalledExactlyOnceWith(warning.id, warning.level, warning.message);
    expect(setWarning).not.toHaveBeenCalled();
  });

  it("defaults to the settings package's setWarning", () => {
    createCameraCatalogRejectionReporter()(rejection);

    expect(setWarning).toHaveBeenCalledExactlyOnceWith(
      "camera-catalog-rejected",
      "warning",
      evaluateCameraCatalogRejectionWarning(rejection).message,
    );
  });
});
