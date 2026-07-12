# PNG Icon Rasterization Implementation Plan (#642 follow-up)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rasterize every device-bound icon (key images and dial touch-strip pixmaps) from SVG to PNG inside the plugin using `@resvg/resvg-js` with bundled Arimo fonts, at each device's native resolution, behind a temporary `pngRasterization` kill-switch flag — and retire the now-obsolete `borderGlow` feature flag and `svg*` capability flags.

**Architecture:** All device-bound images are SVG data URIs that funnel through exactly two adapter-context methods: `setImage(dataUri)` (key icons, flag overlays, dial name icons) and `setFeedback(payload)` (dial touch-strip `box` pixmaps, Elgato only). We intercept there: a new `@iracedeck/rasterizer` package wraps resvg + ships the fonts; a new DI singleton in `deck-core` (`initializeRasterizer` / `toDeviceImage`) does caching, supersede-guarding, and error fallback; each of the three adapters routes its context methods through `toDeviceImage`. When the service is uninitialized (flag off, unit tests), everything passes through unchanged — zero action-code or dial-surface changes.

**Tech Stack:** TypeScript (ESM, tsc builds), `@resvg/resvg-js` 2.6.2 (prebuilt native, marked rollup-`external`, vendored via each plugin's emitted `package.json` like `keysender`), Arimo Regular/Bold (OFL), Vitest, pnpm workspace + turbo.

## Global Constraints

- Working tree: the **`ir-642` worktree** at `C:\Users\Niklas\Projects\iRaceDeck\ir-642`. Shell cwd may reset between commands — always use absolute paths or `git -C C:\Users\Niklas\Projects\iRaceDeck\ir-642 …`.
- Exact dependency versions only (no `^`/`~`; `.npmrc` has `save-exact=true`). resvg is pinned to `2.6.2`.
- resvg font options MUST be `loadSystemFonts: false` + `fontDirs` (a `loadSystemFonts: true` render costs ~130 ms; the `fontFiles` option is silently broken — measured in the #642 spike, see `docs/superpowers/specs/2026-07-12-issue-642-icon-rasterization-decision.md`).
- `pngRasterization` defaults **true on all three platforms** (maintainer decision: PNG everywhere).
- Do NOT modify any file under `packages/iracing-actions/src/actions/` or `packages/iracing-actions/src/shared/` — the interception is entirely below the action layer.
- Commit after every task (conventional commits, local only). **Never push or open a PR** — manual hardware verification by the maintainer comes first.
- After editing any `platform-features.json` or rollup config: running watchers must be restarted, and use `pnpm build --force` (turbo caches deck-core).
- Every fenced code block in any Markdown you touch needs a language tag; Markdown paragraphs stay on one line (no hard wraps).

---

### Task 1: `@iracedeck/rasterizer` package (resvg wrapper + bundled Arimo fonts)

**Files:**

- Create: `packages/rasterizer/package.json`
- Create: `packages/rasterizer/tsconfig.json` (copy `packages/icon-composer/tsconfig.json` verbatim)
- Create: `packages/rasterizer/src/index.ts`
- Create: `packages/rasterizer/fonts/Arimo-Regular.ttf`, `packages/rasterizer/fonts/Arimo-Bold.ttf`, `packages/rasterizer/fonts/OFL.txt` (downloaded)
- Test: `packages/rasterizer/src/index.test.ts`

**Interfaces:**

- Produces: `createSvgRasterizer(options: { fontsDir: string }): SvgRasterizer` and `type SvgRasterizer = (svg: string, widthPx: number) => Promise<Buffer>`. Task 8's plugin wiring imports `createSvgRasterizer` from `@iracedeck/rasterizer`; Task 2's `SvgRenderFn` in deck-core is structurally identical to `SvgRasterizer`.

- [ ] **Step 1: Download the fonts**

```bash
mkdir -p "C:/Users/Niklas/Projects/iRaceDeck/ir-642/packages/rasterizer/fonts"
cd "C:/Users/Niklas/Projects/iRaceDeck/ir-642/packages/rasterizer/fonts"
curl -sL -o Arimo-Regular.ttf "https://github.com/googlefonts/Arimo/raw/main/fonts/ttf/Arimo-Regular.ttf"
curl -sL -o Arimo-Bold.ttf "https://github.com/googlefonts/Arimo/raw/main/fonts/ttf/Arimo-Bold.ttf"
curl -sL -o OFL.txt "https://github.com/googlefonts/Arimo/raw/main/OFL.txt"
```

Expected: `Arimo-Regular.ttf` ≈ 478 KB, `Arimo-Bold.ttf` ≈ 486 KB, `OFL.txt` ≈ 4 KB (URLs verified working 2026-07-12).

- [ ] **Step 2: Create package.json and tsconfig**

`packages/rasterizer/package.json`:

```json
{
  "name": "@iracedeck/rasterizer",
  "version": "2.1.0-dev.0",
  "description": "SVG to PNG rasterization for device-bound deck images via resvg, with bundled Arimo fonts",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "clean": "rimraf dist"
  },
  "dependencies": {
    "@resvg/resvg-js": "2.6.2"
  },
  "devDependencies": {
    "@tsconfig/node22": "22.0.5",
    "@types/node": "26.1.1",
    "rimraf": "6.1.3",
    "typescript": "5.9.3"
  }
}
```

Copy `packages/icon-composer/tsconfig.json` to `packages/rasterizer/tsconfig.json` unchanged. Then run `pnpm install` at the repo root and confirm the new workspace package resolves (no error, lockfile updated).

- [ ] **Step 3: Write the failing test**

`packages/rasterizer/src/index.test.ts`:

```typescript
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createSvgRasterizer } from "./index.js";

const fontsDir = fileURLToPath(new URL("../fonts", import.meta.url));

// Matches the assembled-icon shape: bg + glow filter + artwork + Arial-bold text.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <defs><filter id="glow"><feGaussianBlur in="SourceGraphic" stdDeviation="6"/></filter></defs>
  <rect width="144" height="144" fill="#1a2733"/>
  <rect x="6" y="6" width="132" height="132" rx="12" fill="none" stroke="#00aaff" stroke-width="7" filter="url(#glow)"/>
  <text x="72" y="120" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="18" font-weight="bold">FUEL</text>
</svg>`;

const NO_TEXT_SVG = ICON_SVG.replace(/<text[\s\S]*?<\/text>/, "");

describe("createSvgRasterizer", () => {
  it("renders SVG to a PNG buffer at the requested width", async () => {
    const rasterize = createSvgRasterizer({ fontsDir });
    const png = await rasterize(ICON_SVG, 144);
    // PNG magic bytes
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR width at byte offset 16 (big-endian u32)
    expect(png.readUInt32BE(16)).toBe(144);
    expect(png.readUInt32BE(20)).toBe(144);
  });

  it("scales output to a larger target width", async () => {
    const rasterize = createSvgRasterizer({ fontsDir });
    const png = await rasterize(ICON_SVG, 240);
    expect(png.readUInt32BE(16)).toBe(240);
    expect(png.readUInt32BE(20)).toBe(240);
  });

  it("renders Arial-family text via the bundled Arimo fallback (text changes the output)", async () => {
    const rasterize = createSvgRasterizer({ fontsDir });
    const withText = await rasterize(ICON_SVG, 144);
    const withoutText = await rasterize(NO_TEXT_SVG, 144);
    expect(withText.equals(withoutText)).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run from repo root: `pnpm vitest run packages/rasterizer/src/index.test.ts`
Expected: FAIL — `./index.js` does not exist.

- [ ] **Step 5: Write the implementation**

`packages/rasterizer/src/index.ts`:

```typescript
/**
 * SVG → PNG rasterizer for device-bound deck images.
 *
 * Wraps @resvg/resvg-js and owns the bundled Arimo fonts (fonts/ in this
 * package; copied into each plugin's assets/fonts at build time). Icons ask
 * for "Arial, sans-serif" — Arimo is metric-compatible with Arial and is
 * served through the sans-serif generic fallback, so no icon SVG changes.
 */
import { renderAsync } from "@resvg/resvg-js";

export type SvgRasterizer = (svg: string, widthPx: number) => Promise<Buffer>;

export interface SvgRasterizerOptions {
  /** Directory containing the bundled Arimo font files. */
  fontsDir: string;
}

export function createSvgRasterizer(options: SvgRasterizerOptions): SvgRasterizer {
  const { fontsDir } = options;

  return async (svg: string, widthPx: number): Promise<Buffer> => {
    const rendered = await renderAsync(svg, {
      fitTo: { mode: "width", value: widthPx },
      font: {
        // Never loadSystemFonts: true — it rescans the system font dir on
        // EVERY render (~130 ms). fontFiles is silently broken; use fontDirs.
        loadSystemFonts: false,
        fontDirs: [fontsDir],
        defaultFontFamily: "Arimo",
        sansSerifFamily: "Arimo",
      },
    });

    return rendered.asPng();
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @iracedeck/rasterizer build && pnpm vitest run packages/rasterizer/src/index.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" add packages/rasterizer pnpm-lock.yaml
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -m "feat(rasterizer): add @iracedeck/rasterizer package wrapping resvg with bundled Arimo fonts (#642)"
```

---

### Task 2: deck-core rasterizer service (DI singleton, cache, supersede guard, fallback)

**Files:**

- Create: `packages/deck-core/src/rasterizer-service.ts`
- Modify: `packages/deck-core/src/index.ts` (add exports)
- Test: `packages/deck-core/src/rasterizer-service.test.ts`

**Interfaces:**

- Consumes: `dataUriToSvg`, `isDataUri` from `@iracedeck/icon-composer` (already a deck-core dependency); `ILogger`/`silentLogger` from `@iracedeck/logger`.
- Produces (used by Tasks 5–8): `initializeRasterizer(render: SvgRenderFn, logger?: ILogger): void`, `isRasterizerInitialized(): boolean`, `toDeviceImage(contextKey: string, image: string, targetPx: number): Promise<string | null>` (returns input unchanged when uninitialized or input is not an SVG data URI; `null` when superseded by a newer request for the same `contextKey`), `isSvgDataUri(value: string): boolean`, `TOUCH_STRIP_SLOT_WIDTH = 200`, `type SvgRenderFn = (svg: string, widthPx: number) => Promise<Buffer>`, `_resetRasterizer(): void` (test-only).

- [ ] **Step 1: Write the failing tests**

`packages/deck-core/src/rasterizer-service.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/deck-core/src/rasterizer-service.test.ts`
Expected: FAIL — `./rasterizer-service.js` does not exist.

- [ ] **Step 3: Write the implementation**

`packages/deck-core/src/rasterizer-service.ts`:

```typescript
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

export type SvgRenderFn = (svg: string, widthPx: number) => Promise<Buffer>;

const SVG_DATA_URI_PREFIX = "data:image/svg+xml";

/** Elgato touch-strip slot width in px — dial pixmaps rasterize at this width. */
export const TOUCH_STRIP_SLOT_WIDTH = 200;

/** LRU cap: 512 entries ≈ a few MB of PNGs; static icons all fit. */
const CACHE_MAX_ENTRIES = 512;

export function isSvgDataUri(value: string): boolean {
  return value.startsWith(SVG_DATA_URI_PREFIX);
}

class RasterizerService {
  /** LRU cache keyed by `${targetPx}|${svgDataUri}` (Map preserves insertion order). */
  private readonly cache = new Map<string, Promise<string>>();

  /** Monotonic per-contextKey sequence for supersede detection. */
  private readonly latestRequest = new Map<string, number>();

  private failureLogged = false;

  constructor(
    private readonly render: SvgRenderFn,
    private readonly logger: ILogger,
  ) {}

  async toDeviceImage(contextKey: string, image: string, targetPx: number): Promise<string | null> {
    if (!isSvgDataUri(image)) return image;

    const seq = (this.latestRequest.get(contextKey) ?? 0) + 1;
    this.latestRequest.set(contextKey, seq);

    let result: string;

    try {
      result = await this.rasterizeCached(image, targetPx);
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

  private rasterizeCached(svgDataUri: string, targetPx: number): Promise<string> {
    const key = `${targetPx}|${svgDataUri}`;
    const hit = this.cache.get(key);

    if (hit) {
      // Refresh LRU recency
      this.cache.delete(key);
      this.cache.set(key, hit);

      return hit;
    }

    const pending = this.render(dataUriToSvg(svgDataUri), targetPx).then(
      (png) => `data:image/png;base64,${png.toString("base64")}`,
    );

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
 * same contextKey superseded this one (caller must skip its send).
 */
export async function toDeviceImage(contextKey: string, image: string, targetPx: number): Promise<string | null> {
  if (!rasterizerService) return image;

  return rasterizerService.toDeviceImage(contextKey, image, targetPx);
}

/**
 * @internal Test-only reset.
 */
export function _resetRasterizer(): void {
  rasterizerService = null;
}
```

- [ ] **Step 4: Export from deck-core index**

In `packages/deck-core/src/index.ts`, add alongside the existing service exports (near the `keyboard-service.js` export block):

```typescript
export {
  _resetRasterizer,
  initializeRasterizer,
  isRasterizerInitialized,
  isSvgDataUri,
  TOUCH_STRIP_SLOT_WIDTH,
  toDeviceImage,
  type SvgRenderFn,
} from "./rasterizer-service.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @iracedeck/deck-core build && pnpm vitest run packages/deck-core/src/rasterizer-service.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" add packages/deck-core/src/rasterizer-service.ts packages/deck-core/src/rasterizer-service.test.ts packages/deck-core/src/index.ts
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -m "feat(deck-core): add rasterizer service with cache, supersede guard, and SVG fallback (#642)"
```

---

### Task 3: Key-image pixel sizes per device

**Files:**

- Modify: `packages/deck-core/src/device-profiles.ts` (append; `DeviceType` enum is at the top of this file)
- Modify: `packages/deck-core/src/index.ts` (add exports)
- Test: `packages/deck-core/src/device-profiles.test.ts` (extend if it exists, else create)

**Interfaces:**

- Produces (used by Tasks 5–7): `keyImageSizeForDevice(deviceType?: number): number` and `DEFAULT_KEY_IMAGE_SIZE = 144`.

- [ ] **Step 1: Write the failing test** (append a describe block to `device-profiles.test.ts`, or create the file with deck-core's usual test imports if absent)

```typescript
import { describe, expect, it } from "vitest";

import { DEFAULT_KEY_IMAGE_SIZE, DeviceType, keyImageSizeForDevice } from "./device-profiles.js";

describe("keyImageSizeForDevice", () => {
  it("returns @2x physical key size for known Elgato devices", () => {
    expect(keyImageSizeForDevice(DeviceType.StreamDeck)).toBe(144);
    expect(keyImageSizeForDevice(DeviceType.StreamDeckMini)).toBe(160);
    expect(keyImageSizeForDevice(DeviceType.StreamDeckXL)).toBe(192);
    expect(keyImageSizeForDevice(DeviceType.StreamDeckPlus)).toBe(240);
    expect(keyImageSizeForDevice(DeviceType.StreamDeckNeo)).toBe(192);
  });

  it("falls back to the default for unknown or missing device types", () => {
    expect(keyImageSizeForDevice(undefined)).toBe(DEFAULT_KEY_IMAGE_SIZE);
    expect(keyImageSizeForDevice(999)).toBe(DEFAULT_KEY_IMAGE_SIZE);
    expect(keyImageSizeForDevice(DeviceType.StreamDeckPedal)).toBe(DEFAULT_KEY_IMAGE_SIZE);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/deck-core/src/device-profiles.test.ts`
Expected: FAIL — `keyImageSizeForDevice` is not exported.

- [ ] **Step 3: Implement** (append to `packages/deck-core/src/device-profiles.ts`)

```typescript
/**
 * PNG raster size (px) for key images, per Elgato device type — the physical
 * key LCD size at @2x (Elgato's recommended image scale). Non-Elgato devices
 * (Mirabox/Ulanzi contexts carry no deviceType) and unknown types use
 * DEFAULT_KEY_IMAGE_SIZE; refine per-model once measured on hardware
 * (#642 decision doc §6 checklist).
 */
export const DEFAULT_KEY_IMAGE_SIZE = 144;

const KEY_IMAGE_SIZES: Partial<Record<DeviceType, number>> = {
  [DeviceType.StreamDeck]: 144, // 72×72 keys
  [DeviceType.StreamDeckMini]: 160, // 80×80 keys
  [DeviceType.StreamDeckXL]: 192, // 96×96 keys
  [DeviceType.StreamDeckPlus]: 240, // 120×120 keys
  [DeviceType.StreamDeckNeo]: 192, // 96×96 keys
};

export function keyImageSizeForDevice(deviceType?: number): number {
  if (deviceType === undefined) return DEFAULT_KEY_IMAGE_SIZE;

  return KEY_IMAGE_SIZES[deviceType as DeviceType] ?? DEFAULT_KEY_IMAGE_SIZE;
}
```

In `packages/deck-core/src/index.ts`, extend the existing `device-profiles.js` export statement with `DEFAULT_KEY_IMAGE_SIZE` and `keyImageSizeForDevice` (keep existing exported names untouched).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/deck-core/src/device-profiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" add packages/deck-core/src/device-profiles.ts packages/deck-core/src/device-profiles.test.ts packages/deck-core/src/index.ts
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -m "feat(deck-core): add per-device key image pixel sizes (#642)"
```

---

### Task 4: `pngRasterization` platform flag plumbing

**Files:**

- Modify: `packages/iracing-plugin-stream-deck/platform-features.json`, `packages/iracing-plugin-mirabox/platform-features.json`, `packages/iracing-plugin-ulanzi/platform-features.json` — add `"pngRasterization": true` to `features` (keep everything else as-is for now; borderGlow removal is Task 9)
- Modify: `feature-flags.local.json.example` — add `"pngRasterization": true` to `features`
- Modify: `packages/deck-core/src/plugin-config.ts` — add `pngRasterization: boolean;` to `PlatformFeatureFlags` with comment `/** Rasterize device-bound SVG icons to PNG in-plugin (#642). Temporary kill-switch. */`
- Modify: all three plugin `rollup.config.mjs` — in the `@rollup/plugin-replace` values block that defines `__FEATURE_BORDER_GLOW__`/`__FEATURE_DIAL_FEEDBACK__`, add one entry following the exact same pattern as the existing `__FEATURE_*__` lines: `__FEATURE_PNG_RASTERIZATION__` from `features.pngRasterization`
- Modify: `packages/iracing-plugin-stream-deck/src/platform-features.d.ts`, `packages/iracing-plugin-mirabox/src/platform-features.d.ts`, `packages/iracing-plugin-ulanzi/src/platform-features.d.ts` — add `declare const __FEATURE_PNG_RASTERIZATION__: boolean;`
- Modify: `test-setup.ts` (repo root) — add `__FEATURE_PNG_RASTERIZATION__: boolean;` to the interface and `featureFlagGlobals.__FEATURE_PNG_RASTERIZATION__ = true;`

**Interfaces:**

- Produces: the compile-time constant `__FEATURE_PNG_RASTERIZATION__` (used only in the three `plugin.ts` files, Task 8).

- [ ] **Step 1: Make all edits above** (each is a one-line addition mirroring an existing sibling line — match the sibling's exact style in each file)

- [ ] **Step 2: Verify the flag reaches a bundle**

Run: `pnpm --filter @iracedeck/iracing-plugin-stream-deck build`
Expected: build succeeds (constant defined but unused yet; `@rollup/plugin-replace` tolerates unused values).

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" add packages/iracing-plugin-stream-deck packages/iracing-plugin-mirabox packages/iracing-plugin-ulanzi feature-flags.local.json.example packages/deck-core/src/plugin-config.ts test-setup.ts
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -m "feat(plugins): add pngRasterization platform feature flag, default on (#642)"
```

---

### Task 5: Elgato adapter integration (`setImage` + `setFeedback` pixmaps)

**Files:**

- Modify: `packages/deck-adapter-elgato/src/adapter.ts` — `ElgatoActionContext.setImage` (line ~83) and `ElgatoActionContext.setFeedback` (line ~103)
- Test: `packages/deck-adapter-elgato/src/adapter.test.ts` (extend)

**Interfaces:**

- Consumes (from Tasks 2–3, via `@iracedeck/deck-core`): `toDeviceImage`, `keyImageSizeForDevice`, `isSvgDataUri`, `TOUCH_STRIP_SLOT_WIDTH`, `initializeRasterizer`, `_resetRasterizer`.

- [ ] **Step 1: Write the failing tests** (add to `adapter.test.ts`, following that file's existing mock/setup conventions for constructing a context; the essential assertions:)

```typescript
import { _resetRasterizer, initializeRasterizer, svgToDataUri } from "@iracedeck/deck-core";

// In a new describe block; afterEach(() => _resetRasterizer());

it("passes SVG data URIs through unchanged when no rasterizer is initialized", async () => {
  // construct context via the file's existing helper; then:
  await ctx.setImage(svgUri);
  expect(sdAction.setImage).toHaveBeenCalledWith(svgUri);
});

it("rasterizes setImage SVG data URIs to PNG at the device's key size", async () => {
  initializeRasterizer(async () => Buffer.from("png"));
  // sdAction.device = { id: "dev1", type: 7 }  (StreamDeckPlus → 240 px)
  await ctx.setImage(svgUri);
  expect(sdAction.setImage).toHaveBeenCalledWith(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
});

it("rasterizes SVG pixmap values in setFeedback at the touch-strip slot width, leaving other values alone", async () => {
  const rendered: number[] = [];
  initializeRasterizer(async (_svg, px) => {
    rendered.push(px);
    return Buffer.from("png");
  });
  await ctx.setFeedback({ box: svgUri, title: "FUEL" });
  expect(rendered).toEqual([200]);
  expect(sdAction.setFeedback).toHaveBeenCalledWith({
    box: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
    title: "FUEL",
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run packages/deck-adapter-elgato/src/adapter.test.ts`
Expected: pre-existing tests PASS (uninitialized service = passthrough); the two rasterizing tests FAIL (raw SVG URI forwarded).

- [ ] **Step 3: Implement** — in `ElgatoActionContext`, import `isSvgDataUri, keyImageSizeForDevice, TOUCH_STRIP_SLOT_WIDTH, toDeviceImage` from `@iracedeck/deck-core` and replace the two methods:

```typescript
  async setImage(dataUri: string): Promise<void> {
    const image = await toDeviceImage(this.id, dataUri, keyImageSizeForDevice(this.sdAction.device?.type));

    // null = superseded by a newer image for this context — skip the send.
    if (image === null) return;

    await this.sdAction.setImage(image);
  }

  async setFeedback(feedback: DeckFeedbackPayload): Promise<void> {
    if (!this.sdAction.setFeedback) return;

    const converted: DeckFeedbackPayload = {};

    for (const [key, value] of Object.entries(feedback)) {
      if (typeof value === "string" && isSvgDataUri(value)) {
        const image = await toDeviceImage(`${this.id}#${key}`, value, TOUCH_STRIP_SLOT_WIDTH);

        if (image === null) return; // a newer feedback push superseded this one

        converted[key] = image;
      } else {
        converted[key] = value;
      }
    }

    await this.sdAction.setFeedback(converted as FeedbackPayload);
  }
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm --filter @iracedeck/deck-adapter-elgato build && pnpm vitest run packages/deck-adapter-elgato/src/adapter.test.ts`
Expected: PASS (all pre-existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" add packages/deck-adapter-elgato
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -m "feat(deck-adapter-elgato): rasterize key images and dial pixmaps via deck-core rasterizer (#642)"
```

---

### Task 6: Mirabox adapter integration

**Files:**

- Modify: `packages/deck-adapter-mirabox/src/adapter.ts` — `VSDActionContext.setImage` (line ~38)
- Test: `packages/deck-adapter-mirabox/src/adapter.test.ts` (extend)

**Interfaces:**

- Consumes: `toDeviceImage`, `DEFAULT_KEY_IMAGE_SIZE`, `initializeRasterizer`, `_resetRasterizer` from `@iracedeck/deck-core`.

- [ ] **Step 1: Write the failing test** (mirror Task 5's two `setImage` tests using this file's existing `client.setImage` mock; Mirabox contexts have no device type, so expect `DEFAULT_KEY_IMAGE_SIZE`:)

```typescript
it("rasterizes setImage SVG data URIs at the default key size", async () => {
  const rendered: number[] = [];
  initializeRasterizer(async (_svg, px) => {
    rendered.push(px);
    return Buffer.from("png");
  });
  await ev.action.setImage(svgUri);
  expect(rendered).toEqual([144]);
  expect(client.setImage).toHaveBeenCalledWith(
    "ctx-img",
    `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
  );
});
```

Note: the pre-existing test at `adapter.test.ts:381` asserts passthrough of `"data:image/svg+xml,test"` — it must keep passing (no rasterizer initialized in that test). Add `_resetRasterizer()` to the file's `afterEach`.

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `pnpm vitest run packages/deck-adapter-mirabox/src/adapter.test.ts`
Expected: new test FAILS; pre-existing PASS.

- [ ] **Step 3: Implement** — in `VSDActionContext`:

```typescript
  async setImage(dataUri: string): Promise<void> {
    const image = await toDeviceImage(this.id, dataUri, DEFAULT_KEY_IMAGE_SIZE);

    // null = superseded by a newer image for this context — skip the send.
    if (image === null) return;

    this.client.setImage(this.id, image);
  }
```

(`setFeedback` stays a no-op — the VSD protocol has no touch strip.)

- [ ] **Step 4: Run tests, expect PASS, then commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" add packages/deck-adapter-mirabox
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -m "feat(deck-adapter-mirabox): rasterize key images via deck-core rasterizer (#642)"
```

---

### Task 7: Ulanzi adapter integration

**Files:**

- Modify: `packages/deck-adapter-ulanzi/src/adapter.ts` — `UlanziActionContext.setImage` (line ~43)
- Test: `packages/deck-adapter-ulanzi/src/adapter.test.ts` (extend)

**Interfaces:**

- Consumes: `toDeviceImage`, `DEFAULT_KEY_IMAGE_SIZE`, `initializeRasterizer`, `_resetRasterizer` from `@iracedeck/deck-core`. (The Ulanzi adapter mirrors the Mirabox one — same client-forwarding shape.)

- [ ] **Step 1: Write the failing test** (in `adapter.test.ts`, using this file's existing `client.setImage` mock and event helper; add `_resetRasterizer()` to the file's `afterEach`)

```typescript
it("rasterizes setImage SVG data URIs at the default key size", async () => {
  const rendered: number[] = [];
  initializeRasterizer(async (_svg, px) => {
    rendered.push(px);
    return Buffer.from("png");
  });
  await ev.action.setImage(svgUri);
  expect(rendered).toEqual([144]);
  expect(client.setImage).toHaveBeenCalledWith(
    ev.action.id,
    `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
  );
});

