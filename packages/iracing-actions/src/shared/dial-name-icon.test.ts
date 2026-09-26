import { describe, expect, it, vi } from "vitest";

import { pushDialNameIcon } from "./dial-name-icon.js";

vi.mock("@iracedeck/deck-core", () => ({
  escapeXml: (s: string) => s,
  svgToDataUri: (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`,
}));

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), createScope: vi.fn() };
const ARGS = { line1: "SETUP", line2: "FUEL", backgroundColor: "#1a2a3a" };

function context(canvas: { id: string; width: number; height: number } | null) {
  return { id: "c", dialCanvas: () => canvas, setImage: vi.fn().mockResolvedValue(undefined) };
}

describe("pushDialNameIcon (#1013)", () => {
  it("pushes the two-line name card on the Stream Deck+ strip profile (the app's dial slot image)", async () => {
    const ctx = context({ id: "sd-plus-strip", width: 200, height: 100 });

    pushDialNameIcon(ctx as never, ARGS, logger as never);
    await Promise.resolve();

    expect(decodeURIComponent(ctx.setImage.mock.calls[0][0])).toContain(">FUEL<");
  });

  it("pushes nothing on the knob profile, where setImage IS the live screen", () => {
    const ctx = context({ id: "stream-dock-knob", width: 176, height: 112 });

    pushDialNameIcon(ctx as never, ARGS, logger as never);

    expect(ctx.setImage).not.toHaveBeenCalled();
  });

  it("pushes nothing where there is no dial canvas at all", () => {
    const ctx = context(null);

    pushDialNameIcon(ctx as never, ARGS, logger as never);

    expect(ctx.setImage).not.toHaveBeenCalled();
  });

  it("logs a failed push at debug instead of rejecting", async () => {
    const ctx = context({ id: "sd-plus-strip", width: 200, height: 100 });
    ctx.setImage.mockRejectedValueOnce(new Error("gone"));

    pushDialNameIcon(ctx as never, ARGS, logger as never);
    await new Promise((r) => setTimeout(r, 0));

    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("gone"));
  });
});
