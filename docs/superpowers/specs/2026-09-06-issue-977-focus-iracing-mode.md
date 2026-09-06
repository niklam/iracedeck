> **Issue:** [#977](https://github.com/niklam/iracedeck/issues/977) (folds in [#978](https://github.com/niklam/iracedeck/issues/978)) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# Focus iRacing Window: Always, When required, Never

## The problem

Focus iRacing Window has been on by default since 3.0 (#930). It is wired at the platform level — every plugin registers `focusIRacingIfEnabled()` on the adapter's `onKeyDown` / `onDialDown` / `onDialRotate` — so it runs before every press, including presses that never talk to iRacing (Switch Profile, Audio Controls, Pit Crew toggles, the display actions) and presses that reach iRacing through SDK broadcasts, which arrive whatever window is in front. Only keystrokes and chat need the foreground.

#977 as filed proposed narrowing focusing to the keystroke and chat paths for everyone. The maintainer's ruling (2026-09-06): he likes that a deck press brings iRacing up, nobody has asked for it to stop, and the narrowing is worth having only as a choice. So the setting grows from a switch into a mode, and the narrow behaviour is opt-in.

A second gap rides along. Touch-strip gestures on the Stream Deck+ dispatch real key bindings but never trigger focusing, because `IDeckPlatformAdapter` has no plugin-level touch hook (#978). Whatever mode is chosen, touch must be covered.

## What ships

`focusIRacingWindow` becomes a three-value mode:

| Mode | What it does | Who it is for |
|---|---|---|
| **Always** (default) | Before every key press, dial press and dial rotation, as today. | Everyone who does not open the setting; a deck press always raises the sim. |
| **When required** | Only before something that needs the foreground: a keyboard binding, a chat command, a touch gesture that taps a binding. SDK broadcasts, SimHub roles and plugin-only actions leave the foreground alone. | Someone who presses deck keys while working in another window and does not want iRacing pulled over it unless a keystroke is about to go there. |
| **Never** | No focusing. | The old "off". |

Existing installs keep what they had: a stored `true` reads as Always, `false` as Never.

## Decisions

### 1. Two call sites, one mode

The adapter-level hooks stay where they are and run under **Always** only. A second call site, `focusIRacingBeforeInput()` in the window-focus service, runs under **Always** and **When required** — from the binding dispatcher immediately before a keyboard send (`tap`, `hold`, `tapSequence`; not before a SimHub role, which goes out over TCP), and from the chat command before it types. **Never** runs neither.

Running the second site under Always as well is deliberate: it is what covers touch gestures (#978) without adding `onTouchTap` to `IDeckPlatformAdapter` — an interface change that would touch every typed mock adapter for one consumer — and it is free, because the native focuser returns `AlreadyFocused` on a window it has just focused. Under Always a keyboard press therefore asks twice; the second ask is a foreground-window compare.

The comms catalog (`action-comms.json`, #612) is **not** consulted. Everything that passes through the dispatcher's keyboard branch or the chat send is by definition a keystroke; the catalog would be a second source of truth for a fact the call site already knows.

### 2. The chat command takes a pre-send hook; the SDK stays deck-core-agnostic

`ChatCommand.sendMessage` types its text through the native layer (open chat by broadcast, paste, enter, close), so the paste needs the foreground. `@iracedeck/iracing-sdk` cannot import deck-core, so `createSDK` / `createCommands` (`factory.ts`) gain an optional `beforeKeystrokes?: () => void` that `ChatCommand` calls before the native send; deck-core's `initializeSDK` (`sdk-singleton.ts`) passes `focusIRacingBeforeInput`. `macro()` and the other chat broadcasts do not take it — they are broadcasts.

The ordering guarantee chat has today — focus lands before the chat window opens — is preserved by construction: the hook runs synchronously before the native call, exactly where the adapter-level hook ran relative to the key handler.

### 3. Same key, wider schema, no migration marker

The key stays `focusIRacingWindow`. The schema accepts the legacy boolean or its string form and the three mode strings in one transform: `true` / `"true"` → `"always"`, `false` / `"false"` → `"never"`, an unknown value → the default through `.catch("always")` per `global-settings.md`. The next write persists the mode string. No one-shot migration and no marker: the transform *is* the migration, and it holds for every future read of an old file.

The cost, recorded so it is not rediscovered: an older build reads `"always"` through its boolean transform as not-`true` and turns focusing **off** after a downgrade. Accepted — the settings file is the plugin's own, a downgrade is rare, and the old build's checkbox restores it in one click.

### 4. Mouse to Sim is untouched

`focusIRacingNow()` — the View Adjustment **Mouse to Sim** press — skips the mode entirely, as it skips the switch today: there the press *is* the focus, and Never must not make that key inert.

### 5. The elevation short-circuit (#976) applies to every mode

When the elevation probe has reported a mismatch, both call sites skip the native focuser. That gate is #976's; this spec only notes that it sits inside the focus service, below the mode, so neither issue depends on the other's order.

### 6. Surfaces

- **Settings window, General tab** (`global-common-window-focus.ejs`): the checkbox becomes an `sdpi-select` with the three modes, labelled **Always**, **When required**, **Never**, supporting text naming what "required" means. Nothing in an action PI (`settings-window.md` rule 1).
- **Getting Started** (#1061): the one-press "Turn on Focus iRacing Window" writes `"always"`; `ird-enable-feature` reads `"always"` and `"required"` (and the legacy `true` / `"true"` / absent) as on, so the offer renders only for **Never**.
- **Website**: `docs/features/focus-iracing-window.md` describes the three modes, drops the "touch strip is not covered" paragraph, and keeps the upgrading section true (an existing choice is kept). Changelog line under **Improvements**.
- **Rules**: `keyboard-shortcuts.md` (the focus paragraph), `global-settings.md` (the schema excerpt), `plugin-structure.md` (the init-order comment on the hooks).

## Verification

- Legacy `true` / `false` / absent parse to `always` / `never` / `always`; the three strings parse to themselves; junk parses to `always` without aborting the settings parse.
- **Always**: alt-tabbed away, a Switch Profile press raises iRacing; a keybind press raises it once (second ask returns `AlreadyFocused`); a touch gesture that taps a binding raises it.
- **When required**: alt-tabbed away, Switch Profile / Audio Controls / a display action do not raise iRacing; a keybind press, a chat action (Chat, Tire Service `#t` macro) and a binding-tapping touch gesture do; a SimHub-role binding does not.
- **Never**: nothing raises iRacing; Mouse to Sim still does.
- Chat still sends reliably in every mode where it focuses — the paste lands after focus, as today.

## Affected artifacts

- `deck-core`: `window-focus-service.ts` (mode + `focusIRacingBeforeInput`), `binding-dispatcher.ts` (keyboard branches), `global-settings.ts` (schema), `sdk-singleton.ts` (passes the chat hook), `settings-window-commands.ts` (`enableFeatureWrites`), tests for each.
- `iracing-sdk`: `factory.ts` (`createSDK` / `createCommands`) and `ChatCommand` pre-send hook, tests.
- `pi-components`: `global-common-window-focus.ejs`, `enable-feature.ts`, tests.
- All three `plugin.ts`: no change to the hook registrations — the gate moves inside the service.
- Website: feature page, changelog; `pnpm generate:changelog-data`.
- Rules named in Decision 6.
