# Paired Adjust Key Styles (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selectable key styles that let 2-key pairs (both showing the live, unit-less value) or 3-key groups (View key in the middle) form increase/decrease controls across the seven setup actions.

**Architecture:** A shared renderer + settings module (`packages/iracing-actions/src/shared/adjust-styles.ts`, sibling of `setup-view.ts`) does all style rendering, gating, seeding, and value formatting; each setup action adds two settings fields, a few routing lines, hold-to-repeat wiring, and a shared PI partial include. Spec: `docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md`.

**Tech Stack:** TypeScript, Zod, Vitest, EJS PI templates (sdpi-components), SVG (QT5-safe subset only).

## Global Constraints

- Execute in a sibling worktree (e.g. `C:/Users/Niklas/Projects/iRaceDeck/ir-<issue>`), never inside the repo directory. Commit the spec file (`docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md`, currently untracked in the master checkout) as part of the first commit.
- QT5-safe SVG only: `text`, `polyline`, `path`, `circle`, `rect`, `g`, `opacity` — no filters, masks, clipPath, or `<style>` elements.
- `keyStyle` schema default is `"legacy"`; `pairPosition` default `"auto"`; both get `.default(...).catch(...)` (the `z.enum(X).default(Y).catch(Y)` order used by `changelogNotification`).
- Accent color = `graphic1Color` slot, default `#f1c40f`, resolved from the adjust-style template's own `<desc>` (NOT from the action's `colorSourceSvg`, whose `graphic1Color` is white + locked).
- Unit-less values: strip a trailing `%` from `formatViewValue` output; keep signs; `---` placeholder unchanged.
- No manifest changes, no comms-catalog changes, no new global settings.
- All fenced code blocks in docs need language identifiers. No hard wraps inside markdown paragraphs.
- Before each commit: run the tests named in the task. Before the final task: `pnpm build` must pass (turbo caches deck-core — this plan touches none of its schemas, but if a global-settings schema is ever touched, use `pnpm build --force`).
- Conventional commits; this branch will be squash-merged, so the PR title carries the issue number.

---

### Task 1: Shared module core — types, settings fields, seeding, gating, formatting

**Files:**
- Create: `packages/iracing-actions/src/shared/adjust-styles.ts`
- Create: `packages/iracing-actions/src/shared/adjust-styles.test.ts`

**Interfaces:**
- Consumes: `VIEW_DEFS`, `formatViewValue`, `isViewSetting`, `ViewSettingId` from `./setup-view.js`; `z` from `zod`.
- Produces (used by Tasks 2–11):
  - `ADJUST_KEY_STYLES`, `type AdjustKeyStyle`, `PAIR_POSITIONS`, `type PairPosition`
  - `adjustStyleSettingsFields` (spread into `CommonSettings.extend`)
  - `ADJUST_REPEAT_INTERVAL_MS = 150`, `ADJUST_REPEAT_SAFETY_MS = 15_000`
  - `seedFreshKeyStyle(raw: unknown): Record<string, unknown> | null`
  - `stripUnit(value: string): string`
  - `getViewIdForAdjustment(adjustmentMode: string): ViewSettingId | undefined`
  - `hasPairedValueSource(setting: string): boolean`
  - `styleShowsValue(style: AdjustKeyStyle): boolean`
  - `isPillStyle(style: AdjustKeyStyle): boolean`
  - `isPositionAwareStyle(style: AdjustKeyStyle): boolean`
  - `isPillMiddleStyle(style: AdjustKeyStyle): boolean`
  - `resolvePairPosition(position: PairPosition, direction: "increase" | "decrease"): "left" | "right" | "top" | "bottom"`
  - `pairedKeyNeedsTelemetry(s: { setting: string; keyStyle: AdjustKeyStyle }): boolean`
  - `telemetryMemoValue(s: { setting: string; keyStyle: AdjustKeyStyle }, telemetry: TelemetryData | null): string | null`

- [ ] **Step 1: Write the failing tests**

Create `packages/iracing-actions/src/shared/adjust-styles.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  ADJUST_KEY_STYLES,
  adjustStyleSettingsFields,
  getViewIdForAdjustment,
  hasPairedValueSource,
  isPillMiddleStyle,
  isPillStyle,
  isPositionAwareStyle,
  pairedKeyNeedsTelemetry,
  resolvePairPosition,
  seedFreshKeyStyle,
  stripUnit,
  styleShowsValue,
  telemetryMemoValue,
} from "./adjust-styles.js";

import { z } from "zod";

const Schema = z.object(adjustStyleSettingsFields);

describe("adjustStyleSettingsFields", () => {
  it("defaults keyStyle to legacy and pairPosition to auto", () => {
    expect(Schema.parse({})).toEqual({ keyStyle: "legacy", pairPosition: "auto" });
  });

  it("degrades unknown values via catch instead of failing the parse", () => {
    expect(Schema.parse({ keyStyle: "from-the-future", pairPosition: "diagonal" })).toEqual({
      keyStyle: "legacy",
      pairPosition: "auto",
    });
  });
});

describe("seedFreshKeyStyle", () => {
  it("stamps split on an empty settings object", () => {
    expect(seedFreshKeyStyle({})).toEqual({ keyStyle: "split" });
    expect(seedFreshKeyStyle(undefined)).toEqual({ keyStyle: "split" });
  });

  it("returns null for configured keys (any persisted field)", () => {
    expect(seedFreshKeyStyle({ setting: "brake-bias" })).toBeNull();
    expect(seedFreshKeyStyle({ keyStyle: "legacy" })).toBeNull();
  });

  it("returns null for non-object garbage", () => {
    expect(seedFreshKeyStyle("nope")).toBeNull();
    expect(seedFreshKeyStyle([1])).toBeNull();
  });
});

describe("stripUnit", () => {
  it("strips a trailing percent and keeps signs", () => {
    expect(stripUnit("54.0%")).toBe("54.0");
    expect(stripUnit("+2%")).toBe("+2");
    expect(stripUnit("7")).toBe("7");
    expect(stripUnit("---")).toBe("---");
  });
});

describe("value-source gating", () => {
  it("inverts VIEW_DEFS adjustmentMode to the view id", () => {
    expect(getViewIdForAdjustment("brake-bias")).toBe("view-brake-bias");
    expect(getViewIdForAdjustment("throttle-shaping")).toBe("view-throttle-shape");
    expect(getViewIdForAdjustment("qualifying-tape")).toBeUndefined();
  });

  it("hasPairedValueSource accepts adjust modes with a view def and view ids themselves", () => {
    expect(hasPairedValueSource("brake-bias")).toBe(true);
    expect(hasPairedValueSource("view-brake-bias")).toBe(true);
    expect(hasPairedValueSource("boost-level")).toBe(false);
  });
});

describe("style predicates", () => {
  it("classifies value-showing styles", () => {
    expect(styleShowsValue("split")).toBe(true);
    expect(styleShowsValue("pill-middle-horizontal")).toBe(true);
    expect(styleShowsValue("big-glyph")).toBe(false);
    expect(styleShowsValue("legacy")).toBe(false);
  });

  it("classifies pill / position-aware / pill-middle styles", () => {
    expect(isPillStyle("joined-pill")).toBe(true);
    expect(isPillStyle("pill-end")).toBe(true);
    expect(isPillStyle("pill-middle-vertical")).toBe(true);
    expect(isPillStyle("ghost")).toBe(false);
    expect(isPositionAwareStyle("edge-chevrons")).toBe(true);
    expect(isPositionAwareStyle("big-chevron")).toBe(true);
    expect(isPositionAwareStyle("split")).toBe(false);
    expect(isPillMiddleStyle("pill-middle-horizontal")).toBe(true);
    expect(isPillMiddleStyle("joined-pill")).toBe(false);
  });

  it("resolves auto position from direction", () => {
    expect(resolvePairPosition("auto", "increase")).toBe("right");
    expect(resolvePairPosition("auto", "decrease")).toBe("left");
    expect(resolvePairPosition("top", "decrease")).toBe("top");
  });
});

describe("telemetry wiring helpers", () => {
  const telemetry = { dcBrakeBias: 54.0 } as never;

  it("pairedKeyNeedsTelemetry is true only for value-showing styles with a source", () => {
    expect(pairedKeyNeedsTelemetry({ setting: "brake-bias", keyStyle: "split" })).toBe(true);
    expect(pairedKeyNeedsTelemetry({ setting: "brake-bias", keyStyle: "big-glyph" })).toBe(false);
    expect(pairedKeyNeedsTelemetry({ setting: "boost-level", keyStyle: "split" })).toBe(false);
    expect(pairedKeyNeedsTelemetry({ setting: "brake-bias", keyStyle: "legacy" })).toBe(false);
  });

  it("telemetryMemoValue returns the formatted value for views and paired adjust keys, null otherwise", () => {
    expect(telemetryMemoValue({ setting: "view-brake-bias", keyStyle: "legacy" }, telemetry)).toBe("54.0%");
    expect(telemetryMemoValue({ setting: "brake-bias", keyStyle: "split" }, telemetry)).toBe("54.0%");
    expect(telemetryMemoValue({ setting: "brake-bias", keyStyle: "legacy" }, telemetry)).toBeNull();
    expect(telemetryMemoValue({ setting: "brake-bias", keyStyle: "big-glyph" }, telemetry)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/iracing-actions/src/shared/adjust-styles.test.ts`
