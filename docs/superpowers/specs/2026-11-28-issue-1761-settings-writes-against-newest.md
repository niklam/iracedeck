# A plugin settings write never reverts a newer settings change

> **Issue:** [#1761](https://github.com/iracedeck/iracedeck/issues/1761) · **Related:** [#1794](https://github.com/iracedeck/iracedeck/issues/1794), [#1243](https://github.com/iracedeck/iracedeck/issues/1243), [#1597](https://github.com/iracedeck/iracedeck/issues/1597) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Context

Three actions push a device-filtered profile list into their own settings so the PI dropdown can show it: Camera Controls (Focus Pick Car), Switch Profile, and Race Admin (select-car). Each writes `setSettings({ ...ev.payload.settings, _deviceProfiles })` after awaits in its appear or settings handler. A host stores settings as one whole object, so the write can replace a newer object with the event's older snapshot.

Since #1597, `ContextEventOrder` runs `willAppear`, `willDisappear` and `didReceiveSettings` one at a time per context, in every adapter. So a PI change made while the handler awaits is **queued** behind it, not interleaved with it. At write time the plugin holds nothing newer. Merging onto `BaseAction`'s newest settings alone therefore does not fix the repro: the stale write reaches the host after the host has stored the PI's object. The queued handler then runs for the new settings and, with a Mode that is no longer Focus Pick Car, writes nothing. The host keeps the reverted object.

Two related defects sit on the same path:

- The profile-list write spreads the event payload, which lacks the `addedWithVersion` stamp that `BaseAction.onWillAppear` has just written, so it drops the stamp.
- Race Admin's `persistMigratedSettings` writes the migrated object, and its profile-list write then writes the pre-migration payload. That puts `useViewedCar` back and drops `driverTarget`. A select-car key with `addedWithVersion` and no `driverTarget` reaches this.

## Decision

1. **A per-context settings record in deck-core, write-through.** A new `ContextSettings` (`packages/deck-core/src/context-settings.ts`) replaces `BaseAction`'s `contextSettings` map. It holds the newest settings the plugin knows for each context: what the host last delivered, or what the plugin last wrote. `getContextSettings` returns that record. It is exported from `@iracedeck/deck-core/testing`, so the action-test fakes run the real implementation (`action-tests.md`).

2. **One write helper on `BaseAction`:**

   ```ts
   protected updateSettings(
     ev: IDeckEvent<T>,
     update: (current: Readonly<Record<string, unknown>>) => Record<string, unknown> | undefined,
   ): Promise<boolean>
   ```

   - If the context has no record (it never appeared, or it disappeared), the helper writes nothing and returns `false`.
   - `next = update(record)`. `undefined` means the record already holds the change, so nothing is written. Updaters are pure, because they may be re-run on newer settings.
   - If a newer settings event has already **arrived** for the context (`ev.isSuperseded?.()`), the helper does not write. It parks the updater instead. `onDidReceiveSettings` re-runs the parked updaters through the helper right after recording the new payload. `willAppear` and `willDisappear` drop them.
   - Otherwise it sets the record to `next` synchronously, then awaits `ev.action.setSettings(next)`. On failure it logs a warning, keeps the record, does not throw, and returns `false`.
   - An updater, rather than a partial patch, lets a migration delete a key.

3. **Arrival token from `ContextEventOrder`.** The order numbers every arrival. `ContextEventTask` receives `{ isSuperseded(): boolean }`. That is true once a later `willAppear`, `willDisappear` or `didReceiveSettings` for the context has arrived, and was not dropped at arrival. Inputs and `step:*` never supersede. Ulanzi's `step:promoteToEncoder` re-appears the context from a client cache that already holds the plugin's write. Each adapter passes the token into the events it builds. `IDeckEvent` gains an optional `readonly isSuperseded?: () => boolean`. It is optional because test files build event literals; the contract suite holds adapters to it.

4. **Writers routed through it in #1761:**
   - The three profile-list writes. One shared `deviceProfilesUpdate(deviceType, applies)` in `iracing-actions/src/shared/profile-entries.ts` decides whether the mode applies and checks equality against the record, not the event payload.
   - `BaseAction`'s `addedWithVersion` stamp.
   - Camera Controls' and Race Admin's `persistMigratedSettings`, which write before the profile list in the same handlers.

   The profile-list write merges onto the record, so these writes must be recorded, or the stamp and migration defects remain. The other writers listed in #1794 stay there.

5. **The echo wording is corrected.** `types.ts`, `base-action.ts`, `deck-core/CLAUDE.md`, `profile-entries.ts` and the call-site comments disagree with the dial surfaces and the 2026-11-21 architecture review about whether a host echoes the plugin's own `setSettings`. The design does not depend on the answer: if the host echoes, the echo supersedes later writes in that handler, which are re-applied on the echo and stop there because each updater returns `undefined` once its change is present. The text says so and no longer asserts either way.

## Alternatives rejected

- **Merging onto the newest record alone:** the newer event is still queued at write time.
- **A `getSettings()` on the action context:** widens every host's contract, and on Elgato the answer arrives as a `didReceiveSettings` queued behind the running handler.
- **A per-context query on `ContextEventOrder` or the adapter:** `BaseAction` cannot reach the adapter instance without a new global, and a per-context answer cannot place an event's own arrival.
- **Letting the queued handler repair the host:** the stale write still lands, so the key and PI flicker, and it rewrites the user's object on a guess.
- **Each host's own settings cache:** only Ulanzi has one.
- **Skipping without re-applying later:** an appear-only write, the stamp now and seeds in #1794, would be lost.
- **Making `isSuperseded` required:** it touches every hand-built event in tests, for nothing the contract suite does not already enforce.

## Residual windows

These are not closed by any plugin-side guard and are stated in the PR:

1. A PI change the host has stored and sent, but which has not yet reached the adapter's `enqueue` when the plugin's write leaves. This window is well under a millisecond on loopback.
2. The PI writes its whole form state, which can lack a key the plugin just wrote. `_deviceProfiles` heals on that event. `addedWithVersion` heals on the key's next appear.
3. A write from outside any handler, such as a timer or telemetry callback, has no arrival token. None exists in #1761; #1794 must not route such a writer through this helper.

## Out of scope

- The writers left in #1794: migrations in other actions, dial and key seeds, Fuel Service's unit write, Tire Service's updates write, and `dial-persist.ts`.
- The dial surfaces' own per-context settings caches.
- Any change to the settings schemas; `_deviceProfiles` is already in all three.

## Testing

- `context-event-order.test.ts`:
  - the token is false for a lone task;
  - it turns true when a `didReceiveSettings` or `willDisappear` arrives during the task;
  - it stays false for `keyDown`, `dialRotate` and `step:*`;
  - a token from before a disappear and re-appear reads true.
- A new scenario in `CONTEXT_EVENT_ORDER_SCENARIOS` that all three adapter suites run, plus a reference adapter that omits the token and is pinned to fail it.
- `context-settings` / `base-action` tests, with a real `ContextEventOrder` and a fake host that applies PI and plugin writes in order:
  - the issue's repro: no write from the old settings, and the host ends with the PI's object;
  - the stamp and the profile list in one handler both survive;
  - a superseded stamp is re-applied onto the newer settings;
  - an unchanged updater writes nothing;
  - a disappear means no write;
  - a rejected write keeps the record;
  - with a host that echoes writes, everything converges with no loop.
- The three action tests:
  - newer settings in another Mode mean no profile-list write;
  - the write is the newest object plus `_deviceProfiles`;
  - Race Admin's legacy migration survives the profile-list write;
  - Switch Profile still reports its marker when the write rejects.
- Manual, by Niklas, on Stream Deck and on Mirabox or Ulanzi: the issue's repro (Focus Pick Car, then change Mode at once) keeps the new Mode in both the key and the PI. Whether the key itself ever snapped back before the fix tells which echo reading is true.
