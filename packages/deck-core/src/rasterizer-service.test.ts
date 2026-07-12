import { afterEach, describe, expect, it, vi } from "vitest";

import { svgToDataUri } from "./overlay-utils.js";
import {
  _resetRasterizer,
  initializeRasterizer,
  isRasterizerInitialized,
  isSvgDataUri,
  toDeviceImage,
} from "./rasterizer-service.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#123"/></svg>`;
const SVG_URI = svgToDataUri(SVG);
const FAKE_PNG = Buffer.from("fake-png-bytes");

afterEach(() => {
  _resetRasterizer();
});

describe("isSvgDataUri", () => {
  it("detects SVG data URIs and rejects PNG data URIs and raw strings", () => {
    expect(isSvgDataUri(SVG_URI)).toBe(true);
    expect(isSvgDataUri("data:image/png;base64,AAAA")).toBe(false);
    expect(isSvgDataUri(SVG)).toBe(false);
  });
});

describe("toDeviceImage", () => {
  it("passes input through unchanged when the service is not initialized", async () => {
    expect(isRasterizerInitialized()).toBe(false);
    await expect(toDeviceImage("ctx1", SVG_URI, 144)).resolves.toBe(SVG_URI);
  });

  it("converts an SVG data URI to a PNG data URI, handing the render fn the RAW svg and target px", async () => {
    const render = vi.fn().mockResolvedValue(FAKE_PNG);
    initializeRasterizer(render);
    const result = await toDeviceImage("ctx1", SVG_URI, 192);
    expect(render).toHaveBeenCalledWith(SVG, 192);
    expect(result).toBe(`data:image/png;base64,${FAKE_PNG.toString("base64")}`);
  });

  it("passes non-SVG input through without rendering", async () => {
    const render = vi.fn().mockResolvedValue(FAKE_PNG);
    initializeRasterizer(render);
    await expect(toDeviceImage("ctx1", "data:image/png;base64,AAAA", 144)).resolves.toBe("data:image/png;base64,AAAA");
    expect(render).not.toHaveBeenCalled();
  });

  it("caches by (targetPx, svg) — identical input renders once", async () => {
    const render = vi.fn().mockResolvedValue(FAKE_PNG);
    initializeRasterizer(render);
    await toDeviceImage("ctx1", SVG_URI, 144);
    await toDeviceImage("ctx2", SVG_URI, 144);
    expect(render).toHaveBeenCalledTimes(1);
    await toDeviceImage("ctx1", SVG_URI, 240);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("returns null for a stale request superseded by a newer one on the same contextKey", async () => {
    let releaseFirst!: (png: Buffer) => void;
    const slow = new Promise<Buffer>((resolve) => {
      releaseFirst = resolve;
    });
    const OTHER_URI = svgToDataUri(SVG.replace("#123", "#456"));
    const render = vi.fn().mockReturnValueOnce(slow).mockResolvedValue(FAKE_PNG);
    initializeRasterizer(render);

    const first = toDeviceImage("ctx1", SVG_URI, 144);
    const second = await toDeviceImage("ctx1", OTHER_URI, 144);
    releaseFirst(FAKE_PNG);

    expect(second).toBe(`data:image/png;base64,${FAKE_PNG.toString("base64")}`);
    await expect(first).resolves.toBeNull();
  });

  it("falls back to the original SVG data URI when the render fn rejects, and does not cache the failure", async () => {
    const render = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(FAKE_PNG);
    initializeRasterizer(render);
    await expect(toDeviceImage("ctx1", SVG_URI, 144)).resolves.toBe(SVG_URI);
    await expect(toDeviceImage("ctx1", SVG_URI, 144)).resolves.toBe(
      `data:image/png;base64,${FAKE_PNG.toString("base64")}`,
    );
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("throws on double initialization", () => {
    initializeRasterizer(vi.fn());
    expect(() => initializeRasterizer(vi.fn())).toThrow(/already initialized/);
  });
});
