import { describe, expect, it } from "vitest";

import { InlineMarkdownError, renderInlineMarkdown } from "./changelog-inline-html.mjs";

describe("renderInlineMarkdown", () => {
  it("passes plain prose through untouched", () => {
    expect(renderInlineMarkdown("A plain sentence.")).toBe("A plain sentence.");
  });

  it("renders bold, emphasis and code spans", () => {
    expect(renderInlineMarkdown("**Mode** is *the* label for `dial.setting`.")).toBe(
      "<strong>Mode</strong> is <em>the</em> label for <code>dial.setting</code>.",
    );
  });

  it("renders underscore emphasis", () => {
    expect(renderInlineMarkdown("Type _Your Name_ here.")).toBe("Type <em>Your Name</em> here.");
  });

  it("leaves underscores inside a word alone", () => {
    expect(renderInlineMarkdown("The race_ahead and race_behind variables.")).toBe(
      "The race_ahead and race_behind variables.",
    );
  });

  describe("escaping", () => {
    it("escapes markup so a bullet can never inject elements", () => {
      expect(renderInlineMarkdown('An <img src=x onerror="alert(1)"> attempt.')).toBe(
        "An &lt;img src=x onerror=&quot;alert(1)&quot;&gt; attempt.",
      );
    });

    it("escapes ampersands", () => {
      expect(renderInlineMarkdown("Rock & roll.")).toBe("Rock &amp; roll.");
    });

    it("escapes the contents of a code span", () => {
      expect(renderInlineMarkdown("Wrap `<name>` in backticks.")).toBe(
        "Wrap <code>&lt;name&gt;</code> in backticks.",
      );
    });
  });

  describe("code spans are literal", () => {
    it("does not apply emphasis inside a code span", () => {
      expect(renderInlineMarkdown("`**not bold**`")).toBe("<code>**not bold**</code>");
    });

    it("does not turn a bracketed code span into a link", () => {
      expect(renderInlineMarkdown("`[text](url)`")).toBe("<code>[text](url)</code>");
    });

    it("keeps a backslash path intact", () => {
      expect(renderInlineMarkdown("`%LOCALAPPDATA%\\iRaceDeck\\Settings\\…`")).toBe(
        "<code>%LOCALAPPDATA%\\iRaceDeck\\Settings\\…</code>",
      );
    });
  });

  describe("links", () => {
    it("makes a site-relative link absolute so it opens on the website", () => {
      expect(renderInlineMarkdown("See [Template Variables](/docs/features/template-variables/).")).toBe(
        'See <a href="https://iracedeck.com/docs/features/template-variables/" target="_blank" rel="noopener noreferrer">Template Variables</a>.',
      );
    });

    it("leaves an absolute link absolute", () => {
      expect(renderInlineMarkdown("[SimHub](https://www.simhubdash.com/)")).toBe(
        '<a href="https://www.simhubdash.com/" target="_blank" rel="noopener noreferrer">SimHub</a>',
      );
    });

    it("keeps a code span that sits inside the link label", () => {
      // Both are lifted behind sentinels, so the link's placeholder holds the code
      // span's — a single restore pass would leave the inner sentinel in the HTML.
      expect(renderInlineMarkdown("The [`Mode` dropdown](/docs/actions/) moved.")).toBe(
        'The <a href="https://iracedeck.com/docs/actions/" target="_blank" rel="noopener noreferrer">' +
          "<code>Mode</code> dropdown</a> moved.",
      );
    });

    it("escapes an ampersand in the target exactly once, so the URL still works", () => {
      expect(renderInlineMarkdown("[q](https://example.com/?a=1&b=2)")).toBe(
        '<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">q</a>',
      );
    });

    it("escapes markup in the link label", () => {
      expect(renderInlineMarkdown("[a <b> c](/docs/)")).toBe(
        '<a href="https://iracedeck.com/docs/" target="_blank" rel="noopener noreferrer">a &lt;b&gt; c</a>',
      );
    });

    it("does not let emphasis markers in a URL break the anchor", () => {
      expect(renderInlineMarkdown("[q](/search/?q=a_b_c)")).toBe(
        '<a href="https://iracedeck.com/search/?q=a_b_c" target="_blank" rel="noopener noreferrer">q</a>',
      );
    });

    it("rejects a scheme the settings window cannot open", () => {
      expect(() => renderInlineMarkdown("[click](javascript:alert(1))")).toThrow(InlineMarkdownError);
    });

    it("rejects a bare relative link, which would resolve against the plugin's own server", () => {
      expect(() => renderInlineMarkdown("[docs](docs/index.html)")).toThrow(/must start with/);
    });
  });

  it("renders a real changelog bullet", () => {
    expect(
      renderInlineMarkdown(
        "The **Camera Controls** dial now counts *down* — `#94` to `#77` — see [the dials page](/docs/features/dials/).",
      ),
    ).toBe(
      'The <strong>Camera Controls</strong> dial now counts <em>down</em> — <code>#94</code> to <code>#77</code> — ' +
        'see <a href="https://iracedeck.com/docs/features/dials/" target="_blank" rel="noopener noreferrer">the dials page</a>.',
    );
  });
});
