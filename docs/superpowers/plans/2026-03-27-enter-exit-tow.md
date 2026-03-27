# Enter / Exit / Tow Car — Implementation Plan

> **Superseded:** This plan was originally written for a Cockpit Misc mode. During implementation, the feature was moved to the `CarControl` action class in `packages/actions/src/actions/car-control.ts`. References to `CockpitMisc`, `cockpit-misc.ts`, `cockpitMiscEnterExitTow`, and `packages/icons/cockpit-misc/` below are outdated — the actual implementation uses `CarControl`, `car-control.ts`, `carControlEnterExitTow`, and `packages/icons/car-control/`. See the design spec for the original rationale.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a context-aware "Enter / Exit / Tow Car" mode to the Car Control action that dynamically updates its icon based on telemetry state.

**Architecture:** New mode added to the `CarControl` action class. A pure `getEnterExitTowState()` function determines which of 4 states applies based on `IsOnTrack`, `PlayerCarInPitStall`, and session type from `SessionInfo`. The action conditionally subscribes to telemetry only when this mode is selected, caches state per context to avoid unnecessary redraws, and uses `holdBinding`/`releaseBinding` for the long-press pattern.

**Tech Stack:** TypeScript, Vitest, SVG (Mustache templates), EJS (PI templates)

**Spec:** `docs/superpowers/specs/2026-03-27-enter-exit-tow-design.md`

---

## Tasks

### Task 1: Create the 4 icon SVGs

**Files:**
- Create: `packages/icons/cockpit-misc/enter-car.svg`
- Create: `packages/icons/cockpit-misc/exit-car.svg`
- Create: `packages/icons/cockpit-misc/reset-to-pits.svg`
- Create: `packages/icons/cockpit-misc/tow.svg`

All icons follow the 144x144 Standard key icon template with `<desc>` color metadata, `{{backgroundColor}}`, `{{textColor}}`, `{{graphic1Color}}` Mustache placeholders, and `activity-state` filter. Each has distinct bold artwork in the icon content area (y=18 to y=86). The `{{mainLabel}}` is rendered at y=126 (bold, 20px) and `{{subLabel}}` at y=104 (empty string, but the placeholder must exist for `renderIconTemplate`).

- [ ] **Step 1: Create `enter-car.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a2a3a","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>

    <!-- Car body outline -->
    <path d="M30 62 L42 38 L102 38 L114 62 L114 72 L30 72 Z" fill="none" stroke="{{graphic1Color}}" stroke-width="4" stroke-linejoin="round"/>
    <!-- Windshield -->
    <line x1="52" y1="38" x2="46" y2="62" stroke="{{graphic1Color}}" stroke-width="3"/>
    <!-- Rear window -->
    <line x1="92" y1="38" x2="98" y2="62" stroke="{{graphic1Color}}" stroke-width="3"/>
    <!-- Wheels -->
    <circle cx="48" cy="72" r="8" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <circle cx="96" cy="72" r="8" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <!-- Arrow pointing inward (entering) -->
    <line x1="72" y1="18" x2="72" y2="32" stroke="#2ecc71" stroke-width="5" stroke-linecap="round"/>
    <polyline points="64,26 72,34 80,26" fill="none" stroke="#2ecc71" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Two-line label -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

- [ ] **Step 2: Create `exit-car.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a2a3a","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>

    <!-- Car body outline -->
    <path d="M30 62 L42 38 L102 38 L114 62 L114 72 L30 72 Z" fill="none" stroke="{{graphic1Color}}" stroke-width="4" stroke-linejoin="round"/>
    <!-- Windshield -->
    <line x1="52" y1="38" x2="46" y2="62" stroke="{{graphic1Color}}" stroke-width="3"/>
    <!-- Rear window -->
    <line x1="92" y1="38" x2="98" y2="62" stroke="{{graphic1Color}}" stroke-width="3"/>
    <!-- Wheels -->
    <circle cx="48" cy="72" r="8" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <circle cx="96" cy="72" r="8" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <!-- Arrow pointing outward (exiting) -->
    <line x1="72" y1="34" x2="72" y2="18" stroke="#e74c3c" stroke-width="5" stroke-linecap="round"/>
    <polyline points="64,24 72,16 80,24" fill="none" stroke="#e74c3c" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Two-line label -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

