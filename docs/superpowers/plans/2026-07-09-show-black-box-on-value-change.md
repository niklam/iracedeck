# Show the Fuel Black Box on Value Change — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Show black box" checkbox to Fuel Service that pops iRacing's Fuel black box when the key is pressed, using a new atomic two-keypress native primitive so the priming box never flickers.

**Architecture:** Six layers, bottom-up. A new native `sendScanKeySequence(chords, holdMs = 0)` emits every down/up event of every chord in one `SendInput` batch. `deck-core`'s `keyboard-service` exposes it as `sendKeySequence`, and `binding-dispatcher` as `tapSequence` (which skips rather than degrades when a binding can't be batched). A new `iracing-actions/src/shared/black-box.ts` owns the iRacing policy: press a *different* box first (because a black-box hotkey is a toggle and telemetry never reports which box is shown), then the target. Fuel Service calls it from `onKeyDown`.

**Tech Stack:** C++/N-API (node-gyp), TypeScript, Zod, Vitest, EJS + Lit-style web components (`sdpi-components` / `ird-*`), pnpm + turbo monorepo.

**Spec:** `docs/superpowers/specs/2026-07-09-show-black-box-on-value-change-design.md`
**Issue:** #818

## Global Constraints

- Worktree: `C:/Users/Niklas/Projects/iRaceDeck/ir-818`, branch `ir-818`. All paths below are relative to it.
- No watcher is running. After each task run `pnpm build` (or the scoped package build) **and** `pnpm test` before committing. `pnpm build` catches type errors that vitest's esbuild path lets through.
- A running Stream Deck / UlanziStudio / StreamDock host locks `iracing_native.node` and makes `pnpm build` fail with `EPERM`. Quit the host before Task 1.
- Exact dependency versions only (no `^`/`~`). No new dependencies are needed.
- `sdpi-checkbox` must **omit** the `default` attribute for an unchecked default — `default="false"` renders **checked**.
- Zod booleans: never `z.coerce.boolean()` (it makes `"false"` true). Use `z.union([z.boolean(), z.string()]).transform((val) => val === true || val === "true")`.
- Markdown fenced code blocks always carry a language identifier.
- Commit messages are conventional commits. Do **not** push and do **not** open a PR — the user tests in-sim first.
- Run `pnpm lint:fix` and `pnpm format:fix` before each commit.
- The native ↔ TS ↔ mock mirror is mandatory: any `addon.cc` export must appear in `iracing-native/src/index.ts`, `src/mock-impl.ts`, and `iracing-native/CLAUDE.md`.

---

### Task 1: Native `sendScanKeySequence`

**Files:**
- Modify: `packages/iracing-native/src/addon.cc` (includes ~line 1-6; `sendScanKey` at 668-693; `Init()` keyboard block at ~976-978)
- Modify: `packages/iracing-native/src/index.ts:272-278` (after `sendScanKeyUp`)
- Modify: `packages/iracing-native/src/mock-impl.ts:119-121` (after `sendScanKeyUp`)
- Modify: `packages/iracing-native/CLAUDE.md` (Keyboard Input Functions section)
- Test: `packages/iracing-native/src/mock-impl.test.ts:138-147`

**Interfaces:**
- Consumes: nothing.
- Produces: `IRacingNative.sendScanKeySequence(chords: number[][], holdMs?: number): void` — chords fire in order; each chord is `[modifierScanCode…, mainKeyScanCode]`. `holdMs === 0` (default) = one atomic `SendInput`, no `Sleep`.

- [ ] **Step 1: Write the failing mock test**

Add to `packages/iracing-native/src/mock-impl.test.ts`, directly after the existing `sendScanKeyUp should not throw` test:

```typescript
    it("sendScanKeySequence should not throw", () => {
      expect(() => mock.sendScanKeySequence([[0x3b], [0x3e]])).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });

    it("sendScanKeySequence should accept an explicit holdMs", () => {
      expect(() => mock.sendScanKeySequence([[0x3b], [0x3e]], 16)).not.toThrow();
      expect(console.debug).toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/iracing-native/src/mock-impl.test.ts`
Expected: FAIL — `mock.sendScanKeySequence is not a function`

- [ ] **Step 3: Add `<vector>` to the addon includes**

In `packages/iracing-native/src/addon.cc`, the include block currently reads:

```cpp
#include <napi.h>
#include <windows.h>
#include <string>
#include <mutex>
#include <irsdk_defines.h>
```

Change it to:

```cpp
#include <napi.h>
#include <windows.h>
#include <string>
#include <mutex>
#include <vector>
#include <irsdk_defines.h>
```

- [ ] **Step 4: Extract `makeScanKeyInput` from `sendScanKey`**

In `packages/iracing-native/src/addon.cc`, replace the whole `sendScanKey` function (lines 661-693, including its doc comment) with:

```cpp
/**
 * Build a single scan code INPUT record.
 * Uses KEYEVENTF_SCANCODE for layout-independent physical key sending.
 *
 * @param scanCode - PS/2 scan code. Bit 0x100 signals an extended key (KEYEVENTF_EXTENDEDKEY).
 * @param isDown - true for key press, false for key release
 */
static INPUT makeScanKeyInput(UINT scanCode, bool isDown)
{
    INPUT ip = {};
    ip.type = INPUT_KEYBOARD;
    ip.ki.dwFlags = KEYEVENTF_SCANCODE;

    if (!isDown)
    {
        ip.ki.dwFlags |= KEYEVENTF_KEYUP;
    }

    WORD sc = static_cast<WORD>(scanCode & 0xFF);

    if (scanCode & 0x100)
    {
        ip.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    }

    ip.ki.wScan = sc;
    // Derive VK from scan code for compatibility with apps that read wVk.
    // Use MAPVK_VSC_TO_VK_EX to distinguish extended keys (e.g. PageUp vs Numpad9).
    UINT mapType = (scanCode & 0x100) ? MAPVK_VSC_TO_VK_EX : MAPVK_VSC_TO_VK;
    ip.ki.wVk = static_cast<WORD>(MapVirtualKeyW(sc, mapType));

    return ip;
}

/**
 * Send a single scan code key event via SendInput.
 *
 * @param scanCode - PS/2 scan code. Bit 0x100 signals an extended key (KEYEVENTF_EXTENDEDKEY).
 * @param isDown - true for key press, false for key release
 */
static void sendScanKey(UINT scanCode, bool isDown)
{
    INPUT ip = makeScanKeyInput(scanCode, isDown);
    SendInput(1, &ip, sizeof(INPUT));
}
```

- [ ] **Step 5: Add `SendScanKeySequence`**

In `packages/iracing-native/src/addon.cc`, insert immediately **after** the closing brace of `SendScanKeyUp` (currently line 811) and **before** the `// Clipboard` banner comment:

```cpp
/**
 * Upper bound for the per-chord hold in SendScanKeySequence. Mirrors the chat
 * pipeline's defensive clamp: a negative or absurd JS value must never turn
 * Sleep() into a multi-second stall.
 */
static const double kMaxSequenceHoldMs = 1000.0;

/**
 * Send a SEQUENCE of distinct key chords in one native call (issue #818).
 *
 * Each chord is a scan code array in the usual convention (modifiers first,
 * main key last). Chords fire in order.
 *
 * holdMs == 0 (the default): every down/up event of every chord is emitted in a
 * SINGLE SendInput batch, with no Sleep. The events reach the target's input
 * queue atomically, so a two-chord sequence ("show Lap Timing, then show Fuel")
 * is consumed within one frame and the intermediate box never renders.
 *
 * holdMs > 0: falls back to per-chord press -> Sleep(holdMs) -> release, the
 * same shape as SendScanKeys, for a target that samples keyboard state per
 * frame and would miss a zero-duration press.
 *
 * @param chords - Array of scan code arrays (bit 0x100 = extended key)
 * @param holdMs - Optional per-chord hold in ms; clamped to [0, kMaxSequenceHoldMs]
 */
Napi::Value SendScanKeySequence(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsArray())
    {
        Napi::TypeError::New(env, "Expected (chords: number[][], holdMs?: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array chords = info[0].As<Napi::Array>();
    uint32_t chordCount = chords.Length();

    if (chordCount == 0)
    {
        return env.Undefined();
    }

    // Read as a double, then clamp. Reading via Uint32Value() would let
    // ECMAScript ToUint32 wrap a negative value into a huge DWORD.
    double rawHold = 0.0;

    if (info.Length() >= 2 && info[1].IsNumber())
    {
        rawHold = info[1].As<Napi::Number>().DoubleValue();
    }

    if (!(rawHold > 0.0))
    {
        rawHold = 0.0;
    }
    else if (rawHold > kMaxSequenceHoldMs)
    {
        rawHold = kMaxSequenceHoldMs;
    }

    DWORD holdMs = static_cast<DWORD>(rawHold);

    // Atomic path: one SendInput for the whole sequence, no Sleep.
    if (holdMs == 0)
    {
        std::vector<INPUT> inputs;

        for (uint32_t c = 0; c < chordCount; c++)
        {
            Napi::Value entry = chords.Get(c);

            if (!entry.IsArray())
            {
                continue;
            }

            Napi::Array scanCodes = entry.As<Napi::Array>();
            uint32_t len = scanCodes.Length();

            for (uint32_t i = 0; i < len; i++)
            {
                UINT sc = scanCodes.Get(i).As<Napi::Number>().Uint32Value();
                inputs.push_back(makeScanKeyInput(sc, true));
            }

            for (int32_t i = static_cast<int32_t>(len) - 1; i >= 0; i--)
            {
                UINT sc = scanCodes.Get(static_cast<uint32_t>(i)).As<Napi::Number>().Uint32Value();
                inputs.push_back(makeScanKeyInput(sc, false));
            }
        }

        if (!inputs.empty())
        {
            SendInput(static_cast<UINT>(inputs.size()), inputs.data(), sizeof(INPUT));
        }

        return env.Undefined();
    }

    // Held path: press, hold, release — one chord at a time.
    for (uint32_t c = 0; c < chordCount; c++)
    {
        Napi::Value entry = chords.Get(c);

        if (!entry.IsArray())
        {
            continue;
        }

        Napi::Array scanCodes = entry.As<Napi::Array>();
        uint32_t len = scanCodes.Length();

        if (len == 0)
        {
            continue;
        }

        for (uint32_t i = 0; i < len; i++)
        {
            sendScanKey(scanCodes.Get(i).As<Napi::Number>().Uint32Value(), true);
        }

        Sleep(holdMs);

        for (int32_t i = static_cast<int32_t>(len) - 1; i >= 0; i--)
        {
            sendScanKey(scanCodes.Get(static_cast<uint32_t>(i)).As<Napi::Number>().Uint32Value(), false);
        }
    }

    return env.Undefined();
}
```

- [ ] **Step 6: Register it in `Init()`**

In `packages/iracing-native/src/addon.cc`, the keyboard block of `Init()` currently reads:

