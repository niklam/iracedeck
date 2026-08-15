# Brand logo assets

Logos for the hardware brands shown by `BrandStrip.astro`. Everything about the
brand list itself lives in `src/data/brands.ts` — this folder only holds files.

## Adding a logo

1. Drop the asset here as `<brand>.svg` (preferred) or `.png` / `.webp` / `.avif`.
   Use a transparent background and trim the canvas to the artwork.
2. Set `logo: "<brand>.svg"` on that brand's entry in `src/data/brands.ts`.

That is the whole change — the strip switches that brand from a wordmark tile to
the image, and the tile keeps its size and tone. A `logo` pointing at a file that
is not here fails the build (and `brands.test.ts`) rather than silently falling
back to a wordmark.

## Conventions

- **Prefer official assets** from the brand's own press kit or website over
  scraped images, for provenance as much as quality.
- **Logos are recoloured to a single neutral tone** per theme, so the strip reads
  as a compatibility statement rather than a sponsor wall. Where a brand's
  guidelines forbid recolouring, set `preserveBrandColor: true` on its entry and
  supply the approved full-colour asset — or leave it as a wordmark tile.
- **Size for optical weight, not bounding box.** The tile constrains height and
  caps width; a logo with an unusual aspect ratio may need its own tweak in the
  `.brand-strip` rules in `src/styles/custom.css`.
