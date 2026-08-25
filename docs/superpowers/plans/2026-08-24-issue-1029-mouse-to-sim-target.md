# Configurable Mouse to Sim Pointer Target — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user choose where the Mouse to Sim pointer lands, as a plugin-global anchor + offset, without changing today's placement for anyone who never touches the setting.

**Architecture:** A new dependency-free module in `@iracedeck/deck-core` owns the pure anchor+offset → client-area-fraction math. Four validated fields on `GlobalSettingsSchema` persist the choice. The existing feature-policy module `@iracedeck/iracing-actions/src/shared/mouse-to-sim.ts` — already the single composition point both the keypad mode and the dial gesture call — reads those settings, resolves them through the pure module, and passes explicit fractions to the untouched `movePointerToSim(x, y)`. The UI is one new settings-window card built from a new `global-common-mouse-pointer.ejs` group partial. No native change, no plugin-startup change, no per-surface duplication.

**Tech Stack:** TypeScript, Zod 4, Vitest, EJS partials + sdpi/ird web components, pnpm/turbo monorepo.

**Spec:** https://github.com/niklam/iracedeck/issues/1029 (the issue body is the spec: it states the shape, the defaults, and the affected-artifact list).

## Global Constraints

- **Defaults must reproduce today's placement exactly.** `resolveSimPointerTarget` over the shipped defaults must equal `{ xFraction: DEFAULT_POINTER_X_FRACTION (0.5), yFraction: DEFAULT_POINTER_Y_FRACTION (0.125) }`. No migration, no behaviour change on upgrade. Asserted by a test, not by inspection.
- **Every new `GlobalSettingsSchema` field ends in `.catch(<default>)`** (`.claude/rules/global-settings.md`) — one throwing field aborts the whole settings parse and makes every key binding look unset (#896).
- **`ird-range-input` stores `""` when unset**, so every numeric field needs the `z.preprocess((val) => (val === "" ? undefined : val), …)` guard `simHubPort` uses — without it `z.coerce.number()` reads `""` as `0` and the default never applies.
- **Plugin-global settings live only in the settings window** (#1003). No global control may be added to an action Property Inspector.
- **No raw `<button>`/`<select>`/`<input>` in a PI or partial** — `sdpi-*` / `ird-*` components only (`.claude/rules/stream-deck-actions.md`).
- **Spelling:** US in UI labels and docs prose (`Center`, `centered`) — the dominant form on the site; no `Centre`/`Center` precedent exists in any partial.
- **Setting keys are flat camelCase**: `mouseToSimAnchorX`, `mouseToSimAnchorY`, `mouseToSimOffsetX`, `mouseToSimOffsetY`.
- **Run `pnpm build --force` after the `GlobalSettingsSchema` change** — turbo caches deck-core and can otherwise pass falsely.
- Exact dependency versions; **no new dependency in any package** — `@iracedeck/pi-components` is deliberately dependency-free.

---

### Task 1: Pure pointer-target resolver in deck-core

**Files:**

- Create: `packages/deck-core/src/sim-pointer-target.ts`
- Create: `packages/deck-core/src/sim-pointer-target.test.ts`
- Modify: `packages/deck-core/src/index.ts` (export beside the existing `./mouse-pointer-service.js` block)

**Interfaces:**

- Consumes: `DEFAULT_POINTER_X_FRACTION` / `DEFAULT_POINTER_Y_FRACTION` from `./mouse-pointer-service.js` (test only, for the equality invariant).
- Produces: `POINTER_ANCHORS_X`, `POINTER_ANCHORS_Y`, `PointerAnchorX`, `PointerAnchorY`, `POINTER_ANCHOR_X_FRACTIONS`, `POINTER_ANCHOR_Y_FRACTIONS`, `DEFAULT_POINTER_ANCHOR_X`, `DEFAULT_POINTER_ANCHOR_Y`, `DEFAULT_POINTER_OFFSET_X`, `DEFAULT_POINTER_OFFSET_Y`, `POINTER_OFFSET_LIMIT`, `SimPointerTargetConfig`, `SimPointerTarget`, `resolveSimPointerTarget(config): SimPointerTarget`.

- [ ] **Step 1: Write the failing test** — `packages/deck-core/src/sim-pointer-target.test.ts`

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_POINTER_X_FRACTION, DEFAULT_POINTER_Y_FRACTION } from "./mouse-pointer-service.js";
import {
  DEFAULT_POINTER_ANCHOR_X,
  DEFAULT_POINTER_ANCHOR_Y,
  DEFAULT_POINTER_OFFSET_X,
  DEFAULT_POINTER_OFFSET_Y,
  POINTER_OFFSET_LIMIT,
  resolveSimPointerTarget,
  type SimPointerTargetConfig,
} from "./sim-pointer-target.js";

const config = (overrides: Partial<SimPointerTargetConfig> = {}): SimPointerTargetConfig => ({
  anchorX: DEFAULT_POINTER_ANCHOR_X,
  anchorY: DEFAULT_POINTER_ANCHOR_Y,
  offsetX: DEFAULT_POINTER_OFFSET_X,
  offsetY: DEFAULT_POINTER_OFFSET_Y,
  ...overrides,
});

describe("resolveSimPointerTarget", () => {
  it("resolves the shipped defaults to the pre-#1029 placement", () => {
    expect(resolveSimPointerTarget(config())).toEqual({
      xFraction: DEFAULT_POINTER_X_FRACTION,
      yFraction: DEFAULT_POINTER_Y_FRACTION,
    });
  });

  it.each([
    ["left", 0],
    ["center", 0.5],
    ["right", 1],
  ] as const)("maps the %s anchor to %s with no offset", (anchorX, xFraction) => {
    expect(resolveSimPointerTarget(config({ anchorX, offsetX: 0 })).xFraction).toBe(xFraction);
  });

  it.each([
    ["top", 0],
    ["middle", 0.5],
    ["bottom", 1],
  ] as const)("maps the %s anchor to %s with no offset", (anchorY, yFraction) => {
    expect(resolveSimPointerTarget(config({ anchorY, offsetY: 0 })).yFraction).toBe(yFraction);
  });

  it("shifts by the offset as a percentage of the client area", () => {
    const target = resolveSimPointerTarget(config({ anchorX: "center", offsetX: 25, anchorY: "middle", offsetY: -10 }));

    expect(target).toEqual({ xFraction: 0.75, yFraction: 0.4 });
  });

  it("clamps a target pushed past either edge back into the client area", () => {
    expect(resolveSimPointerTarget(config({ anchorX: "right", offsetX: 50, anchorY: "top", offsetY: -50 }))).toEqual({
      xFraction: 1,
      yFraction: 0,
    });
  });

  it("falls back to the default anchor when a persisted value is not a known anchor", () => {
    const broken = config({ anchorX: "sideways" as never, anchorY: "diagonal" as never, offsetX: 0, offsetY: 0 });

    expect(resolveSimPointerTarget(broken)).toEqual({ xFraction: 0.5, yFraction: 0 });
  });

  it("treats a non-finite offset as no offset", () => {
    const broken = config({
      anchorX: "center",
      offsetX: Number.NaN,
      anchorY: "middle",
      offsetY: Number.POSITIVE_INFINITY,
    });

    expect(resolveSimPointerTarget(broken)).toEqual({ xFraction: 0.5, yFraction: 0.5 });
  });

  it("limits an offset to the span between two neighbouring anchors", () => {
    expect(POINTER_OFFSET_LIMIT).toBe(50);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test packages/deck-core/src/sim-pointer-target.test.ts`
Expected: FAIL — cannot resolve `./sim-pointer-target.js`.

- [ ] **Step 3: Write the implementation** — `packages/deck-core/src/sim-pointer-target.ts`

```ts
/**
 * Sim Pointer Target
 *
 * Where the Mouse to Sim pointer lands (issue #1029), as an anchor plus an
 * offset rather than the two fixed fractions #926 shipped.
 *
 * Pure and dependency-free by design: this module knows nothing about settings
 * storage, the native addon, or the feature that uses it. `mouse-pointer-service`
 * stays the injected OS primitive, the persisted choice is four
 * `GlobalSettingsSchema` fields, and composing the three is feature policy in
 * `@iracedeck/iracing-actions`' `shared/mouse-to-sim.ts` — the same split that
 * already keeps focus and pointer movement independent of each other.
 *
 * Total on purpose: the input crosses a persistence boundary (a hand-edited
 * settings file, or one written by a future schema), so an unknown anchor or a
 * non-finite offset resolves to the default rather than producing a NaN the
 * native call would turn into an arbitrary cursor position.
 */

/** Horizontal anchors, in the order the settings-window select lists them. */
export const POINTER_ANCHORS_X = ["left", "center", "right"] as const;

export type PointerAnchorX = (typeof POINTER_ANCHORS_X)[number];

/** Vertical anchors, in the order the settings-window select lists them. */
export const POINTER_ANCHORS_Y = ["top", "middle", "bottom"] as const;

export type PointerAnchorY = (typeof POINTER_ANCHORS_Y)[number];

/** Each horizontal anchor as a fraction of the client area's width. */
export const POINTER_ANCHOR_X_FRACTIONS: Record<PointerAnchorX, number> = {
  left: 0,
  center: 0.5,
  right: 1,
};

/** Each vertical anchor as a fraction of the client area's height. */
export const POINTER_ANCHOR_Y_FRACTIONS: Record<PointerAnchorY, number> = {
  top: 0,
  middle: 0.5,
  bottom: 1,
};

/** Horizontally centered — half the client area's width. */
export const DEFAULT_POINTER_ANCHOR_X: PointerAnchorX = "center";

/** Measured down from the top edge, which is what the default offset is relative to. */
export const DEFAULT_POINTER_ANCHOR_Y: PointerAnchorY = "top";

/** No horizontal shift: the default target sits on the horizontal centre line. */
export const DEFAULT_POINTER_OFFSET_X = 0;

/**
 * An eighth of the client area's height below the top anchor — iRacing's own
 * top-of-screen UI band, which is what #926 shipped and where the pointer must
 * keep landing for anyone who never opens the setting.
 */
export const DEFAULT_POINTER_OFFSET_Y = 12.5;

/**
 * Largest offset either axis accepts, in percent of the client area.
 *
 * 50 is exactly the span between two neighbouring anchors, so every point in the
 * window is reachable — and reachable from the nearest anchor, which is the one
 * a user would pick anyway. A wider range would only add ways to express a target
 * the clamp then pulls back to an edge.
 */
export const POINTER_OFFSET_LIMIT = 50;

/** A pointer target as the user configured it. */
export interface SimPointerTargetConfig {
  /** Horizontal anchor. */
  anchorX: PointerAnchorX;
  /** Vertical anchor. */
  anchorY: PointerAnchorY;
  /** Shift from the horizontal anchor, in percent of the client area's width; positive moves right. */
  offsetX: number;
  /** Shift from the vertical anchor, in percent of the client area's height; positive moves down. */
  offsetY: number;
}

/** A pointer target as `movePointerToSim` takes it. */
export interface SimPointerTarget {
  /** 0 = left edge, 1 = right edge. */
  xFraction: number;
  /** 0 = top edge, 1 = bottom edge. */
  yFraction: number;
}

/** Keep a resolved target inside the client area. The native call clamps too, but a NaN must never reach it. */
function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;

  return Math.min(1, Math.max(0, value));
}

/** One axis: the anchor's fraction plus the offset, which is a percentage of that axis' extent. */
function resolveAxis(anchorFraction: number, offsetPercent: number): number {
  const offset = Number.isFinite(offsetPercent) ? offsetPercent : 0;

  return clampFraction(anchorFraction + offset / 100);
}

/**
 * Resolve a configured anchor + offset into the client-area fractions the pointer
 * mover takes.
 *
 * @param config - the user's configured target
 * @returns the target as fractions of the iRacing window's client area
 */
export function resolveSimPointerTarget(config: SimPointerTargetConfig): SimPointerTarget {
  const anchorX = POINTER_ANCHOR_X_FRACTIONS[config.anchorX] ?? POINTER_ANCHOR_X_FRACTIONS[DEFAULT_POINTER_ANCHOR_X];
  const anchorY = POINTER_ANCHOR_Y_FRACTIONS[config.anchorY] ?? POINTER_ANCHOR_Y_FRACTIONS[DEFAULT_POINTER_ANCHOR_Y];

  return {
    xFraction: resolveAxis(anchorX, config.offsetX),
    yFraction: resolveAxis(anchorY, config.offsetY),
  };
}
```

Export it from `packages/deck-core/src/index.ts` right after the `./mouse-pointer-service.js` block, matching that file's `export { … } from "…"` style and keeping type-only names under `export type`.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm test packages/deck-core/src/sim-pointer-target.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/sim-pointer-target.ts packages/deck-core/src/sim-pointer-target.test.ts packages/deck-core/src/index.ts
git commit -m "feat(deck-core): resolve a Mouse to Sim pointer target from an anchor and offset (#1029)"
```

---

### Task 2: Persist the target in global settings

**Files:**

- Modify: `packages/deck-core/src/global-settings.ts` (import the Task 1 constants; add four fields after `focusIRacingWindow`)
- Modify: `packages/deck-core/src/global-settings.test.ts` (add a describe block)

**Interfaces:**

- Consumes: every constant Task 1 produces.
- Produces: `GlobalSettings["mouseToSimAnchorX" | "mouseToSimAnchorY" | "mouseToSimOffsetX" | "mouseToSimOffsetY"]`, typed `PointerAnchorX` / `PointerAnchorY` / `number` / `number`.

- [ ] **Step 1: Write the failing test** — append to `packages/deck-core/src/global-settings.test.ts`, matching the file's existing import and parse style

```ts
describe("Mouse to Sim pointer target (#1029)", () => {
  it("defaults to the placement #926 shipped", () => {
    const parsed = GlobalSettingsSchema.parse({});

    expect(parsed.mouseToSimAnchorX).toBe("center");
    expect(parsed.mouseToSimAnchorY).toBe("top");
    expect(parsed.mouseToSimOffsetX).toBe(0);
    expect(parsed.mouseToSimOffsetY).toBe(12.5);
  });

  it("keeps a configured target", () => {
    const parsed = GlobalSettingsSchema.parse({
      mouseToSimAnchorX: "right",
      mouseToSimAnchorY: "bottom",
      mouseToSimOffsetX: -5,
      mouseToSimOffsetY: -12.5,
    });

    expect(parsed.mouseToSimAnchorX).toBe("right");
    expect(parsed.mouseToSimAnchorY).toBe("bottom");
    expect(parsed.mouseToSimOffsetX).toBe(-5);
    expect(parsed.mouseToSimOffsetY).toBe(-12.5);
  });

  it("coerces the numeric strings the range input stores", () => {
    const parsed = GlobalSettingsSchema.parse({ mouseToSimOffsetX: "-25", mouseToSimOffsetY: "7.5" });

    expect(parsed.mouseToSimOffsetX).toBe(-25);
    expect(parsed.mouseToSimOffsetY).toBe(7.5);
  });

  it("treats the empty string an untouched range input stores as absent", () => {
    const parsed = GlobalSettingsSchema.parse({ mouseToSimOffsetX: "", mouseToSimOffsetY: "" });

    expect(parsed.mouseToSimOffsetX).toBe(0);
    expect(parsed.mouseToSimOffsetY).toBe(12.5);
  });

  it.each([
    ["an unknown anchor", { mouseToSimAnchorX: "sideways", mouseToSimAnchorY: "diagonal" }],
    ["an out-of-range offset", { mouseToSimOffsetX: 5000, mouseToSimOffsetY: -5000 }],
    ["a non-numeric offset", { mouseToSimOffsetX: "left-ish", mouseToSimOffsetY: {} }],
  ])("falls back to the defaults for %s without failing the parse", (_case, patch) => {
    const parsed = GlobalSettingsSchema.parse({ focusIRacingWindow: false, ...patch });

    expect(parsed.mouseToSimAnchorX).toBe("center");
    expect(parsed.mouseToSimAnchorY).toBe("top");
    expect(parsed.mouseToSimOffsetX).toBe(0);
    expect(parsed.mouseToSimOffsetY).toBe(12.5);
    // The parse as a whole must survive — one throwing field stalls every setting (#896).
    expect(parsed.focusIRacingWindow).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test packages/deck-core/src/global-settings.test.ts`
Expected: FAIL — `mouseToSimAnchorX` is `undefined` (`.passthrough()` leaves an undeclared key alone, so nothing is defaulted).

- [ ] **Step 3: Write the implementation**

Import in `packages/deck-core/src/global-settings.ts`:

```ts
import {
  DEFAULT_POINTER_ANCHOR_X,
  DEFAULT_POINTER_ANCHOR_Y,
  DEFAULT_POINTER_OFFSET_X,
  DEFAULT_POINTER_OFFSET_Y,
  POINTER_ANCHORS_X,
  POINTER_ANCHORS_Y,
  POINTER_OFFSET_LIMIT,
} from "./sim-pointer-target.js";
```

Add the fields directly after `focusIRacingWindow`:

```ts
    /**
     * Where the Mouse to Sim key parks the pointer inside the iRacing window
     * (issue #1029) — an anchor per axis plus an offset in percent of the client
     * area. The defaults resolve to exactly the 50% / 12.5% #926 shipped, so an
     * install that never opens the setting keeps its placement; the resolution
     * itself lives in `sim-pointer-target.ts`.
     *
     * `.catch(...)` on all four (issue #896): a hand-edited settings file must
     * fall back to the default rather than abort the whole parse.
     */
    mouseToSimAnchorX: z.enum(POINTER_ANCHORS_X).default(DEFAULT_POINTER_ANCHOR_X).catch(DEFAULT_POINTER_ANCHOR_X),
    mouseToSimAnchorY: z.enum(POINTER_ANCHORS_Y).default(DEFAULT_POINTER_ANCHOR_Y).catch(DEFAULT_POINTER_ANCHOR_Y),
    // `preprocess` for the same reason as `simHubPort`: `ird-range-input` stores
    // "" until the user touches it, and `z.coerce.number()` reads that as 0
    // rather than "absent" — silently discarding the default.
    mouseToSimOffsetX: z.preprocess(
      (val) => (val === "" ? undefined : val),
      z.coerce
        .number()
        .min(-POINTER_OFFSET_LIMIT)
        .max(POINTER_OFFSET_LIMIT)
        .default(DEFAULT_POINTER_OFFSET_X)
        .catch(DEFAULT_POINTER_OFFSET_X),
    ),
    mouseToSimOffsetY: z.preprocess(
      (val) => (val === "" ? undefined : val),
      z.coerce
        .number()
        .min(-POINTER_OFFSET_LIMIT)
        .max(POINTER_OFFSET_LIMIT)
        .default(DEFAULT_POINTER_OFFSET_Y)
        .catch(DEFAULT_POINTER_OFFSET_Y),
    ),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test packages/deck-core/src/global-settings.test.ts packages/deck-core/src/sim-pointer-target.test.ts`, then `pnpm build --force`.
Expected: PASS, including `packages/deck-core/src/simhub-service.test.ts`, which pins settings literals.

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/global-settings.ts packages/deck-core/src/global-settings.test.ts
git commit -m "feat(settings): persist the Mouse to Sim pointer target (#1029)"
```

---

### Task 3: Use the configured target

**Files:**

- Modify: `packages/iracing-actions/src/shared/mouse-to-sim.ts`
- Modify: `packages/iracing-actions/src/shared/mouse-to-sim.test.ts`

**Interfaces:**

- Consumes: `getGlobalSettings()`, `resolveSimPointerTarget`, `movePointerToSim(x, y)` from `@iracedeck/deck-core`.
- Produces: no signature change — `bringPointerToSim(logger)` stays the one entry point both surfaces call.

- [ ] **Step 1: Write the failing test**

Add `getGlobalSettings` to the existing `@iracedeck/deck-core` mock in `mouse-to-sim.test.ts` and keep the REAL resolver, so the test proves the math a user actually gets:

```ts
const getGlobalSettings = vi.fn();

vi.mock("@iracedeck/deck-core", async () => {
  const actual = await vi.importActual<typeof import("@iracedeck/deck-core")>("@iracedeck/deck-core");

  return { ...actual, focusIRacingNow, movePointerToSim, getGlobalSettings };
});
```

Never re-implement the resolution inside the mock — that would assert nothing. Then:

```ts
it("moves the pointer to the configured target", () => {
  focusIRacingNow.mockReturnValue(FocusResult.Focused);
  movePointerToSim.mockReturnValue(PointerMoveResult.Moved);
  getGlobalSettings.mockReturnValue({
    mouseToSimAnchorX: "right",
    mouseToSimAnchorY: "bottom",
    mouseToSimOffsetX: 0,
    mouseToSimOffsetY: 0,
  });

  bringPointerToSim(logger);

  expect(movePointerToSim).toHaveBeenCalledWith(1, 1);
});

it("uses the pre-#1029 placement when nothing is configured", () => {
  focusIRacingNow.mockReturnValue(FocusResult.Focused);
  movePointerToSim.mockReturnValue(PointerMoveResult.Moved);
  getGlobalSettings.mockReturnValue({
    mouseToSimAnchorX: "center",
    mouseToSimAnchorY: "top",
    mouseToSimOffsetX: 0,
    mouseToSimOffsetY: 12.5,
  });

  bringPointerToSim(logger);

  expect(movePointerToSim).toHaveBeenCalledWith(0.5, 0.125);
});
```

Update the existing assertion that pins the no-argument call (`expect(movePointerToSim).toHaveBeenCalledWith()`) to the resolved fractions, and give every existing test a default `getGlobalSettings` return in `beforeEach` so they keep exercising their own paths.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test packages/iracing-actions/src/shared/mouse-to-sim.test.ts`
Expected: FAIL — called with no arguments, expected `(1, 1)`.

- [ ] **Step 3: Write the implementation**

```ts
import {
  focusIRacingNow,
  FocusResult,
  getGlobalSettings,
  movePointerToSim,
  PointerMoveResult,
  resolveSimPointerTarget,
} from "@iracedeck/deck-core";
```

Replace the bare call:

```ts
    // Where the pointer goes is the user's choice (#1029). Read live rather than
    // caching: the settings window can change it between two presses. No
    // `isSettingsStoreReady()` gate — the schema defaults ARE the pre-#1029
    // placement, so a press before the store loads lands exactly where it always
    // did, and gating would only make it do nothing instead.
    const settings = getGlobalSettings();
    const target = resolveSimPointerTarget({
      anchorX: settings.mouseToSimAnchorX,
      anchorY: settings.mouseToSimAnchorY,
      offsetX: settings.mouseToSimOffsetX,
      offsetY: settings.mouseToSimOffsetY,
    });

    if (movePointerToSim(target.xFraction, target.yFraction) === PointerMoveResult.Moved) {
      logger.info("Mouse pointer brought to the iRacing window");
    }
```

Extend the module header comment: the composition it owns is now focus → resolve the configured target → move.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test packages/iracing-actions/src/shared/mouse-to-sim.test.ts packages/iracing-actions/src/actions/view-adjustment/`
Expected: PASS — the two view-adjustment suites mock this module and should need no change, which is the point of routing both surfaces through one helper.

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/shared/mouse-to-sim.ts packages/iracing-actions/src/shared/mouse-to-sim.test.ts
git commit -m "feat(actions): send Mouse to Sim to the configured pointer target (#1029)"
```

---

### Task 4: The settings-window control

**Files:**

- Create: `packages/pi-components/partials/global-common-mouse-pointer.ejs`
- Modify: `packages/iracing-actions/src/actions/settings-window/settings-window.ejs` (add the card to the General pane's `sw-grid`)
- Create: `packages/deck-core/src/sim-pointer-target.partial.test.ts` — the UI-matches-schema guard. It lives in deck-core because `@iracedeck/pi-components` is deliberately dependency-free and must not gain a dep on deck-core for a test; reading a sibling package's file by relative path is the established cross-package test pattern (`pi-components/src/build/action-templates.ts` reads `iracing-actions` the same way).

- [ ] **Step 1: Write the failing test** — `packages/deck-core/src/sim-pointer-target.partial.test.ts`

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_POINTER_ANCHOR_X,
  DEFAULT_POINTER_ANCHOR_Y,
  DEFAULT_POINTER_OFFSET_X,
  DEFAULT_POINTER_OFFSET_Y,
  POINTER_ANCHORS_X,
  POINTER_ANCHORS_Y,
  POINTER_OFFSET_LIMIT,
} from "./sim-pointer-target.js";

/**
 * The settings window's controls carry their own `default="…"` attributes, so a
 * schema default changed on one side and not the other would show the user one
 * value and apply another. `@iracedeck/pi-components` is dependency-free on
 * purpose, so the guard lives on this side of the pair.
 */
const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../../..");
const partial = readFileSync(
  path.join(repoRoot, "packages/pi-components/partials/global-common-mouse-pointer.ejs"),
  "utf-8",
);
const settingsWindow = readFileSync(
  path.join(repoRoot, "packages/iracing-actions/src/actions/settings-window/settings-window.ejs"),
  "utf-8",
);

describe("global-common-mouse-pointer.ejs (#1029)", () => {
  it.each(["mouseToSimAnchorX", "mouseToSimAnchorY", "mouseToSimOffsetX", "mouseToSimOffsetY"])(
    "binds %s",
    (key) => {
      expect(partial).toContain(`setting="${key}"`);
    },
  );

  it.each([...POINTER_ANCHORS_X, ...POINTER_ANCHORS_Y])("offers the %s anchor", (anchor) => {
    expect(partial).toContain(`value="${anchor}"`);
  });

  it("defaults every control to its schema default", () => {
    expect(partial).toContain(`setting="mouseToSimAnchorX" global default="${DEFAULT_POINTER_ANCHOR_X}"`);
    expect(partial).toContain(`setting="mouseToSimAnchorY" global default="${DEFAULT_POINTER_ANCHOR_Y}"`);
    expect(partial).toContain(`setting="mouseToSimOffsetX" min="-${POINTER_OFFSET_LIMIT}" max="${POINTER_OFFSET_LIMIT}"`);
    expect(partial).toContain(`setting="mouseToSimOffsetY" min="-${POINTER_OFFSET_LIMIT}" max="${POINTER_OFFSET_LIMIT}"`);
    expect(partial).toContain(`default="${DEFAULT_POINTER_OFFSET_X}" global`);
    expect(partial).toContain(`default="${DEFAULT_POINTER_OFFSET_Y}" global`);
  });

  it("saves every control globally", () => {
    expect(partial.match(/ global/g)).toHaveLength(4);
  });

  it("uses only sdpi/ird components, never raw form controls", () => {
    expect(partial).not.toMatch(/<(input|select|button|textarea)[\s>]/);
  });

  it("emits items only, so the includer owns the heading", () => {
    expect(partial).not.toContain("include('accordion'");
  });

  it("is rendered by the settings window", () => {
    expect(settingsWindow).toContain("include('global-common-mouse-pointer')");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test packages/deck-core/src/sim-pointer-target.partial.test.ts`
Expected: FAIL — `ENOENT` on `global-common-mouse-pointer.ejs`.

- [ ] **Step 3: Write the implementation** — `packages/pi-components/partials/global-common-mouse-pointer.ejs`

Match the sibling group partials' indentation; emit items only.

```ejs
<%#
  Common settings — the Mouse to Sim pointer target (issue #1029). One group of
  the settings window's General tab, and a sibling card to Window Focus &
  Connection rather than part of it: deck-core keeps the focus service and the
  pointer service independent, and the UI says the same thing. Emits items only —
  the includer supplies the heading.
%>
<sdpi-item label="Horizontal">
  <sdpi-select setting="mouseToSimAnchorX" global default="center">
    <option value="left">Left</option>
    <option value="center">Center</option>
    <option value="right">Right</option>
  </sdpi-select>
</sdpi-item>
<sdpi-item label="Horizontal offset %">
  <ird-range-input setting="mouseToSimOffsetX" min="-50" max="50" step="0.5" default="0" global showlabels></ird-range-input>
</sdpi-item>
<sdpi-item label="Vertical">
  <sdpi-select setting="mouseToSimAnchorY" global default="top">
    <option value="top">Top</option>
    <option value="middle">Middle</option>
    <option value="bottom">Bottom</option>
  </sdpi-select>
</sdpi-item>
<sdpi-item label="Vertical offset %">
  <ird-range-input setting="mouseToSimOffsetY" min="-50" max="50" step="0.5" default="12.5" global showlabels></ird-range-input>
</sdpi-item>
<div class="ird-supporting-text">
  Where the <strong>Mouse to Sim</strong> key parks your pointer inside the iRacing
  window. Pick a corner, an edge or the centre with the two anchors, then nudge it
  from there with the offsets — a percentage of the window, so it holds at any
  resolution. Positive moves right and down. The default, Top plus 12.5%, lands on
  iRacing's own on-screen UI band.
</div>
```

In `settings-window.ejs`, add to the General pane's `sw-grid`, after the Window Focus card:

```ejs
					<%- include('accordion', { title: 'Mouse to Sim', content: include('global-common-mouse-pointer'), settingsWindow: true }) %>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test packages/deck-core/src/sim-pointer-target.partial.test.ts && pnpm build`, then confirm the control reached every built page and no PI:

```bash
grep -c "mouseToSimAnchorX" packages/iracing-plugin-*/com.iracedeck.sd.*.sdPlugin/ui/settings-window.html
grep -rl "mouseToSimAnchorX" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/ | grep -v settings-window.html
```

- [ ] **Step 5: Commit**

```bash
git add packages/pi-components/partials/global-common-mouse-pointer.ejs packages/iracing-actions/src/actions/settings-window/settings-window.ejs packages/deck-core/src/sim-pointer-target.partial.test.ts
git commit -m "feat(settings-window): add the Mouse to Sim pointer target controls (#1029)"
```

---

### Task 5: Correct everything that documents the old fixed position

The fixed target is stated as fact in a Property Inspector, a package CLAUDE.md, the action reference and a skill. All four are now wrong.

**Files:**

- Modify: `packages/iracing-actions/src/actions/view-adjustment/view-adjustment.ejs` (`#mouse-to-sim-help`)
- Modify: `packages/deck-core/CLAUDE.md` (the `mouse-pointer-service.ts` bullet + a new one)
- Modify: `docs/reference/actions.json` (the View Adjustment description's "50% x / 12.5% y")
- Modify: `.claude/skills/iracedeck-actions/SKILL.md` (the same phrase, in the View Adjustment row)

- [ ] **Step 1: Update the PI supporting text**

It must stop promising a fixed spot and point at where the target is set — without adding a global control to a PI (#1003):

```html
			<div class="ird-supporting-text hidden" id="mouse-to-sim-help">
				Focuses the iRacing window and moves the mouse pointer into it. Useful in VR,
				where you cannot see where the pointer is. It moves the pointer only — it never
				clicks. Uses no iRacing command, so it needs no key binding. Choose where the
				pointer lands under Mouse to Sim in iRaceDeck Settings.
			</div>
```

- [ ] **Step 2: Update `packages/deck-core/CLAUDE.md`**

Add a bullet after the `mouse-pointer-service.ts` one so the module list stays a true map of the package:

```markdown
- `sim-pointer-target.ts` — Pure Mouse to Sim target resolution (#1029): `POINTER_ANCHORS_X`/`_Y`, `POINTER_ANCHOR_X_FRACTIONS`/`_Y_FRACTIONS`, the `DEFAULT_POINTER_ANCHOR_*` / `DEFAULT_POINTER_OFFSET_*` defaults, `POINTER_OFFSET_LIMIT`, `SimPointerTargetConfig`, `SimPointerTarget`, `resolveSimPointerTarget`. Zero imports: it knows nothing about settings storage or the addon, so the pointer service stays the injected OS primitive and the four `mouseToSim*` global settings stay plain persistence. Its defaults resolve to exactly `DEFAULT_POINTER_X_FRACTION` / `DEFAULT_POINTER_Y_FRACTION`, pinned by `sim-pointer-target.test.ts` — that equality is what keeps #1029 from moving anyone's pointer.
```

- [ ] **Step 3: Update the reference and the skill**

In both, replace "moves the OS mouse pointer to 50% x / 12.5% y of its client area" with the configurable form — e.g. "moves the OS mouse pointer to the target the `mouseToSimAnchorX`/`mouseToSimAnchorY` + `mouseToSimOffsetX`/`mouseToSimOffsetY` global settings configure (#1029), resolved by deck-core's `resolveSimPointerTarget`; the defaults are the 50% x / 12.5% y #926 shipped". Keep each file's voice and line structure — both are single-line entries, so edit in place rather than reflowing.

- [ ] **Step 4: Verify**

Run: `pnpm build && pnpm test`, then confirm nothing still calls the placement unconfigurable:

```bash
grep -rn "12.5% y\|nothing to configure" --include=*.md --include=*.mdx --include=*.json --include=*.ejs . | grep -v node_modules | grep -v changelog
```

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-actions/src/actions/view-adjustment/view-adjustment.ejs packages/deck-core/CLAUDE.md docs/reference/actions.json .claude/skills/iracedeck-actions/SKILL.md
git commit -m "docs: the Mouse to Sim pointer target is configurable, not fixed (#1029)"
```

---

### Task 6: Website, changelog and the regenerated screenshot

**Files:**

- Modify: `packages/website/src/content/docs/docs/actions/view-camera/view-adjustment.md`
- Modify: `packages/website/src/content/docs/docs/getting-started/settings.md`
- Modify: `packages/website/src/content/docs/changelog.mdx`
- Regenerate: `packages/iracing-actions/src/actions/data/changelog.json`, `packages/website/public/changelog.json`, `packages/website/src/assets/settings-window/general.png`

- [ ] **Step 1: Rewrite the action page's Mouse to Sim section**

It currently describes the fixed spot, and its Details **Method** bullet says "nothing to bind and nothing to configure". Replace the description with one that explains the anchor + offset model, states the default, and links to `/docs/getting-started/settings/`; trim the Method bullet to "…no iRacing command, so there is nothing to bind"; and give the section a **Settings** line naming the settings-window card. Keep the page's per-mode structure and its `#### Details` / `#### Settings` subheadings (`.claude/rules/website-action-docs.md`).

- [ ] **Step 2: Document the card on the settings page**

Add a paragraph to `### General`, after the Dual-Press one, in that page's bold-lead voice: name the card, explain the two anchors, the two offsets, that positive means right and down, and what the default does. The image and its alt text are unchanged.

- [ ] **Step 3: Add the changelog entry**

The root `package.json` is `3.1.0-dev.0`, so the in-development section is `## 3.1.0`. It does not exist yet (the top section is `## 3.0.1`), so create it at the very top of the list with `_Unreleased_`, per `.claude/rules/changelog.md`. Mouse to Sim itself shipped in 3.0.0, so this is an **Improvements** line, not a Feature:

```markdown
## 3.1.0

_Unreleased_

**Improvements**

- Mouse to Sim now lets you choose where your pointer lands in the sim window. Pick a horizontal and a vertical anchor — a corner, an edge or the centre — and nudge it from there with an offset, under Mouse to Sim on the Settings window's General tab. Leave it alone and the pointer keeps arriving exactly where it always has.
```

- [ ] **Step 4: Regenerate the derived artifacts**

```bash
pnpm generate:changelog-data            # -> iracing-actions/src/actions/data/changelog.json (a freshness test enforces this)
pnpm build                              # the capture harness reads the built Stream Deck ui/
pnpm capture:settings                   # -> packages/website/src/assets/settings-window/*.png
pnpm --filter @iracedeck/website build  # regenerates public/changelog.json and proves the MDX compiles
```

- [ ] **Step 5: Verify and commit**

Run: `pnpm test` (the changelog parser and freshness tests both read the MDX), and confirm `git status` shows the regenerated `general.png` and both `changelog.json` files.

```bash
git add packages/website packages/iracing-actions/src/actions/data/changelog.json
git commit -m "docs(website): document the configurable Mouse to Sim pointer target (#1029)"
```

---

## Final verification

- [ ] `pnpm install` — lockfile unchanged, since no dependency was added
- [ ] `pnpm lint:fix && pnpm format:fix`
- [ ] `pnpm build --force` — a `GlobalSettingsSchema` change can otherwise hit turbo's cache
- [ ] `pnpm test` — every suite, no skips
- [ ] `mouseToSimAnchorX` appears exactly once in each plugin's built `ui/settings-window.html`, and in no action PI (#1003)
- [ ] Manual test on hardware: with the defaults, a Mouse to Sim press lands the pointer where it always did; set Right + Bottom and it lands in the bottom-right corner; the Stream Deck+ dial press gesture follows the same setting
