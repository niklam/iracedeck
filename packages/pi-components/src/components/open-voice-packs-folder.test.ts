// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration.
import "./open-voice-packs-folder.js";

describe("ird-open-voice-packs-folder", () => {
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

  function mount(attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement("ird-open-voice-packs-folder");

    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }

    document.body.appendChild(el);

    return el;
  }

  it("renders a native <button> with a default label", () => {
    const el = mount();
    const button = el.querySelector("button");

    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Open voice packs folder");
  });

  it("honours a custom label attribute", () => {
    const el = mount({ label: "Show voices…" });

    expect(el.querySelector("button")?.textContent).toBe("Show voices…");
  });

  it("sends the openVoicePacksFolder command to the plugin on click", () => {
    const el = mount();

    el.querySelector("button")?.click();

    expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "openVoicePacksFolder" });
  });

  it("does nothing when sdpi-components has not loaded", () => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
    const el = mount();

    expect(() => el.querySelector("button")?.click()).not.toThrow();
  });
});
