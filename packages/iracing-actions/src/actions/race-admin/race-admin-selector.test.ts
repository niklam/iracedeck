import { getAllCarNumbers } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  carsPerPage,
  computeCarSlotIndex,
  DEFAULT_SELECTOR_TARGET_PROFILE,
  generateSelectorSvg,
  parseSelectedCar,
  resolveSelectedCar,
  resolveSlotCar,
  SELECTED_CAR_KEY,
} from "./race-admin-selector.js";

vi.mock("@iracedeck/iracing-sdk", () => ({
  getAllCarNumbers: vi.fn(() => []),
}));

vi.mock("../../../icons/race-admin-car-selector.svg", () => ({
  default: "<svg>{{backgroundColor}}{{borderDefs}}{{borderContent}}{{titleContent}}{{numberContent}}</svg>",
}));

vi.mock("@iracedeck/deck-core", () => ({
  escapeXml: (s: string) => s,
  generateBorderParts: vi.fn(() => ({ defs: "", rects: "" })),
  generateTitleText: vi.fn(() => "<title/>"),
  getGlobalBorderSettings: vi.fn(() => ({})),
  getGlobalColors: vi.fn(() => ({})),
  getGlobalTitleSettings: vi.fn(() => ({})),
  renderIconTemplate: vi.fn(
    (_tpl: string, data: Record<string, string>) => `<svg>${data.numberContent ?? ""}${data.titleContent ?? ""}</svg>`,
  ),
  resolveBorderSettings: vi.fn(() => ({ enabled: false })),
  resolveIconColors: vi.fn(() => ({ backgroundColor: "#000000", textColor: "#ffffff" })),
  resolveTitleSettings: vi.fn((_s: unknown, _g: unknown, _o: unknown, def?: string) => ({
    showTitle: true,
    titleText: def ?? "",
    bold: true,
    fontSize: 18,
    position: "bottom" as const,
    customPosition: 0,
  })),
  svgToDataUri: vi.fn((svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`),
}));

const XL = [8, 4] as const;
const SD = [5, 3] as const;
const PLUS_XL = [6, 6] as const;

describe("race-admin-selector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("SELECTED_CAR_KEY", () => {
    it("is the passthrough global key", () => {
      expect(SELECTED_CAR_KEY).toBe("_raceAdminSelectedCar");
    });

    it("defaults the target profile to the bundled per-car profile", () => {
      expect(DEFAULT_SELECTOR_TARGET_PROFILE).toBe("iRaceDeck Race Admin Per Car");
    });
  });

  describe("parseSelectedCar", () => {
    it("accepts a well-formed record", () => {
      expect(parseSelectedCar({ carIdx: 5, carNumber: "24" })).toEqual({ carIdx: 5, carNumber: "24" });
    });

    it("rejects malformed values", () => {
      expect(parseSelectedCar(undefined)).toBeNull();
      expect(parseSelectedCar(null)).toBeNull();
      expect(parseSelectedCar(5)).toBeNull(); // legacy bare-CarIdx shape
      expect(parseSelectedCar({ carIdx: -1, carNumber: "24" })).toBeNull();
      expect(parseSelectedCar({ carIdx: 5, carNumber: "" })).toBeNull();
      expect(parseSelectedCar({ carIdx: "5", carNumber: "24" })).toBeNull();
    });
  });

  describe("resolveSelectedCar", () => {
    it("returns the stored number while the CarIdx still maps to it", () => {
      expect(resolveSelectedCar({ carIdx: 5, carNumber: "24" }, () => "24")).toBe("24");
    });

    it("voids the selection when the CarIdx resolves to a different number (session changed)", () => {
      expect(resolveSelectedCar({ carIdx: 5, carNumber: "24" }, () => "7")).toBeNull();
    });

    it("voids the selection when the CarIdx no longer exists", () => {
      expect(resolveSelectedCar({ carIdx: 5, carNumber: "24" }, () => null)).toBeNull();
    });

    it("returns null for a missing or malformed stored value", () => {
      expect(resolveSelectedCar(undefined, () => "24")).toBeNull();
      expect(resolveSelectedCar(5, () => "24")).toBeNull();
    });
  });

  describe("carsPerPage", () => {
    it("subtracts the three reserved nav cells from the grid", () => {
      expect(carsPerPage(XL)).toBe(29);
      expect(carsPerPage(SD)).toBe(12);
      expect(carsPerPage(PLUS_XL)).toBe(33);
    });

    it("returns 0 for unknown grids", () => {
      expect(carsPerPage(null)).toBe(0);
      expect(carsPerPage(undefined)).toBe(0);
    });

    it("dedupes coinciding reserved corners on single-row/column grids", () => {
      expect(carsPerPage([1, 3])).toBe(1); // top-left + one bottom corner reserved
      expect(carsPerPage([4, 1])).toBe(2); // both left corners coincide
      expect(carsPerPage([1, 5])).toBe(3); // both bottom corners coincide
    });
  });

  describe("computeCarSlotIndex (XL 8×4, page 0)", () => {
    it("fills row-major starting at the cell after the top-left back button", () => {
      expect(computeCarSlotIndex(1, 0, XL, 0)).toBe(0);
      expect(computeCarSlotIndex(2, 0, XL, 0)).toBe(1);
      expect(computeCarSlotIndex(7, 0, XL, 0)).toBe(6);
      expect(computeCarSlotIndex(0, 1, XL, 0)).toBe(7);
      expect(computeCarSlotIndex(7, 2, XL, 0)).toBe(22);
    });

    it("keeps the car slots contiguous across the bottom-row nav cells", () => {
      expect(computeCarSlotIndex(1, 3, XL, 0)).toBe(23); // right after bottom-left (prev page)
      expect(computeCarSlotIndex(6, 3, XL, 0)).toBe(28); // just before bottom-right (next page)
    });

    it("returns null for the three reserved navigation cells", () => {
      expect(computeCarSlotIndex(0, 0, XL, 0)).toBeNull(); // back to default
      expect(computeCarSlotIndex(0, 3, XL, 0)).toBeNull(); // previous page
      expect(computeCarSlotIndex(7, 3, XL, 0)).toBeNull(); // next page
    });

    it("returns null for out-of-range coordinates or unknown grid", () => {
      expect(computeCarSlotIndex(8, 0, XL, 0)).toBeNull();
      expect(computeCarSlotIndex(0, 4, XL, 0)).toBeNull();
      expect(computeCarSlotIndex(-1, 0, XL, 0)).toBeNull();
      expect(computeCarSlotIndex(1, 0, null, 0)).toBeNull();
    });
  });

  describe("computeCarSlotIndex (paging)", () => {
    it("offsets by page × carsPerPage", () => {
      expect(computeCarSlotIndex(1, 0, XL, 1)).toBe(29);
      expect(computeCarSlotIndex(0, 1, XL, 2)).toBe(65); // 2*29 + 7
    });

    it("treats a negative/non-finite page as 0", () => {
      expect(computeCarSlotIndex(1, 0, XL, -3)).toBe(0);
      expect(computeCarSlotIndex(1, 0, XL, Number.NaN)).toBe(0);
    });
  });

  describe("computeCarSlotIndex (degenerate single-row/column grids)", () => {
    it("handles a single-row grid where the left corners coincide", () => {
      const grid = [4, 1] as const;
      expect(computeCarSlotIndex(0, 0, grid, 0)).toBeNull(); // back + prev coincide
      expect(computeCarSlotIndex(3, 0, grid, 0)).toBeNull(); // next page
      expect(computeCarSlotIndex(1, 0, grid, 0)).toBe(0);
      expect(computeCarSlotIndex(2, 0, grid, 0)).toBe(1);
      expect(computeCarSlotIndex(1, 0, grid, 1)).toBe(2); // page 1 continues the field
    });

    it("handles a single-column grid where the bottom corners coincide", () => {
      const grid = [1, 5] as const;
      expect(computeCarSlotIndex(0, 0, grid, 0)).toBeNull();
      expect(computeCarSlotIndex(0, 4, grid, 0)).toBeNull();
      expect(computeCarSlotIndex(0, 1, grid, 0)).toBe(0);
      expect(computeCarSlotIndex(0, 3, grid, 0)).toBe(2);
    });
  });

  describe("resolveSlotCar", () => {
    const field = [
      { carIdx: 3, carNumber: "3", carNumberRaw: 3 },
      { carIdx: 9, carNumber: "7", carNumberRaw: 7 },
      { carIdx: 1, carNumber: "24", carNumberRaw: 24 },
    ];

    it("maps a slot index into the car-number-sorted field, excluding pace car and spectators", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue(field);

      expect(resolveSlotCar({}, 0)).toEqual({ carIdx: 3, carNumber: "3" });
      expect(resolveSlotCar({}, 2)).toEqual({ carIdx: 1, carNumber: "24" });
      expect(getAllCarNumbers).toHaveBeenCalledWith({}, true, true);
    });

    it("returns null for an empty slot, a null slot, or a negative slot", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue(field);

      expect(resolveSlotCar({}, 3)).toBeNull(); // beyond the field
      expect(resolveSlotCar({}, null)).toBeNull();
      expect(resolveSlotCar({}, -1)).toBeNull();
    });
  });

  describe("generateSelectorSvg", () => {
    it("renders the car number into a data URI", () => {
      const uri = generateSelectorSvg("24", {});
      expect(uri).toContain("data:image/svg+xml");
      expect(decodeURIComponent(uri)).toContain("24");
    });

    it("scales down but still renders a 3-digit number", () => {
      expect(decodeURIComponent(generateSelectorSvg("123", {}))).toContain("123");
    });

    it("renders a blank key (no number) for an empty slot", () => {
      const decoded = decodeURIComponent(generateSelectorSvg(null, {}));
      expect(decoded).not.toMatch(/<text/);
    });
  });
});
