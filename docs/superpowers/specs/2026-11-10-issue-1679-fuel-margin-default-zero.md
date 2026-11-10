# Fuel margin defaults to 0

> **Issue:** [#1679](https://github.com/niklam/iracedeck/issues/1679) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Decision

The Race Engineer's fuel margin (`fuelCalloutMarginLaps`) defaults to **0 laps**, and existing installs that hold the old default are moved to 0 once.

### The default, in its three copies

- `GlobalSettingsSchema`: `fuelCalloutMarginLaps` takes `.default(0).catch(0)`. The `preprocess` that maps `null`, `""` and whitespace to `undefined` stays: it now falls back to 0 as well, so its comment's reason ("would otherwise turn them into 0 and silently disable the margin") is rewritten to say it keeps empty-ish values on the schema's default path.
- `sim-events-iracing`: `FUEL_CALLOUT_DEFAULT_MARGIN_LAPS = 0`, which `sanitizeFuelCalloutMarginLaps` falls back to and the translator uses when no option is injected.
- The settings window's slider in `race-engineer-callouts.ejs`: `default="0"`.

The three are held equal today by `race-engineer-wiring`'s `translator-options.test.ts` (schema against translator) and `pi-components`' `race-engineer-callouts-sliders.test.ts` (slider against schema), so the change is one edit in each, and either test fails on a missed copy.

### Existing installs: a one-shot migration of the exact old default

Decided by Niklas on 2026-11-10: existing installs are migrated.

Every start writes the whole parsed settings cache to the file (`global-settings.md`, *Changing a schema default reaches new installs only*), so every existing install has `0.3` stored, whether or not anyone chose it. A schema change alone would leave all of them where the problem is.

`migrateFuelMarginDefault(logger)` in `global-settings-migrations.ts` rewrites a stored `fuelCalloutMarginLaps` of exactly 0.3 to 0, once:

- **What it moves.** The value as the cache holds it after parsing is the number `0.3`. Anything else (0, 0.4, 1.0) is left alone. A user who chose 0.3 on purpose is indistinguishable from one who never touched the slider and is moved too; the changelog fragment says so, and the slider puts it back. This follows #1599's rule: a value every install persisted as a default is not a user's choice.
- **Marked done.** A durable passthrough key, `_fuelMarginDefaultMigrated`, holding the plugin version that ran it (the `_migrationAbandoned` shape, #1047). It is written in the same `updateGlobalSettings` call as the value, whether or not a value was moved, so a user who sets 0.3 again after the upgrade keeps it at every later start. Never run-scoped.
- **When it runs.** Once the store is ready (`runOnceSettingsStoreReady`), at every start until marked, beside `migrateGlobalSettingsKeys`. It skips while `_migrationPending` is set: that store has not read the deck host yet, and when the answer arrives `mergeMigration` lets the host's stored 0.3 win over the file's new default 0, so a marker written earlier would leave the host's 0.3 in place for good. The start whose host answer lands runs it. A store marked `_migrationAbandoned` (#1041) is migrated like any other: its file is the settings, and a later re-ask merges the host under the file, so the moved 0 survives.
- **A fresh install** has 0 from the schema and gets the marker on its first ready start, moving nothing.
- **Logged** at info when it moves the value (`Fuel margin moved from the old default 0.3 to 0`), and at debug when it only writes the marker.

### Why 0

The spoken count is `floor(rawLapsLeft − margin − lapFractionRemaining)`. Rounding down already makes every call conservative by up to a lap; a margin on top moves the box call a whole lap earlier in about `margin × 10` stints out of 10 (#1401's analysis). Since #1405 the end-of-race coverage check judges the raw tank and no longer reads the margin, so the margin's only remaining effect is that earlier call. Estimate error is #1401's to handle, with a fuel reserve in liters and its own default.

## Alternatives rejected

- **New installs only, no migration** (the #1061 precedent for `changelogNotification`). The issue is the box call a lap early for the drivers using the plugin now; a default only new installs see fixes almost none of them.
- **Migrating any value at or below 0.3.** A stored 0.1 or 0.2 can only be a choice (the slider steps by 0.1 from a default of 0.3), and moving it would overwrite one.
- **Recording which settings a user changed, to migrate only untouched ones.** The settings store keeps no such record, and adding one to every key for one migration is out of proportion.
- **Folding this into #1401.** #1401's reserve needs in-car testing for its default; the margin default does not, and it would wait on that.

## Out of scope

- The fuel reserve, the counting-basis wording and the logged estimate (#1401).
- The margin's range (0–3) and step (0.1).
- Session Info's **Laps to Empty**, which applies no margin.

## Testing

- **Schema:** a settings file with no key parses to 0; `null`, `""` and a malformed value fall back to 0.
- **The three copies:** `translator-options.test.ts` and `race-engineer-callouts-sliders.test.ts` pass with the new default and fail if any one copy is left at 0.3.
- **Migration**, against the memory store: stored 0.3 → 0 and the marker written; stored 0.4 and 0 → unchanged, marker written; already marked with 0.3 stored → unchanged; `_migrationPending` set → nothing written, then the start after a host answer merging 0.3 → 0 and marked; `_migrationAbandoned` → migrated; a store that is not ready → nothing.
- **Translator:** `diffFuelLapsLeft` with no injected margin uses 0.
- **Manual:** with a settings file holding `"fuelCalloutMarginLaps": 0.3` and no marker, start the plugin; the settings window's slider reads 0, the file holds 0 and the marker, and the log has the info line. Set the slider to 0.3, restart, and it stays 0.3.
