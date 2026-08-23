// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineSendToPluginButton } from "./send-to-plugin-button.js";

/**
 * The factory itself — its per-tag registration guard, per-tag style block,
 * click wiring and rejection swallowing. The two consumers (`ird-open-settings`,
 * `ird-open-folder`) have their own tests for the specific payloads.
 */
describe("defineSendToPluginButton", () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }

    send = vi.fn();
    (window as unknown as Record<string, unknown>).SDPIComponents = { streamDeckClient: { send } };
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  function mount(tag: string, attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement(tag);

    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);

    document.body.appendChild(el);

    return el;
  }

  it("registers the tag once and returns the element class; a second definition for the same tag does not throw", () => {
    const First = defineSendToPluginButton({ tag: "ird-test-button-a", defaultLabel: "A", payload: { event: "a" } });

    expect(customElements.get("ird-test-button-a")).toBe(First);
    expect(() =>
      defineSendToPluginButton({ tag: "ird-test-button-a", defaultLabel: "again", payload: { event: "again" } }),
    ).not.toThrow();
    // The first definition wins — same as customElements.define semantics without the throw.
    expect(customElements.get("ird-test-button-a")).toBe(First);
  });

  it("each tag renders its own button with its own default label and fires its own payload", () => {
    defineSendToPluginButton({ tag: "ird-test-button-b", defaultLabel: "Bee", payload: { event: "b", n: 1 } });
    defineSendToPluginButton({ tag: "ird-test-button-c", defaultLabel: "Cee", payload: { event: "c" } });

    const b = mount("ird-test-button-b");
    const c = mount("ird-test-button-c", { label: "Custom C" });

    expect(b.querySelector("button")?.textContent).toBe("Bee");
    expect(c.querySelector("button")?.textContent).toBe("Custom C");

    b.querySelector("button")?.click();
    c.querySelector("button")?.click();

    expect(send).toHaveBeenNthCalledWith(1, "sendToPlugin", { event: "b", n: 1 });
    expect(send).toHaveBeenNthCalledWith(2, "sendToPlugin", { event: "c" });
  });

  it("injects one style block per tag, however many instances mount", () => {
    defineSendToPluginButton({ tag: "ird-test-button-d", defaultLabel: "D", payload: { event: "d" } });
    const before = document.head.querySelectorAll("style").length;

    mount("ird-test-button-d");
    mount("ird-test-button-d");
    mount("ird-test-button-d");

    const styles = Array.from(document.head.querySelectorAll("style")).slice(before);

    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain("ird-test-button-d button");
  });

  describe("icon (#1024)", () => {
    const ICON = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/></svg>';

    it("renders the glyph before the label and hides it from assistive tech", () => {
      defineSendToPluginButton({
        tag: "ird-test-button-icon",
        defaultLabel: "With icon",
        payload: { event: "i" },
        icon: ICON,
      });

      const button = mount("ird-test-button-icon").querySelector("button");
      const glyph = button?.children.item(0);

      expect(glyph?.getAttribute("aria-hidden")).toBe("true");
      expect(glyph?.querySelector("svg")).not.toBeNull();
      // The label is still the button's only text, so callers can read it as such.
      expect(button?.textContent).toBe("With icon");
    });

    it("renders no glyph element when no icon is given", () => {
      defineSendToPluginButton({ tag: "ird-test-button-plain", defaultLabel: "Plain", payload: { event: "p" } });

      const button = mount("ird-test-button-plain").querySelector("button");

      expect(button?.querySelector("[aria-hidden]")).toBeNull();
      expect(button?.textContent).toBe("Plain");
    });

    it("keeps the label the button's only text when the icon is authored across lines", () => {
      // Every other inline icon in this package is a multi-line literal, so the
      // factory collapses inter-tag whitespace rather than leaving the next
      // author to discover that newlines land in the accessible name.
      defineSendToPluginButton({
        tag: "ird-test-button-multiline-icon",
        defaultLabel: "Multi",
        payload: { event: "m" },
        icon: `<svg viewBox="0 0 16 16">
  <circle cx="8" cy="8" r="4"/>
  <circle cx="8" cy="8" r="1"/>
</svg>`,
      });

      const button = mount("ird-test-button-multiline-icon").querySelector("button");

      expect(button?.textContent).toBe("Multi");
      expect(button?.querySelectorAll("circle")).toHaveLength(2);
    });
  });

  describe("size (#1024)", () => {
    /** The style block a tag injects on its first mount. */
    function styleFor(tag: string): string {
      const before = document.head.querySelectorAll("style").length;

      mount(tag);

      return Array.from(document.head.querySelectorAll("style")).slice(before)[0]?.textContent ?? "";
    }

    it("claims the full width by default — a button that closes a card", () => {
      defineSendToPluginButton({ tag: "ird-test-button-std", defaultLabel: "S", payload: { event: "s" } });

      // The bare tag rule carries the default; ordering matters only against
      // the attribute rules, which are more specific either way.
      expect(styleFor("ird-test-button-std")).toContain("ird-test-button-std button {\n          width: 100%;");
    });

    it("shrinks to its content when the tag defaults to compact", () => {
      defineSendToPluginButton({
        tag: "ird-test-button-compact",
        defaultLabel: "C",
        payload: { event: "c2" },
        defaultSize: "compact",
      });

      expect(styleFor("ird-test-button-compact")).toContain("ird-test-button-compact button {\n          width: auto;");
    });

    it("lets one element override the tag's default with a size attribute", () => {
      // settings.ejs needs the full-width pill from a tag that is compact
      // everywhere else, so both sizes ship for every tag.
      defineSendToPluginButton({
        tag: "ird-test-button-sized",
        defaultLabel: "Sized",
        payload: { event: "s2" },
        defaultSize: "compact",
      });

      const css = styleFor("ird-test-button-sized");

      expect(css).toContain('ird-test-button-sized[size="standard"] button');
      expect(css).toContain('ird-test-button-sized[size="compact"] button');
    });
  });

  it("re-connecting a mounted element does not build a second button", () => {
    defineSendToPluginButton({ tag: "ird-test-button-e", defaultLabel: "E", payload: { event: "e" } });
    const el = mount("ird-test-button-e");

    document.body.removeChild(el);
    document.body.appendChild(el);

    expect(el.querySelectorAll("button")).toHaveLength(1);
  });

  it("swallows a rejected send and does nothing without an sdpi client", async () => {
    defineSendToPluginButton({ tag: "ird-test-button-f", defaultLabel: "F", payload: { event: "f" } });
    send.mockReturnValue(Promise.reject(new Error("socket closed")));
    const el = mount("ird-test-button-f");
    const unhandled = vi.fn();

    process.on("unhandledRejection", unhandled);

    try {
      el.querySelector("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();

      (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
      expect(() => el.querySelector("button")?.click()).not.toThrow();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
