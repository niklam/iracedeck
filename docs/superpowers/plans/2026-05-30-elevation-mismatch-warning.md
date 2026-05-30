# Elevation Mismatch Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when iRacing runs at a higher integrity level (Administrator) than the plugin — which makes Windows UIPI silently drop every outbound command — and surface it as a clear, reusable Property Inspector warning banner plus a `WARN` log.

**Architecture:** A Windows-only native probe compares this process's elevation token with iRacing's. A reusable warnings store in `deck-core` writes keyed warning records into a `_warnings` global setting. A new `ird-warnings` PI web component, auto-injected into every PI via `head-common.ejs`, renders those records as banners. Both plugins run the probe once per iRacing connection and post/clear the elevation warning. The probe is purely diagnostic — it never gates or disables the plugin.

**Tech Stack:** C++/N-API (node-gyp), TypeScript, Vitest (+ jsdom for the component), EJS partials, pnpm + turbo monorepo.

**Conventions for every task below:**
- Tests run from the repo root: `pnpm exec vitest run <path>`.
- Commit from the worktree root (`C:/Users/Niklas/Projects/iRaceDeck/ir-610`).
- This is a Windows machine, so the native addon (`@iracedeck/iracing-native`) compiles for real via `pnpm --filter @iracedeck/iracing-native build`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/deck-core/src/pi-warnings.ts` (create) | Reusable warnings store: `setWarning`/`clearWarning` keyed by id, backed by the `_warnings` global setting. |
| `packages/deck-core/src/pi-warnings.test.ts` (create) | Unit tests for the store. |
| `packages/deck-core/src/elevation-warning.ts` (create) | Pure `evaluateElevationWarning(status)` + the shared id/message constants. |
| `packages/deck-core/src/elevation-warning.test.ts` (create) | Unit tests for the decision. |
| `packages/deck-core/src/index.ts` (modify) | Export the new helpers/types. |
| `packages/iracing-native/src/defines.ts` (modify) | Add the `ElevationStatus` type. |
| `packages/iracing-native/src/addon.cc` (modify) | `getElevationStatus()` native impl + `Init()` registration. |
| `packages/iracing-native/src/index.ts` (modify) | `getElevationStatus()` wrapper method. |
| `packages/iracing-native/src/mock-impl.ts` (modify) | Mock `getElevationStatus()` returning no-mismatch. |
| `packages/iracing-native/src/mock-impl.test.ts` (modify) | Test the mock returns no-mismatch. |
| `packages/iracing-native/CLAUDE.md` (modify) | Document the new native function. |
| `packages/pi-components/src/components/warnings.ts` (create) | `<ird-warnings>` web component. |
| `packages/pi-components/src/components/warnings.test.ts` (create) | Component tests (jsdom). |
| `packages/pi-components/src/components/index.ts` (modify) | Export `WarningsBanner`. |
| `packages/pi-components/partials/head-common.ejs` (modify) | Auto-inject `<ird-warnings>` at the top of every PI body. |
| `packages/iracing-plugin-stream-deck/src/plugin.ts` (modify) | Run the probe on connect; post/clear the warning. |
| `packages/iracing-plugin-mirabox/src/plugin.ts` (modify) | Same wiring for parity. |
| `packages/website/src/content/docs/docs/getting-started/troubleshooting.md` (modify) | FAQ entry. |
| `.claude/rules/global-settings.md` (modify) | Document `_warnings` + the warnings helpers. |
| `.claude/rules/keyboard-shortcuts.md` (modify) | Note the detector + elevation-matching guidance. |
| `.claude/rules/stream-deck-actions.md` (modify) | Document the `ird-warnings` auto-injected component. |

---

## Task 1: Reusable PI warnings store (deck-core)

**Files:**
- Create: `packages/deck-core/src/pi-warnings.ts`
- Test: `packages/deck-core/src/pi-warnings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/deck-core/src/pi-warnings.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, updateSpy } = vi.hoisted(() => {
  const store = { current: {} as Record<string, unknown> };
  const updateSpy = vi.fn((partial: Record<string, unknown>) => {
    store.current = { ...store.current, ...partial };
  });
  return { store, updateSpy };
});

vi.mock("./global-settings.js", () => ({
  getGlobalSettings: () => store.current,
  updateGlobalSettings: updateSpy,
}));

import { clearWarning, setWarning } from "./pi-warnings.js";

function warnings(): Array<{ id: string; level: string; message: string }> {
  const raw = store.current._warnings;
  return typeof raw === "string" ? JSON.parse(raw) : [];
}

