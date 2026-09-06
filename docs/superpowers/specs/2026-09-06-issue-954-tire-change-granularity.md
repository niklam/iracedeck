> **Issue:** [#954](https://github.com/niklam/iracedeck/issues/954) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Tire Service: per-car tire-change granularity

## The problem

Tire Service's `toggle-tires` mode lets a key be configured for any subset of the four corners and sends the matching `#t` macro from `buildTireToggleMacro`. Nothing asks whether the car can change one corner on its own. On a car that only accepts all-four, a key configured for LF is asking for something the pit crew cannot do, and the key's dynamic icon — which colours "configured" from the settings and "on" from `PitSvFlags` — then draws a single-tire selection that will never come true.

iRacing already answers the question. The 2026-08-14 captures show a car publishes exactly the `dp*TireChange` fields matching its granularity, which is the presence-is-capability pattern `telemetry-features.ts` already uses for `hasPitLimiter` / `hasVisor` / `hasWipers`. All seven names exist in `docs/reference/telemetry-vars.json` — `dpLFTireChange`, `dpRFTireChange`, `dpLRTireChange`, `dpRRTireChange`, `dpLTireChange`, `dpRTireChange`, `dpTireChange` — and none are typed in `TelemetryData` or read anywhere.

Maintainer ruling (2026-09-06): the test cars are GT3s (per corner), **Super Formula Lights** (all four at once, replacing the DW-12 the issue body names) and ARCA (the per-side candidate, to be confirmed in the sim). The granularity must come from the published fields, never from a car list.

## What ships

A `getTireChangeGranularity()` helper, a coercion applied to the requested set before the macro is built, and an icon that draws the coerced set. No new setting, no new action, no change to the communication method.

## Decisions

### 1. Finest published level wins; absence means no coercion

`getTireChangeGranularity(t): "corner" | "side" | "all" | null` returns `"corner"` if **any** of the four corner fields is present, else `"side"` if either side field is, else `"all"` if `dpTireChange` is, else `null` (disconnected, or a car publishing none of the seven).

An unexpected combination — corner *and* `dpTireChange`, say — therefore resolves to the **finer** level, and `null` coerces nothing. The two failure modes are not symmetric. Over-coercion changes tires the user did not ask for: it costs stop time in a real race, and it would land on the majority car class (GT3) on the strength of a field combination nobody has captured. Under-coercion sends a request the sim then handles as it does today, which is the status quo this issue improves on rather than a regression. So the rule is: trust the finest capability the car advertises, and when the telemetry says nothing, behave exactly as before.

### 2. Coercion expands the set; the macro follows

`coerceTireRequest(tires, granularity)` leaves the set alone for `"corner"` and `null`, expands any corner to its side pair for `"side"`, and expands any non-empty set to all four for `"all"`. An empty set stays empty and still hits the existing "No tires configured" warning.

A useful property falls out: on a side or all car the coerced set is always all-four, left, or right, so `buildTireToggleMacro` always returns one of `#!t` / `#!l` / `#!r` and never a per-corner `!lf` list. The coerced path only ever sends the shorthand macros — which is what the website already claims works on coarse cars.

The coercion sits in the action, not in `Commands`. The per-corner SDK wrappers (`pit.leftFront()`, `pit.leftTires()`, …) stay raw: they are a thin broadcast surface with no telemetry read, and no action calls them today.

### 3. The toggle still toggles, and it compares against the coerced set

Where the coerced request already equals what is checked, the key **still toggles it off**. That is the documented Select-mode behaviour ("if the configured tires are already the only ones selected, pressing the button clears them"), and a granularity-only exception to it would be a second rule for one car class.

Select mode's `doCurrentTiresMatch` must be given the **coerced** set. Comparing the raw configured set instead would never match on a coarse car — a key configured for LF on a Super Formula Lights would clear and re-send on every single press. Because that comparison is corner-by-corner against the coerced set, the group's on/off reading is **all-of**: a group counts as on only when every corner in it is set. Any-of was rejected — a group observed half-set for one tick would read as on, and the next press would turn it off, which is the wrong direction and skips the clear.

### 4. The icon shows the coerced set; the PI does not change

The icon's "configured" half draws the coerced set, so a single-corner key on a coarse car shows all four as configured and never suggests a change the car cannot make. Its "on" half stays the raw `PitSvFlags` readback, which is truth. With `null` granularity it falls back to the configured set — today's disconnected rendering, unchanged.

The Property Inspector keeps its four checkboxes and gains one `ird-supporting-text` line saying the request is expanded to what the car supports. Greying or unchecking corners per car was rejected: granularity is a live telemetry fact that changes when the driver swaps car, a PI is edited in the garage and between sessions, and a control that rewrites a stored choice when a list narrows is exactly what "never delete user choices" forbids.

### 5. The sim capture comes first

The coercion rests on three things nobody has measured, so the first task of the implementation is a capture per car — GT3, ARCA, Super Formula Lights:

1. What iRacing does with `#!lf` on an all-four car: ignore it, or apply it to all four?
2. What `PitSvFlags` reports on side and all cars — all four corner bits together, or only the group's?
3. Whether `#!l` / `#!r` are accepted on an all-four car, as the website's current wording claims.

If (1) shows the sim already coerces the request, the change is still worth shipping — the icon telling the truth, and Select mode not issuing a clear on every press, are the remaining value — and the decisions above stand. If (2) shows the bits are not per-corner on coarse cars, what changes is the readback mapping in `getTireState`, not the coercion rule. ARCA's per-side classification is confirmed by (2) or the per-side test car changes; the code does not.

### 6. No comms change

Both `#t` modes stay `chat` in `comms-catalog.ts`; `action-comms.json` and the `#612` binding-status line are untouched, as are every manifest and `plugin.ts`. The website's Toggle Tires section gains a paragraph naming the three granularities and what a coarse car does with a partial request, and its existing shorthand-macro sentence is checked against capture (3).

## Verification

The sim capture above, first. Then unit tests: the helper for corner, side, all, absent, and the corner-plus-all combination; the coercion matrix for every input set at each level, including the empty set and `null`; `buildTireToggleMacro` on coerced sets (side to `#!l`/`#!r`, all to `#!t`); `doCurrentTiresMatch` against a coerced set; the icon content for a coerced key. Then manual, on all three cars: a single-corner key changes one corner on a GT3, the side pair on ARCA, all four on a Super Formula Lights — and in each case the icon matches what the pit black box shows.

## Affected artifacts

- `@iracedeck/iracing-native`: the seven `dp*TireChange` fields typed in `defines.ts` as optional numbers.
- `@iracedeck/iracing-sdk`: `getTireChangeGranularity` in `telemetry-features.ts`, plus tests.
- `@iracedeck/iracing-actions`: `tire-service.ts` (coercion, the match check, icon content), `tire-service.ejs` (the supporting-text line), `tire-service.test.ts`.
- Website: `docs/actions/pit-service/tire-service.md`, changelog under **Improvements**, then `pnpm generate:changelog-data`.
- The `iracedeck-actions` skill where the tire modes are described.
- No plugin, manifest, comms-catalog or settings-schema change.
