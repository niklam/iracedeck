# Pit Crew Corner Names: a tap and a long press each choose what they toggle

> **Issue:** [#1699](https://github.com/niklam/iracedeck/issues/1699) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

The Pit Crew key's Corner Names mode (#897) flips one global opt-in, `calloutEnabledCornerNames`, on key-down, and speaks `toggle/corner-names-on-01` or `-off-01` by path when the Race Engineer master is on. The sector-start calls (#1573) have their own opt-in, `calloutEnabledSectorStarts`, which only the Settings window can change. Niklas decided on 2026-11-15: "Allow users to choose if it's both/corners/sectors per short press / long press." His first idea was a tap for corners and a long press for sectors, "kinda like with Wipers and Visor" (#1463), and that is what the defaults below give.

## Decisions

### 1. Two per-key settings

Niklas confirmed the defaults on 2026-11-15 for new and existing keys alike: a tap toggles Corners, a long press toggles Sectors, accepting that a tap then acts on release.


Both are new keys in Pit Crew's action settings schema (`pit-crew.ts`, `Settings`). They are read only in the `corner-names` mode and are ignored in every other mode.

| Key | Values | Default | PI label |
| --- | --- | --- | --- |
| `cornerNamesTap` | `both`, `corners`, `sectors` | `corners` | Tap toggles |
| `cornerNamesLongPress` | `none`, `both`, `corners`, `sectors` | `sectors` | Long press toggles |

```typescript
cornerNamesTap: z.enum(["both", "corners", "sectors"]).default("corners"),
cornerNamesLongPress: z.enum(["none", "both", "corners", "sectors"]).default("sectors"),
```

- **No migration and no fresh-key seed.** A key stored before this change has neither field and reads the schema defaults, so its tap still toggles the corner names, as the issue requires. A new key reads the same defaults. Every key therefore behaves as its PI shows, with no hidden difference between keys placed before and after the release.
- **Existing keys gain a long press for the sector calls.** Before this change, holding the key toggled the corner names at key-down like a tap. Now a hold past the threshold toggles the sector calls. That is the feature the issue asks for, and the changelog fragment says so.
- **The value `none` is labelled "Nothing"**, Niklas's and the issue's word, so the dropdown reads "Long press toggles: Nothing". The stored value is `none`, the value every gesture slot in the repo uses.
- **A tap cannot be Nothing.** A key that does nothing on a tap is never what a user wants, and a Corner Names key that only works on a long press would look broken.
- These keys are a persisted contract (an action settings schema, `xhigh` in `code-review.md`). Renaming them or their values later needs a migration.

### 2. What a press toggles

Every target maps to the global opt-ins. The key writes the same switches as the Settings window checkboxes (**Race Engineer Callouts → Corner Names and Sectors**), so the two always agree.

| Target | What the press does |
| --- | --- |
| `corners` | Flips `calloutEnabledCornerNames`. Unchanged from today. |
| `sectors` | Flips `calloutEnabledSectorStarts`. |
| `both` | If either opt-in is on, turns both off. If both are off, turns both on. |

- **"Both" with mixed states turns everything off.** The key's purpose is to stop or start the track-position chatter. From a mixed state the useful result is silence. The icon's aggregate state (section 4) shows "on" whenever either is on, so a press on a key that shows ON always produces OFF. Flipping each opt-in on its own was rejected: from a mixed state it swaps which call is heard, and that is never what a driver means by pressing "both".
- **"Both" writes both keys in one `updateGlobalSettings` call** (a `setCalloutsEnabled(keys, enabled)` helper beside `setCalloutEnabled` in `@iracedeck/settings`). The global-settings listeners then see one change: the key re-renders once, and the Settings window never shows half a toggle.
- The toggle logic moves from `toggleCornerNamesFeature` to `toggleTrackCallouts(target, logger)` in `audio/audio-toggles.ts`, with `isSectorStartsEnabled()` beside `isCornerNamesEnabled()`. It returns the new state of each opt-in it touched, and it logs one info line naming the target and the result, for example `Corner and sector callouts disabled`.

### 3. When a press is classified

- **The tap and the long press are decided on release**, through deck-core's `DualPressTracker` and the global `dualPressThresholdMs` (Long-press threshold, default 500 ms, range 200–2000). This is the same rule and the same threshold as Wipers and Visor (#1463) and the setup keys. Key-down records the press. Key-up computes tap or long, reads the key's settings, and toggles. A press fires one toggle, never two.
- **When the long press is Nothing, or names the same target as the tap, the key toggles on key-down**, as it does today, and the release does nothing. There is no long press to tell apart, so there is no reason to wait. This is the Wipers and Visor visor-car rule: no second action means act on down.
- **The latency cost.** With a distinct long press, a tap acts when the finger lifts instead of when it lands. That is the length of the tap itself, typically 80 to 200 ms. The ack follows the toggle, so the voice confirms after the release. A long press acts on release, after at least the threshold. For a toggle that is not time-critical this cost is accepted. A user who wants key-down timing sets the long press to Nothing.
- **A stray release does nothing.** If key-down recorded nothing (for example, the settings changed from Nothing to Sectors mid-press), `computeOutcome` returns undefined and nothing is toggled, as the tracker documents. `onWillDisappear` clears the context's pending press.
- **Keys report real key-up timing on all three hosts.** The dual-press setup keys and Wipers and Visor rely on this too; the manual test checks it on Mirabox. (Only Mirabox knobs complete a press at down. Pit Crew has no knob surface.)
- **Press sounds (#269).** `keyPressShape` returns `{ kind: "release", thresholdMs, short: true, long: true }` when the long press is classified, and `{ kind: "tap" }` when the key acts on key-down. With press sounds on, a long press therefore plays the double bleep at the threshold. The decision is made from the settings in the key-down event, the same read the press acts on.

### 4. The key icon

The icon keeps today's frame: the glyph above a status bar at y 100–144, the border in the state colour, the title hidden by the template lock (#1479).

**Artwork and default title follow what a tap toggles**, as the Wipers and Visor key shows what its tap does:

| Tap | Glyph | Default title |
| --- | --- | --- |
| Corners | today's corner glyph (`cornerNamesPathContent`) | `CORNER\nNAMES` (unchanged) |
| Sectors | a new sector glyph | `SECTOR\nCALLS` |
| Both | a new combined glyph (the corner bend crossed by the sector mark) | `TRACK\nCALLS` |

The two new glyphs are placeholder-convention artwork drawn in code like the existing three. Niklas approves them on a review page before they are committed (`review-page` skill).

**The status bar follows everything the key toggles**: the union of the tap's and the long press's targets. A key with tap Corners and long press Sectors covers both opt-ins, so it shows both states. Showing only the tap's target was rejected because the key would then hide the state of the switch its long press flips.

| The key covers | Both opt-ins agree | Status bar | Border |
| --- | --- | --- | --- |
| Corners only | — | ON / OFF from `calloutEnabledCornerNames`, as today | that state |
| Sectors only | — | ON / OFF from `calloutEnabledSectorStarts` | that state |
| Both | yes | the ordinary full-width ON or OFF | that state |
| Both | no | a split bar: the left half shows the corners state with the label `CORNER`, the right half shows the sectors state with `SECTOR`. Each half is green or red. | green (the aggregate is on: something is still talking) |

The split bar is a new status-bar helper in `icons/status-bar.ts` (`statusBarSplit(left, right, leftLabel, rightLabel)`), drawn at a smaller font than the 20 px ON/OFF so each word fits its 72 px half. Its exact size is settled on the icon review page. The key re-renders on every global-settings change, as it does today, so the bar follows a Settings window click or another key at once. "Mixed" exists only for a key that covers both, and the aggregate rule (on when either is on) matches the press rule in section 2.

### 5. The acknowledgement

The ack plays when the Race Engineer master is on, the ack opt-in is on, and a voice is available. These are today's gates, unchanged. **One opt-in, `calloutEnabledToggleCornerNames` ("Toggle on/off acknowledgment", already in the Corner Names and Sectors group), gates every ack of this key.** Its key and label stay; its registry comment is updated to name all three targets. A second opt-in per target was rejected: nobody wants the corner ack and not the sector ack from the same key.

Each target gets one whole-phrase clip per direction, played by path from the `toggle` group:

| Target | On | Off |
| --- | --- | --- |
| Corners | `corner-names-on-01` "Roger that. Corner calls coming up." (existing) | `corner-names-off-01` "Copy that. Dropping the corner calls." (existing) |
| Sectors | `sector-starts-on-01` "Roger that. Sector calls coming up." (new) | `sector-starts-off-01` "Copy that. Dropping the sector calls." (new) |
| Both | `track-calls-on-01` "Roger that. Corner and sector calls coming up." (new) | `track-calls-off-01` "Copy that. Dropping the corner and sector calls." (new) |

- **Four new clips, in both first-party voices** (Default and Short callouts), mirroring the existing corner-names pair's wording. Niklas approved the four texts as written on 2026-11-15. They are written without a break after the full stop, per #1643.
- **Generation follows the v4 rules (#1643).** The clips are generated on `eleven_v4` with the voice's settings, with no `next_text`. Each carries `previous_request_ids` pointing at its existing sibling: `toggle/corner-names-on-01` for both new on clips, and `toggle/corner-names-off-01` for both new off clips. That way the new lines continue the existing ack's tone. The build's 20 ms tail trim applies as for every clip. Short callouts gets the same entries, and the generator copies them from Default when the references resolve to the same request ids (#1643's copy rule). Niklas approves the takes on a review page before they are committed.
- **A "Both" press from a mixed state speaks the off clip**, because the result is both off. The ack states the resulting state, not the change.
- **Splicing the combined line from the corner and sector pieces was rejected.** The house rule is whole phrases, and the existing ack is one take.
- **A pack without a new clip plays nothing for that ack.** The toggle still applies, as when a pack lacks the corner-names clip today. The four new clips are added to `PLUGIN_PLAYED_CLIPS` in `scripts/lib/lint-pack-run.mjs`, with their `playedBy` text, so `pnpm lint:pack` and the pack reference (`pack-reference.json`, the recording-script page) tell pack authors about them.
- **How the ack plays against a running callout is #1698's.** Today every Corner Names ack goes through `playVoiceSequence` outside the scheduler and can strand a callout's fire. This spec routes all six clips through one call site in `audio-toggles.ts` (`playTrackCallsAck(clip)`) and does not change how it plays. #1698 converts that one call site to its engine entry point and its ack `whenBusy` value. Both issues are in milestone 3.9.0. Whichever lands second rebases onto the other; the release must carry both.

### 6. Dial or knob

None. Pit Crew is `"Controllers": ["Keypad"]` in all three manifests, so the mode has no Stream Deck+ dial or Mirabox knob surface. This adds none. Press classification therefore follows the keypad path in section 3, not `classifyDialReleaseForHost`.

### 7. The hold preview

**There is none, and none is needed.** The #1120 hold preview (encoders rule 9) is a dial-strip mechanism. A Pit Crew key on a Stream Deck+ is one of its eight keys, not a dial, and has no strip to draw on. Redrawing the key image at the threshold was rejected: the finger is on the key, so nobody sees it, and no key in the repo does it. The cue a key has is the press sounds' double bleep at the threshold (section 3), when the user has press sounds on.

### 8. The Property Inspector

There is one template, `pit-crew/pit-crew.ejs`, compiled into `ui/pit-crew.html` for all three plugins (Stream Deck, Mirabox, Ulanzi), so they get the same layout with no per-host branch. Under the Mode dropdown, shown only when Mode is Corner Names:

```html
<sdpi-item id="corner-names-tap-item" class="hidden" label="Tap toggles">
	<sdpi-select setting="cornerNamesTap" default="corners">
		<option value="both">Both</option>
		<option value="corners">Corners</option>
		<option value="sectors">Sectors</option>
	</sdpi-select>
</sdpi-item>
<sdpi-item id="corner-names-long-item" class="hidden" label="Long press toggles">
	<sdpi-select setting="cornerNamesLongPress" default="sectors">
		<option value="none">Nothing</option>
		<option value="both">Both</option>
		<option value="corners">Corners</option>
		<option value="sectors">Sectors</option>
	</sdpi-select>
</sdpi-item>
<div class="ird-supporting-text hidden" id="corner-names-note">
	Corners are the corner-name calls, Sectors the sector-start calls. Both turns them all off when either is on, and on when both are off. A long press is a hold past the Long-press threshold in iRaceDeck Settings.
</div>
```

The existing visibility script, which today shows Direction only for Radar Volume, gains these three ids. It uses the same `change`/`input` listeners and `window.irdPoll` fallback. The Mode option keeps its label, **Corner Names**.

## Alternatives rejected

- **A fixed split: tap for corners, long press for sectors.** This was Niklas's first idea. He chose per-press dropdowns instead, and the defaults reproduce it.
- **A separate Sector Starts mode.** It would take a second key for what one key can do with a long press.
- **Defaulting a new key's tap to Both through a fresh-key seed** (`seedFreshKeyStyle`'s pattern, #1453). That would create two groups of keys with the same PI and different behaviour, and the seed would be written on every new Pit Crew key whatever its mode. Corners also matches the mode's name.
- **Defaulting existing keys' long press to Nothing** to keep key-down timing. The issue exists to put the sector calls on the deck, and the cost is one tap's length.
- **"Both" flips each opt-in on its own,** or follows the corners state. Section 2 gives the reason.
- **Firing the long press from a timer at the threshold while the key is still held.** This conflicts with the repo's release-time rule ("no timer decides execution") and would make a tap's action depend on a race with the timer.
- **A mixed-state look without per-target halves** (for example an amber MIXED bar). It says something is on without saying what.
- **Renaming the mode** (for example to Track Calls). It would change docs, the website and existing users' mental model for a label. The tap default is still corners.

## Out of scope

- How a key-press ack plays while a callout runs, and the stranded fire: #1698.
- Overlapping corner and sector calls: #1676.
- The Race Engineer on/off and radio-check acks (#1696 for the radio check).
- A dial or knob surface for Pit Crew.
- Per-key target choices for the other Pit Crew modes.
- A Tap = Nothing option.
- New callouts or scripts. The acks stay plugin-played clips outside `callouts.json`.

## Artifacts

- `@iracedeck/iracing-actions`: `pit-crew.ts` (schema, press handling with `DualPressTracker`, `keyPressShape`, icon), `pit-crew.ejs`, `audio/audio-toggles.ts` (`toggleTrackCallouts`, `isSectorStartsEnabled`, `playTrackCallsAck`), `icons/status-bar.ts` (`statusBarSplit`), and their tests.
- `@iracedeck/settings`: `setCalloutsEnabled`.
- `@iracedeck/callout-settings`: the `corner-names-toggle` family comment.
- `@iracedeck/audio-assets`: four entries in each of `configs/default.voice.json` and `configs/shawn.voice.json`, the generated clips and manifests, and both packs repacked under the pack-record and catalog rules.
- `scripts/lib/lint-pack-run.mjs` (`PLUGIN_PLAYED_CLIPS`) and the regenerated `pack-reference.json`.
- Docs: `docs/plugins/core/actions/pit-crew.md`, `docs/reference/actions.json`, and the `iracedeck-actions` skill's Pit Crew entry.
- Website: the Corner Names section of `docs/actions/audio-voice/pit-crew.md` (both dropdowns, the "Both" rule, the icon states, the acks), and a changelog fragment under Features.

## Testing

- **Unit, `pit-crew.test.ts` and `audio-toggles.test.ts`:**
  - a key stored with only `mode: "corner-names"` parses to tap Corners and long press Sectors;
  - for each tap target, a release under the threshold flips exactly the right opt-ins, and key-down flips nothing;
  - for each long-press target, a release at or over the threshold flips exactly the right opt-ins;
  - long press Nothing, and a long press equal to the tap target, toggle on key-down, and the release sends nothing;
  - Both from on/on, off/off, on/off and off/on gives off/off, on/on, off/off and off/off, in one `updateGlobalSettings` write;
  - a release with no recorded key-down toggles nothing;
  - the threshold is read live (a changed `dualPressThresholdMs` applies to the next press);
  - `keyPressShape` is `release` with `long: true` when classified and `tap` otherwise;
  - the ack: the right clip for each target and result, only with the master, the ack opt-in and a voice; none otherwise; the toggle applies in every case;
  - the icon: the glyph and title per tap target, the status bar per covered set, the split bar with the right colours and green border on a mixed state, and a re-render when the Settings window flips `calloutEnabledSectorStarts`.
- **Pack tooling:** `lint-pack-run.test.mjs` holds the four new entries to clips in the manifest, and `pnpm lint:pack` over a pack without them reports nothing new as dangling.
- **Review pages (Niklas):** the four clip texts before generation, then the takes; the two new glyphs and the split bar.
- **Manual (Niklas, Stream Deck and iRacing, practice session, Race Engineer on):**
  - With a default Corner Names key: a tap toggles the corner calls and the engineer confirms; a hold past the threshold toggles the sector calls; the split bar shows the mixed state, and the Settings window checkboxes follow.
  - Set the tap to Both from a mixed state: one tap silences both and the off ack plays.
  - Set the long press to Nothing: the tap acts as the key goes down.
  - Repeat the tap and long press on a Mirabox key.
  - Press while the engineer is speaking once #1698 has landed.