Expected: FAIL — cannot resolve `./adjust-styles.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/iracing-actions/src/shared/adjust-styles.ts` (the render entry `renderPairedIconOrNull` is added in Tasks 2–3; this task creates everything else):

```typescript
/**
 * Paired adjust key styles (spec: docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md).
 *
 * Lets two keys (both showing the live value) or three keys (View key in the
 * middle) form one increase/decrease control. This module owns the style
 * catalog, the shared Zod settings fields, fresh-key seeding, value-source
 * gating (via the VIEW_DEFS registry), unit-less value formatting, and (from
 * Tasks 2–3) the SVG renderer. Actions stay thin: they spread
 * `adjustStyleSettingsFields`, call `seedFreshKeyStyle` on first appear, route
 * rendering through `renderPairedIconOrNull`, and gate their telemetry
 * subscription with `pairedKeyNeedsTelemetry` / `telemetryMemoValue`.
 */
import type { TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import { formatViewValue, isViewSetting, VIEW_DEFS, type ViewSettingId } from "./setup-view.js";

/** Every selectable key style. Which subset applies depends on the mode kind (adjust vs View). */
export const ADJUST_KEY_STYLES = [
  "legacy",
  // Value-showing directional styles (2-key pairs).
  "corner-badge",
  "edge-chevrons",
  "split",
  "ghost",
  "joined-pill",
  // No-value directional styles (3-key group outer keys; also fine standalone).
  "big-glyph",
  "big-chevron",
  "pill-end",
  // View-key display styles (3-key group middle).
  "pill-middle-horizontal",
  "pill-middle-vertical",
] as const;

export type AdjustKeyStyle = (typeof ADJUST_KEY_STYLES)[number];

export const PAIR_POSITIONS = ["auto", "left", "right", "top", "bottom"] as const;
export type PairPosition = (typeof PAIR_POSITIONS)[number];

/**
 * Shared settings fields — spread into each action's `CommonSettings.extend`.
 * `.catch` (not just `.default`) so a value persisted by a newer plugin
 * version degrades to the default instead of failing the whole settings parse
 * (which would reset the key to full defaults — the 2.0 contamination bug).
 */
export const adjustStyleSettingsFields = {
  keyStyle: z.enum(ADJUST_KEY_STYLES).default("legacy").catch("legacy"),
  pairPosition: z.enum(PAIR_POSITIONS).default("auto").catch("auto"),
};

/** Gap between repeat steps while a paired key is held (≈ 6–7 steps/sec). */
export const ADJUST_REPEAT_INTERVAL_MS = 150;
/** Safety cap for a held paired key — catches dropped keyUp events. */
export const ADJUST_REPEAT_SAFETY_MS = 15_000;

/**
 * One-shot default seeding: a key that appears with NO persisted settings at
 * all is a fresh placement and gets the modern default (`split`); any
 * persisted field means the key predates this feature (or was configured) and
 * stays on the schema default `legacy`. Note: a pre-existing key whose PI was
 * never opened also has empty settings and therefore also seeds to `split` —
 * accepted in the design (its user accepted defaults; the default changed).
 */
export function seedFreshKeyStyle(raw: unknown): Record<string, unknown> | null {
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) return null;

  const obj = (raw ?? {}) as Record<string, unknown>;

  if (Object.keys(obj).length > 0) return null;

  return { keyStyle: "split" };
}

/**
 * Unit-less display value: strips a trailing "%" (the only unit VIEW_DEFS
 * formatters emit), keeps signs and decimals. "Everyone knows the unit, so
 * bigger value is more important."
 */
export function stripUnit(value: string): string {
  return value.endsWith("%") ? value.slice(0, -1) : value;
}

/** Inverse of the VIEW_DEFS adjustmentMode mapping: adjust-mode id → View id. */
const ADJUSTMENT_TO_VIEW: ReadonlyMap<string, ViewSettingId> = new Map(
  (Object.keys(VIEW_DEFS) as ViewSettingId[]).map((viewId) => [VIEW_DEFS[viewId].adjustmentMode, viewId]),
);

export function getViewIdForAdjustment(adjustmentMode: string): ViewSettingId | undefined {
  return ADJUSTMENT_TO_VIEW.get(adjustmentMode);
}

/**
 * A mode can use paired styles only when a live value exists for it: either it
 * IS a View id, or it's an adjust mode with a matching View def. Directional
 * modes without telemetry (qualifying-tape, boost-level, springs/shocks) stay
 * legacy-only by design.
 */
export function hasPairedValueSource(setting: string): boolean {
  return isViewSetting(setting) || ADJUSTMENT_TO_VIEW.has(setting);
}

const VALUE_SHOWING_STYLES: ReadonlySet<AdjustKeyStyle> = new Set([
  "corner-badge",
  "edge-chevrons",
  "split",
  "ghost",
  "joined-pill",
  "pill-middle-horizontal",
  "pill-middle-vertical",
]);

export function styleShowsValue(style: AdjustKeyStyle): boolean {
  return VALUE_SHOWING_STYLES.has(style);
}

const PILL_STYLES: ReadonlySet<AdjustKeyStyle> = new Set([
  "joined-pill",
  "pill-end",
  "pill-middle-horizontal",
  "pill-middle-vertical",
]);

/** Pill styles suppress the normal border (locked off) — the pill IS the border. */
export function isPillStyle(style: AdjustKeyStyle): boolean {
  return PILL_STYLES.has(style);
}

const POSITION_AWARE_STYLES: ReadonlySet<AdjustKeyStyle> = new Set([
  "edge-chevrons",
  "joined-pill",
  "pill-end",
  "big-chevron",
]);

/** Styles whose artwork depends on where the partner key sits (PI shows Position in Pair). */
export function isPositionAwareStyle(style: AdjustKeyStyle): boolean {
  return POSITION_AWARE_STYLES.has(style);
}

export function isPillMiddleStyle(style: AdjustKeyStyle): boolean {
  return style === "pill-middle-horizontal" || style === "pill-middle-vertical";
}

/** `auto` = the common horizontal layout: increase on the right, decrease on the left. */
export function resolvePairPosition(
  position: PairPosition,
  direction: "increase" | "decrease",
): "left" | "right" | "top" | "bottom" {
  if (position !== "auto") return position;

  return direction === "increase" ? "right" : "left";
}

/** True when this key's icon must re-render on telemetry ticks beyond the View case. */
export function pairedKeyNeedsTelemetry(s: { setting: string; keyStyle: AdjustKeyStyle }): boolean {
  return (
    !isViewSetting(s.setting) &&
    s.keyStyle !== "legacy" &&
    styleShowsValue(s.keyStyle) &&
    hasPairedValueSource(s.setting)
  );
}

/**
 * The string to memoize icon re-renders on, or null when the key's icon does
 * not depend on telemetry. Views memoize the same formatted value they always
 * have; paired adjust keys memoize the SOURCE value (with unit) — stripping is
 * monotonic, so change detection is identical.
 */
export function telemetryMemoValue(
  s: { setting: string; keyStyle: AdjustKeyStyle },
  telemetry: TelemetryData | null,
): string | null {
  if (isViewSetting(s.setting)) return formatViewValue(s.setting, telemetry);

  if (pairedKeyNeedsTelemetry(s)) {
    const viewId = getViewIdForAdjustment(s.setting);

    return viewId ? formatViewValue(viewId, telemetry) : null;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/iracing-actions/src/shared/adjust-styles.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Commit (include the spec file in this first commit)**

```bash
git add docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md docs/superpowers/plans/2026-07-07-paired-adjust-key-styles.md packages/iracing-actions/src/shared/adjust-styles.ts packages/iracing-actions/src/shared/adjust-styles.test.ts
git commit -m "feat(actions): add adjust-styles core (settings fields, seeding, gating, formatting)"
```

---

### Task 2: Renderer — template + value-showing styles

**Files:**
- Create: `packages/iracing-actions/icons/adjust-style.svg`
- Modify: `packages/iracing-actions/src/shared/adjust-styles.ts` (append renderer)
- Modify: `packages/iracing-actions/src/shared/adjust-styles.test.ts` (append renderer tests)

**Interfaces:**
- Consumes: Task 1 exports; from `@iracedeck/deck-core`: `applyBindingWarning`, `type BorderOverrides`, `type ColorSlots`, `generateBorderParts`, `generateTitleText`, `getGlobalBorderSettings`, `getGlobalColors`, `getGlobalTitleSettings`, `renderIconTemplate`, `resolveBorderSettings`, `resolveIconColors`, `resolveTitleSettings`, `svgToDataUri`, `type TitleOverrides`.
- Produces: `renderAdjustStyleSvg(inputs: AdjustStyleRenderInputs): string` (data URI) covering styles `corner-badge`, `split`, `ghost`, `edge-chevrons`. Task 3 extends the same function with the pill family, `big-glyph`, `big-chevron`, and adds `renderPairedIconOrNull`.

```typescript
export interface AdjustStyleRenderInputs {
  readonly style: Exclude<AdjustKeyStyle, "legacy">;
  readonly direction: "increase" | "decrease";
  readonly pairPosition: PairPosition;
  /** Already formatted + unit-stripped; null renders the "---" placeholder. */
  readonly value: string | null;
  /** Default label text, e.g. "BRAKE BIAS" (from VIEW_DEFS[...].label). */
  readonly label: string;
  /** Bump value font size for short integer readouts (from VIEW_DEFS valueFontSize ≥ 40). */
  readonly shortValue?: boolean;
  /** Representative static icon of the owning action — supplies background/text palette. */
  readonly colorSourceSvg?: string;
  readonly colorOverrides?: ColorSlots;
  readonly titleOverrides?: TitleOverrides;
  readonly borderOverrides?: BorderOverrides;
  readonly bindingMissing?: boolean;
}
```

- [ ] **Step 1: Create the dynamic template**

Create `packages/iracing-actions/icons/adjust-style.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a3444","textColor":"#ffffff","graphic1Color":"#f1c40f"}}</desc>
  {{borderDefs}}
  <g>
    <rect x="0" y="0" width="144" height="144" rx="24" fill="{{backgroundColor}}"/>
{{borderContent}}
    {{content}}
  </g>
