/**
 * Phase 3 (#1349): the native input layer — keyboard, clipboard — and the PNG
 * rasterizer for device-bound icons.
 */
import { initializeClipboard, initializeKeyboard, initializeRasterizer } from "@iracedeck/deck-core";
import { IRacingNative } from "@iracedeck/iracing-native";
import { createSvgRasterizer } from "@iracedeck/rasterizer";
import { join } from "node:path";

import type { Core, Input } from "../types.js";

export function initInput(core: Core): Input {
  // Initialize keyboard for hotkey actions with scan code support for non-US layouts
  const native = new IRacingNative();
  initializeKeyboard(
    core.adapter.createLogger("Keyboard"),
    (scanCodes) => native.sendScanKeys(scanCodes),
    (scanCodes) => native.sendScanKeyDown(scanCodes),
    (scanCodes) => native.sendScanKeyUp(scanCodes),
    (chords, holdMs) => native.sendScanKeySequence(chords, holdMs),
  );

  // Initialize clipboard for paste-based action flows (e.g. race-admin "Type in Chat").
  // Pasting itself uses the keyboard service above (Ctrl+V).
  initializeClipboard(core.adapter.createLogger("Clipboard"), (text) => native.setClipboardText(text));

  // Rasterize device-bound SVG icons to PNG in-plugin (#642). When the flag is
  // off, the service stays uninitialized and adapters pass SVG through as before.
  if (__FEATURE_PNG_RASTERIZATION__) {
    const rasterizerLogger = core.adapter.createLogger("Rasterizer");

    try {
      initializeRasterizer(
        createSvgRasterizer({ fontsDir: join(core.binDir, "..", "assets", "fonts") }),
        rasterizerLogger,
      );
    } catch (err) {
      // Fonts missing or resvg init failed — stay uninitialized so adapters
      // fall back to sending SVG, instead of crashing the whole plugin.
      rasterizerLogger.warn(`PNG rasterization disabled: ${err}`);
    }
  }

  return { native };
}