- [ ] **Step 3: Create `reset-to-pits.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a2a3a","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>

    <!-- Car body outline -->
    <path d="M30 62 L42 38 L102 38 L114 62 L114 72 L30 72 Z" fill="none" stroke="{{graphic1Color}}" stroke-width="4" stroke-linejoin="round"/>
    <!-- Windshield -->
    <line x1="52" y1="38" x2="46" y2="62" stroke="{{graphic1Color}}" stroke-width="3"/>
    <!-- Rear window -->
    <line x1="92" y1="38" x2="98" y2="62" stroke="{{graphic1Color}}" stroke-width="3"/>
    <!-- Wheels -->
    <circle cx="48" cy="72" r="8" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <circle cx="96" cy="72" r="8" fill="none" stroke="{{graphic1Color}}" stroke-width="4"/>
    <!-- Circular reset/return arrow -->
    <path d="M84 22 A18 18 0 1 1 62 18" fill="none" stroke="#f39c12" stroke-width="5" stroke-linecap="round"/>
    <polyline points="62,10 62,20 72,20" fill="none" stroke="#f39c12" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Two-line label -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

- [ ] **Step 4: Create `tow.svg`**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
  <desc>{"colors":{"backgroundColor":"#2a2a3a","textColor":"#ffffff","graphic1Color":"#ffffff"}}</desc>
  <g filter="url(#activity-state)">
    <rect x="0" y="0" width="144" height="144" fill="{{backgroundColor}}"/>

    <!-- Thick tow hook -->
    <!-- Hook shaft -->
    <line x1="72" y1="18" x2="72" y2="48" stroke="{{graphic1Color}}" stroke-width="8" stroke-linecap="round"/>
    <!-- Hook curve (open-bottom J shape) -->
    <path d="M72 48 L72 62 A16 16 0 0 1 40 62 L40 52" fill="none" stroke="{{graphic1Color}}" stroke-width="8" stroke-linecap="round"/>
    <!-- Hook tip (inward point) -->
    <line x1="40" y1="52" x2="48" y2="46" stroke="{{graphic1Color}}" stroke-width="8" stroke-linecap="round"/>
    <!-- Cross-bar at top -->
    <line x1="58" y1="18" x2="86" y2="18" stroke="{{graphic1Color}}" stroke-width="6" stroke-linecap="round"/>
    <!-- Warning triangle -->
    <path d="M92 50 L104 72 L80 72 Z" fill="none" stroke="#f39c12" stroke-width="4" stroke-linejoin="round"/>
    <text x="92" y="68" text-anchor="middle" dominant-baseline="central"
          fill="#f39c12" font-family="Arial, sans-serif" font-size="16" font-weight="bold">!</text>

    <!-- Two-line label -->
    <text x="72" y="104" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="16">{{subLabel}}</text>
    <text x="72" y="126" text-anchor="middle" dominant-baseline="central"
          fill="{{textColor}}" font-family="Arial, sans-serif" font-size="20" font-weight="bold">{{mainLabel}}</text>
  </g>
</svg>
```

- [ ] **Step 5: Generate icon previews and color defaults**

Run:
```bash
node scripts/generate-icon-previews.mjs && node scripts/generate-color-defaults.mjs
```

Expected: Scripts complete successfully, preview files and `color-defaults.json` updated.

- [ ] **Step 6: Commit**

```bash
git add packages/icons/cockpit-misc/enter-car.svg packages/icons/cockpit-misc/exit-car.svg packages/icons/cockpit-misc/reset-to-pits.svg packages/icons/cockpit-misc/tow.svg packages/icons/preview/ packages/stream-deck-plugin/src/pi/data/color-defaults.json
git commit -m "feat(icons): add enter/exit/reset/tow icons for cockpit-misc (#193)"
```

---

### Task 2: Write failing tests for `getEnterExitTowState`

**Files:**
- Modify: `packages/actions/src/actions/cockpit-misc.test.ts`

- [ ] **Step 1: Add icon mocks and update imports**

At the top of `cockpit-misc.test.ts`, after the existing icon mocks (after line 38), add:

```typescript
vi.mock("@iracedeck/icons/cockpit-misc/enter-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">enter-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/exit-car.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">exit-car {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/reset-to-pits.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">reset-to-pits {{mainLabel}} {{subLabel}}</svg>',
}));
vi.mock("@iracedeck/icons/cockpit-misc/tow.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">tow {{mainLabel}} {{subLabel}}</svg>',
}));
```

Update the import at line 3 to also import `getEnterExitTowState`:

```typescript
import { COCKPIT_MISC_GLOBAL_KEYS, CockpitMisc, generateCockpitMiscSvg, getEnterExitTowState } from "./cockpit-misc.js";
```

- [ ] **Step 2: Add `getEnterExitTowState` test block**

Add a new `describe` block after the `COCKPIT_MISC_GLOBAL_KEYS` block (after line 170):

