# Fuel Service: a second mode on a long press

> **Issue:** [#1729](https://github.com/niklam/iracedeck/issues/1729) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

A Fuel Service key does one thing: its Mode. Holding Add Fuel or Reduce Fuel repeats the step (#333's `RepeatController`, 400 ms hold, a step every 250 ms once the previous one has landed, #1314); holding any other mode does nothing more. The request is a second Fuel Service mode on a long press, the way Car Control's Wipers and Visor (#1463), the setup keys' View sub-modes (#540) and Pit Crew's Corner Names (#1699) already split a tap from a long press. Niklas decided the scope: Fuel Service only, not a framework across actions, with the pattern recorded so other actions can follow it (section 9). The issue carries the request; this records how.

## Decisions

### 1. Two new per-key settings

Both are new keys in `FuelServiceSettings` (`fuel-service/fuel-service-settings.ts`), flat beside `mode` and `amount`, because the keypad settings are flat and stay so (#759). They are read on the keypad surface only.

```typescript
export const FUEL_SERVICE_LONG_PRESS_MODES = ["none", ...FUEL_SERVICE_MODES] as const;

longPressMode: z.enum(FUEL_SERVICE_LONG_PRESS_MODES).default("none").catch("none"),
longPressAmount: z.preprocess(commaToDot, z.coerce.number().min(0).default(1)).catch(1),
```

| Key | Values | Default | PI label |
| --- | --- | --- | --- |
| `longPressMode` | `none` and the eight keypad modes, spelled exactly as `mode`'s values | `none` | Long press |
| `longPressAmount` | a number ≥ 0, comma or dot decimal | `1` | Long press amount |

- **Backward compatible by construction.** A key stored before this change has neither key and parses to `longPressMode: "none"`, which is today's behaviour exactly, hold-to-repeat included. No migration, no fresh-key seed, no `willAppear` write. The one-shot unit write in `onWillAppear` spreads the raw settings (`{ ...raw, unit }`), so it keeps both new keys once they exist.
- **`.catch` on both, so a bad value never costs the key its mode.** `parseFuelServiceSettings` falls back to full defaults when the whole parse fails, which would reset the stored Mode and Amount (the reason `unit` and `showBlackBox` already catch). An unknown `longPressMode` (a later version's value, a hand-edited profile) reads as `none`, so an unknown gesture never sends a fuel command the user did not pick: the rule #1699 set with `cornerNamesLongPress`. A malformed or negative `longPressAmount` reads as `1`.
- **The values are the Mode values, not a new vocabulary.** A long-press mode is one of the key's own modes, so `executeMode` runs it unchanged and the comms catalog's `fuel-service` entry already describes it (section 7). `none` is the sentinel every gesture slot in the repo uses.
- **One Unit per key.** Both outcomes use the key's existing `unit`, resolved as today (`resolveKeypadUnit`, `auto` following `DisplayUnits`, `k` through `DriverCarFuelKgPerLtr`). A driver works in one unit; a second Unit dropdown would only allow "tap adds 1 L, hold adds 1 gal", which nobody asked for. The legacy-unit rule (`migrateLegacyUnit`) is untouched: `unit` is banked at the first appear, before the PI can persist either new key, so a key with a `longPressMode` and no `unit` cannot arise from the PI.
- **`longPressAmount` defaults to `1`, like `amount`.** A different default (say 10, the issue's example) would be a number invented for one example; the PI field shows the placeholder `1` and the user types what they want. Its sign follows the mode exactly as `amount`'s does: Reduce Fuel subtracts it, Set Fuel Amount targets it.
- **A persisted contract.** Both keys and every value are an action settings schema, `xhigh` in `code-review.md`; renaming either later needs a migration.

### 2. Which modes may be the long press

**All eight.** Every pairing the issue names works, and none is unsafe: tap Toggle Fuel Fill / hold Toggle Autofuel, tap Add Fuel 1 / hold Add Fuel 10, tap Add / hold Reduce, tap Toggle Fuel Fill / hold Clear Fuel, a lap-margin pair. Restricting the list would need a rule for which pairs are "sensible", and the PI cannot explain one better than the user can choose.

**A long press with nothing distinct to do is no long press.** The key behaves exactly as today (acts on key-down, Add and Reduce repeat while held) when:

- `longPressMode` is `none`; or
- `longPressMode` equals `mode` and the mode has no amount (two Toggle Fuel Fills); or
- `longPressMode` equals `mode`, the mode is an amount mode (Add, Reduce, Set), and `longPressAmount` equals `amount`.

Otherwise the press is classified on release (section 3). This is #1699's rule (a long press set to Nothing or to the tap's own target toggles on key-down) and #1463's visor-car rule: with no second outcome there is no reason to wait for the release, and an Add-1 / Add-1 key keeps its repeat. It lives in one pure, exported helper, `fuelKeyPress(settings): { kind: "down" } | { kind: "classify" }`, which `onKeyDown`, `onKeyUp` and `keyPressShape` all call, so the three can never disagree.

### 3. When a press acts

With a distinct long press:

- **Key-down records the press and does nothing else.** `onKeyDown` parses the settings, sees `classify`, and calls `DualPressTracker.recordKeyDown(contextId)` synchronously, before its first `await`. That ordering is load-bearing: since #1597 a context's `keyUp` does not wait for its `keyDown` handler (input events wait only for exclusive ones), so a recording placed after an await could lose a fast tap. No repeat is armed, no black box is shown, nothing is sent.
- **Key-up classifies and acts once.** `onKeyUp` stops any repeat as today, then `computeOutcome(contextId, "tap", "long")` against deck-core's live `getDualPressThresholdMs()`, the plugin-wide **Long-press threshold** on the Settings window's Dual-Press card (default 500 ms, 200–2000). The same threshold governs every tap/hold key and every dial, so one setting tunes them all. A tap runs `executeMode(settings.mode, settings)`; a long press runs `executeMode(settings.longPressMode, { ...settings, mode: settings.longPressMode, amount: settings.longPressAmount })`. The settings are the ones in the key-up event, as setup-aero and Pit Crew read them. The derived settings object is built by a pure exported helper (`fuelPressSettings(settings, "tap" | "long")`) so every path that reads `amount` (`executeSdkFuelAdjust`, the step check's log line, Set Fuel Amount) sees the long press's amount with no second code path.
- **A press acts once, at release, never at the threshold.** The repo's rule is that no timer decides execution (#540, #1463, #1699 all classify at release; #1699 rejected firing at the threshold). A long press therefore fires once even on Add Fuel: there is no repeat on a key with a long press, and holding longer changes nothing.
- **A stray release does nothing.** A `keyUp` with no recorded `keyDown` (the long press was set mid-press, or the key-down took the `down` path) makes `computeOutcome` return `undefined`, and the release sends nothing, as the tracker documents. `onWillDisappear` and `onDidReceiveSettings` clear the context's pending press beside the existing `repeat.clear`, so a settings change mid-hold ends the press rather than firing it under new settings.
- **The latency cost, accepted.** On such a key a tap acts when the finger lifts instead of when it lands, typically 80 to 200 ms later; a long press acts at release, after at least the threshold. That is the price #1463 and #1699 accepted for the same feature, and a user who wants key-down timing (or the repeat) leaves Long press at None.

**Hold-to-repeat is replaced on that key only.** A key whose long press is distinct never arms the `RepeatController`, whichever mode the tap is. Every other Fuel Service key, and every key stored before this change, repeats exactly as today: `REPEATABLE_MODES`, `REPEAT_HOLD_THRESHOLD_MS` (400), `REPEAT_GAP_MS` (250) and `REPEAT_MAX_DURATION_MS` are untouched.

**The fuel step check and its queue are unchanged.** A released Add or Reduce goes through `FuelStepper.sendFuelStep` like a key-down one (#1314), so a second press while a step is checked queues or supersedes as it does today, and the preserve-off decision (`runningKeypadPreserve`) is read the same way.

### 4. Show black box

**On a key with a distinct long press, the Fuel black box opens at release, just before the chosen outcome runs**, in the `onKeyUp` handler, with the same `showBlackBox(FUEL_BLACK_BOX_ID, …)` call and dependencies `onKeyDown` uses today. One checkbox covers both outcomes, because every Fuel Service mode is readable in the one Fuel box (#818), so which outcome the press turns out to be never changes which box to show.

- **Why release and not key-down.** #818's order is "box first, then the value", so the driver watches it change. Shown at key-down, the box's awaited key sends would run in the `keyDown` handler while the release, which since #1597 does not wait for it, runs the outcome: the value could change before the box opens, and a keyboard-mode outcome (Toggle Autofuel, a lap margin) could interleave its tap with the box's two presses. Showing it in the release handler keeps box-then-value in one `await` chain, exactly as the key-down path has it today. The box then opens when the press acts, which is also when the driver wants to see it; a stray release shows nothing.
- **Once per press, never per outcome.** The key-down path keeps its rule (shown after the repeat is armed, before the first execute, never on a repeat iteration); the release path shows it once per classified press.

### 5. Auto-enable fueling

**Unchanged and outcome-agnostic.** The global `enableFuelingOnChange` (the **Auto-enable fueling** checkbox) applies to whichever mode a press runs, because the preserve-off decision is made inside `executeMode`'s amount and lap-margin paths (`shouldPreserveFuelingState`), not from the key's tap mode. A tap Toggle Fuel Fill / hold Add Fuel key with Auto-enable fueling off adds fuel on a long press and restores the unchecked box afterwards, as an Add Fuel key does. The PI shows the checkbox when either the tap or the long-press mode is one it applies to (`FUELING_ON_CHANGE_MODES`). It stays keypad-only, as its supporting text says.

### 6. Press sounds

Fuel Service gains a `keyPressShape(ev)` member (#269), computed from the key-down event's settings through `fuelKeyPress`, the same read the press acts on:

| Key | Shape | Sounds |
| --- | --- | --- |
| distinct long press (`classify`) | `{ kind: "release", thresholdMs: getDualPressThresholdMs(), short: true, long: true }` | single bleep at a short release, double bleep at the threshold, never both |
| no long press (`down`), any mode, Add and Reduce included | `{ kind: "tap" }` | single bleep at key-down, never a double |

The second row is what the key already gets today from the wrapper's default, written out so the member covers every key. It keeps #269's decision that a hold-to-repeat key gets no double bleep, since letting go of a repeating key only stops it; #1686 was closed on exactly that reading, and this issue does not revisit it. The threshold is read at down, as the wrapper and every dual-press key do, and the accepted sub-millisecond disagreement between the wrapper's clock and the action's (#269) applies unchanged. `dialPressShape` and `touchPressShape` are not touched. `press-shape-coverage.test.ts` then finds `fuel-service.ts` among the sources that construct a `DualPressTracker` and holds it to declaring `keyPressShape`.

### 7. The key icon and the missing-binding warning

- **The icon shows the tap's mode, unchanged.** Art, default title, the amount label (`+1 L`) and the telemetry status bar all follow `mode`, as Wipers and Visor and Corner Names show what a tap does. No long-press marker on the key: #269 lists a key-image preview of a long outcome as follow-up work, and a key redrawn at the threshold is under the finger.
- **The #612 warning covers both outcomes.** The key's warning is `isBindingMissing([FUEL_SERVICE_GLOBAL_KEYS[mode], FUEL_SERVICE_GLOBAL_KEYS[longPressMode]])` (undefined entries drop out; `none` and the API modes have no key), so a key whose long press is Toggle Autofuel warns while that binding is unset. Unlike #1463's any-key rule, the user chose this long press on this key, so its binding is required. The same expression goes into every place the key computes the flag today: `updateDisplay`, both regenerate closures and `buildStateKey`'s `warn` part, so a binding set or cleared re-renders the key. When the classified long press's binding is unset, `tapBinding` sends nothing, as it does for a tap today.
- **The PI status line.** A second `<ird-binding-status mode-setting="longPressMode" comms='…'>` under the Long press select, fed from the same `fuel-service` comms entry. The catalog already lists all eight mode values and has no `none`, so the line says nothing for None and the right thing for every mode. No catalog or `action-comms.json` change.

### 8. The Property Inspector

One template, `fuel-service/fuel-service.ejs`, compiled for all three plugins, so Stream Deck, Mirabox and Ulanzi get the same layout. Inside `#keypad-settings` only, in this order:

1. **Mode** (unchanged; its label stays exactly "Mode", the terminology rule) and its status line.
2. **Amount**, shown when the tap's mode is an amount mode (as today).
3. **Long press**: an `sdpi-select` bound to `longPressMode`, `default="none"`, options **None** then the eight modes with the Mode dropdown's labels (Toggle Fuel Fill, Add Fuel, Reduce Fuel, Set Fuel Amount, Clear Fuel Checkbox, Toggle Autofuel, Lap Margin Increase, Lap Margin Decrease). It is not the action's Mode selector, so it is labelled for what it is, "Long press", matching the issue, the dial's **Long Press** slot and #1699's "Long press toggles". Its status line follows it.
4. **Long press amount**: an `sdpi-textfield` bound to `longPressAmount`, placeholder `1`, the same comma-to-dot input fix as Amount, shown when the long-press mode is an amount mode.
5. **Unit**, shown when either mode is an amount mode.
6. **Auto-enable fueling**, shown when either mode is in `FUELING_ON_CHANGE_MODES`.
7. **Show black box** (unchanged).

Under the Long press select, one `ird-supporting-text` line: "A long press is a hold past the Long-press threshold in iRaceDeck Settings. With a long press set, the key acts when you let go, and holding Add or Reduce Fuel no longer repeats." The Related Key Bindings accordion shows when either mode is a keyboard mode or Show black box is ticked. `updateVisibility` reads both selects; the long-press select gets the same `change` / `input` listeners and `window.irdPoll` fallback as the Mode select. The dial view (`#dial-settings`) is unchanged and never shows the new fields; `isDialSurface` keeps the keypad gates from running there.

### 9. The pattern, for the next action that wants one

Recorded so a later issue that gives another action a long press follows the same shape. No shared helper is extracted now: each of the four adopters (#540, #1463, #1699, this) resolves its outcomes from its own settings, and the shared part, `DualPressTracker` plus `getDualPressThresholdMs`, is already in deck-core.

1. **One per-key selector, `longPress<…>`, whose values are the action's own modes (or targets) plus `none`, defaulting to `none` and catching to `none`**, plus an amount or similar parameter only where the chosen mode has one. A key stored before the change then behaves as before with no migration.
2. **No distinct second outcome, no classification.** `none`, or the tap's own mode with the same parameters, keeps key-down timing and any hold behaviour the key had; one pure helper decides this and every handler calls it.
3. **Classify at release with deck-core's `DualPressTracker` against the global Long-press threshold**, recording at key-down before the first `await`, and clearing on `willDisappear` and `didReceiveSettings`. Never a timer that fires at the threshold.
4. **A distinct long press replaces whatever the hold did before on that key** (repeat, hold-to-engage), never both on one gesture.
5. **Declare `keyPressShape`**: `release` with `short` and `long` set when classifying, the key's previous shape otherwise.
6. **Per-press side effects** (a black box, an acknowledgment) run in the release handler, once, before the outcome, so they cannot race it.
7. **The icon follows the tap; the #612 warning covers both outcomes' bindings; the PI gets a "Long press" select with its own binding-status line**, beside the "Mode" select it never replaces.

`stream-deck-actions.md` gains a short subsection naming these seven points and pointing here.

### 10. Hosts

Keys deliver a real `keyUp` on all three hosts (#269's host section: Mirabox `adapter.ts`, Ulanzi `ulanzi-client.ts`), which the setup keys, Wipers and Visor and Corner Names already rely on, so the feature works on every host's keys with no per-host branch. The manual test confirms it on a Mirabox key.

## Alternatives rejected

- **Keep hold-to-repeat and fire the long press after the first repeat**, or at the threshold while the key is held. One gesture would do two things, and a timer would decide execution. The issue rejected it; so does the repo's release-time rule.
- **A long-press action on every key, as a framework.** Niklas's scope decision: Fuel Service first, the pattern recorded (section 9).
- **Restricting the long-press list** (for example, no same-mode pairs). Add 1 / Add 10 is the issue's headline example, and section 2's rule already turns a pair with nothing distinct into "no long press".
- **A second Unit setting for the long press.** Section 1.
- **A nested `longPress: { mode, amount }` object.** The keypad settings are flat by #759's decision, `sdpi-*` binds flat keys most simply, and the flat pair mirrors `mode` / `amount`. Rejected for consistency, not for capability.
- **Defaulting `longPressAmount` to 10**, or to the tap's `amount` when unset. The first invents a number; the second couples two stored fields so that editing Amount silently changes the long press.
- **Showing the black box at key-down on a classified key.** Section 4: since #1597 the release does not wait for the key-down handler, so the box and the value could arrive in the wrong order.
- **Warning only on the tap's binding** (#1463's any-key rule). That rule exists for a mode that picks its binding from the car; here the user picked the long press, and a silently dead long press is the bug the warning exists for.

## Out of scope

- **The fuel dial.** Its **Long Press** slot (`dial.longPressAction`, default Toggle Autofuel), Push, Push + Turn and touch gestures exist since #759 and are unchanged; the new keys are keypad-only, never read by `FuelDialSurface`, and never shown in the dial view. A Mirabox knob still completes every push at its down.
- **Long presses on any other action**, and a shared deck-core helper for them (section 9).
- **Revisiting #269's no-double-bleep rule for hold-to-repeat keys** (#1686, closed not planned).
- **A key-image hint of the long press**, or a hold preview on a key (#1120's preview is a dial-strip mechanism; #269 lists the key preview as follow-up).
- **A per-key threshold.** The plugin-wide Long-press threshold is the one threshold.
- **Changes to the repeat's timing, the fuel step check (#1314), the comms catalog, key bindings, icons or manifests.**

## Affected artifacts

- `packages/iracing-actions/src/actions/fuel-service/`: `fuel-service-settings.ts` (the two keys, `FUEL_SERVICE_LONG_PRESS_MODES`) and its test; `fuel-service.ts` (`fuelKeyPress`, `fuelPressSettings`, the `DualPressTracker`, `onKeyDown` / `onKeyUp` branching, the release-time black box, `keyPressShape`, the two-key warning) and `fuel-service.test.ts`; `fuel-service.ejs` (section 8). All three plugins get it through `plugin-runtime`'s shared action list and the shared template; no manifest, UUID or layout change.
- `docs/plugins/core/actions/fuel-service.md`: the Long press setting, per `action-documentation.md`.
- Website: `docs/actions/pit-service/fuel-service.md` (a Long press section in the `website-action-docs.md` format, and the Add / Reduce Fuel repeat sentences qualified "unless a long press is set"); `docs/features/press-sounds.md` (Fuel Service with a long press in the "acts when you let go" list, and Add / Reduce Fuel without one among the keys whose hold just repeats); a `Features` fragment, `changelog.d/1729-fuel-service-long-press.md`.
- `.claude/skills/iracedeck-actions/SKILL.md`: the Fuel Service entry gains the Long press setting (the mode count is unchanged).
- `.claude/rules/stream-deck-actions.md`: the section 9 subsection.

## Testing

Suite (`pnpm test` on the fuel-service files; review row `xhigh`, since an action settings schema changes, and the second read applies, since the key's press handling becomes a two-path state machine):

- **Settings** (`fuel-service-settings.test.ts`): `{}` and a pre-change stored key parse to `longPressMode: "none"`, `longPressAmount: 1`, with `mode`, `amount` and `unit` intact; each of the nine values round-trips; an unknown `longPressMode` reads `none` and a malformed or negative `longPressAmount` reads `1` without resetting the stored mode or amount; `"2,5"` reads 2.5; the legacy-unit rule still coerces a `mode`-without-`unit` key to `l` whether or not it carries `longPressMode`.
- **`fuelKeyPress`**: `down` for `none`, for the same non-amount mode, and for the same amount mode with an equal amount; `classify` for a different mode and for the same amount mode with a different amount.
- **No long press** (and a key stored before this change): key-down acts at once; Add and Reduce arm the repeat with the existing constants and repeat while held; key-up stops it; the black box shows at key-down once per press. These are today's tests, run against a key carrying `longPressMode: "none"` as well as one without it.
- **Tap**: with a distinct long press, key-down sends nothing and arms no repeat; a release under the threshold runs the tap's mode with `amount`.
- **Long press**: a release at or over the threshold runs `longPressMode` with `longPressAmount` and the key's unit, for each kind (an API toggle, an amount mode through the step check, a keyboard mode through `tapBinding`); Add 1 / Add 10 sends 10 on a long press and 1 on a tap; holding past the threshold for seconds still sends once and never repeats.
- **Positive control for the boundary**: a release exactly at the threshold is long, and a changed `dualPressThresholdMs` applies to the next press.
- **Stray and lifecycle**: a release with no recorded down sends nothing; `onDidReceiveSettings` and `onWillDisappear` mid-hold clear the pending press, and the following release sends nothing; key-down records before any await (a key-up delivered while the key-down handler is suspended still classifies).
- **Black box**: on a classified key it is shown once, at release, before the outcome's send, for both outcomes, and never at key-down; with Show black box off it is never shown.
- **Auto-enable fueling**: off, with fuel fill off, a long-press Add Fuel sends its step and then the preserve clear, and a long-press lap margin sends the forced clear, as the same modes do as taps.
- **`keyPressShape`**: `release` with the live threshold, `short` and `long` true for a classified key; `tap` for every `down` key including Add and Reduce.
- **Warning**: an API tap with a keyboard long press whose binding is unset draws the warning; setting the binding re-renders without it; `none` adds nothing to the check.
- **PI** (`src/pi-templates/` tests): the Long press select binds `longPressMode` with default `none` and the nine options; the Mode label is still exactly "Mode"; the long-press amount field binds `longPressAmount`; a second binding-status line names `longPressMode`; none of the new fields is inside `#dial-settings`.

By hand (Niklas, in iRacing, on a Stream Deck and a Mirabox key):

- Tap Toggle Fuel Fill / hold Toggle Autofuel: a tap flips fuel fill on release, a hold flips autofuel on release, never both; the key still shows the fuel-fill art and amount.
- Tap Add Fuel 1 / hold Add Fuel 10 (and in a gallon car, e.g. the Global MX-5): a tap adds one step, a hold adds ten liters once, holding longer does not repeat.
- An Add Fuel key with Long press None: holding repeats exactly as before.
- Show black box on a classified key: the Fuel box opens as the press acts and the value changes in it.
- Press sounds on Both: a short release bleeps once, a hold bleeps twice at the threshold and not again; an Add Fuel key without a long press bleeps once at down and never twice.
- A Toggle Autofuel long press with its binding unset: the key shows the warning and the PI line under Long press says so.
- The fuel dial: unchanged, its PI shows none of the new fields.
