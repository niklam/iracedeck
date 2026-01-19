import { validateIconTemplate } from "@iracedeck/stream-deck-shared";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const iconsDir = join(import.meta.dirname, "..", "icons");

describe("icon templates", () => {
  const svgFiles = readdirSync(iconsDir).filter((file) => file.endsWith(".svg"));

  it("should have at least one template file", () => {
    expect(svgFiles.length).toBeGreaterThan(0);
  });

  svgFiles.forEach((file) => {
    describe(file, () => {
      const content = readFileSync(join(iconsDir, file), "utf-8");

      it("should have valid SVG structure", () => {
        const errors = validateIconTemplate(content);

        expect(errors).toEqual([]);
      });

      it("should have 72x72 viewBox", () => {
        expect(content).toContain('viewBox="0 0 72 72"');
      });

      it("should have activity-state filter group", () => {
        expect(content).toContain('filter="url(#activity-state)"');
      });

      it("should have SVG namespace", () => {
        expect(content).toContain('xmlns="http://www.w3.org/2000/svg"');
      });
    });
  });
});
