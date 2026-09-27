> **Issue:** [#1270](https://github.com/niklam/iracedeck/issues/1270) · **Supersedes:** _none_ · **Superseded by:** [#1274](2026-09-27-issue-1274-opponent-flags-nearby-class-car-number.md)
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Opponent flags: a "My class only" option

## Where the other-class calls come from

The #936 qualification window (`classify()` in `packages/sim-events-iracing/src/diff/opponent-flags.ts`) has two halves. The standings relations — `ahead` (1–3 class positions up) and `behind` (one down) — already require the same class and the same lap. The track-relative fallback, `track-ahead`, does not: any flagged car on the racing surface within the 10 s enter / 12 s exit hysteresis ahead of the player qualifies whatever its class or lap. That was deliberate in #936 (the approaching-an-impaired-car safety case), and it is the only path by which a car from another class is ever announced. So the option does one thing: in a multi-class session, a car known to be in another class does not qualify through `track-ahead` either.

## Decisions

### 1. The filter lives in the translator, beside the per-flag opt-ins

The option is a live-read closure injected into the translator, exactly as the per-flag opt-ins are (`getOpponentFlagCalloutEnabled`, enforced in the diff since the #936 review). `sim-events-iracing` stays settings-agnostic: `SimEventsIracingOptions` already exists to carry settings-backed knobs "injected as closures so this package stays independent of `@iracedeck/deck-core`", and four live-read knobs travel that way today.

- `SimEventsIracingOptions` gains an optional `getOpponentFlagMyClassOnly?: () => boolean`, defaulting to `() => false`.
- `diffOpponentFlags` receives it next to `getCalloutEnabled` and reads it **once per announce pass** (per tick, after the gates), so a Settings-window toggle takes effect on the next tick without a restart.
- `classify()` receives the resolved boolean and, when it is on, returns `null` for a known other-class car **before** either half runs. The standings half would reject such a car anyway; the early return is what closes the `track-ahead` half, and it keeps the rule in one visible line rather than folded into the fallback's surface and gap checks.

Returning `null` from `classify()` is what makes the filter complete, because everything downstream keys off a non-null classification: `opponentFlagInWindow[i]` is cleared (so the car's hysteresis starts from the 10 s enter bound if it later qualifies), no episode-latch bit or per-(car, flag) cooldown is stamped, and no entry is added to `opponentFlagRecentEntries`. A filtered car therefore never counts toward the three-distinct-car burst threshold, can never collapse a same-class car's individual line into the `others` tail, and can never be the reason the aggregate plays.

**Rejected: filter at the scenario layer.** A `where:` on the payload would need `opponentFlag.flagged` to carry whether the car is in the player's class. It does not (it carries `relation`, `carIdx`, `flag`, `trigger`, `position`, `gapSeconds`, `isMultiClass`), so this would add a field to a published event-bus event — an xhigh contract change — to buy a worse result. The latch, the cooldowns and the aggregation all live in the translator and run before the event exists, so a scenario-side filter would let other-class cars stamp latches, consume the burst budget and trip the `others` tail — an aggregate the user would then hear about cars they asked not to hear about, or a same-class line swallowed into it. This is the same reasoning that moved the per-flag opt-ins into the diff in the #936 review, and it applies unchanged.

### 2. "Another class" means known to be another class

The test is: the session is multi-class (`isMultiClass`, the value the diff already receives from `resolveIsMultiClass`), and `CarIdxClass` has a value for both the player and the car, and the two differ. The class IDs are read from the same `telemetry.CarIdxClass` array `classify()` already uses for its `sameClass` check, so the filter and the standings relations can never disagree about what "your class" is.

This is deliberately **not** `!sameClass`. `classify()`'s `sameClass` is false when the player's class is missing, which is right for the standings half (no class, no class position) but would make the option silence every flagged car on a tick with missing class data. A car whose class cannot be read keeps today's behaviour and can qualify through `track-ahead` — the "don't punish missing data" precedent the surface check in the same fallback already sets. Missing class data in a multi-class session is a transient, not a steady state.

Consequences, all by construction:

- **Single-class session:** `isMultiClass` is false, the filter is a no-op, and the option changes nothing.
- **Same-class lapped traffic** still qualifies through `track-ahead` with the option on. The request is about class, not lap, and a lapped car in your own class is still a car you race among.
- **The pace car** is already excluded before `classify()` runs (`paceCarIdx`).

### 3. Toggling mid-race behaves like the per-flag opt-ins

The option is live, so turning it on or off during a race needs no special handling beyond what the level-triggered design already gives:

- **Off → on:** from the next tick, other-class cars stop qualifying. An other-class car already announced keeps its latch bit until its flag drops; nothing re-announces.
- **On → off:** a flagged other-class car already within the window announces on the next tick with `trigger: "entered-range"`, because it was never latched — the same outcome as re-enabling a per-flag opt-in mid-episode.

### 4. The setting: one global boolean, default off

- **Key:** `opponentFlagCalloutMyClassOnly` in `GlobalSettingsSchema`, next to the four `calloutEnabledOpponentFlag*` keys, using the same `z.union([z.boolean(), z.string()]).transform(...)` shape with `.default(false)`. It is a scope filter, not a callout opt-in, so it does not take the `calloutEnabled` prefix. Adding an optional key with a default is forward-compatible under `global-settings.md`: no migration, and an older build ignores it.
- **Default off.** The standing rule is that new Race Engineer functionality defaults on; this is not new functionality but a narrowing of shipped behaviour, and off keeps every existing user hearing exactly what they hear today. That is the maintainer's decision for this issue.
- **Plugins** wire it in all three `plugin.ts` files next to `getOpponentFlagCalloutEnabled`, reading the parsed global setting live, so that a stored `"true"` string reads the same as the schema's coercion.

### 5. The Settings window row

In the Race Engineer tab's **Callouts** section (`packages/pi-components/partials/race-engineer-callouts.ejs`), directly after the **Opponent Flags** item and before **Pit Service**, a separate item rather than a fifth checkbox in the Opponent Flags grid — the grid holds one checkbox per announced flag, and this one is not a flag:

- Item label **Opponent flag scope**, one checkbox labelled **My class only**.
- The checkbox **omits** the `default` attribute (the `default="false"` renders-checked trap the fuel rows document).
- Supporting text, in the gap-slider style: *"Only announce flags on cars in your class. Flagged cars from other classes stay silent too, even just ahead of you on track. No effect in single-class races."*

### 6. Scenario descriptions follow

`RELATION_CAR["track-ahead"]` in `packages/audio-scenarios/src/catalog/pit-crew/opponent-flags.ts` currently reads "of any class or lap". It gains the qualification that other classes are left out when the driver has chosen **My class only**, and `pnpm generate:pack-reference` regenerates the committed `pack-reference.json` the website renders. The aggregate's description needs no change. The contracts, their `where:` predicates and the scripts do not change: no new line is spoken.

## Rejected alternatives

- **Keep other-class meatballs as a hazard exception** — filter furled, black and DQ for other classes but still warn about a meatballed car of any class close ahead on track. Rejected by the maintainer. The request names meatballs specifically, so the exception would leave the reported noise in place; it would make the option mean "my class only, except for one flag on one relation", which a single checkbox cannot say and the website would have to explain; and in multi-class racing faster and slower classes pass you constantly, so a flagged other-class car ahead is usually visible and either pitting or pulling away rather than an unseen hazard. A driver who wants that warning leaves the option off, which is the default.
- **A three-way choice** (all classes / my class / my class plus hazards). Same reasoning: more surface for a case nobody asked for.
- **Per-flag or per-relation class scope.** Four or eight more settings for one request that asks for one switch.
- **Narrowing the track window for other classes** (say 3 s instead of 10 s). A different behaviour from what was asked, and a number the user cannot see.
- **Filtering in the scenario layer with a new payload field.** See decision 1.

## Out of scope

- **The leader's final-lap call** (`diffLeaderWhite`): it follows the **overall** leader by design, because in multi-class that car's final lap ends the race for everyone. The option does not touch it.
- **Opponent-pit callouts** (#622): their nearby relation is already class-only; the leader-pitting line follows the overall leader and stays that way.
- **Class-scoping any other Race Engineer family** (gaps and overtakes are class-based already; the spotter and radar are proximity by nature).
- Changing the 10 s / 12 s track window, the burst threshold, the cooldowns or the Furled debounce.
- "Flag cleared / penalty served" callouts (the #936 follow-up).
- Any change to `opponentFlag.flagged` or the `getLiveOpponentFlags()` seam, which stays raw per-car truth with no announcement policy.
- The scenario harness: no new bus event and no new callout, and it wires no opt-in resolvers, so it cannot exercise this gate.

## Testing

**Suite** (`packages/sim-events-iracing/src/diff/opponent-flags.test.ts` unless noted):

- Multi-class, a flagged other-class car 5 s ahead on track:
  - option off: announces `track-ahead` (today's behaviour, pinned as a regression guard);
  - option on: nothing emitted, and no latch bit, cooldown or `opponentFlagRecentEntries` entry is stamped.
- Multi-class, option on: a flagged same-class car up to three places ahead, directly behind, and lapped same-class traffic ahead on track all still announce with their existing relations.
- Burst: option on, three flagged other-class cars and one flagged same-class car inside the aggregation window — the same-class car's line plays individually, and no `others` aggregate fires.
- Single-class session with the option on: output identical to option off for the same fixture.
- Missing class data (player's or the car's `CarIdxClass` entry absent): the car still qualifies through `track-ahead` with the option on.
- Live toggle: on → off with a flagged other-class car in the window announces `entered-range` on the next tick; off → on stops further other-class announces, and an already-announced car does not re-announce.
- Escalation on a same-class car still bypasses the collapse with the option on (unchanged #936 behaviour, re-run under the new parameter).
- `translator.test.ts`: the option defaults to off when not supplied.
- `global-settings` tests: the key defaults to `false`, and `"true"` / `true` parse to `true`.
- The pack-reference freshness test picks up the changed description.

**Manual (the PR gate).** In iRacing, in a multi-class race (an AI race with two classes is enough, as the #936 captures were), using an admin black flag (`!black`) on cars you can position around:

- Option off: a black flag on an other-class car within about ten seconds ahead on track is announced as *"The car ahead on track…"*.
- Option on: the same situation is silent; a black flag on a same-class car one to three places ahead, or directly behind, is still announced with its position.
- Toggle the option in the Settings window mid-race and confirm it takes effect without a restart, including the on → off announce of a car already in range.
- The **My class only** checkbox renders unchecked on a fresh settings file and survives a plugin restart once checked, in the Settings window of each deck host that is linked.
- In a single-class race, the option makes no audible difference.