</svg>
```

- [ ] **Step 2: Write the failing renderer tests**

Append to `adjust-styles.test.ts`. First add the partial deck-core mock at the very top of the file (before any imports of the module under test) so the pure icon-composer functions run for real while the global-settings readers are deterministic:

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("@iracedeck/deck-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@iracedeck/deck-core")>();

  return {
    ...actual,
    getGlobalColors: () => ({}),
    getGlobalTitleSettings: () => ({}),
    getGlobalBorderSettings: () => ({}),
    getGlobalGraphicSettings: () => ({}),
  };
});
```

(Adjust the existing `import { describe, expect, it } from "vitest";` line to the one above — `vi` is now needed.) Then append:

```typescript
import { renderAdjustStyleSvg } from "./adjust-styles.js";

/** Decode the data URI back to raw SVG for content assertions. */
function decode(dataUri: string): string {
  return decodeURIComponent(dataUri.replace("data:image/svg+xml,", ""));
}

const BASE = {
  direction: "increase",
  pairPosition: "auto",
  value: "54.0",
  label: "BRAKE BIAS",
} as const;

describe("renderAdjustStyleSvg — value-showing styles", () => {
  it("corner-badge renders value, label, and an accent badge with the direction glyph", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "corner-badge" }));
    expect(svg).toContain(">54.0</text>");
    expect(svg).toContain("BRAKE BIAS");
    expect(svg).toContain('circle cx="119" cy="25"');
    expect(svg).toContain("#f1c40f");
    expect(svg).toContain(">+</text>");
  });

  it("split renders label top, value middle, big glyph bottom; decrease shows a minus", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", direction: "decrease" }));
    expect(svg).toContain(">54.0</text>");
    expect(svg).toContain(">−</text>");
  });

  it("ghost renders a translucent glyph behind a full-size value", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "ghost" }));
    expect(svg).toContain('opacity="0.2"');
    expect(svg).toContain(">54.0</text>");
  });

  it("edge-chevrons places chevrons on the resolved edge, pointing in the direction of change", () => {
    // increase + auto → right edge, pointing right (x grows along the polyline)
    const inc = decode(renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons" }));
    expect(inc).toContain('points="114,52 130,72 114,92"');
    // decrease + auto → left edge, pointing left
    const dec = decode(renderAdjustStyleSvg({ ...BASE, style: "edge-chevrons", direction: "decrease" }));
    expect(dec).toContain('points="30,52 14,72 30,92"');
  });

  it("renders the null placeholder and applies the binding warning overlay", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "split", value: null, bindingMissing: true }));
    expect(svg).toContain("---");
    expect(svg).toContain('opacity="0.3"'); // dimmed content wrapper from applyBindingWarning
  });

  it("hides the label when titleOverrides.showTitle is false", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "corner-badge", titleOverrides: { showTitle: false } }));
    expect(svg).not.toContain("BRAKE BIAS");
  });
});
```

Note: if the `opacity="0.3"` dim assertion does not match `applyBindingWarning`'s actual output, read `packages/icon-composer/src/binding-warning.ts` and assert on the real dim-wrapper markup instead — the intent is "content is dimmed and the warning triangle polygon is present".

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run packages/iracing-actions/src/shared/adjust-styles.test.ts`
Expected: FAIL — `renderAdjustStyleSvg` is not exported. (Task 1 tests must still pass.)

- [ ] **Step 4: Implement the renderer core + four styles**

Append to `adjust-styles.ts` (new imports merge into the existing import block):

```typescript
import {
  applyBindingWarning,
  type BorderOverrides,
  type ColorSlots,
  generateBorderParts,
  generateTitleText,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
  type TitleOverrides,
} from "@iracedeck/deck-core";

import adjustStyleTemplate from "../../icons/adjust-style.svg";
```

Then the renderer (see the interface block above for `AdjustStyleRenderInputs`):

```typescript
/** Placeholder when no telemetry value is available (same string as View keys). */
const NULL_VALUE = "---";

/**
 * Per-style default-title sources. resolveTitleSettings reads title metadata
 * from an SVG string's <desc>; these tiny synthetic sources let each style set
 * its own defaults (and lock the fields that would break the layout) without a
 * file per style. Locked fields skip the GLOBAL title defaults only — a
 * per-key title override always wins (#755 semantics).
 */
const TITLE_SOURCE_BOTTOM = `<svg><desc>{"colors":{}}</desc></svg>`;
const TITLE_SOURCE_TOP = `<svg><desc>{"colors":{},"title":{"position":"top","locked":["position"]}}</desc></svg>`;
const TITLE_SOURCE_HIDDEN = `<svg><desc>{"colors":{},"title":{"showTitle":false,"locked":["showTitle"]}}</desc></svg>`;

/** Pill styles: the pill IS the border — normal border locked off (per-key override still wins). */
const PILL_BORDER_SOURCE = `<svg><desc>{"colors":{},"border":{"enabled":false,"glowEnabled":false,"locked":["enabled","glowEnabled"]}}</desc></svg>`;

const GLYPH: Record<"increase" | "decrease", string> = { increase: "+", decrease: "−" };

function valueText(value: string | null, x: number, y: number, size: number, fill: string): string {
  return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${fill}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold">${value ?? NULL_VALUE}</text>`;
}

function glyphText(direction: "increase" | "decrease", x: number, y: number, size: number, fill: string): string {
  return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${fill}" font-family="Arial, sans-serif" font-size="${size}" font-weight="bold">${GLYPH[direction]}</text>`;
}

