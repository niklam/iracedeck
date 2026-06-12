# Template Expressions

Date: 2026-06-12
Issue: #192
Branch: `niklam/ir-192`

## Problem

Templates in Telemetry Display, Chat, and Race Admin could only substitute `{{variable}}` values verbatim. Users could not derive values — unit conversions (m/s → km/h, fuel kg → gallons), rounding, or conditional text — without requesting a new pre-converted variable for every use case (issue #192).

## Design Decisions

- **Syntax**: `{{= expression }}` alongside plain `{{variable}}` placeholders. `=` must immediately follow `{{`; variables are referenced bare with dot notation inside expressions (no inner braces).
- **Full operator/function set**: arithmetic `+ - * / %`, parentheses, comparisons `> < >= <= == !=` (non-associative — chaining is a parse error), ternary `?:`, string literals in single or double quotes, string concatenation via `+`; functions `round(x)`, `round(x, decimals)` (decimals must be a literal integer 0–20), `floor`, `ceil`, `abs`, `min`, `max`.
- **Hand-rolled zero-dependency evaluator**: tokenizer + recursive-descent parser + AST interpreter in `packages/iracing-sdk/src/expression-evaluator.ts`. No `eval()`/`new Function()` and no expression-library dependency — user-authored template strings must never reach a JS execution context.
- **Raw-value combined context**: `TemplateContext` became a `{ display, raw }` pair. Plain placeholders keep reading display-formatted strings (floats to 2 decimals, boolean-ish fields as Yes/No); expressions evaluate against raw full-precision values (numbers stay numbers, boolean-ish 0/1 telemetry fields stay 0/1).
- **Hybrid error model**: a parse error (typo) leaves the `{{= ... }}` placeholder verbatim in the output so the mistake is visible on the key; a runtime error (unknown variable, division by zero, non-finite result) renders an empty string.

## Architecture

Pipeline in `expression-evaluator.ts`: `tokenize` → `parseExpression` (recursive descent: ternary → comparison → additive → multiplicative → unary minus → primary/call) → `evaluateAst` → `formatResult`.

- **AST cache**: a `Map` keyed by expression source with FIFO eviction at 200 entries. Parse errors are cached too — templates re-resolve on every telemetry tick, and a typo must not re-parse each time.
- **Length cap**: expressions over 1000 characters are rejected before parsing and never stored as cache keys; the cap also bounds parser/evaluator recursion depth (both are recursive).
- **Single-pass resolution**: `resolveTemplate` (`template-resolver.ts`) uses one alternation regex matching `{{= expr }}` (lazy, bounded `{0,1000}` to mirror the evaluator cap) or `{{dot.notation}}`, so an unclosed `{{=` can't trigger a long scan. Consequence: `}}` cannot appear inside an expression string literal — the placeholder ends at the first `}}`.
- **Raw-first field builders**: context builders (`flattenContext`, `fieldsToMaps`, session fields in `template-context.ts`) produce both maps in one walk. The raw map omits unavailable (null/undefined) keys so expressions referencing them fail as unknown variables (→ empty string).
- **Prototype safety**: variable lookup uses `Object.hasOwn`, so prototype-chain names (`constructor`, `toString`) never resolve as variables.

## Formatting Rules

- Strings render as-is; booleans render `Yes`/`No`.
- Whole-number results render bare (`5`); other numbers render with two decimals (`0.33`).
- `round(x, n)` carries a fixed-decimals hint through to formatting — exactly `n` decimals (`round(10/2, 1)` → `5.0`). The ternary forwards its chosen branch's hint; all other constructs drop it.
- Non-finite results (division by zero, NaN) are runtime errors → empty string.

## Deliberately Not Done

- **Unit-conversion helper functions** (`kmh()`, `gal()`, …) — plain arithmetic already covers conversions; helpers can be added later without changing the syntax.
- **Chat / Race Admin specific work** — both already route through `resolveTemplate`, so expressions work there transparently; documented as supported, no code changes needed.
