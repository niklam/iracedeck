# Flags Overlay Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-action Flags Overlay setting that flashes Stream Deck buttons with race flag colors when flags are active.

**Architecture:** Flag detection utilities extracted to `@iracedeck/iracing-sdk` for cross-plugin reuse. `CommonSettings` Zod schema extends all action settings with `flagsOverlay`. `BaseAction` subscribes to telemetry and manages flash cycle, image output gating, and restore logic.

**Tech Stack:** TypeScript, Zod, Vitest, Stream Deck SDK, EJS templates

**Spec:** `docs/superpowers/specs/2026-03-12-flags-overlay-design.md`

---

## Chunk 0: Setup

### Task 0: Create feature branch

- [ ] **Step 1: Create and checkout feature branch**

```bash
git checkout -b feature/106-flags-overlay
```

---

## Chunk 1: Shared Flag Utility

### Task 1: Extract flag utilities to `@iracedeck/iracing-sdk`

**Files:**
- Create: `packages/iracing-sdk/src/flag-utils.ts`
- Create: `packages/iracing-sdk/src/flag-utils.test.ts`
- Modify: `packages/iracing-sdk/src/index.ts`

- [ ] **Step 1: Write failing tests for flag utilities**

Create `packages/iracing-sdk/src/flag-utils.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { Flags } from "@iracedeck/iracing-native";

import { FLAG_DEFINITIONS, resolveActiveFlag, resolveAllActiveFlags } from "./flag-utils.js";

describe("flag-utils", () => {
  describe("FLAG_DEFINITIONS", () => {
    it("should have entries for all major flag types", () => {
      expect(FLAG_DEFINITIONS.length).toBeGreaterThanOrEqual(8);
    });

    it("should have red as highest priority", () => {
      const result = FLAG_DEFINITIONS[0];
      expect(result.info.label).toBe("RED");
    });
  });

  describe("resolveActiveFlag", () => {
    it("should return null for undefined", () => {
      expect(resolveActiveFlag(undefined)).toBeNull();
    });

    it("should return null for no flags", () => {
      expect(resolveActiveFlag(0)).toBeNull();
    });

    it("should return yellow for yellow flag", () => {
      const result = resolveActiveFlag(Flags.Yellow);
      expect(result).not.toBeNull();
      expect(result!.label).toBe("YELLOW");
      expect(result!.color).toBe("#f1c40f");
    });

    it("should return blue for blue flag", () => {
      const result = resolveActiveFlag(Flags.Blue);
      expect(result).not.toBeNull();
      expect(result!.label).toBe("BLUE");
    });

    it("should return red over yellow when both active (priority)", () => {
      const result = resolveActiveFlag(Flags.Red | Flags.Yellow);
      expect(result!.label).toBe("RED");
    });

    it("should return yellow for caution flag", () => {
      const result = resolveActiveFlag(Flags.Caution);
      expect(result!.label).toBe("YELLOW");
    });

    it("should return yellow for caution waving flag", () => {
      const result = resolveActiveFlag(Flags.CautionWaving);
      expect(result!.label).toBe("YELLOW");
    });

    it("should return black for disqualify flag", () => {
      const result = resolveActiveFlag(Flags.Disqualify);
      expect(result!.label).toBe("BLACK");
      expect(result!.pulse).toBe(true);
    });
  });

  describe("resolveAllActiveFlags", () => {
    it("should return empty array for undefined", () => {
      expect(resolveAllActiveFlags(undefined)).toEqual([]);
    });

    it("should return empty array for no flags", () => {
      expect(resolveAllActiveFlags(0)).toEqual([]);
    });

    it("should return single flag", () => {
      const result = resolveAllActiveFlags(Flags.Yellow);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("YELLOW");
    });

    it("should return multiple flags when active", () => {
      const result = resolveAllActiveFlags(Flags.Yellow | Flags.Blue);
      expect(result).toHaveLength(2);
      const labels = result.map((f) => f.label);
      expect(labels).toContain("YELLOW");
      expect(labels).toContain("BLUE");
    });

    it("should exclude green flag", () => {
      const result = resolveAllActiveFlags(Flags.Green | Flags.Blue);
      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("BLUE");
    });

    it("should return empty array for green-only", () => {
      expect(resolveAllActiveFlags(Flags.Green)).toEqual([]);
    });

    it("should maintain priority order", () => {
      const result = resolveAllActiveFlags(Flags.Blue | Flags.Yellow | Flags.Red);
      expect(result[0].label).toBe("RED");
      expect(result[1].label).toBe("YELLOW");
      expect(result[2].label).toBe("BLUE");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/iracing-sdk && npx vitest run src/flag-utils.test.ts`
Expected: FAIL — module `./flag-utils.js` not found

- [ ] **Step 3: Create flag-utils.ts**

Create `packages/iracing-sdk/src/flag-utils.ts`:

