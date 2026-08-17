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

const KNOWN_BRIDGES = ["pi-settings-bridge.js", "ulanzi-pi-bridge.js", "settings-window-bridge.js"];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build-time guard (#993 phase 2): every generated PI page carries EXACTLY the
 * one bridge it is meant to, immediately before sdpi-components.js, and no
 * other bridge — two bridges on one page double-patch WebSocket. Runs in
 * closeBundle (after every writeBundle-stage injector has finished).
 *
 * @param {{ outputDir: string, expectedBridge: (fileName: string) => string }} options
 */
export function assertBridgeInjectionPlugin({ outputDir, expectedBridge }) {
  const sdpiTag = '<script src="sdpi-components.js"></script>';

  return {
    name: "assert-bridge-injection",
    closeBundle() {
      // No output directory means no PI page was generated at all — that is a
      // wiring failure this guard exists to catch, reported on its own terms
      // rather than as readdirSync's ENOENT.
      if (!existsSync(outputDir)) {
        throw new Error(`PI bridge injection check failed: output directory ${outputDir} does not exist (no PI pages generated?)`);
      }

      const problems = [];

      for (const file of readdirSync(outputDir).filter((f) => f.endsWith(".html"))) {
        const content = readFileSync(path.join(outputDir, file), "utf-8");

        if (!content.includes(sdpiTag)) continue;

        const bridge = expectedBridge(file);
        const bridgeTag = `<script src="${bridge}"></script>`;
        const count = content.split(bridgeTag).length - 1;
        // Ordered = the bridge tag directly precedes the sdpi tag with nothing
        // but whitespace between them, however the page happens to be indented.
        const ordered = new RegExp(`${escapeRegExp(bridgeTag)}\\s*${escapeRegExp(sdpiTag)}`).test(content);
        const others = KNOWN_BRIDGES.filter((b) => b !== bridge && content.includes(`<script src="${b}"></script>`));

        if (count !== 1 || !ordered || others.length > 0) {
          problems.push(
            `${file}: expected ${bridge} exactly once before sdpi-components.js (found ${count}${ordered ? "" : ", wrong order"}${others.length ? `, also ${others.join("+")}` : ""})`,
          );
        }
      }

      if (problems.length > 0) throw new Error(`PI bridge injection check failed:\n${problems.join("\n")}`);
    },
  };
}
