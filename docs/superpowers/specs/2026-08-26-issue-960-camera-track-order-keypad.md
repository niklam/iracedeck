# Camera Controls: a keypad surface for Cycle by Track Order

> **Issue:** [#960](https://github.com/niklam/iracedeck/issues/960) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

Camera Controls can move the camera through the field two ways on a **dial** — by ascending car number, and (since #886) by **physical track order**: the competitor nearest ahead of or behind the focused car on the road, regardless of standings or lap count. On a **key** only the car-number walk exists (Cycle Car). Nothing on a key reaches the car physically ahead or behind.

That is the ordering a spectator actually wants during an incident, where the running order says nothing about who is next to whom on the road — and it is the one ordering a keypad user cannot get today. The dial is Elgato Stream Deck+ only (#786), so on Mirabox, Ulanzi, and every Elgato deck without dials the capability is unreachable.

## What this is not

It is **not** a new computation. `computeTrackOrderTarget` (`iracing-actions/src/shared/car-cycling.ts`) already exists, shipped with #886, and is a thin wrapper over the project's one track-order primitive, `findNearestCarOnTrack` (`@iracedeck/iracing-sdk`). This change gives that shipped computation a second surface. The `race-positions.md` rule already names it as the single helper for physical track order; no new entry in that rule is needed.

Two premises in the issue body were true when it was filed and are not any more, so they are recorded here rather than acted on:

- The issue asks for the keypad mode and #886's dial mode to be *implemented together* so the two surfaces agree. #886 has since shipped; agreement is now achieved by consuming its helper, not by co-implementation.
- The issue's open question — whether the pace car should be a valid "ahead" target — is already settled by that helper, which filters to `getAllCarNumbers(sessionInfo, true, true)` (pace car and spectators excluded). Both surfaces therefore skip it, and no `skipIdx` argument is introduced.

One premise in the issue body is simply wrong: it states Camera Controls' keypad surface is absent from the comms catalog by design. It is present (`camera-focus`, `_meta.modeSetting = "target"`), so the new mode needs an `api` entry there.

## Naming: Track Order, not Track Position

The issue proposes **Cycle by Track Position** for both surfaces, aligning #886's label to it. That is rejected. #886 shipped as **Track Order**, and the name is already published: the dial's touch-strip caption (`TRACK ORDER`), the dial mode label, the website action page, `docs/reference/actions.json`, and the `iracedeck-actions` skill.

One concept keeps one name, and the cheapest way to hold that invariant is to adopt the name that already exists rather than rename four published surfaces to satisfy a label chosen before the first surface shipped. The keypad mode is therefore **Cycle by Track Order**, setting value `cycle-track-order`.

The key titles are **`CAR AHEAD`** / **`CAR BEHIND`** rather than `TRACK ORDER NEXT/PREV`: on a key the title has to say what the press *does*, and "ahead" / "behind" is the whole idea. It also reads distinctly against the neighbouring `CAR NEXT` / `CAR PREV` of Cycle Car.

## Design

### Dispatch — a cycle target, not a focus target

`cycle-track-order` joins `CYCLE_TARGET_VALUES`. That single placement buys three things for free, all of them existing behaviour rather than new code: `onKeyDown` routes it through `executeCycle`; the PI reveals the shared **Direction** dropdown for it; and `CYCLE_ICONS` / `CYCLE_TITLES`, both typed `Record<CycleTarget, Record<Direction, string>>`, become compile errors until the mode supplies its icons and titles.

Its `executeCycle` case mirrors the `cycle-car` case: resolve the competitor list from session info, ask `computeTrackOrderTarget` for the neighbour, and dispatch `camera.switchNum(carNumberRaw, groupNum, cameraNum)` with the group and sub-camera read from live telemetry — so the shot is preserved and only the subject changes, exactly as Cycle Car does.

It differs from `cycle-car` in one way, deliberately: **there is no fallback branch**. `cycle-car` falls back to the raw `camera.cycleCar` helper when the session lists no cars at all. Track order has no SDK equivalent to fall back to, and inventing one would mean a second ordering. No neighbour → nothing sent, warn log. That is Replay Control's contract for the same computation and #885's no-fallback contract for the dial.

### The one refactor: `trackOrderDirection` moves down

"`next` means the car *ahead*" is a mapping, and it currently lives as a private function in `camera-dial-surface.ts`. A keypad copy would be a second definition of the same rule, and the two surfaces could then drift in opposite directions — the precise failure the #803 *preview == execution* invariant exists to prevent, one layer up.

`trackOrderDirection` therefore moves into `shared/car-cycling.ts`, beside the `TrackOrderDirection` type and `computeTrackOrderTarget` it serves, and both surfaces import it. Its signature takes the shared `CarCycleDirection`, which is structurally the `Direction` both surfaces already use. Nothing else moves: the dial keeps `MODE_NUMBER_PRIMARY`, `clockwiseDirection`, and `orientSides`, which are rotation concerns with no keypad meaning.

Note what this does *not* import into the keypad: `MODE_NUMBER_PRIMARY`'s clockwise-lowers-the-number rule is about which way a knob turns and has no analogue on a key, which goes one way per press.

### Direction: the shared setting, relabelled

The mode reuses the existing `direction` setting (`next` = ahead, `previous` = behind) rather than introducing a parallel one. The PI swaps the two options' `textContent` to **Ahead** / **Behind** while this mode is selected — the pattern `force-feedback.ejs` already uses to relabel Increase/Decrease as Louder/Quieter per mode. Values are untouched, so nothing is persisted differently and no migration exists to get wrong.

**This mode must be exempt from #228**, which proposes dropping the Direction setting for the cycle modes in favour of separate modes. A key can only travel one way per press, so for this mode the direction is not a refinement of the mode — it *is* the mode. If #228 lands, `cycle-track-order` either keeps its dropdown or splits into two modes; it cannot simply lose the setting.

### Icons — derived from the Replay Control car family

Two new files, `track-position-ahead.svg` and `track-position-behind.svg`, living in `camera-cycle` beside the other cycle keys but **drawn from the Replay Control car family**, not from `camera-cycle`'s own thin line art.

That family is a system rather than a set of drawings: one detailed side-profile car silhouette, mirrored for the reverse direction, with a symbol **knocked out of the body** in `{{backgroundColor}}`. The silhouette is the constant; the knockout is the only thing that varies — a triangle for Next / Previous Car, `1 2 3` for the by-number pair, a heart for Jump to My Car. Joining a system by copying its constant and supplying a new variable is how a new member is added to it, so the silhouette and `<desc>` palette are copied **verbatim** from `next-car.svg` / `prev-car.svg` and only the knockout and the title change.

The knockout is a **double chevron**, pointing along the car's direction of travel: it reads as "further along the road", and it is the one thing that has to distinguish these keys from Replay Control's plain single triangle, which a user may well have on the same deck. Distinctiveness within Camera Controls comes for free — every other cycle key there is thin line art.

Consequences of joining that family rather than `camera-cycle`: no green accent (the Replay keys carry no semantic colour), and therefore no `locked` array in the `<desc>` — with no hard-coded colour left to protect, a user's global graphic colour should apply, which is exactly what the Replay keys do.

Static per direction. No telemetry-aware icon: the mode has no readback worth showing (the target changes continuously as the field moves, and a key that repainted every tick would be noise), which is the same call Cycle Car made.

**A first attempt drew the pair by hand** — two simplified `camera-cycle`-style cars stacked vertically, the target one green, with a green direction arrow — reasoning that the mode is about a relationship between two cars and so should show two. It was rejected on sight. The lesson is worth keeping: on a deck full of professionally drawn keys, an icon that invents its own drawing reads as foreign no matter how well it encodes the concept. Look for the family the new key belongs to and join it; the concept can be carried by the one element that family leaves free.

### Live data during a replay

The mode reads live car placement, so scrubbing a replay *inside a live session* follows the live field rather than the replay cursor — the #492 finding, already documented for the dial's track-order mode and for Cycle Car. It gets the same sentence on the keypad mode's website section rather than a code change: the alternative would be a second, replay-cursor-aware ordering, and there is one track-order primitive on purpose.

### The chevron becomes shared vocabulary

Replay Control's **Next Car** / **Previous Car** make the same move — the camera steps to the next car along the road. They get there differently (they tap iRacing's own binding and let the sim pick, rather than computing a target), but what the user sees happen is the same thing. Their single-triangle knockout therefore becomes the double chevron as part of this change, so one meaning carries one glyph across the deck instead of two keys that do the same thing looking unrelated.

That inverts the distinctiveness argument that picked the chevron in the first place, and does so deliberately. `icons.md` asks that icons be *distinguishable*, and what needs distinguishing is behaviour, not artwork: two keys that make the same move should look alike, and the differences that remain — an SDK command with no binding on one side, a key binding on the other — are carried by their titles (`CAR AHEAD` vs `CAR NEXT`) and their Property Inspectors. The `1 2 3` knockout is what separates the by-number pair, and it is untouched.

This is the one part of the change that reaches outside issue #960, since it edits two shipped icons, so it carries its own changelog line.

## Alternatives rejected

**A focus target rather than a cycle target.** `focus-track-ahead` / `focus-track-behind` as two entries in `FOCUS_TARGET_VALUES` would avoid the Direction relabel entirely. Rejected: it doubles the mode list for one behaviour, it splits what the dial models as one mode with a direction, and it forfeits the exhaustive-`Record` compile checks that `CycleTarget` gives.

**A per-mode `trackDirection` setting (`ahead` / `behind`).** Self-describing in storage, no relabel needed. Rejected: a second direction setting on an action that already has one is a trap for the next person adding a cycle mode, and it buys nothing a relabelled dropdown does not already give — the persisted vocabulary is an implementation detail, while the label is what the user reads.

**Renaming the dial mode to Track Position.** Covered above; rejected for the published-surface cost against no gain.

## Affected artifacts

Code: `camera-controls.ts` (target value, icon/title maps, `executeCycle` case), `shared/car-cycling.ts` (`trackOrderDirection` moves in), `camera-dial-surface.ts` (imports it), `camera-focus.ejs` (option, `CYCLE_TARGETS`, direction relabel), `comms-catalog.ts` + regenerated `action-comms.json`, two icons + regenerated previews and defaults, plus the two Replay Control car icons re-marked with the same chevron.

Rules: `race-positions.md`, whose list of `findNearestCarOnTrack` consumers now names both Camera Controls surfaces. The rule itself does not change — physical track order was already carved out from the canonical-order rule; only the consumer list grows.

Docs and data: the website action page (new mode section, Method: iRacing API, the replay caveat), `changelog.mdx` + regenerated `changelog.json`, `docs/reference/actions.json`, and the mode counts in `.claude/skills/iracedeck-actions/SKILL.md`, `docs/actions/overview.md`, and `index.mdx`.

No manifest change on any plugin — the mode is a dropdown value, and all three plugins rebuild their PI from the same template.
