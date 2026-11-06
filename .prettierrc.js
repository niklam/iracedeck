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
      files: "*.astro",
      options: {
        parser: "astro",
      },
    },
    {
      files: "*.jsonc",
      options: {
        trailingComma: "none",
      },
    },
  ],
};