```typescript
  describe("getEnterExitTowState", () => {
    it("should return enter-car when telemetry is null", () => {
      expect(getEnterExitTowState(null, null)).toBe("enter-car");
    });

    it("should return enter-car when IsOnTrack is false", () => {
      expect(getEnterExitTowState({ IsOnTrack: false } as any, null)).toBe("enter-car");
    });

    it("should return enter-car when IsOnTrack is undefined", () => {
      expect(getEnterExitTowState({} as any, null)).toBe("enter-car");
    });

    it("should return exit-car when on track and in pit stall", () => {
      expect(
        getEnterExitTowState({ IsOnTrack: true, PlayerCarInPitStall: true, SessionNum: 0 } as any, null),
      ).toBe("exit-car");
    });

    it("should return reset-to-pits when on track, not in pit stall, non-Race session", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Practice" }],
        },
      };
      expect(
        getEnterExitTowState(
          { IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any,
          sessionInfo as any,
        ),
      ).toBe("reset-to-pits");
    });

    it("should return tow when on track, not in pit stall, Race session", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Race" }],
        },
      };
      expect(
        getEnterExitTowState(
          { IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any,
          sessionInfo as any,
        ),
      ).toBe("tow");
    });

    it("should return reset-to-pits when on track, not in pit stall, Qualifying session", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Qualifying" }],
        },
      };
      expect(
        getEnterExitTowState(
          { IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any,
          sessionInfo as any,
        ),
      ).toBe("reset-to-pits");
    });

    it("should return reset-to-pits when on track, not in pit stall, session info is null", () => {
      expect(
        getEnterExitTowState(
          { IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any,
          null,
        ),
      ).toBe("reset-to-pits");
    });

    it("should return reset-to-pits when session number does not match any session", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [{ SessionNum: 0, SessionType: "Race" }],
        },
      };
      expect(
        getEnterExitTowState(
          { IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 5 } as any,
          sessionInfo as any,
        ),
      ).toBe("reset-to-pits");
    });

    it("should use correct session from multiple sessions based on SessionNum", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [
            { SessionNum: 0, SessionType: "Practice" },
            { SessionNum: 1, SessionType: "Qualifying" },
            { SessionNum: 2, SessionType: "Race" },
          ],
        },
      };
      expect(
        getEnterExitTowState(
          { IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 2 } as any,
          sessionInfo as any,
        ),
      ).toBe("tow");
      expect(
        getEnterExitTowState(
          { IsOnTrack: true, PlayerCarInPitStall: false, SessionNum: 0 } as any,
          sessionInfo as any,
        ),
      ).toBe("reset-to-pits");
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/actions/src/actions/cockpit-misc.test.ts`

Expected: FAIL — `getEnterExitTowState` is not exported from `./cockpit-misc.js`.

- [ ] **Step 4: Commit failing tests**

```bash
git add packages/actions/src/actions/cockpit-misc.test.ts
git commit -m "test(actions): add failing tests for getEnterExitTowState (#193)"
```

---

### Task 3: Implement `getEnterExitTowState` and update type/data structures

**Files:**
- Modify: `packages/actions/src/actions/cockpit-misc.ts`

- [ ] **Step 1: Add new imports for the 4 icon SVGs**

After the existing SVG imports (after line 23), add:

```typescript
import enterCarSvg from "@iracedeck/icons/cockpit-misc/enter-car.svg";
import exitCarSvg from "@iracedeck/icons/cockpit-misc/exit-car.svg";
import resetToPitsSvg from "@iracedeck/icons/cockpit-misc/reset-to-pits.svg";
import towSvg from "@iracedeck/icons/cockpit-misc/tow.svg";
```

Also add the telemetry types import at the top with the other imports:

```typescript
import type { SessionInfo, TelemetryData } from "@iracedeck/iracing-sdk";
```

- [ ] **Step 2: Add `enter-exit-tow` to the `CockpitMiscControl` type union**

Update the type (line 26–33) to include the new mode:

```typescript
type CockpitMiscControl =
  | "toggle-wipers"
  | "trigger-wipers"
  | "ffb-max-force"
  | "report-latency"
  | "dash-page-1"
  | "dash-page-2"
  | "in-lap-mode"
  | "enter-exit-tow";
```

- [ ] **Step 3: Add the `EnterExitTowState` type and state-to-SVG/label maps**

After the `DIRECTIONAL_CONTROLS` set, add:

```typescript
/** @internal Exported for testing */
export type EnterExitTowState = "enter-car" | "exit-car" | "reset-to-pits" | "tow";

const ENTER_EXIT_TOW_SVGS: Record<EnterExitTowState, string> = {
  "enter-car": enterCarSvg,
  "exit-car": exitCarSvg,
  "reset-to-pits": resetToPitsSvg,
  "tow": towSvg,
};

const ENTER_EXIT_TOW_LABELS: Record<EnterExitTowState, string> = {
  "enter-car": "ENTER",
  "exit-car": "EXIT",
  "reset-to-pits": "RESET",
  "tow": "TOW",
};
```

- [ ] **Step 4: Add `enter-exit-tow` entries to `COCKPIT_MISC_LABELS` and `COCKPIT_MISC_SVGS`**

Add to `COCKPIT_MISC_LABELS` (placeholder — the actual label is chosen dynamically based on state, but we need an entry for the static fallback):

```typescript
  "enter-exit-tow": { mainLabel: "ENTER", subLabel: "" },
```

Add to `COCKPIT_MISC_SVGS`:

