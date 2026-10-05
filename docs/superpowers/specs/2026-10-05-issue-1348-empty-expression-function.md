# `empty()` in template expressions

> **Issue:** [#1348](https://github.com/niklam/iracedeck/issues/1348) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

A `{{= … }}` expression that reads a variable the context does not have fails as a whole: `evaluateAst` throws `ExpressionRuntimeError("Unknown variable …")` and `resolveExpression` renders `""`. That is the normal state for part of the variable space. When a driver slot has no car (`race_ahead` while leading, `focused` on a scenic camera), `fieldsToMaps` leaves the slot's number fields (`position`, `class_position`, `lap`, `laps_completed`, `irating`, `irating_change`, `irating_new`) out of the raw map, so they are not found. The text fields hold `""`, and the website already teaches `x ? x : y` as the fallback for them, but that idiom cannot help with a missing number. It also reads a real `0` as missing. Nothing in the language can ask "is this value here?" without blanking the expression.

## Decision

### 1. `empty(path)` returns a boolean

`empty(x)` is `true` when the lookup for `x` reports `found: false`, when it reports `found: true` with an `undefined` value, or when the value is the empty string `""`. Every other value is not empty, including `0`, `false` and a whitespace-only string. The result is an ordinary boolean, so it works as a ternary condition, compares like any boolean (`empty(x) == 0`), and renders `Yes` / `No` if it is the final result.

`0` and `false` are deliberately not empty, unlike PHP's `empty()`. In this variable space a zero is data: `self.incidents` 0, lap 0, an iRating change of 0, `telemetry.OnPitRoad` 0. The maintainer chose the strict reading (2026-10-05).

`null` needs no rule of its own. `ExpressionValue` has no `null`: `fieldsToMaps` omits null and undefined values from the raw map, and `formatLeaf` reports a null or undefined leaf as not found. A null value therefore arrives as `found: false`. The evaluator still treats a `null` value defensively as empty, so a future lookup that passes one through cannot change the answer.

### 2. The argument is exactly one variable path, checked at parse time

`buildCall` accepts `empty` only with a single argument whose node is `{ type: "variable" }`. Anything else is an `ExpressionParseError`: no argument, two arguments, a literal (`empty('')`), an arithmetic expression (`empty(a + 1)`), or a nested call. A parse error renders the template source verbatim, which is how a user spots a mistake. The parse-error cache already covers it.

This keeps the meaning exact: `empty` answers whether one value is present. With an arbitrary expression it would have to decide whether a missing variable deep inside means "empty" or still blanks the result, and either answer surprises someone. The maintainer chose the restriction (2026-10-05).

### 3. `empty` is the one construct that does not throw on a missing variable

`evaluateCall` currently converts every argument to a number before switching on the function name. `empty` has to branch before that conversion. It calls `lookup(path)` directly rather than `evaluateAst` on its argument, so the unknown-variable error never arises. No other construct changes: a bare missing variable anywhere else still fails the expression.

The ternary already evaluates only the branch it picks, so the motivating pattern is safe:

```text
{{= empty(race_ahead.position) ? '--' : 'P' + race_ahead.position }}
```

renders `--` with no car ahead, and the `'P' + race_ahead.position` branch is never evaluated.

### 4. Consequences accepted

- **A typo reads as empty.** `empty(race_ahaed.first_name)` is `true`, so the fallback shows instead of a blank. Today the same typo renders a silent `""`, so no error that was visible before is hidden now. The website page says so next to the function.
- **A path that is not a leaf reads as empty.** The context answers `found: false` for a path ending at an object or an array (`sessionInfo.DriverInfo`) and for the excluded `telemetry.CarIdx*` arrays, so `empty()` is `true` for them. That matches what an expression can read: none of them is a value it could use.
- **There is no negation operator.** "Not empty" is written by swapping the ternary's branches. This change does not add `!`.

## Out of scope

- Logical operators (`!`, `&&`, `||`) and a null-coalescing operator (`a ?? 'Unknown'`). `??` would be shorter for the exact fallback pattern, but `empty()` composes with any ternary and was the form requested. Either can be added later without touching `empty`.
- Treating whitespace-only strings, `0` or `false` as empty.
- Any change to what the template context reports as found. Which fields are omitted when a slot is empty stays as `fieldsToMaps` decides it.
- Plain `{{path}}` placeholders. They already render `""` for a missing path and are unaffected.

## Testing

Unit tests in `packages/iracing-sdk/src/expression-evaluator.test.ts`:

- `empty` is `true` for a not-found path, a found path with an `undefined` value, and `""`.
- `empty` is `false` for `0`, `false`, `"0"`, a whitespace-only string, a non-zero number and a non-empty string.
- Parse errors (`resolveExpression` returns `null`) for `empty()`, `empty(a, b)`, `empty('')`, `empty(1)`, `empty(a + 1)` and `empty(round(a))`.
- The ternary pattern: `empty(missing) ? '--' : 'P' + missing` renders `--`, and with the variable present it renders `P3`, which proves the untaken branch is never evaluated.
- A bare `empty(x)` result renders `Yes` / `No`.
- A missing variable outside `empty` still renders `""`, a regression guard on decision 3.

A resolver-level case in `template-resolver.test.ts` runs the issue's example through a real context: an empty `race_ahead` slot gives `'Unknown'` for `first_name`, and `'--'` for `position`.

Manual: on a Telemetry Display key, set `{{= empty(race_ahead.position) ? '--' : 'P' + race_ahead.position }}`. While leading, the key shows `--`. Behind another car it shows that car's position. A typo in the function name (`emty(…)`) leaves the template text visible on the key.
