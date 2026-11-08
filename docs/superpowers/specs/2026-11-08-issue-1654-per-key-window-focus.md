> **Issue:** [#1654](https://github.com/niklam/iracedeck/issues/1654) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

# A per-key override for bringing the iRacing window to the front

## The problem

**Focus iRacing window** is one plugin-wide mode (#977): `always` (the default), `required` or `never`. It is read at two sites in `deck-core`'s `window-focus-service.ts`:

- **Press time:** `focusIRacingIfEnabled`, which `plugin-runtime`'s `registerActions` hangs on the adapter's `onKeyDown` / `onDialDown` / `onDialRotate` listeners. It runs under `always` only.
- **Keystroke time:** `focusIRacingBeforeInput`, called by the keyboard service right before each native send and by the chat send through `createSDK`'s `beforeKeystrokes` hook. It runs under `always` and `required`.

A deck mixes keys that want different answers. A broadcaster typing in OBS wants camera keys, which are SDK broadcasts that arrive whatever window is in front, to switch the shot without pulling iRacing forward. The same deck's keystroke keys must bring it forward, and a key that comes before an outside macro may need iRacing in front although it sends nothing itself. One global mode cannot serve all three.

Neither site can see the key. The adapter listeners receive no event, and the keyboard service does not know which press it is serving.

## What ships

Every action gets a per-key **Focus iRacing window** choice in its **Common Settings**, on the keypad and dial surfaces alike:

| Value | Stored | Press time | Keystroke time |
|-------|--------|------------|----------------|
| Use global setting (default) | `"global"` | as today | as today |
| Bring iRacing to the front | `"focus"` | focuses, whatever the global mode | focuses, whatever the global mode |
| Don't bring iRacing to the front | `"no-focus"` | never | never |

## Decisions

### 1. Three values, no per-key When required

On one key, When required is the same as one of the other two: a key either sends keystrokes (then it focuses at keystroke time, as `focus` does) or it does not (then it never focuses, as `no-focus` does). The third value, `global`, is not a mode but the absence of an override. It keeps every existing key unchanged, and it lets a later change to the global mode still reach the whole deck. The maintainer chose this shape (2026-11-08).

Rejected:
- **A single "Don't bring iRacing to the front" checkbox.** It cannot express `focus` on a deck set to When required or Never, the case of a key that comes before an outside macro.
- **Mirroring all four global values per key.** It adds a value that behaves like one of the others on every key.

### 2. The field: `windowFocus` on `CommonSettings`

`windowFocus: z.enum(["global", "focus", "no-focus"]).default("global").catch("global")` is added to `CommonSettings` in `deck-core/src/common-settings.ts`. The `.catch` keeps a value from a newer build from failing the whole parse, which would reset the key to full defaults. An older build ignores the unknown key, so a downgrade returns the key to the global mode, which is what it did before. `CommonSettings` is a contract every action stores, so the branch is reviewed at `xhigh`.

### 3. Press time: a per-action wrapper replaces the adapter listeners

`deck-core` gains `withWindowFocus(handler)`, next to `withPressSounds`. `registerActions` wraps every action with it, inside the press-sound wrapper (`withPressSounds(withWindowFocus(action.create(…)))`), and drops the three adapter listeners. At `onKeyDown`, `onDialDown` and `onDialRotate` the wrapper reads `windowFocus` from `ev.payload.settings` through the field's own schema, then calls the handler. Before calling it:

- **`global`** calls `focusIRacingIfEnabled()`, exactly as the listener did, so the default path is unchanged.
- **`focus`** calls a new `focusIRacingForKey()`. It skips the mode check and the settings-store-ready gate, since the key's own setting is the decision. It keeps the elevation-mismatch gate (#976) and the post-timeout cooldown: they stop a focus that cannot succeed from stalling the plugin, which applies to a per-key ask as much as to a global one.
- **`no-focus`** does nothing.

The wrapper covers every registered action, the host's extras included, as the listeners did, and focuses before the handler runs, as the listener did by being registered first. Touch taps keep their current press-time behaviour (no press-time focus, #978), but run inside the scope from decision 4, so `no-focus` and `focus` reach their keystrokes.

Rejected: passing the event through the adapter's listener (`onKeyDown(callback: (ev) => void)`). That changes `IDeckPlatformAdapter`, a seam implemented by three adapters, for something registration can do on its own. `onKeyDown` / `onDialDown` / `onDialRotate` stay on the interface; removing them is out of scope.

### 4. Keystroke time: the press runs in an async scope the focus service reads

The keystroke site is reached from far below the action: through the binding dispatcher, through direct `getKeyboard()` calls (Race Admin's paste, Car Control's Escape), and through the chat send in `iracing-sdk`. So the key's choice travels in an `AsyncLocalStorage` (`node:async_hooks`), owned by `window-focus-service.ts`. The wrapper runs every handler member (`onKeyDown`, `onKeyUp`, `onDialDown`, `onDialUp`, `onDialRotate`, `onTouchTap`) inside `focusScope.run(windowFocus, …)`, and `focusIRacingBeforeInput` reads `focusScope.getStore()` first:

- `"no-focus"` returns without focusing.
- `"focus"` focuses through `focusIRacingForKey()`'s gates, whatever the global mode.
- `"global"` or no scope keeps today's mode check. No scope covers anything not started by a press.

The scope follows everything the handler starts: awaited calls, promise chains (Black Box Selector's serialized queue is attached inside the handler), and timers set inside it (hold-to-repeat, `RepeatController`), since Node carries the async context into callbacks created within it. Work a handler only schedules for later through an outside queue keeps the scope it was created in. A camera switch queued through `requestCameraSwitch` sends SDK broadcasts and never reaches the keystroke site, so the difference does not matter there.

Rejected: threading a context id or the override through `tapBinding`, the binding dispatcher, `IKeyboardService` and `ChatCommand`. That changes every signature on the way down, and still misses the direct `getKeyboard()` callers unless each is changed by hand. The scope reaches all of them with no signature changes, from one place.

### 5. The control lives in Common Settings, which moves out of the keypad-only wrapper

The `common-settings.ejs` accordion gains a **Focus iRacing window** `sdpi-select` (`setting="windowFocus"`, `default="global"`) with the three labels above. Its hint says that **Don't** sends a key's keystrokes to whatever window is in front.

In the 18 dial-capable PIs the accordion sits inside `#keypad-appearance`, which `dial-controller` hides on the dial surface, so the control would vanish there. The accordion therefore moves out of `#keypad-appearance` in those 18 templates, to just after it. Its **Flags Overlay** item, which only draws on a key icon, is marked `data-keypad-only`. `irdApplyDialView()` in the shared `dial-controller` partial hides every `[data-keypad-only]` element along with the wrappers it already hides. That gives one generic hook, so a later keypad-only item in a shared partial needs no template edit. A test in `iracing-actions/src/pi-templates/` checks that every action template including `common-settings` places it outside every surface-conditional wrapper, in the way `action-settings-footer.test.ts` checks the footer.

Rejected:
- **Putting the control in `action-settings-footer.ejs`,** which already sits outside the wrappers. It would leave Common Settings as the place for every other per-key behaviour except this one.
- **A second dial-only copy of the control.** Two controls on one setting is the trap `settings-window.md` rule 12 names.

### 6. Logging

The wrapper logs nothing at info. When a per-key value changes what happens, it logs at debug once per press:
- `Focus skipped for this key (per-key setting)` for `no-focus`;
- `Focus requested by this key's setting` for `focus` when the global mode would not have focused.

That way a support log with debug on explains a press that did or didn't bring iRacing forward. The focus service's own result logging is unchanged.

## Out of scope

- **A per-key When required** (decision 1).
- **Removing `onKeyDown` / `onDialDown` / `onDialRotate` from `IDeckPlatformAdapter`,** which nothing else uses once this lands. That's an adapter seam change for its own issue.
- **Press-time focus on touch taps** (#978, closed as not planned).
- **Mouse to Sim** (`focusIRacingNow`), which focuses because that is what the key is for. It ignores the per-key value as it ignores the global one.
- **A camera-specific global setting.** When required already never focuses on a camera switch.

## Testing

Unit, in `deck-core`:
- **`windowFocus` parsing:** default, each value, junk, and a value from a newer build, none resetting the key's other settings.
- **`withWindowFocus`,** across each per-key value and each global mode:
  - press-time focus at key down, dial down and dial rotate;
  - none at key up, dial up or touch tap;
  - the handler called exactly once and after the focus;
  - the elevation gate and cooldown honoured by `focus`;
  - the store-ready gate honoured by `global` only.
- **The scope:**
  - a `tapBinding`, a direct `getKeyboard()` send and a chat send reached from inside a wrapped handler focus or not according to the value;
  - the scope survives an `await`, a promise chain and a `setTimeout` / `setInterval` started in the handler;
  - a keystroke from outside any press follows the global mode;
  - two keys pressed together keep their own values.
- **Composition:** `withPressSounds(withWindowFocus(h))` still plays and classifies press sounds exactly as before.

In `plugin-runtime`: `registerActions` wraps every action, the host extras included, and registers no focus listener on the adapter.

In `iracing-actions`' PI template tests:
- the control renders in every action PI on both surfaces;
- Common Settings sits outside every surface-conditional wrapper;
- Flags Overlay carries `data-keypad-only`.

Manual, on Stream Deck with a dial, then Mirabox and Ulanzi:
- **Global Always:**
  - a camera key set to **Don't** switches the camera while OBS stays in front;
  - a black-box key left at **Use global** still brings iRacing forward;
  - a black-box key set to **Don't** sends its key into the front window, as the hint says.
- **Global When required:** a camera key set to **Bring iRacing to the front** brings it forward on press, and a following Stream Deck hotkey reaches iRacing.
- **Global Never:** a key set to **Bring iRacing to the front** still focuses.
- **Dial:** the same three on a dial's press and rotation, and the control visible in the dial PI.
- **Held key:** a held Look Direction key set to **Don't** never steals focus while held.
- **Old decks:** a deck saved before the change behaves identically.
