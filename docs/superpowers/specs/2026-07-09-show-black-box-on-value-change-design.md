# Show the relevant black box when an action changes a value

_Design — 2026-07-09_

## Problem

Several action modes change an iRacing value that has **no telemetry readback**. The autofuel lap margin is the clearest example: nothing in the telemetry stream reports it, so a key that nudges it gives the driver no confirmation that anything happened. The value is only ever visible inside iRacing's black box overlay.

The black boxes always render live data, so simply having the right box on screen when the key fires solves the problem — for values with telemetry and without.

Two facts constrain any solution:

1. **Telemetry does not expose which black box is currently shown.** There is no variable for it.
2. **An iRacing black-box hotkey is a toggle.** Pressing the Fuel key when the Fuel box is already shown hides it. So a single press cannot guarantee the box ends up visible.

The consequence: to *guarantee* the Fuel box is shown, press some **other** box first (which deterministically replaces whatever was there), then press Fuel. Both presses must land inside one frame, or the driver sees the priming box flash.

## Current behavior worth knowing

- `sendScanKeys` in `packages/iracing-native/src/addon.cc` calls `SendInput` **once per key event** and blocks on `Sleep(100)` between the down-set and the up-set — on the JS main thread. Two sequential `tapBinding` calls would therefore mean ~200 ms of blocking plus a clearly visible priming box.
- The Fuel Service SDK modes do not use the keyboard at all. `getCommands().pit.fuel(...)` reaches iRacing through `irsdk_broadcastMsg` → `SendNotifyMessage(HWND_BROADCAST, ...)` (`irsdk_utils.cpp:358`), which posts asynchronously and returns immediately.
- `ird-key-binding` writes its `default` attribute into global settings the first time a Property Inspector containing it renders. `black-box-selector.ejs` is currently the **only** template that includes the `blackBox` binding list, so a user who never placed a Black Box Selector key has `blackBoxFuel` unconfigured, and `tapBinding` on it would silently do nothing.

## Scope

**In scope.** One `showBlackBox` checkbox on **Fuel Service**, unchecked by default, honoured by every keypad mode: `add-fuel`, `reduce-fuel`, `set-fuel-amount`, `clear-fuel`, `toggle-fuel-fill`, `toggle-autofuel`, `lap-margin-increase`, `lap-margin-decrease`. All eight are readable in the one Fuel black box, so the mode → box map is a constant, not a table.

**Out of scope.** The Fuel Service dial surface (the touch strip already renders the value); the Setup actions and their readback-less values (engine boost level, aero qualifying tape, chassis springs/shocks → In-car black box) — a natural follow-up once the shared mechanism exists; a plugin-global default; auto-hiding the box afterwards; changing `sendScanKeys`'s existing 100 ms hold.

## Design

### Layer 1 — native sequence primitive

`packages/iracing-native` gains one export:

```text
sendScanKeySequence(chords: number[][], holdMs = 0): void
```

Each `chord` is a scan-code array in the existing convention (modifiers first, main key last).

- **`holdMs === 0`** — build a single `INPUT` array containing, for each chord in order, its down events (in order) followed by its up events (in reverse), then issue **one** `SendInput` call. Nothing sleeps; nothing blocks. All events reach iRacing's input queue atomically, so both presses are consumed in the same frame and the priming box never renders.
- **`holdMs > 0`** — fall back to per-chord press → `Sleep(holdMs)` → release-in-reverse, the same shape as today's `sendScanKeys`.

Mirrored into `src/index.ts` and `src/mock-impl.ts` per the native ↔ TS ↔ mock rule, with a `mock-impl.test.ts` case.

`holdMs` exists so the press duration can be tuned from TypeScript after an in-sim test, without reopening the C++ file. The default is `0`.

### Layer 2 — `deck-core/keyboard-service.ts`

New callback type `ScanKeySequenceSender = (chords: number[][], holdMs: number) => void`, threaded through `initializeKeyboard()` as a fifth parameter, and a new interface method:

```text
sendKeySequence(combinations: KeyCombination[], holdMs?: number): Promise<boolean>
```

It resolves scan codes for every combination through the existing `buildScanCodes`. If **any** combination has no scan-code mapping, or the sequence sender was not supplied, it returns `false` — there is deliberately **no `keysender` fallback**, because a sequence cannot be expressed atomically there and a non-atomic one reintroduces the flicker the feature exists to avoid.

This pulls the full cross-package sync from `.claude/rules/keyboard-shortcuts.md`: `addon.cc` → `iracing-native/src/index.ts` → `keyboard-service.ts` → all three `plugin.ts` files → `keyboard-service.test.ts` → the rules → `iracing-native/CLAUDE.md`.

