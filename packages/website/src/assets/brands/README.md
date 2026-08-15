# Brand logo assets

Logos for the hardware brands shown by `BrandStrip.astro`. Everything about the
brand list itself lives in `src/data/brands.ts` — this folder only holds files.

These are third-party trademarks, shown to identify compatible hardware
(nominative use). They are not iRaceDeck's, and the landing page footer says so.

## Provenance

Each asset is the brand's own logo, taken from that brand's own website on
2026-08-15, then trimmed of transparent padding and scaled down to 120 px tall.

| File | Source |
|------|--------|
| `elgato.svg` | Header logo on <https://www.elgato.com/> (inline SVG; site-specific classes stripped, `currentColor` fixed to black) |
| `mirabox.png` | <https://mirabox.net/cdn/shop/files/MiraBox_Logo_white.png> |
| `soomfon.png` | <https://soomfon.com/cdn/shop/files/LOGO-RGB1.png> |
| `vsdinside.png` | <https://www.vsdinside.com/cdn/shop/files/VSD_LOGO.png> |
| `nouvolo.png` | <https://www.nouvolo.com/cdn/shop/files/MM_Nouvolo_d4310abe-1f59-4211-8ca3-043736b12d87.png> |
| `ulanzi.png` | Header logo on <https://www.ulanzi.com/> — an icon-only mark, so its entry sets `logoNeedsName`. The white counter inside the mark was made transparent so the monochrome filter keeps the shape readable; the outline is unchanged. |

VAPOURD, KILOGOGRAPH, and HALCONTORNO sell only through marketplaces and publish
no logo asset, so they render as wordmark tiles. Stream Dock's mark is the same
grid as Mirabox's and would read as a duplicate beside it, so it does too.

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
- **Trim the canvas.** Tiles size logos by a shared box, so any transparent
  padding left in the file shows up as that one logo rendering smaller than the
  rest.
- **Size for optical weight, not bounding box.** `--brand-logo-box` in
  `src/styles/custom.css` is kept short relative to the tile width so the height
  is what limits each logo — that is what makes differently-shaped marks come
  out equally tall. A logo wider than about 5:1 runs out of tile width first and
  lands shorter (VSDinside does); one far outside that range may need its own
  rule.