it("passes SVG data URIs through unchanged when no rasterizer is initialized", async () => {
  await ev.action.setImage("data:image/svg+xml,test");
  expect(client.setImage).toHaveBeenCalledWith(ev.action.id, "data:image/svg+xml,test");
});
```

- [ ] **Step 2: Run tests to verify the rasterizing test fails**

Run: `pnpm vitest run packages/deck-adapter-ulanzi/src/adapter.test.ts`
Expected: new rasterizing test FAILS; everything else PASSES.

- [ ] **Step 3: Implement** — in `UlanziActionContext` (line ~43), import `DEFAULT_KEY_IMAGE_SIZE, toDeviceImage` from `@iracedeck/deck-core` and replace `setImage`:

```typescript
  async setImage(dataUri: string): Promise<void> {
    const image = await toDeviceImage(this.id, dataUri, DEFAULT_KEY_IMAGE_SIZE);

    // null = superseded by a newer image for this context — skip the send.
    if (image === null) return;

    this.client.setImage(this.id, image);
  }
```

- [ ] **Step 4: Run `pnpm --filter @iracedeck/deck-adapter-ulanzi build && pnpm vitest run packages/deck-adapter-ulanzi/src/adapter.test.ts`, expect PASS**

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" add packages/deck-adapter-ulanzi
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -m "feat(deck-adapter-ulanzi): rasterize key images via deck-core rasterizer (#642)"
```

