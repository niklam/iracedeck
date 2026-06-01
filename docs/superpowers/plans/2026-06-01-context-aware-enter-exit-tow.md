# Context-Aware Enter/Exit/Tow Button Implementation Plan (#632)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Car Control action's Enter/Exit/Tow mode shows session-aware color/icon/label when out of the car (Test/Practice/Qualify/Grid/Race, mirroring iRacing's UI button) and a red background for all in-car states.

**Architecture:** A new pure function `getSessionContext()` classifies the session (test/practice/qualify/grid/race/unknown) from session-info YAML + the `SessionState` telemetry enum. `generateCarControlSvg()`'s enter-exit-tow branch picks icon/label/background per context for the enter-car state and forces a red background for in-car states. Three new icon SVGs (lightning, car, flag) join `packages/icons/car-control/`. The semantic background is applied by overriding `backgroundColor` after `resolveIconColors()` (state-driven, never user-colorizable — same principle as toggle border state colors).

**Tech Stack:** TypeScript, Zod, Vitest, SVG (Tiny 1.2-safe), pnpm + turbo monorepo.

**Issue:** https://github.com/niklam/iracedeck/issues/632

**Worktree:** `C:\Users\Niklas\Projects\iRaceDeck\ir-632`, branch `feature/632-context-aware-enter-exit-tow`

---

## Key facts for implementers (read first)

- **Action file:** `packages/iracing-actions/src/actions/car-control/car-control.ts` (~893 lines). Test file: `car-control.test.ts` (sibling).
- **Existing state detection:** `getEnterExitTowState(telemetry, sessionInfo)` at line ~240 returns `"enter-car" | "exit-car" | "reset-to-pits" | "tow"`.
- **Existing icon branch:** `generateCarControlSvg()` line ~414, `control === "enter-exit-tow"` branch uses `assembleIcon({ graphicSvg, colors, title, border, graphic, bindingMissing })`.
- **Color resolution:** `resolveIconColors(svg, getGlobalColors(), settings.colorOverrides)` returns `Record<string, string>` (keys: `backgroundColor`, `textColor`, `graphic1Color`). Spreading and overriding `backgroundColor` AFTER this call makes the semantic color win over user/global presets.
- **Title resolution:** `resolveTitleSettings(svg, global, overrides, actionDefaultText)` — `actionDefaultText` (4th param) beats the icon `<desc>` title text but loses to per-action user overrides. The dynamic labels (TEST/PRACTICE/...) go through this param.
- **`SessionState` enum** is exported from `@iracedeck/iracing-sdk`: `Invalid=0, GetInCar=1, Warmup=2, ParadeLaps=3, Racing=4, Checkered=5, CoolDown=6`.
- **Tests run with:** `pnpm --filter @iracedeck/iracing-actions test` (or `pnpm test` at root, ~7s for everything). Build with `pnpm build` at root.
- **Build verification rule:** review FULL build output for `TS[0-9]+:` patterns — the build can exit 0 while emitting real type errors as warnings. (`.claude/rules/build-and-commit.md`)
- **Preview freshness:** a Vitest test fails if `packages/icons/preview/` is stale. After adding/changing icon SVGs run `node scripts/generate-icon-previews.mjs` AND `node scripts/generate-icon-defaults.mjs` from the repo root.
- **Conventions:** Conventional Commits with scope = package name, issue ref `(#632)` at end of subject. No AI references/co-authors in commit messages. All code comments in the existing style (sentence-case, explain *why*).

---

### Task 1: New session-context icon SVGs

**Files:**
- Create: `packages/icons/car-control/enter-car-qualify.svg`
- Create: `packages/icons/car-control/enter-car-grid.svg`
- Create: `packages/icons/car-control/enter-car-race.svg`
- Regenerate: `packages/icons/preview/**` (script), `packages/iracing-actions/src/actions/data/icon-defaults.json` (script)

The three icons follow the existing graphic-snippet format (see `packages/icons/car-control/enter-car.svg` for reference): trimmed viewBox, artwork only, `{{graphic1Color}}` placeholder, `<desc>` JSON metadata, no background rect, no `<style>`/filters/clipPath (SVG Tiny 1.2-safe per `.claude/rules/svg-platform-compatibility.md`).

