import path from "node:path";
import url from "node:url";

import { assertBridgeInjectionPlugin, injectBridgeScriptPlugin } from "./inject-bridge-plugin.mjs";
import { piTemplatePlugin } from "./pi-template-plugin.mjs";

const packageRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "../..");

export const partialsDir = path.join(packageRoot, "partials");
export const browserDir = path.join(packageRoot, "browser");

/** The dedicated settings window's compiled page + its bridge (#992). */
export const SETTINGS_WINDOW_HTML = "settings-window.html";
export const SETTINGS_WINDOW_BRIDGE = "settings-window-bridge.js";
/** The iRaceDeck wordmark the settings window shows in its header (committed in browser/). */
export const SETTINGS_WINDOW_LOGO = "iracedeck-logo.png";
/** The Elgato/Mirabox PI settings bridge, injected into every action PI (#993 phase 2). */
export const PI_SETTINGS_BRIDGE = "pi-settings-bridge.js";

export { assertBridgeInjectionPlugin, injectBridgeScriptPlugin, piTemplatePlugin };
