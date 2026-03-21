# @iracedeck/stream-dock-plugin

VSDinside Stream Dock plugin for iRaceDeck. Registers actions from `@iracedeck/actions` with VSD Craft via `@iracedeck/deck-adapter-vsd`.

Mirrors the structure of `@iracedeck/stream-deck-plugin` but targets VSDinside devices instead of Elgato Stream Deck.

## Key Differences from stream-deck-plugin

- Uses `VSDPlatformAdapter` instead of `ElgatoPlatformAdapter`
- Manifest uses `"Knob"` instead of `"Encoder"` for dial actions
- No `Encoder.layout` field (VSD doesn't support encoder layouts)
- Uses `ws` package for WebSocket communication (VSD bundles Node.js 20)
- No PI template plugin (PI compatibility is a separate work item)
- `SDKVersion: 1` instead of `3`

## Build

```bash
pnpm build  # Rollup → com.iracedeck.dock.core.sdPlugin/bin/plugin.js
```

## Window Focus

The `window-focus.ts` module is duplicated from `stream-deck-plugin` rather than shared via `deck-core`, to avoid adding test infrastructure to `deck-core`. Extraction is planned as a follow-up.
