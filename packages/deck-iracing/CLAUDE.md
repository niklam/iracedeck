# @iracedeck/deck-iracing

iRacing's side of the deck layer's sim-connection seam (#1351): `IRacingSimConnection` (the `SimConnection` `deck-core` reads), the `IRacingAction` base for actions that read the SDK directly, the SDK singleton (`initializeSDK`, `getController`, `getCommands`), and the iRacing helpers actions share — the app monitor, fuel telemetry, unit conversion, the hotkey presets, the elevation check and the replay-session subscriber. It depends on `deck-core`, never the other way round.