```typescript
import { Flags } from "@iracedeck/iracing-native";

import { hasFlag } from "./utils.js";

/**
 * Describes a resolved race flag with its visual properties.
 */
export interface FlagInfo {
  label: string;
  color: string;
  textColor: string;
  /** Whether this flag should pulse continuously (black, meatball) */
  pulse: boolean;
}

/**
 * Flag definitions in priority order (highest priority first).
 * When multiple flags are active, the first match wins for resolveActiveFlag.
 */
export const FLAG_DEFINITIONS: ReadonlyArray<{
  check: (flags: number) => boolean;
  info: FlagInfo;
}> = [
  { check: (f) => hasFlag(f, Flags.Red), info: { label: "RED", color: "#e74c3c", textColor: "#ffffff", pulse: false } },
  {
    check: (f) => hasFlag(f, Flags.Black) || hasFlag(f, Flags.Disqualify),
    info: { label: "BLACK", color: "#1a1a1a", textColor: "#ffffff", pulse: true },
  },
  {
    check: (f) => hasFlag(f, Flags.Repair),
    info: { label: "REPAIR", color: "#e67e22", textColor: "#ffffff", pulse: true },
  },
  {
    check: (f) => hasFlag(f, Flags.Yellow) || hasFlag(f, Flags.Caution) || hasFlag(f, Flags.CautionWaving),
    info: { label: "YELLOW", color: "#f1c40f", textColor: "#1a1a1a", pulse: false },
  },
  {
    check: (f) => hasFlag(f, Flags.Blue),
    info: { label: "BLUE", color: "#3498db", textColor: "#ffffff", pulse: false },
  },
  {
    check: (f) => hasFlag(f, Flags.White),
    info: { label: "WHITE", color: "#e8e8e8", textColor: "#1a1a1a", pulse: false },
  },
  {
    check: (f) => hasFlag(f, Flags.Checkered),
    info: { label: "FINISH", color: "#1a1a1a", textColor: "#ffffff", pulse: false },
  },
  {
    check: (f) => hasFlag(f, Flags.Green),
    info: { label: "GREEN", color: "#2ecc71", textColor: "#ffffff", pulse: false },
  },
];

/**
 * Resolves the highest-priority active flag from the session flags bitfield.
 */
export function resolveActiveFlag(sessionFlags: number | undefined): FlagInfo | null {
  if (sessionFlags === undefined) return null;

  for (const def of FLAG_DEFINITIONS) {
    if (def.check(sessionFlags)) return def.info;
  }

  return null;
}

/**
 * Resolves all active flags from the session flags bitfield, in priority order.
 * Excludes Green (normal racing state) — Green should not trigger an overlay.
 */
export function resolveAllActiveFlags(sessionFlags: number | undefined): FlagInfo[] {
  if (sessionFlags === undefined) return [];

  const result: FlagInfo[] = [];

  for (const def of FLAG_DEFINITIONS) {
    if (def.info.label === "GREEN") continue;
    if (def.check(sessionFlags)) result.push(def.info);
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/iracing-sdk && npx vitest run src/flag-utils.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Export from SDK barrel**

Add to `packages/iracing-sdk/src/index.ts`, after the template variable system exports:

```typescript
// Flag utilities
export { type FlagInfo, FLAG_DEFINITIONS, resolveActiveFlag, resolveAllActiveFlags } from "./flag-utils.js";
```

- [ ] **Step 6: Run full SDK test suite**

Run: `cd packages/iracing-sdk && npx vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/iracing-sdk/src/flag-utils.ts packages/iracing-sdk/src/flag-utils.test.ts packages/iracing-sdk/src/index.ts
git commit -m "feat(iracing-sdk): extract flag utilities for cross-plugin reuse"
```

### Task 2: Update session-info to import from SDK

**Files:**
- Modify: `packages/stream-deck-plugin/src/actions/session-info.ts`
- Modify: `packages/stream-deck-plugin/src/actions/session-info.test.ts`

- [ ] **Step 1: Update session-info.ts imports**

In `packages/stream-deck-plugin/src/actions/session-info.ts`:

Replace the local `FlagInfo`, `FLAG_DEFINITIONS`, and `resolveActiveFlag` definitions with imports from the SDK:

```typescript
// Add to existing @iracedeck/iracing-sdk import:
import {
  DisplayUnits,
  type FlagInfo,
  FLAG_DEFINITIONS,
  Flags,
  hasFlag,
  resolveActiveFlag,
  type SessionInfo as IRacingSessionInfo,
  type TelemetryData,
} from "@iracedeck/iracing-sdk";
```

Remove the local definitions:
- `export interface FlagInfo { ... }` (lines ~52-58)
- `export const FLAG_DEFINITIONS: ...` (lines ~66-96)
- `export function resolveActiveFlag(...)` (lines ~103-111)

Do NOT re-export from session-info — tests should import directly from the SDK.

- [ ] **Step 2: Update session-info.test.ts**

Update test imports: change `import { resolveActiveFlag, FLAG_DEFINITIONS } from "./session-info.js"` to `import { resolveActiveFlag, FLAG_DEFINITIONS } from "@iracedeck/iracing-sdk"`. Then verify:

Run: `cd packages/stream-deck-plugin && npx vitest run src/actions/session-info.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/stream-deck-plugin/src/actions/session-info.ts packages/stream-deck-plugin/src/actions/session-info.test.ts
git commit -m "refactor(stream-deck-plugin): import flag utils from SDK"
```

---

## Chunk 2: CommonSettings Schema and PI Partial

### Task 3: Create CommonSettings Zod schema

**Files:**
- Create: `packages/stream-deck-plugin/src/shared/common-settings.ts`
- Create: `packages/stream-deck-plugin/src/shared/common-settings.test.ts`
- Modify: `packages/stream-deck-plugin/src/shared/index.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/stream-deck-plugin/src/shared/common-settings.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import z from "zod";

