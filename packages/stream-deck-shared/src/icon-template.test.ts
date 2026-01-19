import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearTemplateCache,
  escapeXml,
  generateIconText,
  loadIconTemplate,
  renderIcon,
  renderIconTemplate,
  validateIconTemplate,
} from "./icon-template.js";

describe("icon-template", () => {
  const testDir = join(import.meta.dirname, "__test-templates__");
  const validTemplate = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <text x="36" y="65" class="title">{{text}}</text>
  </g>
</svg>`;

  beforeEach(() => {
    clearTemplateCache();
    mkdirSync(join(testDir, "imgs", "actions", "test-action"), { recursive: true });
    writeFileSync(join(testDir, "imgs", "actions", "test-action", "key-template.svg"), validTemplate);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("escapeXml", () => {
    it("should escape ampersand", () => {
      expect(escapeXml("A & B")).toBe("A &amp; B");
    });

    it("should escape less than", () => {
      expect(escapeXml("A < B")).toBe("A &lt; B");
    });

    it("should escape greater than", () => {
      expect(escapeXml("A > B")).toBe("A &gt; B");
    });

    it("should escape double quotes", () => {
      expect(escapeXml('Say "hello"')).toBe("Say &quot;hello&quot;");
    });

    it("should escape single quotes", () => {
      expect(escapeXml("It's")).toBe("It&apos;s");
    });

    it("should handle multiple special characters", () => {
      expect(escapeXml('<script>alert("xss")</script>')).toBe("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    });

    it("should leave normal text unchanged", () => {
      expect(escapeXml("Hello World 123")).toBe("Hello World 123");
    });
  });

  describe("loadIconTemplate", () => {
    it("should load template from file system", () => {
      const template = loadIconTemplate(testDir, "test-action");

      expect(template).toBe(validTemplate);
    });

    it("should cache loaded templates", () => {
      const template1 = loadIconTemplate(testDir, "test-action");
      const template2 = loadIconTemplate(testDir, "test-action");

      expect(template1).toBe(template2);
    });

    it("should throw for non-existent template", () => {
      expect(() => loadIconTemplate(testDir, "non-existent")).toThrow();
    });
  });

  describe("renderIconTemplate", () => {
    it("should replace single placeholder", () => {
      const template = "<svg>{{name}}</svg>";
      const result = renderIconTemplate(template, { name: "Hello" });

      expect(result).toBe("<svg>Hello</svg>");
    });

    it("should replace multiple placeholders", () => {
      const template = "<svg>{{a}} and {{b}}</svg>";
      const result = renderIconTemplate(template, { a: "First", b: "Second" });

      expect(result).toBe("<svg>First and Second</svg>");
    });

    it("should replace same placeholder multiple times", () => {
      const template = "<svg>{{x}} + {{x}} = {{x}}{{x}}</svg>";
      const result = renderIconTemplate(template, { x: "1" });

      expect(result).toBe("<svg>1 + 1 = 11</svg>");
    });

    it("should leave unmatched placeholders unchanged", () => {
      const template = "<svg>{{known}} and {{unknown}}</svg>";
      const result = renderIconTemplate(template, { known: "Hello" });

      expect(result).toBe("<svg>Hello and {{unknown}}</svg>");
    });

    it("should handle empty values", () => {
      const template = "<svg>{{empty}}</svg>";
      const result = renderIconTemplate(template, { empty: "" });

      expect(result).toBe("<svg></svg>");
    });

    it("should handle SVG content in values", () => {
      const template = "<svg>{{content}}</svg>";
      const result = renderIconTemplate(template, { content: '<rect fill="#ff0000"/>' });

      expect(result).toBe('<svg><rect fill="#ff0000"/></svg>');
    });
  });

  describe("renderIcon", () => {
    it("should load, render, and convert to data URI", () => {
      const result = renderIcon(testDir, "test-action", { text: "Hello" });

      expect(result.startsWith("data:image/svg+xml;base64,")).toBe(true);

      // Decode and verify content
      const decoded = Buffer.from(result.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf-8");

      expect(decoded).toContain("Hello");
      expect(decoded).not.toContain("{{text}}");
    });

    it("should use cached template on subsequent calls", () => {
      const result1 = renderIcon(testDir, "test-action", { text: "First" });
      const result2 = renderIcon(testDir, "test-action", { text: "Second" });

      // Both should be valid data URIs
      expect(result1.startsWith("data:image/svg+xml;base64,")).toBe(true);
      expect(result2.startsWith("data:image/svg+xml;base64,")).toBe(true);

      // But with different content
      expect(result1).not.toBe(result2);
    });
  });

  describe("validateIconTemplate", () => {
    it("should return empty array for valid template", () => {
      const errors = validateIconTemplate(validTemplate);

      expect(errors).toEqual([]);
    });

    it("should detect missing viewBox", () => {
      const template = `<svg xmlns="http://www.w3.org/2000/svg">
        <g filter="url(#activity-state)"></g>
      </svg>`;
      const errors = validateIconTemplate(template);

      expect(errors).toContain('Missing or incorrect viewBox. Expected: viewBox="0 0 72 72"');
    });

    it("should detect incorrect viewBox", () => {
      const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g filter="url(#activity-state)"></g>
      </svg>`;
      const errors = validateIconTemplate(template);

      expect(errors).toContain('Missing or incorrect viewBox. Expected: viewBox="0 0 72 72"');
    });

    it("should detect missing activity-state filter", () => {
      const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
        <g></g>
      </svg>`;
      const errors = validateIconTemplate(template);

      expect(errors).toContain('Missing activity-state filter group. Expected: <g filter="url(#activity-state)">');
    });

    it("should detect missing namespace", () => {
      const template = `<svg viewBox="0 0 72 72">
        <g filter="url(#activity-state)"></g>
      </svg>`;
      const errors = validateIconTemplate(template);

      expect(errors).toContain('Missing SVG namespace. Expected: xmlns="http://www.w3.org/2000/svg"');
    });

    it("should report multiple errors", () => {
      const template = "<svg><g></g></svg>";
      const errors = validateIconTemplate(template);

      expect(errors.length).toBe(3);
    });
  });

  describe("clearTemplateCache", () => {
    it("should clear all cached templates", () => {
      // Load a template to populate cache
      loadIconTemplate(testDir, "test-action");

      // Modify the file
      const modifiedTemplate = validTemplate.replace("{{text}}", "{{modified}}");

      writeFileSync(join(testDir, "imgs", "actions", "test-action", "key-template.svg"), modifiedTemplate);

      // Should still return cached version
      const cached = loadIconTemplate(testDir, "test-action");

      expect(cached).toBe(validTemplate);

      // Clear cache and reload
      clearTemplateCache();

      const fresh = loadIconTemplate(testDir, "test-action");

      expect(fresh).toBe(modifiedTemplate);
    });
  });

  describe("generateIconText", () => {
    it("should generate single line text at y=62 by default", () => {
      const result = generateIconText({ text: "+5 L" });

      expect(result).toContain('y="62"');
      expect(result).toContain(">+5 L</text>");
      expect(result).toContain('class="title"');
      expect(result).toContain('font-size="14"');
    });

    it("should use custom font size", () => {
      const result = generateIconText({ text: "Test", fontSize: 18 });

      expect(result).toContain('font-size="18"');
    });

    it("should use custom baseY", () => {
      const result = generateIconText({ text: "Test", baseY: 50 });

      expect(result).toContain('y="50"');
    });

    it("should escape XML characters in text", () => {
      const result = generateIconText({ text: "<test>" });

      expect(result).toContain("&lt;test&gt;");
    });

    it("should generate multiple text elements for multi-line text", () => {
      const result = generateIconText({ text: "Line 1\nLine 2" });

      expect(result).toContain(">Line 1</text>");
      expect(result).toContain(">Line 2</text>");
      // Should have two separate <text> elements
      expect(result.match(/<text/g)?.length).toBe(2);
    });

    it("should center multi-line text around baseY", () => {
      const result = generateIconText({ text: "Line 1\nLine 2", fontSize: 14, baseY: 62 });

      // 2 lines, lineHeight = 14 * 1 = 14
      // totalBlockHeight = (2-1) * 14 = 14
      // startY = 62 - 14/2 = 62 - 7 = 55
      // Line 1 at y=55, Line 2 at y=55+14=69
      expect(result).toContain('y="55"');
      expect(result).toContain('y="69"');
    });

    it("should handle three lines correctly", () => {
      const result = generateIconText({ text: "A\nB\nC", fontSize: 10, baseY: 62 });

      // 3 lines, lineHeight = 10 * 1 = 10
      // totalBlockHeight = (3-1) * 10 = 20
      // startY = 62 - 20/2 = 62 - 10 = 52
      // A at y=52, B at y=62, C at y=72
      expect(result).toContain('y="52"');
      expect(result).toContain('y="62"');
      expect(result).toContain('y="72"');
    });

    it("should respect custom lineHeightMultiplier", () => {
      const result = generateIconText({
        text: "Line 1\nLine 2",
        fontSize: 10,
        baseY: 62,
        lineHeightMultiplier: 1.5,
      });

      // lineHeight = 10 * 1.5 = 15
      // totalBlockHeight = (2-1) * 15 = 15
      // startY = 62 - 15/2 = 62 - 7.5 = 54.5
      // Line 1 at y=54.5, Line 2 at y=54.5+15=69.5
      expect(result).toContain('y="54.5"');
      expect(result).toContain('y="69.5"');
    });

    it("should include all required text attributes", () => {
      const result = generateIconText({ text: "Test" });

      expect(result).toContain('x="36"');
      expect(result).toContain('text-anchor="middle"');
      expect(result).toContain('dominant-baseline="central"');
      expect(result).toContain('fill="#ffffff"');
      expect(result).toContain('font-family="sans-serif"');
      expect(result).toContain('font-weight="bold"');
    });

    it("should use custom fill color", () => {
      const result = generateIconText({ text: "Test", fill: "#FF4444" });

      expect(result).toContain('fill="#FF4444"');
      expect(result).not.toContain('fill="#ffffff"');
    });

    it("should apply custom fill color to multi-line text", () => {
      const result = generateIconText({ text: "Line 1\nLine 2", fill: "#00FF00" });

      // Both lines should have the custom fill color
      const fillMatches = result.match(/fill="#00FF00"/g);

      expect(fillMatches?.length).toBe(2);
    });
  });
});
