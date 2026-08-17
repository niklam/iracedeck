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

    const styles = [...document.head.querySelectorAll("style")].slice(before);

    expect(styles).toHaveLength(1);
    expect(styles[0]?.textContent).toContain("ird-test-button-d button");
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
