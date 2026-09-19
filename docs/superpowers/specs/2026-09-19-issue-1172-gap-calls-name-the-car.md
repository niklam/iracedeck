# Gap callouts name the car

> **Issue:** [#1172](https://github.com/niklam/iracedeck/issues/1172) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## The decision

When the sim can spell the neighbour's number, the six gap lines name it: *"We're gaining on car forty-two."* Each numbered line is a new lead-in that stops before "car", followed by the existing `car-number` clip. When no number can be spelled, today's line plays unchanged. The choice is a script branch on a new condition that shares its closure with the number var, which is #1127's `caution.hasFollowCarNumber` pattern. The number spoken is always the car the gap event is about, spelled from session info when the line is spoken.

This builds on #1127, cited at its branch HEAD `7a1c6e53c` (`ir-1127`, unmerged when this was written). Its `car-number` group, the `caution.*` vocabulary and the conditioning seam are cited as they stand there. The work starts once #1127 merges. It is independent of #1171. Once #1171 lands, a numbered gap call never plays under a caution, like any other gap call.

## Rulings confirmed

Niklas confirmed these on 2026-09-19:

- **The number always goes last**, with the reworded lines in *Wording* below. The issue's *"Car nineteen behind is closing in."* is not used.
- **A queued call names the event's car**, even after that car was passed. See *Which car*.
- **No new `lint:pack` rule.** A pack that adopts the numbered wording is told what it owes through the var description and the recording script. See *Voice packs*.

Still open: the final wording of the ten lead-ins, settled from the dry run, and which release carries this change, which decides the `minPluginVersion` branch in *Voice packs*.

## Which car

**The car named is the event's own `carIdx`.** The translator resolved it from the canonical order: `diffGaps` receives `handleTick`'s `canonicalPositions` and picks the class neighbours with `resolveClassNeighbors`, excluding the pace car explicitly. So the named car is the one the gap was measured against, and the one the readout checks its live gap for. The vocabulary never re-resolves "the car ahead" from anywhere else: not `CarIdxPosition`, not road order, and not the live neighbour at speak time. This is `race-positions.md` applied directly. The callout reads the order through the event and adds nothing of its own.

- **Sides.** An ahead-side event names the class neighbour ahead. A behind-side event names the class neighbour behind. A threshold crossing names the neighbour on its own side.
- **A stale fire names the event's car.** A queued fire can play after the neighbour has changed, for example when you passed that car while the line waited behind the spotter. The number still names the car the event was about. The line is about that car, and the readout already drops its clause on the mismatch. The numberless alternative would quietly re-attribute the sentence to whichever car is ahead now. That is worse than a line that is out of date but says which car it means. Whether a stale gap call should speak at all is a question for the whole family, and this change does not answer it.
- **Multi-class: the car is always named.** The neighbour is in your class by construction, so the number is always a car you are racing. That is the ambiguity the issue exists to remove.
- **Pace car: never a gap neighbour, and never spoken.** The translator excludes the pace car when it resolves neighbours. The reader below also returns null for the pace car, so a hand-fired harness event naming index 0 gets the numberless line. No future family can say "car zero" through this reader either.
- **A car that has left the world: named if session info can still spell it.** A gap event is never emitted for a neighbour that is `NotInWorld` (`neighborSuppressed`), so this is only the stale-fire case above. If session info no longer holds the car's entry, the reader returns null and the numberless line plays.
- **A car the session cannot spell gets the numberless line.** That covers: no session info, no entry for the index, a blank number, and a fire with no gap event behind it (an imperative `fire`, or a gap var named from another family's entry, which is `gapFireOf`'s existing rule).

## Where the number comes from

**The reader.** A new translator reader, `getCarNumber(carIdx): string | null`, in `sim-events-iracing` beside its per-car sibling `getLiveCarPosition(carIdx)`. It reads the controller's session info through the SDK's `getCarNumberFromSessionInfo`, which handles the quoted, unquoted-numeric (#869) and blank shapes and keeps the leading zeros a quoted number carries. It returns null for the index `resolvePaceCarIdx` names. It is never a hand-rolled read: #1127 caught one dropping the numeric form.

**The dependency.** It reaches the catalog as a new `PitCrewDeps` entry, `getCarNumber?: CarNumberResolver`, defaulting to `() => null`. That default leaves every gap line numberless, which is today's wording and a safe stub for tests. All three plugins and the harness `main.ts` wire it. It is injected rather than imported for the reason `caution.ts` gives for its lineup reader: a test or the harness can supply one without standing up the translator's singleton.

**Read at speak time, not frozen into the payload.** A car's number does not change during a session, so freezing it buys nothing. It would only add a field to each of two published catalog events.

**One constant for the group name.** The `car-number` group name moves out of `caution.ts` into a module both families import, so the two families cannot spell it differently.

## Vocabulary

Four names join the five existing gap names. They follow this family's own spelling: `gap.readoutIntro` is the gap group's word for a lead-in, and `caution.followCarNumber` / `caution.hasFollowCarNumber` name the number pair. Every var names the clip group it draws from, because `descriptionNamesGroup` is how the recording script and `lint:pack` credit a group's lines to the var.

- **`gap.lineIntro`** (var): The lead-in of the numbered trend line, which stops where the car number begins ("We're gaining on"). It is drawn from the gap group by side and direction: gap/ahead-closing-intro, gap/ahead-opening-intro, gap/behind-closing-intro, gap/behind-opening-intro. It is never a sentence on its own. Speak gap.carNumber straight after it, and only where gap.hasCarNumber holds; otherwise gap.line is the whole sentence.
- **`gap.thresholdIntro`** (var): The same for a gap that dropped under the alert threshold, from gap/threshold-ahead-intro or gap/threshold-behind-intro. Speak gap.carNumber straight after it, only where gap.hasCarNumber holds; otherwise gap.thresholdLine.
- **`gap.carNumber`** (var): The number of the car the gap line is about, meaning the class-standings neighbour the gap was measured against, as named by the firing event. It is spoken from the car-number group exactly as the sim spells it, so "09" and "9" are different clips. It is null when the session cannot spell that car, and for a fire with no gap event behind it. So branch on gap.hasCarNumber and give the other branch the numberless line. A voice that names it must ship the whole car-number group, every spelling from 0 to 999, because a number with no clip aborts the callout.
- **`gap.hasCarNumber`** (condition): The car the gap line is about can be named, meaning gap.carNumber would resolve. It is false when the session cannot spell the number, and for a fire with no gap event behind it. The reference voice branches on it: the named lead-in and the number in one branch, the numberless gap.line or gap.thresholdLine in the other. A car without a readable number therefore still gets its sentence.

`gap.carNumber` and `gap.hasCarNumber` share one function over the fire's context, so the branch and the number can never disagree about a fire. The descriptions of `gap.line` and `gap.thresholdLine` each gain a clause saying they are the numberless wording.

## The script

The reference voice's two gap entries become:

```json
{
  "pit-crew.gap-trend": {
    "sequence": [
      {
        "if": "gap.hasCarNumber",
        "then": ["{{gap.lineIntro}}", "{{gap.carNumber}}"],
        "else": ["{{gap.line}}"]
      },
      "@gap-readout"
    ]
  },
  "pit-crew.gap-threshold": {
    "sequence": [
      {
        "if": "gap.hasCarNumber",
        "then": ["{{gap.thresholdIntro}}", "{{gap.carNumber}}"],
        "else": ["{{gap.thresholdLine}}"]
      },
      "@gap-readout"
    ]
  }
}
```

**The numbered branch is required, not `optional` as it is in #1127's caution entries.** In those entries nothing follows the optional clause, so a dropped clause and an aborted callout both end in silence. Here the `gap-readout` fragment follows the line. A dropped clause would leave *"Gap is one point five seconds."* with no subject. The condition guarantees the number resolves, so a required step can only fail on a voice that is missing a clip. In that case the whole call aborts under the #835 rule, and a readout never plays without its line.

**The `else` branch is today's line, unchanged.** A car the session cannot spell gets exactly the call it gets now. The branch is written into each entry rather than a fragment, because the two entries use different vars. The entries' `comment` and `test` lines are updated to describe both branches.

## Wording: the number goes last

All six numbered lines end on the number. That rules out the issue's *"Car nineteen behind is closing in."*, which is reworded, for three reasons:

- **The car-number clips were rendered to end a sentence.** They carry preceding context only: `previous_request_ids` → `caution/one-to-go-outside-01`, and no `next_*`. Their cadence closes the sentence, so a tail after one would follow a falling close.
- **A tail clip would be short.** At two or three words it is the kind of clip #1127 found renders badly.
- **It matches the #1127 rule.** Every call that names a car number does so at the end.

Proposed lead-ins, one per existing take so each numbered line has the variety its numberless twin has. That is ten clips. The final wording is settled from the reviewed dry run, as #1127's was.

| New base | Today's line (unchanged, now the fallback) | Proposed lead-in (+ "car forty-two") |
| --- | --- | --- |
| `ahead-closing-intro` | We're gaining on the car ahead. / Good pace. We're closing on the car ahead. | We're gaining on / Good pace. We're closing on |
| `ahead-opening-intro` | The car ahead is pulling away from us. / We're losing time to the car ahead. | We're losing touch with / We're losing time to |
| `behind-closing-intro` | The car behind is closing in on us. / The car behind is gaining. Keep your head down. | Closing in behind us is / Keep your head down. We're being caught by |
| `behind-opening-intro` | We're pulling away from the car behind. / Good. We're dropping the car behind. | We're pulling away from / Good. We're dropping |
| `threshold-ahead-intro` | We've caught the car ahead. | We've caught up to |
| `threshold-behind-intro` | The car behind is right with us. | Right with us now is |

The existing six bases and their clips stay exactly as they are. They are the fallback, nothing about them is regenerated, and every existing pack's script that names them keeps its meaning.

## Clips and conditioning

- **Ten entries in the `gap` group** under the six `-intro` bases above, each with `"next_text": "car ninety five"`, which is the exact string #1127's lead-ins use.
  - `next_request_ids` is never used: `detectReferenceCycles` rejects the cycle it would form with the numbers' `previous_request_ids`.
  - A `next_text` that spells a number with "oh" is never used either: in #1127 it bled into the audio.
  - The engine's `poolMemberPattern` reads `<base>(-NN)?`, so `ahead-closing-intro-01` never counts as a take of `ahead-closing`.
- **The `car-number` group is frozen.** Its entries keep `previous_request_ids: ["caution/one-to-go-outside-01"]`, and no `one-to-go-*` entry is touched. The entry hash follows the reference, so changing either re-cuts all 1,110 clips.
- **The config is edited as text.** It is never parsed and re-serialised: the generator splices text, and a round trip re-expands the inline arrays.
- **Dry-run before generating.** `generate:dry-run --group gap` must list exactly the ten new entries as WOULD GENERATE and every other entry as a cache hit. Only then generate those ten (`--entry`) and rebuild the manifests. The expected spend is ten clips.
- **Listen before accepting.** The numbers were conditioned to follow *"Take the outside line behind"*, and a gap lead-in is a different sentence. Nothing may assume "We're gaining on" + "car forty-two" joins cleanly until it has been heard.
  - The audition runs in the scenario harness, which plays the radio-filtered output a user hears. With the `race` session preset, the Gaps buttons name car nineteen (ahead, index 3) and car eight (behind, index 5).
  - Each of the ten lead-ins must be heard against every reading shape: one digit ("eight"), two digits ("nineteen"), a leading zero ("oh nine") and three digits ("one oh five").
  - The race preset spells neither of the last two, so this change adds a session preset, `race-car-numbers.json`. It is `race.json` with the two gap neighbours renumbered `09` and `105`, a name and `TrackID` of its own (the harness caches track data by `TrackID`, so a cloned preset must change it), and nothing else changed.
  - The existing presets' rosters are not touched, because the caution shortcuts are indexed against them.
  - After the harness, the lines are heard in the sim through the development voice root (`dev:voices on`, `pack:voice default --no-catalog`, Rescan).
- **A lead-in that does not join cleanly is fixed on the lead-in**, with another seed or other words. Never on the numbers.

## Voice packs

- **Existing packs keep working unchanged.** The four names are additions. `gap.line`, `gap.thresholdLine` and the readout keep their meaning. A pack whose script names none of the new names behaves exactly as today, and its coverage and `lint:pack` findings do not change.
- **A pack that adopts the numbered wording must ship the whole `car-number` group, plus the six intro bases.** `lint:pack` cannot catch a missing number. A var-driven group is exempt from the orphan rule, and a var's references are invisible to the dangling rule. That is the linter's documented limitation, and its stated fix, declared sources on `defineVar`, is not pulled into this change. Instead, the var description says what a pack owes, and the generated recording script lists those lines. A pack with a partial group gets silence for the numbers it lacks, never a wrong line. The reason is that `gap.hasCarNumber`, like `caution.hasFollowCarNumber`, asks the session and not the voice (see *Rejected alternatives*).
- **The reference voice's coverage test stays green by construction.** No step addresses the `gap` or `car-number` group directly, so both count as var-driven. What proves the ten clips exist is the family test: `GAP_CLIP_SOURCES` grows from seven bases to thirteen, and the test pins each against the bundled manifest.
- **Plugins keep `default` updated, and an older plugin cannot read the new script.** Since #1034 stage 3 every plugin keeps `default` at the catalog's digest. A plugin without this change that fetched the new script would find `gap.hasCarNumber` unknown. It would skip both gap callouts for the voice, so an update would silence the gap calls.
  - If this ships in a later release than the one that introduced the launch step (3.3.0), the `default` catalog entry carries `minPluginVersion` set to that release. An older plugin then keeps the voice it has, whose gap calls keep the old wording, and reports that the newer pack needs a newer plugin.
  - If it ships in 3.3.0 itself, no older plugin updates `default` and the field is unnecessary.
  - `pack:voice default` regenerates the entry either way. A version that is already published needs a `version` bump first.

## Settings

No setting is added. `calloutEnabledGapTrend` and `calloutEnabledGapThreshold` switch the calls whatever words they use, and keys never change when the wording does. The labels ("Gap trend (gaining/losing)", "Gap under threshold") stay true.

## Tests

**`audio-scenarios` `gaps.test.ts`:**

- `gap.carNumber` resolves the event's `carIdx` through the injected reader. `09` and `9` resolve to different clips. The var is null with no event behind the fire, and null when the reader returns null.
- `gap.hasCarNumber` agrees with `gap.carNumber` in every one of those cases.
- `gap.lineIntro` and `gap.thresholdIntro` select their base by side and direction.
- Through the real script:
  - A spellable neighbour plays the intro, `car-number/<n>` and the readout.
  - A spellable neighbour with no readable gap plays the intro and the number, with no readout.
  - An unspellable neighbour plays exactly the ops it plays today. That pins the fallback to today's call.
  - A queued fire that drains after the neighbour changed still names the event's car.
- "Publishes the vars … and nothing else" grows to nine names, each naming its group.
- The bundled-script shape test covers the new branch.
- `GAP_CLIP_SOURCES` lists thirteen bases, each with a clip in the bundled voice.

**`sim-events-iracing`:** `getCarNumber` covers:

- a quoted number
- an unquoted numeric one
- a leading zero, preserved
- a blank number
- the pace car's index
- an index with no entry
- no session info

**Harness:** a test pins that the `race` preset's indices 3 and 5 spell `19` and `8`, and that `race-car-numbers` spells `09` and `105`, so the shortcut descriptions stay true.

**Wiring:** all three plugins and the harness wire `getCarNumber`. The dependency is optional, so a plugin that forgets it still compiles and silently keeps the numberless wording. The harness test above covers the harness. The plugins are covered by the in-sim listen through the development voice root, and that listen must hear a number.

## Documentation and artifacts

- **Regenerate the artifacts.** `pnpm generate:callout-scripts` (the post-edit hook runs it in a Claude Code session). Then `pnpm build` followed by `pnpm generate:pack-reference`: the vocabulary, the bundled script and the bundled clips all change. Then `pnpm --filter @iracedeck/audio-assets pack:voice default`, with `minPluginVersion` as set out above. Commit the regenerated manifests with the clips.
- **Website Pit Crew page.** The Gap callouts section quotes the numbered wording and says when the car ahead is left unnamed. The Voice Packs reference regenerates itself.
- **Changelog.** One line under **Improvements**: the gap callouts now name the car.
- **Shortcut and script text.** The Gaps shortcut descriptions and the two entries' `test` lines name the `race` preset for the number, and the `practice` preset (a player car but an empty driver list) for the fallback.
- **Rules.**
  - `race-positions.md`: the Gap tracking bullet gains a sentence saying the callouts name the car the event carries.
  - `race-engineer-callout-examples.md`: one entry with the reusable lesson. When an existing line gains a numbered form and another clause follows it, the numbered branch is required rather than optional.

## Rejected alternatives

- **Driver names:** see the issue.
- **Keep today's line and append "That's car forty-two.":** the optional clause would be safe with no condition, but the car would be named twice and every call would get longer.
- **A tail clip after the number ("… is closing in"):** see *Wording*.
- **The number frozen into the gap events' payloads:** see *Where the number comes from*.
- **Re-pointing the car-number conditioning at a gap lead-in:** it re-cuts 1,110 clips, and it would only trade which lead-in they fit.
- **A condition that also checks the active voice holds the clip:** this is a known limitation shared with #1127's `caution.hasFollowCarNumber`. It was identified during #1127's review but is written down nowhere in #1127's code or rules; its description says only that it is false "when the session cannot spell the car's number". This spec is where it is recorded. Both conditions ask the session whether it can spell the number, not the voice whether it holds the clip, and `gap.hasCarNumber` inherits that on purpose. Closing it would need an engine seam that vocabulary resolvers do not have today. It would also have to be fixed for both conditions together, or the two families would behave differently on the same pack. And it would only rescue a pack that is already defective, since the reference voice spells every number iRacing issues.
- **The numberless line whenever the neighbour has changed or left the world:** it misattributes the sentence. See *Which car*.
- **A `case` over side and direction in place of the two intro vars:** the family's lines are vars today. Mirroring `gap.line` and `gap.thresholdLine` keeps the pairs obvious to a pack author.

## Unverified, and what would settle it

- **Whether each lead-in joins the number cleanly.** Settled only by listening (see *Clips and conditioning*).
- **Whether session info keeps a departed car's `DriverInfo` entry.** Either answer is handled. It decides only whether a stale call about that car is named or numberless.

None of this blocks implementation.

## Order of work, and review

1. After #1127 merges, write the code: the reader, the dependency, the vocabulary and the family tests.
2. Then the script and the clips: dry run, generation, audition.
3. Then the artifacts, the catalog entry and the documentation.

Four names join the published pack vocabulary, and the `default` catalog entry (the release contract) changes. So this takes an `xhigh` review (`code-review.md`: an honest choice between two rows takes the higher).
