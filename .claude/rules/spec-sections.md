---
paths:
  - "docs/superpowers/specs/**"
  - "scripts/claude-hooks/**"
---

# The required spec sections — what the commit check reads

The heading grammar behind *Required sections* in `@.claude/rules/specs-and-plans.md`, for whoever writes a spec or edits the spec-commit rule in `rules-bash.mjs`. Moved out of it in #1658 to keep the always-loaded set inside its budget.

Beyond the header block, two sections are checked at the commit (#1193). A section is an ATX heading at level 2 or below (`##` to `######`; a setext `---` underline is not read), or a line that is bold from end to end; the level-1 heading is the spec's title and never counts, a paragraph that merely opens in bold is prose, and so is anything inside a code fence (closed or not) or an HTML comment, a list item's included. The heading must **be** the section's name, not mention it (#1391): inline HTML aside (an anchor, a `<!-- TODO -->`), an optional number (`5. Testing`), then the name, then at most a parenthetical, an issue reference (`#1391`) and one tail — a dash, or a comma, colon, semicolon or full stop followed by a space or ending the heading — or a word or second name joined by `and`, `&` or `/` (`Testing (TDD)`, `Verification — results`, `Testing & verification`, `Code and tests`, `Out of scope and testing`, which counts as both). `Test position` and a title such as `The Background Test plays a frame` are not test plans. The spellings already in use are all accepted:

- **Out of scope** — or `Non-goals`, `Not in scope`, or `What this deliberately does not do` (`this` may be followed by one word, or be `it` / `we`; `deliberately` is optional; the verb is `do`, `cover`, `include`, `ship` or `change`). What the decision deliberately does not cover.
- **Testing** — or `Test`, `Tests`, `Verification`, with an optional `Manual`, `Unit`, `Integration`, `Build`, `Regression`, `Acceptance`, `End-to-end`, `E2E`, `Hardware`, `Device`, `Sim` or `In-sim` before it and `plan`, `strategy`, `approach`, `steps`, `cases`, `matrix`, `checklist` or `results` after it; or `Verify`, `How to test`, `How to verify`, `How it is tested`, `How it was verified`. How the thing is proven, by hand as well as by suite.

Both faded once the spec became a filing-time decision record instead of an implementation-time design doc — 50 % → 17 % and 88 % → 70 % across the #621 policy, measured in the #1193 spec — and both are worth keeping from the older shape. **Forward-only**, like the naming convention: the check sees only a spec a commit ADDS, so amending an existing one is untouched and nothing is backfilled.