/** Double chevron: `primary` is the outermost/leading chevron, the second is drawn at 45% opacity. */
function chevrons(primary: string, secondary: string, stroke: string, width: number): string {
  return (
    `<polyline points="${secondary}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="0.45"/>` +
    `<polyline points="${primary}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

export function renderAdjustStyleSvg(inputs: AdjustStyleRenderInputs): string {
  const { style, direction } = inputs;
  const position = resolvePairPosition(inputs.pairPosition, direction);

  // Background/text palette from the owning action's representative icon; the
  // ACCENT (graphic1Color) resolves against this template's own desc so its
  // default is the chevron yellow #f1c40f (the action icons declare a locked
  // white graphic1Color that must not leak into the accent).
  const styleSource = inputs.colorSourceSvg ?? adjustStyleTemplate;
  const colors = resolveIconColors(styleSource, getGlobalColors(), inputs.colorOverrides);
  const accent = resolveIconColors(adjustStyleTemplate, getGlobalColors(), inputs.colorOverrides).graphic1Color;

  const titleSource =
    style === "split"
      ? TITLE_SOURCE_TOP
      : style === "big-glyph" || style === "big-chevron" || style === "pill-end"
        ? TITLE_SOURCE_HIDDEN
        : style === "edge-chevrons" && position === "bottom"
          ? TITLE_SOURCE_TOP
          : TITLE_SOURCE_BOTTOM;
  const title = resolveTitleSettings(titleSource, getGlobalTitleSettings(), inputs.titleOverrides, inputs.label);
  const titleContent = title.showTitle
    ? generateTitleText({
        text: title.titleText,
        fontSize: title.fontSize,
        bold: title.bold,
        position: title.position,
        customPosition: title.customPosition,
        fill: colors.textColor,
      })
    : "";

  const borderSource = isPillStyle(style) ? PILL_BORDER_SOURCE : styleSource;
  const border = resolveBorderSettings(borderSource, getGlobalBorderSettings(), inputs.borderOverrides);
  const borderSvg = generateBorderParts(border);

  const bump = inputs.shortValue ? 8 : 0;
  const art = buildStyleArt(inputs, position, colors.textColor, accent, bump, title.showTitle);

  const inner = inputs.bindingMissing ? applyBindingWarning(art) : art;

  const svg = renderIconTemplate(adjustStyleTemplate, {
    backgroundColor: colors.backgroundColor,
    borderDefs: borderSvg.defs,
    borderContent: borderSvg.rects,
    content: inner + titleContent,
  });

  return svgToDataUri(svg);
}

/** Per-style artwork (value + direction accent), title excluded (rendered by the caller). */
function buildStyleArt(
  inputs: AdjustStyleRenderInputs,
  position: "left" | "right" | "top" | "bottom",
  textColor: string,
  accent: string,
  bump: number,
  labelShown: boolean,
): string {
  const { style, direction, value } = inputs;

  switch (style) {
    case "corner-badge":
      return (
        valueText(value, 72, 79, 44 + bump, textColor) +
        `<circle cx="119" cy="25" r="15" fill="${accent}"/>` +
        glyphText(direction, 119, 26, 26, "#2a2a2a")
      );

    case "split":
      return valueText(value, 72, 56, 38 + bump, textColor) + glyphText(direction, 72, 104, 62, accent);

    case "ghost":
      return (
        `<g opacity="0.2">${glyphText(direction, 72, 70, 130, accent)}</g>` +
        valueText(value, 72, 72, 44 + bump, textColor)
      );

    case "edge-chevrons": {
      // Chevrons sit on the `position` edge and point in the TRUE direction of
      // change: horizontal pairs point right for increase / left for decrease;
      // vertical pairs point up for increase / down for decrease.
      const horizontal = position === "left" || position === "right";

      if (horizontal) {
        // Point direction: increase → right, decrease → left. Edge: `position`.
        const pointsRight = direction === "increase";
        const onLeftEdge = position === "left";
        const art = pointsRight
          ? onLeftEdge
            ? chevrons("14,52 30,72 14,92", "30,52 46,72 30,92", accent, 7)
            : chevrons("114,52 130,72 114,92", "98,52 114,72 98,92", accent, 7)
          : onLeftEdge
            ? chevrons("30,52 14,72 30,92", "46,52 30,72 46,92", accent, 7)
            : chevrons("130,52 114,72 130,92", "114,52 98,72 114,92", accent, 7);
        const valueX = onLeftEdge ? 88 : 56;

        return art + valueText(value, valueX, 74, 38 + bump, textColor);
      }

      const pointsUp = direction === "increase";
      const art = pointsUp
        ? chevrons("52,30 72,14 92,30", "52,46 72,30 92,46", accent, 7)
        : chevrons("52,114 72,130 92,114", "52,98 72,114 92,98", accent, 7);
      const valueY = pointsUp ? 84 : labelShown ? 62 : 60;

      return art + valueText(value, 72, valueY, 38 + bump, textColor);
    }

    default:
      // Pill family + no-value styles are implemented in Task 3.
      return valueText(value, 72, 72, 44 + bump, textColor);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/iracing-actions/src/shared/adjust-styles.test.ts`
Expected: PASS. If a title/border assertion fails on real icon-composer behavior (e.g. locked-field handling), read `packages/icon-composer/src/title-settings.ts` and align the synthetic `<desc>` sources — do not weaken the assertion's intent.

- [ ] **Step 6: Commit**

```bash
git add packages/iracing-actions/icons/adjust-style.svg packages/iracing-actions/src/shared/adjust-styles.ts packages/iracing-actions/src/shared/adjust-styles.test.ts
git commit -m "feat(actions): adjust-styles renderer — corner badge, split, ghost, edge chevrons"
```

---

### Task 3: Renderer — pill family, no-value styles, and the high-level entry

**Files:**
- Modify: `packages/iracing-actions/src/shared/adjust-styles.ts`
- Modify: `packages/iracing-actions/src/shared/adjust-styles.test.ts`

**Interfaces:**
- Produces: complete `buildStyleArt` coverage for `joined-pill`, `pill-end`, `pill-middle-horizontal`, `pill-middle-vertical`, `big-glyph`, `big-chevron`, and:

```typescript
export interface PairedIconOptions {
  readonly setting: string; // current mode id (adjust mode or View id)
  readonly direction: "increase" | "decrease";
  readonly keyStyle: AdjustKeyStyle;
  readonly pairPosition: PairPosition;
  readonly telemetry: TelemetryData | null;
  readonly colorSourceSvg: string;
  readonly colorOverrides?: ColorSlots;
  readonly titleOverrides?: TitleOverrides;
  readonly borderOverrides?: BorderOverrides;
  readonly bindingMissing?: boolean;
}
/** Returns the styled icon, or null when the mode/style combination is not paired-capable (caller falls back to legacy). */
export function renderPairedIconOrNull(opts: PairedIconOptions): string | null;
```

- [ ] **Step 1: Write the failing tests**

Append to `adjust-styles.test.ts`:

```typescript
import { renderPairedIconOrNull } from "./adjust-styles.js";

describe("renderAdjustStyleSvg — pill family and no-value styles", () => {
  it("joined-pill draws a frame open toward the partner and no normal border", () => {
    const left = decode(renderAdjustStyleSvg({ ...BASE, style: "joined-pill", direction: "decrease" }));
    // decrease + auto → left key → frame open on the RIGHT edge (path starts and ends at x=144)
    expect(left).toContain('d="M144 14 H34');
    expect(left).toContain(">54.0</text>");
    expect(left).toContain(">−</text>");
  });

  it("pill-end uses equal margins and a centered glyph, no value, no label", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "pill-end", value: null }));
    expect(svg).toContain('d="M0 14 H110'); // increase + auto → right end → open LEFT
    expect(svg).toContain(">+</text>");
    expect(svg).not.toContain("---");
    expect(svg).not.toContain("BRAKE BIAS");
  });

  it("pill-middle-horizontal draws both rails and centers value + label", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "pill-middle-horizontal" }));
    expect(svg).toContain('d="M0 14 H144 M0 130 H144"');
    expect(svg).toContain(">54.0</text>");
    expect(svg).toContain("BRAKE BIAS");
  });

  it("big-glyph is a huge accent glyph with hidden label by default", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "big-glyph" }));
    expect(svg).toContain(">+</text>");
    expect(svg).not.toContain("BRAKE BIAS");
  });

  it("big-chevron points in the true direction of change", () => {
    const svg = decode(renderAdjustStyleSvg({ ...BASE, style: "big-chevron", pairPosition: "top" }));
    expect(svg).toContain('points="36,76 72,40 108,76"'); // vertical, increase → up
  });
});

describe("renderPairedIconOrNull", () => {
  const common = {
    direction: "increase",
    pairPosition: "auto",
    telemetry: { dcBrakeBias: 54.0 } as never,
    colorSourceSvg: `<svg><desc>{"colors":{"backgroundColor":"#3a2a1a","textColor":"#ffffff"}}</desc></svg>`,
  } as const;

  it("returns null for legacy style, valueless modes, and non-pill view styles", () => {
    expect(renderPairedIconOrNull({ ...common, setting: "brake-bias", keyStyle: "legacy" })).toBeNull();
    expect(renderPairedIconOrNull({ ...common, setting: "boost-level", keyStyle: "split" })).toBeNull();
    expect(renderPairedIconOrNull({ ...common, setting: "view-brake-bias", keyStyle: "split" })).toBeNull();
  });

  it("renders a paired adjust key with the unit-stripped live value", () => {
    const svg = decode(renderPairedIconOrNull({ ...common, setting: "brake-bias", keyStyle: "split" }) ?? "");
    expect(svg).toContain(">54.0</text>");
    expect(svg).not.toContain("54.0%");
  });

  it("renders a View key in pill-middle style", () => {
    const svg = decode(
      renderPairedIconOrNull({ ...common, setting: "view-brake-bias", keyStyle: "pill-middle-vertical" }) ?? "",
    );
    expect(svg).toContain('d="M14 0 V144 M130 0 V144"');
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run packages/iracing-actions/src/shared/adjust-styles.test.ts`
Expected: FAIL — pill cases hit the `default:` fallback; `renderPairedIconOrNull` not exported.

- [ ] **Step 3: Implement the remaining styles and the entry function**

Replace the `default:` arm of `buildStyleArt` with the concrete cases (geometry from the approved v2/v3 mockups; equal pill margin = 14; pill stroke width 5):

```typescript
    case "big-glyph":
      return glyphText(direction, 72, 72, 96, accent);

    case "big-chevron": {
      const horizontal = position === "left" || position === "right";

      if (horizontal) {
        return direction === "increase"
          ? chevrons("68,36 104,72 68,108", "32,36 68,72 32,108", accent, 10)
          : chevrons("76,36 40,72 76,108", "112,36 76,72 112,108", accent, 10);
      }

      return direction === "increase"
        ? chevrons("36,76 72,40 108,76", "36,112 72,76 108,112", accent, 10)
        : chevrons("36,68 72,104 108,68", "36,32 72,68 108,32", accent, 10);
    }

    case "joined-pill": {
      // Frame open toward the partner (the JOINED edge is the opposite of `position`).
      // With a visible bottom label (horizontal pair) the frame shortens to y 14..108;
      // without one it uses the equal-margin frame y 14..130.
      const yBot = labelShown && (position === "left" || position === "right") ? 108 : 130;
      const yQ = yBot - 20;

      switch (position) {
        case "left":
          return (
            `<path d="M144 14 H34 Q14 14 14 34 V${yQ} Q14 ${yBot} 34 ${yBot} H144" fill="none" stroke="${accent}" stroke-width="5"/>` +
            glyphText(direction, 38, (14 + yBot) / 2, 38, accent) +
            valueText(value, 92, (14 + yBot) / 2, 34 + bump, textColor)
          );
        case "right":
          return (
            `<path d="M0 14 H110 Q130 14 130 34 V${yQ} Q130 ${yBot} 110 ${yBot} H0" fill="none" stroke="${accent}" stroke-width="5"/>` +
            valueText(value, 52, (14 + yBot) / 2, 34 + bump, textColor) +
            glyphText(direction, 106, (14 + yBot) / 2, 38, accent)
          );
        case "top":
          return (
            `<path d="M14 144 V34 Q14 14 34 14 H110 Q130 14 130 34 V144" fill="none" stroke="${accent}" stroke-width="5"/>` +
            glyphText(direction, 72, 46, 38, accent) +
            valueText(value, 72, 88, 34 + bump, textColor)
          );
        case "bottom":
          return (
            `<path d="M14 0 V110 Q14 130 34 130 H110 Q130 130 130 110 V0" fill="none" stroke="${accent}" stroke-width="5"/>` +
            valueText(value, 72, 58, 34 + bump, textColor) +
            glyphText(direction, 72, 100, 38, accent)
          );
      }
      break;
    }

    case "pill-end": {
      switch (position) {
        case "left":
          return (
            `<path d="M144 14 H34 Q14 14 14 34 V110 Q14 130 34 130 H144" fill="none" stroke="${accent}" stroke-width="5"/>` +
            glyphText(direction, 72, 72, 52, accent)
          );
        case "right":
          return (
            `<path d="M0 14 H110 Q130 14 130 34 V110 Q130 130 110 130 H0" fill="none" stroke="${accent}" stroke-width="5"/>` +
            glyphText(direction, 72, 72, 52, accent)
          );
        case "top":
          return (
            `<path d="M14 144 V34 Q14 14 34 14 H110 Q130 14 130 34 V144" fill="none" stroke="${accent}" stroke-width="5"/>` +
            glyphText(direction, 72, 80, 52, accent)
          );
        case "bottom":
          return (
            `<path d="M14 0 V110 Q14 130 34 130 H110 Q130 130 130 110 V0" fill="none" stroke="${accent}" stroke-width="5"/>` +
            glyphText(direction, 72, 64, 52, accent)
          );
      }
      break;
    }

    case "pill-middle-horizontal":
      return (
        `<path d="M0 14 H144 M0 130 H144" fill="none" stroke="${accent}" stroke-width="5"/>` +
        valueText(value, 72, 62, 42 + bump, textColor)
      );

    case "pill-middle-vertical":
      return (
        `<path d="M14 0 V144 M130 0 V144" fill="none" stroke="${accent}" stroke-width="5"/>` +
        valueText(value, 72, 58, 38 + bump, textColor)
      );
```

TypeScript cannot prove the nested position switches exhaustive, so after replacing the `default:` arm, end `buildStyleArt` with an unreachable fallback so every code path returns:

```typescript
  }

  return valueText(inputs.value, 72, 72, 44, textColor); // unreachable — every style case returns above
}
```

**Pill-middle labels:** the middle segments draw their label at a fixed position inside the pill instead of the standard bottom/top title. In `renderAdjustStyleSvg`, add after the `titleContent` computation:

```typescript
  // Pill-middle labels live INSIDE the pill at a fixed spot; suppress the
  // standard positioned title and draw the label directly (text/bold/size/show
  // overrides still apply; position/customPosition are style-fixed).
  const pillMiddleLabel =
    isPillMiddleStyle(style) && title.showTitle
      ? `<text x="72" y="${style === "pill-middle-horizontal" ? 108 : 102}" text-anchor="middle" fill="${colors.textColor}" font-family="Arial, sans-serif" font-size="14" font-weight="${title.bold ? "bold" : "normal"}">${title.titleText}</text>`
      : "";
```

and change the final content assembly line to:

```typescript
    content: inner + (isPillMiddleStyle(style) ? pillMiddleLabel : titleContent),
```

Then add the high-level entry at the end of the file:

```typescript
/**
 * The single per-action entry point: returns the styled paired icon, or null
 * when the key must fall back to its existing (legacy / View) render path.
 * Applies all gating: legacy style, valueless modes, and View modes with a
 * non-pill-middle style all return null.
 */
export function renderPairedIconOrNull(opts: PairedIconOptions): string | null {
  const { setting, keyStyle } = opts;

  if (keyStyle === "legacy") return null;

  if (isViewSetting(setting)) {
    if (!isPillMiddleStyle(keyStyle)) return null;

    const def = VIEW_DEFS[setting];

    return renderAdjustStyleSvg({
      style: keyStyle,
      direction: opts.direction,
      pairPosition: opts.pairPosition,
      value: stripUnit(formatViewValue(setting, opts.telemetry)),
      label: def.label,
      shortValue: (def.valueFontSize ?? 36) >= 40,
      colorSourceSvg: opts.colorSourceSvg,
      colorOverrides: opts.colorOverrides,
      titleOverrides: opts.titleOverrides,
      borderOverrides: opts.borderOverrides,
      bindingMissing: opts.bindingMissing,
    });
  }

  const viewId = getViewIdForAdjustment(setting);

  if (!viewId) return null;

  if (isPillMiddleStyle(keyStyle)) return null; // middle segments are View-key styles

  const def = VIEW_DEFS[viewId];

  return renderAdjustStyleSvg({
    style: keyStyle,
    direction: opts.direction,
    pairPosition: opts.pairPosition,
    value: styleShowsValue(keyStyle) ? stripUnit(formatViewValue(viewId, opts.telemetry)) : null,
    label: def.label,
    shortValue: (def.valueFontSize ?? 36) >= 40,
    colorSourceSvg: opts.colorSourceSvg,
    colorOverrides: opts.colorOverrides,
    titleOverrides: opts.titleOverrides,
    borderOverrides: opts.borderOverrides,
    bindingMissing: opts.bindingMissing,
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/iracing-actions/src/shared/adjust-styles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/shared/adjust-styles.ts packages/iracing-actions/src/shared/adjust-styles.test.ts
git commit -m "feat(actions): adjust-styles renderer — pill family, no-value styles, renderPairedIconOrNull"
```

---

### Task 4: Shared PI partial `adjust-style.ejs`

**Files:**
- Create: `packages/pi-components/partials/adjust-style.ejs`

**Interfaces:**
- Consumes (EJS params from each action template): `modeSelectId: string` (always `'setting-select'` for the setup actions), `pairedModes: string[]` (adjust modes with a value source), `viewModes: string[]` (View mode ids).
- Produces: three `sdpi-item`s — "Key Style" (adjust modes), "Display Style" (View modes; both selects bind the same `keyStyle` setting), "Position in Pair" (`pairPosition`) — with self-contained visibility JS.

- [ ] **Step 1: Create the partial**

```ejs
<%
// Paired adjust key styles (spec 2026-07-07). Params:
//   modeSelectId — DOM id of the action's mode <sdpi-select>
//   pairedModes  — adjust-mode values that support paired styles (value source exists)
//   viewModes    — View-mode values (get the Display Style select instead)
// Both style selects bind the SAME `keyStyle` setting; visibility picks which
// one applies to the current mode. `legacy` doubles as the View "Default".
%>
<sdpi-item label="Key Style" id="adjust-style-item" class="hidden">
	<sdpi-select id="adjust-style-select" setting="keyStyle" default="legacy">
		<option value="legacy">Legacy (arrows)</option>
		<optgroup label="Value on this key (2-key pairs)">
			<option value="split">Split — value + big +/−</option>
			<option value="corner-badge">Corner badge</option>
			<option value="ghost">Ghost +/−</option>
			<option value="edge-chevrons">Edge chevrons</option>
			<option value="joined-pill">Joined pill</option>
		</optgroup>
		<optgroup label="No value (3-key groups)">
			<option value="big-glyph">Big +/−</option>
			<option value="big-chevron">Big chevrons</option>
			<option value="pill-end">Pill end</option>
		</optgroup>
	</sdpi-select>
</sdpi-item>
<sdpi-item label="Display Style" id="adjust-view-style-item" class="hidden">
	<sdpi-select id="adjust-view-style-select" setting="keyStyle" default="legacy">
		<option value="legacy">Default</option>
		<option value="pill-middle-horizontal">Pill middle — horizontal</option>
		<option value="pill-middle-vertical">Pill middle — vertical</option>
	</sdpi-select>
</sdpi-item>
<sdpi-item label="Position in Pair" id="adjust-position-item" class="hidden">
	<sdpi-select setting="pairPosition" default="auto">
		<option value="auto">Auto (from direction)</option>
		<option value="left">Left</option>
		<option value="right">Right</option>
		<option value="top">Top</option>
		<option value="bottom">Bottom</option>
	</sdpi-select>
</sdpi-item>
<div class="ird-supporting-text" id="adjust-style-help">
	Place two keys with opposite directions next to each other — or three with a View key in the middle. Both keys show the live value; hold a key to keep stepping.
</div>

<script>
	(function () {
		const PAIRED_MODES = <%- JSON.stringify(pairedModes) %>;
		const VIEW_MODES = <%- JSON.stringify(viewModes) %>;
		const POSITION_AWARE = ["edge-chevrons", "joined-pill", "pill-end", "big-chevron"];

		function updateAdjustStyleVisibility() {
			const mode = document.getElementById("<%= modeSelectId %>")?.value || "";
			const styleItem = document.getElementById("adjust-style-item");
			const viewStyleItem = document.getElementById("adjust-view-style-item");
			const positionItem = document.getElementById("adjust-position-item");
			const help = document.getElementById("adjust-style-help");

			const isPaired = PAIRED_MODES.includes(mode);
			const isView = VIEW_MODES.includes(mode);
			styleItem?.classList.toggle("hidden", !isPaired);
			viewStyleItem?.classList.toggle("hidden", !isView);
			help?.classList.toggle("hidden", !isPaired && !isView);

			const style = document.getElementById(isView ? "adjust-view-style-select" : "adjust-style-select")?.value || "legacy";
			positionItem?.classList.toggle("hidden", !(isPaired && POSITION_AWARE.includes(style)));
		}

		async function initAdjustStyle() {
			await customElements.whenDefined("sdpi-select");
			updateAdjustStyleVisibility();

			for (const id of ["<%= modeSelectId %>", "adjust-style-select", "adjust-view-style-select"]) {
				const el = document.getElementById(id);
				el?.addEventListener("change", updateAdjustStyleVisibility);
				el?.addEventListener("input", updateAdjustStyleVisibility);
			}

			// Polling fallback — sdpi-select events can be unreliable.
			let last = "";
			setInterval(() => {
				const mode = document.getElementById("<%= modeSelectId %>")?.value || "";
				const style = document.getElementById("adjust-style-select")?.value || "";
				const key = mode + "|" + style;
				if (key !== last) {
					last = key;
					updateAdjustStyleVisibility();
				}
			}, 100);
		}

		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initAdjustStyle);
		else initAdjustStyle();
	})();
</script>
<style>
	.hidden { display: none !important; }
</style>
```

- [ ] **Step 2: Verify the partial compiles (no consumer yet — smoke via the brakes build in Task 5)**

Run: `pnpm --filter @iracedeck/pi-components build`
Expected: PASS (partials are copied/consumed at plugin build time; this validates the package still builds).

- [ ] **Step 3: Commit**

```bash
git add packages/pi-components/partials/adjust-style.ejs
git commit -m "feat(pi): shared adjust-style PI partial (key style, display style, position in pair)"
```

---

### Task 5: Setup Brakes adoption (reference implementation)

**Files:**
- Modify: `packages/iracing-actions/src/actions/setup-brakes/setup-brakes-settings.ts`
- Modify: `packages/iracing-actions/src/actions/setup-brakes/setup-brakes.ts`
- Modify: `packages/iracing-actions/src/actions/setup-brakes/setup-brakes.ejs`
- Modify: `packages/iracing-actions/src/actions/setup-brakes/setup-brakes.test.ts`

**Interfaces:**
- Consumes: everything Task 1–4 produces; `RepeatController` from `../../shared/repeat-controller.js`; `IconUpdateThrottle` from `../../shared/icon-update-throttle.js`; `getDualPressThresholdMs` from `@iracedeck/deck-core`.
- Produces: the adoption pattern Tasks 6–11 replicate. Paired modes for brakes: `["abs-adjust","brake-bias","brake-bias-fine","peak-brake-bias","brake-misc","engine-braking"]`; view modes: `["view-brake-bias","view-brake-bias-fine","view-peak-brake-bias","view-brake-misc","view-engine-braking","view-abs-adjust"]`.

- [ ] **Step 1: Write the failing tests**

Append to `setup-brakes.test.ts` (inside the existing top-level `describe`, using the file's existing mock setup — the deck-core mock there must also gain `getDualPressThresholdMs: vi.fn(() => 500)` if absent):

```typescript
describe("paired key styles", () => {
  it("parses keyStyle/pairPosition with defaults and catch-degradation", () => {
    const parsed = parseSetupBrakesSettings({ setting: "brake-bias" });
    expect(parsed.keyStyle).toBe("legacy");
    expect(parsed.pairPosition).toBe("auto");
    const degraded = parseSetupBrakesSettings({ setting: "brake-bias", keyStyle: "hologram" });
    expect(degraded.keyStyle).toBe("legacy");
    expect(degraded.setting).toBe("brake-bias"); // catch keeps the rest of the parse alive
  });
});
```

(`parseSetupBrakesSettings` is already exported from `setup-brakes-settings.ts`.) Seeding and rendering behavior are covered by the shared-module tests; the per-action test guards the schema wiring.

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npx vitest run packages/iracing-actions/src/actions/setup-brakes/setup-brakes.test.ts`
Expected: FAIL — `keyStyle` is `undefined` (field not in schema yet).

- [ ] **Step 3: Extend the settings schema**

In `setup-brakes-settings.ts`, add the import and spread the shared fields into `SetupBrakesSettings`:

```typescript
import { adjustStyleSettingsFields } from "../../shared/adjust-styles.js";
```

```typescript
export const SetupBrakesSettings = CommonSettings.extend({
  setting: z
    .enum([
      /* ...existing values unchanged... */
    ])
    .default("brake-bias"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
  ...adjustStyleSettingsFields,
  /* dualPressEnabled and dial stay unchanged */
});
```

(Keep every existing field; only the `...adjustStyleSettingsFields` line is new.)

- [ ] **Step 4: Wire the action class**

In `setup-brakes.ts`:

a. Add imports:

```typescript
import { getDualPressThresholdMs } from "@iracedeck/deck-core"; // merge into the existing deck-core import block
import {
  ADJUST_REPEAT_INTERVAL_MS,
  ADJUST_REPEAT_SAFETY_MS,
  hasPairedValueSource,
  pairedKeyNeedsTelemetry,
  renderPairedIconOrNull,
  seedFreshKeyStyle,
  telemetryMemoValue,
} from "../../shared/adjust-styles.js";
import { IconUpdateThrottle } from "../../shared/icon-update-throttle.js";
import { RepeatController } from "../../shared/repeat-controller.js";
```

b. Add class fields next to the existing `dualPress` field:

```typescript
  /** Hold-to-repeat for paired-style directional keys (always on, spec 2026-07-07). */
  private readonly repeat = new RepeatController(this.logger);

  /** Coalesces telemetry-driven re-renders to ≤ 10/s per key (issue #493 pattern). */
  private readonly iconThrottle = new IconUpdateThrottle();
```

c. In `onWillAppear`, inside the keypad path (AFTER the `if (ev.action.isDial()) { ... return; }` block, BEFORE `this.activeContexts.set(...)`), add the one-shot seed:

```typescript
    // One-shot default seeding (spec 2026-07-07): a never-configured key gets
    // the modern `split` style; keys with any persisted settings stay legacy.
    const seeded = seedFreshKeyStyle(ev.payload.settings);

    if (seeded) {
      await ev.action.setSettings(seeded);
      settings = this.parseSettings(seeded);
    }
```

(`settings` is declared with `let` in this file already.)

d. Extend the telemetry subscription predicate in `onWillAppear` — replace:

```typescript
      if (stored && isViewSetting(stored.setting)) {
        void this.updateDisplayFromTelemetry(ev.action.id, telemetry, stored);
      }
```

with:

```typescript
      if (stored && (isViewSetting(stored.setting) || pairedKeyNeedsTelemetry(stored))) {
        void this.updateDisplayFromTelemetry(ev.action.id, telemetry, stored);
      }
```

e. In `onKeyDown`, replace the final two lines (`this.logger.info("Key down received"); await this.executeSetting(...)`) with:

```typescript
    this.logger.info("Key down received");

    // Hold-to-repeat for paired-style keys: arm SYNCHRONOUSLY before the first
    // execute so a racing keyUp always finds timers to clear (fuel-service pattern).
    if (settings.keyStyle !== "legacy" && hasPairedValueSource(settings.setting)) {
      const { setting, direction } = settings;
      this.repeat.onKeyDown(ev.action.id, {
        holdMs: getDualPressThresholdMs(),
        intervalMs: ADJUST_REPEAT_INTERVAL_MS,
        safetyMs: ADJUST_REPEAT_SAFETY_MS,
        execute: async () => {
          await this.executeSetting(setting as SetupBrakesAdjustSetting, direction);

          return true;
        },
      });
    }

    await this.executeSetting(settings.setting, settings.direction);
```

(The `settings.setting` here is already narrowed past `isViewSetting` by the early return above it — keep the existing cast style of the file.)

f. In `onKeyUp`, add as the FIRST line of the method body:

```typescript
    this.repeat.onKeyUp(ev.action.id);
```

g. In `onWillDisappear` and `onDidReceiveSettings` (keypad path), add next to the existing `dualPress.clear` / cache-bust lines:

```typescript
    this.repeat.clear(ev.action.id);
```

h. In `renderIcon`, insert the paired branch FIRST (before the `isViewSetting` branch):

```typescript
  private renderIcon(settings: SetupBrakesSettings): string {
    const bindingMissing = this.computeBindingMissing(settings);

    const paired = renderPairedIconOrNull({
      setting: settings.setting,
      direction: settings.direction,
      keyStyle: settings.keyStyle,
      pairPosition: settings.pairPosition,
      telemetry: this.sdkController.getCurrentTelemetry(),
      colorSourceSvg: brakeBiasIncreaseIconSvg,
      colorOverrides: settings.colorOverrides,
      titleOverrides: settings.titleOverrides,
      borderOverrides: settings.borderOverrides,
      bindingMissing,
    });

    if (paired) return paired;

    /* existing isViewSetting branch and legacy fallthrough unchanged */
  }
```

i. Generalize `updateDisplayFromTelemetry` (replace the method body):

```typescript
  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: SetupBrakesSettings,
  ): Promise<void> {
    const memo = telemetryMemoValue(settings, telemetry);

    if (memo === null) return;

    if (this.lastRenderedValue.get(contextId) === memo) return;

    this.lastRenderedValue.set(contextId, memo);
    this.iconThrottle.schedule(contextId, async () => {
      const stored = this.activeContexts.get(contextId);

      if (stored) await this.updateKeyImage(contextId, this.renderIcon(stored));
    });
  }
```

j. In `updateDisplay`, replace the view-only memo block:

```typescript
    if (isViewSetting(settings.setting)) {
      const telemetry = this.sdkController.getCurrentTelemetry();
      this.lastRenderedValue.set(ev.action.id, formatViewValue(settings.setting, telemetry));
    }
```

with:

```typescript
    const memo = telemetryMemoValue(settings, this.sdkController.getCurrentTelemetry());

    if (memo !== null) {
      this.lastRenderedValue.set(ev.action.id, memo);
    }
```

(If `formatViewValue` is now unused in the file, drop it from the `setup-view.js` import.)

- [ ] **Step 5: Wire the PI**

In `setup-brakes.ejs`, directly after the `dual-press-overrides` include (or after the Direction `sdpi-item` if the include order differs — the partial must sit below the Direction control), add:

```ejs
		<%- include('adjust-style', {
			modeSelectId: 'setting-select',
			pairedModes: ['abs-adjust', 'brake-bias', 'brake-bias-fine', 'peak-brake-bias', 'brake-misc', 'engine-braking'],
			viewModes: ['view-brake-bias', 'view-brake-bias-fine', 'view-peak-brake-bias', 'view-brake-misc', 'view-engine-braking', 'view-abs-adjust']
		}) %>
```

- [ ] **Step 6: Run the action tests**

Run: `npx vitest run packages/iracing-actions/src/actions/setup-brakes/setup-brakes.test.ts packages/iracing-actions/src/shared/adjust-styles.test.ts`
Expected: PASS. If the existing mock lacks `getDualPressThresholdMs` or `updateKeyImage`, add them to the mock (`getDualPressThresholdMs: vi.fn(() => 500)`; `updateKeyImage = vi.fn()` on the mock base class).

- [ ] **Step 7: Build both plugins to validate TS + PI compile**

Run: `pnpm build`
Expected: PASS (all three plugins bundle the shared sources; the brakes PI compiles with the new partial).

- [ ] **Step 8: Commit**

```bash
git add packages/iracing-actions/src/actions/setup-brakes packages/iracing-actions/src/shared
git commit -m "feat(setup-brakes): paired adjust key styles + hold-to-repeat (reference adoption)"
```

---

### Tasks 6–11: Adopt in the remaining six setup actions

Each task applies the SAME transformation as Task 5 (steps 1–6 there), with the per-action identifiers below. The pattern is verbatim identical across these actions (they share the #541 structure); differences are only names and mode lists. For each action: extend the schema with `...adjustStyleSettingsFields` (these six define their schema inline in `<action>.ts`, not in a separate settings file), add the `repeat`/`iconThrottle` fields, seed in `onWillAppear` (these actions have no dial branch — insert the seed guarded by `if (!ev.action.isDial())` right after `const settings = this.parseSettings(...)`, converting that `const` to `let`), extend the subscribe predicate, arm repeat in `onKeyDown` (adjust path only, i.e. after the view early-return), `repeat.onKeyUp` first line of `onKeyUp`, `repeat.clear` in `onWillDisappear` + `onDidReceiveSettings`, paired branch first in `renderIcon` (with that action's `colorSourceSvg`), generalized `updateDisplayFromTelemetry` + `updateDisplay` memo, PI include after the action's Direction/dual-press controls, and the same schema-wiring test (each action exposes a private `parseSettings`; where no parse helper is exported, assert via the exported `generate<Action>Svg` accepting the parsed shape — or export the schema parse the same way brakes does; keep it minimal).

One commit per action: `feat(<action>): paired adjust key styles + hold-to-repeat`.

### Task 6: Setup Aero

**Files:** Modify `packages/iracing-actions/src/actions/setup-aero/setup-aero.ts`, `setup-aero.ejs`, `setup-aero.test.ts`

- `colorSourceSvg`: `frontWingIncreaseIconSvg`
- `pairedModes: ['front-wing', 'rear-wing']` (qualifying-tape and rf-brake-attached have no value source — excluded)
- `viewModes: ['view-front-wing', 'view-rear-wing']`
- Note: `onDialDown`/`onDialRotate` bare handlers exist — leave untouched; the seed's `!ev.action.isDial()` guard keeps dial contexts unseeded.

- [ ] Apply the Task 5 transformation with the identifiers above; run `npx vitest run packages/iracing-actions/src/actions/setup-aero/setup-aero.test.ts`; expected PASS.
- [ ] Commit: `git add packages/iracing-actions/src/actions/setup-aero && git commit -m "feat(setup-aero): paired adjust key styles + hold-to-repeat"`

### Task 7: Setup Traction

**Files:** Modify `packages/iracing-actions/src/actions/setup-traction/setup-traction.ts`, `setup-traction.ejs`, `setup-traction.test.ts`

- `colorSourceSvg`: the action's existing representative icon passed to `generateSetupViewSvg` (read the file — same variable the view branch already uses).
- `pairedModes: ['tc-slot-1', 'tc-slot-2', 'tc-slot-3', 'tc-slot-4']` (tc-toggle excluded — non-directional)
- `viewModes: ['view-tc-slot-1', 'view-tc-slot-2', 'view-tc-slot-3', 'view-tc-slot-4']`

- [ ] Apply the transformation; run `npx vitest run packages/iracing-actions/src/actions/setup-traction/setup-traction.test.ts`; expected PASS.
- [ ] Commit: `git add packages/iracing-actions/src/actions/setup-traction && git commit -m "feat(setup-traction): paired adjust key styles + hold-to-repeat"`

### Task 8: Setup Fuel

**Files:** Modify `packages/iracing-actions/src/actions/setup-fuel/setup-fuel.ts`, `setup-fuel.ejs`, `setup-fuel.test.ts`

- `colorSourceSvg`: the view branch's existing representative icon.
- `pairedModes: ['fuel-mixture', 'fuel-cut-position']`
- `viewModes: ['view-fuel-mixture', 'view-fuel-cut-position']`

- [ ] Apply the transformation; run `npx vitest run packages/iracing-actions/src/actions/setup-fuel/setup-fuel.test.ts`; expected PASS.
- [ ] Commit: `git add packages/iracing-actions/src/actions/setup-fuel && git commit -m "feat(setup-fuel): paired adjust key styles + hold-to-repeat"`

### Task 9: Setup Engine

**Files:** Modify `packages/iracing-actions/src/actions/setup-engine/setup-engine.ts`, `setup-engine.ejs`, `setup-engine.test.ts`

- `colorSourceSvg`: `enginePowerIncreaseIconSvg`
- `pairedModes: ['engine-power', 'throttle-shaping', 'launch-rpm']` (boost-level excluded — no value source)
- `viewModes: ['view-engine-power', 'view-throttle-shape', 'view-launch-rpm']`
- Note the id mismatch is handled by the shared inversion: adjust mode `throttle-shaping` ↔ view `view-throttle-shape`.

- [ ] Apply the transformation; run `npx vitest run packages/iracing-actions/src/actions/setup-engine/setup-engine.test.ts`; expected PASS.
- [ ] Commit: `git add packages/iracing-actions/src/actions/setup-engine && git commit -m "feat(setup-engine): paired adjust key styles + hold-to-repeat"`

### Task 10: Setup Chassis

**Files:** Modify `packages/iracing-actions/src/actions/setup-chassis/setup-chassis.ts`, `setup-chassis.ejs`, `setup-chassis.test.ts`

- `colorSourceSvg`: the view branch's existing representative icon.
- `pairedModes: ['differential-preload', 'differential-entry', 'differential-middle', 'differential-exit', 'front-arb', 'rear-arb', 'power-steering']` (springs/shocks excluded — no value source)
- `viewModes: ['view-diff-preload', 'view-diff-entry', 'view-diff-middle', 'view-diff-exit', 'view-anti-roll-front', 'view-anti-roll-rear', 'view-power-steering', 'view-weight-jacker-left', 'view-weight-jacker-right']`
- Note: the weight-jacker views have NO adjust sub-mode in this action — they still get pill-middle display styles (display-only), which the shared entry handles.

- [ ] Apply the transformation; run `npx vitest run packages/iracing-actions/src/actions/setup-chassis/setup-chassis.test.ts`; expected PASS.
- [ ] Commit: `git add packages/iracing-actions/src/actions/setup-chassis && git commit -m "feat(setup-chassis): paired adjust key styles + hold-to-repeat"`

### Task 11: Setup Hybrid

**Files:** Modify `packages/iracing-actions/src/actions/setup-hybrid/setup-hybrid.ts`, `setup-hybrid.ejs`, `setup-hybrid.test.ts`

- `colorSourceSvg`: the view branch's existing representative icon.
- `pairedModes: ['mguk-deploy-mode', 'mguk-regen-gain', 'mguk-fixed-deploy']`
- `viewModes: ['view-mguk-deploy-mode', 'view-mguk-regen-gain', 'view-mguk-deploy-fixed']`
- **CAUTION:** this action has `HOLD_CONTROLS` (`hys-boost`, `hys-regen`) using `holdBinding`/`releaseBinding` on keyDown/keyUp. The repeat arming MUST be gated exactly as in Task 5 (`keyStyle !== "legacy" && hasPairedValueSource(setting)`), which excludes the hys modes; `repeat.onKeyUp` at the top of `onKeyUp` is a no-op for non-held ids and must be placed BEFORE the existing hold-release logic without altering it.

- [ ] Apply the transformation; run `npx vitest run packages/iracing-actions/src/actions/setup-hybrid/setup-hybrid.test.ts`; expected PASS.
- [ ] Commit: `git add packages/iracing-actions/src/actions/setup-hybrid && git commit -m "feat(setup-hybrid): paired adjust key styles + hold-to-repeat"`

---

### Task 12: Documentation, changelog, skill

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/car-setup/setup-brakes.md` (and the six sibling pages `setup-aero.md`, `setup-traction.md`, `setup-fuel.md`, `setup-engine.md`, `setup-chassis.md`, `setup-hybrid.md` in the same directory)
- Modify: `packages/website/src/content/docs/changelog.mdx`
- Modify: `.claude/skills/iracedeck-actions/SKILL.md`
- Modify: `packages/iracing-actions/CLAUDE.md`

- [ ] **Step 1: Website action pages**

Add this section to each of the seven car-setup action pages, after the page's mode/settings documentation (adapt only the mode names in the second sentence to the action's `pairedModes` from Tasks 5–11):

```markdown
### Key Styles — paired +/− buttons

Adjustment modes with a live value can render as **paired keys**: place two keys with opposite directions next to each other (or three, with a View key in the middle) and both show the live value — no separate display key needed. Choose the look under **Key Style**:

- **Legacy (arrows)** — the classic static arrow icon (default for existing keys).
- **Split** — label on top, live value in the middle, a big +/− below (default for newly placed keys).
- **Corner badge**, **Ghost +/−**, **Edge chevrons**, **Joined pill** — alternative value-showing pair looks.
- **Big +/−**, **Big chevrons**, **Pill end** — no-value styles for the outer keys of a 3-key group; the View key in the middle shows the value (set its **Display Style** to *Pill middle* to span the pill across all three keys).

Values are shown without units for maximum size. **Edge chevrons**, **Joined pill**, **Pill end**, and **Big chevrons** take a **Position in Pair** setting (*Auto* follows the direction: increase right, decrease left; pick *Top*/*Bottom* for vertical stacks). Holding a paired key repeats the adjustment until released. Colors follow the normal color overrides (the +/− accent is the *Graphic 1* slot); pill styles disable the normal border — the pill itself is the frame.
```

- [ ] **Step 2: Changelog**

In `packages/website/src/content/docs/changelog.mdx`, under the top in-development version section (create `## 2.0.0` with `_Unreleased_` only if it does not already exist — it should), add under `**Features**`:

```markdown
- Setup actions can render increase/decrease keys as space-saving paired buttons that show the live value (unit-less) in six selectable styles, with three-key layouts around a value key, horizontal or vertical, plus hold-to-repeat.
```

- [ ] **Step 3: Skill + package docs**

In `.claude/skills/iracedeck-actions/SKILL.md`, find the setup-action entries and note the new capability once (matching the file's existing style — one line, not per action): paired +/− key styles with live value, 2-key and 3-key layouts, hold-to-repeat, Phase 1 = the seven setup actions.

In `packages/iracing-actions/CLAUDE.md`, add to the `src/shared/` list:

```markdown
- `adjust-styles.ts` — paired +/− key styles: style catalog, shared settings fields + fresh-key seeding, value-source gating over VIEW_DEFS, and the SVG renderer (spec: docs/superpowers/specs/2026-07-07-paired-adjust-key-styles-design.md)
```

- [ ] **Step 4: Verify website builds**

Run: `pnpm --filter @iracedeck/website build`
Expected: PASS; changelog renders at `/changelog/`.

- [ ] **Step 5: Commit**

```bash
git add packages/website/src/content/docs .claude/skills/iracedeck-actions/SKILL.md packages/iracing-actions/CLAUDE.md
git commit -m "docs: paired adjust key styles — action pages, changelog, skill, package docs"
```

---

### Task 13: Full verification sweep

- [ ] **Step 1:** `pnpm install` (no lockfile changes expected — this plan adds no dependencies; if the lockfile changed, something is wrong).
- [ ] **Step 2:** `pnpm build` — expected PASS for every package. If a deck host app is running (Stream Deck / UlanziStudio), quit it first — it locks `iracing_native.node` and fails the build with EPERM.
- [ ] **Step 3:** `pnpm test` — expected PASS, all suites.
- [ ] **Step 4:** `pnpm lint:fix && pnpm format:fix` — commit any resulting changes as `chore: lint/format`.
- [ ] **Step 5:** Manual smoke checklist for the user's live test (do NOT push or open a PR — the user tests in iRacing first, per workflow):
  - Fresh key placed → split style appears with live value once iRacing runs; `---` before that.
  - Existing brake-bias key → unchanged legacy arrows.
  - Two keys L/R with opposite directions in each value style; vertical pair with explicit Top/Bottom positions.
  - Triple: pill-end / pill-middle-horizontal / pill-end.
  - Hold a paired key ≥ threshold → repeats ~6/s until release.
  - Unbind the mode's key binding → warning triangle over dimmed content; PI status line unchanged.
  - Color overrides (accent via Graphic 1), title override "BB" on a pill key, border override on a non-pill style.
