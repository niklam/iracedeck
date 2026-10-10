import { assembleIcon, BORDER_DEFAULTS, dataUriToSvg, parseSvgViewBox } from "@iracedeck/deck-core";
import switchByCarNumberSvg from "@iracedeck/icons/camera-focus/switch-by-car-number.svg";
import switchByPositionSvg from "@iracedeck/icons/camera-focus/switch-by-position.svg";
import { describe, expect, it } from "vitest";

import { isSwitchTarget, switchTargetTemplateValues, switchTargetText } from "./switch-target-value.js";

// The real icons, not mocks: the frame constants in switch-target-value.ts
// describe this artwork, so the two are checked against each other here.
const ICONS = {
  "switch-by-car-number": switchByCarNumberSvg,
  "switch-by-position": switchByPositionSvg,
} as const;

const TITLE = {
  showTitle: true,
  showGraphics: true,
  titleText: "SWITCH\nTO CAR",
  bold: true,
  fontSize: 18,
  position: "bottom" as const,
  customPosition: 0,
};

const COLORS = { backgroundColor: "#2a3a4a", textColor: "#ffffff", graphic1Color: "#ffffff" };

function valuesFor(target: string, settings: Parameters<typeof switchTargetTemplateValues>[1]): Record<string, string> {
  const values = switchTargetTemplateValues(target, settings);

  if (!values) throw new Error(`no template values for ${target}`);

  return values;
}

/** Arial / Arimo capitals and digits stand 0.72 em above the baseline. */
const CAP_HEIGHT_EM = 0.72;

function viewBoxOf(svg: string): { width: number; height: number } {
  const viewBox = parseSvgViewBox(svg);

  if (!viewBox) throw new Error("icon has no viewBox");

  return viewBox;
}

/** Bold Arial / Arimo digits and capitals average 0.6 em — the estimate `fitValueFontSize` fits with. */
function estimatedWidth(values: Record<string, string>): number {
  return values.value.length * 0.6 * Number(values.valueFontSize);
}

