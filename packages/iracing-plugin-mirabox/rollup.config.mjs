import { createPluginRollupConfig } from "@iracedeck/plugin-build";

export default createPluginRollupConfig({
  configUrl: import.meta.url,
  sdPluginDir: "com.iracedeck.sd.core.sdPlugin",
  platform: "mirabox",
  extraExternals: ["ws"],
  assetCopy: { actionIcons: ["icon.svg", "key.svg"], elgatoPluginImgs: true },
  // VSD Craft requires <html> without a lang attribute.
  stripHtmlLang: true,
});