---

### Task 8: Plugin wiring — init, packaging, fonts (all three plugins)

**Files (×3, same pattern):**

- Modify: `packages/iracing-plugin-{stream-deck,mirabox,ulanzi}/package.json` — add `"@iracedeck/rasterizer": "workspace:*"` to dependencies
- Modify: `packages/iracing-plugin-{stream-deck,mirabox,ulanzi}/src/plugin.ts` — initialize the rasterizer
- Modify: `packages/iracing-plugin-{stream-deck,mirabox,ulanzi}/rollup.config.mjs` — external, emitted deps, fonts copy

**Interfaces:**

- Consumes: `createSvgRasterizer` (Task 1), `initializeRasterizer` (Task 2), `__FEATURE_PNG_RASTERIZATION__` (Task 4).

- [ ] **Step 1: plugin.ts wiring** — in each plugin's `src/plugin.ts`, next to the existing `initializeKeyboard(...)` block (order requirement: after the adapter is created, before actions are registered), add:

```typescript
import { initializeRasterizer } from "@iracedeck/deck-core";
import { createSvgRasterizer } from "@iracedeck/rasterizer";

// Rasterize device-bound SVG icons to PNG in-plugin (#642). When the flag is
// off, the service stays uninitialized and adapters pass SVG through as before.
if (__FEATURE_PNG_RASTERIZATION__) {
  initializeRasterizer(
    createSvgRasterizer({ fontsDir: join(__binDir, "..", "assets", "fonts") }),
    adapter.createLogger("Rasterizer"),
  );
}
```

