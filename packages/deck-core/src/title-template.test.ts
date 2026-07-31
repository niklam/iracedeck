/**
 * Tests for user-entered title template resolution (issue #899).
 *
 * getController is mocked so tests can control the template context;
 * resolveTemplate itself runs for real (pure string processing).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTitleTemplate, titleHasTemplate } from "./title-template.js";

const { mockGetCurrentTemplateContext, mockGetController } = vi.hoisted(() => {
  const mockGetCurrentTemplateContext = vi.fn();

  return {
    mockGetCurrentTemplateContext,
    mockGetController: vi.fn(() => ({ getCurrentTemplateContext: mockGetCurrentTemplateContext })),
  };
});

vi.mock("./sdk-singleton.js", () => ({
  getController: mockGetController,
}));

describe("titleHasTemplate", () => {
  it("returns false for undefined", () => {
    expect(titleHasTemplate(undefined)).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(titleHasTemplate("NEXT CAR")).toBe(false);
  });

  it("returns true for text containing a placeholder", () => {
    expect(titleHasTemplate("CAR {{track_ahead.car_number}}")).toBe(true);
  });
});

describe("resolveTitleTemplate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns text without placeholders unchanged and never consults the controller", () => {
    expect(resolveTitleTemplate("NEXT CAR")).toBe("NEXT CAR");
    expect(mockGetController).not.toHaveBeenCalled();
  });

  it("resolves {{variable}} placeholders against the current template context", () => {
    mockGetCurrentTemplateContext.mockReturnValue({
      display: { "track_ahead.car_number": "34" },
      raw: {},
    });

    expect(resolveTitleTemplate("CAR {{track_ahead.car_number}}")).toBe("CAR 34");
  });

  it("resolves {{= expression }} placeholders against the raw context", () => {
    mockGetCurrentTemplateContext.mockReturnValue({
      display: {},
      raw: { "self.position": 4 },
    });

    expect(resolveTitleTemplate("P{{= self.position + 1 }}")).toBe("P5");
  });

  it("renders variables empty when the sim is disconnected (null context)", () => {
    mockGetCurrentTemplateContext.mockReturnValue(null);

    expect(resolveTitleTemplate("CAR {{track_ahead.car_number}}")).toBe("CAR ");
  });

  it("keeps expression parse errors visible when disconnected", () => {
    mockGetCurrentTemplateContext.mockReturnValue(null);

    expect(resolveTitleTemplate("{{= self.position + }}")).toBe("{{= self.position + }}");
  });

  it("falls back to the empty context when the SDK singleton is not initialized", () => {
    mockGetController.mockImplementation(() => {
      throw new Error("SDK not initialized");
    });

    expect(resolveTitleTemplate("CAR {{track_ahead.car_number}}")).toBe("CAR ");
  });
});