```cpp
    // Keyboard Input
    exports.Set("sendScanKeys", Napi::Function::New(env, SendScanKeys));
    exports.Set("sendScanKeyDown", Napi::Function::New(env, SendScanKeyDown));
    exports.Set("sendScanKeyUp", Napi::Function::New(env, SendScanKeyUp));
```

Add a fourth line:

```cpp
    // Keyboard Input
    exports.Set("sendScanKeys", Napi::Function::New(env, SendScanKeys));
    exports.Set("sendScanKeyDown", Napi::Function::New(env, SendScanKeyDown));
    exports.Set("sendScanKeyUp", Napi::Function::New(env, SendScanKeyUp));
    exports.Set("sendScanKeySequence", Napi::Function::New(env, SendScanKeySequence));
```

- [ ] **Step 7: Mirror into the TypeScript wrapper**

In `packages/iracing-native/src/index.ts`, insert after the `sendScanKeyUp` method (which ends at line 278):

```typescript
  /**
   * Send a sequence of distinct key chords in one native call (issue #818).
   *
   * Chords fire in order; each is an array of PS/2 scan codes (modifiers first,
   * then main key). With `holdMs === 0` the whole sequence goes out as a single
   * atomic SendInput batch with no sleep, so the target consumes every event in
   * the same frame — no intermediate state is ever rendered.
   *
   * @param chords - Array of scan code arrays
   * @param holdMs - Per-chord hold in ms (default 0 = atomic batch, no sleep)
   */
  sendScanKeySequence(chords: number[][], holdMs = 0): void {
    if (addon) {
      addon.sendScanKeySequence(chords, holdMs);
    } else {
      this.getMock().sendScanKeySequence(chords, holdMs);
    }
  }
```

- [ ] **Step 8: Mirror into the mock**

In `packages/iracing-native/src/mock-impl.ts`, insert after the `sendScanKeyUp` method (ends line 121):

```typescript
  sendScanKeySequence(chords: number[][], holdMs = 0): void {
    const rendered = chords.map((chord) => `[${chord.join(", ")}]`).join(", ");
    console.debug(`[IRacingNativeMock] sendScanKeySequence([${rendered}], ${holdMs})`);
  }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run packages/iracing-native/src/mock-impl.test.ts`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 10: Rebuild the native addon**

Run: `pnpm --filter @iracedeck/iracing-native build`
Expected: `node-gyp rebuild` succeeds, then `tsc` succeeds. If it fails with `EPERM`/`EBUSY`, a deck host app is running — quit it and retry.

- [ ] **Step 11: Document the new native function**

In `packages/iracing-native/CLAUDE.md`, in the "Keyboard Input Functions" section, change the intro line:

```markdown
The addon provides three keyboard functions using Windows `SendInput()` with `KEYEVENTF_SCANCODE` for layout-independent physical key sending.
```

to:

```markdown
The addon provides four keyboard functions using Windows `SendInput()` with `KEYEVENTF_SCANCODE` for layout-independent physical key sending.
```

Then insert after the `sendScanKeyUp` subsection and before the "All three delegate…" paragraph:

```markdown
### `sendScanKeySequence(chords: number[][], holdMs?: number)`
**Atomic sequence** — sends several distinct chords in order, in one call (issue #818). Each chord is its own scan-code array.

With `holdMs = 0` (the default) every down/up event of every chord is emitted in a **single `SendInput` batch** with no `Sleep`, so the target application consumes the whole sequence within one frame and no intermediate state is rendered. This is what lets iRaceDeck switch black boxes (press Lap Timing, then Fuel) without the priming box flickering — a black-box hotkey is a toggle, and telemetry never reports which box is shown, so a lone press cannot guarantee the target ends up visible.

With `holdMs > 0` it falls back to per-chord press → `Sleep(holdMs)` → release, the same shape as `sendScanKeys`, for a target that samples keyboard state per frame and would miss a zero-duration press. `holdMs` is read as a double and clamped to `[0, kMaxSequenceHoldMs]` (1000 ms) so a negative JS value can't wrap into a multi-second stall.
```

Then change the trailing paragraph:

```markdown
All three delegate to a static C++ `sendScanKey(scanCode, isDown)` that sends one key event via `SendInput()`, deriving `wVk` from the scan code with `MapVirtualKeyW()` for compatibility.
```

to:

```markdown
All four build their events with a static C++ `makeScanKeyInput(scanCode, isDown)` that derives `wVk` from the scan code with `MapVirtualKeyW()` for compatibility. The first three send one event per `SendInput()` call via `sendScanKey(scanCode, isDown)`; `sendScanKeySequence` at `holdMs = 0` batches every event into one `SendInput()` call instead.
```

- [ ] **Step 12: Lint, format, and full verify**

```bash
pnpm lint:fix && pnpm format:fix && pnpm build && pnpm test
```

Expected: build 20/20 tasks successful; tests all passing.

- [ ] **Step 13: Commit**

```bash
git add packages/iracing-native docs/superpowers
git commit -m "feat(iracing-native): add atomic sendScanKeySequence primitive (#818)"
```

Note: this first commit also lands the spec and this plan (both untracked until now).

---

### Task 2: `deck-core` `sendKeySequence` + plugin wiring

**Files:**
- Modify: `packages/deck-core/src/keyboard-service.ts` (types ~52-66; `IKeyboardService` 71-101; `KeyboardService` ctor 147-157; `initializeKeyboard` 447-460)
- Modify: `packages/iracing-plugin-stream-deck/src/plugin.ts:231-236`
- Modify: `packages/iracing-plugin-mirabox/src/plugin.ts:241-246`
- Modify: `packages/iracing-plugin-ulanzi/src/plugin.ts:243-248`
- Modify: `.claude/rules/keyboard-shortcuts.md`
- Modify: `.claude/rules/plugin-structure.md`
- Test: `packages/iracing-plugin-stream-deck/src/shared/keyboard-service.test.ts` (this is where the keyboard tests actually live — not in `deck-core`)

**Interfaces:**
- Consumes: `IRacingNative.sendScanKeySequence(chords, holdMs)` from Task 1.
- Produces:
  - `export type ScanKeySequenceSender = (chords: number[][], holdMs: number) => void;`
  - `IKeyboardService.sendKeySequence(combinations: KeyCombination[], holdMs?: number): Promise<boolean>` — `false` means "skipped, nothing sent".
  - `initializeKeyboard(logger?, scanKeySender?, scanKeyPresser?, scanKeyReleaser?, scanKeySequenceSender?)`

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe("Keyboard Service", …)` block of `packages/iracing-plugin-stream-deck/src/shared/keyboard-service.test.ts`:

```typescript
  describe("sendKeySequence", () => {
    it("should return false when no sequence sender is configured", async () => {
      const keyboard = initializeKeyboard();

      const result = await keyboard.sendKeySequence([{ key: "f1", code: "F1" }]);

      expect(result).toBe(false);
    });

    it("should return false for an empty sequence", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
    });

    it("should send one chord per combination, modifiers first", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([
        { key: "f1", code: "F1" },
        { key: "f4", code: "F4" },
      ]);

      expect(result).toBe(true);
      // F1 = 0x3b, F4 = 0x3e (PS/2 Set 1)
      expect(mockSequenceSender).toHaveBeenCalledWith([[0x3b], [0x3e]], 0);
    });

    it("should forward an explicit holdMs", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      await keyboard.sendKeySequence([{ key: "f1", code: "F1" }], 16);

      expect(mockSequenceSender).toHaveBeenCalledWith([[0x3b]], 16);
    });

    it("should skip (not fall back to keysender) when a combination has no event.code", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([{ key: "f1" }, { key: "f4", code: "F4" }]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
      expect(mockSendKey).not.toHaveBeenCalled();
    });

    it("should skip when a combination's event.code has no scan code", async () => {
      const mockSequenceSender = vi.fn();
      const keyboard = initializeKeyboard(undefined, undefined, undefined, undefined, mockSequenceSender);

      const result = await keyboard.sendKeySequence([{ key: "f1", code: "TotallyNotAKey" }]);

      expect(result).toBe(false);
      expect(mockSequenceSender).not.toHaveBeenCalled();
      expect(mockSendKey).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/iracing-plugin-stream-deck/src/shared/keyboard-service.test.ts`
Expected: FAIL — `keyboard.sendKeySequence is not a function`

- [ ] **Step 3: Add the callback type**

In `packages/deck-core/src/keyboard-service.ts`, insert after the `ScanKeyReleaser` type (ends line 66):

```typescript
/**
 * Function type for sending a SEQUENCE of distinct scan code chords in one
 * native call (issue #818). Each chord is an array of PS/2 scan codes
 * (modifiers first, then main key); chords fire in order.
 *
 * `holdMs === 0` emits the whole sequence in one atomic SendInput batch with no
 * sleep, so the target consumes every event in the same frame.
 */
export type ScanKeySequenceSender = (chords: number[][], holdMs: number) => void;
```

- [ ] **Step 4: Add the interface method**

In `packages/deck-core/src/keyboard-service.ts`, insert into `IKeyboardService` after `releaseKeyCombination` (ends line 100):

```typescript

  /**
   * Send a sequence of distinct key combinations in one native call.
   *
   * Deliberately has NO keysender fallback: keysender cannot emit the sequence
   * atomically, and a non-atomic sequence defeats the purpose — the caller uses
   * this precisely to avoid an intermediate state being rendered (issue #818).
   * Returns false when the sequence sender was not supplied, the sequence is
   * empty, or any combination lacks a scan code mapping. Callers must treat
   * false as "skipped", never as "send it the slow way".
   *
   * @param combinations - The chords to send, in order
   * @param holdMs - Per-chord hold in ms; 0 (default) = one atomic batch, no sleep
   * @returns true if the sequence was dispatched, false if it was skipped
   */
  sendKeySequence(combinations: KeyCombination[], holdMs?: number): Promise<boolean>;
```

- [ ] **Step 5: Add the field, constructor param, and implementation**

In `packages/deck-core/src/keyboard-service.ts`, change the `KeyboardService` field block and constructor (lines 140-157) to:

```typescript
  private hardware: KeysenderHardware | null = null;
  private logger: ILogger;
  private initPromise: Promise<void> | null = null;
  private scanKeySender: ScanKeySender | null;
  private scanKeyPresser: ScanKeyPresser | null;
  private scanKeyReleaser: ScanKeyReleaser | null;
  private scanKeySequenceSender: ScanKeySequenceSender | null;

  constructor(
    logger: ILogger,
    scanKeySender: ScanKeySender | null,
    scanKeyPresser: ScanKeyPresser | null,
    scanKeyReleaser: ScanKeyReleaser | null,
    scanKeySequenceSender: ScanKeySequenceSender | null,
  ) {
    this.logger = logger;
    this.scanKeySender = scanKeySender;
    this.scanKeyPresser = scanKeyPresser;
    this.scanKeyReleaser = scanKeyReleaser;
    this.scanKeySequenceSender = scanKeySequenceSender;
  }
```

Then insert this method immediately after `releaseKeyCombination` (which ends at line 303), before `pressViaScanCodes`:

```typescript
  async sendKeySequence(combinations: KeyCombination[], holdMs = 0): Promise<boolean> {
    if (!this.scanKeySequenceSender) {
      this.logger.debug("No scan key sequence sender configured, skipping sequence");

      return false;
    }

    if (combinations.length === 0) {
      return false;
    }

    const chords: number[][] = [];

    for (const combination of combinations) {
      // No keysender fallback: the sequence must be atomic or not happen at all.
      if (!combination.code) {
        this.logger.debug(`No event.code for key="${combination.key}", skipping sequence`);

        return false;
      }

      const scanCodes = this.buildScanCodes(combination);

      if (!scanCodes) {
        this.logger.debug(`No scan code for event.code="${combination.code}", skipping sequence`);

        return false;
      }

      chords.push(scanCodes);
    }

    try {
      const rendered = chords.map((chord) => `[${chord.map((sc) => `0x${sc.toString(16)}`).join(", ")}]`).join(" -> ");
      this.logger.debug(`Sending scan code sequence: ${rendered} (holdMs=${holdMs})`);

      this.scanKeySequenceSender(chords, holdMs);

      return true;
    } catch (error) {
      this.logger.error(`Failed to send scan code sequence: ${error}`);

      return false;
    }
  }

```

- [ ] **Step 6: Extend `initializeKeyboard`**

In `packages/deck-core/src/keyboard-service.ts`, replace `initializeKeyboard` (lines 447-460) with:

```typescript
export function initializeKeyboard(
  logger: ILogger = silentLogger,
  scanKeySender?: ScanKeySender,
  scanKeyPresser?: ScanKeyPresser,
  scanKeyReleaser?: ScanKeyReleaser,
  scanKeySequenceSender?: ScanKeySequenceSender,
): IKeyboardService {
  if (keyboardService) {
    throw new Error("Keyboard service already initialized. initializeKeyboard() should only be called once.");
  }

  keyboardService = new KeyboardService(
    logger,
    scanKeySender ?? null,
    scanKeyPresser ?? null,
    scanKeyReleaser ?? null,
    scanKeySequenceSender ?? null,
  );

  return keyboardService;
}
```

Also add this line to its JSDoc, after the `@param scanKeyReleaser` line:

```typescript
 * @param scanKeySequenceSender - Optional function for sending a sequence of distinct scan code chords in one
 *   atomic native call (issue #818). When omitted, `sendKeySequence` always returns false (skipped).
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run packages/iracing-plugin-stream-deck/src/shared/keyboard-service.test.ts`
Expected: PASS

- [ ] **Step 8: Wire all three plugins**

In each of `packages/iracing-plugin-stream-deck/src/plugin.ts`, `packages/iracing-plugin-mirabox/src/plugin.ts`, and `packages/iracing-plugin-ulanzi/src/plugin.ts`, the `initializeKeyboard` call currently reads:

```typescript
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),
  (scanCodes) => native.sendScanKeyDown(scanCodes),
  (scanCodes) => native.sendScanKeyUp(scanCodes),
);
```

Change all three to:

```typescript
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),
  (scanCodes) => native.sendScanKeyDown(scanCodes),
  (scanCodes) => native.sendScanKeyUp(scanCodes),
  (chords, holdMs) => native.sendScanKeySequence(chords, holdMs),
);
```

- [ ] **Step 9: Update `.claude/rules/keyboard-shortcuts.md`**

In the "Direct Keyboard Access (Plugin-Level Only)" section, the code block currently reads:

```typescript
import { getKeyboard, type KeyboardKey, type KeyboardModifier, type KeyCombination } from "@iracedeck/deck-core";

