import type { IRacingHotkeyPreset } from "./keyboard-types.js";

/**
 * iRacing default keyboard shortcuts
 * Reference: https://www.iracing.com/keyboard-shortcuts/
 */
export const IRACING_HOTKEY_PRESETS: IRacingHotkeyPreset[] = [
  // Black Box
  {
    id: "blackbox-timing",
    name: "Lap Timing",
    description: "Open the lap timing black box",
    defaultKey: { key: "f1" },
    category: "blackbox",
  },
  {
    id: "blackbox-standings",
    name: "Standings",
    description: "Open the standings black box",
    defaultKey: { key: "f2" },
    category: "blackbox",
  },
  {
    id: "blackbox-relative",
    name: "Relative",
    description: "Open the relative timing black box",
    defaultKey: { key: "f3" },
    category: "blackbox",
  },
  {
    id: "blackbox-fuel",
    name: "Fuel",
    description: "Open the fuel black box",
    defaultKey: { key: "f4" },
    category: "blackbox",
  },
  {
    id: "blackbox-tires",
    name: "Tire Pressure",
    description: "Open the tire pressure black box",
    defaultKey: { key: "f5" },
    category: "blackbox",
  },
  {
    id: "blackbox-tire-info",
    name: "Tire Info",
    description: "Open the tire info black box",
    defaultKey: { key: "f6" },
    category: "blackbox",
  },
  {
    id: "blackbox-pit-adjustments",
    name: "Pit Adjustments",
    description: "Open the pit adjustments black box",
    defaultKey: { key: "f7" },
    category: "blackbox",
  },
  {
    id: "blackbox-car-adjustments",
    name: "Car Adjustments",
    description: "Open the car adjustments black box",
    defaultKey: { key: "f8" },
    category: "blackbox",
  },

  // Controls
  {
    id: "control-starter",
    name: "Starter",
    description: "Engage the starter motor",
    defaultKey: { key: "s" },
    category: "controls",
  },
  {
    id: "control-ignition",
    name: "Ignition",
    description: "Toggle ignition on/off",
    defaultKey: { key: "i" },
    category: "controls",
  },
  {
    id: "control-pit-limiter",
    name: "Pit Limiter",
    description: "Toggle pit road speed limiter",
    defaultKey: { key: "a" },
    category: "controls",
  },
  {
    id: "control-tow",
    name: "Tow/Reset",
    description: "Request a tow to the pits",
    defaultKey: { key: "r", modifiers: ["shift"] },
    category: "controls",
  },
  {
    id: "control-bias-increase",
    name: "Brake Bias +",
    description: "Increase brake bias towards front",
    defaultKey: { key: "=" },
    category: "controls",
  },
  {
    id: "control-bias-decrease",
    name: "Brake Bias -",
    description: "Decrease brake bias towards rear",
    defaultKey: { key: "-" },
    category: "controls",
  },

  // Camera
  {
    id: "camera-look-left",
    name: "Look Left",
    description: "Look left",
    defaultKey: { key: "z" },
    category: "camera",
  },
  {
    id: "camera-look-right",
    name: "Look Right",
    description: "Look right",
    defaultKey: { key: "x" },
    category: "camera",
  },

  // Misc
  {
    id: "misc-chat",
    name: "Text Chat",
    description: "Open text chat",
    defaultKey: { key: "t" },
    category: "misc",
  },
  {
    id: "misc-delta",
    name: "Splits/Delta",
    description: "Toggle delta/splits display",
    defaultKey: { key: "tab" },
    category: "misc",
  },
];

/**
 * Get a hotkey preset by its ID
 */
export function getHotkeyPreset(id: string): IRacingHotkeyPreset | undefined {
  return IRACING_HOTKEY_PRESETS.find((preset) => preset.id === id);
}

/**
 * Get all hotkey presets in a specific category
 */
export function getHotkeysByCategory(category: IRacingHotkeyPreset["category"]): IRacingHotkeyPreset[] {
  return IRACING_HOTKEY_PRESETS.filter((preset) => preset.category === category);
}