import { CommonSettings } from "./common-settings.js";

describe("CommonSettings", () => {
  it("should default flagsOverlay to false", () => {
    const result = CommonSettings.parse({});
    expect(result.flagsOverlay).toBe(false);
  });

  it("should accept boolean true", () => {
    const result = CommonSettings.parse({ flagsOverlay: true });
    expect(result.flagsOverlay).toBe(true);
  });

  it("should accept boolean false", () => {
    const result = CommonSettings.parse({ flagsOverlay: false });
    expect(result.flagsOverlay).toBe(false);
  });

  it("should transform string 'true' to boolean true", () => {
    const result = CommonSettings.parse({ flagsOverlay: "true" });
    expect(result.flagsOverlay).toBe(true);
  });

  it("should transform string 'false' to boolean false", () => {
    const result = CommonSettings.parse({ flagsOverlay: "false" });
    expect(result.flagsOverlay).toBe(false);
  });

  it("should be extendable with action-specific settings", () => {
    const ActionSettings = CommonSettings.extend({
      direction: z.enum(["next", "previous"]).default("next"),
    });

    const result = ActionSettings.parse({});
    expect(result.flagsOverlay).toBe(false);
    expect(result.direction).toBe("next");
  });

  it("should preserve flagsOverlay when extended schema is parsed", () => {
    const ActionSettings = CommonSettings.extend({
      direction: z.enum(["next", "previous"]).default("next"),
    });

    const result = ActionSettings.parse({ flagsOverlay: true, direction: "previous" });
    expect(result.flagsOverlay).toBe(true);
    expect(result.direction).toBe("previous");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/stream-deck-plugin && npx vitest run src/shared/common-settings.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create common-settings.ts**

Create `packages/stream-deck-plugin/src/shared/common-settings.ts`:

```typescript
import z from "zod";

/**
 * Common settings shared by all actions.
 * All action settings schemas should extend this.
 *
 * @example
 * ```typescript
 * const MyActionSettings = CommonSettings.extend({
 *   direction: z.enum(["next", "previous"]).default("next"),
 * });
 * ```
 */
export const CommonSettings = z.object({
  flagsOverlay: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
});

export type CommonSettings = z.infer<typeof CommonSettings>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/stream-deck-plugin && npx vitest run src/shared/common-settings.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Export from shared barrel**

Add to `packages/stream-deck-plugin/src/shared/index.ts`, after the BaseAction export:

```typescript
// Common settings (shared by all actions)
export { CommonSettings } from "./common-settings.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/stream-deck-plugin/src/shared/common-settings.ts packages/stream-deck-plugin/src/shared/common-settings.test.ts packages/stream-deck-plugin/src/shared/index.ts
git commit -m "feat(stream-deck-plugin): add CommonSettings schema"
```

### Task 4: Create common-settings PI partial

**Files:**
- Create: `packages/stream-deck-plugin/src/pi-templates/partials/common-settings.ejs`

- [ ] **Step 1: Create the partial**

Create `packages/stream-deck-plugin/src/pi-templates/partials/common-settings.ejs`:

```ejs
<%- include('accordion', {
  title: 'Common Settings',
  content: `
    <sdpi-item label="Flags Overlay">
      <sdpi-checkbox setting="flagsOverlay" label="Flash flag colors on button"></sdpi-checkbox>
    </sdpi-item>
  `
}) %>
```

- [ ] **Step 2: Verify build succeeds**

Run: `cd packages/stream-deck-plugin && pnpm build`
Expected: Build succeeds (partial is not included yet, so this just verifies it doesn't break)

- [ ] **Step 3: Commit**

```bash
git add packages/stream-deck-plugin/src/pi-templates/partials/common-settings.ejs
git commit -m "feat(stream-deck-plugin): add common-settings PI partial"
```

---

## Chunk 3: BaseAction Flag Overlay Logic

### Task 5: Add flag overlay to BaseAction

**Files:**
- Modify: `packages/stream-deck-plugin/src/shared/base-action.ts`
- Modify: `packages/stream-deck-plugin/src/shared/base-action.test.ts`

This is the core of the feature. The implementation adds:
1. Flag overlay state tracking
2. Image output gating in `setKeyImage`/`updateKeyImage`
3. Lifecycle hooks (`onWillAppear`, `onDidReceiveSettings`)
4. Telemetry subscription and flash cycle
5. Restore logic when flags clear

- [ ] **Step 1: Write failing tests for image output gating**

Add to `packages/stream-deck-plugin/src/shared/base-action.test.ts`:

```typescript
describe("flag overlay - image gating", () => {
  it("should store SVG but skip setImage when flag overlay is active", async () => {
    const ev = createMockEvent("context-1", { flagsOverlay: true });

    await testAction.setImage(ev, "<svg>original</svg>");
    ev.action.setImage.mockClear();

    // Simulate flag overlay being active
    testAction.simulateFlagOverlayActive("context-1");

    await testAction.updateImage("context-1", "<svg>updated-during-flag</svg>");

    // SVG is stored (for later restore)
    expect(testAction.getStoredImage("context-1")).toBe("<svg>updated-during-flag</svg>");
    // But setImage was NOT called (flag overlay takes priority)
    expect(ev.action.setImage).not.toHaveBeenCalled();
  });

  it("should call setImage normally when flag overlay is not active", async () => {
    const ev = createMockEvent("context-1", { flagsOverlay: true });

    await testAction.setImage(ev, "<svg>original</svg>");
    ev.action.setImage.mockClear();

    await testAction.updateImage("context-1", "<svg>updated</svg>");

    expect(ev.action.setImage).toHaveBeenCalledWith("<svg>updated</svg>");
  });

  it("should gate setKeyImage as well during active flag overlay", async () => {
    const ev = createMockEvent("context-1", { flagsOverlay: true });

    await testAction.setImage(ev, "<svg>original</svg>");

    testAction.simulateFlagOverlayActive("context-1");
    ev.action.setImage.mockClear();

    await testAction.setImage(ev, "<svg>new-during-flag</svg>");

    expect(testAction.getStoredImage("context-1")).toBe("<svg>new-during-flag</svg>");
    expect(ev.action.setImage).not.toHaveBeenCalled();
  });
});
```

Update the `TestAction` class to expose flag overlay methods for testing:

```typescript
class TestAction extends BaseAction<{ testSetting?: string; flagsOverlay?: boolean }> {
  // ... existing methods ...

  simulateFlagOverlayActive(contextId: string): void {
    this.flagOverlayActive.add(contextId);
  }

  simulateFlagOverlayInactive(contextId: string): void {
    this.flagOverlayActive.delete(contextId);
  }
}
```

Note: `flagOverlayActive` needs to be `protected` in BaseAction for this to work.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/stream-deck-plugin && npx vitest run src/shared/base-action.test.ts`
Expected: FAIL — `flagOverlayActive` does not exist on BaseAction

- [ ] **Step 3: Add flag overlay state and image gating to BaseAction**

Modify `packages/stream-deck-plugin/src/shared/base-action.ts`:

Add imports at top:
```typescript
import type { FlagInfo } from "@iracedeck/iracing-sdk";
import { resolveAllActiveFlags } from "@iracedeck/iracing-sdk";
import type { SDKController } from "@iracedeck/iracing-sdk";

import { getController } from "./sdk-singleton.js";
```

Add new fields after existing fields:
```typescript
/** Contexts with flag overlay enabled (settings.flagsOverlay === true) */
protected flagOverlayContexts = new Set<string>();

/** Contexts currently displaying a flag color (image output gated) */
protected flagOverlayActive = new Set<string>();

/** Shared flash timer for all overlay contexts */
private flagFlashTimer: ReturnType<typeof setInterval> | null = null;

/** Current active flags from telemetry */
private currentFlags: FlagInfo[] = [];

/** Rotation index for multi-flag alternation */
private flagFlashIndex = 0;

/** Shared telemetry subscription ID */
private flagTelemetrySubId: string | null = null;

/** Last flag state key for change detection */
private lastFlagStateKey = "";
```

Modify `refreshAllImages` — add gating check:
```typescript
private refreshAllImages(): void {
  for (const [contextId, { action, svg }] of this.contexts) {
    // Skip contexts with active flag overlay
    if (this.flagOverlayActive.has(contextId)) continue;

    const finalImage = this.applyOverlayIfNeeded(svg);
    action.setImage(finalImage).catch((err) => {
      this.logger.warn(`Failed to refresh image for context ${contextId}: ${err}`);
    });
  }
}
```

Modify `setKeyImage` — add gating check after storing SVG:
```typescript
protected async setKeyImage(ev: KeyCompatibleEvent<T>, svg: string): Promise<void> {
  if (!ev.action.isKey()) {
    this.logger.debug(`setKeyImage: skipping non-key action ${ev.action.id}`);
    return;
  }

  const keyAction = ev.action as KeyAction<T>;

  // Store original SVG for later refresh (always, even during flag overlay)
  this.contexts.set(ev.action.id, { action: keyAction, svg });
  this.logger.debug(`setKeyImage: stored context ${ev.action.id}, isActive=${this._isActive}`);

  // Skip visual update if flag overlay is active for this context
  if (this.flagOverlayActive.has(ev.action.id)) {
    this.logger.trace(`setKeyImage: skipped visual update (flag overlay active) for ${ev.action.id}`);
    return;
  }

  // Apply overlay if inactive and global setting is enabled
  const finalImage = this.applyOverlayIfNeeded(svg);
  await keyAction.setImage(finalImage);
  this.logger.trace(`setKeyImage: image set for ${ev.action.id}`);
}
```

Modify `updateKeyImage` — add gating check after storing SVG:
```typescript
protected async updateKeyImage(contextId: string, svg: string): Promise<boolean> {
  const entry = this.contexts.get(contextId);

  if (!entry) {
    this.logger.debug(`updateKeyImage: context ${contextId} not found`);
    return false;
  }

  // Store original SVG for later refresh (always, even during flag overlay)
  entry.svg = svg;

  // Skip visual update if flag overlay is active for this context
  if (this.flagOverlayActive.has(contextId)) {
    this.logger.trace(`updateKeyImage: skipped visual update (flag overlay active) for ${contextId}`);
    return true;
  }

  // Apply overlay if inactive and global setting is enabled
  const finalImage = this.applyOverlayIfNeeded(svg);
  await entry.action.setImage(finalImage);
  this.logger.trace(`updateKeyImage: updated ${contextId}, isActive=${this._isActive}`);

  return true;
}
```

- [ ] **Step 4: Run gating tests to verify they pass**

Run: `cd packages/stream-deck-plugin && npx vitest run src/shared/base-action.test.ts`
Expected: All tests PASS (including new gating tests)

- [ ] **Step 5: Write failing tests for lifecycle hooks and flash cycle**

Add more tests to `base-action.test.ts`:

```typescript
describe("flag overlay - lifecycle", () => {
  it("should add context to flagOverlayContexts on onWillAppear with flagsOverlay=true", async () => {
    const ev = createMockEvent("context-1", { flagsOverlay: true }) as any;
    ev.action.isKey = vi.fn().mockReturnValue(true);

    await testAction.onWillAppear(ev);

    expect(testAction.isFlagOverlayEnabled("context-1")).toBe(true);
  });

  it("should not add context when flagsOverlay is false", async () => {
    const ev = createMockEvent("context-1", { flagsOverlay: false }) as any;

    await testAction.onWillAppear(ev);

    expect(testAction.isFlagOverlayEnabled("context-1")).toBe(false);
  });

  it("should remove context from flagOverlayContexts on onWillDisappear", async () => {
    const ev = createMockEvent("context-1", { flagsOverlay: true }) as any;
    ev.action.isKey = vi.fn().mockReturnValue(true);

    await testAction.onWillAppear(ev);
    await testAction.onWillDisappear(ev);

    expect(testAction.isFlagOverlayEnabled("context-1")).toBe(false);
  });

  it("should update context on onDidReceiveSettings", async () => {
    const ev1 = createMockEvent("context-1", { flagsOverlay: false }) as any;
    ev1.action.isKey = vi.fn().mockReturnValue(true);

    await testAction.onWillAppear(ev1);
    expect(testAction.isFlagOverlayEnabled("context-1")).toBe(false);

    const ev2 = createMockEvent("context-1", { flagsOverlay: true }) as any;
    ev2.action.isKey = vi.fn().mockReturnValue(true);

    await testAction.onDidReceiveSettings(ev2);
    expect(testAction.isFlagOverlayEnabled("context-1")).toBe(true);
  });
});

describe("flag overlay - SVG generation", () => {
  it("should generate a solid color SVG for a flag", () => {
    const svg = testAction.generateFlagSvgPublic({ label: "YELLOW", color: "#f1c40f", textColor: "#1a1a1a", pulse: false });
    expect(svg).toContain("#f1c40f");
    expect(svg).toContain("72");
    expect(svg).toContain("svg");
  });
});
```

Add test helper methods to `TestAction`:
```typescript
isFlagOverlayEnabled(contextId: string): boolean {
  return this.flagOverlayContexts.has(contextId);
}

generateFlagSvgPublic(flagInfo: FlagInfo): string {
  return this.generateFlagOverlaySvg(flagInfo);
}
```

- [ ] **Step 6: Implement lifecycle hooks and flag SVG generation in BaseAction**

Add `onWillAppear` override:
```typescript
override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
  const settings = ev.payload.settings as Record<string, unknown>;

  if (settings.flagsOverlay === true || settings.flagsOverlay === "true") {
    this.flagOverlayContexts.add(ev.action.id);
    this.ensureFlagTelemetrySubscription();
    this.logger.debug(`Flag overlay enabled for context ${ev.action.id}`);
  }
}
```

Add `onDidReceiveSettings` override:
```typescript
override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
  const settings = ev.payload.settings as Record<string, unknown>;

  if (settings.flagsOverlay === true || settings.flagsOverlay === "true") {
    this.flagOverlayContexts.add(ev.action.id);
    this.ensureFlagTelemetrySubscription();
  } else {
    this.flagOverlayContexts.delete(ev.action.id);
    // Restore original image if flag overlay was active
    if (this.flagOverlayActive.delete(ev.action.id)) {
      this.restoreFlagOverlayImage(ev.action.id);
    }
    this.cleanupFlagSubscriptionIfUnneeded();
  }
}
```

Update `onWillDisappear`:
```typescript
override async onWillDisappear(ev: WillDisappearEvent<T>): Promise<void> {
  this.flagOverlayContexts.delete(ev.action.id);
  this.flagOverlayActive.delete(ev.action.id);
  this.cleanupFlagSubscriptionIfUnneeded();
  this.contexts.delete(ev.action.id);
  this.logger.debug(`onWillDisappear: removed context ${ev.action.id}, remaining=${this.contexts.size}`);
}
```

Add private helpers:
```typescript
private static readonly FLAG_FLASH_INTERVAL_MS = 500;
private static readonly FLAG_SUBSCRIPTION_PREFIX = "__flag_overlay__";

/**
 * Generate a solid-color SVG for a flag overlay.
 */
protected generateFlagOverlaySvg(flagInfo: FlagInfo): string {
  return svgToDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" rx="8" fill="${flagInfo.color}"/></svg>`,
  );
}

/**
 * Ensure a single telemetry subscription exists for flag overlay.
 */
private ensureFlagTelemetrySubscription(): void {
  if (this.flagTelemetrySubId) return;

  try {
    const controller = getController();
    const subId = `${BaseAction.FLAG_SUBSCRIPTION_PREFIX}${Date.now()}`;
    this.flagTelemetrySubId = subId;

    controller.subscribe(subId, (telemetry, isConnected) => {
      if (!isConnected) {
        this.onFlagTelemetryUpdate(undefined);
        return;
      }
      this.onFlagTelemetryUpdate(telemetry?.SessionFlags);
    });

    this.logger.debug("Flag overlay telemetry subscription started");
  } catch {
    this.logger.debug("Flag overlay: SDK not initialized, skipping telemetry subscription");
  }
}

/**
 * Process telemetry update for flag detection.
 */
private onFlagTelemetryUpdate(sessionFlags: number | undefined): void {
  const flags = resolveAllActiveFlags(sessionFlags);
  const stateKey = flags.map((f) => f.label).join(",");

  if (stateKey === this.lastFlagStateKey) return;

  this.lastFlagStateKey = stateKey;
  this.currentFlags = flags;
  this.flagFlashIndex = 0;

  if (flags.length > 0) {
    this.startFlagFlash();
  } else {
    this.stopFlagFlash();
  }
}

/**
 * Start or restart the flag flash timer.
 */
private startFlagFlash(): void {
  // Clear existing timer to prevent leaks
  if (this.flagFlashTimer) {
    clearInterval(this.flagFlashTimer);
  }

  // Immediately show first flag
  this.applyFlagOverlayToContexts();

  this.flagFlashTimer = setInterval(() => {
    this.flagFlashIndex++;
    this.applyFlagOverlayToContexts();
  }, BaseAction.FLAG_FLASH_INTERVAL_MS);
}

/**
 * Stop the flag flash timer and restore original images.
 */
private stopFlagFlash(): void {
  if (this.flagFlashTimer) {
    clearInterval(this.flagFlashTimer);
    this.flagFlashTimer = null;
  }

  // Restore all overlay-active contexts
  for (const contextId of this.flagOverlayActive) {
    this.restoreFlagOverlayImage(contextId);
  }
  this.flagOverlayActive.clear();
}

/**
 * Apply the current flag color to all overlay-enabled contexts.
 */
private applyFlagOverlayToContexts(): void {
  if (this.currentFlags.length === 0) return;

  const flagInfo = this.currentFlags[this.flagFlashIndex % this.currentFlags.length];
  const flagSvg = this.generateFlagOverlaySvg(flagInfo);

  for (const contextId of this.flagOverlayContexts) {
    const entry = this.contexts.get(contextId);
    if (!entry) continue;

    this.flagOverlayActive.add(contextId);
    entry.action.setImage(flagSvg).catch((err) => {
      this.logger.warn(`Failed to set flag overlay for context ${contextId}: ${err}`);
    });
  }
}

/**
 * Restore the original image for a context after flag overlay ends.
 */
private restoreFlagOverlayImage(contextId: string): void {
  const entry = this.contexts.get(contextId);
  if (!entry) return;

  const finalImage = this.applyOverlayIfNeeded(entry.svg);
  entry.action.setImage(finalImage).catch((err) => {
    this.logger.warn(`Failed to restore image for context ${contextId}: ${err}`);
  });
}

/**
 * Unsubscribe from telemetry if no contexts need flag overlay.
 */
private cleanupFlagSubscriptionIfUnneeded(): void {
  if (this.flagOverlayContexts.size > 0 || !this.flagTelemetrySubId) return;

  try {
    const controller = getController();
    controller.unsubscribe(this.flagTelemetrySubId);
  } catch {
    // SDK may not be initialized
  }

  this.flagTelemetrySubId = null;
  this.stopFlagFlash();
  this.logger.debug("Flag overlay telemetry subscription stopped");
}
```

Add necessary import for `svgToDataUri`:
```typescript
import { svgToDataUri } from "./overlay-utils.js";
```

- [ ] **Step 7: Run all BaseAction tests**

Run: `cd packages/stream-deck-plugin && npx vitest run src/shared/base-action.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add packages/stream-deck-plugin/src/shared/base-action.ts packages/stream-deck-plugin/src/shared/base-action.test.ts
git commit -m "feat(stream-deck-plugin): add flag overlay to BaseAction"
```

---

## Chunk 4: Update All Actions

### Task 6: Update all action settings to extend CommonSettings

**Files:**
- Modify: All 30 action `.ts` files in `packages/stream-deck-plugin/src/actions/`

For each action file, make two changes:

1. **Settings schema**: Change `z.object({...})` to `CommonSettings.extend({...})`
2. **Add super calls**: Add `await super.onWillAppear(ev)` and `await super.onDidReceiveSettings(ev)`
3. **Import CommonSettings**: Add to the shared imports

**Pattern for actions WITH settings:**

Before:
```typescript
import { ConnectionStateAwareAction, ... } from "../shared/index.js";

const MyActionSettings = z.object({
  direction: z.enum(["next", "previous"]).default("next"),
});
```

After:
```typescript
import { CommonSettings, ConnectionStateAwareAction, ... } from "../shared/index.js";

const MyActionSettings = CommonSettings.extend({
  direction: z.enum(["next", "previous"]).default("next"),
});
```

**Pattern for onWillAppear:**

Before:
```typescript
override async onWillAppear(ev: WillAppearEvent<MySettings>): Promise<void> {
  const parsed = MySettings.safeParse(ev.payload.settings);
  // ...
}
```

After:
```typescript
override async onWillAppear(ev: WillAppearEvent<MySettings>): Promise<void> {
  await super.onWillAppear(ev);
  const parsed = MySettings.safeParse(ev.payload.settings);
  // ...
}
```

**Pattern for onDidReceiveSettings:**

Before:
```typescript
override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MySettings>): Promise<void> {
  const parsed = MySettings.safeParse(ev.payload.settings);
  // ...
}
```

After:
```typescript
override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MySettings>): Promise<void> {
  await super.onDidReceiveSettings(ev);
  const parsed = MySettings.safeParse(ev.payload.settings);
  // ...
}
```

- [ ] **Step 1: Update all 30 action files**

Apply the three changes (CommonSettings import, schema extension, super calls) to each action file. The complete list of files:

1. `audio-controls.ts`
2. `black-box-selector.ts`
3. `camera-cycle.ts`
4. `camera-editor-adjustments.ts`
5. `camera-editor-controls.ts`
6. `camera-focus.ts`
7. `car-control.ts`
8. `chat.ts`
9. `cockpit-misc.ts`
10. `fuel-service.ts`
11. `look-direction.ts`
12. `media-capture.ts`
13. `pit-quick-actions.ts`
14. `replay-navigation.ts`
15. `replay-speed.ts`
16. `replay-transport.ts`
17. `session-info.ts`
18. `setup-aero.ts`
19. `setup-brakes.ts`
20. `setup-chassis.ts`
21. `setup-engine.ts`
22. `setup-fuel.ts`
23. `setup-hybrid.ts`
24. `setup-traction.ts`
25. `splits-delta-cycle.ts`
26. `telemetry-control.ts`
27. `telemetry-display.ts`
28. `tire-service.ts`
29. `toggle-ui-elements.ts`
30. `view-adjustment.ts`

For `session-info.ts` specifically: the `SessionInfoSettings` schema already uses `z.object`. Change it to `CommonSettings.extend(...)` like the rest.

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 3: Run build to check for TypeScript warnings**

Run: `pnpm build 2>&1 | grep -i "TS[0-9]"`
Expected: No TypeScript errors (ignore `Circular dependency` and `npm warn` lines)

- [ ] **Step 4: Commit**

```bash
git add packages/stream-deck-plugin/src/actions/
git commit -m "feat(stream-deck-plugin): extend CommonSettings in all actions"
```

### Task 7: Add common-settings include to all PI templates

**Files:**
- Modify: All 30 action `.ejs` files in `packages/stream-deck-plugin/src/pi/`

For each `.ejs` template, add the common-settings include just before the closing `</body>` tag, after any existing content (action settings, key bindings, scripts):

```ejs
    <%- include('common-settings') %>
  </body>
