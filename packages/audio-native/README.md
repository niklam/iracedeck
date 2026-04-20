# @iracedeck/audio-native

Native Node.js addon (C++/N-API) wrapping the [miniaudio](https://miniaud.io) single-header audio library. Provides a 4-channel mixer used by Pit Engineer and other audio-playing actions.

See `CLAUDE.md` for the full function reference and `src/index.ts` for the TypeScript surface.

## Build requirements

- Node.js 24 or later
- Python 3.x
- Visual Studio Build Tools with "Desktop development with C++" workload (Windows only)

## Platform support

- **Windows**: compiles the native `.node` addon.
- **macOS / Linux**: ships a JS mock (`AudioNativeMock`) that returns success for every call but produces no audio.

The `AudioNative` class selects the right backend at module load, so consumers never branch on platform.

## Mock mode

Set `IRACEDECK_MOCK=1` or place an empty `.mock` file in the process's working directory to force mock mode on Windows.

## License

See `LICENSE` at the repo root.
