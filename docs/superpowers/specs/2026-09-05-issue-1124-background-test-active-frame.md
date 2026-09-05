> **Issue:** [#1124](https://github.com/niklam/iracedeck/issues/1124) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# The Background Test plays the selected voice's frame

## The problem

Since [#1064](https://github.com/niklam/iracedeck/issues/1064) the radio frame is pack-defined: `frames.radio` in the voice's `callouts.json`, expanded by the engine around every spoken body. The Background **Test** button predates that and plays the plugin's three built-in clips directly (`background-test.ts`), so for a pack with its own beeps the preview and the callouts disagree. The #1064 review found it; the fix was deferred because it needs an engine surface that did not exist.

## The decision

**One frame mechanism.** The preview asks the engine for the active voice's frame rather than keeping a second copy of what a frame is. `IScenarioEngine` gains one method:

```ts
playFramePreview(frameName: string, holdMs: number, onComplete?: () => void): boolean;
```

It expands the active voice's compiled frame through the same `applyFrame` path a callout uses — the Radio beeps and Pit ambience switches, the SFX channel for frame play ops, the ambient steps — around a `pause` of `holdMs`, plays it on the Voice bus like a callout, and returns `false` without playing when the active voice has no compiled frame of that name (no script, or a frame that failed to compile). The preview then falls back to the built-in clips it plays today and logs the fallback at debug. `background-test.ts` keeps the fallback and loses its own copy of the switch logic.

**Why a method, not an accessor.** Handing the preview the frame's resolved steps would make it re-implement expansion, channel routing and the switches — the duplication the issue exists to remove. A method that plays keeps every rule in one place.

**Why the preview does not fire a scenario.** A contract with a pause-only body gets no frame under the empty-body rule (a frame wraps speech), and the rule is right for callouts; the preview is the one legitimate case of a frame around silence, so it is a separate entry point rather than an exception in `applyFrame`.

## Scope

In: the engine method and its tests, `background-test.ts`, the `background` kind in `audio-previews.ts`, the settings page's Test description, the changelog, `packages/audio-scenarios/CLAUDE.md`.

Not in: the per-callout Play button ([#1066](https://github.com/niklam/iracedeck/issues/1066)), which fires real contracts and needs no frame preview.

## Rejected alternatives

- **Expose the compiled frame's steps and expand them in the preview.** Duplicates the expansion rules; see above.
- **Register a hidden preview contract with a silent body.** Fights the empty-body rule, and a contract needs a trigger it would never use.
