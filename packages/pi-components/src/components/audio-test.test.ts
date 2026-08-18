// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import the module to trigger custom element registration
import "./audio-test.js";

describe("ird-audio-test", () => {
  let button: HTMLElement;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }

    send = vi.fn();
    (window as unknown as Record<string, unknown>).SDPIComponents = { streamDeckClient: { send } };

    button = document.createElement("ird-audio-test");
    button.setAttribute("preview", "radar");
    document.body.appendChild(button);
  });

  afterEach(() => {
    // The window global is real global state — one test deletes it on purpose,
    // so clear it here rather than relying on the next beforeEach.
    delete (window as unknown as Record<string, unknown>).SDPIComponents;
  });

  describe("DOM structure", () => {
    it("creates a native <button> inside the element", () => {
      const inner = button.querySelector("button");
      expect(inner).not.toBeNull();
      expect(inner!.type).toBe("button");
    });

    it("uses the label attribute for button text", () => {
      const labeled = document.createElement("ird-audio-test");
      labeled.setAttribute("preview", "voice");
      labeled.setAttribute("label", "Play preview");
      document.body.appendChild(labeled);

      expect(labeled.querySelector("button")!.textContent).toBe("Play preview");
    });

    it("defaults the label to 'Test' when no label attribute is set", () => {
      expect(button.querySelector("button")!.textContent).toBe("Test");
    });
  });

  describe("click behaviour", () => {
    // Since #1003 there is one route only: the settings window owns these
    // controls, so the click always asks the plugin to run the preview. The old
    // per-action path (bumping a hidden `_test*` timestamp the Pit Crew action
    // watched) went with the controls it served.
    it("asks the plugin to play the named preview", () => {
      button.querySelector("button")!.click();

      expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "audioPreview", kind: "radar" });
    });

    it.each(["radar", "voice", "background"])("forwards the %s kind verbatim", (kind) => {
      const el = document.createElement("ird-audio-test");
      el.setAttribute("preview", kind);
      document.body.appendChild(el);

      el.querySelector("button")!.click();

      expect(send).toHaveBeenCalledWith("sendToPlugin", { event: "audioPreview", kind });
    });

    it("is inert without a preview attribute, rather than sending a malformed command", () => {
      const untargeted = document.createElement("ird-audio-test");
      document.body.appendChild(untargeted);

      expect(() => untargeted.querySelector("button")!.click()).not.toThrow();
      expect(send).not.toHaveBeenCalled();
    });

    it("does not throw when the client is unavailable", () => {
      delete (window as unknown as Record<string, unknown>).SDPIComponents;

      expect(() => button.querySelector("button")!.click()).not.toThrow();
    });
  });
});
