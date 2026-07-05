import { getAllCarNumbers } from "@iracedeck/iracing-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  availableProfilesForDevice,
  DEFAULT_SELECTOR_TARGET_PROFILE,
  deviceProfileEntries,
  generateSelectorSvg,
  pageStartSlot,
  parseSelectedCar,
  parseSelectorPage,
  resolveSelectedCar,
  resolveSlotCar,
  SELECTED_CAR_KEY,
  selectorOrdinal,
} from "./race-admin-selector.js";

vi.mock("@iracedeck/iracing-sdk", () => ({
  getAllCarNumbers: vi.fn(() => []),
  splitDriverName: vi.fn((userName: string) => {
    const trimmed = userName.trim();
    const spaceIndex = trimmed.indexOf(" ");

    if (spaceIndex === -1) return { firstName: trimmed, lastName: "" };

    return { firstName: trimmed.substring(0, spaceIndex), lastName: trimmed.substring(spaceIndex + 1) };
  }),
}));

vi.mock("../../../icons/race-admin-car-selector.svg", () => ({
  default: "<svg>{{backgroundColor}}{{borderDefs}}{{borderContent}}{{titleContent}}{{numberContent}}</svg>",
}));

vi.mock("../data/profiles.json", () => ({
  default: [
    { name: "iRaceDeck Default XL", deviceType: 2, displayName: "iRaceDeck Default" },
    { name: "iRaceDeck Race Admin Cars XL", deviceType: 2, displayName: "iRaceDeck Race Admin Cars" },
    { name: "iRaceDeck Race Admin Per Car XL", deviceType: 2, displayName: "iRaceDeck Race Admin Per Car" },
    { name: "iRaceDeck Pit Actions Mini", deviceType: 1, displayName: "iRaceDeck Pit Actions" },
  ],
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

  describe("availableProfilesForDevice", () => {
    it("filters the bundled profile list by device type, returning manifest names", () => {
      expect(availableProfilesForDevice(2)).toEqual([
        "iRaceDeck Default XL",
        "iRaceDeck Race Admin Cars XL",
        "iRaceDeck Race Admin Per Car XL",
      ]);
      expect(availableProfilesForDevice(1)).toEqual(["iRaceDeck Pit Actions Mini"]);
      expect(availableProfilesForDevice(99)).toEqual([]);
      expect(availableProfilesForDevice(undefined)).toEqual([]);
    });
  });

  describe("deviceProfileEntries", () => {
    it("pairs each manifest name with its clean display label (#753)", () => {
      expect(deviceProfileEntries(2)).toEqual([
        { name: "iRaceDeck Default XL", label: "iRaceDeck Default" },
        { name: "iRaceDeck Race Admin Cars XL", label: "iRaceDeck Race Admin Cars" },
        { name: "iRaceDeck Race Admin Per Car XL", label: "iRaceDeck Race Admin Per Car" },
      ]);
      expect(deviceProfileEntries(undefined)).toEqual([]);
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

  describe("parseSelectorPage", () => {
    it("parses a 0-based page string", () => {
      expect(parseSelectorPage("0")).toBe(0);
      expect(parseSelectorPage("3")).toBe(3);
      expect(parseSelectorPage("2.9")).toBe(2);
    });

    it("treats invalid, negative, or missing values as page 0", () => {
      expect(parseSelectorPage("")).toBe(0);
      expect(parseSelectorPage("abc")).toBe(0);
      expect(parseSelectorPage("-2")).toBe(0);
      expect(parseSelectorPage(undefined)).toBe(0);
    });
  });

  describe("selectorOrdinal", () => {
    // A partial page: five keys scattered around the grid, corners included —
    // there are no reserved cells anymore (#754).
    const keys = [
      { column: 0, row: 0 },
      { column: 3, row: 0 },
      { column: 1, row: 1 },
      { column: 0, row: 2 },
      { column: 7, row: 2 },
    ];

    it("assigns row-major ordinals regardless of placement or count", () => {
      expect(selectorOrdinal({ column: 0, row: 0 }, keys)).toBe(0);
      expect(selectorOrdinal({ column: 3, row: 0 }, keys)).toBe(1);
      expect(selectorOrdinal({ column: 1, row: 1 }, keys)).toBe(2);
      expect(selectorOrdinal({ column: 0, row: 2 }, keys)).toBe(3);
      expect(selectorOrdinal({ column: 7, row: 2 }, keys)).toBe(4);
    });

    it("works when self is not part of the list", () => {
      expect(selectorOrdinal({ column: 2, row: 1 }, keys)).toBe(3); // after (0,0), (3,0), (1,1)
    });

    it("is 0 for a single key wherever it sits", () => {
      expect(selectorOrdinal({ column: 5, row: 3 }, [{ column: 5, row: 3 }])).toBe(0);
    });
  });

  describe("pageStartSlot", () => {
    it("starts page 0 at slot 0 even with no learned counts", () => {
      expect(pageStartSlot(0, new Map())).toBe(0);
    });

    it("sums the learned counts of all earlier pages — uneven counts included", () => {
      const counts = new Map([
        [0, 29],
        [1, 12],
        [2, 5],
      ]);
      expect(pageStartSlot(1, counts)).toBe(29);
      expect(pageStartSlot(2, counts)).toBe(41);
      expect(pageStartSlot(3, counts)).toBe(46);
    });

    it("returns null while any earlier page's count is unknown", () => {
      const counts = new Map([[1, 12]]); // page 0 never visited
      expect(pageStartSlot(1, counts)).toBeNull();
      expect(pageStartSlot(2, counts)).toBeNull();
    });
  });

  describe("resolveSlotCar", () => {
    const field = [
      { carIdx: 3, carNumber: "3", carNumberRaw: 3, userName: "Max Verstappen" },
      { carIdx: 9, carNumber: "7", carNumberRaw: 7, userName: "Lando" },
      { carIdx: 1, carNumber: "24", carNumberRaw: 24, userName: "John van der Berg" },
    ];

    it("maps a slot index into the car-number-sorted field, excluding pace car and spectators", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue(field);

      expect(resolveSlotCar({}, 0)).toEqual({ carIdx: 3, carNumber: "3", lastName: "Verstappen" });
      expect(resolveSlotCar({}, 2)).toEqual({ carIdx: 1, carNumber: "24", lastName: "van der Berg" });
      expect(getAllCarNumbers).toHaveBeenCalledWith({}, true, true);
    });

    it("yields an empty last name for a single-word user name", () => {
      vi.mocked(getAllCarNumbers).mockReturnValue(field);

      expect(resolveSlotCar({}, 1)).toEqual({ carIdx: 9, carNumber: "7", lastName: "" });
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
      const uri = generateSelectorSvg({ carNumber: "24", lastName: "Doe" }, {});
      expect(uri).toContain("data:image/svg+xml");
      expect(decodeURIComponent(uri)).toContain("24");
    });

    it("renders every number at the same fixed size (sized to fit 888)", () => {
      const one = decodeURIComponent(generateSelectorSvg({ carNumber: "1" }, {}));
      const three = decodeURIComponent(generateSelectorSvg({ carNumber: "888" }, {}));
      const sizeOf = (svg: string) => /font-size="(\d+)"/.exec(svg)?.[1];
      expect(sizeOf(one)).toBe(sizeOf(three));
      expect(three).toContain("888");
    });

    it("renders the driver's last name below the number, uppercased", () => {
      const decoded = decodeURIComponent(generateSelectorSvg({ carNumber: "42", lastName: "Norris" }, {}));
      expect(decoded).toContain("NORRIS");
    });

    it("shrinks the name font for long names", () => {
      const short = decodeURIComponent(generateSelectorSvg({ carNumber: "42", lastName: "Sainz" }, {}));
      const long = decodeURIComponent(generateSelectorSvg({ carNumber: "42", lastName: "Vandoorne-Hulkenberg" }, {}));
      const sizes = (svg: string) => [...svg.matchAll(/font-size="(\d+)"/g)].map((m) => Number(m[1]));
      // [number, name] — the number size is identical, the name size shrinks.
      expect(sizes(short)[0]).toBe(sizes(long)[0]);
      expect(sizes(long)[1]!).toBeLessThan(sizes(short)[1]!);
    });

    it("renders only the number when the driver has no last name", () => {
      const decoded = decodeURIComponent(generateSelectorSvg({ carNumber: "7", lastName: "" }, {}));
      expect(decoded).toContain("7");
      expect([...decoded.matchAll(/<text/g)]).toHaveLength(1);
    });

    it("renders a blank key (no number) for an empty slot", () => {
      const decoded = decodeURIComponent(generateSelectorSvg(null, {}));
      expect(decoded).not.toMatch(/<text/);
    });
  });
});
