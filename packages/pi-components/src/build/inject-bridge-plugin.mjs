import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Rollup plugin that injects a bridge `<script>` immediately before
 * `sdpi-components.js` in generated PI HTML files.
 *
 * sdpi-components connects synchronously on load, so any shim that must
 * monkeypatch `window.WebSocket` first (the Ulanzi PI bridge, the settings-window
 * bridge, #992) has to be in the DOM before it. Post-generation injection keeps
 * the shared partials untouched.
 *
 * `include(fileName)` decides which HTML files get THIS bridge. That matters
 * because two bridges must never share a page: on Ulanzi the PI bridge goes into
 * every action PI but NOT settings-window.html, which gets the settings-window
 * bridge instead — otherwise the PI bridge would hijack the window's socket
 * toward UlanziStudio.
 *
 * @param {{ outputDir: string, bridge: string, include: (fileName: string) => boolean }} opts
 */
export function injectBridgeScriptPlugin({ outputDir, bridge, include }) {
  const bridgeTag = `<script src="${bridge}"></script>`;
  const sdpiTag = '<script src="sdpi-components.js"></script>';

  return {
    name: `inject-bridge:${bridge}`,
    writeBundle() {
      if (!existsSync(outputDir)) return;

      for (const file of readdirSync(outputDir).filter((f) => f.endsWith(".html") && include(f))) {
        const filePath = path.join(outputDir, file);
        const content = readFileSync(filePath, "utf-8");

        if (content.includes(bridge) || !content.includes(sdpiTag)) continue;

        writeFileSync(filePath, content.replace(sdpiTag, `${bridgeTag}\n    ${sdpiTag}`), "utf-8");
      }
    },
  };
}