describe("pi-warnings store", () => {
  beforeEach(() => {
    store.current = {};
    updateSpy.mockClear();
  });

  it("adds a warning record keyed by id", () => {
    setWarning("a", "warning", "msg");
    expect(warnings()).toEqual([{ id: "a", level: "warning", message: "msg" }]);
  });

  it("replaces an existing record with the same id", () => {
    setWarning("a", "warning", "first");
    setWarning("a", "error", "second");
    expect(warnings()).toEqual([{ id: "a", level: "error", message: "second" }]);
  });

  it("keeps records with different ids side by side", () => {
    setWarning("a", "warning", "A");
    setWarning("b", "info", "B");
    expect(warnings().map((w) => w.id).sort()).toEqual(["a", "b"]);
  });

  it("does not write when the record is unchanged", () => {
    setWarning("a", "warning", "msg");
    updateSpy.mockClear();
    setWarning("a", "warning", "msg");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("clears a warning by id", () => {
    setWarning("a", "warning", "A");
    setWarning("b", "info", "B");
    clearWarning("a");
    expect(warnings()).toEqual([{ id: "b", level: "info", message: "B" }]);
  });

  it("clearWarning is a no-op when the id is absent", () => {
    clearWarning("missing");
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("tolerates a malformed _warnings cache", () => {
    store.current._warnings = "{not json";
    setWarning("a", "warning", "msg");
    expect(warnings()).toEqual([{ id: "a", level: "warning", message: "msg" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/deck-core/src/pi-warnings.test.ts`
Expected: FAIL — `Cannot find module './pi-warnings.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/deck-core/src/pi-warnings.ts`:

```ts
/**
 * Reusable Property Inspector warning store (issue #610).
 *
 * Warning records are persisted in the `_warnings` global setting as a JSON
 * array. Each record is keyed by `id` so independent producers (e.g. the
 * elevation-mismatch detector) can post and clear their own banner without
 * clobbering others. The `ird-warnings` PI component renders the array at the
 * top of every Property Inspector.
 */
import { getGlobalSettings, updateGlobalSettings } from "./global-settings.js";

export type PiWarningLevel = "info" | "warning" | "error";

export interface PiWarning {
  id: string;
  level: PiWarningLevel;
  message: string;
}

const WARNINGS_KEY = "_warnings";

function readWarnings(): PiWarning[] {
  const raw = (getGlobalSettings() as Record<string, unknown>)[WARNINGS_KEY];

  if (typeof raw !== "string" || raw === "") return [];

  try {
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? (parsed as PiWarning[]) : [];
  } catch {
    return [];
  }
}

/**
 * Upsert a warning by id. Replaces an existing record with the same id;
 * appends otherwise. Skips the write when an identical record already exists
 * so it never churns global settings on repeated calls.
 */
export function setWarning(id: string, level: PiWarningLevel, message: string): void {
  const list = readWarnings();
  const existing = list.find((w) => w.id === id);

  if (existing && existing.level === level && existing.message === message) return;

  const next = list.filter((w) => w.id !== id);
  next.push({ id, level, message });
  updateGlobalSettings({ [WARNINGS_KEY]: JSON.stringify(next) });
}

/**
 * Remove the warning with the given id. No-op (no write) when absent.
 */
export function clearWarning(id: string): void {
  const list = readWarnings();
  const next = list.filter((w) => w.id !== id);

  if (next.length === list.length) return;

  updateGlobalSettings({ [WARNINGS_KEY]: JSON.stringify(next) });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/deck-core/src/pi-warnings.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/pi-warnings.ts packages/deck-core/src/pi-warnings.test.ts
git commit -m "feat(deck-core): add reusable PI warnings store (#610)"
```

---

## Task 2: Elevation→warning decision (deck-core)

**Files:**
- Create: `packages/deck-core/src/elevation-warning.ts`
- Test: `packages/deck-core/src/elevation-warning.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/deck-core/src/elevation-warning.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { ELEVATION_WARNING_ID, evaluateElevationWarning } from "./elevation-warning.js";

describe("evaluateElevationWarning", () => {
  it("returns a warning record when there is a mismatch", () => {
    const result = evaluateElevationWarning({ mismatch: true });
    expect(result).not.toBeNull();
    expect(result?.id).toBe(ELEVATION_WARNING_ID);
    expect(result?.level).toBe("warning");
    expect(result?.message.length).toBeGreaterThan(0);
  });

  it("returns null when there is no mismatch", () => {
    expect(evaluateElevationWarning({ mismatch: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/deck-core/src/elevation-warning.test.ts`
Expected: FAIL — `Cannot find module './elevation-warning.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/deck-core/src/elevation-warning.ts`:

```ts
/**
 * Maps a native elevation-status probe (issue #610) to a PI warning record.
 *
 * The decision is pure and structurally typed (only `mismatch` is read) so it
 * lives in deck-core without a dependency on `@iracedeck/iracing-native`, and
 * both plugins share the exact same wording.
 *
 * The message intentionally carries NO leading emoji — the `ird-warnings`
 * banner renders a level icon (⚠️) itself, so adding one here would double it.
 */
import type { PiWarning } from "./pi-warnings.js";

export const ELEVATION_WARNING_ID = "elevation-mismatch";

export const ELEVATION_WARNING_MESSAGE =
  "iRacing seems to be running as Administrator while iRaceDeck is not. " +
  "Run Stream Deck as Administrator (or run iRacing without Administrator) so that buttons reach iRacing.";

export function evaluateElevationWarning(status: { mismatch: boolean }): PiWarning | null {
  if (!status.mismatch) return null;

  return { id: ELEVATION_WARNING_ID, level: "warning", message: ELEVATION_WARNING_MESSAGE };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/deck-core/src/elevation-warning.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/deck-core/src/elevation-warning.ts packages/deck-core/src/elevation-warning.test.ts
git commit -m "feat(deck-core): add elevation-mismatch warning decision (#610)"
```

---

## Task 3: Export new helpers from deck-core

**Files:**
- Modify: `packages/deck-core/src/index.ts`

- [ ] **Step 1: Add the exports**

Append after the existing `key-binding-utils` export line (`export { formatKeyBinding, parseKeyBinding, parseBinding } from "./key-binding-utils.js";`):

```ts
export { setWarning, clearWarning, type PiWarning, type PiWarningLevel } from "./pi-warnings.js";
export {
  evaluateElevationWarning,
  ELEVATION_WARNING_ID,
  ELEVATION_WARNING_MESSAGE,
} from "./elevation-warning.js";
```

- [ ] **Step 2: Verify the package builds**

Run: `pnpm --filter @iracedeck/deck-core build`
Expected: succeeds, no TS errors.

- [ ] **Step 3: Commit**

```bash
git add packages/deck-core/src/index.ts
git commit -m "feat(deck-core): export PI warnings and elevation-warning helpers (#610)"
```

---

## Task 4: ElevationStatus type + native wrapper + mock (iracing-native, TS side)

**Files:**
- Modify: `packages/iracing-native/src/defines.ts`
- Modify: `packages/iracing-native/src/index.ts`
- Modify: `packages/iracing-native/src/mock-impl.ts`
- Test: `packages/iracing-native/src/mock-impl.test.ts`

- [ ] **Step 1: Add the `ElevationStatus` type to defines.ts**

Append to `packages/iracing-native/src/defines.ts`:

```ts
/**
 * Result of the Administrator/integrity-level comparison between this process
 * and iRacing (issue #610). All fields are `false` on non-Windows / mock.
 */
export interface ElevationStatus {
  /** This process's token reports an elevated (Administrator) integrity. */
  selfElevated: boolean;
  /** The iRacing simulator window was found. */
  iracingFound: boolean;
  /** OpenProcess on iRacing failed with ERROR_ACCESS_DENIED (higher integrity). */
  iracingQueryDenied: boolean;
  /** iRacing's token reports elevated (only meaningful when the query succeeded). */
  iracingElevated: boolean;
  /** !selfElevated && iracingFound && (iracingQueryDenied || iracingElevated). */
  mismatch: boolean;
}
```

- [ ] **Step 2: Write the failing mock test**

Add to `packages/iracing-native/src/mock-impl.test.ts` (inside the top-level `describe`, or a new `describe`):

```ts
import { IRacingNativeMock } from "./mock-impl.js";

describe("getElevationStatus (mock)", () => {
  it("reports no mismatch", () => {
    const mock = new IRacingNativeMock();
    expect(mock.getElevationStatus()).toEqual({
      selfElevated: false,
      iracingFound: false,
      iracingQueryDenied: false,
      iracingElevated: false,
      mismatch: false,
    });
  });
});
```

(If `IRacingNativeMock` is already imported at the top of the file, do not duplicate the import.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/iracing-native/src/mock-impl.test.ts`
Expected: FAIL — `getElevationStatus is not a function`.

- [ ] **Step 4: Implement the mock method**

In `packages/iracing-native/src/mock-impl.ts`, update the type import to include `ElevationStatus`:

```ts
import type { BroadcastMsg, ElevationStatus, IRSDKHeader, VarHeader } from "./defines.js";
```

Add this method to the `IRacingNativeMock` class (e.g. after `setClipboardText`):

```ts
  getElevationStatus(): ElevationStatus {
    return {
      selfElevated: false,
      iracingFound: false,
      iracingQueryDenied: false,
      iracingElevated: false,
      mismatch: false,
    };
  }
```

- [ ] **Step 5: Implement the wrapper method**

In `packages/iracing-native/src/index.ts`, update the type import to include `ElevationStatus`:

```ts
import type { BroadcastMsg, ElevationStatus, IRSDKHeader, VarHeader } from "./defines.js";
```

Add this method to the `IRacingNative` class (e.g. after `setClipboardText`):

```ts
  /**
   * Compare this process's elevation/integrity with iRacing's (issue #610).
   * Windows-only; returns a safe "no mismatch" result on other platforms and
   * when the native addon is unavailable.
   *
   * @returns Elevation status, including a `mismatch` flag.
   */
  getElevationStatus(): ElevationStatus {
    return addon ? addon.getElevationStatus() : this.getMock().getElevationStatus();
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/iracing-native/src/mock-impl.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/iracing-native/src/defines.ts packages/iracing-native/src/index.ts packages/iracing-native/src/mock-impl.ts packages/iracing-native/src/mock-impl.test.ts
git commit -m "feat(iracing-native): add getElevationStatus TS wrapper and mock (#610)"
```

---

## Task 5: Native `getElevationStatus()` implementation (addon.cc)

**Files:**
- Modify: `packages/iracing-native/src/addon.cc`

There is no C++ unit test (consistent with the existing addon); verification is "the addon compiles and the exported function is callable".

- [ ] **Step 1: Add the native implementation**

In `packages/iracing-native/src/addon.cc`, add this block before the `// Module Initialization` section (immediately before `Napi::Object Init(...)`):

```cpp
// ============================================================================
// Elevation / Integrity Detection (issue #610)
// ============================================================================

struct ElevationStatus
{
    bool selfElevated = false;
    bool iracingFound = false;
    bool iracingQueryDenied = false;
    bool iracingElevated = false;
};

/**
 * Query whether a process token reports an elevated (Administrator) integrity.
 * Returns true on a successful query and writes the result to outElevated.
 */
static bool queryTokenElevation(HANDLE process, bool &outElevated)
{
    HANDLE token = NULL;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token))
    {
        return false;
    }

    TOKEN_ELEVATION elevation = {};
    DWORD size = sizeof(elevation);
    BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size);
    if (ok)
    {
        outElevated = elevation.TokenIsElevated != 0;
    }

    CloseHandle(token);
    return ok != 0;
}

/**
 * Compare this process's integrity/elevation with iRacing's.
 *
 * A functional probe can't detect the UIPI block (blocked SendInput/broadcast
 * still report success), so we compare integrity levels. ACCESS_DENIED when
 * opening an iRacing process we can clearly see ⇒ it runs at a higher
 * integrity level than us.
 */
static ElevationStatus getElevationStatus()
{
    ElevationStatus status;

    // Own elevation — reliable token query against the current process.
    queryTokenElevation(GetCurrentProcess(), status.selfElevated);

    // Locate iRacing via its window, then resolve the owning PID.
    HWND hwnd = FindWindowA(NULL, "iRacing.com Simulator");
    if (!hwnd)
    {
        return status; // iracingFound stays false
    }
    status.iracingFound = true;

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0)
    {
        return status;
    }

    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process)
    {
        // ACCESS_DENIED on a process we can see ⇒ higher integrity than us.
        if (GetLastError() == ERROR_ACCESS_DENIED)
        {
            status.iracingQueryDenied = true;
        }
        return status;
    }

    queryTokenElevation(process, status.iracingElevated);
    CloseHandle(process);
    return status;
}

/**
 * N-API wrapper: return the elevation/mismatch status object.
 *
 * @returns object { selfElevated, iracingFound, iracingQueryDenied,
 *                   iracingElevated, mismatch }
 */
Napi::Value GetElevationStatus(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    ElevationStatus status = getElevationStatus();

    bool mismatch = !status.selfElevated && status.iracingFound &&
                    (status.iracingQueryDenied || status.iracingElevated);

    Napi::Object result = Napi::Object::New(env);
    result.Set("selfElevated", Napi::Boolean::New(env, status.selfElevated));
    result.Set("iracingFound", Napi::Boolean::New(env, status.iracingFound));
    result.Set("iracingQueryDenied", Napi::Boolean::New(env, status.iracingQueryDenied));
    result.Set("iracingElevated", Napi::Boolean::New(env, status.iracingElevated));
    result.Set("mismatch", Napi::Boolean::New(env, mismatch));
    return result;
}
```

- [ ] **Step 2: Register it in `Init()`**

In `Init()`, after the clipboard registration line
(`exports.Set("setClipboardText", Napi::Function::New(env, SetClipboardText));`), add:

```cpp
    // Elevation / integrity detection (issue #610)
    exports.Set("getElevationStatus", Napi::Function::New(env, GetElevationStatus));
```

- [ ] **Step 3: Build the native addon**

Run: `pnpm --filter @iracedeck/iracing-native build`
Expected: `node-gyp rebuild` compiles with no errors, then `tsc` succeeds.

- [ ] **Step 4: Smoke-test the native export is callable**

Run:

```bash
node -e "const{IRacingNative}=require('./packages/iracing-native/dist/index.js');console.log(new IRacingNative().getElevationStatus())"
```

Expected: prints an object with the five boolean fields (real values on this Windows machine — `mismatch` will be `false` unless iRacing is running elevated). If `dist` path differs, use the package's actual build output path (check `packages/iracing-native/package.json` `main`).

- [ ] **Step 5: Commit**

```bash
git add packages/iracing-native/src/addon.cc
git commit -m "feat(iracing-native): implement native getElevationStatus probe (#610)"
```

---

## Task 6: Document the native function (iracing-native CLAUDE.md)

**Files:**
- Modify: `packages/iracing-native/CLAUDE.md`

- [ ] **Step 1: Add a documentation section**

Insert a new section after the "Clipboard Functions" section (before "Chat Functions"):

```markdown
## Elevation / Integrity Detection

### `getElevationStatus(): ElevationStatus`

Compares this process's elevation (integrity) level with iRacing's to detect the case where iRacing runs as Administrator while the plugin does not — Windows UIPI then silently drops every outbound command (scan-code injection and SDK broadcasts) while read-only telemetry keeps working (issue #610). A functional probe can't detect this (UIPI-blocked input still reports success), so the comparison of integrity levels is the only reliable signal.

Returns `{ selfElevated, iracingFound, iracingQueryDenied, iracingElevated, mismatch }`:

- `selfElevated` — this process's `TOKEN_ELEVATION.TokenIsElevated` via `OpenProcessToken` + `GetTokenInformation(TokenElevation)`.
- `iracingFound` — `FindWindowA(NULL, "iRacing.com Simulator")` located the window.
- `iracingQueryDenied` — `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` on iRacing's PID failed with `ERROR_ACCESS_DENIED` (it runs at a higher integrity level than us).
- `iracingElevated` — iRacing's token reports elevated (only meaningful when the `OpenProcess` query succeeded).
- `mismatch` — `!selfElevated && iracingFound && (iracingQueryDenied || iracingElevated)`. Computed in the N-API wrapper from the fields above.

Because the signal is *relative* integrity, it also catches non-"Administrator" integrity differences, not just the literal Administrator case.

This is **not** a keyboard function: it has no keyboard-service / `initializeKeyboard` wiring. The cross-package sync chain below applies only to its native↔TS↔mock mirror (`addon.cc` → `src/index.ts` → `src/mock-impl.ts`) and this document. Consumers (the plugins) read it directly via `new IRacingNative().getElevationStatus()`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/iracing-native/CLAUDE.md
git commit -m "docs(iracing-native): document getElevationStatus (#610)"
```

---

## Task 7: `ird-warnings` web component (pi-components)

**Files:**
- Create: `packages/pi-components/src/components/warnings.ts`
- Test: `packages/pi-components/src/components/warnings.test.ts`
- Modify: `packages/pi-components/src/components/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/pi-components/src/components/warnings.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./warnings.js";

type SettingsCallback = (value: string) => void;
type SettingsHook = [() => Promise<string>, (value: string) => void];

interface MockSDPIState {
  callbacks: Map<string, SettingsCallback>;
}

function installMockSDPI(): MockSDPIState {
  const state: MockSDPIState = { callbacks: new Map() };
  const useGlobalSettings = (key: string, callback: SettingsCallback): SettingsHook => {
    state.callbacks.set(key, callback);
    return [async () => "", vi.fn()];
  };
  (window as unknown as Record<string, unknown>).SDPIComponents = { useGlobalSettings };
  return state;
}

describe("ird-warnings", () => {
  let el: HTMLElement;
  let mock: MockSDPIState;

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    mock = installMockSDPI();
    el = document.createElement("ird-warnings");
    document.body.appendChild(el);
  });

  afterEach(() => {
    (window as unknown as Record<string, unknown>).SDPIComponents = undefined;
  });

  function emit(value: string): void {
    mock.callbacks.get("_warnings")!(value);
  }

  it("renders nothing when there are no warnings", () => {
    emit("");
    expect(el.querySelectorAll(".ird-warning").length).toBe(0);
  });

  it("renders one banner per warning record with its message", () => {
    emit(
      JSON.stringify([
        { id: "elevation-mismatch", level: "warning", message: "Run as admin" },
        { id: "x", level: "info", message: "Heads up" },
      ]),
    );
    const rows = el.querySelectorAll(".ird-warning");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("Run as admin");
    expect(rows[1].textContent).toContain("Heads up");
  });

  it("maps level to a CSS class and icon", () => {
    emit(JSON.stringify([{ id: "a", level: "warning", message: "m" }]));
    const row = el.querySelector(".ird-warning")!;
    expect(row.classList.contains("ird-warning-warning")).toBe(true);
    expect(row.textContent).toContain("⚠️");
  });

  it("ignores malformed JSON without throwing", () => {
    expect(() => emit("{not json")).not.toThrow();
    expect(el.querySelectorAll(".ird-warning").length).toBe(0);
  });

  it("ignores records with an unknown level", () => {
    emit(JSON.stringify([{ id: "a", level: "bogus", message: "m" }]));
    expect(el.querySelectorAll(".ird-warning").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/pi-components/src/components/warnings.test.ts`
Expected: FAIL — `Cannot find module './warnings.js'`.

- [ ] **Step 3: Write the component**

Create `packages/pi-components/src/components/warnings.ts`:

```ts
/// <reference lib="dom" />
/**
 * Global Property Inspector warning banner (issue #610).
 *
 * Subscribes to the `_warnings` global setting — a JSON array of
 * `{ id, level, message }` records maintained by the plugin via deck-core's
 * `setWarning`/`clearWarning` — and renders one banner per record at the top
 * of the Property Inspector. State-driven and not dismissible: a warning
 * stays until its underlying condition clears.
 *
 * Auto-injected at the top of every PI body by `head-common.ejs`, so no
 * per-template markup is required.
 */

let styleInjected = false;

type WarningLevel = "info" | "warning" | "error";
interface WarningRecord {
  id: string;
  level: WarningLevel;
  message: string;
}

const WARNINGS_SETTING = "_warnings";

const LEVEL_ICON: Record<WarningLevel, string> = {
  info: "ℹ️",
  warning: "⚠️",
  error: "⛔",
};

export class WarningsBanner extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private _initialized = false;

  connectedCallback(): void {
    if (this._initialized) return;

    this._initialized = true;
    this.injectStyle();
    this.container = document.createElement("div");
    this.appendChild(this.container);
    this.hookSettings();
  }

  private injectStyle(): void {
    if (styleInjected || typeof document === "undefined") return;

    const style = document.createElement("style");
    style.textContent = `
      ird-warnings { display: block; }
      ird-warnings .ird-warning {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin: 8px 0;
        padding: 8px 10px;
        border-radius: 4px;
        font-family: "Segoe UI", Arial, Roboto, Helvetica, sans-serif,
                     "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        font-size: 9pt;
        line-height: 1.35;
      }
      ird-warnings .ird-warning-icon { flex-shrink: 0; }
      ird-warnings .ird-warning-info { background: #1e3a4a; border: 1px solid #2a6f97; color: #d6ecff; }
      ird-warnings .ird-warning-warning { background: #4a3a1e; border: 1px solid #b8860b; color: #ffe9b8; }
      ird-warnings .ird-warning-error { background: #4a1e1e; border: 1px solid #c0392b; color: #ffd6d6; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  private hookSettings(): void {
    if (!window.SDPIComponents) return;

    window.SDPIComponents.useGlobalSettings(WARNINGS_SETTING, (value: string) => {
      this.render(this.parse(value));
    });
  }

  private parse(value: unknown): WarningRecord[] {
    if (typeof value !== "string" || value === "") return [];

    try {
      const parsed: unknown = JSON.parse(value);

      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (w): w is WarningRecord =>
          !!w &&
          typeof (w as WarningRecord).id === "string" &&
          typeof (w as WarningRecord).message === "string" &&
          ((w as WarningRecord).level === "info" ||
            (w as WarningRecord).level === "warning" ||
            (w as WarningRecord).level === "error"),
      );
    } catch {
      return [];
    }
  }

  private render(warnings: WarningRecord[]): void {
    if (!this.container) return;

    this.container.replaceChildren();

    for (const w of warnings) {
      const row = document.createElement("div");
      row.className = `ird-warning ird-warning-${w.level}`;

      const icon = document.createElement("span");
      icon.className = "ird-warning-icon";
      icon.textContent = LEVEL_ICON[w.level];
      row.appendChild(icon);

      const text = document.createElement("span");
      text.className = "ird-warning-text";
      text.textContent = w.message;
      row.appendChild(text);

      this.container.appendChild(row);
    }
  }
}

if (typeof customElements !== "undefined") {
  if (!customElements.get("ird-warnings")) {
    customElements.define("ird-warnings", WarningsBanner);
  }
}
```

- [ ] **Step 4: Export it from the component barrel**

Append to `packages/pi-components/src/components/index.ts`:

```ts
// Warnings Banner - global PI warning banner driven by the _warnings global setting
export { WarningsBanner } from "./warnings.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/pi-components/src/components/warnings.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/pi-components/src/components/warnings.ts packages/pi-components/src/components/warnings.test.ts packages/pi-components/src/components/index.ts
git commit -m "feat(pi-components): add ird-warnings banner component (#610)"
```

---

## Task 8: Auto-inject the banner into every PI (head-common.ejs)

**Files:**
- Modify: `packages/pi-components/partials/head-common.ejs`

- [ ] **Step 1: Add the injection bootstrap**

In `packages/pi-components/partials/head-common.ejs`, inside the existing `<script>` block, add this IIFE immediately after the opening accordion IIFE's closing `})();` (i.e. anywhere among the other top-level IIFEs in that script; place it right after the accordion block for readability):

```js
  // Inject the global warnings banner (issue #610) at the very top of every
  // PI body. head-common is included by every PI and loads pi-components.js,
  // so this covers all current and future Property Inspectors with no
  // per-template markup. The <ird-warnings> element subscribes to the
  // `_warnings` global setting and renders itself; it collapses to nothing
  // when there are no warnings.
  (function() {
    function injectWarnings() {
      if (!document.body) return;
      if (document.querySelector('ird-warnings')) return;
      var el = document.createElement('ird-warnings');
      document.body.insertBefore(el, document.body.firstChild);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectWarnings);
    } else {
      injectWarnings();
    }
  })();
```

- [ ] **Step 2: Build pi-components and verify the banner is bundled + injected**

Run: `pnpm --filter @iracedeck/pi-components build`
Expected: succeeds.

Run: `grep -c "ird-warnings" packages/pi-components/browser/pi-components.js`
Expected: ≥ 1 (the component is in the bundle).

- [ ] **Step 3: Commit**

```bash
git add packages/pi-components/partials/head-common.ejs packages/pi-components/browser/pi-components.js
git commit -m "feat(pi-components): auto-inject ird-warnings banner into every PI (#610)"
```

> Note: if `packages/pi-components/browser/pi-components.js` is gitignored, `git add` will skip it — that's fine; the plugins rebuild it. Check `git status` and only commit it if it's tracked.

---

## Task 9: Wire detection into the Stream Deck plugin

**Files:**
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts`

- [ ] **Step 1: Add imports**

In `packages/iracing-plugin-stream-deck/src/plugin.ts`, add to the existing `@iracedeck/deck-core` import block (the one starting `import {` … `} from "@iracedeck/deck-core";`) these named imports (keep alphabetical-ish ordering consistent with the file):

```ts
  clearWarning,
  ELEVATION_WARNING_ID,
  evaluateElevationWarning,
  setWarning,
```

- [ ] **Step 2: Add the detection wiring**

Insert this block immediately **before** the final `adapter.connect();` line (after `initAppMonitor(...)`):

```ts
// Detect an Administrator/integrity mismatch with iRacing and surface it as a
// PI warning banner (issue #610). When iRacing runs elevated and the plugin
// does not, Windows UIPI silently drops every outbound command while telemetry
// keeps flowing — so nothing else signals the cause. The probe runs once per
// connection (re-armed on reconnect) and is purely diagnostic: it never gates
// or disables the plugin.
const elevationLogger = adapter.createLogger("Elevation");
let elevationWasConnected = false;
let elevationChecked = false;

getController().subscribe("elevation-check", (_telemetry, isConnected) => {
  if (isConnected && !elevationWasConnected && !elevationChecked) {
    elevationChecked = true;

    const status = native.getElevationStatus();
    const warning = evaluateElevationWarning(status);

    if (warning) {
      elevationLogger.warn(
        "iRacing appears to run at a higher integrity level than the plugin; outbound commands will be silently dropped",
      );
      elevationLogger.debug(`Elevation status: ${JSON.stringify(status)}`);
      setWarning(warning.id, warning.level, warning.message);
    } else {
      clearWarning(ELEVATION_WARNING_ID);
    }
  }

  if (isConnected) {
    elevationWasConnected = true;
  } else {
    elevationWasConnected = false;
    elevationChecked = false;
  }
});
```

- [ ] **Step 3: Build the plugin**

Run: `pnpm --filter @iracedeck/iracing-plugin-stream-deck build`
Expected: succeeds, no TS errors.

- [ ] **Step 4: Commit**

```bash
git add packages/iracing-plugin-stream-deck/src/plugin.ts
git commit -m "feat(plugin-stream-deck): warn on iRacing elevation mismatch (#610)"
```

---

## Task 10: Wire detection into the Mirabox plugin (parity)

**Files:**
- Modify: `packages/iracing-plugin-mirabox/src/plugin.ts`

- [ ] **Step 1: Add imports**

In `packages/iracing-plugin-mirabox/src/plugin.ts`, add to the existing `@iracedeck/deck-core` import block these named imports:

```ts
  clearWarning,
  ELEVATION_WARNING_ID,
  evaluateElevationWarning,
  setWarning,
```

Confirm `getController` is already imported in this file (it is, per the existing init that calls `initializeSimEventsIracing(eventBus, getController(), …)`), and that `native` (the `IRacingNative` instance) is in scope.

- [ ] **Step 2: Add the detection wiring**

Insert the same block as Task 9 Step 2 immediately **before** this plugin's final `adapter.connect();` line, using this plugin's `adapter.createLogger`:

```ts
// Detect an Administrator/integrity mismatch with iRacing and surface it as a
// PI warning banner (issue #610). When iRacing runs elevated and the plugin
// does not, Windows UIPI silently drops every outbound command while telemetry
// keeps flowing — so nothing else signals the cause. The probe runs once per
// connection (re-armed on reconnect) and is purely diagnostic: it never gates
// or disables the plugin.
const elevationLogger = adapter.createLogger("Elevation");
let elevationWasConnected = false;
let elevationChecked = false;

getController().subscribe("elevation-check", (_telemetry, isConnected) => {
  if (isConnected && !elevationWasConnected && !elevationChecked) {
    elevationChecked = true;

    const status = native.getElevationStatus();
    const warning = evaluateElevationWarning(status);

    if (warning) {
      elevationLogger.warn(
        "iRacing appears to run at a higher integrity level than the plugin; outbound commands will be silently dropped",
      );
      elevationLogger.debug(`Elevation status: ${JSON.stringify(status)}`);
      setWarning(warning.id, warning.level, warning.message);
    } else {
      clearWarning(ELEVATION_WARNING_ID);
    }
  }

  if (isConnected) {
    elevationWasConnected = true;
  } else {
    elevationWasConnected = false;
    elevationChecked = false;
  }
});
```

- [ ] **Step 3: Build the plugin**

Run: `pnpm --filter @iracedeck/iracing-plugin-mirabox build`
Expected: succeeds, no TS errors.

- [ ] **Step 4: Commit**

```bash
git add packages/iracing-plugin-mirabox/src/plugin.ts
git commit -m "feat(plugin-mirabox): warn on iRacing elevation mismatch (#610)"
```

---

## Task 11: Website troubleshooting entry

**Files:**
- Modify: `packages/website/src/content/docs/docs/getting-started/troubleshooting.md`

- [ ] **Step 1: Add the FAQ entry**

Insert this section after the "## Buttons show \"disabled\" or don't respond" section (before "## Keyboard shortcuts not working"):

```markdown
## Buttons do nothing in iRacing (but the plugin looks connected)

If iRaceDeck appears connected — telemetry-driven features like the Race Engineer still work — but **no button affects iRacing** (black box, camera, pit service, chat all do nothing), the most common cause is an **Administrator mismatch**:

- iRacing is running **as Administrator**, and
- the Stream Deck software (and therefore iRaceDeck) is **not**.

Windows blocks a non-elevated program from sending input or commands to an elevated one, so iRaceDeck's button presses are silently dropped even though it can still read iRacing's telemetry. When iRaceDeck detects this, it shows a ⚠️ warning banner at the top of every action's settings (Property Inspector).

**Fix:** run both at the same level. Either:

- Run the **Stream Deck software as Administrator** (right-click → Run as administrator), or
- Run **iRacing without Administrator**.

Then restart the one you changed. The warning clears automatically once the levels match.
```

- [ ] **Step 2: Commit**

```bash
git add packages/website/src/content/docs/docs/getting-started/troubleshooting.md
git commit -m "docs(website): add Administrator-mismatch troubleshooting entry (#610)"
```

---

## Task 12: Rules documentation

**Files:**
- Modify: `.claude/rules/global-settings.md`
- Modify: `.claude/rules/keyboard-shortcuts.md`
- Modify: `.claude/rules/stream-deck-actions.md`

- [ ] **Step 1: Document the warnings store in global-settings.md**

Append this section to `.claude/rules/global-settings.md` (after the "Settings Key Convention" section):

```markdown
## PI Warning Banners — `_warnings` + `setWarning`/`clearWarning`

Plugin code can surface a banner at the top of every Property Inspector (issue #610). Warnings are persisted in the `_warnings` global setting as a JSON array of `{ id, level, message }` records (`level` is `"info" | "warning" | "error"`). `_warnings` is a passthrough key — no `GlobalSettingsSchema` field is needed (same as `_audioDeviceList`).

Manage warnings from `@iracedeck/deck-core`:

```typescript
import { setWarning, clearWarning } from "@iracedeck/deck-core";

setWarning("elevation-mismatch", "warning", "…message…"); // upsert, keyed by id
clearWarning("elevation-mismatch");                         // remove by id
```

Records are keyed by `id` so independent producers coexist. `setWarning` skips the write when an identical record already exists; `clearWarning` is a no-op when the id is absent. The `ird-warnings` PI web component (auto-injected by `head-common.ejs`) renders the array and prepends a per-level icon — so warning **messages must not start with their own emoji**. Banners are state-driven and not dismissible: a warning persists until its condition clears.

Reference producer: the elevation-mismatch detector wired in both plugins' `plugin.ts` using `evaluateElevationWarning()` + `getElevationStatus()`.
```

- [ ] **Step 2: Note the detector in keyboard-shortcuts.md**

In `.claude/rules/keyboard-shortcuts.md`, add this subsection at the end of the "## SDK-First Principle" section (or directly after it, before "## Reference"):

```markdown
## Elevation / Administrator mismatch

Keyboard injection and SDK broadcasts both require the plugin to run at the **same Windows integrity level as iRacing**. If iRacing runs as Administrator and the plugin does not, UIPI silently drops every outbound command (input *and* broadcast) while telemetry keeps working — there is no error to catch. The native `getElevationStatus()` probe (see `iracing-native/CLAUDE.md`) detects this; both plugins run it once per connection and post a PI warning banner via `setWarning` (issue #610). It is diagnostic only — never gate or disable actions on it. Advise users to run Stream Deck and iRacing at matching elevation.

`getElevationStatus` is a native export, so the native↔TS↔mock mirror still applies (`addon.cc` → `iracing-native/src/index.ts` → `src/mock-impl.ts`), but it is **not** a keyboard function — steps 3–4 of the keyboard Cross-Package Sync (keyboard-service, `initializeKeyboard`) do not apply to it.
```

- [ ] **Step 3: Document the component in stream-deck-actions.md**

In `.claude/rules/stream-deck-actions.md`, under "### Custom Components" (after the `ird-audio-device-select` entry), add:

```markdown
**`ird-warnings`** - Global warning banner. Auto-injected at the top of every Property Inspector by `head-common.ejs` (no per-template markup). Subscribes to the `_warnings` global setting and renders one banner per `{ id, level, message }` record. Plugins post/clear warnings with `setWarning`/`clearWarning` from `@iracedeck/deck-core`. See `@.claude/rules/global-settings.md` for the data shape. Do not add `<ird-warnings>` to individual templates — it is injected globally.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/rules/global-settings.md .claude/rules/keyboard-shortcuts.md .claude/rules/stream-deck-actions.md
git commit -m "docs(rules): document PI warnings store and elevation detector (#610)"
```

---

## Task 13: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Install (ensure workspace is linked)**

Run: `pnpm install`
Expected: up to date / no errors.

- [ ] **Step 2: Full build**

Run: `pnpm build`
Expected: turbo builds every package with no errors (this rebuilds `pi-components.js` and both plugins, copying the bundle into each plugin's `ui/`).

- [ ] **Step 3: Lint**

Run: `pnpm lint:fix`
Expected: no remaining errors. Fix any reported in the new files.

- [ ] **Step 4: Format**

Run: `pnpm format:fix`
Expected: formats; re-stage any changed files.

- [ ] **Step 5: Full test suite**

Run: `pnpm test`
Expected: all tests pass, including the new `pi-warnings`, `elevation-warning`, `mock-impl` (elevation), and `ird-warnings` tests.

- [ ] **Step 6: Verify the bundle carries the component and injector**

Run (per plugin ui dir):

```bash
grep -c "ird-warnings" packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/pi-components.js
grep -c "ird-warnings" packages/iracing-plugin-mirabox/*.sdPlugin/ui/pi-components.js
```

Expected: ≥ 1 in each.

- [ ] **Step 7: Commit any formatting/lint fixups**

```bash
git add -A
git commit -m "chore: lint/format fixups for elevation warning (#610)"
```

(Skip if there is nothing to commit.)

---

## Notes for the implementer

- **Do not** add `<ird-warnings>` to any action template — it is injected globally by `head-common.ejs`.
- The elevation message in `elevation-warning.ts` has **no** leading emoji on purpose; the banner renders the ⚠️ icon.
- The probe genuinely compiles and runs on this Windows machine — if `pnpm --filter @iracedeck/iracing-native build` fails to find `tsc`/a binary in `node_modules`, the fix is `rm -rf node_modules && pnpm install` (pnpm store corruption), then rebuild.
- Manual end-to-end test (after the user's own iRacing session): run iRacing as Administrator with Stream Deck non-elevated → expect a ⚠️ banner at the top of any action's PI and one `WARN` line in the plugin log shortly after connecting; run both at the same level → no banner.
```