import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ICONS_DIR = path.resolve(__dirname, "..");
const PREVIEW_DIR = path.join(ICONS_DIR, "preview");

function parseDesc(svg: string): Record<string, string> | null {
  const match = svg.match(/<desc>(.*?)<\/desc>/s);

  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]) as { colors?: Record<string, string> };

    return parsed.colors ?? null;
  } catch {
    return null;
  }
}

function renderTemplate(svg: string, values: Record<string, string>): string {
  let result = svg;

  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }

  return result;
}

function collectTemplates(dir: string, base: string = dir): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory() && entry.name !== "preview" && entry.name !== "node_modules" && entry.name !== "src") {
      files.push(...collectTemplates(fullPath, base));
    } else if (entry.isFile() && entry.name.endsWith(".svg")) {
      files.push(path.relative(base, fullPath));
    }
  }

  return files;
}

describe("icon preview freshness", () => {
  const templates = collectTemplates(ICONS_DIR);

  it("should find template SVGs", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it("should have preview directory", () => {
    expect(fs.existsSync(PREVIEW_DIR)).toBe(true);
  });

  for (const relPath of templates) {
    it(`preview matches template: ${relPath}`, () => {
      const templatePath = path.join(ICONS_DIR, relPath);
      const previewPath = path.join(PREVIEW_DIR, relPath);
      const templateSvg = fs.readFileSync(templatePath, "utf-8");
      const colors = parseDesc(templateSvg);

      if (!colors) {
        // No color metadata — no preview expected
        return;
      }

      expect(fs.existsSync(previewPath), `Preview missing: preview/${relPath}`).toBe(true);

      const expectedPreview = renderTemplate(templateSvg, colors);
      const actualPreview = fs.readFileSync(previewPath, "utf-8");

      expect(actualPreview).toBe(expectedPreview);
    });
  }
});