</html>
```

**Do NOT modify `settings.ejs`** — that is a general settings page, not an action PI.

The complete list of 30 EJS files to update:

1. `audio-controls.ejs`
2. `black-box-selector.ejs`
3. `camera-cycle.ejs`
4. `camera-editor-adjustments.ejs`
5. `camera-editor-controls.ejs`
6. `camera-focus.ejs`
7. `car-control.ejs`
8. `chat.ejs`
9. `cockpit-misc.ejs`
10. `fuel-service.ejs`
11. `look-direction.ejs`
12. `media-capture.ejs`
13. `pit-quick-actions.ejs`
14. `replay-navigation.ejs`
15. `replay-speed.ejs`
16. `replay-transport.ejs`
17. `session-info.ejs`
18. `setup-aero.ejs`
19. `setup-brakes.ejs`
20. `setup-chassis.ejs`
21. `setup-engine.ejs`
22. `setup-fuel.ejs`
23. `setup-hybrid.ejs`
24. `setup-traction.ejs`
25. `splits-delta-cycle.ejs`
26. `telemetry-control.ejs`
27. `telemetry-display.ejs`
28. `tire-service.ejs`
29. `toggle-ui-elements.ejs`
30. `view-adjustment.ejs`

- [ ] **Step 1: Update all 30 EJS files**

- [ ] **Step 2: Build and verify PI HTML output**

Run: `pnpm build`
Expected: Build succeeds, generated HTML files in `ui/` folder contain "Common Settings" accordion

- [ ] **Step 3: Commit**

```bash
git add packages/stream-deck-plugin/src/pi/
git commit -m "feat(stream-deck-plugin): add common-settings to all PI templates"
```

---

## Chunk 5: Documentation and Final Verification

### Task 8: Update documentation

**Files:**
- Modify: `.claude/rules/stream-deck-actions.md`
- Modify: `packages/stream-deck-plugin/CLAUDE.md`

- [ ] **Step 1: Update stream-deck-actions.md**

Add to the "Requirements" section:

```markdown
### CommonSettings