await getKeyboard().sendKeyCombination(combination);       // tap
await getKeyboard().pressKeyCombination(combination);      // hold
await getKeyboard().releaseKeyCombination(combination);    // release
```

Change it to:

```typescript
import { getKeyboard, type KeyboardKey, type KeyboardModifier, type KeyCombination } from "@iracedeck/deck-core";

await getKeyboard().sendKeyCombination(combination);       // tap
await getKeyboard().pressKeyCombination(combination);      // hold
await getKeyboard().releaseKeyCombination(combination);    // release
await getKeyboard().sendKeySequence([comboA, comboB]);     // atomic multi-chord sequence (#818)
```

Then, in the "Plugin Setup for Keyboard Support" section, change the `initializeKeyboard` snippet to include the fifth callback:

```typescript
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),          // tap (press + release)
  (scanCodes) => native.sendScanKeyDown(scanCodes),        // press only (key hold)
  (scanCodes) => native.sendScanKeyUp(scanCodes),          // release only (key release)
  (chords, holdMs) => native.sendScanKeySequence(chords, holdMs), // atomic multi-chord sequence (#818)
);
```

Then add a new section immediately before "## Direct Keyboard Access (Plugin-Level Only)":

```markdown
## Atomic key sequences — `sendKeySequence` / `tapSequence` (#818)

Some iRacing interactions need two *different* keys pressed back to back with no
observable intermediate state. Showing a specific black box is the canonical case:
telemetry never reports which box is open and a black-box hotkey is a **toggle**, so
the only way to guarantee the target box ends up visible is to press a different box
first and then the target. Two ordinary `tapBinding` calls would block the JS main
thread for ~200 ms (each `sendScanKeys` holds `Sleep(100)` natively) and visibly flash
the priming box.

`getKeyboard().sendKeySequence(combinations, holdMs?)` and its binding-aware wrapper
`getBindingDispatcher().tapSequence(settingKeys, holdMs?)` send the whole sequence in a
single native `SendInput` batch. Both **return `false` and send nothing** rather than
degrading, when any key is unbound, is a SimHub role, or lacks a scan code mapping —
a non-atomic sequence would reintroduce the very flicker the API exists to remove.
Callers treat `false` as "skip", and surface it in the PI rather than failing silently.