### Layer 3 — `deck-core/binding-dispatcher.ts`

```text
tapSequence(settingKeys: string[]): Promise<boolean>
```

Resolves each setting key from global settings. Returns `false` when any key is unset or bound to a SimHub role (a role goes over HTTP and cannot join a `SendInput` batch). Otherwise maps the bindings to `KeyCombination[]` and delegates to `sendKeySequence`, propagating its boolean.

`ConnectionStateAwareAction` gains a `tapBindingSequence(keys)` delegate mirroring the existing `tapBinding`.

### Layer 4 — `iracing-actions/src/shared/black-box.ts`

New shared module, alongside `setup-view.ts`, owning the iRacing-specific policy.

```text
BLACK_BOX_GLOBAL_KEYS: Record<BlackBoxId, string>
BLACK_BOX_SEQUENCE_HOLD_MS = 0
resolvePrimeKey(targetId, isConfigured): string | null
showBlackBox(targetId, deps): Promise<boolean>
```

`resolvePrimeKey` prefers `blackBoxLapTiming`. When the target *is* Lap Timing, or Lap Timing is unbound, it returns the first configured black-box key that is not the target, scanning `BLACK_BOX_GLOBAL_KEYS` in declaration order (lap-timing, standings, relative, fuel, tires, tire-info, pit-stop, in-car, mirror, radio, weather). It returns `null` when nothing else is bound, in which case `showBlackBox` sends nothing — a lone target press would toggle the box **off** half the time, which is worse than doing nothing.

`showBlackBox` then calls `tapBindingSequence([primeKey, targetKey])`.

The priming press is idempotent with respect to the target: whatever box was showing (including the target itself, and including a box that pages on repeated press) is replaced by the prime, and the target press then shows the target.

**Targeted cleanup carried by this change.** `BLACK_BOX_GLOBAL_KEYS` currently exists twice — as a `Record` in `black-box-selector.ts` and again as the `keybindBy` map in `comms-catalog.ts` — a duplication the package's own `CLAUDE.md` flags. The new shared module becomes its single home and both import it. `key-bindings.json` remains the data source and its existing cross-check test keeps guarding the pair.

### Layer 5 — the action

`showBlackBox` joins the flat keypad half of `FuelServiceSettings` using the standard string/boolean coercion, `.default(false)`.

The call site is in `FuelService.onKeyDown`, **after** `repeat.onKeyDown(...)` and **before** `executeMode(...)`. Both halves of that position are load-bearing:

- `repeat.onKeyDown` is armed synchronously before any `await` on purpose (see the comment at `fuel-service.ts:498`: awaiting first lets a `keyUp` slip through the yield and orphan the timers), so the box call cannot precede it.
- The repeat loop invokes `executeMode` directly. Putting the box call in `onKeyDown` rather than inside `executeMode` therefore yields "show once per press, never on repeat iterations" with no flag threaded through the call chain — which is exactly the specified behavior, since nothing can change the shown box between repeat iterations.

Show-then-change is the order. Both calls return immediately, so it costs nothing, the driver watches the value tick, and it is the only safe order if iRacing's lap-margin keys turn out to act on the currently-shown box.

The dial surface never calls it.

### Layer 6 — Property Inspector

- An `sdpi-checkbox` bound to `showBlackBox`, with **no** `default` attribute (`default="false"` renders checked). Placed in the keypad settings section near `enableFuelingOnChange`.
- The existing *Related Key Bindings* accordion gets the `blackBoxLapTiming` and `blackBoxFuel` rows appended to its `fuelService` list. **This is not cosmetic**: rendering an `ird-key-binding` is what writes its `default` into global settings, so merely opening the Fuel Service PI seeds F1 and F4 and the feature works out of the box rather than silently doing nothing. The accordion, currently hidden for the API-only modes, must also become visible whenever `showBlackBox` is ticked — otherwise the bindings the checkbox depends on are unreachable from the mode that needs them.
- A new `ird-black-box-caveat` **web component** (in `@iracedeck/pi-components`) renders an `ird-supporting-text` line under the checkbox when the bindings as configured cannot show the box: the target is unset or a SimHub role, or no *other* black box is keyboard-bound to prime with. The value still changes in that case; only the box is skipped, and the action logs a debug line.

  A component rather than an EJS partial with inline script, for two reasons. It must read **global settings** live (`streamDeckClient.getGlobalSettings()` + `didReceiveGlobalSettings`) to see boxes bound from the Black Box Selector PI — a DOM-only read would see just the two rows this PI renders and warn falsely when, say, only Standings is bound. And `ird-binding-status` already establishes the pattern for a live, read-only status line, with unit tests. The Setup actions are the obvious second consumer.

