# @iracedeck/deck-adapter-elgato

Elgato Stream Deck adapter that implements `IDeckPlatformAdapter` from `@iracedeck/deck-core`. Bridges the `@elgato/streamdeck` SDK to the platform-agnostic interfaces.

## How It Works

`ElgatoPlatformAdapter` wraps the Elgato SDK:

- **`registerAction(uuid, handler)`** — Creates a bridge `SingletonAction` subclass that sets `override manifestId = uuid` directly — deliberately **not** via the `@action({ UUID })` decorator, whose `__esDecorate` helper emits `(this && ...)` code that is invalid in ESM. Do not reintroduce the decorator. Delegates all lifecycle methods (`onWillAppear`, `onKeyDown`, dial handlers `onDialRotate`/`onDialDown`/`onDialUp`, and `onTouchTap`) to the platform-neutral handler
- **Event wrapping** — Converts Elgato events (`WillAppearEvent`, `KeyDownEvent`, etc.) to deck-core events (`IDeckWillAppearEvent`, `IDeckKeyDownEvent`, etc.) via `ElgatoActionContext`. The dial rotate event is wrapped with `ticks` and `pressed` (rotate-while-held) by `wrapDialRotateEvent`, and the encoder touchscreen tap via `wrapTouchTapEvent` (`tapPos`, `hold`).
- **Stream Deck+ dial bridging** — `ElgatoActionContext` bridges `isDial()`, `setFeedback(payload)`, `setFeedbackLayout(layout)`, and `setTriggerDescription(descriptions)` to the SDK `DialAction` (forwarding `DeckFeedbackPayload` as the Elgato `FeedbackPayload`); these are guarded so they no-op when the underlying action lacks them. The context also exposes `deviceId`/`deviceType` getters and `showAlert()` (present on `KeyAction` only — dials have no warning indicator).
- **Profile-switch wiring (Elgato-only)** — The constructor wires `sd.ui.onSendToPlugin` → `handleSendToPlugin`, routing the PI "Stream Deck Profiles" accordion's `switchToProfile` messages through the deck-core `requestProfileSwitch` singleton (not `this.switchToProfile` directly, so the switch lands in the per-device profile history, #762), after resolving the accordion's clean display names to device-suffixed manifest names via `deviceProfileName` (#753). The other adapters never receive this message.
- **`switchToProfile(deviceId, profile?, page?)`** — Delegates to `sd.profiles.switchToProfile`. A not-yet-installed profile triggers the Stream Deck app's install prompt — this is how the bundled profiles get installed and updated.
- **`openUrl(url)`** — `sd.system.openUrl`. Deliberately a concrete method on the adapter, not on `IDeckPlatformAdapter` (see `.claude/rules/global-settings.md`).
- **`WillDisappearEvent` special case** — Elgato's `ActionContext` lacks `setImage`/`setTitle`/`isKey` (and dial methods), so `wrapDisappearEvent()` provides no-op stubs
- **`createLogger(scope)`** — Wraps `streamDeck.logger.createScope()` via `createSDLogger()`
- **Global settings: one fan-out, two sources** — `onDidReceiveGlobalSettings(cb)` records the callback and subscribes to the SDK event once; `getGlobalSettings()` awaits the SDK's `settings.getGlobalSettings()` promise and hands its result to the same subscribers (#1208). Since `@elgato/streamdeck` 3.0 the SDK event fires only for a PI's save, so without the promise path the one-time host migration would never get its answer. The SDK resolves that promise on the next frame, uncorrelated, so a PI save arriving while a read is pending would otherwise be delivered twice; both paths receive the same frame's settings object, and the promise's value is dropped when it is the event's last payload by reference. A throwing subscriber is logged and does not stop the rest. `useLegacySettingsBehavior` stays off — turning it on would deliver the reply twice — and lint refuses the property. See `.claude/rules/global-settings.md`.
- **Neo Infobar instances are narrowed out** — SDK 3.0's `WillAppearEvent` / `DidReceiveSettingsEvent` action includes `NeoInfobarAction`, which has no image or title. No manifest entry declares that controller, so the bridge returns early on `ev.action.isNeoInfobar()` (willAppear, didReceiveSettings) and `controllerType === "Neo"` (willDisappear, whose `ActionContext` has no discriminator method) rather than casting. Supporting Neo Infobar actions is a separate decision.
- **Other adapter methods** — Delegate directly to the Elgato SDK (`setGlobalSettings`, `onApplicationDidLaunch`, `connect`, etc.)

## Also Contains

- `createSDLogger()` / `SDLoggerLike` — Wraps Elgato's SDK logger into the `ILogger` interface with level filtering. Defaults to `LogLevel.Debug` intentionally: level gating happens at the `streamDeck.logger` layer, so the wrapper keeps forwarding debug and a runtime `debugLogging` flip surfaces scoped debug logs without recreating loggers (see `.claude/rules/logging.md`)

## Build

```bash
pnpm build  # tsc → dist/
```

## Dependencies

- `@elgato/streamdeck` — The Elgato Stream Deck SDK
- `@iracedeck/deck-core` — Platform-agnostic interfaces
- `@iracedeck/logger` — `ILogger` interface
