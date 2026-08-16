import path from "node:path";
import url from "node:url";

import { injectBridgeScriptPlugin } from "./inject-bridge-plugin.mjs";
import { piTemplatePlugin } from "./pi-template-plugin.mjs";

const packageRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

export const partialsDir = path.join(packageRoot, "partials");
export const browserDir = path.join(packageRoot, "browser");

/** The dedicated settings window's compiled page + its bridge (#992). */
export const SETTINGS_WINDOW_HTML = "settings-window.html";
export const SETTINGS_WINDOW_BRIDGE = "settings-window-bridge.js";

export { injectBridgeScriptPlugin, piTemplatePlugin };
