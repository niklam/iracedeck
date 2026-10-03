import { describe, expect, it } from "vitest";

import { sanitizeChangelogHtml } from "./changelog-html-sanitize.js";

describe("sanitizeChangelogHtml", () => {
  it("keeps the four tags the changelog generator emits", () => {
    const html = "A <strong>bold</strong> <em>thing</em> with <code>code()</code>.";

    expect(sanitizeChangelogHtml(html)).toBe(html);
  });

  it("keeps an https link and re-writes its target and rel itself", () => {
    expect(sanitizeChangelogHtml('<a href="https://iracedeck.com/docs/">docs</a>')).toBe(
      '<a href="https://iracedeck.com/docs/" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it("drops every attribute other than href", () => {
    expect(sanitizeChangelogHtml('<a href="https://iracedeck.com/" onclick="steal()" class="x">x</a>')).toBe(
      '<a href="https://iracedeck.com/" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it("keeps a bare unquoted href and still drops everything beside it", () => {
    expect(sanitizeChangelogHtml('<a href=https://x.test/ onmouseover="alert(1)">x</a>')).toBe(
      '<a href="https://x.test/" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it("escapes a link whose scheme is not http(s)", () => {
    const result = sanitizeChangelogHtml('<a href="javascript:alert(1)">x</a>');

    expect(result).not.toContain("<a");
    expect(result).toContain("&lt;a");
  });

  it("escapes a tag that is not on the allow-list", () => {
    expect(sanitizeChangelogHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes an image with an event handler", () => {
    const result = sanitizeChangelogHtml('<img src=x onerror="alert(1)">');

    expect(result).not.toContain("<img");
    expect(result).toContain("&lt;img");
  });

  it("escapes a stray closing tag that never opened", () => {
    expect(sanitizeChangelogHtml("plain </strong> text")).toBe("plain &lt;/strong&gt; text");
  });

  it("escapes an opening tag that is never closed", () => {
    expect(sanitizeChangelogHtml("dangling <strong>rest")).toBe("dangling &lt;strong&gt;rest");
  });

  it("keeps allow-listed tags nested inside a link label", () => {
    expect(sanitizeChangelogHtml('<a href="https://iracedeck.com/"><code>x</code></a>')).toBe(
      '<a href="https://iracedeck.com/" target="_blank" rel="noopener noreferrer"><code>x</code></a>',
    );
  });

  it("escapes bare angle brackets and ampersands in text", () => {
    expect(sanitizeChangelogHtml("5 < 6 && 7 > 6")).toBe("5 &lt; 6 &amp;&amp; 7 &gt; 6");
  });

  it("leaves existing entities intact rather than double-escaping them", () => {
    expect(sanitizeChangelogHtml("a &amp; b &lt;c&gt; &quot;d&quot;")).toBe("a &amp; b &lt;c&gt; &quot;d&quot;");
  });

  it("is not stateful across calls", () => {
    const html = "<strong>a</strong>";

    expect(sanitizeChangelogHtml(html)).toBe(html);
    expect(sanitizeChangelogHtml(html)).toBe(html);
  });

  it("returns an empty string for empty input", () => {
    expect(sanitizeChangelogHtml("")).toBe("");
  });

  it("escapes a tag carrying a < inside a quoted value rather than keeping it", () => {
    expect(sanitizeChangelogHtml('<a href="https://x.test/<b">x</a>')).not.toContain("<a href");
  });

  // #1101: this runs over remote text in the plugin process. The old pattern
  // was quadratic on both inputs — measured at 734 ms for 40 KB of `<a`, which
  // puts this 400 KB case near 75 s — so a bound of seconds separates the two
  // shapes by an order of magnitude either way, on any machine CI runs on.
  it.each([
    ["repeated unclosed tags", "<a".repeat(200_000)],
    ["one < before a long word", `<${"a".repeat(400_000)}`],
    ["unclosed quoted values", '<a "'.repeat(100_000)],
  ])("sanitizes %s in linear time", (_shape, html) => {
    const started = performance.now();
    const out = sanitizeChangelogHtml(html);

    expect(performance.now() - started).toBeLessThan(2000);
    expect(out).not.toContain("<a");
  });
});
