import elgatoConfig from "@elgato/prettier-config";

export default {
  ...elgatoConfig,
  tabWidth: 2,
  useTabs: false,
  // The website's Astro components and pages are formatted like any other
  // source (#1616): `format` and the pre-commit step reach them, and
  // scripts/lint-format-coverage.test.mjs holds format to every file lint reads.
  plugins: [...(elgatoConfig.plugins || []), "prettier-plugin-astro"],
  overrides: [
    ...(elgatoConfig.overrides || []).filter(
      (o) => !o.files?.includes?.("*.json") && o.files !== "*.json",
    ),
    {
      files: ["*.json", "*.jsonc"],
      options: {
        tabWidth: 2,
        useTabs: false,
      },
    },
    {
      files: "*.jsonc",
      options: {
        trailingComma: "none",
      },
    },
    {
      // prettier-plugin-astro moves only the whitespace Astro's compiler would
      // collapse anyway, and this tells it which: "jsx", Astro 7's compressHTML
      // default, drops a whitespace run that holds a newline and keeps a
      // same-line space. So it may put the full stop after `<code>!</code>` on
      // the next line, or a link's text on lines of its own, and the page still
      // reads `!.` and an underline with no space either side (#1616). Named
      // rather than left to the plugin's default so the two cannot drift:
      // packages/website/astro.config.mjs sets no compressHTML, and
      // scripts/format-staged.test.mjs compiles a formatted paragraph with
      // Astro's compiler and fails when either side moves.
      files: "*.astro",
      options: {
        astroCompressHTML: "jsx",
      },
    },
  ],
};