### Comms catalog

Untouched. `showBlackBox` is not a way of talking to iRacing — it is a garnish on modes that already have one. No `⚠️` missing-binding overlay for a black-box binding: the mode works without it.

## Testing

- `mock-impl.test.ts` — the new native function logs its arguments.
- `keyboard-service.test.ts` — the batching path forwards chords and `holdMs` to the sender; an unmappable `code` returns `false` and does **not** reach `keysender`; a missing sender returns `false`.
- `binding-dispatcher.test.ts` — `tapSequence` returns `false` on an unset key and on a SimHub role; otherwise passes combinations in order.
- `shared/black-box.test.ts` — prime is Lap Timing by default; target-is-Lap-Timing picks the next configured box; Lap-Timing-unbound picks the first configured non-target; nothing bound returns `null`.
- `fuel-service.test.ts` — the box fires exactly once per press when enabled; never when unchecked; never on repeat iterations; after repeat arming and before `executeMode`; never from a dial event.

## Verification in the sim — results (2026-07-09)

The design rested on one assumption that could not be tested outside iRacing. It was tested and **holds**.

1. **Does `holdMs = 0` register at all?** — **Yes.** iRacing honours a zero-duration press delivered in a single `SendInput` batch. Across 31 logged presses: 31 sequences dispatched (`Sending scan code sequence: [0x3b] -> [0x3e] (holdMs=0)`), 0 skipped, 0 binding bailouts. `BLACK_BOX_SEQUENCE_HOLD_MS` stays at `0`; the fallback path is retained but unused.
2. **Does the priming box visibly flash?** — **Almost never.** The atomic batch guarantees delivery order, not that iRacing drains its input queue before rendering, so a rare single-frame flash of Lap Timing is possible when the events straddle a frame boundary. Observed as a "tiny, tiny flash" in a small minority of presses. Accepted; the docs say so rather than promising "never".
3. **Show-then-change ordering** — confirmed: the sequence dispatches ~3 ms before `pit.fuel` goes out, so the driver watches the value tick.
4. **Do Lap Margin ± work with the box hidden?** — **Still open.** If those keys turn out to act only on the currently-shown black box, the two lap-margin modes need the box unconditionally rather than behind a checkbox. Track separately; it does not block this change.

Keyboard injection requires iRacing to have focus; `focusIRacingIfEnabled()` already runs before every key handler.

**Diagnostic note.** `showBlackBox` is a **per-key** setting. During the first test it appeared broken because the ticked keys lived in a profile bound to `iRacingUI.exe`, which Stream Deck deactivates the moment the sim takes focus — the keys actually pressed were a different, un-ticked set. The `Key down settings: mode=…, showBlackBox=… (raw=…)` debug line in `onKeyDown` exists to make that distinction (never persisted vs persisted-but-false) visible in one glance.

## Rejected alternatives

- **Press the target twice.** Ends hidden when the box started hidden.
- **Two sequential `tapBinding` calls.** ~200 ms of blocked main thread and a clearly visible priming box — the outcome this design exists to avoid.
- **Run the box sequence and the value change on separate threads.** Buys no wall-clock: the fuel command is an async `SendNotifyMessage` and the box show is a `SendInput`, both sub-millisecond at `holdMs = 0`. For the two keyboard modes (Lap Margin ±, Toggle Autofuel) it would be a bug — two threads writing the one global keyboard input stream interleave, and the margin key could be delivered while Lap Timing is the shown box. If a non-zero `holdMs` ever makes the native call block, the fix is to offload the **single ordered sequence** to one detached thread, never two.
- **Fall back to sequential taps when a binding is a SimHub role.** Rejected in favour of skipping with a PI caveat: the flicker is the thing being designed away, and a silent skip with no explanation is a support ticket.
- **Seed the F1–F11 black-box defaults at plugin startup.** Would make a hardcoded Lap Timing prime always work, but it flips every black-box binding to "configured" for the #612 missing-binding warning, a behavior change well beyond this feature.

## Documentation to update in the same change

`packages/iracing-native/CLAUDE.md`; `.claude/rules/keyboard-shortcuts.md`; `.claude/rules/plugin-structure.md` (the `initializeKeyboard()` snippet gains a fifth callback); all three `plugin.ts` files; the website Fuel Service action page (settings table and a note on the mechanism); one `**Features**` line in `packages/website/src/content/docs/changelog.mdx`.