(`join` and `__binDir` already exist in each plugin.ts for the audio-assets path — reuse them.)

- [ ] **Step 2: rollup.config.mjs (each plugin)** —
  1. Add `"@resvg/resvg-js"` to the `external` array (next to `"keysender"`).
  2. In the emitted-package-json plugin (`emit-module-package-file` / `generateBundle`), add `"@resvg/resvg-js": "2.6.2"` to `dependencies` (regular dependency — prebuilds exist for all platforms, unlike `keysender`).
  3. Add a fonts-copy plugin (mirror the shape of the existing icon-copy plugin in the same file):

```javascript
    {
      name: "copy-rasterizer-fonts",
      generateBundle() {
        const fontsSrc = path.resolve(__dirname, "../rasterizer/fonts");
        const destDir = path.join(sdPlugin, "assets", "fonts");
        mkdirSync(destDir, { recursive: true });
        for (const file of readdirSync(fontsSrc)) {
          copyFileSync(path.join(fontsSrc, file), path.join(destDir, file));
        }
      },
    },
```

(`mkdirSync`/`readdirSync`/`copyFileSync`/`path` are already imported in each config; add any that aren't.)

- [ ] **Step 3: Install and build everything**

Run: `pnpm install` then `pnpm build --force`
Expected: all packages build. Verify the artifacts:

```bash
ls "C:/Users/Niklas/Projects/iRaceDeck/ir-642/packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/assets/fonts"
# → Arimo-Bold.ttf  Arimo-Regular.ttf  OFL.txt
grep -c "@resvg/resvg-js" "C:/Users/Niklas/Projects/iRaceDeck/ir-642/packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/bin/package.json"
# → 1 (and repeat both checks for the mirabox + ulanzi sdPlugin dirs)
```

- [ ] **Step 4: Run the full test suite**

Run: `pnpm test`
Expected: PASS (actions/adapters unaffected: service uninitialized in tests unless a test opts in).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" add packages/iracing-plugin-stream-deck packages/iracing-plugin-mirabox packages/iracing-plugin-ulanzi pnpm-lock.yaml
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -m "feat(plugins): wire PNG rasterizer with bundled fonts into all three plugins (#642)"
```

---

### Task 9: Retire `borderGlow` feature flag and `svg*` capability flags

Rationale: with PNG rendered by resvg on every platform, the QT5 engine no longer sets the ceiling. In the kill-switch fallback (flag off → SVG to QT5), glow markup is silently ignored by QT5 — visually identical to today's flag-off behavior, so removal is safe even with the fallback.

**Files:**

- Modify: `packages/icon-composer/src/icon-base.ts:30` — `if (!border.glowEnabled || !__FEATURE_BORDER_GLOW__)` → `if (!border.glowEnabled)`
- Modify: `packages/icon-composer/src/title-settings.ts:345` — delete the `__FEATURE_BORDER_GLOW__ &&` prefix (keep the `resolve(...)` expression)
- Delete: `packages/icon-composer/src/platform-features.d.ts` (no `__FEATURE_*__`/`__CAPABILITY_*__` constants remain referenced in icon-composer)
- Modify: all three `packages/iracing-plugin-*/src/platform-features.d.ts` — remove the `__CAPABILITY_SVG_FILTERS__`, `__CAPABILITY_SVG_MASKS__`, `__CAPABILITY_SVG_PATTERNS__`, `__FEATURE_BORDER_GLOW__` declarations (keep `__FEATURE_DIAL_FEEDBACK__` and `__FEATURE_PNG_RASTERIZATION__`)
- Modify: all three `packages/iracing-plugin-*/platform-features.json` — delete the whole `"capabilities"` object and the `"borderGlow"` key; resulting shape: `{ "features": { "dialFeedback": <unchanged>, "profiles": <unchanged>, "pngRasterization": true } }`
- Modify: `feature-flags.local.json.example` — same shape change
- Modify: all three `rollup.config.mjs` — remove the four `__CAPABILITY_*__`/`__FEATURE_BORDER_GLOW__` replace entries; if the config reads `merged.capabilities.*` anywhere else, remove that too
- Modify: `packages/deck-core/src/plugin-config.ts` — delete `PlatformCapabilities` and the `capabilities` member of `PlatformFeatures`; delete `borderGlow` from `PlatformFeatureFlags`
- Modify: `test-setup.ts` — remove the four retired globals (keep `__FEATURE_DIAL_FEEDBACK__`, `__FEATURE_PNG_RASTERIZATION__`)
- Modify: `packages/deck-core/src/icon-base.test.ts` and `packages/deck-core/src/title-settings.test.ts` — delete the test cases that `vi.stubGlobal("__FEATURE_BORDER_GLOW__", false)` (the false-path no longer exists); keep glow-enabled/disabled-by-settings cases

- [ ] **Step 1: Make the code + flag edits above**
- [ ] **Step 2: Verify** — `pnpm build --force && pnpm test` → PASS; then `grep -ri "BORDER_GLOW\|CAPABILITY_SVG" packages/ --include="*.ts" --include="*.mjs" --include="*.json"` → no production hits (docs handled in Task 11).
- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -am "refactor(flags): retire borderGlow feature flag and svg capability flags (#642)"
```

---

### Task 10: PI partials — un-gate the glow controls

**Files:**

- Modify: `packages/pi-components/partials/border-overrides.ejs`, `packages/pi-components/partials/global-border-defaults.ejs`, `packages/pi-components/partials/head-common.ejs`

Mechanical transformation in each file: delete the `<% var borderGlowEnabled = (locals.platform?.features?.borderGlow !== false); %>` declaration, then unwrap every `<% if (borderGlowEnabled) { %> … <% } %>` block keeping its contents, and for every JS-template ternary `(borderGlowEnabled ? X : Y)` keep `X`. The glow controls now render on all three platforms' PIs. Do NOT touch the `profiles` gating in `global-stream-deck-profiles.ejs`.

- [ ] **Step 1: Apply the transformation to the three partials**
- [ ] **Step 2: Verify** — `pnpm build` then confirm the glow control now exists in a Mirabox PI page:

```bash
grep -l "ird-border-glow" "C:/Users/Niklas/Projects/iRaceDeck/ir-642/packages/iracing-plugin-mirabox/com.iracedeck.sd.core.sdPlugin/ui/" -r
```

Expected: matches (previously none on Mirabox). Also `grep -ri borderGlow packages/pi-components/partials/` → no hits.

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -am "feat(pi-components): show border glow controls on all platforms (#642)"
```

---

### Task 11: Documentation & changelog sweep

**Files:**

- Rewrite: `.claude/rules/svg-platform-compatibility.md` — new content: icons are rasterized in-plugin by resvg (`@iracedeck/rasterizer`); authoring baseline is resvg's SVG 1.1-static support (filters, masks, patterns, and `clipPath` now allowed; still no `<style>` elements, animations, or scripts); fonts come from bundled Arimo via the `sans-serif` fallback (`font-family="Arial, sans-serif"` keeps working; `dominant-baseline` guidance unchanged — keep computing baselines); note the kill-switch caveat (with `pngRasterization` off, hosts render SVG again, so avoid making a filter-only effect essential information until the flag is deleted); keep the §binding-warning-glyph note. Preserve the file name so `paths:` scoping and cross-references keep working.
- Modify: `.claude/rules/platform-feature-flags.md` — flag list: remove `borderGlow` + capabilities, add `pngRasterization` (temporary kill-switch, true everywhere, gates only `initializeRasterizer` in plugin.ts); update the "local override round-trip" example to use `pngRasterization`.
- Modify: `.claude/rules/plugin-structure.md` — add the `initializeRasterizer` block (Task 8 Step 1 code) to the plugin.ts init-order example with a numbered step, and note `@resvg/resvg-js` in the native-module external/dependency guidance next to `keysender`.
- Modify: root `.claude/CLAUDE.md` — add to the Packages list: ``- `@iracedeck/rasterizer` — SVG→PNG rasterization for device-bound images via `@resvg/resvg-js`, with bundled Arimo fonts (OFL). Injected into deck-core's rasterizer service by each plugin (`initializeRasterizer`); gated by the `pngRasterization` platform flag.``
- Modify: `packages/icon-composer/CLAUDE.md` — remove/replace its `__FEATURE_BORDER_GLOW__` mention (glow is now unconditional in icon assembly).
- Modify: `packages/website/src/content/docs/docs/development/architecture.md` — add `@iracedeck/rasterizer` to the package inventory and dependency-graph Mermaid diagram (plugins → rasterizer; deck-core consumes it via injection), and one prose sentence in the rendering/data-flow section: icons are rasterized to PNG in-plugin and sent as pixels.
- Modify: `packages/website/src/content/docs/docs/development/feature-flags.md` — same flag-list changes as the rules file.
- Modify: `packages/website/src/content/docs/changelog.mdx` — under the in-development `## 2.1.0` section (create per changelog rules if absent), add under `**Improvements**`: `- Key and dial icons are now rendered to pixels by the plugin itself instead of each deck app's SVG engine, so icons look identical on every device and effects like the border glow work on Mirabox and Ulanzi decks too.`
- Check: `grep -ri "borderGlow\|svgFilters" .claude/ docs/ packages/website/src/content/ --include="*.md" --include="*.mdx"` and fix any remaining stale mention (historical `docs/superpowers/specs/*` design notes stay untouched).

- [ ] **Step 1: Make all documentation edits**
- [ ] **Step 2: Verify website builds** — `pnpm --filter @iracedeck/website build` → PASS
- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -am "docs: update rendering/flag docs and changelog for PNG rasterization (#642)"
```

---

### Task 12: Full verification

- [ ] **Step 1:** `pnpm install` → lockfile clean (`git status` shows no unexpected lockfile diff)
- [ ] **Step 2:** `pnpm build --force` → all packages build
- [ ] **Step 3:** `pnpm test` → all tests pass
- [ ] **Step 4:** `pnpm lint:fix && pnpm format:fix` → commit any resulting changes
- [ ] **Step 5:** Bundle sanity checks:

```bash
# resvg must NOT be bundled (external), fonts must be present, PNG flag replaced:
grep -c "resvg" "C:/Users/Niklas/Projects/iRaceDeck/ir-642/packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/bin/plugin.js"
# → small number of import references only; no minified resvg body (file size roughly unchanged)
grep -c "__FEATURE_PNG_RASTERIZATION__" "C:/Users/Niklas/Projects/iRaceDeck/ir-642/packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/bin/plugin.js"
# → 0 (replaced with literal)
```

- [ ] **Step 6:** Commit anything outstanding: `git -C "C:/Users/Niklas/Projects/iRaceDeck/ir-642" commit -am "chore: lint/format pass (#642)"` (skip if clean)

---

### Task 13: Manual hardware verification (maintainer) — STOP point

No push, no PR until these pass (maintainer runs them):

- [ ] Elgato Stream Deck: keys render (PNG accepted via `setImage`), text crisp, border glow visible; Fuel Service dial strip renders; 10 Hz telemetry keys smooth.
- [ ] Ulanzi Deck: keys render via PNG data URIs (was SVG-verified in #508; PNG assumed but unverified); icon sharpness acceptable at the default 144 px raster.
- [ ] Mirabox (if hardware available): same as Ulanzi.
- [ ] Kill-switch check: `feature-flags.local.json` with `{ "features": { "pngRasterization": false } }` + rebuild → SVG behavior restored (restart watchers after the flag change).
- [ ] Icon spot-check across several action families (black box, tire service, telemetry display, setup dials) comparing look vs current release.

Findings from the resolution checks (icon softness on Ulanzi/Mirabox) feed the per-model pixel-size map (`KEY_IMAGE_SIZES`) — expected follow-up, not a blocker for this plan.
