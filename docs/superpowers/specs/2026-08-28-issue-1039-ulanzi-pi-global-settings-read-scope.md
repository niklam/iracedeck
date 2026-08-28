# Ulanzi PI global settings: the read and the write need opposite scopes

> **Issue:** [#1039](https://github.com/niklam/iracedeck/issues/1039) · **Supersedes:** _none_ · **Superseded by:** _none_
>
> Point-in-time design record. The code and `.claude/rules/` are the truth; this is not documentation.

## Problem

On UlanziStudio every plugin-global setting reads as unset in an action's Property Inspector. Key bindings show empty; *Related Key Bindings* looks like nothing was ever configured. The same settings are correct in the Settings window and in the plugin-owned settings file, so nothing is actually lost — the PI simply never learns them.

The plugin side is healthy. A local run shows the store loading from file, the settings server binding, and the once-per-start host mirror going out 22 ms after the socket opened:

```text
2026-08-28T05:02:06.890Z INFO [Ulanzi:WebSocket] Connected to UlanziStudio
2026-08-28T05:02:06.893Z INFO [GlobalSettings] Global settings loaded from the settings file
2026-08-28T05:02:06.911Z INFO [SettingsWindow] Settings window server started
2026-08-28T05:02:06.912Z INFO [SettingsWindow] Mirrored settings + channel to the deck host
```

So the host holds the settings and the channel. The PI just cannot get them out.

## Evidence

A read-only probe (a second WebSocket to the running UlanziStudio, mimicking a PI socket, sending only `connected` and `getGlobalSettings`) establishes which identity fields decide whether the host replies:

| Frame identity | Host answers? | Payload |
| --- | --- | --- |
| `uuid=plugin, key="", actionid=""` — **what the PI bridge sends today** | **silent** | — |
| `uuid=plugin, key=<pi>, actionid=<pi>` | answered | 238 keys, `_settingsChannel` present |
| `uuid=action, key="", actionid=""` | silent | — |
| `uuid=action, key=<pi>, actionid=<pi>` — what the plugin adapter re-drives | answered | 238 keys |
| `uuid=plugin, key=<pi>, actionid=""` | silent | — |
| `uuid=plugin, key="", actionid=<pi>` | answered | 238 keys |

Two facts fall out, and both are load-bearing:

1. **`actionid` is the reply-routing address.** A blank one is never answered; a non-empty one always is. `key` alone does not help. The host echoes the `actionid` back on the reply, and it answered an `actionid` that has never existed on this machine — so it is routing by the asking socket and using the field as an address label, not as a lookup key.
2. **`uuid` decides nothing on a read.** Every answered variant returned the same plugin-wide bucket, including the variants that asked with an action UUID. The bucket is not selected by the frame's `uuid` on the way out; it is only selected on the way *in*, by a write.

### The failure chain

The router's bootstrap read goes out unanswerable, its 3 s settle timer fires, and `fallbackWith(undefined, …)` replays the queued frames **to the host in the same unanswerable shape**. No `didReceiveGlobalSettings` ever reaches sdpi-components, so its `getGlobalSettings()` promise never resolves and every `global`-bound control stays empty. The Settings window is unaffected because it never asks the host at all — it dials the loopback settings server with its launch token.

This is worth stating plainly because it contradicts a documented assumption. `packages/deck-adapter-ulanzi/CLAUDE.md` predicts that a PI which cannot bootstrap "works against the host copy — reads fine, but its global-settings edits then never reach the plugin". On this host the fallback is not a working read path either, so the router's "never a blank PI" guarantee does not hold on Ulanzi.

### Where it came from

`90716112` (#895, the #868 persistence fix) changed the read from `...base` to a new `globalScope`:

```ts
const globalScope = { uuid: PLUGIN_UUID, key: "", actionid: "" };
case "getGlobalSettings":
  return { cmd: "getGlobalSettings", ...globalScope };
case "setGlobalSettings":
  return { cmd: "setGlobalSettings", ...globalScope, settings: asRecord(frame.payload) ?? {} };
```

Blanking the identity was correct for the **write** — it is what stopped key bindings scattering into per-action buckets the plugin never reads back. It was applied to the **read** as well, which had been working precisely because `base` carried a non-empty `actionid`. That is why 2.1.0 users saw the fields load but not persist, and why today it is the exact reverse: one constant now serves two frames that need opposite things.

## Decision

**Scope the two directions separately.** The read carries the PI's own routing identity; the write keeps the blank plugin scope.

```ts
// Reply routing: UlanziStudio answers a read only when `actionid` is non-empty
// (#1039). The uuid selects nothing on a read — the reply is the plugin-wide
// bucket either way — so keep the plugin UUID and state the intent.
case "getGlobalSettings":
  return {
    cmd: "getGlobalSettings",
    uuid: PLUGIN_UUID,
    key: identity.key,
    actionid: identity.actionid || PI_READ_ACTIONID,
  };
// Bucket selection: a write MUST stay plugin-scoped with a blank context (#868).
case "setGlobalSettings":
  return { cmd: "setGlobalSettings", ...globalScope, settings: asRecord(frame.payload) ?? {} };
```

Three choices inside that, each with a reason:

**Keep `uuid: PLUGIN_UUID` on the read**, even though the probe shows the field is ignored. It costs nothing observable, it keeps the read and the write agreeing about which bucket they mean, and if a future host version ever does key its lookup by `uuid`, plugin scope is the answer we want. Reverting to the action UUID would re-assert on a global frame exactly the identity #868 blamed, in exchange for nothing.

**Carry `key` as well as `actionid`.** Only `actionid` is required, but `key` is part of the PI's true identity and the host echoes both; sending the real pair keeps the frame honest rather than minimal.

**Fall back to a synthesized non-empty `actionid`.** `readIdentity` defaults `actionid` to `""` when the URL omits it, and a PI served that way would be right back in the failure. The probe shows the host routes happily by an `actionid` that never existed, so a constant is safe, and it is strictly no worse than the empty string it replaces. This is belt and braces against the one dependency the probe could not verify — the real PI's URL params — where the failure mode is total and silent.

## Alternatives rejected

**Revert the read to the pre-#895 `...base`.** It works — that shape is answered — but it puts the action UUID back on a global-settings frame. The probe proves the uuid buys nothing on a read, so this trades away the explicit plugin-wide intent for no gain, and leaves the next reader to rediscover why a global frame is action-scoped.

**Deliver the channel out of band, via `sendToPropertyInspector`.** The bridge already announces itself with a `propertyInspectorDidAppear` marker, so the plugin could push `_settingsChannel` back rather than have the PI read the host store. This is the fallback plan if the `actionid` dependency ever proves unreliable, but it is the wrong first move: it is a bespoke Ulanzi-only divergence from the shared router contract, it is still a request/response with extra steps, and it would leave the plain host read broken — so the router's fallback path would stay dead on this host.

**Probe the host at runtime**, trying scopes until one answers. Guessing on the wire to rediscover, on every PI open, a rule we have already measured.

**Treat an unanswered bootstrap as a hard error with a banner.** A diagnosis aid, not a fix. Worth considering separately if a host ever fails a read we believe should work; it does not belong in the path to correct behaviour.

## Consequences

- The PI bootstraps the loopback channel, so PI edits reach the plugin-owned file again and window ↔ PI stay in sync live, as #993 phase 2 intends everywhere else.
- The fallback path becomes a working read path on Ulanzi as a side effect: a PI that cannot reach the channel at least reads the host copy, which is what the router's design has always claimed.
- The "open question for a community tester" in `packages/deck-adapter-ulanzi/CLAUDE.md` is answered — the host does **not** answer the read as sent — and its prediction about the fallback path is wrong. Both must be corrected.

### Deliberately not fixed here

**Fallback-path writes are still ignored by the plugin.** A PI that cannot bootstrap has its edits echoed as saved and dropped. That is the standing design item from #993 and unchanged by this fix — but far less reachable once the bootstrap works.

**The plugin's own connect-time read is still blank-scoped and unanswered.** It is covered by the adapter's `willAppear` re-drive (#868). The gap only opens on a first install where no action has ever been placed, and such an install has no PI to open either, so it closes itself before it can matter.

## Verification

Unit: `translate.test.ts` currently pins the broken read shape and must instead pin that the read carries a non-empty `actionid`, that a blank URL `actionid` still produces one, and that the write is untouched.

Manual, on UlanziStudio, with debug logging on: open an action's PI and confirm the bindings populate; change one in the PI and confirm the Settings window follows live and the settings file's content changes; confirm the plugin log shows the loopback upgrade being accepted rather than a PI console warning about the bootstrap. The debug log also reports the real PI identity, which is the one thing the probe had to synthesize.
