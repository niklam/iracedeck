import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Starlight 0.42 reads an `i18n` collection unconditionally and Astro 7.3
  // warns when it is undefined (#1152). Declared empty: the site keeps
  // Starlight's default UI strings.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