Actions reach it through `this.tapBindingSequence(settingKeys, holdMs?)`. The iRacing
policy (which box to prime with, and the `holdMs` tuning constant) lives in
`packages/iracing-actions/src/shared/black-box.ts`, not in `deck-core`.
```

Finally, in the "Cross-Package Sync" numbered list, change item 4:

```markdown
4. **Plugin init** (all plugin `plugin.ts` files: `iracing-plugin-stream-deck`, `iracing-plugin-mirabox`) — `initializeKeyboard()` call must pass all callbacks
```

to:

```markdown
4. **Plugin init** (all plugin `plugin.ts` files: `iracing-plugin-stream-deck`, `iracing-plugin-mirabox`, `iracing-plugin-ulanzi`) — `initializeKeyboard()` call must pass all callbacks
```

and item 5:

```markdown
5. **Tests** (`keyboard-service.test.ts`) — must cover all paths (scan code + keysender fallback)
```

to:

```markdown
5. **Tests** (`packages/iracing-plugin-stream-deck/src/shared/keyboard-service.test.ts`) — must cover all paths (scan code + keysender fallback + sequence skip)
```

- [ ] **Step 10: Update `.claude/rules/plugin-structure.md`**

In the "Plugin Initialization Order (plugin.ts)" code block, change:

```typescript
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),      // tap (press + release)
  (scanCodes) => native.sendScanKeyDown(scanCodes),    // press only (key hold)
  (scanCodes) => native.sendScanKeyUp(scanCodes),      // release only (key release)
);
```

to:

```typescript
initializeKeyboard(
  adapter.createLogger("Keyboard"),
  (scanCodes) => native.sendScanKeys(scanCodes),      // tap (press + release)
  (scanCodes) => native.sendScanKeyDown(scanCodes),    // press only (key hold)
  (scanCodes) => native.sendScanKeyUp(scanCodes),      // release only (key release)
  (chords, holdMs) => native.sendScanKeySequence(chords, holdMs), // atomic multi-chord sequence (#818)
);
```

- [ ] **Step 11: Lint, format, and full verify**

```bash
pnpm lint:fix && pnpm format:fix && pnpm build && pnpm test
```

Expected: build 20/20 successful; all tests pass.

- [ ] **Step 12: Commit**

```bash
git add packages/deck-core packages/iracing-plugin-stream-deck packages/iracing-plugin-mirabox packages/iracing-plugin-ulanzi .claude/rules
git commit -m "feat(deck-core): add sendKeySequence keyboard API and wire it in all plugins (#818)"
```

---

### Task 3: `binding-dispatcher.tapSequence` + action delegate

**Files:**
- Modify: `packages/deck-core/src/binding-dispatcher.ts` (`IBindingDispatcher` 43-61; class impl after `tap` at 91)
- Modify: `packages/deck-core/src/connection-state-aware-action.ts` (after `tapBinding`, line 253)
- Test: `packages/deck-core/src/binding-dispatcher.test.ts`

**Interfaces:**
- Consumes: `getKeyboard().sendKeySequence(combinations, holdMs)` from Task 2.
- Produces:
  - `IBindingDispatcher.tapSequence(settingKeys: string[], holdMs?: number): Promise<boolean>`
  - `ConnectionStateAwareAction.tapBindingSequence(settingKeys: string[], holdMs?: number): Promise<boolean>` (protected)

- [ ] **Step 1: Extend the test file's keyboard mock**

In `packages/deck-core/src/binding-dispatcher.test.ts`, the `vi.hoisted` block and the `keyboard-service.js` mock need a `sendKeySequence`. Change the hoisted block to add one mock:

```typescript
const {
  mockSendKeyCombination,
  mockPressKeyCombination,
  mockReleaseKeyCombination,
  mockSendKeySequence,
  mockStartRole,
  mockStopRole,
  mockGetGlobalSettings,
  mockIsSimHubInitialized,
  mockIsSimHubReachable,
} = vi.hoisted(() => ({
  mockSendKeyCombination: vi.fn().mockResolvedValue(true),
  mockPressKeyCombination: vi.fn().mockResolvedValue(true),
  mockReleaseKeyCombination: vi.fn().mockResolvedValue(true),
  mockSendKeySequence: vi.fn().mockResolvedValue(true),
  mockStartRole: vi.fn().mockResolvedValue(true),
  mockStopRole: vi.fn().mockResolvedValue(true),
  mockGetGlobalSettings: vi.fn<() => Record<string, unknown>>(() => ({})),
  mockIsSimHubInitialized: vi.fn(() => true),
  mockIsSimHubReachable: vi.fn(() => true),
}));
```

and the keyboard-service mock to:

```typescript
vi.mock("./keyboard-service.js", () => ({
  getKeyboard: () => ({
    sendKeyCombination: mockSendKeyCombination,
    pressKeyCombination: mockPressKeyCombination,
    releaseKeyCombination: mockReleaseKeyCombination,
    sendKeySequence: mockSendKeySequence,
  }),
}));
```

- [ ] **Step 2: Write the failing tests**

Append a new `describe` block at the end of the top-level `describe` in `packages/deck-core/src/binding-dispatcher.test.ts`:

```typescript
  describe("tapSequence", () => {
    const keyboardBinding = (key: string, code: string) => JSON.stringify({ type: "keyboard", key, modifiers: [], code });

    it("should return false for an empty key list", async () => {
      initializeBindingDispatcher();

      const result = await getBindingDispatcher().tapSequence([]);

      expect(result).toBe(false);
      expect(mockSendKeySequence).not.toHaveBeenCalled();
    });

    it("should send every binding as one sequence, in order", async () => {
      mockGetGlobalSettings.mockReturnValue({
        blackBoxLapTiming: keyboardBinding("f1", "F1"),
        blackBoxFuel: keyboardBinding("f4", "F4"),
      });
      initializeBindingDispatcher();

      const result = await getBindingDispatcher().tapSequence(["blackBoxLapTiming", "blackBoxFuel"]);

      expect(result).toBe(true);
      expect(mockSendKeySequence).toHaveBeenCalledWith(
        [
          { key: "f1", modifiers: undefined, code: "F1" },
          { key: "f4", modifiers: undefined, code: "F4" },
        ],
        0,
      );
    });

    it("should forward an explicit holdMs", async () => {
      mockGetGlobalSettings.mockReturnValue({ blackBoxFuel: keyboardBinding("f4", "F4") });
      initializeBindingDispatcher();

      await getBindingDispatcher().tapSequence(["blackBoxFuel"], 16);

      expect(mockSendKeySequence).toHaveBeenCalledWith([{ key: "f4", modifiers: undefined, code: "F4" }], 16);
    });

    it("should send nothing when any binding is unset", async () => {
      mockGetGlobalSettings.mockReturnValue({ blackBoxFuel: keyboardBinding("f4", "F4") });
      initializeBindingDispatcher();

      const result = await getBindingDispatcher().tapSequence(["blackBoxLapTiming", "blackBoxFuel"]);

      expect(result).toBe(false);
      expect(mockSendKeySequence).not.toHaveBeenCalled();
    });

    it("should send nothing when any binding is a SimHub role", async () => {
      mockGetGlobalSettings.mockReturnValue({
        blackBoxLapTiming: JSON.stringify({ type: "simhub", role: "Lap Timing" }),
        blackBoxFuel: keyboardBinding("f4", "F4"),
      });
      initializeBindingDispatcher();

      const result = await getBindingDispatcher().tapSequence(["blackBoxLapTiming", "blackBoxFuel"]);

      expect(result).toBe(false);
      expect(mockSendKeySequence).not.toHaveBeenCalled();
      expect(mockStartRole).not.toHaveBeenCalled();
    });

    it("should propagate a false result from the keyboard service", async () => {
      mockGetGlobalSettings.mockReturnValue({ blackBoxFuel: keyboardBinding("f4", "F4") });
      mockSendKeySequence.mockResolvedValueOnce(false);
      initializeBindingDispatcher();

      const result = await getBindingDispatcher().tapSequence(["blackBoxFuel"]);

      expect(result).toBe(false);
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/deck-core/src/binding-dispatcher.test.ts`
Expected: FAIL — `getBindingDispatcher(...).tapSequence is not a function`

- [ ] **Step 4: Add the interface method**

In `packages/deck-core/src/binding-dispatcher.ts`, insert into `IBindingDispatcher` after `tap` (line 45):

```typescript

  /**
   * Execute several bindings as ONE atomic key sequence (issue #818).
   *
   * Sends nothing and returns false when any binding is unset, is a SimHub role
   * (it goes over HTTP and cannot join a SendInput batch), or has no scan code
   * mapping. Callers must treat false as "skip" — a non-atomic fallback would
   * reintroduce the visible intermediate state this API exists to prevent.
   *
   * @param settingKeys - Global settings keys, in press order
   * @param holdMs - Per-chord hold in ms; 0 (default) = one atomic batch
   * @returns true if the sequence was dispatched, false if it was skipped
   */
  tapSequence(settingKeys: string[], holdMs?: number): Promise<boolean>;
```

- [ ] **Step 5: Implement it**

In `packages/deck-core/src/binding-dispatcher.ts`, insert into the `BindingDispatcher` class immediately after the `tap` method (which ends at line 91):

```typescript

  /**
   * Resolve several bindings and send them as one atomic key sequence.
   *
   * @param settingKeys - Global settings keys, in press order
   * @param holdMs - Per-chord hold in ms; 0 (default) = one atomic batch
   */
  async tapSequence(settingKeys: string[], holdMs = 0): Promise<boolean> {
    if (settingKeys.length === 0) return false;

    const combinations: KeyCombination[] = [];

    for (const settingKey of settingKeys) {
      const binding = this.resolveGlobalBinding(settingKey);

      if (!binding) return false;

      if (isSimHubBinding(binding)) {
        this.logger.debug(`Binding for ${settingKey} is a SimHub role, cannot batch — skipping sequence`);

        return false;
      }

      combinations.push(this.toKeyCombination(binding));
    }

    const sent = await getKeyboard().sendKeySequence(combinations, holdMs);

    if (sent) {
      this.logger.info("Key sequence sent successfully");
      this.logger.debug(`Key sequence: ${settingKeys.join(" -> ")}`);
    } else {
      this.logger.debug(`Key sequence skipped: ${settingKeys.join(" -> ")}`);
    }

    return sent;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/deck-core/src/binding-dispatcher.test.ts`
Expected: PASS

- [ ] **Step 7: Add the action delegate**

In `packages/deck-core/src/connection-state-aware-action.ts`, insert after the `tapBinding` method (which ends at line 253):

```typescript

  /**
   * Execute several bindings as one atomic key sequence (issue #818).
   * Returns false when the sequence was skipped (unset / SimHub / unmappable key).
   *
   * @param settingKeys - Global settings keys, in press order
   * @param holdMs - Per-chord hold in ms; 0 (default) = one atomic batch
   */
  protected async tapBindingSequence(settingKeys: string[], holdMs?: number): Promise<boolean> {
    return getBindingDispatcher().tapSequence(settingKeys, holdMs);
  }
```

- [ ] **Step 8: Lint, format, and full verify**

```bash
pnpm lint:fix && pnpm format:fix && pnpm build && pnpm test
```

Expected: build 20/20 successful; all tests pass.

- [ ] **Step 9: Commit**

```bash
git add packages/deck-core
git commit -m "feat(deck-core): add binding-dispatcher tapSequence and tapBindingSequence delegate (#818)"
```

---

### Task 4: Shared `black-box.ts` + dedup the id→key map

**Files:**
- Create: `packages/iracing-actions/src/shared/black-box.ts`
- Create: `packages/iracing-actions/src/shared/black-box.test.ts`
- Modify: `packages/iracing-actions/src/actions/black-box-selector/black-box-selector.ts:71-88`
- Modify: `packages/iracing-actions/src/actions/comms-catalog.ts:96-112`
- Modify: `packages/iracing-actions/CLAUDE.md` (the `src/shared/` bullet list)
- Regenerate: `packages/iracing-actions/src/actions/data/action-comms.json`

**Interfaces:**
- Consumes: `tapBindingSequence` from Task 3 (via the `ShowBlackBoxDeps.tapSequence` port).
- Produces:
  - `type BlackBoxId` (11 kebab-case ids)
  - `const BLACK_BOX_GLOBAL_KEYS: Record<BlackBoxId, string>`
  - `const PRIME_BLACK_BOX: BlackBoxId`
  - `const BLACK_BOX_SEQUENCE_HOLD_MS: number`
  - `interface ShowBlackBoxDeps { isConfigured; tapSequence; logger }`
  - `function resolvePrimeKey(targetId: BlackBoxId, isConfigured: (k: string) => boolean): string | null`
  - `function showBlackBox(targetId: BlackBoxId, deps: ShowBlackBoxDeps): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `packages/iracing-actions/src/shared/black-box.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLACK_BOX_GLOBAL_KEYS,
  BLACK_BOX_SEQUENCE_HOLD_MS,
  PRIME_BLACK_BOX,
  resolvePrimeKey,
  showBlackBox,
} from "./black-box.js";

const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Treat exactly the listed global keys as configured. */
const configured = (...keys: string[]) => (key: string) => keys.includes(key);

describe("BLACK_BOX_GLOBAL_KEYS", () => {
  it("should map all 11 black boxes", () => {
    expect(Object.keys(BLACK_BOX_GLOBAL_KEYS)).toHaveLength(11);
    expect(BLACK_BOX_GLOBAL_KEYS.fuel).toBe("blackBoxFuel");
    expect(BLACK_BOX_GLOBAL_KEYS["lap-timing"]).toBe("blackBoxLapTiming");
  });

  it("should list lap-timing first so it is the default prime fallback", () => {
    expect(Object.keys(BLACK_BOX_GLOBAL_KEYS)[0]).toBe("lap-timing");
    expect(PRIME_BLACK_BOX).toBe("lap-timing");
  });
});

describe("resolvePrimeKey", () => {
  it("should prefer lap timing", () => {
    expect(resolvePrimeKey("fuel", configured("blackBoxLapTiming", "blackBoxFuel"))).toBe("blackBoxLapTiming");
  });

  it("should pick another configured box when the target IS lap timing", () => {
    const isConfigured = configured("blackBoxLapTiming", "blackBoxStandings");

    expect(resolvePrimeKey("lap-timing", isConfigured)).toBe("blackBoxStandings");
  });

  it("should fall back to the first configured non-target box when lap timing is unbound", () => {
    const isConfigured = configured("blackBoxRelative", "blackBoxTires", "blackBoxFuel");

    expect(resolvePrimeKey("fuel", isConfigured)).toBe("blackBoxRelative");
  });

  it("should never return the target itself", () => {
    expect(resolvePrimeKey("fuel", configured("blackBoxFuel"))).toBeNull();
  });

  it("should return null when nothing is configured", () => {
    expect(resolvePrimeKey("fuel", () => false)).toBeNull();
  });
});

describe("showBlackBox", () => {
  const tapSequence = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.clearAllMocks();
    tapSequence.mockResolvedValue(true);
  });

  it("should tap prime then target as one sequence", async () => {
    const result = await showBlackBox("fuel", {
      isConfigured: configured("blackBoxLapTiming", "blackBoxFuel"),
      tapSequence,
      logger,
    });

    expect(result).toBe(true);
    expect(tapSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxFuel"], BLACK_BOX_SEQUENCE_HOLD_MS);
  });

  it("should send nothing when the target is unbound", async () => {
    const result = await showBlackBox("fuel", {
      isConfigured: configured("blackBoxLapTiming"),
      tapSequence,
      logger,
    });

    expect(result).toBe(false);
    expect(tapSequence).not.toHaveBeenCalled();
  });

  it("should send nothing when no other box is bound to prime with", async () => {
    const result = await showBlackBox("fuel", {
      isConfigured: configured("blackBoxFuel"),
      tapSequence,
      logger,
    });

    expect(result).toBe(false);
    expect(tapSequence).not.toHaveBeenCalled();
  });

  it("should propagate a skipped sequence", async () => {
    tapSequence.mockResolvedValue(false);

    const result = await showBlackBox("fuel", {
      isConfigured: configured("blackBoxLapTiming", "blackBoxFuel"),
      tapSequence,
      logger,
    });

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/iracing-actions/src/shared/black-box.test.ts`
Expected: FAIL — cannot resolve `./black-box.js`

- [ ] **Step 3: Create the shared module**

Create `packages/iracing-actions/src/shared/black-box.ts`:

```typescript
/**
 * Black-box selection shared across actions (issue #818).
 *
 * Two facts drive this module:
 *
 * 1. Telemetry never reports which black box iRacing is currently showing.
 * 2. A black-box hotkey TOGGLES — pressing Fuel while Fuel is shown hides it.
 *
 * Together they mean a single press cannot guarantee the target box ends up
 * visible. Pressing a DIFFERENT box first deterministically replaces whatever
 * was there; the target press then shows the target. Both presses leave as one
 * atomic key sequence (see `tapSequence` / `sendKeySequence` in deck-core), so
 * the priming box never renders.
 */
import type { ILogger } from "@iracedeck/logger";

/** Every iRacing black box, in the order the Black Box Selector lists them. */
export type BlackBoxId =
  | "lap-timing"
  | "standings"
  | "relative"
  | "fuel"
  | "tires"
  | "tire-info"
  | "pit-stop"
  | "in-car"
  | "mirror"
  | "radio"
  | "weather";

/**
 * Mapping from black-box id to its global-settings key.
 *
 * Single source of truth: consumed by the Black Box Selector action (which
 * re-exports it for its tests) and by the #612 comms catalog. `key-bindings.json`
 * remains the data source for labels and default keys, and a cross-check test
 * guards that every key here exists there.
 *
 * Declaration order is also the prime-fallback scan order in {@link resolvePrimeKey}.
 */
export const BLACK_BOX_GLOBAL_KEYS: Record<BlackBoxId, string> = {
  "lap-timing": "blackBoxLapTiming",
  standings: "blackBoxStandings",
  relative: "blackBoxRelative",
  fuel: "blackBoxFuel",
  tires: "blackBoxTires",
  "tire-info": "blackBoxTireInfo",
  "pit-stop": "blackBoxPitStop",
  "in-car": "blackBoxInCar",
  mirror: "blackBoxMirror",
  radio: "blackBoxRadio",
  weather: "blackBoxWeather",
};

/** The box pressed first, to force a deterministic switch to the target. */
export const PRIME_BLACK_BOX: BlackBoxId = "lap-timing";

/**
 * Per-chord hold for the show-black-box sequence, in milliseconds.
 *
 * `0` means the whole sequence goes out in one atomic SendInput batch with no
 * sleep, so the priming box never renders. Raise this — 16-30 ms is one frame at
 * 60 Hz — only if iRacing turns out to sample keyboard state per frame and drop a
 * zero-duration press. This constant is the single tuning point for that.
 */
export const BLACK_BOX_SEQUENCE_HOLD_MS = 0;

/** Collaborators {@link showBlackBox} needs from the calling action. */
export interface ShowBlackBoxDeps {
  /** Whether a binding (keyboard or SimHub) is set at this global-settings key. */
  isConfigured: (settingKey: string) => boolean;
  /** Send the resolved keys as one atomic sequence. Returns false when skipped. */
  tapSequence: (settingKeys: string[], holdMs?: number) => Promise<boolean>;
  logger: ILogger;
}

/**
 * Pick the box to press before the target.
 *
 * Prefers Lap Timing. When the target IS Lap Timing, or Lap Timing has no
 * binding, falls back to the first configured box that isn't the target, in
 * {@link BLACK_BOX_GLOBAL_KEYS} declaration order.
 *
 * Returns null when no other box is bound. Pressing the target alone would then
 * toggle the box OFF whenever it happened to already be shown — worse than doing
 * nothing, since the driver cannot tell which happened.
 */
export function resolvePrimeKey(targetId: BlackBoxId, isConfigured: (settingKey: string) => boolean): string | null {
  const targetKey = BLACK_BOX_GLOBAL_KEYS[targetId];
  const preferredKey = BLACK_BOX_GLOBAL_KEYS[PRIME_BLACK_BOX];

  if (preferredKey !== targetKey && isConfigured(preferredKey)) {
    return preferredKey;
  }

  for (const key of Object.values(BLACK_BOX_GLOBAL_KEYS)) {
    if (key !== targetKey && isConfigured(key)) {
      return key;
    }
  }

  return null;
}

/**
 * Show the given black box, whatever is currently on screen.
 *
 * @returns true when the sequence was dispatched; false when it was skipped
 *   (target unbound, no usable prime, or a binding that cannot be batched).
 */
export async function showBlackBox(targetId: BlackBoxId, deps: ShowBlackBoxDeps): Promise<boolean> {
  const targetKey = BLACK_BOX_GLOBAL_KEYS[targetId];

  if (!deps.isConfigured(targetKey)) {
    deps.logger.debug(`No binding for ${targetKey}, not showing the ${targetId} black box`);

    return false;
  }

  const primeKey = resolvePrimeKey(targetId, deps.isConfigured);

  if (!primeKey) {
    deps.logger.debug(`No other black-box binding to prime with, not showing the ${targetId} black box`);

    return false;
  }

  const sent = await deps.tapSequence([primeKey, targetKey], BLACK_BOX_SEQUENCE_HOLD_MS);

  if (!sent) {
    deps.logger.debug(`Black-box sequence skipped (${primeKey} -> ${targetKey})`);
  }

  return sent;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/iracing-actions/src/shared/black-box.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Point the Black Box Selector at the shared map**

In `packages/iracing-actions/src/actions/black-box-selector/black-box-selector.ts`, delete the local `BLACK_BOX_GLOBAL_KEYS` declaration (lines 71-88, including its doc comment):

```typescript
/**
 * @internal Exported for testing
 *
 * Mapping from blackBox setting values (kebab-case) to global settings keys
 */
export const BLACK_BOX_GLOBAL_KEYS: Record<string, string> = {
  "lap-timing": "blackBoxLapTiming",
  standings: "blackBoxStandings",
  relative: "blackBoxRelative",
  fuel: "blackBoxFuel",
  tires: "blackBoxTires",
  "tire-info": "blackBoxTireInfo",
  "pit-stop": "blackBoxPitStop",
  "in-car": "blackBoxInCar",
  mirror: "blackBoxMirror",
  radio: "blackBoxRadio",
  weather: "blackBoxWeather",
};
```

and replace it with a re-export:

```typescript
/**
 * @internal Re-exported for the existing tests. The map itself lives in
 * `shared/black-box.ts`, which is also what the #612 comms catalog imports.
 */
export { BLACK_BOX_GLOBAL_KEYS };
```

Then add the import alongside the other relative imports, immediately after the `zod` import at line 31:

```typescript
import { BLACK_BOX_GLOBAL_KEYS } from "../../shared/black-box.js";
```

(Import ordering is enforced by the linter; `pnpm lint:fix` will place it correctly.)

- [ ] **Step 6: Point the comms catalog at the shared map**

In `packages/iracing-actions/src/actions/comms-catalog.ts`, add to the imports:

```typescript
import { BLACK_BOX_GLOBAL_KEYS } from "../shared/black-box.js";
```

and replace the `black-box-selector` entry (lines 96-112):

```typescript
  "black-box-selector": entry("mode", {
    direct: keybindBy("blackBox", {
      "lap-timing": "blackBoxLapTiming",
      standings: "blackBoxStandings",
      relative: "blackBoxRelative",
      fuel: "blackBoxFuel",
      tires: "blackBoxTires",
      "tire-info": "blackBoxTireInfo",
      "pit-stop": "blackBoxPitStop",
      "in-car": "blackBoxInCar",
      mirror: "blackBoxMirror",
      radio: "blackBoxRadio",
      weather: "blackBoxWeather",
    }),
    next: keybind("blackBoxCycleNext"),
    previous: keybind("blackBoxCyclePrevious"),
  }),
```

with:

```typescript
  "black-box-selector": entry("mode", {
    direct: keybindBy("blackBox", BLACK_BOX_GLOBAL_KEYS),
    next: keybind("blackBoxCycleNext"),
    previous: keybind("blackBoxCyclePrevious"),
  }),
```

- [ ] **Step 7: Regenerate the comms JSON and confirm it is byte-identical**

```bash
pnpm generate:action-comms
git diff --stat packages/iracing-actions/src/actions/data/action-comms.json
```

Expected: **no diff**. `BLACK_BOX_GLOBAL_KEYS` declares its keys in the same order the inline map did, so the generated JSON must not change. If a diff appears, the key order drifted — fix the order in `black-box.ts` rather than accepting the diff.

- [ ] **Step 8: Run the affected tests**

```bash
npx vitest run packages/iracing-actions/src/actions/comms-catalog.test.ts packages/iracing-actions/src/actions/black-box-selector packages/iracing-actions/src/shared/black-box.test.ts
```

Expected: PASS — including the comms freshness test and the key cross-check against `key-bindings.json`.

- [ ] **Step 9: Document the new shared module**

In `packages/iracing-actions/CLAUDE.md`, in the `src/shared/` bullet list, insert a bullet in alphabetical order (after `adjust-styles.ts`, before `car-select-intent.ts`):

```markdown
- `black-box.ts` — canonical black-box id↔global-key map (`BLACK_BOX_GLOBAL_KEYS`, also consumed by `comms-catalog.ts`) plus `showBlackBox()` / `resolvePrimeKey()`: press a different box first, then the target, as one atomic key sequence, because a black-box hotkey toggles and telemetry never reports the shown box (#818)
```

- [ ] **Step 10: Lint, format, and full verify**

```bash
pnpm lint:fix && pnpm format:fix && pnpm build && pnpm test
```

Expected: build 20/20 successful; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/iracing-actions
git commit -m "feat(actions): add shared black-box module and dedupe the id-to-key map (#818)"
```

---

### Task 5: Fuel Service setting + call site

**Files:**
- Modify: `packages/iracing-actions/src/actions/fuel-service/fuel-service-settings.ts:101-110`
- Modify: `packages/iracing-actions/src/actions/fuel-service/fuel-service.ts` (imports; a new constant near `REPEATABLE_MODES` at line 210; `onKeyDown` at 494-521)
- Test: `packages/iracing-actions/src/actions/fuel-service/fuel-service.test.ts`
- Test: `packages/iracing-actions/src/actions/fuel-service/fuel-service-settings.test.ts`

**Interfaces:**
- Consumes: `showBlackBox(targetId, deps)` from Task 4; `this.tapBindingSequence(keys, holdMs)` and `this.isBindingMissing(key)` from Task 3.
- Produces: `FuelServiceSettings.showBlackBox: boolean` (default `false`).

- [ ] **Step 1: Write the failing settings test**

Append to `packages/iracing-actions/src/actions/fuel-service/fuel-service-settings.test.ts`, inside the existing top-level `describe`:

```typescript
  describe("showBlackBox", () => {
    it("should default to false", () => {
      expect(parseFuelServiceSettings({}).showBlackBox).toBe(false);
    });

    it("should accept a real boolean", () => {
      expect(parseFuelServiceSettings({ showBlackBox: true }).showBlackBox).toBe(true);
    });

    it('should treat the string "true" as true', () => {
      expect(parseFuelServiceSettings({ showBlackBox: "true" }).showBlackBox).toBe(true);
    });

    it('should treat the string "false" as false', () => {
      expect(parseFuelServiceSettings({ showBlackBox: "false" }).showBlackBox).toBe(false);
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/iracing-actions/src/actions/fuel-service/fuel-service-settings.test.ts`
Expected: FAIL — `expected undefined to be false`

- [ ] **Step 3: Add the setting**

In `packages/iracing-actions/src/actions/fuel-service/fuel-service-settings.ts`, replace the `FuelServiceSettings` schema (lines 101-110) with:

```typescript
export const FuelServiceSettings = CommonSettings.extend({
  mode: z.enum(FUEL_SERVICE_MODES).default("toggle-fuel-fill"),
  amount: z.preprocess(commaToDot, z.coerce.number().min(0).default(1)),
  // .catch maps an unknown persisted unit — e.g. a value written into a shared
  // profile by a newer version — to auto instead of failing the whole parse,
  // which would discard the stored mode and render the key as toggle-fuel-fill
  // (the same hardening master applies for 2.0's "auto" on its side).
  unit: FuelUnit.default("auto").catch("auto"),
  // Show iRacing's Fuel black box when the key is pressed (#818). Opt-in: some
  // fuel values — notably the autofuel lap margin — have no telemetry readback,
  // so the black box is the only confirmation the driver ever gets.
  // NOT z.coerce.boolean(): it maps the string "false" to true.
  showBlackBox: z
    .union([z.boolean(), z.string()])
    .transform((val) => val === true || val === "true")
    .default(false),
  dial: DialSettings,
});
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/iracing-actions/src/actions/fuel-service/fuel-service-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Add `tapBindingSequence` to the action test's deck-core mock**

In `packages/iracing-actions/src/actions/fuel-service/fuel-service.test.ts`, the hoisted block at the top currently reads:

```typescript
const { mockPitClearFuel, mockPitFuel, mockGetCommands, mockParseKeyBinding, mockGetGlobalSettings, mockTapBinding } =
  vi.hoisted(() => ({
    mockPitClearFuel: vi.fn(() => true),
    mockPitFuel: vi.fn(() => true),
    mockGetCommands: vi.fn(() => ({
      pit: {
        clearFuel: mockPitClearFuel,
        fuel: mockPitFuel,
      },
    })),
    mockParseKeyBinding: vi.fn(),
    mockGetGlobalSettings: vi.fn(() => ({})),
    mockTapBinding: vi.fn().mockResolvedValue(undefined),
  }));
```

Change it to add one mock:

```typescript
const {
  mockPitClearFuel,
  mockPitFuel,
  mockGetCommands,
  mockParseKeyBinding,
  mockGetGlobalSettings,
  mockTapBinding,
  mockTapBindingSequence,
} = vi.hoisted(() => ({
  mockPitClearFuel: vi.fn(() => true),
  mockPitFuel: vi.fn(() => true),
  mockGetCommands: vi.fn(() => ({
    pit: {
      clearFuel: mockPitClearFuel,
      fuel: mockPitFuel,
    },
  })),
  mockParseKeyBinding: vi.fn(),
  mockGetGlobalSettings: vi.fn(() => ({})),
  mockTapBinding: vi.fn().mockResolvedValue(undefined),
  mockTapBindingSequence: vi.fn().mockResolvedValue(true),
}));
```

Then, in the `ConnectionStateAwareAction: class MockConnectionStateAwareAction` block (around line 79), add the delegate immediately after `tapBinding = mockTapBinding;`:

```typescript
      tapBindingSequence = mockTapBindingSequence;
```

- [ ] **Step 6: Write the failing action tests**

Append this `describe` block inside the top-level `describe` in `packages/iracing-actions/src/actions/fuel-service/fuel-service.test.ts`. It reuses the file's existing `fakeEvent(actionId, settings)` helper, its `internals(action)` accessor, and its `METRIC_TELEMETRY` fixture — do not introduce new helpers.

```typescript
  describe("showBlackBox (#818)", () => {
    let action: FuelService;

    beforeEach(() => {
      action = new FuelService();
      internals(action).sdkController.getCurrentTelemetry.mockReturnValue(METRIC_TELEMETRY);
      mockTapBindingSequence.mockResolvedValue(true);
    });

    it("should not touch the black box when the setting is off", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l" }) as any);

      expect(mockTapBindingSequence).not.toHaveBeenCalled();
    });

    it("should show the Fuel black box before the value changes when enabled", async () => {
      await action.onKeyDown(
        fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l", showBlackBox: true }) as any,
      );

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxFuel"], 0);
      // Show-then-change: the sequence is dispatched before the SDK fuel command.
      expect(mockTapBindingSequence.mock.invocationCallOrder[0]!).toBeLessThan(
        mockPitFuel.mock.invocationCallOrder[0]!,
      );
    });

    it('should treat the string "true" from sdpi-checkbox as enabled', async () => {
      await action.onKeyDown(
        fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l", showBlackBox: "true" }) as any,
      );

      expect(mockTapBindingSequence).toHaveBeenCalledOnce();
    });

    it('should treat the string "false" from sdpi-checkbox as disabled', async () => {
      await action.onKeyDown(
        fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l", showBlackBox: "false" }) as any,
      );

      expect(mockTapBindingSequence).not.toHaveBeenCalled();
    });

    it("should show the black box for the keyboard lap-margin mode too", async () => {
      await action.onKeyDown(fakeEvent("action-1", { mode: "lap-margin-increase", showBlackBox: true }) as any);

      expect(mockTapBindingSequence).toHaveBeenCalledWith(["blackBoxLapTiming", "blackBoxFuel"], 0);
    });

    it("should still change the value when the sequence is skipped", async () => {
      mockTapBindingSequence.mockResolvedValue(false);

      await action.onKeyDown(
        fakeEvent("action-1", { mode: "add-fuel", amount: 5, unit: "l", showBlackBox: true }) as any,
      );

      expect(mockPitFuel).toHaveBeenCalledWith(15);
    });

    it("should show the black box exactly once per press, not on every repeat iteration", async () => {
      vi.useFakeTimers();

      // onWillAppear populates activeContexts, which the repeat loop's execute reads.
      // `unit` is supplied so willAppear's one-shot unit-seeding setSettings is skipped.
      const ev = fakeEvent("action-1", { mode: "add-fuel", amount: 1, unit: "l", showBlackBox: true });
      await action.onWillAppear(ev as any);
      await action.onKeyDown(ev as any);

      // REPEAT_HOLD_THRESHOLD_MS is 400 and REPEAT_GAP_MS is 250, so 1500 ms
      // covers the threshold plus several repeats.
      await vi.advanceTimersByTimeAsync(1500);

      expect(mockPitFuel.mock.calls.length).toBeGreaterThan(1);
      expect(mockTapBindingSequence).toHaveBeenCalledOnce();

      await action.onKeyUp(ev as any);
      vi.useRealTimers();
    });
  });
```

Note on why the mocks give the expected keys: the mock `isBindingMissing` returns `false` for everything, so `showBlackBox` sees every black-box key as configured, and `resolvePrimeKey` picks its preferred `blackBoxLapTiming`.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run packages/iracing-actions/src/actions/fuel-service/fuel-service.test.ts`
Expected: FAIL — `mockTapBindingSequence` never called

- [ ] **Step 8: Add the import and constant**

In `packages/iracing-actions/src/actions/fuel-service/fuel-service.ts`, add to the imports (near the existing `import { RepeatController } from "../../shared/repeat-controller.js";` at line 44):

```typescript
import { showBlackBox } from "../../shared/black-box.js";
```

Then add, immediately before the `/** Modes that support long-press repeat (execute at interval while held) */` comment at line 210:

```typescript
/**
 * The black box every Fuel Service keypad mode is readable in (#818): the fuel
 * to add, the fuel-fill checkbox, the autofuel toggle, and the lap margin all
 * live in iRacing's Fuel black box.
 */
const FUEL_BLACK_BOX_ID = "fuel" as const;

```

- [ ] **Step 9: Add the call site in `onKeyDown`**

In `packages/iracing-actions/src/actions/fuel-service/fuel-service.ts`, `onKeyDown` currently ends:

```typescript
    if (REPEATABLE_MODES.has(settings.mode)) {
      this.repeat.onKeyDown(ev.action.id, {
        holdMs: REPEAT_HOLD_THRESHOLD_MS,
        intervalMs: REPEAT_GAP_MS,
        safetyMs: REPEAT_MAX_DURATION_MS,
        execute: async () => {
          const current = this.activeContexts.get(ev.action.id);

          if (!current) return false;

          await this.executeMode(current.mode, current);

          return true;
        },
      });
    }

    await this.executeMode(settings.mode, settings);
  }
```

Insert the black-box call between the repeat block and `executeMode`:

```typescript
    if (REPEATABLE_MODES.has(settings.mode)) {
      this.repeat.onKeyDown(ev.action.id, {
        holdMs: REPEAT_HOLD_THRESHOLD_MS,
        intervalMs: REPEAT_GAP_MS,
        safetyMs: REPEAT_MAX_DURATION_MS,
        execute: async () => {
          const current = this.activeContexts.get(ev.action.id);

          if (!current) return false;

          await this.executeMode(current.mode, current);

          return true;
        },
      });
    }

    // Show the Fuel black box BEFORE the value changes, so the driver watches it
    // tick. Two constraints pin this exact position:
    //   - AFTER repeat.onKeyDown, whose timers must be armed before the first
    //     await (see the comment above).
    //   - In onKeyDown rather than executeMode, because the repeat loop calls
    //     executeMode directly. That gives "show once per press, never on a
    //     repeat iteration" for free — nothing can change the shown box between
    //     iterations. (#818)
    if (settings.showBlackBox) {
      await showBlackBox(FUEL_BLACK_BOX_ID, {
        isConfigured: (key) => !this.isBindingMissing(key),
        tapSequence: (keys, holdMs) => this.tapBindingSequence(keys, holdMs),
        logger: this.logger,
      });
    }

    await this.executeMode(settings.mode, settings);
  }
```

- [ ] **Step 10: Run it to verify it passes**

Run: `npx vitest run packages/iracing-actions/src/actions/fuel-service`
Expected: PASS

- [ ] **Step 11: Lint, format, and full verify**

```bash
pnpm lint:fix && pnpm format:fix && pnpm build && pnpm test
```

Expected: build 20/20 successful; all tests pass.

- [ ] **Step 12: Commit**

```bash
git add packages/iracing-actions
git commit -m "feat(fuel-service): show the Fuel black box on press when enabled (#818)"
```

---

### Task 6: Property Inspector — checkbox, seeded bindings, caveat component

**Files:**
- Create: `packages/pi-components/src/components/black-box-caveat.ts`
- Create: `packages/pi-components/src/components/black-box-caveat.test.ts`
- Modify: `packages/pi-components/src/components/index.ts` (add the export)
- Modify: `packages/iracing-actions/src/actions/fuel-service/fuel-service.ejs`

**Interfaces:**
- Consumes: `parseKeyBinding` from `./key-binding-input.js`.
- Produces: the `<ird-black-box-caveat>` custom element with attributes `enabled-setting`, `target`, `candidates` (JSON array of global keys), `message`.

- [ ] **Step 1: Write the failing component test**

Create `packages/pi-components/src/components/black-box-caveat.test.ts`:

```typescript
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./black-box-caveat.js";

const CANDIDATES = ["blackBoxLapTiming", "blackBoxStandings", "blackBoxFuel"];

const keyboardBinding = (key: string, code: string) => JSON.stringify({ type: "keyboard", key, modifiers: [], code });
const simhubBinding = (role: string) => JSON.stringify({ type: "simhub", role });

let globalSettings: Record<string, unknown> = {};
let subscriber: ((ev: { payload: { settings: Record<string, unknown> } }) => void) | null = null;

function installSdpiStub(): void {
  (window as unknown as { SDPIComponents: unknown }).SDPIComponents = {
    streamDeckClient: {
      getGlobalSettings: () => Promise.resolve(globalSettings),
      didReceiveGlobalSettings: {
        subscribe: (fn: (ev: { payload: { settings: Record<string, unknown> } }) => void) => {
          subscriber = fn;

          return () => {
            subscriber = null;
          };
        },
      },
    },
  };
}

/** Mount the checkbox the component reads, then the component itself. */
async function mount(enabled: boolean): Promise<HTMLElement> {
  const checkbox = document.createElement("sdpi-checkbox");
  checkbox.setAttribute("setting", "showBlackBox");
  (checkbox as unknown as { value: boolean }).value = enabled;
  document.body.appendChild(checkbox);

  const el = document.createElement("ird-black-box-caveat");
  el.setAttribute("enabled-setting", "showBlackBox");
  el.setAttribute("target", "blackBoxFuel");
  el.setAttribute("candidates", JSON.stringify(CANDIDATES));
  el.setAttribute("message", "Needs keyboard bindings.");
  document.body.appendChild(el);

  await Promise.resolve();
  await Promise.resolve();

  return el;
}

const isVisible = (el: HTMLElement) => el.textContent!.includes("Needs keyboard bindings.");

describe("ird-black-box-caveat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    globalSettings = {};
    subscriber = null;
    document.body.innerHTML = "";
    installSdpiStub();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should stay silent when the feature is disabled, even with no bindings", async () => {
    const el = await mount(false);

    expect(isVisible(el)).toBe(false);
  });

  it("should stay silent when target and a prime are keyboard-bound", async () => {
    globalSettings = {
      blackBoxLapTiming: keyboardBinding("f1", "F1"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(false);
  });

  it("should warn when the target binding is missing", async () => {
    globalSettings = { blackBoxLapTiming: keyboardBinding("f1", "F1") };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
  });

  it("should warn when the target is bound to a SimHub role", async () => {
    globalSettings = {
      blackBoxLapTiming: keyboardBinding("f1", "F1"),
      blackBoxFuel: simhubBinding("Fuel Box"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
  });

  it("should warn when no other box is available to prime with", async () => {
    globalSettings = { blackBoxFuel: keyboardBinding("f4", "F4") };
    const el = await mount(true);

    expect(isVisible(el)).toBe(true);
  });

  it("should accept any other keyboard-bound box as the prime", async () => {
    globalSettings = {
      blackBoxStandings: keyboardBinding("f2", "F2"),
      blackBoxFuel: keyboardBinding("f4", "F4"),
    };
    const el = await mount(true);

    expect(isVisible(el)).toBe(false);
  });

  it("should clear the warning when a binding arrives later", async () => {
    globalSettings = { blackBoxFuel: keyboardBinding("f4", "F4") };
    const el = await mount(true);
    expect(isVisible(el)).toBe(true);

    subscriber!({
      payload: {
        settings: {
          blackBoxLapTiming: keyboardBinding("f1", "F1"),
          blackBoxFuel: keyboardBinding("f4", "F4"),
        },
      },
    });

    expect(isVisible(el)).toBe(false);
  });

  it("should react to the checkbox being ticked", async () => {
    globalSettings = {};
    const el = await mount(false);
    expect(isVisible(el)).toBe(false);

    const checkbox = document.querySelector('sdpi-checkbox[setting="showBlackBox"]')!;
    (checkbox as unknown as { value: boolean }).value = true;
    vi.advanceTimersByTime(300);

    expect(isVisible(el)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/pi-components/src/components/black-box-caveat.test.ts`
Expected: FAIL — cannot resolve `./black-box-caveat.js`

- [ ] **Step 3: Create the component**

Create `packages/pi-components/src/components/black-box-caveat.ts`:

```typescript
/**
 * ird-black-box-caveat — explains, in the PI, why "Show black box" will do nothing.
 *
 * Showing a black box needs TWO keyboard bindings: the target box, and a
 * different box to prime the switch with (a black-box hotkey is a toggle, and
 * telemetry never reports which box is shown — see
 * `iracing-actions/src/shared/black-box.ts`). Both must be keyboard bindings:
 * a SimHub role goes over HTTP and cannot join the single atomic SendInput batch
 * that keeps the priming box from flickering, so the plugin skips the box
 * entirely rather than degrading. The value still changes either way.
 *
 * Rendered only when the feature checkbox is ticked AND the bindings can't do it.
 *
 * @example
 * <ird-black-box-caveat
 *   enabled-setting="showBlackBox"
 *   target="blackBoxFuel"
 *   candidates='["blackBoxLapTiming","blackBoxStandings"]'
 *   message="Showing the black box needs keyboard bindings…"
 * ></ird-black-box-caveat>
 */
import { parseKeyBinding } from "./key-binding-input.js";

/**
 * The checkbox is a per-action setting whose live value is only reliably
 * readable from the DOM (the same reason ird-binding-status polls). Global
 * binding values, by contrast, arrive on didReceiveGlobalSettings.
 */
const CHECKBOX_POLL_INTERVAL_MS = 250;

interface ValueElement extends Element {
  value?: unknown;
}

interface GlobalSettingsEvent {
  payload: { settings: Record<string, unknown> };
}

interface StreamDeckClient {
  getGlobalSettings(): Promise<Record<string, unknown>>;
  didReceiveGlobalSettings: { subscribe(fn: (ev: GlobalSettingsEvent) => void): unknown };
}

/** Escape a value for safe use inside a `[attr="…"]` selector. */
function cssAttr(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function streamDeckClient(): StreamDeckClient | null {
  const sdpi = (window as unknown as { SDPIComponents?: { streamDeckClient?: StreamDeckClient } }).SDPIComponents;

  return sdpi?.streamDeckClient ?? null;
}

/**
 * Whether a stored global binding value is a usable KEYBOARD binding.
 * A SimHub role, an empty value, or a corrupt one all return false.
 */
export function isKeyboardBinding(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;

  try {
    const parsed = JSON.parse(raw) as { type?: string };

    if (parsed.type === "simhub") return false;
  } catch {
    // Not JSON — fall through; parseKeyBinding rejects it below.
  }

  return parseKeyBinding(raw) !== null;
}

export class BlackBoxCaveat extends HTMLElement {
  private container: HTMLDivElement | null = null;
  private settings: Record<string, unknown> = {};
  private settingsLoaded = false;
  private pollTimer: number | null = null;
  private initialized = false;
  private readonly onDomChange = (): void => this.render();

  connectedCallback(): void {
    if (this.initialized) return;

    this.initialized = true;
    this.container = document.createElement("div");
    this.container.className = "ird-supporting-text";
    this.container.style.display = "none";
    this.appendChild(this.container);

    const client = streamDeckClient();

    if (client) {
      void client.getGlobalSettings().then((settings) => {
        this.settings = settings ?? {};
        this.settingsLoaded = true;
        this.render();
      });

      client.didReceiveGlobalSettings.subscribe((ev) => {
        this.settings = ev?.payload?.settings ?? {};
        this.settingsLoaded = true;
        this.render();
      });
    }

    document.addEventListener("change", this.onDomChange);
    document.addEventListener("input", this.onDomChange);
    this.pollTimer = window.setInterval(this.onDomChange, CHECKBOX_POLL_INTERVAL_MS);

    this.render();
  }

  disconnectedCallback(): void {
    document.removeEventListener("change", this.onDomChange);
    document.removeEventListener("input", this.onDomChange);

    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Read the feature checkbox's live value from the DOM. */
  private isEnabled(): boolean {
    const setting = this.getAttribute("enabled-setting");

    if (!setting) return false;

    const el = document.querySelector(`[setting="${cssAttr(setting)}"]`) as ValueElement | null;

    if (!el) return false;

    return el.value === true || el.value === "true";
  }

  private parseCandidates(): string[] {
    const raw = this.getAttribute("candidates");

    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw) as unknown;

      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }

  /** True when the bindings as configured cannot show the box. */
  private bindingsUnusable(): boolean {
    const target = this.getAttribute("target");

    if (!target) return false;

    if (!isKeyboardBinding(this.settings[target])) return true;

    // A prime is any OTHER keyboard-bound box.
    return !this.parseCandidates().some((key) => key !== target && isKeyboardBinding(this.settings[key]));
  }

  private render(): void {
    if (!this.container) return;

    // Never flash the caveat before the first global-settings delivery.
    const show = this.settingsLoaded && this.isEnabled() && this.bindingsUnusable();

    if (!show) {
      this.container.style.display = "none";
      this.container.textContent = "";

      return;
    }

    this.container.textContent = this.getAttribute("message") ?? "";
    this.container.style.display = "";
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ird-black-box-caveat")) {
  customElements.define("ird-black-box-caveat", BlackBoxCaveat);
}
```

- [ ] **Step 4: Export it from the bundle entry**

In `packages/pi-components/src/components/index.ts`, insert after the `BindingStatus` export:

```typescript
// Black Box Caveat - explains when "Show black box" can't work with the current bindings
export { BlackBoxCaveat } from "./black-box-caveat.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/pi-components/src/components/black-box-caveat.test.ts`
Expected: PASS (8 tests)

If the "should stay silent when the feature is disabled" case fails because `settingsLoaded` is false at assert time, keep the assertion — a hidden caveat is the correct state either way.

- [ ] **Step 6: Add the checkbox and caveat to the Fuel Service PI**

In `packages/iracing-actions/src/actions/fuel-service/fuel-service.ejs`, insert immediately after the closing `</div>` of `fueling-on-change-section` (line 62) and before the closing `</div>` of `keypad-settings` (line 63):

```ejs
			<sdpi-item label="Show black box">
				<sdpi-checkbox
					id="show-black-box"
					setting="showBlackBox"
					label="Show the Fuel black box when this key is pressed"
				></sdpi-checkbox>
			</sdpi-item>
			<div class="ird-supporting-text">
				Lets you see the value change in iRacing — including the autofuel lap margin,
				which no telemetry reports. iRacing never says which black box is open, so
				iRaceDeck switches through another box first; both keypresses are sent
				together, so you never see it.
			</div>
			<ird-black-box-caveat
				enabled-setting="showBlackBox"
				target="blackBoxFuel"
				candidates='<%= JSON.stringify(require("./data/key-bindings.json").blackBox.map(function (b) { return b.setting; })) %>'
				message="Showing the black box needs keyboard bindings for the Fuel black box and at least one other black box. Set them under Related Key Bindings. The fuel value still changes without them."
			></ird-black-box-caveat>
```

Note: `candidates` uses `<%=` (HTML-escaped) — the browser decodes it back to valid JSON on read, the same rule the `comms` attribute follows.

Note: this deliberately lists **all** black-box global keys, not just the two rendered as inputs — the component reads global settings directly, so it sees a box bound by the Black Box Selector PI too, and won't warn falsely.

- [ ] **Step 7: Seed the black-box bindings from this PI**

In `packages/iracing-actions/src/actions/fuel-service/fuel-service.ejs`, replace the `key-bindings-section` block (lines 171-175):

```ejs
		<div id="key-bindings-section" class="hidden">
			<%- include('global-key-bindings', {
				keyBindings: require('./data/key-bindings.json').fuelService
			}) %>
		</div>
```

with:

```ejs
		<div id="key-bindings-section" class="hidden">
			<%
			var __kb = require('./data/key-bindings.json');
			// The two black-box rows are here so this PI SEEDS their defaults (#818):
			// ird-key-binding writes its `default` into global settings the first time it
			// renders, and black-box-selector.ejs used to be the only template that did.
			// Without this, "Show black box" would silently do nothing for anyone who
			// never placed a Black Box Selector key.
			var __blackBoxRows = __kb.blackBox
				.filter(function (b) { return b.id === 'lapTiming' || b.id === 'fuel'; })
				.map(function (b) {
					return { id: b.id, label: 'Black Box: ' + b.label, default: b.default, setting: b.setting };
				});
			%>
			<%- include('global-key-bindings', {
				keyBindings: __kb.fuelService.concat(__blackBoxRows)
			}) %>
		</div>
```

- [ ] **Step 8: Reveal the bindings accordion when Show black box is on**

The accordion is currently hidden for the API modes, which would hide the very bindings the checkbox needs. In `packages/iracing-actions/src/actions/fuel-service/fuel-service.ejs`, replace the `updateVisibility` function and add a helper. The current function reads:

```javascript
			function updateVisibility(mode) {
				const fuelSettings = document.getElementById("fuel-settings");
				const keyBindings = document.getElementById("key-bindings-section");
				const fuelingOnChange = document.getElementById("fueling-on-change-section");

				if (FUEL_AMOUNT_MODES.includes(mode)) {
					fuelSettings?.classList.remove("hidden");
				} else {
					fuelSettings?.classList.add("hidden");
				}

				if (FUELING_ON_CHANGE_MODES.includes(mode)) {
					fuelingOnChange?.classList.remove("hidden");
				} else {
					fuelingOnChange?.classList.add("hidden");
				}

				if (KEYBOARD_MODES.includes(mode)) {
					keyBindings?.classList.remove("hidden");
				} else {
					keyBindings?.classList.add("hidden");
				}
			}
```

Replace it with:

```javascript
			// Remembered so the Show-black-box checkbox can re-run visibility on its own.
			let currentMode = "toggle-fuel-fill";

			function isShowBlackBoxOn() {
				const el = document.getElementById("show-black-box");
				return !!el && (el.value === true || el.value === "true");
			}

			function updateVisibility(mode) {
				currentMode = mode;

				const fuelSettings = document.getElementById("fuel-settings");
				const keyBindings = document.getElementById("key-bindings-section");
				const fuelingOnChange = document.getElementById("fueling-on-change-section");

				if (FUEL_AMOUNT_MODES.includes(mode)) {
					fuelSettings?.classList.remove("hidden");
				} else {
					fuelSettings?.classList.add("hidden");
				}

				if (FUELING_ON_CHANGE_MODES.includes(mode)) {
					fuelingOnChange?.classList.remove("hidden");
				} else {
					fuelingOnChange?.classList.add("hidden");
				}

				// The black-box keys live in this accordion too (#818), so an API mode with
				// Show black box ticked still needs it visible.
				if (KEYBOARD_MODES.includes(mode) || isShowBlackBoxOn()) {
					keyBindings?.classList.remove("hidden");
				} else {
					keyBindings?.classList.add("hidden");
				}
			}
```

Then, inside `initialize()`, immediately after the `if (modeSelect) { … }` block and before the `resolveController()` call, add:

```javascript
					const showBlackBox = document.getElementById("show-black-box");

					if (showBlackBox) {
						const reapply = () => updateVisibility(currentMode);
						showBlackBox.addEventListener("change", reapply);
						showBlackBox.addEventListener("input", reapply);

						// Polling fallback — sdpi component events can be unreliable.
						let lastChecked = isShowBlackBoxOn();
						setInterval(() => {
							const checked = isShowBlackBoxOn();
							if (checked !== lastChecked) {
								lastChecked = checked;
								reapply();
							}
						}, 100);
					}
```

- [ ] **Step 9: Rebuild the PI bundle and confirm the HTML carries the component**

```bash
pnpm --filter @iracedeck/pi-components build
pnpm --filter @iracedeck/iracing-plugin-stream-deck build
grep -c ird-black-box-caveat packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/fuel-service.html
grep -c blackBoxLapTiming packages/iracing-plugin-stream-deck/com.iracedeck.sd.core.sdPlugin/ui/fuel-service.html
```

Expected: both greps print `1` or more.

- [ ] **Step 10: Lint, format, and full verify**

```bash
pnpm lint:fix && pnpm format:fix && pnpm build && pnpm test
```

Expected: build 20/20 successful; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/pi-components packages/iracing-actions
git commit -m "feat(pi): add Show black box checkbox, seeded bindings, and caveat component (#818)"
```

---

### Task 7: User-facing documentation

**Files:**
- Modify: `packages/website/src/content/docs/docs/actions/pit-service/fuel-service.md` (all eight keypad mode sections)
- Modify: `packages/website/src/content/docs/changelog.mdx` (the `## 2.1.0` → `**Features**` list)

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1-6.
- Produces: nothing consumed by code.

- [ ] **Step 1: Define the shared setting blurb**

Every keypad mode gets the same self-contained block (the website rule requires each mode section to stand alone). This exact text, used eight times:

```markdown
#### Setting: Show black box

Off by default. When enabled, pressing the key opens iRacing's Fuel black box so you can watch the value change — most useful for the autofuel lap margin, which no telemetry reports.

iRacing never reveals which black box is open, and a black box hotkey is a toggle, so iRaceDeck presses a different box first and then the Fuel box. Both keypresses are sent as a single keystroke, so the intermediate box never appears on screen.

Requires keyboard bindings for the **Fuel** black box and at least one other black box — set them under **Related Key Bindings**. If either is missing, or is bound to a SimHub role instead of a key, the fuel value still changes but no black box opens.
```

- [ ] **Step 2: Add it to the four modes that currently have no settings**

In `packages/website/src/content/docs/docs/actions/pit-service/fuel-service.md`, the **Toggle Fuel Fill**, **Clear Fuel**, **Toggle Autofuel**, **Lap Margin Increase**, and **Lap Margin Decrease** sections each end with:

```markdown
#### Settings

- No additional settings
```

Replace that block, in each of those five sections, with the blurb from Step 1 (i.e. the `#### Setting: Show black box` heading and its three paragraphs).

- [ ] **Step 3: Add it to the three amount modes**

In the **Add Fuel**, **Reduce Fuel**, and **Set Fuel Amount** sections, append the blurb from Step 1 immediately after each section's `#### Setting: Unit` block and before the trailing `---`.

- [ ] **Step 4: Verify all eight modes carry it**

Run: `grep -c "#### Setting: Show black box" packages/website/src/content/docs/docs/actions/pit-service/fuel-service.md`
Expected: `8`

- [ ] **Step 5: Add the changelog entry**

In `packages/website/src/content/docs/changelog.mdx`, under `## 2.1.0` → `**Features**`, append one bullet at the end of the existing list:

```markdown
- Fuel Service keys can optionally pop iRacing's Fuel black box when pressed (off by default), so you can see the value you just changed — including the autofuel lap margin, which no telemetry reports. The box is switched with a single atomic keystroke pair, so there's no flicker.
```

Do not add a `**Bug Fixes**` line for this — it is a new feature in an unreleased version, and the "one change, one line" rule collapses it to this single bullet.

- [ ] **Step 6: Verify the website builds**

Run: `pnpm --filter @iracedeck/website build`
Expected: build succeeds; the changelog page renders at `/changelog/`.

- [ ] **Step 7: Lint, format, and full verify**

```bash
pnpm lint:fix && pnpm format:fix && pnpm build && pnpm test
```

Expected: build 20/20 successful; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/website
git commit -m "docs(website): document Fuel Service Show black box setting (#818)"
```

---

## After the plan: in-sim verification (blocking, before push/PR)

The design rests on one assumption no unit test can settle. Hand the build to the user and have them check, in iRacing:

1. **Does `holdMs = 0` register at all?** If iRacing samples keyboard state per frame rather than reading the message queue, a press that opens and closes inside one frame is invisible to it. If the box does not switch, raise `BLACK_BOX_SEQUENCE_HOLD_MS` in `packages/iracing-actions/src/shared/black-box.ts` to `16`, rebuild, and retest; escalate to `30` if needed.
2. **Does the priming (Lap Timing) box visibly flash** at whatever `holdMs` wins?
3. **Does the Fuel box end up shown from every prior state** — nothing shown, Fuel already shown, Lap Timing shown, some other box shown?
4. **Do Lap Margin ± work with the box shown, and with it hidden?** This settles whether those keys are black-box-context-dependent, which the `"Lap margin changes through the black box"` comment in `fuel-service.ts` hints at but does not establish. If they only work with the box open, that is a follow-up issue (the modes would need the box regardless of the checkbox).

Do **not** push or open a PR until the user has run these.