- [ ] **Step 1: Create `enter-car-qualify.svg` (lightning bolt)**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 80" stroke-width="0.5" stroke="#fff" fill="#fff">
  <desc>{"colors":{"backgroundColor":"#9013f5","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"QUALIFY\n"},"border":{"color":"#5a5a6a"}}</desc>


    <polygon points="30,0 2,46 19,46 13,80 48,30 26,30" fill="{{graphic1Color}}" stroke="none"/>


</svg>
```

- [ ] **Step 2: Create `enter-car-grid.svg` (car silhouette)**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 42" stroke-width="0.5" stroke="#fff" fill="#fff">
  <desc>{"colors":{"backgroundColor":"#0fa30f","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"GRID\n"},"border":{"color":"#5a5a6a"}}</desc>


    <path d="M14,28 C8,28 2,26 2,22 L2,18 C2,14 6,12 14,11 L30,9 C34,4 40,1 48,1 L58,1 C66,1 72,4 76,9 L84,11 C90,12 94,15 94,20 L94,24 C94,27 90,28 84,28 L77,28 C77,22 72,17 66,17 C60,17 55,22 55,28 L39,28 C39,22 34,17 28,17 C22,17 17,22 17,28 Z" fill="{{graphic1Color}}" stroke="none"/>
    <circle cx="28" cy="31" r="9" fill="{{graphic1Color}}" stroke="none"/>
    <circle cx="66" cy="31" r="9" fill="{{graphic1Color}}" stroke="none"/>


</svg>
```

- [ ] **Step 3: Create `enter-car-race.svg` (waving flag)**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 80" stroke-width="0.5" stroke="#fff" fill="#fff">
  <desc>{"colors":{"backgroundColor":"#0fa30f","textColor":"#ffffff","graphic1Color":"#ffffff"},"title":{"text":"RACE\n"},"border":{"color":"#5a5a6a"}}</desc>


    <rect x="2" y="0" width="6" height="80" rx="3" fill="{{graphic1Color}}" stroke="none"/>
    <path d="M12,4 C20,-1 30,-1 38,3 C46,7 54,7 62,3 L62,38 C54,42 46,42 38,38 C30,34 20,34 12,39 Z" fill="{{graphic1Color}}" stroke="none"/>


</svg>
```

- [ ] **Step 4: Regenerate previews and icon defaults**

Run from repo root (worktree root):

```bash
node scripts/generate-icon-previews.mjs
node scripts/generate-icon-defaults.mjs
```

Expected: new files appear under `packages/icons/preview/car-control/` for the three new SVGs. `icon-defaults.json` may or may not change (it is keyed per action template) — commit whatever the scripts produce.

- [ ] **Step 5: Run the icons tests (preview freshness)**

```bash
pnpm test 2>&1 | tail -20
```

Expected: PASS (the freshness test sees regenerated previews).

- [ ] **Step 6: Commit**

```bash
git add packages/icons/car-control/ packages/icons/preview/ packages/iracing-actions/src/actions/data/icon-defaults.json
git commit -m "feat(icons): add session-context icons for Enter/Exit/Tow (#632)"
```

(Drop `icon-defaults.json` from the `git add` if the script left it unchanged.)

---

### Task 2: Session context detection — `getSessionContext()`

**Files:**
- Modify: `packages/iracing-actions/src/actions/car-control/car-control.ts`
- Test: `packages/iracing-actions/src/actions/car-control/car-control.test.ts`

TDD: tests first, watch them fail, implement, watch them pass.

- [ ] **Step 1: Update the `@iracedeck/iracing-sdk` mock in the test file**

In `car-control.test.ts`, the existing mock at ~line 61 is:

```typescript
vi.mock("@iracedeck/iracing-sdk", () => ({
  hasFlag: (value: number, flag: number) => (value & flag) !== 0,
  EngineWarnings: { PitSpeedLimiter: 0x0010 },
}));
```

Replace it with:

```typescript
vi.mock("@iracedeck/iracing-sdk", () => ({
  hasFlag: (value: number, flag: number) => (value & flag) !== 0,
  EngineWarnings: { PitSpeedLimiter: 0x0010 },
  SessionState: { Invalid: 0, GetInCar: 1, Warmup: 2, ParadeLaps: 3, Racing: 4, Checkered: 5, CoolDown: 6 },
}));
```

- [ ] **Step 2: Write failing tests for `getSessionContext`**

Add to `car-control.test.ts` (after the existing `describe("getEnterExitTowState", ...)` block, ~line 742). Also add `getSessionContext` to the import list from `./car-control.js` at the top of the file.

```typescript
  describe("getSessionContext", () => {
    function sessionInfoWith(sessionType: string, sessionNum = 0) {
      return {
        SessionInfo: {
          Sessions: [{ SessionNum: sessionNum, SessionType: sessionType }],
        },
      };
    }

    it("should return unknown when telemetry and session info are null", () => {
      expect(getSessionContext(null, null)).toBe("unknown");
    });

    it("should return unknown when session info has no matching session", () => {
      expect(getSessionContext({ SessionNum: 5 } as any, sessionInfoWith("Race", 0))).toBe("unknown");
    });

    it("should return test for Offline Testing session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Offline Testing"))).toBe("test");
    });

    it("should return practice for Practice session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Practice"))).toBe("practice");
    });

    it("should return practice for Lone Practice session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Lone Practice"))).toBe("practice");
    });

    it("should return qualify for Lone Qualify session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Lone Qualify"))).toBe("qualify");
    });

    it("should return qualify for Open Qualify session", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Open Qualify"))).toBe("qualify");
    });

    it("should return grid for Race session before start (GetInCar)", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 1 } as any, sessionInfoWith("Race"))).toBe("grid");
    });

    it("should return grid for Race session during warmup", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 2 } as any, sessionInfoWith("Race"))).toBe("grid");
    });

    it("should return grid for Race session during parade laps", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 3 } as any, sessionInfoWith("Race"))).toBe("grid");
    });

    it("should return race for Race session when racing", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 4 } as any, sessionInfoWith("Race"))).toBe("race");
    });

    it("should return race for Race session after checkered", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 5 } as any, sessionInfoWith("Race"))).toBe("race");
    });

    it("should return race for Race session during cooldown", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 6 } as any, sessionInfoWith("Race"))).toBe("race");
    });

    it("should return grid for Race session when SessionState is missing", () => {
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfoWith("Race"))).toBe("grid");
    });

    it("should treat Warmup session type as a race-like session", () => {
      expect(getSessionContext({ SessionNum: 0, SessionState: 4 } as any, sessionInfoWith("Warmup"))).toBe("race");
    });

    it("should pick the session matching SessionNum from multiple sessions", () => {
      const sessionInfo = {
        SessionInfo: {
          Sessions: [
            { SessionNum: 0, SessionType: "Practice" },
            { SessionNum: 1, SessionType: "Lone Qualify" },
            { SessionNum: 2, SessionType: "Race" },
          ],
        },
      };
      expect(getSessionContext({ SessionNum: 1 } as any, sessionInfo)).toBe("qualify");
      expect(getSessionContext({ SessionNum: 0 } as any, sessionInfo)).toBe("practice");
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm --filter @iracedeck/iracing-actions test 2>&1 | tail -30
```

Expected: FAIL — `getSessionContext` is not exported.

- [ ] **Step 4: Implement `SessionContext` + `getSessionContext` in `car-control.ts`**

4a. Add `SessionState` to the existing `@iracedeck/iracing-sdk` import (line ~40):

```typescript
import { EngineWarnings, hasFlag, SessionState, type TelemetryData } from "@iracedeck/iracing-sdk";
```

4b. Add after the existing color constants (line ~52, after `const BLUE = "#3498db";`):

```typescript
/**
 * Semantic background colors for the context-aware Enter/Exit/Tow mode (issue #632).
 * State-driven — never overridable by user color presets, mirroring iRacing's own UI button.
 */
const SESSION_BG_GREEN = "#0fa30f";
const SESSION_BG_BLUE = "#1f5fd6";
const SESSION_BG_PURPLE = "#9013f5";
const IN_CAR_BG_RED = "#ff0000";
```

4c. Add after `getEnterExitTowState()` (line ~265, after its closing brace):

```typescript
/** @internal Exported for testing */
export type SessionContext = "test" | "practice" | "qualify" | "grid" | "race" | "unknown";

/**
 * @internal Exported for testing
 *
 * Classifies the current session for the context-aware enter-car appearance (issue #632).
 * Mirrors iRacing's own UI button: Test / Practice / Qualify / Grid (race not yet started) /
 * Race (racing, checkered, cooldown). Returns "unknown" when session info is unavailable so
 * callers can fall back to the legacy neutral appearance.
 */
export function getSessionContext(
  telemetry: TelemetryData | null,
  sessionInfo: Record<string, unknown> | null,
): SessionContext {
  const sessionNum = telemetry?.SessionNum ?? 0;
  const sessions = (sessionInfo?.SessionInfo as Record<string, unknown> | undefined)?.Sessions as
    | Array<Record<string, unknown>>
    | undefined;
  const currentSession = sessions?.find((s) => s.SessionNum === sessionNum);
  const sessionType = currentSession?.SessionType as string | undefined;

  if (!sessionType) {
    return "unknown";
  }

  if (sessionType.includes("Testing")) {
    return "test";
  }

  if (sessionType.includes("Practice")) {
    return "practice";
  }

  if (sessionType.includes("Qualify")) {
    return "qualify";
  }

  // Race-like session (Race / Warmup / Heat): split on SessionState — gridding,
  // warmup, and parade laps count as "grid"; racing and beyond count as "race".
  const state = telemetry?.SessionState;

  if (state !== undefined && state >= SessionState.Racing) {
    return "race";
  }

  return "grid";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @iracedeck/iracing-actions test 2>&1 | tail -30
```

Expected: PASS (all new `getSessionContext` tests + all existing tests).

- [ ] **Step 6: Commit**

```bash
git add packages/iracing-actions/src/actions/car-control/
git commit -m "feat(actions): add session context detection for Enter/Exit/Tow (#632)"
```

---

### Task 3: Context-aware icon rendering

**Files:**
- Modify: `packages/iracing-actions/src/actions/car-control/car-control.ts`
- Test: `packages/iracing-actions/src/actions/car-control/car-control.test.ts`

Depends on: Task 1 (icon files must exist for the imports to resolve at build time) and Task 2 (`SessionContext` type). Tests still run before Task 1's files exist because the test file mocks all SVG imports.

- [ ] **Step 1: Update test mocks in `car-control.test.ts`**

1a. Add SVG mocks for the three new icons (next to the existing `enter-car.svg` mock, ~line 48):

```typescript
vi.mock("@iracedeck/icons/car-control/enter-car-qualify.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">enter-car-qualify</svg>',
}));
vi.mock("@iracedeck/icons/car-control/enter-car-grid.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">enter-car-grid</svg>',
}));
vi.mock("@iracedeck/icons/car-control/enter-car-race.svg", () => ({
  default: '<svg xmlns="http://www.w3.org/2000/svg">enter-car-race</svg>',
}));
```

1b. Replace the `assembleIcon` mock (inside the `vi.mock("@iracedeck/deck-core", ...)` factory, ~line 151) so tests can assert on the background color:

```typescript
  assembleIcon: vi.fn(
    ({
      graphicSvg,
      colors,
      title,
    }: {
      graphicSvg: string;
      colors: Record<string, string>;
      title: { titleText: string };
    }) => {
      const bg = colors?.backgroundColor ? ` bg="${colors.backgroundColor}"` : "";
      const encoded = encodeURIComponent(`<svg${bg}>${graphicSvg}${title?.titleText ?? ""}</svg>`);

      return `data:image/svg+xml,${encoded}`;
    },
  ),
