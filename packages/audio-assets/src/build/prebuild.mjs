// Turbo entry for `@iracedeck/audio-assets#build`. Warms
// `.cache/<pipeline-hash>/voice/...` so the parallel plugin builds that
// depend on this task (`^build`) find a fully-warm cache and only read
// from it. See `prebuildAudioAssetCache` for the contention rationale.

import { prebuildAudioAssetCache } from "./index.mjs";

await prebuildAudioAssetCache({ logger: (msg) => console.log(msg) });