```typescript
  "enter-exit-tow": enterCarSvg,
```

- [ ] **Step 5: Add global key mapping**

Add to `COCKPIT_MISC_GLOBAL_KEYS`:

```typescript
  "enter-exit-tow": "cockpitMiscEnterExitTow",
```

- [ ] **Step 6: Update the Zod enum**

Update the `CockpitMiscSettings` Zod schema to include `"enter-exit-tow"`:

```typescript
const CockpitMiscSettings = CommonSettings.extend({
  control: z
    .enum([
      "toggle-wipers",
      "trigger-wipers",
      "ffb-max-force",
      "report-latency",
      "dash-page-1",
      "dash-page-2",
      "in-lap-mode",
      "enter-exit-tow",
    ])
    .default("toggle-wipers"),
  direction: z.enum(["increase", "decrease"]).default("increase"),
});
```

- [ ] **Step 7: Implement `getEnterExitTowState`**

Add the exported function (before `generateCockpitMiscSvg`):

```typescript
/**
 * @internal Exported for testing
 *
 * Determines the Enter/Exit/Tow state based on telemetry and session info.
 * Priority order: enter-car → exit-car → reset-to-pits/tow (based on session type).
 */
export function getEnterExitTowState(
  telemetry: TelemetryData | null,
  sessionInfo: SessionInfo | null,
): EnterExitTowState {
  if (!telemetry || !telemetry.IsOnTrack) {
    return "enter-car";
  }

  if (telemetry.PlayerCarInPitStall) {
    return "exit-car";
  }

  // On track, not in pit stall — check session type
  const sessionNum = telemetry.SessionNum ?? 0;
  const sessions = (sessionInfo?.SessionInfo as Record<string, unknown> | undefined)
    ?.Sessions as Array<Record<string, unknown>> | undefined;
  const currentSession = sessions?.find(
    (s) => s.SessionNum === sessionNum,
  );
  const sessionType = currentSession?.SessionType as string | undefined;

  if (sessionType === "Race") {
    return "tow";
  }

  return "reset-to-pits";
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run packages/actions/src/actions/cockpit-misc.test.ts`