```

- [ ] **Step 2: Write failing tests**

Add to `car-control.test.ts` after the existing `describe("generateCarControlSvg enter-exit-tow states", ...)` block (~line 801):

```typescript
  describe("generateCarControlSvg session-context appearance (issue #632)", () => {
    it("should render green background, steering wheel, and TEST label for test context", () => {
      const result = generateCarControlSvg(
        { control: "enter-exit-tow" },
        { enterExitTowState: "enter-car", sessionContext: "test" },
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#0fa30f"');
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("TEST");
    });

    it("should render blue background, steering wheel, and PRACTICE label for practice context", () => {
      const result = generateCarControlSvg(
        { control: "enter-exit-tow" },
        { enterExitTowState: "enter-car", sessionContext: "practice" },
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#1f5fd6"');
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("PRACTICE");
    });

    it("should render purple background, lightning icon, and QUALIFY label for qualify context", () => {
      const result = generateCarControlSvg(
        { control: "enter-exit-tow" },
        { enterExitTowState: "enter-car", sessionContext: "qualify" },
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#9013f5"');
      expect(decoded).toContain("enter-car-qualify");
      expect(decoded).toContain("QUALIFY");
    });

    it("should render green background, car icon, and GRID label for grid context", () => {
      const result = generateCarControlSvg(
        { control: "enter-exit-tow" },
        { enterExitTowState: "enter-car", sessionContext: "grid" },
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#0fa30f"');
      expect(decoded).toContain("enter-car-grid");
      expect(decoded).toContain("GRID");
    });

    it("should render green background, flag icon, and RACE label for race context", () => {
      const result = generateCarControlSvg(
        { control: "enter-exit-tow" },
        { enterExitTowState: "enter-car", sessionContext: "race" },
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#0fa30f"');
      expect(decoded).toContain("enter-car-race");
      expect(decoded).toContain("RACE");
    });

    it("should keep the legacy DRIVE appearance for unknown context", () => {
      const result = generateCarControlSvg(
        { control: "enter-exit-tow" },
        { enterExitTowState: "enter-car", sessionContext: "unknown" },
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).not.toContain("bg=");
      expect(decoded).toContain("enter-car");
      expect(decoded).toContain("DRIVE");
    });

    it("should keep the legacy DRIVE appearance when sessionContext is not provided", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "enter-car" });
      const decoded = decodeURIComponent(result);
      expect(decoded).not.toContain("bg=");
      expect(decoded).toContain("DRIVE");
    });

    it("should render red background for exit-car state", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "exit-car" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).toContain("exit-car");
      expect(decoded).toContain("EXIT");
    });

    it("should render red background for reset-to-pits state", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "reset-to-pits" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).toContain("reset-to-pits");
      expect(decoded).toContain("RESET");
    });

    it("should render red background for tow state", () => {
      const result = generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "tow" });
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).toContain("tow");
      expect(decoded).toContain("TOW");
    });

    it("should ignore session context for in-car states (red background wins)", () => {
      const result = generateCarControlSvg(
        { control: "enter-exit-tow" },
        { enterExitTowState: "tow", sessionContext: "race" },
      );
      const decoded = decodeURIComponent(result);
      expect(decoded).toContain('bg="#ff0000"');
      expect(decoded).toContain("TOW");
    });

    it("should produce different icons for different session contexts", () => {
      const contexts = ["test", "practice", "qualify", "grid", "race"] as const;
      const results = contexts.map((sessionContext) =>
        generateCarControlSvg({ control: "enter-exit-tow" }, { enterExitTowState: "enter-car", sessionContext }),
      );
      const unique = new Set(results);
      expect(unique.size).toBe(contexts.length);
    });
  });

  describe("session context state key (issue #632)", () => {
    it("should include session context in the state key so context changes re-render", () => {
      const action = new CarControl();
      const settings = { control: "enter-exit-tow" } as any;
      const gridKey = action["buildStateKey"](settings, { enterExitTowState: "enter-car", sessionContext: "grid" });
      const raceKey = action["buildStateKey"](settings, { enterExitTowState: "enter-car", sessionContext: "race" });

      expect(gridKey).not.toBe(raceKey);
    });

    it("should compute sessionContext in getTelemetryState for enter-exit-tow", () => {
      const action = new CarControl();
      (action as any).sdkController.getSessionInfo = vi.fn(() => ({
        SessionInfo: { Sessions: [{ SessionNum: 0, SessionType: "Race" }] },
      }));
      const state = action["getTelemetryState"]({ IsOnTrack: false, SessionNum: 0, SessionState: 4 } as any, "enter-exit-tow");

      expect(state.enterExitTowState).toBe("enter-car");
      expect(state.sessionContext).toBe("race");
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm --filter @iracedeck/iracing-actions test 2>&1 | tail -40
```

Expected: FAIL — `sessionContext` is not a known property of `CarControlTelemetryState`, no semantic backgrounds rendered.

- [ ] **Step 4: Implement in `car-control.ts`**

4a. Add the three icon imports (after the existing `import enterCarIcon ...` line ~30, keeping the import list alphabetical by path):

```typescript
import enterCarGridIcon from "@iracedeck/icons/car-control/enter-car-grid.svg";
import enterCarQualifyIcon from "@iracedeck/icons/car-control/enter-car-qualify.svg";
import enterCarRaceIcon from "@iracedeck/icons/car-control/enter-car-race.svg";
```

(Note: `enter-car-grid` / `enter-car-qualify` / `enter-car-race` sort after `enter-car` and before `escape`.)

4b. Add the per-context maps right after `ENTER_EXIT_TOW_TITLES` (~line 97):

```typescript
/**
 * Per-session-context appearance for the enter-car state (issue #632).
 * "unknown" (no session info) keeps the legacy neutral steering-wheel look.
 */
const SESSION_CONTEXT_ICONS: Record<SessionContext, string> = {
  test: enterCarIcon,
  practice: enterCarIcon,
  qualify: enterCarQualifyIcon,
  grid: enterCarGridIcon,
  race: enterCarRaceIcon,
  unknown: enterCarIcon,
};

const SESSION_CONTEXT_TITLES: Record<SessionContext, string> = {
  test: "TEST",
  practice: "PRACTICE",
  qualify: "QUALIFY",
  grid: "GRID",
  race: "RACE",
  unknown: ENTER_EXIT_TOW_TITLES["enter-car"],
};

/** Background per context; undefined = keep the resolved (user/global/icon) background. */
const SESSION_CONTEXT_BACKGROUNDS: Record<SessionContext, string | undefined> = {
  test: SESSION_BG_GREEN,
  practice: SESSION_BG_BLUE,
  qualify: SESSION_BG_PURPLE,
  grid: SESSION_BG_GREEN,
  race: SESSION_BG_GREEN,
  unknown: undefined,
};
```

NOTE: the maps reference `SessionContext`, the constants from Task 2, and `ENTER_EXIT_TOW_TITLES`. The `SessionContext` type and `getSessionContext` are defined later in the file (after `getEnterExitTowState`) — TypeScript hoists type aliases and `const` declarations are evaluated at module load in order, so place these maps AFTER the constants from Task 2 step 4b but the type reference is fine. If the linter complains about use-before-declaration, move the `SessionContext` type + `getSessionContext` function ABOVE these maps.

4c. Extend `CarControlTelemetryState` (~line 305):

```typescript
export type CarControlTelemetryState = {
  pitLimiterActive?: boolean;
  pitSpeedLimit?: number;
  pushToPassActive?: boolean;
  drsActive?: boolean;
  enterExitTowState?: EnterExitTowState;
  /** Session classification for the context-aware enter-car appearance (issue #632). */
  sessionContext?: SessionContext;
};
```

4d. Replace the `control === "enter-exit-tow"` branch in `generateCarControlSvg()` (~line 414):

```typescript
  // Enter/Exit/Tow uses state-specific standalone SVGs. The enter-car state is
  // session-context-aware (issue #632): icon/label/background mirror iRacing's
  // own UI button. In-car states keep their icons but get a red background.
  if (control === "enter-exit-tow") {
    const towState = telemetryState?.enterExitTowState ?? "enter-car";
    const sessionContext = telemetryState?.sessionContext ?? "unknown";
    const isEnterCar = towState === "enter-car";

    const iconSvg = isEnterCar ? SESSION_CONTEXT_ICONS[sessionContext] : ENTER_EXIT_TOW_ICONS[towState];
    const defaultTitle = isEnterCar ? SESSION_CONTEXT_TITLES[sessionContext] : ENTER_EXIT_TOW_TITLES[towState];
    // State-driven background — wins over user color overrides and global presets,
    // same principle as toggle-action border state colors.
    const stateBackground = isEnterCar ? SESSION_CONTEXT_BACKGROUNDS[sessionContext] : IN_CAR_BG_RED;

    const resolvedColors = resolveIconColors(iconSvg, getGlobalColors(), settings.colorOverrides);
    const colors = stateBackground ? { ...resolvedColors, backgroundColor: stateBackground } : resolvedColors;
    const title = resolveTitleSettings(iconSvg, getGlobalTitleSettings(), settings.titleOverrides, defaultTitle);
    const border = resolveBorderSettings(iconSvg, getGlobalBorderSettings(), settings.borderOverrides);

    const graphic = resolveGraphicSettings(getGlobalGraphicSettings(), settings.graphicOverrides);

    return assembleIcon({ graphicSvg: iconSvg, colors, title, border, graphic, bindingMissing });
  }
```

4e. Extend `getTelemetryState()` (~line 784) — the `enter-exit-tow` else-if branch becomes:

```typescript
    } else if (control === "enter-exit-tow") {
      const sessionInfo = this.sdkController.getSessionInfo();
      state.enterExitTowState = getEnterExitTowState(telemetry, sessionInfo);
      state.sessionContext = getSessionContext(telemetry, sessionInfo);
    }
```

4f. Extend `buildStateKey()` (~line 841) — the `enter-exit-tow` branch becomes:

```typescript
    if (settings.control === "enter-exit-tow") {
      return `enter-exit-tow|${telemetryState.enterExitTowState ?? "enter-car"}|${telemetryState.sessionContext ?? "unknown"}|${borderKey}|${warn}`;
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @iracedeck/iracing-actions test 2>&1 | tail -40
```

Expected: PASS — all new tests and all existing tests (existing enter-exit-tow tests assert label/icon containment only and are unaffected; the `unknown` fallback keeps DRIVE behavior).

- [ ] **Step 6: Commit**

```bash
git add packages/iracing-actions/src/actions/car-control/
git commit -m "feat(actions): context-aware Enter/Exit/Tow icon, label, and background (#632)"
```

---

### Task 4: Documentation updates

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/driving/car-control.md` (Enter/Exit/Tow section, ~lines 135-160)
- Modify: `docs/plugins/core/actions/enter-exit-tow-car.md` (Icon States section)
- Modify: `.claude/skills/iracedeck-actions/SKILL.md` (~line 79, Car Control row)

Independent of Tasks 1-3 (documents the agreed behavior). Keep paragraphs on single lines (no hard wraps inside paragraphs).

- [ ] **Step 1: Update the website doc**

In `packages/website/src/content/docs/docs/actions/driving/car-control.md`, replace the `#### Setting: State icons` section content (the intro line and the four bullets) of the **Enter/Exit/Tow** section with:

```markdown
#### Setting: State icons

Enter/Exit/Tow automatically picks its display state based on live telemetry. There is no setting to override this — it is shown here only to document the mapping:

- **Enter Car** — Out of the car. The button mirrors iRacing's own session button: a green **Test** button (steering wheel) in test sessions, a blue **Practice** button (steering wheel) in practice, a purple **Qualify** button (lightning bolt) in qualifying, a green **Grid** button (car) before a race starts, and a green **Race** button (flag) once the race is underway. When no session information is available the neutral steering-wheel **Drive** icon is shown.
- **Exit Car** — In the pits; the icon shows a car with an outward arrow on a red background
- **Reset to Pits** — On track in a non-race session; the icon shows a reset arrow on a red background
- **Tow** — On track in a race session; the icon shows a tow hook on a red background

The session-state colors and the red in-car background are state-driven and intentionally not affected by color overrides or global color presets.
```

Also update the `- **Telemetry-aware icon:**` line in the same section's `#### Details` block to:

```markdown
- **Telemetry-aware icon:** Yes — out of the car the icon shows the session context (Test / Practice / Qualify / Grid / Race); in the car it switches between Exit Car, Reset to Pits, and Tow on a red background
```

- [ ] **Step 2: Update the legacy action doc**

In `docs/plugins/core/actions/enter-exit-tow-car.md`, replace the `## Icon States` section with:

```markdown
## Icon States

| State | Description |
|-------|-------------|
| Test (out of car, test session) | Steering wheel on green background, "TEST" label |
| Practice (out of car, practice session) | Steering wheel on blue background, "PRACTICE" label |
| Qualify (out of car, qualifying session) | Lightning bolt on purple background, "QUALIFY" label |
| Grid (out of car, race not started) | Car on green background, "GRID" label |
| Race (out of car, race underway) | Flag on green background, "RACE" label |
| Unknown (no session info) | Steering wheel on default background, "DRIVE" label |
| Exit Car (in pit stall) | Exit arrow on red background, "EXIT" label |
| Reset to Pits (on track, non-race) | Reset arrow on red background, "RESET" label |
| Tow (on track, race) | Tow hook on red background, "TOW" label |
```

- [ ] **Step 3: Update the iracedeck-actions skill**

In `.claude/skills/iracedeck-actions/SKILL.md` line ~79, update the Car Control row's `enter-exit-tow` description from:

```text
enter-exit-tow (hold, telemetry-aware, per-state auto-hold options for exit/reset/tow)
```

to:

```text
enter-exit-tow (hold, telemetry-aware, session-context icon/color/label when out of car: Test/Practice/Qualify/Grid/Race, red background in-car, per-state auto-hold options for exit/reset/tow)
```

- [ ] **Step 4: Commit**

```bash
git add packages/website/src/content/docs/docs/actions/driving/car-control.md docs/plugins/core/actions/enter-exit-tow-car.md .claude/skills/iracedeck-actions/SKILL.md
git commit -m "docs: document context-aware Enter/Exit/Tow appearance (#632)"
```

---

### Task 5: Final verification

**Files:** none new — runs checks across the whole worktree.

- [ ] **Step 1: Install + full build (review FULL output)**

```bash
pnpm install
pnpm build 2>&1 | tee /tmp/ir632-build.log
grep -E "TS[0-9]+:" /tmp/ir632-build.log
```

Expected: build succeeds AND the grep finds **nothing** (ignore `Circular dependency` warnings from zod internals and `npm warn Unknown env config`).

- [ ] **Step 2: Full test suite**

```bash
pnpm test 2>&1 | tail -15
```

Expected: all test files pass, 0 failures.

- [ ] **Step 3: Lint + format**

```bash
pnpm lint:fix
pnpm format:fix
git status --short
```

Expected: no lint errors. If lint/format modified files, review the diff and amend them into a final chore commit:

```bash
git add -A
git commit -m "chore: lint and format (#632)"
```

(Skip the commit if nothing changed.)

- [ ] **Step 4: Verify all acceptance criteria from issue #632**

Walk the issue's acceptance criteria against the implementation:

- Test session, out of car → green key, steering wheel icon, "Test" ✓ (Task 3 test)
- Practice → blue key, steering wheel, "Practice" ✓ (Task 3 test)
- Qualify → purple key, lightning bolt, "Qualify" ✓ (Task 3 test)
- Race before start → green key, car icon, "Grid" ✓ (Task 2+3 tests)
- Race after start (incl. checkered/cooldown) → green key, flag icon, "Race" ✓ (Task 2+3 tests)
- In-car states keep icons/labels, red `#ff0000` background ✓ (Task 3 tests)
- Missing-binding ⚠️ overlay still renders ✓ (`bindingMissing` still passed to `assembleIcon`)
- Renders on Elgato (QT6) and Mirabox (QT5) ✓ (new SVGs use only polygon/path/rect/circle — Tiny 1.2-safe)
- Title overrides still work ✓ (labels flow through `resolveTitleSettings` `actionDefaultText`)
- `pnpm build`, `pnpm test`, `pnpm lint` pass ✓ (Steps 1-3)

**STOP after this task.** Do NOT push, do NOT create a PR. The user must manually test in iRacing first (per project workflow).
