// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import "./audio-test.js";

describe("ird-audio-test", () => {
  let button: HTMLElement;
  let field: HTMLInputElement;

  beforeEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }

    field = document.createElement("input");
    field.id = "target-field";
    document.body.appendChild(field);

    button = document.createElement("ird-audio-test");
    button.setAttribute("target", "target-field");
    document.body.appendChild(button);
  });

  describe("DOM structure", () => {
    it("creates a native <button> inside the element", () => {
      const inner = button.querySelector("button");
      expect(inner).not.toBeNull();
      expect(inner!.type).toBe("button");
    });

    it("uses the label attribute for button text", () => {
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }

      const labeled = document.createElement("ird-audio-test");
      labeled.setAttribute("target", "x");
      labeled.setAttribute("label", "Play preview");
      document.body.appendChild(labeled);

      expect(labeled.querySelector("button")!.textContent).toBe("Play preview");
    });

    it("defaults the label to 'Test' when no label attribute is set", () => {
      expect(button.querySelector("button")!.textContent).toBe("Test");
    });
  });

  describe("click behaviour", () => {
    it("writes a timestamp into the target field and dispatches a change event", () => {
      const before = Date.now();
      const handler = vi.fn();
      field.addEventListener("change", handler);

      button.querySelector("button")!.click();

      const written = Number(field.value);
      expect(Number.isFinite(written)).toBe(true);
      expect(written).toBeGreaterThanOrEqual(before);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the target id does not resolve to a field", () => {
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }

      const orphan = document.createElement("ird-audio-test");
      orphan.setAttribute("target", "does-not-exist");
      document.body.appendChild(orphan);

      expect(() => orphan.querySelector("button")!.click()).not.toThrow();
    });

    it("does nothing when the target attribute is missing", () => {
      while (document.body.firstChild) {
        document.body.removeChild(document.body.firstChild);
      }

      const untargeted = document.createElement("ird-audio-test");
      document.body.appendChild(untargeted);

      expect(() => untargeted.querySelector("button")!.click()).not.toThrow();
    });
  });
});
