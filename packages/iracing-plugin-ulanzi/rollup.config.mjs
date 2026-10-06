import { createPluginRollupConfig } from "@iracedeck/plugin-build";

export default createPluginRollupConfig({
  configUrl: import.meta.url,
  sdPluginDir: "com.ulanzi.iracedeck.ulanziPlugin",
  platform: "ulanzi",
  extraExternals: ["ws"],
  assetCopy: { actionIcons: ["icon.svg", "key.svg"], elgatoPluginImgs: true },
  piBridge: "ulanzi-pi-bridge.js",
});
