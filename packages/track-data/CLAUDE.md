# @iracedeck/track-data

Bundled corner markers from Lovely Sim Racing, keyed by `WeekendInfo.TrackName`. Zero runtime dependencies.

## License

The data is CC BY-NC-SA 4.0 and used with permission (#888). Attribution is a condition of that grant: the credits in `CORNER_DATA_ATTRIBUTION` (`src/attribution.ts`, whose comment lists the grant's terms) are never removed from the Property Inspector or the website docs.

## Refreshing the data

`src/corners.iracing.ts` is generated. Refresh it with `node packages/track-data/scripts/refresh-corner-data.mjs` after building the package.

A corner the refresh adds then needs a hand-authored `corner-names` entry and clip in every published voice, the same entry in each; `packages/audio-assets/src/corner-names.test.ts` fails until it has one (#1336).
