# View FFB Force — a display mode for the Force Feedback key

> **Issue:** [#1268](https://github.com/niklam/iracedeck/issues/1268) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

iRacing reports the wheel's FFB max force directly as `SteeringWheelMaxForceNm` (typed on `TelemetryData` in `iracing-native/src/defines.ts`); nothing is calculated. The Force Feedback dial already shows it on its touch strip (#802, `formatDialValue` in `force-feedback-dial-surface.ts`). The keypad surface never subscribes to telemetry, so a key only ever shows a static increase / decrease / auto icon. A Telemetry Display key with `{{= round(telemetry.SteeringWheelMaxForceNm, 1) }} Nm` works today, but it is undiscoverable and sits on a different key from the one that changes the value.

The Setup actions already solved "show a live value on a key, and optionally adjust it" with their View modes (#541, #540): a read-only Mode entry rendered by `shared/setup-view.ts`, with an opt-in dual press that taps one direction on a short press and the other on a long press.

## Decision

Force Feedback gets one new keypad Mode, **View FFB Force** (`view-ffb-force`), built on the Setup View machinery rather than beside it.

- **Mode list.** A third `<optgroup label="Display value">` after the existing two groups, holding one option, `View FFB Force` — the same group label and `View …` wording the Setup actions use. The Direction item is hidden for it, as it is for the Setup Views.
- **Rendering.** A `view-ffb-force` entry in `VIEW_DEFS`: `telemetryField: "SteeringWheelMaxForceNm"`, label `FFB FORCE`, `adjustmentMode: "ffb-force"`. The key renders through `generateSetupViewSvg`, so it takes the global colours, title, border and the binding-missing warning exactly as a Setup View does. `ViewSettingId` gains the id; the registry's doc comment stops saying "setup-action" only, but the module is not renamed — it stays the one home of View definitions.
- **One formatter.** The Nm formatting (one decimal, ` Nm` suffix, `VIEW_NULL_VALUE` / `---` for a missing or non-finite value) moves into `setup-view.ts` as `formatForceNm`, used by the `VIEW_DEFS` entry. The dial's `formatDialValue` calls it for `ffb-force`, so key and touch strip cannot drift apart. The dial surface's comment that says this value has no `view-*` entry is rewritten. The dial's output does not change.
- **Font size.** Whatever size keeps `99.9 Nm` inside the key edges — decided on the icon preview, as the `%` entries were. A value of 100 Nm or more is not a real wheel setting and may crowd.
- **Telemetry.** The keypad `onWillAppear` subscribes to `sdkController` for every keypad instance and re-renders only when the stored mode is `view-ffb-force` **and** the formatted value differs from the last one rendered (a per-context `lastRenderedValue` map, cleared on disappear and on a settings change) — the `setup-chassis.ts` pattern. Non-View keys therefore cost one map lookup per tick and never call `setKeyImage` from telemetry.
- **Dual press.** `dualPressEnabled` joins `ForceFeedbackSettings` with the Setup schema's exact shape (boolean-or-string, default `true`). On a View key with it on, `DualPressTracker` classifies the release: the tap direction is the plugin-wide `dualPressDirections` global setting, the long press the opposite, and the key taps `cockpitMiscFfbForceIncrease` / `cockpitMiscFfbForceDecrease` — the same bindings FFB Force already uses. With it off, a press does nothing. The PI includes the shared `dual-press-overrides` partial, shown only for the View mode. The default is `true` because it is the Setup Views' default and a user picking this mode expects the key that shows the force to change it; it cannot alter any existing key, since no existing key is in this mode.
- **Comms.** `comms-catalog.ts` gains `"view-ffb-force": pair("cockpitMiscFfbForceIncrease", "cockpitMiscFfbForceDecrease")` under `force-feedback`, like the Setup `view-*` entries, so the binding-status row and the missing-binding warning cover both keys. `action-comms.json` is regenerated.
- **No black box.** iRacing has no black box for FFB, so the mode has no Show Black Box option.
- **No LFE Views.** iRacing reports no telemetry for wheel or bass-shaker LFE, so there is nothing to show.

## Alternatives rejected

- **A "show value" checkbox on the existing FFB Force increase/decrease keys** (the first draft of the issue). It gives one Mode two render paths, and it duplicates what the View pattern already does with dual press, which makes one key both show and adjust. Users of the Setup actions already know the View shape.
- **A local renderer in the Force Feedback action** instead of a `VIEW_DEFS` entry. It would copy the value-slot layout, font sizing and binding warning that `generateSetupViewSvg` owns, and the two would drift apart.
- **Telling users to use Telemetry Display.** That's fine as a stopgap in the Discord reply, but it's not the answer: the value belongs on the FFB action, where people look for it.

## Out of scope

- A View mode or live value on **Cockpit Misc**. Its FFB keys share the bindings (#827) but the FFB readout moved to Force Feedback on purpose.
- **Paired adjust key styles** (the Setup actions' `adjustStyleSettingsFields`) for the FFB Force increase/decrease keys. That is a separate enhancement if anyone asks.
- Any change to the dial surface beyond sharing the formatter.
- LFE, Auto Compute FFB Force, and any new iRacing binding.

## Testing

Suite:

- `setup-view.test.ts`: `formatForceNm` (a normal value, a value that rounds, `undefined`, `NaN`, `Infinity`), and `formatViewValue("view-ffb-force", …)` returning that string.
- `force-feedback-dial-surface.test.ts`: the existing dial output is unchanged (`11.5 Nm`, `---`).
- `force-feedback.test.ts`: the schema accepts `view-ffb-force` and defaults `dualPressEnabled` to `true` (and parses `"false"` as `false`); the View key renders the value; a telemetry tick with an unchanged formatted value does not call `setKeyImage` again, and a changed one does; a non-View key never re-renders from telemetry; dual press taps increase on a short press and decrease on a long one under `tap-increases`, and the reverse under `tap-decreases`; with dual press off, a press sends nothing.
- The comms catalog freshness test, and regenerated icon previews if the icon set changes.

Manual, on a Stream Deck in iRacing:

- The key shows the same number as the Force Feedback dial and as iRacing's own FFB max force, and follows a change made in the sim's options.
- Short and long press step the force in the configured directions, and the key follows within a tick.
- What the key shows in the garage, in a replay and with iRacing closed (`---` expected when there's no value). Confirm this in the sim rather than assuming it, and record what `SteeringWheelMaxForceNm` actually reports outside the car.
- The key reads cleanly in the Default, Black Box and Inverted key icon types.
