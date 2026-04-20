# Radio-effect spike

Experiment harness for applying "race-engineer radio" ffmpeg filter chains to
MP3 voice assets. Spike-only — NOT wired into any plugin build.

## Layout

```text
scripts/radio-effect/
├── process.mjs     Main script
├── presets.mjs     Named ffmpeg filter-chain presets
├── input/          Drop *.mp3 files here (gitignored)
└── output/         One subfolder per preset, populated by process.mjs (gitignored)
```

## Usage

```bash
# 1. Install ffmpeg-static once at the repo root
pnpm add -w -D ffmpeg-static

# 2. Drop MP3s into input/
cp some-voice.mp3 scripts/radio-effect/input/

# 3. Run
node scripts/radio-effect/process.mjs

# 4. Listen to output/<preset>/<filename>.mp3
```

## Adding / editing presets

Edit `presets.mjs`. Each entry is:

```js
{
  name: "folder-name",
  description: "one-liner shown in docs",
  filterChain: "ffmpeg -af string",
}
```

Keep `name` filesystem-safe (lowercase, hyphens). The `filterChain` is passed
verbatim as the `-af` argument; escape carefully if you add commas inside
option values.

## Good starting knobs

- **Band edges** (`highpass=f=…,lowpass=f=…`) — classic telephone is
  300–3000 Hz. Widen for clarity, narrow for more "squashed" feel.
- **Compression** (`acompressor=threshold=…:ratio=…`) — lower threshold + higher
  ratio = more squash + more radio feel.
- **Volume boost** (`volume=NdB`) — after compression, push 2–5 dB to compensate
  for lost headroom.
- **Saturation** (`aexciter=amount=…`) — adds upper-harmonic crunch. Subtle
  amounts (3–8) simulate saturated radio transmitters.

## Not yet explored (future presets)

- Static / white-noise mix via `amix` + `anoisesrc`
- Squelch tail SFX prepended/appended with `concat`
- Per-category chains (e.g. sharper filter on `names/`, gentler on `spotter/`)
