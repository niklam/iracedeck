---
category: Bug Fixes
weight: 50
---

A voice pack that records its spotter lines as numbered takes, such as `car-left-01.mp3`, now plays its spotter calls, where before it played none at all; a pack may ship the plain `car-left.mp3`, numbered takes, or both, as for every other line. `pnpm lint:pack` now also names each spotter line missing from a pack whose script uses the spotter, and each spotter clip the spotter never plays, such as a one-digit take. See [Lint the pack](/docs/voice-packs/first-pack/#lint-the-pack).
