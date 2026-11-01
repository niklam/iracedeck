# Sector start calls in practice and test

> **Issue:** [#1573](https://github.com/niklam/iracedeck/issues/1573) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

Measured at `3e40a7f4f`.

## The problem

In practice and test sessions the Race Engineer names each corner as the car approaches it (#888: `packages/sim-events-iracing/src/diff/corner-name.ts`, wired at `translator.ts:2961`, the contract at `packages/audio-scenarios/src/catalog/pit-crew/corner-name.ts:78-104`), but never says where a sector starts. Nothing parses the track's sectors: `SplitTimeInfo` (shape in `packages/iracing-native/src/mock-data/session-info.ts:510-517`) appears elsewhere only in a test fixture (`packages/iracing-sdk/src/template-context.test.ts:1574`). The issue's Goal settles the product: a short "Sector three." as the car crosses into a new sector, the track's own sectors however many, working the way the corner names do, practice and test only (Niklas, 2026-11-01). This spec settles the parse, the trigger, the line it shares with the corner calls, sector one, the setting, and what #1572 (`docs/superpowers/specs/2026-11-01-issue-1572-sector-comparison.md`) builds on.

## Decisions

### 1. This issue owns the sectors: the `SplitTimeInfo` parse, its cache and `getTrackSectors()`

A pure `extractSectorStarts(sessionInfo): number[] | null` in a new `packages/iracing-sdk/src/sector-utils.ts` returns the sector start fractions, sorted by `SectorNum`. It returns `null`, and no sector feature runs, unless every entry has a finite `SectorStartPct` in `[0, 1)`, the values are strictly ascending, and the first is 0 (within `1e-6`). The first-is-zero gate is what lets a lap's sectors be counted from the start/finish line. All 21 track configurations in the 211 Telemetry Snapshots under `local/` (gitignored, measured 2026-11-01) start at 0.0000, and they range from two sectors (every oval, Rallycross) to seven (Le Mans): Tsukuba 4, Barber 3, Red Bull Ring 3, Spa 4, Road Atlanta 4, Monza 5, Zolder 5, Suzuka 6, Motegi 6. A track whose first sector does not start at the line gets no sector calls rather than a model that has not been seen. `SectorNum` 0 is spoken "sector one".

The translator caches the result per `(TrackID, SessionNum)` and exposes it as `getTrackSectors(): { starts: readonly number[] } | null`, in every session type. That key is built by hand three times today, identically, at `translator.ts:3221` (track length), `:3251` (corner markers) and `:3275` (pit speed limit); a fourth copy is one too many, so one `trackSessionKey(sessionInfo, telemetry)` helper replaces all three and builds the new one. It is the one place any feature reads the sectors, #1572 included.

### 2. The trigger is the player's lead point crossing a sector start, swept exactly as the corner names are

Niklas: "announce sector starts like we announce turns". So the call is timed by the same lead point, `LapDistPct + min(CORNER_LEAD_MAX_PCT, Speed × leadSeconds ÷ trackLengthMeters)` (`corner-name.ts:110-111`), with the same `cornerCalloutLeadSeconds` setting (the "Corner call lead" slider, default 1 s). A call therefore lands as the car reaches the line, as a corner name lands at the corner. One knob for both, because a driver who tunes how early the engineer speaks wants that for every marker on the lap.

The sweep rules are #888's, unchanged: a silent first-tick seed; a boundary fires when it falls inside the forward interval the lead point swept this tick; once per sector per lap, the spoken set cleared when the lead point wraps the line (`corner-name.ts:136`); reversing never fires; a jump over `CORNER_TELEPORT_THRESHOLD` re-anchors silently (`corner-name.ts:127`); several boundaries in one tick speak only the nearest; on pit road a crossing is consumed and not announced (`corner-name.ts:162`). So the two calls cannot drift apart, both halves come out of `diffCornerName` into one pure module, `diff/lead-point-sweep.ts`: `leadPointPct(lapDistPct, speed, leadSeconds, trackLengthMeters)`, the lead computation of `corner-name.ts:110-111`, and `sweepLeadPoint`, the sweep. Both diffs call both. Each diff keeps its own gates (session, markers or sectors, track length, on track) and its own previous point and spoken set in `TranslatorState`. The corner tests pass unchanged on the extracted module, which is the extraction's proof.

A new live diff, `diff/sector-start.ts`, runs right after `diffCornerName` with the same inputs plus `getTrackSectors()` and the corner markers, and emits a new bus event:

```typescript
/**
 * The car's lead point (the configured lead ahead of it, the same point the
 * corner-name calls use) crossed the start of a sector, in a practice or test
 * session. Every sector start, sector 1 at the start/finish line included;
 * once per sector per lap.
 */
"sectorStart.approaching": SimEvent<
  "sectorStart.approaching",
  {
    /** The sector being entered, as a driver counts them: 1 is the sector that starts at the line. */
    sector: number;
    /** How many sectors the track has. */
    sectorCount: number;
    /**
     * Seconds, at the current speed, from this sector start to the next corner
     * this translator announces through `cornerName.approaching`. Null only when
     * there is no corner data for the track, no track length or no speed.
     */
    nextCornerInS: number | null;
  }
>;
```

`nextCornerInS` is defined against the bus, not against a dataset: it is the time to the next `cornerName.approaching` this translator would publish on the lap at the current speed, so a consumer can relate the two events without knowing where either comes from. The diff measures it as the forward distance, in lap fraction and wrapping the line, from the sector start to the next marker `diffCornerName` sweeps, times the track length, divided by the current speed. There is no reach bound: the next corner may be most of a lap away, and the number then simply says so.

The payload is sim-agnostic: any sim with sectors and corner data can fill it. It is a published catalog change (`xhigh`), with an `event-names.ts` entry in the harness and a `TICK_ORDER` row (`via: "pending"`) right after the corner-name row, its `events` the module's `SECTOR_START_EVENTS`.

### 3. Practice and test only, gated in the diff; never in a replay

The diff is gated like `diffCornerName`: `sessionType !== "" && classifySessionType(sessionType) === "practice"` (`translator.ts:3038`), which covers Practice, Lone Practice and Offline Testing and leaves qualifying, warmup and the race silent. In the diff, the #655 / #888 shape, so the harness can publish the event freely. Replays never speak it: the diff runs after the replay guard, which reads the controller's debounced replay state (`race-engineer-callouts.md`, the #1324 reason), and it takes no replay gate of its own.

### 4. Sector one is emitted at the line and not spoken there

The diff publishes every sector start, sector 1 included: the event reports what happened on track. The contract `pit-crew.sector-start-approaching` refuses `data.sector === 1` in its `where:`, so the speaking decision sits with the rest of the speaking decisions. The line is already the lap's own marker, the one place on track a driver never needs to be told where they are, and in practice it is where the lap-time calls speak (#555, #1163): "Sector one." would either delay them or, with the every-lap time on, precede it on every single lap. So a three-sector track hears "Sector two." and "Sector three." each lap.

### 5. When a corner call and a sector call are due together, the corner call wins

The corner is what the driver acts on; the sector start is orientation. Two cases:

- **A corner call is playing or starts first.** The sector contract is `weight: WEIGHT.CHATTER` and `queueable: false`; the corner contract is the default `WEIGHT.NORMAL`, also not queueable. A sector fire that cannot take the bus is dropped, so a corner name in flight is never delayed or cut by it. On a tick where both are swept, `diffCornerName` runs first, so the corner is published first and wins the idle bus too.
- **A corner is due just after the sector start.** A sector line already playing would make the heavier corner fire wait for it (a heavier fire without `interrupt` waits for the line in flight, `race-engineer-callouts.md`), landing the corner name late. So the contract's `where:` refuses the fire when `nextCornerInS <= SECTOR_START_CORNER_CLEARANCE_S` (1.5 s, about the length of a corner name plus a beat) and the corner call would actually be spoken: `enabledIn(CORNER_NAME_CALLOUTS)` for `corner-names` AND `engine.isScripted("pit-crew.corner-name-approaching")` (the #1571 owner-resolver precedent), one resolver built inside `registerPitCrew`. With the corner names switched off, or a voice that does not script them, every sector start is called.

The translator reports the fact and the catalog decides, because only the catalog knows whether a corner call will be heard. One case is accepted: a corner the active voice scripts but has no clip for still suppresses the sector call, since `where:` cannot see clips; a dataset corner a first-party voice lacks already fails `audio-assets/src/corner-names.test.ts`.

### 6. Scheduling and the line

`pit-crew.sector-start-approaching`, a new family `sector-start` with its own `family: "sector-start"` (not `corner-name`: same-family replacement would let a sector start cut a corner name mid-word), `weight: WEIGHT.CHATTER`, `interrupt: false`, `queueable: false` (a late sector call is a wrong one, #888's reasoning), and `frame: NO_FRAME`, the terse delivery the corner names use, stated beside it. Its `description`: "Your car reaches the point about a second (the configured lead) before a sector start in a practice or test session, once per sector per lap, the start/finish line excepted; qualifying and races stay silent."

### 7. The clips: this issue owns the `sector-number` group, one through ten, both voices

A `sector-number` group, entries `1` to `10` with the text "Sector one." to "Sector ten.", one take each, in both voices: the Terse voice's text is identical, so its clips are copies of Default's with their manifest rows (no paid call). The text is phrase-final and capitalised as a sentence, because it is either a whole call here or the end of a sentence in #1572's lines. "Sector one." is recorded although this callout never speaks it, because #1572 names sector one.

Ten is the bound because the most measured is seven (Le Mans) and a clip is cheap. There is no clamp in code (`race-engineer-callouts.md`, value-indexed clips): past ten the clip does not exist, so the call is skipped whole (#835). Adding sector eleven later is a clip-file change only.

The script entry is one step, `"{{sectorStart.number}}"`, a var returning `poolRef("sector-number", String(data.sector))` from the fire's own event (`ctx.event`, so no plugin-side cache is needed).

**Draft, for Niklas's approval before any clip is generated** (both voices): "Sector one.", "Sector two.", "Sector three.", and so on to "Sector ten."

Vocabulary, published generously: the var `sectorStart.number` (the sector being entered, from the sector-number group: `sector-number/3` is "Sector three."), and the condition `sectorStart.isFinal` (the sector entered is the track's last), which the bundled scripts do not use and a pack may, for a "Final sector." of its own.

### 8. The setting: one, default on

A new family `packages/callout-settings/src/families/sector-start.ts`, `id: "sector-start"`, one callout `"sector-starts": { key: "calloutEnabledSectorStarts", label: "Sector starts (practice/test)" }`, no `default` (it ships on). It goes in the `corner-names` group of `CALLOUT_PI_GROUPS` (`packages/callout-settings/src/pi-groups.ts:78`), beside the corner names and under the lead slider that times both. That group's title becomes "Corner Names and Sectors"; its id, and every key, stay. The Pit Crew action's Corner Names key keeps toggling only the corner names.

### 9. This issue ships before #1572

#1572 depends on this issue and builds on it. #1573 adds the parse, `trackSessionKey`, the cache and `getTrackSectors()` (decision 1), the `sector-number` group (decision 7), the lead-point module, the diff, the event, the family and the setting, with their tests. #1572 then adds the sector timer, its readers and the comparison family, and reuses all of the above unchanged.

### 10. Artifacts beyond the code

- `iracing-sdk`: `sector-utils.ts`.
- `sim-events-iracing`: `trackSessionKey` at the four cache sites, `diff/lead-point-sweep.ts`, `diff/sector-start.ts`, state in `state.ts` (type and `createInitialState()`), `getTrackSectors()`, the `TICK_ORDER` row and its spy line in `tick-order.test.ts`.
- `event-bus`: the event and its doc comment.
- `audio-scenarios`: `catalog/pit-crew/sector-start.ts`, its `SCENARIO_ID_TO_SECTOR_START_ID` and the `GATED` row in `callout-settings-coverage.test.ts`.
- Both voice packs: the `sector-number` group, the script entries, `callouts.json`, clips, catalog entries and a pack `version` bump.
- `scenario-harness`: the `event-names.ts` template and the shortcuts below.
- Website: a "Sector starts (practice & test)" paragraph in the Corner names section of the Race Engineer page, saying the corner call lead times both and that sector one is not called; the settings-window screenshot is retaken for the renamed heading; a `Features` changelog fragment; the pack reference regenerated.
- `race-engineer-callout-examples.md`: a #1573 entry (a second marker set on #888's sweep through one extracted module, an event that reports every crossing while the contract chooses what to say, and a collision the translator measures and the catalog decides).

## Approaches weighed and rejected

- **Calling exactly at the line, with no lead.** The line would be passed before the words were out, and the corner names would land on a different clock; the issue asks for the corner-name timing.
- **A separate lead setting.** A second slider for the same idea; one lead times every marker.
- **Folding sector starts into the corner-name diff's marker list.** The sweep would be shared, but the two calls have separate settings, payloads and session text, and the corner event's published payload would have to grow a sector field.
- **One combined line ("Sector three. Turn eleven.") when both are due.** It joins two families with separate opt-ins into one event or one script, and the sector half is the one with nothing to act on.
- **Deciding the collision in the translator.** It would need the corner-name opt-in and the voice's script injected into the translator, policy where only facts belong.
- **Defining `nextCornerInS` by the dataset with a reach bound.** It would tie the published event to `@iracedeck/track-data` and to a constant of the corner diff; defined against `cornerName.approaching`, it means the same thing to any consumer and any sim.
- **Dropping sector one in the diff.** The event would then misreport the track, and the decision would sit outside the contract that owns the other speaking decisions (decision 4).
- **The sector call queueable, or sharing the corner names' family.** A queued "Sector three." heard after the line is wrong; a shared family would let it cut a corner name.
- **Speaking sector one at the line** (decision 4).
- **Qualifying too.** Settled by Niklas: practice and test only.

## Out of scope

- Sector times or deltas in practice (a delta to the driver's own best sector). #1572 measures sector times in races only.
- Changing the corner-name calls, their lead or their key.
- Making the Pit Crew Corner Names key toggle the sector calls.
- Tracks whose first sector does not start at the line.

## Testing

**Unit tests, one per rule:**

- `iracing-sdk` `sector-utils.test.ts`: the mock's three sectors; entries out of `SectorNum` order sorted; a first start other than 0, a repeated or descending start, a value at or above 1, a missing or empty `Sectors` each return `null`; one sector returns `[0]`.
- `translator.test.ts`: `trackSessionKey` keys all four caches the same way (the three existing caches' tests pass unchanged, the extraction's positive control); `getTrackSectors()` re-resolves on a new `(TrackID, SessionNum)` and answers in practice, qualifying and race; the diff is behind the replay guard (a replay tick crossing a sector start emits nothing, and the next live crossing does).
- `diff/lead-point-sweep.test.ts`: `leadPointPct` (speed scaling, the 0.2 cap, the wrap) and the sweep's own cases (forward interval, nearest of several, wrap clears the spoken set, reversing, teleport re-anchor). The existing `diff/corner-name.test.ts` passes unchanged on the extracted module, the positive control that the extraction changed nothing.
- `diff/sector-start.test.ts`: a lead point crossing the start of each sector emits each once with the right `sector` and `sectorCount`, sector 1 at the line included; a second lap announces again; reversing and a teleport never fire; pit road consumes; qualifying, warmup and race are silent; no sectors is silent; `nextCornerInS` for a marker 0.01 lap past the start at a known speed and track length, for the next marker across the line (wrapping), and `null` with no markers, no track length or zero speed.
- `audio-scenarios` `sector-start.test.ts`:
  - `sector: 1` is silent, and the same fixture with `sector: 2` speaks, its positive control;
  - a practice event speaks the `sector-number` clip; a sector with no clip (11) is skipped whole;
  - `nextCornerInS` at 1.5 s with the corner names on and scripted is silent, and at 1.6 s speaks; at 0.5 s with the corner names off speaks, and with them on but unscripted by the voice speaks;
  - a corner name in flight drops the sector fire, and a sector fire never cuts or delays a playing corner name on a held bus.
- `bundled-scripts.test.ts`, `script-coverage.test.ts`, `callout-settings-coverage.test.ts`, the settings baseline and `tick-order.test.ts` cover the rest.

**Harness shortcuts** (Harness → Corner Names): "Sector three" (`sector: 3, sectorCount: 4, nextCornerInS: null`), "Sector one at the line" (silent), "Sector start with a corner due" (`nextCornerInS: 0.8`, silent while the corner names are on, spoken once they are off), and "Sector eleven" (silent: no clip).

**Manual offline check**, in an Offline Testing session at a track with four or more sectors and corner data (Spa or Monza): each sector start except the line is called once a lap, landing as the car reaches the sector line iRacing's own timing splits at; where a named corner sits just past a sector start, only the corner is heard, and switching the corner names off brings the sector call back; changing the corner call lead moves both calls together; a pit visit says nothing in the lane; a qualifying session and a replay say nothing; the setting silences only the sector calls.
