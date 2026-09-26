/**
 * Rasterizer Service
 *
 * Converts device-bound SVG data URIs to PNG data URIs through an injected
 * render function (each plugin injects @iracedeck/rasterizer's resvg
 * renderer, gated by the __FEATURE_PNG_RASTERIZATION__ platform flag).
 *
 * When the service is NOT initialized (flag off, unit tests), toDeviceImage
 * passes every input through unchanged — the SVG data URI ships to the host
 * exactly as before, so this module is invisible until a plugin opts in.
 */
import { dataUriToSvg } from "@iracedeck/icon-composer";
import { type ILogger, silentLogger } from "@iracedeck/logger";

import { SD_PLUS_STRIP_CANVAS } from "./dial-canvas.js";

/** A device-bound image's target box. A bare number is the legacy square/width-only form. */
export interface DeviceImageSize {
  width: number;
  height: number;
}

/**
 * Renders `svg` to a PNG. With `heightPx` omitted the width alone drives the
 * scale (every key icon; the SVG's own aspect decides the height). With it
 * given the result FITS the width×height box — see `@iracedeck/rasterizer`.
 */
export type SvgRenderFn = (svg: string, widthPx: number, heightPx?: number) => Promise<Buffer>;

const SVG_DATA_URI_PREFIX = "data:image/svg+xml";

/** Elgato touch-strip slot width in px — dial pixmaps rasterize at this width. */
export const TOUCH_STRIP_SLOT_WIDTH = SD_PLUS_STRIP_CANVAS.width;

/**
 * LRU cap: 512 entries — worst case ~15-25 MB (240px PNGs, base64-encoded, keys
 * and values both counted). All static icons fit well within the cap; high-churn
 * dynamic icons (e.g. live telemetry values) evict the oldest entries first.
 */
const CACHE_MAX_ENTRIES = 512;

export function isSvgDataUri(value: string): boolean {
  return value.startsWith(SVG_DATA_URI_PREFIX);
}

class RasterizerService {
  /** LRU cache keyed by `${targetPx}|${svgDataUri}` or `${width}x${height}|${svgDataUri}` (Map preserves insertion order). */
  private readonly cache = new Map<string, Promise<string>>();

  /** Monotonic per-contextKey sequence for supersede detection. */
  private readonly latestRequest = new Map<string, number>();

  private failureLogged = false;

  constructor(
    private readonly render: SvgRenderFn,
    private readonly logger: ILogger,
  ) {}

  async toDeviceImage(contextKey: string, image: string, target: number | DeviceImageSize): Promise<string | null> {
    // Bump the sequence BEFORE the non-SVG early return: a non-SVG image for
    // this context must still supersede any in-flight SVG render, otherwise
    // a slow render started before it could land after it (stale-over-fresh).
    const seq = (this.latestRequest.get(contextKey) ?? 0) + 1;
    this.latestRequest.set(contextKey, seq);

    if (!isSvgDataUri(image)) return image;

    let result: string;

    try {
      result = await this.rasterizeCached(image, target);
    } catch (err) {
      // Render failure: ship the SVG as before. Warn once, then debug.
      if (this.failureLogged) {
        this.logger.debug(`Rasterization failed, falling back to SVG: ${err}`);
      } else {
        this.failureLogged = true;
        this.logger.warn(`Rasterization failed, falling back to SVG data URIs: ${err}`);
      }

      result = image;
    }

    // A newer image was requested for this context while we rendered — drop
    // this one so a slow render can never overwrite a fresher icon.
    if (this.latestRequest.get(contextKey) !== seq) return null;

    return result;
  }

  private rasterizeCached(svgDataUri: string, target: number | DeviceImageSize): Promise<string> {
    const key = `${typeof target === "number" ? target : `${target.width}x${target.height}`}|${svgDataUri}`;
    const hit = this.cache.get(key);

    if (hit) {
      // Refresh LRU recency
      this.cache.delete(key);
      this.cache.set(key, hit);

      return hit;
    }

    const svg = dataUriToSvg(svgDataUri);
    // A number keeps the legacy width-only call exactly (no third argument).
    const pending = (
      typeof target === "number" ? this.render(svg, target) : this.render(svg, target.width, target.height)
    ).then((png) => `data:image/png;base64,${png.toString("base64")}`);

    this.cache.set(key, pending);

    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;

      if (oldest !== undefined) this.cache.delete(oldest);
    }

    // Failures must not stay cached (transient errors would stick forever).
    pending.catch(() => {
      this.cache.delete(key);
    });

    return pending;
  }
}

let rasterizerService: RasterizerService | null = null;

export function initializeRasterizer(render: SvgRenderFn, logger: ILogger = silentLogger): void {
  if (rasterizerService) {
    throw new Error("Rasterizer service already initialized. Call initializeRasterizer() only once.");
  }

  rasterizerService = new RasterizerService(render, logger);
  logger.info("Rasterizer service initialized");
}

export function isRasterizerInitialized(): boolean {
  return rasterizerService !== null;
}

/**
 * Convert a device-bound image to what should actually be sent to the host.
 * Pass-through (input returned unchanged) when the service is uninitialized
 * or the input is not an SVG data URI; `null` when a newer request for the
 * same contextKey superseded this one (caller must skip its send). A non-SVG
 * image still bumps the per-contextKey sequence before returning, so it can
 * supersede — and never be superseded-past by — an in-flight SVG render for
 * the same context.
 *
 * `target` is the legacy square/width-only px count, or a `DeviceImageSize`
 * for a non-square screen such as a Stream Dock knob (#1013).
 */
export async function toDeviceImage(
  contextKey: string,
  image: string,
  target: number | DeviceImageSize,
): Promise<string | null> {
  if (!rasterizerService) return image;

  return rasterizerService.toDeviceImage(contextKey, image, target);
}

/**
 * @internal Test-only reset.
 */
export function _resetRasterizer(): void {
  rasterizerService = null;
}
