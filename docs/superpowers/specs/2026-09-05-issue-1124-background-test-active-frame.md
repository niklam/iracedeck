> **Issue:** [#1124](https://github.com/niklam/iracedeck/issues/1124) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# The Background Test plays the selected voice's frame

## The problem

Since [#1064](https://github.com/niklam/iracedeck/issues/1064) the radio frame is pack-defined: `frames.radio` in the voice's `callouts.json`, expanded by the engine around every spoken body. The Background **Test** button predates that and plays the plugin's three built-in clips directly (`background-test.ts`), so for a pack with its own beeps the preview and the callouts disagree. The #1064 review found it; the fix was deferred because it needs an engine surface that did not exist.

## The decision

**One frame mechanism.** The preview asks the engine for the active voice's frame rather than keeping a second copy of what a frame is. `IScenarioEngine` gains one method:

```ts
playFramePreview(frameName: string, holdMs: number, onComplete?: () => void): FramePreviewResult; // "playing" | "no-frame" | "bus-busy"
```

It expands the active voice's compiled frame through the same `applyFrame` path a callout uses — the Radio beeps and Pit ambience switches, the SFX channel for frame play ops, the ambient steps — around a `pause` of `holdMs`, plays it on the Voice bus, and returns `"no-frame"` without playing when the active voice has no compiled frame of that name (no script, or a frame that failed to compile). The preview then falls back to the built-in clips it plays today and logs the fallback at debug. `background-test.ts` keeps the fallback, and with it the two switches: the built-in clips are not a compiled frame, so the engine cannot apply them there (amended during implementation — the first draft said the switch logic would go).

**The preview yields to every callout** (amended during implementation, after review). It never cuts, delays or displaces one: it starts only on a free Voice bus — nothing playing, nothing pending, no focus floor held — and returns `"bus-busy"` otherwise, in which case the Test plays nothing (the built-in fallback would play over the engineer). A callout that would play while the preview runs treats the bus as idle and cuts the preview, once that callout has expanded to something to play. The first draft had the preview take the bus at a weight below every band; review showed that cut a live callout (lost if not queueable), parked every arrival in the single pending slot so a second one could drop the first, and deferred `TRANSIENT` lines that must play at once or not at all. `onComplete` runs however the preview ends — finished, cut, or `stopAll` — because the caller holds the Background bus open past the master gate for it.

**Why a method, not an accessor.** Handing the preview the frame's resolved steps would make it re-implement expansion, channel routing and the switches — the duplication the issue exists to remove. A method that plays keeps every rule in one place.

**Why the preview does not fire a scenario.** A contract with a pause-only body gets no frame under the empty-body rule (a frame wraps speech), and the rule is right for callouts; the preview is the one legitimate case of a frame around silence, so it is a separate entry point rather than an exception in `applyFrame`.

## Scope

In: the engine method and its tests, `background-test.ts`, the `background` kind in `audio-previews.ts`, the settings page's Test description, the changelog, `packages/audio-scenarios/CLAUDE.md`.

Not in: the per-callout Play button ([#1066](https://github.com/niklam/iracedeck/issues/1066)), which fires real contracts and needs no frame preview.

## Out of scope

The per-callout Play button (above), and any change to the Radar or Race Engineer voice Test buttons, which play no frame.

## Testing

Engine tests drive `playFramePreview` against a pack frame with its own beep: the ops and the hold, the switches, every `"no-frame"` cause, a busy bus and a focus floor, arrivals of each scheduling shape cutting it, an arrival that aborts leaving it running, `stopAll`, and a throwing completion. `background-test.ts` is tested against a mocked engine for each result and the fallback. By hand: select a pack whose frame has its own beep, press Test, and hear that beep; select a voice with no frame and hear the built-in ticks; press Test mid-callout and hear nothing cut.

## Rejected alternatives

- **Expose the compiled frame's steps and expand them in the preview.** Duplicates the expansion rules; see above.
- **Take the bus at the lowest weight and let the scheduler arbitrate.** The first implementation; see *The preview yields* above.
- **Register a hidden preview contract with a silent body.** Fights the empty-body rule, and a contract needs a trigger it would never use.
