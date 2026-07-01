// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration.
import "./profile-switch.js";

describe("ird-profile-switch", () => {
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

  function mount(attrs: Record<string, string>): HTMLElement {
    const el = document.createElement("ird-profile-switch");

    for (const [key, value] of Object.entries(attrs)) {
      el.setAttribute(key, value);
    }

    document.body.appendChild(el);

    return el;
  }

  describe("DOM structure", () => {
    it("creates a native <button> using the label attribute", () => {
      const el = mount({ profile: "iRaceDeck Default", label: "Default" });
      const inner = el.querySelector("button");

      expect(inner).not.toBeNull();
      expect(inner!.type).toBe("button");
      expect(inner!.textContent).toBe("Default");
    });

    it("defaults the button text to the profile name", () => {
      const el = mount({ profile: "iRaceDeck Replay" });

      expect(el.querySelector("button")!.textContent).toBe("iRaceDeck Replay");
    });
  });

  describe("click behaviour", () => {
    it("sends a switchToProfile message with the profile name", () => {
      const el = mount({ profile: "iRaceDeck Default" });

      el.querySelector("button")!.click();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "switchToProfile", profile: "iRaceDeck Default" });
    });

    it("does nothing when the profile attribute is missing", () => {
      const el = mount({});

      el.querySelector("button")!.click();

      expect(send).not.toHaveBeenCalled();
    });

    it("does not throw when the sdpi-components client is unavailable", () => {
      (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
      const el = mount({ profile: "iRaceDeck Default" });

      expect(() => el.querySelector("button")!.click()).not.toThrow();
    });
  });
});
