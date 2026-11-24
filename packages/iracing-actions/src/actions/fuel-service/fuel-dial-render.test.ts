import { describe, expect, it, vi } from "vitest";

import { PENDING_BAR_HEIGHT } from "../../shared/dial-preview.js";
import {
  buildDialReadout,
  buildRefuelBandText,
  buildValueText,
  formatDisplayValue,
  FUEL_BAR_TOP_Y,
  PENDING_BAR_TOP_Y,
  renderFuelBarSvg,
  renderFuelCanvasFor,
  renderKnobCanvasSvg,
  renderStripCanvasSvg,
  resolveBandState,
  roundedBarPath,
} from "./fuel-dial-render.js";

// Only the #612 overlay is reached from the deck-core barrel; it appends a
// recognizable marker for the assertions.
vi.mock("@iracedeck/deck-core", () => ({
  applyBindingWarning: (content: string) => `${content}<binding-warning/>`,
}));

describe("fuel-dial-render", () => {
  describe("formatDisplayValue", () => {
    it("drops decimals for whole numbers", () => {
      expect(formatDisplayValue(74, "metric")).toBe("74");
    });

    it("keeps one decimal for fractional values", () => {
      expect(formatDisplayValue(12.5, "metric")).toBe("12.5");
    });

    it("converts to gallons in english mode", () => {
      // 100L ≈ 26.4 gal
      expect(formatDisplayValue(100, "imperial")).toBe("26.4");
    });
  });

  describe("buildValueText", () => {
    it("add-amount shows +add = total with suffix", () => {
      // add 20, total 65
      expect(buildValueText("add-amount", 20, 65, 65, "metric")).toBe("+20 = 65 L");
    });

    it("add-amount caps the total at capacity in the readout (caller computes total)", () => {
      // total already capped to 90 by computeTotalLtr; add 30
      expect(buildValueText("add-amount", 30, 90, 90, "metric")).toBe("+30 = 90 L");
    });

    it("fill-to shows the integer target with an arrow", () => {
      expect(buildValueText("fill-to", 20, 65, 65, "metric")).toBe("→ 65 L");
    });

    it("fill-to still shows the target when capacity unknown", () => {
      expect(buildValueText("fill-to", 20, 65, 65, "metric")).toBe("→ 65 L");
    });

    it("converts to gallons in english mode", () => {
      // 65L ≈ 17.2 gal target
      expect(buildValueText("fill-to", 0, 65, 65, "imperial")).toBe("→ 17.2 gal");
    });
  });

  describe("roundedBarPath", () => {
    it("emits arc commands for a fully-rounded segment", () => {
      const d = roundedBarPath(0, 100, 30, true, true, 8);

      expect(d).toContain("A "); // arcs present on both ends
      expect(d.startsWith("M ")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
    });

    it("omits arcs on a square boundary (right end square)", () => {
      // current segment: left rounded, right square (butted onto add)
      const d = roundedBarPath(0, 50, 30, true, false, 8);
      const arcCount = (d.match(/A /g) ?? []).length;

      // Only the left end (2 corners) carries arcs.
      expect(arcCount).toBe(2);
    });

    it("uses no arcs when both ends are square", () => {
      const d = roundedBarPath(10, 40, 30, false, false, 8);

      expect(d).not.toContain("A ");
    });
  });

  describe("renderFuelBarSvg", () => {
    it("renders the add segment green when fuel on, current segment neutral", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "on", 184, 30, "metric");

      expect(svg).toContain("<svg");
      expect(svg).toContain("#2ecc71"); // green add segment
      expect(svg).toContain("#9aa7b4"); // neutral current segment color
    });

    it("renders the add segment gray when fuel off — the top band carries the loud state", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "off", 184, 30, "metric");

      expect(svg).toMatch(/<path[^>]*fill="#888888"/);
      expect(svg).not.toContain("#2ecc71");
      expect(svg).not.toContain("#e74c3c");
    });

    it("renders the add segment gray when the fueling state is unknown (n/a)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "na", 184, 30, "metric");

      expect(svg).toMatch(/<path[^>]*fill="#888888"/);
      expect(svg).not.toContain("#2ecc71");
      expect(svg).not.toContain("#e74c3c");
    });

    it("draws no outline around the track (the status band is the indicator)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "off", 184, 30, "metric");

      expect(svg).not.toContain('fill="none"');
      expect(svg).not.toContain("stroke=");
    });

    it("omits the add segment when there is nothing to add", () => {
      const svg = renderFuelBarSvg(45, 0, 90, "on", 184, 30, "metric");

      expect(svg).not.toMatch(/<path[^>]*fill="#2ecc71"/);
    });

    it("uses paths for the segments (rounded outer corners, square boundary) — no clipPath", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "on", 184, 30, "metric");

      expect(svg).toContain("<path");
      expect(svg).not.toContain("clipPath");
    });

    it("renders on-bar amount labels (current LEFT dark, +add RIGHT white)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "on", 184, 30, "metric");

      expect(svg).toContain('text-anchor="start"');
      expect(svg).toContain('text-anchor="end"');
      expect(svg).toContain(">45<"); // current amount
      expect(svg).toContain(">+20<"); // to-be-added amount
      // The +add label is white (sits over the green/red/gray add segment); the
      // current label is dark (sits over the light current segment).
      expect(svg).toContain('fill="#ffffff"'); // +add label
      expect(svg).toContain('fill="#0d1117"'); // current label
    });

    it("omits a segment label when its segment is too narrow to hold it", () => {
      // Tiny add (1L of a 90L tank) -> add segment far too narrow for "+1".
      const svg = renderFuelBarSvg(45, 1, 90, "on", 184, 30, "metric");

      // The current segment is wide enough; its label shows.
      expect(svg).toContain(">45<");
      // The add segment is too narrow; its label is omitted (no over-track text).
      expect(svg).not.toContain(">+1<");
    });

    it("caps the add segment to the track when current + add exceeds capacity (#681)", () => {
      // The sent add may now make current + add > capacity (e.g. 41.9 + 49 = 90.9 in
      // a 90 L tank), since the request is the amount NEEDED to reach the target and
      // more fuel burns before the stop. The bar must still cap the green segment to
      // the track — never overflow past the right edge.
      const widthPx = 184;
      const svg = renderFuelBarSvg(41.9, 49, 90, "on", widthPx, 30, "metric");

      // Every path's geometry stays within [0, widthPx]: pull all x-like numeric
      // coordinates from the segment paths and assert none exceeds the track width
      // (allow a hair for rounding).
      const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);

      expect(paths.length).toBeGreaterThan(0);

      for (const d of paths) {
        // Coordinates appear as "<num> <num>" pairs; the first of each pair is x.
        const coords = [...d.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)];

        for (const [, x] of coords) {
          expect(Number(x)).toBeLessThanOrEqual(widthPx + 0.01);
          expect(Number(x)).toBeGreaterThanOrEqual(-0.01);
        }
      }
    });

    it("draws a RED target line ONLY when a target is supplied (fill-to mode)", () => {
      const withTarget = renderFuelBarSvg(45, 20, 90, "on", 184, 30, "metric", 65);

      // The target marker is a red rect.
      expect(withTarget).toContain('fill="#e74c3c"');
    });

    it("omits the target line in add-amount mode (no target supplied)", () => {
      const withoutTarget = renderFuelBarSvg(45, 20, 90, "on", 184, 30, "metric");

      // No red marker rect when no target is supplied.
      expect(withoutTarget).not.toContain('fill="#e74c3c"');
    });

    it("keeps the target marker RED when fueling is off (the gray add segment gives it contrast)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "off", 184, 30, "metric", 65);

      expect(svg).toMatch(/<rect[^>]*fill="#e74c3c"/);
    });

    it("confines the target line to the full bar height (no overhang, unpadded viewBox)", () => {
      const svg = renderFuelBarSvg(45, 20, 90, "on", 184, 30, "metric", 65);

      // The viewBox spans exactly the bar (no vertical padding) so the track +
      // segments fill the full pixmap rect.
      const vb = /viewBox="0 (-?\d+(?:\.\d+)?) 184 (\d+(?:\.\d+)?)"/.exec(svg);

      expect(vb).not.toBeNull();
      expect(Number(vb![1])).toBe(0); // y-origin at 0, no top padding
      expect(Number(vb![2])).toBe(30); // exactly the bar height

      // The red marker rect spans the full bar height (y=0, height=bar) — confined.
      const line = /<rect[^>]*fill="#e74c3c"[^>]*\/>/.exec(svg)?.[0] ?? "";
      const lineY = /y="(-?\d+(?:\.\d+)?)"/.exec(line);
      const lineH = /height="(\d+(?:\.\d+)?)"/.exec(line);

      expect(Number(lineY?.[1])).toBe(0);
      expect(Number(lineH?.[1])).toBe(30);
    });
  });

  describe("buildRefuelBandText", () => {
    it("reads REFUEL: ON / REFUEL: OFF in manual mode", () => {
      expect(buildRefuelBandText("manual", "on")).toBe("REFUEL: ON");
      expect(buildRefuelBandText("manual", "off")).toBe("REFUEL: OFF");
    });

    it("reads REFUEL: N/A when the manual fueling state is unknown", () => {
      expect(buildRefuelBandText("manual", "na")).toBe("REFUEL: N/A");
    });

    it("reads AUTOFUEL: ON in autofuel mode whatever the fuel-fill checkbox says (#1226)", () => {
      expect(buildRefuelBandText("autofuel", "on")).toBe("AUTOFUEL: ON");
      expect(buildRefuelBandText("autofuel", "off")).toBe("AUTOFUEL: ON");
    });

    it("reads AUTOFUEL: N/A when autofuel is engaged but unavailable", () => {
      expect(buildRefuelBandText("autofuel-off", "na")).toBe("AUTOFUEL: N/A");
      expect(buildRefuelBandText("autofuel-off", "on")).toBe("AUTOFUEL: N/A");
    });
  });

  describe("resolveBandState", () => {
    it("follows the fueling state in manual mode", () => {
      expect(resolveBandState("manual", "on")).toBe("on");
      expect(resolveBandState("manual", "off")).toBe("off");
      expect(resolveBandState("manual", "na")).toBe("na");
    });

    it("is on in autofuel mode whatever the fuel-fill checkbox says (#1226)", () => {
      expect(resolveBandState("autofuel", "on")).toBe("on");
      expect(resolveBandState("autofuel", "off")).toBe("on");
    });

    it("is on in autofuel mode even when the fueling state is unknown — the switch itself is read from telemetry", () => {
      expect(resolveBandState("autofuel", "na")).toBe("on");
    });

    it("is n/a when autofuel is engaged but unavailable", () => {
      expect(resolveBandState("autofuel-off", "na")).toBe("na");
    });
  });

  describe("buildDialReadout", () => {
    it("autofuel shows the intended add as AUTO → <add> <u>", () => {
      expect(buildDialReadout("autofuel", "add-amount", 48, 90, 90, "metric")).toBe("AUTO → 48 L");
    });

    it("autofuel-off shows a dash", () => {
      expect(buildDialReadout("autofuel-off", "add-amount", 0, 45, 45, "metric")).toBe("—");
    });

    it("manual delegates to buildValueText", () => {
      expect(buildDialReadout("manual", "add-amount", 20, 65, 65, "metric")).toBe("+20 = 65 L");
      expect(buildDialReadout("manual", "fill-to", 20, 65, 65, "metric")).toBe("→ 65 L");
    });
  });

  describe("renderStripCanvasSvg", () => {
    it("is a full 200×100 canvas with the status band, readout, and bar", () => {
      const svg = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, "metric");

      expect(svg).toContain('viewBox="0 0 200 100"');
      // Green band with the REFUEL: ON cue.
      expect(svg).toMatch(/<path[^>]*fill="#2ecc71"/);
      expect(svg).toContain("REFUEL: ON");
      // Readout and the two-segment bar.
      expect(svg).toContain(">+20 = 65 L<");
      expect(svg).toContain("#9aa7b4");
    });

    it("draws a red REFUEL: OFF band when fueling is off", () => {
      const svg = renderStripCanvasSvg("manual", "add-amount", "off", 45, 20, 65, 65, 90, "metric");

      expect(svg).toMatch(/<path[^>]*fill="#e74c3c"/);
      expect(svg).toContain("REFUEL: OFF");
      expect(svg).not.toContain("#2ecc71");
    });

    it("draws the red target line in manual fill-to mode only", () => {
      const fillTo = renderStripCanvasSvg("manual", "fill-to", "on", 45, 20, 65, 65, 90, "metric");
      const addMode = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, "metric");
      const autofuel = renderStripCanvasSvg("autofuel", "add-amount", "on", 45, 20, 65, 65, 90, "metric");

      expect(fillTo).toMatch(/<rect[^>]*fill="#e74c3c"/);
      expect(addMode).not.toMatch(/<rect[^>]*fill="#e74c3c"/);
      expect(autofuel).not.toMatch(/<rect[^>]*fill="#e74c3c"/);
    });

    it("shows the AUTOFUEL band and AUTO readout in autofuel mode", () => {
      const svg = renderStripCanvasSvg("autofuel", "add-amount", "on", 45, 30, 75, 75, 90, "metric");

      expect(svg).toContain("AUTOFUEL: ON");
      expect(svg).toContain(">AUTO → 30 L<");
    });

    it("keeps a green AUTOFUEL: ON band when autofuel plans no fuel (#1226)", () => {
      // Autofuel armed with a 0 L plan clears the fuel-fill checkbox; the band
      // must still say autofuel is on — the readout carries the amount.
      const svg = renderStripCanvasSvg("autofuel", "add-amount", "off", 45, 0, 45, 45, 90, "metric");

      expect(svg).toContain("AUTOFUEL: ON");
      expect(svg).not.toContain("AUTOFUEL: OFF");
      expect(svg).toMatch(/<path[^>]*fill="#2ecc71"/);
      expect(svg).not.toMatch(/<path[^>]*fill="#e74c3c"/);
      expect(svg).toContain(">AUTO → 0 L<");
    });

    it("shows a gray AUTOFUEL: N/A band and dash readout when autofuel is unavailable", () => {
      const svg = renderStripCanvasSvg("autofuel-off", "add-amount", "na", 45, 0, 45, 45, 90, "metric");

      expect(svg).toContain("AUTOFUEL: N/A");
      expect(svg).toMatch(/<path[^>]*fill="#888888"/);
      expect(svg).toContain(">—<");
    });

    it("positions texts by explicit baselines (QT ignores dominant-baseline) — nudged down", () => {
      const svg = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, "metric");

      // The deck app's QT renderer ignores dominant-baseline, so y is the text
      // BASELINE; the values sit texts vertically centered in their areas.
      expect(svg).not.toContain("dominant-baseline");
      expect(svg).toContain('y="21"'); // band text baseline (band 0..30)
      expect(svg).toContain('y="56"'); // readout baseline (band→bar gap 30..66)
    });

    it("dims the content and draws the #612 warning glyph when the autofuel binding is missing", () => {
      const without = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, "metric");
      const withWarn = renderStripCanvasSvg("manual", "add-amount", "on", 45, 20, 65, 65, 90, "metric", true);

      expect(without).not.toContain("binding-warning");
      expect(withWarn).toContain("binding-warning");
    });

    it("previews a pending outcome in the readout slot, underlined, leaving band and bar alone (#1120)", () => {
      const pending = { text: "FUEL ON", color: "#2ecc71" };
      const svg = renderStripCanvasSvg("manual", "add-amount", "off", 45, 20, 65, 65, 90, "metric", false, pending);

      // The readout slot shows the outcome in its colour, not the live value in white.
      expect(svg).toContain(
        `fill="#2ecc71" font-family="Arial, sans-serif" font-size="24" font-weight="bold">FUEL ON<`,
      );
      expect(svg).not.toContain(">+20 = 65 L<");
      // The shared pending bar, in the same colour, sits at its own y.
      expect(svg).toMatch(
        new RegExp(`<rect data-pending-bar="true" x="\\d+" y="${PENDING_BAR_TOP_Y}"[^>]*fill="#2ecc71"`),
      );
      // The band still tells the CURRENT state, and the fuel bar is still drawn.
      expect(svg).toContain("REFUEL: OFF");
      expect(svg).toMatch(/<path[^>]*fill="#e74c3c"/);
      expect(svg).toContain("#9aa7b4");
    });

    it("draws no pending bar without a preview", () => {
      const svg = renderStripCanvasSvg("manual", "add-amount", "off", 45, 20, 65, 65, 90, "metric", false, null);

      expect(svg).not.toContain("data-pending-bar");
      expect(svg).toContain(">+20 = 65 L<");
    });

    it("keeps the pending bar above the fuel bar graphic", () => {
      expect(PENDING_BAR_TOP_Y + PENDING_BAR_HEIGHT).toBeLessThanOrEqual(FUEL_BAR_TOP_Y);
      // And the value slot's baseline sits above the bar, not on it.
      expect(PENDING_BAR_TOP_Y).toBeGreaterThan(56);
    });
  });

  describe("renderFuelCanvasFor (#1013)", () => {
    const args = ["manual", "add-amount", "on", 45, 20, 65, 65, 90, "metric", false, null] as const;

    it("draws the strip on the Stream Deck+ strip canvas", () => {
      expect(renderFuelCanvasFor({ id: "sd-plus-strip", width: 200, height: 100 }, args)).toBe(
        renderStripCanvasSvg(...args),
      );
    });

    it("draws the knob screen on the Stream Dock knob canvas", () => {
      expect(renderFuelCanvasFor({ id: "stream-dock-knob", width: 176, height: 112 }, args)).toBe(
        renderKnobCanvasSvg(...args),
      );
    });
  });

  describe("unit system (#1662)", () => {
    it("draws gallons on the strip for the imperial unit system", () => {
      const svg = renderStripCanvasSvg(
        "manual",
        "add-amount",
        "on",
        37.8541,
        37.8541,
        75.7082,
        75.7082,
        90,
        "imperial",
      );

      expect(svg).toContain(">+10 = 20 gal<");
    });

    it("draws gallons on the knob for the imperial unit system", () => {
      const svg = renderKnobCanvasSvg("manual", "fill-to", "on", 37.8541, 0, 37.8541, 75.7082, 90, "imperial");

      expect(svg).toContain(">→ 20 gal<");
    });
  });
});