describe("switch-target-value (#1352)", () => {
  describe("isSwitchTarget", () => {
    it("is true for the two modes that draw their target, and for nothing else", () => {
      expect(isSwitchTarget("switch-by-car-number")).toBe(true);
      expect(isSwitchTarget("switch-by-position")).toBe(true);
      expect(isSwitchTarget("focus-on-leader")).toBe(false);
      expect(isSwitchTarget("toString")).toBe(false);
    });
  });

  describe("switchTargetText", () => {
    it.each([
      [7, "7"],
      [42, "42"],
      [199, "199"],
      [0, "0"],
    ])("draws car number %s as its digits", (carNumber, text) => {
      expect(switchTargetText("switch-by-car-number", { carNumber })).toBe(text);
    });

    it("draws a digit string as stored, leading zeros kept (#1353)", () => {
      expect(switchTargetText("switch-by-car-number", { carNumber: "007" })).toBe("007");
    });

    it("draws 0 when no car number is set, the schema default", () => {
      expect(switchTargetText("switch-by-car-number", {})).toBe("0");
    });

    it.each([
      [1, "P1"],
      [3, "P3"],
      [12, "P12"],
      [100, "P100"],
    ])("draws position %s in the dial's P<n> notation", (position, text) => {
      expect(switchTargetText("switch-by-position", { position })).toBe(text);
    });

    it("draws P1 when no position is set, the schema default", () => {
      expect(switchTargetText("switch-by-position", {})).toBe("P1");
    });
  });

  describe("switchTargetTemplateValues", () => {
    it("returns nothing for a mode that draws no setting", () => {
      expect(switchTargetTemplateValues("focus-on-leader", { carNumber: 42, position: 3 })).toBeUndefined();
      expect(switchTargetTemplateValues("cycle-camera", {})).toBeUndefined();
    });

    it("gives the value, its font size and the baseline that centres it", () => {
      // Car number: centred on y 23 at 28 → 23 + 0.36 × 28.
      expect(valuesFor("switch-by-car-number", { carNumber: 42 })).toEqual({
        value: "42",
        valueFontSize: "28",
        valueY: "33.08",
      });
      // Position: centred on y 15.5 at 40 → 15.5 + 0.36 × 40.
      expect(valuesFor("switch-by-position", { position: 3 })).toEqual({
        value: "P3",
        valueFontSize: "40",
        valueY: "29.9",
      });
    });

    it.each([7, 42, 199])("draws car number %s at the full size", (carNumber) => {
      expect(valuesFor("switch-by-car-number", { carNumber }).valueFontSize).toBe("28");
    });

    it.each([1, 12, 100])("draws position %s at the full size", (position) => {
      expect(valuesFor("switch-by-position", { position }).valueFontSize).toBe("40");
    });

    it("shrinks a value that is too long for its frame, and keeps it centred", () => {
      const four = valuesFor("switch-by-car-number", { carNumber: 1234 });
      const six = valuesFor("switch-by-car-number", { carNumber: 123456 });

      expect(Number(four.valueFontSize)).toBeLessThan(28);
      expect(Number(six.valueFontSize)).toBeLessThan(Number(four.valueFontSize));
      // The baseline follows the size, so the digits stay centred on y 23.
      expect(Number(four.valueY)).toBeCloseTo(23 + 0.36 * Number(four.valueFontSize), 2);

      expect(Number(valuesFor("switch-by-position", { position: 1234567 }).valueFontSize)).toBeLessThan(40);
    });

    it("escapes markup, since the icon does not know what it is given", () => {
      expect(valuesFor("switch-by-car-number", { carNumber: '<b a="1">&' }).value).toBe(
        "&lt;b a=&quot;1&quot;&gt;&amp;",
      );
    });

    it("fits the font to the text as drawn, not to its escaped form", () => {
      expect(valuesFor("switch-by-car-number", { carNumber: "&" }).valueFontSize).toBe("28");
    });
  });

  describe("against the real icons", () => {
    it.each(Object.entries(ICONS))("%s carries the three value placeholders and no dominant-baseline", (_, svg) => {
      expect(svg).toContain("{{value}}");
      expect(svg).toContain('font-size="{{valueFontSize}}"');
      expect(svg).toContain('y="{{valueY}}"');
      // resvg ignores it; the baseline is computed (svg-platform-compatibility.md).
      expect(svg).not.toContain("dominant-baseline");
    });

    it.each([
      ["switch-by-car-number", { carNumber: 42 }, ">42</text>"],
      ["switch-by-car-number", { carNumber: "007" }, ">007</text>"],
      ["switch-by-position", { position: 3 }, ">P3</text>"],
    ] as const)("%s assembles with its value drawn and no placeholder left", (target, settings, drawn) => {
      const svg = dataUriToSvg(
        assembleIcon({
          graphicSvg: ICONS[target],
          colors: COLORS,
          title: TITLE,
          border: BORDER_DEFAULTS,
          graphic: { scale: 100 },
          templateValues: valuesFor(target, settings),
        }),
      );

      expect(svg).toContain(drawn);
      expect(svg).not.toContain("{{");
    });

    it("keeps every car number inside the box, clear of its stroke", () => {
      const rect = switchByCarNumberSvg.match(/<rect\b[^>]*\bwidth="([\d.]+)"[^>]*\bstroke-width="([\d.]+)"/);

      if (!rect) throw new Error("switch-by-car-number.svg has no stroked box");

      const innerWidth = Number(rect[1]) - Number(rect[2]);

      for (const carNumber of [7, 42, 199, 1234, 12345, 123456789]) {
        expect(estimatedWidth(valuesFor("switch-by-car-number", { carNumber }))).toBeLessThanOrEqual(innerWidth);
      }
    });

    it("keeps every position inside the icon's frame", () => {
      const viewBox = parseSvgViewBox(switchByPositionSvg);

      if (!viewBox) throw new Error("switch-by-position.svg has no viewBox");

      for (const position of [1, 12, 100, 1000, 123456789]) {
        expect(estimatedWidth(valuesFor("switch-by-position", { position }))).toBeLessThanOrEqual(viewBox.width);
      }
    });

    it("trims the car-number viewBox to the box, which is the whole artwork", () => {
      const rect = switchByCarNumberSvg.match(
        /<rect\b[^>]*\bx="([\d.]+)"[^>]*\by="([\d.]+)"[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"[^>]*\bstroke-width="([\d.]+)"/,
      );

      if (!rect) throw new Error("switch-by-car-number.svg has no stroked box");

      const [x, y, width, height, strokeWidth] = rect.slice(1).map(Number);
      const viewBox = viewBoxOf(switchByCarNumberSvg);

      // The stroke's outer edge sits exactly the 1-unit margin inside each side:
      // a larger frame would shrink the number on the key.
      expect(x - strokeWidth / 2).toBe(1);
      expect(y - strokeWidth / 2).toBe(1);
      expect(x + width + strokeWidth / 2).toBe(viewBox.width - 1);
      expect(y + height + strokeWidth / 2).toBe(viewBox.height - 1);
      // No label under the box: the title, or the number itself, says what it is.
      expect(switchByCarNumberSvg.match(/<text\b/g)).toHaveLength(1);
    });

    it("trims the position viewBox to the value at full size, which is the whole artwork", () => {
      const viewBox = viewBoxOf(switchByPositionSvg);
      // At full size, the tallest the value is drawn.
      const { valueFontSize, valueY } = valuesFor("switch-by-position", { position: 12 });
      const top = Number(valueY) - CAP_HEIGHT_EM * Number(valueFontSize);
      const bottomMargin = viewBox.height - Number(valueY);

      // The 1-unit margin above the capitals and below the baseline, and no more
      // than a fraction over it: a taller frame would shrink the value on the key.
      expect(top).toBeGreaterThanOrEqual(1);
      expect(top).toBeLessThan(1.5);
      expect(bottomMargin).toBeGreaterThanOrEqual(1);
      expect(bottomMargin).toBeLessThan(1.5);
      // No label under the value: the P, or the title, says what it is.
      expect(switchByPositionSvg.match(/<text\b/g)).toHaveLength(1);
    });

    it("centres the position in its viewBox, whatever size it is drawn at", () => {
      const viewBox = viewBoxOf(switchByPositionSvg);

      for (const position of [1, 100, 1234567]) {
        const { valueFontSize, valueY } = valuesFor("switch-by-position", { position });

        expect(Number(valueY) - 0.36 * Number(valueFontSize)).toBeCloseTo(viewBox.height / 2, 1);
      }
    });

    it("centres the value in the car-number box", () => {
      const rect = switchByCarNumberSvg.match(/<rect\b[^>]*\by="([\d.]+)"[^>]*\bheight="([\d.]+)"/);

      if (!rect) throw new Error("switch-by-car-number.svg has no box");

      const boxCentre = Number(rect[1]) + Number(rect[2]) / 2;
      const { valueFontSize, valueY } = valuesFor("switch-by-car-number", { carNumber: 42 });

      expect(Number(valueY) - 0.36 * Number(valueFontSize)).toBeCloseTo(boxCentre, 2);
    });
  });
});
