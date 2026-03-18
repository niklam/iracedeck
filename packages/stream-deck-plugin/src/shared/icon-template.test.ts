import { describe, expect, it } from "vitest";

import {
  escapeXml,
  generateIconText,
  parseIconDefaults,
  renderIconTemplate,
  resolveIconColors,
  validateIconTemplate,
} from "./icon-template.js";

describe("icon-template", () => {
  const validTemplate72 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
  <g filter="url(#activity-state)">
    <text x="72" y="130" class="title">{{text}}</text>
  </g>
</svg>`;

  const validTemplate144 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <g filter="url(#activity-state)">
    <text x="72" y="126" class="title">{{text}}</text>
  </g>
</svg>`;

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

  describe("validateIconTemplate", () => {
    it("should return empty array for valid 144x144 template", () => {
      const errors = validateIconTemplate(validTemplate144);

      expect(errors).toEqual([]);
    });

    it("should return empty array for valid 72x72 template (legacy)", () => {
      const errors = validateIconTemplate(validTemplate72);

      expect(errors).toEqual([]);
    });

    it("should detect missing viewBox", () => {
      const template = `<svg xmlns="http://www.w3.org/2000/svg">
        <g filter="url(#activity-state)"></g>
      </svg>`;
      const errors = validateIconTemplate(template);

      expect(errors).toContain('Missing or incorrect viewBox. Expected: viewBox="0 0 144 144"');
    });

    it("should detect incorrect viewBox", () => {
      const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g filter="url(#activity-state)"></g>
      </svg>`;
      const errors = validateIconTemplate(template);

      expect(errors).toContain('Missing or incorrect viewBox. Expected: viewBox="0 0 144 144"');
    });

    it("should detect missing activity-state filter", () => {
      const template = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
        <g></g>
      </svg>`;
      const errors = validateIconTemplate(template);

      expect(errors).toContain('Missing activity-state filter group. Expected: <g filter="url(#activity-state)">');
    });

    it("should detect missing namespace", () => {
      const template = `<svg viewBox="0 0 144 144">
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

  describe("generateIconText", () => {
    it("should generate single line text at y=124 by default", () => {
      const result = generateIconText({ text: "+5 L" });

      expect(result).toContain('y="124"');
      expect(result).toContain(">+5 L</text>");
      expect(result).toContain('class="title"');
      expect(result).toContain('font-size="28"');
    });

    it("should use custom font size", () => {
      const result = generateIconText({ text: "Test", fontSize: 18 });

      expect(result).toContain('font-size="18"');
    });

    it("should use custom baseY", () => {
      const result = generateIconText({ text: "Test", baseY: 100 });

      expect(result).toContain('y="100"');
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
      const result = generateIconText({ text: "Line 1\nLine 2", fontSize: 28, baseY: 124 });

      // 2 lines, lineHeight = 28 * 1 = 28
      // totalBlockHeight = (2-1) * 28 = 28
      // startY = 124 - 28/2 = 124 - 14 = 110
      // Line 1 at y=110, Line 2 at y=110+28=138
      expect(result).toContain('y="110"');
      expect(result).toContain('y="138"');
    });

    it("should handle three lines correctly", () => {
      const result = generateIconText({ text: "A\nB\nC", fontSize: 20, baseY: 124 });

      // 3 lines, lineHeight = 20 * 1 = 20
      // totalBlockHeight = (3-1) * 20 = 40
      // startY = 124 - 40/2 = 124 - 20 = 104
      // A at y=104, B at y=124, C at y=144
      expect(result).toContain('y="104"');
      expect(result).toContain('y="124"');
      expect(result).toContain('y="144"');
    });

    it("should respect custom lineHeightMultiplier", () => {
      const result = generateIconText({
        text: "Line 1\nLine 2",
        fontSize: 20,
        baseY: 124,
        lineHeightMultiplier: 1.5,
      });

      // lineHeight = 20 * 1.5 = 30
      // totalBlockHeight = (2-1) * 30 = 30
      // startY = 124 - 30/2 = 124 - 15 = 109
      // Line 1 at y=109, Line 2 at y=109+30=139
      expect(result).toContain('y="109"');
      expect(result).toContain('y="139"');
    });

    it("should include all required text attributes", () => {
      const result = generateIconText({ text: "Test" });

      expect(result).toContain('x="72"');
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

  describe("parseIconDefaults", () => {
    it("should parse color defaults from <desc> metadata", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
        <desc>{"colors":{"backgroundColor":"#412244","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>
        <g filter="url(#activity-state)"></g>
      </svg>`;

      const defaults = parseIconDefaults(svg);

      expect(defaults).toEqual({
        backgroundColor: "#412244",
        textColor: "#ffffff",
        graphic1Color: "#ffffff",
      });
    });

    it("should return empty object when no <desc> element", () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
        <g filter="url(#activity-state)"></g>
      </svg>`;

      expect(parseIconDefaults(svg)).toEqual({});
    });

    it("should return empty object for invalid JSON in <desc>", () => {
      const svg = `<svg><desc>not json</desc></svg>`;

      expect(parseIconDefaults(svg)).toEqual({});
    });

    it("should return empty object when <desc> has no colors key", () => {
      const svg = `<svg><desc>{"other":"data"}</desc></svg>`;

      expect(parseIconDefaults(svg)).toEqual({});
    });

    it("should handle BG + Text only icons", () => {
      const svg = `<svg><desc>{"colors":{"backgroundColor":"#2a2a2a","textColor":"#ffffff"}}</desc></svg>`;

      const defaults = parseIconDefaults(svg);

      expect(defaults).toEqual({
        backgroundColor: "#2a2a2a",
        textColor: "#ffffff",
      });
      expect(defaults.graphic1Color).toBeUndefined();
    });
  });

  describe("resolveIconColors", () => {
    const templateWithAllSlots = `<svg>
      <desc>{"colors":{"backgroundColor":"#412244","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>
    </svg>`;

    const templateBgTextOnly = `<svg>
      <desc>{"colors":{"backgroundColor":"#2a2a2a","textColor":"#ffffff"}}</desc>
    </svg>`;

    it("should return icon defaults when no overrides provided", () => {
      const colors = resolveIconColors(templateWithAllSlots, {});

      expect(colors).toEqual({
        backgroundColor: "#412244",
        textColor: "#ffffff",
        graphic1Color: "#ffffff",
      });
    });

    it("should apply global colors over icon defaults", () => {
      const colors = resolveIconColors(templateWithAllSlots, {
        backgroundColor: "#1a1a3e",
        textColor: "#d0d8ff",
      });

      expect(colors.backgroundColor).toBe("#1a1a3e");
      expect(colors.textColor).toBe("#d0d8ff");
      expect(colors.graphic1Color).toBe("#ffffff"); // falls back to icon default
    });

    it("should apply action overrides over global colors", () => {
      const colors = resolveIconColors(
        templateWithAllSlots,
        { backgroundColor: "#1a1a3e" },
        { backgroundColor: "#ff0000" },
      );

      expect(colors.backgroundColor).toBe("#ff0000"); // action override wins
    });

    it("should only return slots declared by the icon", () => {
      const colors = resolveIconColors(templateBgTextOnly, {
        backgroundColor: "#111111",
        textColor: "#eeeeee",
        graphic1Color: "#ff0000", // icon doesn't declare this slot
      });

      expect(colors).toEqual({
        backgroundColor: "#111111",
        textColor: "#eeeeee",
      });
      expect(colors).not.toHaveProperty("graphic1Color");
    });

    it("should return empty object for SVG without <desc>", () => {
      const colors = resolveIconColors("<svg></svg>", { backgroundColor: "#111111" });

      expect(colors).toEqual({});
    });

    it("should handle full chain: action > global > default", () => {
      const colors = resolveIconColors(
        templateWithAllSlots,
        { backgroundColor: "#global", textColor: "#global-text" },
        { textColor: "#action-text" },
      );

      expect(colors.backgroundColor).toBe("#global"); // global (no action override)
      expect(colors.textColor).toBe("#action-text"); // action override
      expect(colors.graphic1Color).toBe("#ffffff"); // icon default (no global or action)
    });
  });
});
