> **Issue:** [#1126](https://github.com/niklam/iracedeck/issues/1126) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# The voice-pack plugin wiring moves into deck-core helpers

## The problem

The three `plugin.ts` files mirror each other by convention, and [#1064](https://github.com/niklam/iracedeck/issues/1064) added three more byte-identical blocks to that convention: the `_voicePacks` view model that keeps scripts out of the settings-window payload, the missing-script banner re-assertion, and the `applyScripts` → `setScripts` hand-off around `registerPitCrew`. Each was verified identical by diffing the three files at review time, which is a check that only postpones drift. The frame-switch reader was already pulled into `frameOptionsFromSettings()` during that PR for the same reason.

## The decision

Follow the pattern `createSettingsChannelPublisher` and `frameOptionsFromSettings` already set: deck-core owns the rule, the plugin owns one call.

- `voicePackListPayload(packs, problems)` — the `_voicePacks` shape, with `voices` reduced to `{ id, label }`. Pinned by a test that the payload carries no `script` field, since that is the invariant the mapping exists for.
- `createVoiceScriptWarningReassert({ scripts, getActiveVoice, set, clear })` — returns the `reassert()` the plugins call after every scan and on every settings arrival, wrapping the existing pure evaluator and reporter.
- The `applyScripts` hand-off stays a closure in each plugin: it depends on `isAudioScenariosInitialized()` and the engine singleton, both of which deck-core must not import. One line per plugin is the honest minimum.

**Boundary that holds throughout:** deck-core does not depend on `@iracedeck/audio-scenarios`. Anything that needs the engine stays in the plugin; anything that only needs settings and the voice-pack service moves.

## Scope

In: the two helpers and their tests, the three call sites, `.claude/rules/plugin-structure.md` and the plugin step of `race-engineer-callouts.md`.

Not in: a shared plugin-common package (far larger than this needs), and the harness, which wires the same seam differently on purpose.
