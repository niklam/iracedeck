/**
 * Supported hardware brands — the single source of truth for every surface that
 * answers "will iRaceDeck work with my device?".
 *
 * Consumed by the landing page's "Works with" strip, the download cards, and the
 * installation guide (via `BrandStrip.astro` / `BrandNames.astro`), so adding a
 * brand here propagates everywhere. Do not retype these lists in prose.
 */

/** A hardware ecosystem — one plugin build serves each. */
export type Ecosystem = "elgato" | "mirabox" | "ulanzi";

export interface EcosystemInfo {
  /** Human name of the ecosystem, as used in headings and card titles. */
  label: string;
  /**
   * The supported hardware, phrased for prose ("For {devices}."). Model-level
   * detail lives here; the brand tiles stay brand-level.
   */
  devices: string;
  /**
   * Whether {@link BRANDS} names every brand shipping this ecosystem's hardware.
   * When false, surfaces that list the brands say so rather than implying the
   * list is exhaustive.
   */
  listIsComplete: boolean;
}

export interface Brand {
  /** Display name, spelled the way the brand spells it. */
  name: string;
  ecosystem: Ecosystem;
  /**
   * File name of a logo under `src/assets/brands/`, with one of the extensions
   * in {@link BRAND_LOGO_EXTENSIONS}. Optional: a brand without one renders as a
   * wordmark tile, which is the common case for the smaller Mirabox OEM brands
   * that publish no usable asset.
   */
  logo?: string;
  /**
   * Set when {@link logo} is an icon-only mark that does not spell the brand
   * out, so the tile shows the name beside it. Without this a visitor has to
   * already recognise the mark to know which brand it is.
   */
  logoNeedsName?: boolean;
  /**
   * Set when the brand's guidelines forbid recoloring its mark. Such a logo is
   * shown in its own colors instead of the strip's uniform monochrome tone.
   */
  preserveBrandColor?: boolean;
}

/**
 * Logo file extensions `BrandStrip.astro` can resolve. Its `import.meta.glob`
 * pattern has to be a literal (Vite requires a static pattern), so this list is
 * the mirror that `brands.test.ts` checks every declared logo against — an
 * extension outside it exists on disk but never reaches the strip.
 */
export const BRAND_LOGO_EXTENSIONS = [".svg", ".png", ".webp", ".avif"] as const;

/** Declaration order is display order. */
export const ECOSYSTEMS: Record<Ecosystem, EcosystemInfo> = {
  elgato: {
    label: "Elgato Stream Deck",
    devices: "Stream Deck, Stream Deck Mini, Stream Deck XL, and Stream Deck+",
    listIsComplete: true,
  },
  mirabox: {
    label: "Mirabox Ecosystem",
    devices: "Stream Dock devices",
    // The same Stream Dock hardware is resold under a long tail of OEM brands,
    // with no published list of them. These are the ones we can name.
    listIsComplete: false,
  },
  ulanzi: {
    label: "Ulanzi Deck",
    devices: "Ulanzi Deck D200, D200H, D200X, and Dial",
    listIsComplete: true,
  },
};

/**
 * Declaration order is display order within an ecosystem.
 *
 * Logos are each brand's own asset, taken from that brand's own site (see
 * `src/assets/brands/README.md`). VAPOURD, KILOGOGRAPH, and HALCONTORNO sell
 * only through marketplaces and publish no logo asset, so they render as
 * wordmark tiles — as does Stream Dock, whose mark is the same grid as
 * Mirabox's and would read as a duplicate next to it.
 */
export const BRANDS: readonly Brand[] = [
  { name: "Elgato", ecosystem: "elgato", logo: "elgato.svg" },

  { name: "Mirabox", ecosystem: "mirabox", logo: "mirabox.png" },
  { name: "Stream Dock", ecosystem: "mirabox" },
  { name: "SOOMFON", ecosystem: "mirabox", logo: "soomfon.png" },
  { name: "VAPOURD", ecosystem: "mirabox" },
  { name: "KILOGOGRAPH", ecosystem: "mirabox" },
  { name: "HALCONTORNO", ecosystem: "mirabox" },
  { name: "VSDinside", ecosystem: "mirabox", logo: "vsdinside.png" },
  { name: "Nouvolo", ecosystem: "mirabox", logo: "nouvolo.png" },

  { name: "Ulanzi", ecosystem: "ulanzi", logo: "ulanzi.png", logoNeedsName: true },
];

function toList(ecosystem: Ecosystem | readonly Ecosystem[]): readonly Ecosystem[] {
  return typeof ecosystem === "string" ? [ecosystem] : ecosystem;
}

/** One ecosystem's brands, carrying that ecosystem's own completeness flag. */
export interface BrandGroup {
  ecosystem: Ecosystem;
  /** The ecosystem's brands, in declaration order. */
  brands: readonly Brand[];
  /** Mirrors {@link EcosystemInfo.listIsComplete} for this ecosystem. */
  listIsComplete: boolean;
}

/**
 * The requested ecosystems as separate groups, in the order requested and, within
 * a group, in declaration order.
 *
 * Grouping keeps `listIsComplete` attached to the brands it describes, so a
 * surface can mark an open-ended list where it actually is instead of at the end
 * of the whole strip — where it would silently attribute the unnamed brands to
 * whichever ecosystem happened to be rendered last.
 */
export function brandGroupsFor(ecosystem: Ecosystem | readonly Ecosystem[]): BrandGroup[] {
  return toList(ecosystem).map((wanted) => ({
    ecosystem: wanted,
    brands: BRANDS.filter((brand) => brand.ecosystem === wanted),
    listIsComplete: ECOSYSTEMS[wanted].listIsComplete,
  }));
}

/**
 * The brands of one or more ecosystems, grouped in the order the ecosystems were
 * requested and, within a group, in declaration order.
 */
export function brandsFor(ecosystem: Ecosystem | readonly Ecosystem[]): readonly Brand[] {
  return brandGroupsFor(ecosystem).flatMap((group) => group.brands);
}

/** An item of a natural-language list, paired with the text that follows it. */
export interface SentenceListSegment {
  value: string;
  /** Separator rendered after this item — empty for the last one. */
  separator: string;
}

/**
 * Splits a list into segments for rendering as an Oxford-comma sentence, so a
 * template can wrap each item in its own markup without owning the punctuation.
 */
export function toSentenceList(items: readonly string[]): SentenceListSegment[] {
  return items.map((value, index) => {
    const remaining = items.length - index - 1;

    if (remaining === 0) return { value, separator: "" };

    if (remaining === 1) return { value, separator: items.length === 2 ? " and " : ", and " };

    return { value, separator: ", " };
  });
}