Expected: All `getEnterExitTowState` tests PASS. Existing tests still PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/actions/src/actions/cockpit-misc.ts packages/actions/src/actions/cockpit-misc.test.ts
git commit -m "feat(actions): implement getEnterExitTowState for cockpit-misc (#193)"
```

---

### Task 4: Write failing tests for enter-exit-tow icon generation

**Files:**
- Modify: `packages/actions/src/actions/cockpit-misc.test.ts`

- [ ] **Step 1: Add icon generation tests for enter-exit-tow**

Add to the `generateCockpitMiscSvg` describe block:

```typescript
    it("should generate a valid data URI for enter-exit-tow (default state)", () => {
      const result = generateCockpitMiscSvg({ control: "enter-exit-tow", direction: "increase" });
      expect(result).toContain("data:image/svg+xml");
    });

    it("should include ENTER label for enter-exit-tow default", () => {
      const result = generateCockpitMiscSvg({ control: "enter-exit-tow", direction: "increase" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("ENTER");
    });
```

Also add to the `generateCockpitMiscSvg` test block — a new test for the state-aware variant. First, update the import to also import `generateEnterExitTowSvg`:

```typescript
import {
  COCKPIT_MISC_GLOBAL_KEYS,
  CockpitMisc,
  generateCockpitMiscSvg,
  generateEnterExitTowSvg,
  getEnterExitTowState,
} from "./cockpit-misc.js";
```

Add a new describe block after `generateCockpitMiscSvg`:

```typescript
  describe("generateEnterExitTowSvg", () => {
    it("should produce different icons for each state", () => {
      const states = ["enter-car", "exit-car", "reset-to-pits", "tow"] as const;
      const results = states.map((state) => generateEnterExitTowSvg(state, {}));
      const unique = new Set(results);
      expect(unique.size).toBe(4);
    });

    it("should include ENTER label for enter-car state", () => {
      const result = generateEnterExitTowSvg("enter-car", {});
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("ENTER");
      expect(decoded).toContain("enter-car");
    });

    it("should include EXIT label for exit-car state", () => {
      const result = generateEnterExitTowSvg("exit-car", {});
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("EXIT");
      expect(decoded).toContain("exit-car");
    });

    it("should include RESET label for reset-to-pits state", () => {
      const result = generateEnterExitTowSvg("reset-to-pits", {});
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("RESET");
      expect(decoded).toContain("reset-to-pits");
    });

    it("should include TOW label for tow state", () => {
      const result = generateEnterExitTowSvg("tow", {});
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain("TOW");
      expect(decoded).toContain("tow");
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/actions/src/actions/cockpit-misc.test.ts`

Expected: FAIL — `generateEnterExitTowSvg` is not exported.

- [ ] **Step 3: Commit**

```bash
git add packages/actions/src/actions/cockpit-misc.test.ts
git commit -m "test(actions): add failing tests for enter-exit-tow icon generation (#193)"
```

---

### Task 5: Implement `generateEnterExitTowSvg`

**Files:**
- Modify: `packages/actions/src/actions/cockpit-misc.ts`

- [ ] **Step 1: Add `generateEnterExitTowSvg` function**

Add after `getEnterExitTowState`, before `generateCockpitMiscSvg`:

```typescript
/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for a specific Enter/Exit/Tow state.
 */
export function generateEnterExitTowSvg(
  state: EnterExitTowState,
  colorOverrides: Record<string, string> | undefined,
): string {
  const iconSvg = ENTER_EXIT_TOW_SVGS[state];
  const mainLabel = ENTER_EXIT_TOW_LABELS[state];

  const colors = resolveIconColors(iconSvg, getGlobalColors(), colorOverrides);
  const svg = renderIconTemplate(iconSvg, {
    mainLabel,
    subLabel: "",
    ...colors,
  });

  return svgToDataUri(svg);
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run packages/actions/src/actions/cockpit-misc.test.ts`

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/actions/src/actions/cockpit-misc.ts
git commit -m "feat(actions): implement generateEnterExitTowSvg (#193)"
```

---

### Task 6: Write failing tests for action telemetry subscription and hold/release behavior

**Files:**
- Modify: `packages/actions/src/actions/cockpit-misc.test.ts`

- [ ] **Step 1: Add hoisted mocks for hold/release**

Update the hoisted mock block at the top (line 5–7) to include hold and release mocks:

```typescript
const { mockTapBinding, mockHoldBinding, mockReleaseBinding } = vi.hoisted(() => ({
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockHoldBinding: vi.fn().mockResolvedValue(undefined),
  mockReleaseBinding: vi.fn().mockResolvedValue(undefined),
}));
```

Update the `ConnectionStateAwareAction` mock class to use these:

```typescript
    tapBinding = mockTapBinding;
    holdBinding = mockHoldBinding;
    releaseBinding = mockReleaseBinding;
```

- [ ] **Step 2: Add subscription lifecycle tests**

Add a new describe block:

```typescript
  describe("enter-exit-tow telemetry subscription", () => {
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should subscribe to telemetry on willAppear for enter-exit-tow", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(action.sdkController.subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
    });

    it("should not subscribe to telemetry for non-enter-exit-tow controls", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(action.sdkController.subscribe).not.toHaveBeenCalled();
    });

    it("should unsubscribe on willDisappear when subscribed", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(action.sdkController.unsubscribe).toHaveBeenCalledWith("action-1");
    });

    it("should not unsubscribe on willDisappear for non-enter-exit-tow controls", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "toggle-wipers" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(action.sdkController.unsubscribe).not.toHaveBeenCalled();
    });

    it("should subscribe when switching to enter-exit-tow via settings change", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "toggle-wipers" }) as any);
      await action.onDidReceiveSettings(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(action.sdkController.subscribe).toHaveBeenCalledWith("action-1", expect.any(Function));
    });

    it("should unsubscribe when switching away from enter-exit-tow via settings change", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);
      await action.onDidReceiveSettings(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(action.sdkController.unsubscribe).toHaveBeenCalledWith("action-1");
    });
  });
```

- [ ] **Step 3: Add hold/release behavior tests**

Add a new describe block:

```typescript
  describe("enter-exit-tow hold/release behavior", () => {
    let action: CockpitMisc;

    beforeEach(() => {
      action = new CockpitMisc();
    });

    it("should use holdBinding on keyDown for enter-exit-tow", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "cockpitMiscEnterExitTow");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });

    it("should use releaseBinding on keyUp for enter-exit-tow", async () => {
      await action.onKeyUp(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should still use tapBinding on keyDown for non-enter-exit-tow controls", async () => {
      await action.onKeyDown(fakeEvent("action-1", { control: "toggle-wipers" }) as any);

      expect(mockTapBinding).toHaveBeenCalledWith("cockpitMiscToggleWipers");
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should release binding on willDisappear for enter-exit-tow", async () => {
      await action.onWillAppear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);
      await action.onWillDisappear(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockReleaseBinding).toHaveBeenCalledWith("action-1");
    });

    it("should ignore dial rotation for enter-exit-tow", async () => {
      await action.onDialRotate(
        fakeDialRotateEvent("action-1", { control: "enter-exit-tow" }, 1) as any,
      );

      expect(mockTapBinding).not.toHaveBeenCalled();
      expect(mockHoldBinding).not.toHaveBeenCalled();
    });

    it("should use holdBinding on dialDown for enter-exit-tow", async () => {
      await action.onDialDown(fakeEvent("action-1", { control: "enter-exit-tow" }) as any);

      expect(mockHoldBinding).toHaveBeenCalledWith("action-1", "cockpitMiscEnterExitTow");
      expect(mockTapBinding).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 4: Update global keys count test**

Update the test at line 167–169:

```typescript
    it("should have exactly 11 entries", () => {
      expect(Object.keys(COCKPIT_MISC_GLOBAL_KEYS)).toHaveLength(11);
    });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run packages/actions/src/actions/cockpit-misc.test.ts`

Expected: FAIL — `onKeyUp` and `onWillDisappear` don't exist or don't have the expected behavior yet. Hold/release not implemented.

- [ ] **Step 6: Commit failing tests**

```bash
git add packages/actions/src/actions/cockpit-misc.test.ts
git commit -m "test(actions): add failing tests for enter-exit-tow subscription and hold/release (#193)"
```

---

### Task 7: Implement telemetry subscription, hold/release, and lifecycle management

**Files:**
- Modify: `packages/actions/src/actions/cockpit-misc.ts`

This is the main action class modification. The `CockpitMisc` class needs:
- New imports for `IDeckKeyUpEvent` and `IDeckWillDisappearEvent`
- Per-context tracking maps
- Conditional telemetry subscription
- Hold/release branching in key handlers
- `onKeyUp` and `onWillDisappear` overrides

- [ ] **Step 1: Add missing event type imports**

Update the deck-core import block to include the new event types:

```typescript
import {
  CommonSettings,
  ConnectionStateAwareAction,
  getGlobalColors,
  type IDeckDialDownEvent,
  type IDeckDialRotateEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckKeyUpEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveIconColors,
  svgToDataUri,
} from "@iracedeck/deck-core";
```

- [ ] **Step 2: Add per-context tracking maps and helper**

Add as class properties at the top of the `CockpitMisc` class:

```typescript
export class CockpitMisc extends ConnectionStateAwareAction<CockpitMiscSettings> {
  private subscribedContexts = new Set<string>();
  private activeContextSettings = new Map<string, CockpitMiscSettings>();
  private lastTelemetryState = new Map<string, EnterExitTowState>();
```

- [ ] **Step 3: Rewrite `onWillAppear` with conditional subscription**

```typescript
  override async onWillAppear(ev: IDeckWillAppearEvent<CockpitMiscSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.control, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    this.activeContextSettings.set(ev.action.id, settings);

    if (settings.control === "enter-exit-tow") {
      this.subscribeToTelemetry(ev.action.id);
    }

    await this.updateDisplay(ev, settings);
  }
```

- [ ] **Step 4: Rewrite `onDidReceiveSettings` with subscription management**

```typescript
  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<CockpitMiscSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    const activeKey = this.resolveGlobalKey(settings.control, settings.direction);

    if (activeKey) {
      this.setActiveBinding(activeKey);
    }

    const prevSettings = this.activeContextSettings.get(ev.action.id);
    this.activeContextSettings.set(ev.action.id, settings);

    // Manage subscription transitions
    if (settings.control === "enter-exit-tow" && !this.subscribedContexts.has(ev.action.id)) {
      this.subscribeToTelemetry(ev.action.id);
    } else if (settings.control !== "enter-exit-tow" && this.subscribedContexts.has(ev.action.id)) {
      this.unsubscribeFromTelemetry(ev.action.id);
    }

    await this.updateDisplay(ev, settings);
  }
```

- [ ] **Step 5: Rewrite `onKeyDown` with hold/tap branching**

```typescript
  override async onKeyDown(ev: IDeckKeyDownEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Key down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "enter-exit-tow") {
      const settingKey = COCKPIT_MISC_GLOBAL_KEYS["enter-exit-tow"];
      await this.holdBinding(ev.action.id, settingKey);
      return;
    }

    await this.executeControl(settings.control, settings.direction);
  }
```

- [ ] **Step 6: Add `onKeyUp` override**

```typescript
  override async onKeyUp(ev: IDeckKeyUpEvent<CockpitMiscSettings>): Promise<void> {
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "enter-exit-tow") {
      await this.releaseBinding(ev.action.id);
    }
  }
```

- [ ] **Step 7: Rewrite `onDialDown` with hold/tap branching**

```typescript
  override async onDialDown(ev: IDeckDialDownEvent<CockpitMiscSettings>): Promise<void> {
    this.logger.info("Dial down received");
    const settings = this.parseSettings(ev.payload.settings);

    if (settings.control === "enter-exit-tow") {
      const settingKey = COCKPIT_MISC_GLOBAL_KEYS["enter-exit-tow"];
      await this.holdBinding(ev.action.id, settingKey);
      return;
    }

    await this.executeControl(settings.control, settings.direction);
  }
```

- [ ] **Step 8: Add `onWillDisappear` override**

```typescript
  override async onWillDisappear(ev: IDeckWillDisappearEvent<CockpitMiscSettings>): Promise<void> {
    const contextId = ev.action.id;

    if (this.subscribedContexts.has(contextId)) {
      await this.releaseBinding(contextId);
      this.unsubscribeFromTelemetry(contextId);
    }

    this.activeContextSettings.delete(contextId);
    this.lastTelemetryState.delete(contextId);

    await super.onWillDisappear(ev);
  }
```

- [ ] **Step 9: Add private telemetry subscription helpers**

```typescript
  private subscribeToTelemetry(contextId: string): void {
    this.subscribedContexts.add(contextId);
    this.sdkController.subscribe(contextId, (telemetry) => {
      this.updateDisplayFromTelemetry(contextId, telemetry);
    });
  }

  private unsubscribeFromTelemetry(contextId: string): void {
    this.subscribedContexts.delete(contextId);
    this.sdkController.unsubscribe(contextId);
    this.lastTelemetryState.delete(contextId);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
  ): Promise<void> {
    const settings = this.activeContextSettings.get(contextId);
    if (!settings || settings.control !== "enter-exit-tow") return;

    const sessionInfo = this.sdkController.getSessionInfo();
    const state = getEnterExitTowState(telemetry, sessionInfo);
    const lastState = this.lastTelemetryState.get(contextId);

    if (state === lastState) return;

    this.lastTelemetryState.set(contextId, state);
    this.logger.info("Enter/Exit/Tow state changed");
    this.logger.debug(`New state: ${state}`);

    const svgDataUri = generateEnterExitTowSvg(state, settings.colorOverrides);
    await this.updateKeyImage(contextId, svgDataUri);
    this.setRegenerateCallback(contextId, () => {
      const currentTelemetry = this.sdkController.getCurrentTelemetry();
      const currentSessionInfo = this.sdkController.getSessionInfo();
      const currentState = getEnterExitTowState(currentTelemetry, currentSessionInfo);
      return generateEnterExitTowSvg(currentState, settings.colorOverrides);
    });
  }
```

- [ ] **Step 10: Update `updateDisplay` to handle enter-exit-tow**

```typescript
  private async updateDisplay(
    ev: IDeckWillAppearEvent<CockpitMiscSettings> | IDeckDidReceiveSettingsEvent<CockpitMiscSettings>,
    settings: CockpitMiscSettings,
  ): Promise<void> {
    if (settings.control === "enter-exit-tow") {
      const telemetry = this.sdkController.getCurrentTelemetry();
      const sessionInfo = this.sdkController.getSessionInfo();
      const state = getEnterExitTowState(telemetry, sessionInfo);
      this.lastTelemetryState.set(ev.action.id, state);

      const svgDataUri = generateEnterExitTowSvg(state, settings.colorOverrides);
      await ev.action.setTitle("");
      await this.setKeyImage(ev, svgDataUri);
      this.setRegenerateCallback(ev.action.id, () => {
        const currentTelemetry = this.sdkController.getCurrentTelemetry();
        const currentSessionInfo = this.sdkController.getSessionInfo();
        const currentState = getEnterExitTowState(currentTelemetry, currentSessionInfo);
        return generateEnterExitTowSvg(currentState, settings.colorOverrides);
      });
      return;
    }

    const svgDataUri = generateCockpitMiscSvg(settings);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateCockpitMiscSvg(settings));
  }
```

- [ ] **Step 11: Add `getSessionInfo` to the mock sdkController in the test file**

In `cockpit-misc.test.ts`, update the `sdkController` in the mock `ConnectionStateAwareAction` class:

```typescript
    sdkController = { subscribe: vi.fn(), unsubscribe: vi.fn(), getCurrentTelemetry: vi.fn(), getSessionInfo: vi.fn(() => null) };
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `npx vitest run packages/actions/src/actions/cockpit-misc.test.ts`

Expected: All tests PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/actions/src/actions/cockpit-misc.ts packages/actions/src/actions/cockpit-misc.test.ts
git commit -m "feat(actions): implement enter-exit-tow telemetry subscription and hold/release (#193)"
```

---

### Task 8: Update PI template and key bindings

**Files:**
- Modify: `packages/stream-deck-plugin/src/pi/cockpit-misc.ejs`
- Modify: `packages/stream-deck-plugin/src/pi/data/key-bindings.json`

- [ ] **Step 1: Add `enter-exit-tow` option to the control dropdown**

In `cockpit-misc.ejs`, add a new option to the `<sdpi-select>` control dropdown, after the `in-lap-mode` option:

```html
        <option value="enter-exit-tow">Enter / Exit / Tow Car</option>
```

- [ ] **Step 2: Add key binding entry to `key-bindings.json`**

In the `cockpitMisc` array, add:

```json
    {
      "id": "enterExitTow",
      "label": "Enter / Exit / Tow Car",
      "default": "Shift+R",
      "setting": "cockpitMiscEnterExitTow"
    }
```

- [ ] **Step 3: Build PI templates to verify**

Run:
```bash
cd packages/stream-deck-plugin && pnpm build
```

Expected: Build succeeds, `ui/cockpit-misc.html` contains the new option and key binding.

- [ ] **Step 4: Commit**

```bash
git add packages/stream-deck-plugin/src/pi/cockpit-misc.ejs packages/stream-deck-plugin/src/pi/data/key-bindings.json
git commit -m "feat(pi): add Enter / Exit / Tow Car to cockpit-misc PI (#193)"
```

---

### Task 9: Update manifest and Mirabox plugin

**Files:**
- Modify: `packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json`
- Check: `packages/mirabox-plugin/` for cockpit-misc registration

- [ ] **Step 1: Update manifest tooltip**

In `manifest.json`, update the cockpit-misc action tooltip:

```json
"Tooltip": "Miscellaneous cockpit controls (toggle/trigger wipers, FFB, latency, dash pages, in-lap mode, enter/exit/tow)"
```

- [ ] **Step 2: Check if Mirabox plugin registers cockpit-misc**

Search for cockpit-misc registration in the Mirabox plugin. If registered, verify the key bindings JSON there also has the new entry. If the Mirabox plugin has its own `key-bindings.json`, add the same entry.

Run: `grep -r "cockpit-misc\|COCKPIT_MISC" packages/mirabox-plugin/`

If it registers cockpit-misc, update its `key-bindings.json` and PI template to match the stream-deck-plugin changes.

- [ ] **Step 3: Commit**

```bash
git add packages/stream-deck-plugin/com.iracedeck.sd.core.sdPlugin/manifest.json
# Also add mirabox-plugin files if updated
git commit -m "chore(plugin): update cockpit-misc manifest tooltip for enter/exit/tow (#193)"
```

---

### Task 10: Update documentation and skills

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/cockpit/cockpit-misc.md`

- [ ] **Step 1: Update cockpit-misc action documentation**

Update the frontmatter badge and content:

```markdown
---
title: Cockpit Misc
description: Miscellaneous cockpit controls including wipers, FFB, latency, dash pages, and enter/exit/tow
sidebar:
  badge:
    text: "11 modes"
    variant: tip
---

The Cockpit Misc action groups together various cockpit controls that don't fit neatly into other categories. Manage wipers, force feedback, latency reporting, dashboard pages, in-lap mode, and car entry/exit/tow.

## Modes

| Mode | Description |
|------|-------------|
| Toggle Wipers | Toggles the windshield wipers on or off. |
| Trigger Wipers | Triggers a single wiper sweep. |
| FFB Max Force Up | Increases the force feedback maximum force. |
| FFB Max Force Down | Decreases the force feedback maximum force. |
| Report Latency | Reports the current network latency. |
| Dash Page 1 Next | Cycles to the next page on dashboard display 1. |
| Dash Page 1 Previous | Cycles to the previous page on dashboard display 1. |
| Dash Page 2 Next | Cycles to the next page on dashboard display 2. |
| Dash Page 2 Previous | Cycles to the previous page on dashboard display 2. |
| In-Lap Mode | Toggles in-lap mode. |
| Enter / Exit / Tow Car | Context-aware car entry, exit, pit reset, or tow. Icon updates dynamically based on telemetry. |

### Enter / Exit / Tow Car States

The Enter / Exit / Tow Car mode dynamically changes its icon based on your current state in iRacing:

| State | Condition | Icon |
|-------|-----------|------|
| Enter Car | Out of car (replay/spectator) | Car with inward arrow |
| Exit Car | In the pits | Car with outward arrow |
| Reset to Pits | On track, non-race session | Car with reset arrow |
| Tow | On track, race session | Tow hook |

This mode uses a long-press pattern — hold the button to confirm the action.

## Keyboard Simulation

| Action | Default Key | iRacing Setting |
|--------|-------------|-----------------|
| Enter / Exit / Tow Car | Shift+R | Enter/Exit/Tow Car |

## Encoder Support

Yes.
```

- [ ] **Step 2: Update the iracedeck-actions skill**

Invoke the `iracedeck-actions` skill to update the cockpit-misc mode listings (add `enter-exit-tow` with its sub-actions/states).

- [ ] **Step 3: Commit**

```bash
git add packages/website/src/content/docs/docs/actions/cockpit/cockpit-misc.md
git commit -m "docs(website): document Enter / Exit / Tow Car cockpit-misc mode (#193)"
```

---

### Task 11: Full build and test verification

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `pnpm test`

Expected: All tests pass.

- [ ] **Step 2: Run full build**

Run: `pnpm build`

Expected: Build succeeds with no errors.

- [ ] **Step 3: Run lint and format**

Run: `pnpm lint:fix && pnpm format:fix`

Expected: No errors. Any auto-fixes applied.

- [ ] **Step 4: Generate icon previews (final check)**

Run: `node scripts/generate-icon-previews.mjs`

Expected: Previews up to date.

- [ ] **Step 5: Commit any lint/format fixes**

If lint or format made changes:

```bash
git add -A
git commit -m "chore: lint and format fixes (#193)"
```
