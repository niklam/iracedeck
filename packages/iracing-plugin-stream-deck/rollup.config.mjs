import { createPluginRollupConfig } from "@iracedeck/plugin-build";

export default createPluginRollupConfig({
  configUrl: import.meta.url,
  sdPluginDir: "com.iracedeck.sd.core.sdPlugin",
  platform: "stream-deck",
  // dial.svg (optional) is the manifest `Encoder.Icon` default for dual-surface actions (#775).
  assetCopy: { actionIcons: ["icon.svg", "key.svg", "dial.svg"] },
});