All action settings schemas must extend `CommonSettings` from `../shared/index.js`:

```typescript
import { CommonSettings } from "../shared/index.js";

const MyActionSettings = CommonSettings.extend({
  direction: z.enum(["next", "previous"]).default("next"),
});
```

Actions with no custom settings use `CommonSettings` directly.

### Super Calls

All actions must call `super.onWillAppear(ev)` and `super.onDidReceiveSettings(ev)` in their lifecycle hooks:

```typescript
override async onWillAppear(ev: WillAppearEvent<MySettings>): Promise<void> {
  await super.onWillAppear(ev);
  // ... action-specific logic
}

override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MySettings>): Promise<void> {
  await super.onDidReceiveSettings(ev);
  // ... action-specific logic
}
```

This is required for BaseAction features (flag overlay, future common features) to work.
```

- [ ] **Step 2: Update CLAUDE.md**

In the "Adding a New Action" section of `packages/stream-deck-plugin/CLAUDE.md`:

Update the action source template to show `CommonSettings.extend(...)` instead of `z.object({})`.

Add `CommonSettings` to the shared imports in the template.

Add `await super.onWillAppear(ev)` and `await super.onDidReceiveSettings(ev)` to the lifecycle handlers in the template.

Add a note in the PI template section about including `common-settings`:

```markdown
#### PI Template Note
Every action PI template must include the common-settings partial before `</body>`:
```ejs
<%- include('common-settings') %>
```
```

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/stream-deck-actions.md packages/stream-deck-plugin/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: update action conventions for CommonSettings and super calls

Fixes #106
EOF
)"
```

### Task 9: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run full build and check for warnings**

Run: `pnpm build 2>&1`
Expected: Build succeeds with no TypeScript errors (search output for `TS[0-9]+:` patterns)

- [ ] **Step 3: Run lint and format**

Run: `pnpm lint:fix && pnpm format:fix`
Expected: No errors

- [ ] **Step 4: Verify acceptance criteria**

Review each item from the spec:
- [ ] CommonSettings schema exists and all action settings extend it
- [ ] Common Settings section appears in every action's Property Inspector
- [ ] Flags Overlay checkbox defaults to unchecked
- [ ] Active flag causes button to show solid flag color at 500ms flash interval
- [ ] Multiple simultaneous flags alternate each cycle
- [ ] Normal icon restores (with latest value) when flags clear
- [ ] Telemetry-driven actions don't overwrite flag overlay during active flags
- [ ] Flag overlay is handled in BaseAction (no per-action logic needed)
- [ ] Flag detection utilities live in `@iracedeck/iracing-sdk` for cross-plugin reuse
- [ ] Unit tests cover flag detection, flashing, gating, and multi-flag rotation
- [ ] Build succeeds without TypeScript warnings
