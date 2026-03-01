import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseAction } from "./base-action.js";
import { applyInactiveOverlay, overlayConfig } from "./overlay-utils.js";

// Mock KeyAction
function createMockKeyAction(id: string) {
  return {
    id,
    isKey: vi.fn().mockReturnValue(true),
    setImage: vi.fn().mockResolvedValue(undefined),
  };
}

// Mock event with action
function createMockEvent<T>(actionId: string, settings: T = {} as T) {
  const action = createMockKeyAction(actionId);

  return {
    action,
    payload: { settings },
  };
}

// Concrete implementation for testing
class TestAction extends BaseAction<{ testSetting?: string }> {
  async setImage(ev: any, svg: string): Promise<void> {
    await this.setKeyImage(ev, svg);
  }

  async updateImage(contextId: string, svg: string): Promise<boolean> {
    return this.updateKeyImage(contextId, svg);
  }

  getStoredImage(contextId: string): string | undefined {
    return this.getKeyImage(contextId);
  }
}

describe("BaseAction", () => {
  let testAction: TestAction;

  beforeEach(() => {
    testAction = new TestAction();
    // Enable overlay for tests (disabled by default in production)
    overlayConfig.inactiveOverlayEnabled = true;
  });

  afterEach(() => {
    overlayConfig.inactiveOverlayEnabled = false;
  });

  describe("setKeyImage", () => {
    it("should store the original SVG", async () => {
      const ev = createMockEvent("context-1");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

      await testAction.setImage(ev, svg);

      expect(testAction.getStoredImage("context-1")).toBe(svg);
    });

    it("should call action.setImage with the SVG when active", async () => {
      const ev = createMockEvent("context-1");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

      await testAction.setImage(ev, svg);

      expect(ev.action.setImage).toHaveBeenCalledWith(svg);
    });

    it("should apply grayscale overlay when inactive", async () => {
      const ev = createMockEvent("context-1");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" fill="#ff0000"></svg>';

      testAction.setActive(false);
      await testAction.setImage(ev, svg);

      // setKeyImage applies overlay when inactive
      expect(ev.action.setImage).toHaveBeenCalledWith(applyInactiveOverlay(svg));
    });

    it("should store original SVG even when inactive", async () => {
      const ev = createMockEvent("context-1");
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" fill="#ff0000"></svg>';

      testAction.setActive(false);
      await testAction.setImage(ev, svg);

      // Original SVG is stored, not the grayscale version
      expect(testAction.getStoredImage("context-1")).toBe(svg);
    });

    it("should not call setImage for non-key actions", async () => {
      const ev = createMockEvent("context-1");

      ev.action.isKey.mockReturnValue(false);

      await testAction.setImage(ev, "<svg></svg>");

      expect(ev.action.setImage).not.toHaveBeenCalled();
    });

    it("should update stored SVG when called multiple times", async () => {
      const ev = createMockEvent("context-1");

      await testAction.setImage(ev, "<svg>first</svg>");
      await testAction.setImage(ev, "<svg>second</svg>");

      expect(testAction.getStoredImage("context-1")).toBe("<svg>second</svg>");
    });
  });

  describe("setActive", () => {
    it("should update isActive state", () => {
      expect(testAction.getIsActive()).toBe(true);

      testAction.setActive(false);

      expect(testAction.getIsActive()).toBe(false);

      testAction.setActive(true);

      expect(testAction.getIsActive()).toBe(true);
    });

    it("should not trigger any action when state hasn't changed", async () => {
      const ev = createMockEvent("context-1");

      await testAction.setImage(ev, "<svg></svg>");
      ev.action.setImage.mockClear();

      // Set to true when already true
      testAction.setActive(true);

      expect(ev.action.setImage).not.toHaveBeenCalled();
    });

    it("should refresh all contexts with grayscale overlay when becoming inactive", async () => {
      const ev1 = createMockEvent("context-1");
      const ev2 = createMockEvent("context-2");

      const svg1 = '<svg id="1" fill="#ff0000"></svg>';
      const svg2 = '<svg id="2" fill="#00ff00"></svg>';

      await testAction.setImage(ev1, svg1);
      await testAction.setImage(ev2, svg2);

      ev1.action.setImage.mockClear();
      ev2.action.setImage.mockClear();

      testAction.setActive(false);

      // BaseAction refreshes all contexts with grayscale overlay
      expect(ev1.action.setImage).toHaveBeenCalledWith(applyInactiveOverlay(svg1));
      expect(ev2.action.setImage).toHaveBeenCalledWith(applyInactiveOverlay(svg2));
    });

    it("should refresh all contexts with original images when becoming active", async () => {
      const ev1 = createMockEvent("context-1");
      const ev2 = createMockEvent("context-2");

      const svg1 = '<svg id="1" fill="#ff0000"></svg>';
      const svg2 = '<svg id="2" fill="#00ff00"></svg>';

      await testAction.setImage(ev1, svg1);
      await testAction.setImage(ev2, svg2);

      testAction.setActive(false);

      ev1.action.setImage.mockClear();
      ev2.action.setImage.mockClear();

      testAction.setActive(true);

      // BaseAction refreshes all contexts with original images
      expect(ev1.action.setImage).toHaveBeenCalledWith(svg1);
      expect(ev2.action.setImage).toHaveBeenCalledWith(svg2);
    });
  });

  describe("onWillDisappear", () => {
    it("should clear stored context", async () => {
      const ev = createMockEvent("context-1") as any;

      await testAction.setImage(ev, "<svg></svg>");

      expect(testAction.getStoredImage("context-1")).toBeDefined();

      await testAction.onWillDisappear(ev);

      expect(testAction.getStoredImage("context-1")).toBeUndefined();
    });

    it("should not affect other contexts", async () => {
      const ev1 = createMockEvent("context-1") as any;
      const ev2 = createMockEvent("context-2") as any;

      await testAction.setImage(ev1, "<svg>1</svg>");
      await testAction.setImage(ev2, "<svg>2</svg>");

      await testAction.onWillDisappear(ev1);

      expect(testAction.getStoredImage("context-1")).toBeUndefined();
      expect(testAction.getStoredImage("context-2")).toBe("<svg>2</svg>");
    });

    it("should remove context from storage", async () => {
      const ev = createMockEvent("context-1") as any;

      await testAction.setImage(ev, "<svg></svg>");
      await testAction.onWillDisappear(ev);

      expect(testAction.getStoredImage("context-1")).toBeUndefined();
    });
  });

  describe("getIsActive", () => {
    it("should return true by default", () => {
      expect(testAction.getIsActive()).toBe(true);
    });

    it("should reflect current active state", () => {
      testAction.setActive(false);

      expect(testAction.getIsActive()).toBe(false);

      testAction.setActive(true);

      expect(testAction.getIsActive()).toBe(true);
    });
  });

  describe("updateKeyImage", () => {
    it("should update the stored SVG", async () => {
      const ev = createMockEvent("context-1");

      await testAction.setImage(ev, "<svg>original</svg>");
      await testAction.updateImage("context-1", "<svg>updated</svg>");

      expect(testAction.getStoredImage("context-1")).toBe("<svg>updated</svg>");
    });

    it("should call action.setImage with the new SVG", async () => {
      const ev = createMockEvent("context-1");

      await testAction.setImage(ev, "<svg>original</svg>");
      ev.action.setImage.mockClear();

      await testAction.updateImage("context-1", "<svg>updated</svg>");

      expect(ev.action.setImage).toHaveBeenCalledWith("<svg>updated</svg>");
    });

    it("should apply grayscale overlay when inactive", async () => {
      const ev = createMockEvent("context-1");
      const updatedSvg = '<svg fill="#ff0000">updated</svg>';

      await testAction.setImage(ev, "<svg>original</svg>");
      testAction.setActive(false);
      ev.action.setImage.mockClear();

      await testAction.updateImage("context-1", updatedSvg);

      // updateKeyImage applies overlay when inactive
      expect(ev.action.setImage).toHaveBeenCalledWith(applyInactiveOverlay(updatedSvg));
    });

    it("should store original SVG even when inactive", async () => {
      const ev = createMockEvent("context-1");
      const updatedSvg = '<svg fill="#ff0000">updated</svg>';

      await testAction.setImage(ev, "<svg>original</svg>");
      testAction.setActive(false);

      await testAction.updateImage("context-1", updatedSvg);

      // Original SVG is stored, not the grayscale version
      expect(testAction.getStoredImage("context-1")).toBe(updatedSvg);
    });

    it("should return false for unknown context", async () => {
      const result = await testAction.updateImage("unknown-context", "<svg></svg>");

      expect(result).toBe(false);
    });

    it("should return true for known context", async () => {
      const ev = createMockEvent("context-1");

      await testAction.setImage(ev, "<svg>original</svg>");

      const result = await testAction.updateImage("context-1", "<svg>updated</svg>");

      expect(result).toBe(true);
    });
  });

  describe("multiple action instances", () => {
    it("should have independent active states", async () => {
      const action1 = new TestAction();
      const action2 = new TestAction();

      action1.setActive(false);

      expect(action1.getIsActive()).toBe(false);
      expect(action2.getIsActive()).toBe(true);
    });

    it("should have independent image stores", async () => {
      const action1 = new TestAction();
      const action2 = new TestAction();

      const ev1 = createMockEvent("context-1");
      const ev2 = createMockEvent("context-2");

      await action1.setImage(ev1, "<svg>action1</svg>");
      await action2.setImage(ev2, "<svg>action2</svg>");

      expect(action1.getStoredImage("context-1")).toBe("<svg>action1</svg>");
      expect(action1.getStoredImage("context-2")).toBeUndefined();

      expect(action2.getStoredImage("context-2")).toBe("<svg>action2</svg>");
      expect(action2.getStoredImage("context-1")).toBeUndefined();
    });
  });
});
