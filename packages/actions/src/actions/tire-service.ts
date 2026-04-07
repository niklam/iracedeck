import {
  assembleIcon,
  CommonSettings,
  ConnectionStateAwareAction,
  generateBorderParts,
  getCommands,
  getGlobalBorderSettings,
  getGlobalColors,
  getGlobalTitleSettings,
  getSDK,
  type IDeckDialDownEvent,
  type IDeckDidReceiveSettingsEvent,
  type IDeckKeyDownEvent,
  type IDeckWillAppearEvent,
  type IDeckWillDisappearEvent,
  renderIconTemplate,
  resolveBorderSettings,
  resolveIconColors,
  resolveTitleSettings,
  svgToDataUri,
} from "@iracedeck/deck-core";
import changeAllTiresIconSvg from "@iracedeck/icons/tire-service/change-all-tires.svg";
import clearTiresIconSvg from "@iracedeck/icons/tire-service/clear-tires.svg";
import { hasFlag, PitSvFlags, PitSvStatus, TelemetryData } from "@iracedeck/iracing-sdk";
import z from "zod";

import tireServiceTemplate from "../../icons/tire-service.svg";

const GRAY = "#888888";
const WHITE = "#ffffff";
const GREEN = "#2ecc71";
const YELLOW = "#f1c40f";
const RED = "#e74c3c";
const BLUE = "#3498db";

/** Compound artwork colors matching the provided tire SVGs */
const DRY_COMPOUND_COLOR = "#ffd318";
const WET_COMPOUND_COLOR = "#078cd1";

/** F1-style compound color mapping */
const COMPOUND_COLORS: Record<string, string> = {
  hard: WHITE,
  medium: YELLOW,
  soft: RED,
  intermediate: GREEN,
  wet: BLUE,
};

/**
 * Detailed DRY tire artwork (inline fills, no <style>).
 * Original viewBox 0 0 144 144, rendered inside a scaling group.
 */
const DRY_TIRE_PATHS = `
  <path fill="#333" d="M72,0C32.24,0,0,32.24,0,72s32.24,72,72,72,72-32.24,72-72S111.76,0,72,0ZM72,41.27c16.97,0,30.73,13.76,30.73,30.73h0c0,16.97-13.76,30.73-30.73,30.73h0c-16.97,0-30.73-13.76-30.73-30.73h0c0-16.97,13.76-30.73,30.73-30.73h0Z"/>
  <path fill="#a8a8a8" d="M72,32c-22.09,0-40,17.91-40,40s17.91,40,40,40,40-17.91,40-40-17.91-40-40-40ZM72,41.27c16.97,0,30.73,13.76,30.73,30.73h0c0,16.97-13.76,30.73-30.73,30.73h0c-16.97,0-30.73-13.76-30.73-30.73h0c0-16.97,13.76-30.73,30.73-30.73h0Z"/>
  <path fill="#ffd318" d="M72,38.67c-18.41,0-33.33,14.92-33.33,33.33s14.92,33.33,33.33,33.33,33.33-14.92,33.33-33.33-14.92-33.33-33.33-33.33ZM69.6,43.45v16.81c-.88.18-1.74.46-2.56.83l-9.87-13.59c3.78-2.29,8.03-3.68,12.43-4.05h0ZM74.4,43.45c4.4.38,8.65,1.76,12.43,4.05l-9.87,13.58c-.82-.38-1.68-.66-2.56-.84v-16.79h0ZM90.72,50.31c3.34,2.89,5.97,6.51,7.68,10.59l-15.97,5.19c-.44-.78-.97-1.52-1.58-2.18l9.88-13.6h0ZM53.29,50.33l9.87,13.58c-.61.66-1.14,1.39-1.59,2.18l-15.99-5.2c1.72-4.07,4.36-7.68,7.71-10.56h0ZM72,64c4.42,0,8,3.58,8,8s-3.58,8-8,8h0c-4.42,0-8-3.58-8-8h0c0-4.42,3.58-8,8-8ZM44.12,65.46l15.96,5.19c-.05.45-.08.9-.08,1.35,0,.45.04.9.09,1.35l-15.97,5.19c-.51-2.14-.78-4.33-.79-6.53.01-2.2.27-4.39.79-6.54h0ZM99.88,65.47c.51,2.14.78,4.33.79,6.53-.01,2.2-.27,4.39-.79,6.54l-15.96-5.19c.05-.45.08-.9.08-1.35,0-.45-.04-.9-.09-1.35l15.97-5.19h0ZM61.58,77.91c.44.78.97,1.51,1.58,2.18l-9.88,13.6c-3.34-2.89-5.97-6.51-7.67-10.59l15.97-5.19h0ZM82.43,77.91l15.99,5.2c-1.72,4.07-4.36,7.68-7.71,10.56l-9.87-13.58c.61-.66,1.14-1.39,1.59-2.18h0ZM76.96,82.91l9.87,13.59c-3.78,2.29-8.03,3.68-12.43,4.05v-16.81c.88-.18,1.74-.46,2.56-.83h0ZM67.04,82.91c.82.38,1.68.66,2.56.84v16.79c-4.4-.38-8.65-1.76-12.43-4.05l9.87-13.58h0Z"/>
  <path fill="#ffd318" fill-rule="evenodd" d="M78.91,132.59v.08s-.03.06-.05.08v-.06s.05-.07.05-.1ZM69.17,129.09s0,.01,0,.02c0,0,0,0,0,0h0ZM66.13,123.02c-.19-.01-.39.02-.57.1-.2.08-.38.21-.5.4l-.04.06-.49,1.36v.1c-.02.19.06.39.16.52.1.13.21.19.3.24h.02c.15.08.32.12.49.12l4.77.21-.29.78-5.23-.22h.07c-.42-.06-.85.13-1.1.48l-.05.07-.5,1.36v.1c-.02.31.23.63.4.73h.01s.01.01.01.01c.16.09.34.14.53.15l4.78.21-.65,1.76-5.23-.23h-.01c-.16,0-.32.04-.47.09-.25.07-.47.24-.59.48v.03s-.49,1.31-.49,1.31v.1c-.02.25.14.57.35.72s.42.17.6.17l7.3.32h.03c.25,0,.48-.11.67-.27.15-.12.28-.27.37-.45v-.03s3.46-9.35,3.46-9.35v-.11c.01-.22-.05-.43-.17-.61-.15-.24-.42-.39-.7-.4l-7.26-.32ZM105.61,121.33l.02.04s0,.02,0,.02c0,0-.03-.06-.03-.06,0,0,0,0,0,0h0ZM87.18,121.19l-7.82,1.69c-.19.04-.36.12-.52.23-.18.13-.32.31-.39.52l-.02.07-.13,1.45.02.1c.08.37.43.56.65.6.16.03.33.04.49,0l3.8-.82-5.49,6.94h0c-.05.09-.08.18-.11.26l-.11.12-.14,1.6.02.1c.05.24.3.53.53.61s.42.06.59.02h0s7.82-1.69,7.82-1.69c.18-.04.35-.12.49-.22.22-.14.38-.36.43-.61v-.03s.14-1.39.14-1.39l-.02-.1c-.08-.35-.41-.55-.6-.6h-.01s-.01,0-.01,0c-.17-.04-.36-.04-.53,0l-3.89.83,5.61-7.26c.14-.18.23-.39.26-.61v-.02s.09-1.06.09-1.06l-.02-.1c-.05-.24-.3-.52-.54-.6-.24-.08-.42-.05-.58-.02h0ZM52.46,120.42h0s0,.09,0,.14h0s0-.09,0-.14h0ZM52.08,119.56l-.16.02c-.26.04-.49.19-.63.41l-.03.04-.11.23v.1s-.01.07-.01.1v.07s.14,2.18.14,2.18c-.14,0-.28-.02-.42,0-.44.05-.88.14-1.31.27-.42.13-.83.32-1.21.55-.38.22-.71.52-.96.88h0s-1.42,2.01-1.42,2.01l-.11.28v.02c-.12.34-.15.7-.1,1.06.04.35.15.69.33.99h0c.18.31.41.58.69.81.29.24.62.42.98.53h0s6.08,1.9,6.08,1.9h.03c.24.06.49.02.71-.09.18-.08.35-.19.47-.35l.02-.02,5.66-8.06-.3.24c.21-.08.27-.19.31-.25s.06-.1.07-.13c.03-.06.04-.1.05-.15h0c.05-.16.09-.38-.02-.62-.1-.24-.34-.4-.52-.46l-1.34-.42h0c-.25-.07-.51-.04-.74.09-.16.08-.31.2-.42.35h0s-4.62,6.59-4.62,6.59l-3.47-1.08h0c-.09-.03-.17-.07-.24-.13-.05-.04-.09-.1-.13-.16-.02-.04-.03-.09-.04-.13h0s0-.02,0-.02c0-.03,0-.06,0-.09h0s.84-1.21.84-1.21c.05-.06.11-.11.17-.15h0s0,0,0,0c.13-.07.27-.12.42-.16h0s0,0,0,0c.16-.04.33-.06.49-.06h0c.14,0,.28.02.42.06l2.03.63h.25-.11c.3.04.6-.09.77-.33l-.07.08.25-.26.11-.33v-.13s-.33-4.31-.33-4.31v.06c0-.19-.07-.44-.21-.6-.14-.16-.32-.25-.47-.29l-1.83-.58ZM37.89,115.06h0c.15,0,.3.04.45.09h0s0,0,0,0c.14.05.28.11.4.19,0,0,0,0,0,0l3.13,2.1h.02c.16.11.29.25.37.42,0,.01,0,.03,0,.04l-.02.03-.02.03s0,0,0,0l-.03.02-.03.03-3.71,2.92h0s-.06.05-.1.05h-.02s-.02,0-.02,0c-.15.03-.31.04-.46.03h0c-.18,0-.35-.03-.53-.08h0s0,0,0,0c-.13-.03-.26-.09-.37-.16l-3.12-2.09h0c-.14-.09-.25-.23-.31-.39v-.02s-.01-.02-.01-.02c-.02-.04-.01-.09.01-.12h0s.04-.05.04-.05l3.63-2.88c.08-.06.17-.1.27-.11h0s0,0,0,0c.14-.03.28-.04.42-.03h0ZM37.84,112.17c-.42,0-.84.02-1.25.09-.4.06-.79.18-1.16.34l-.08.03-4.82,3.84-.06.09c-.2.3-.33.63-.4.98h0s0,0,0,0c-.07.35-.06.71,0,1.06.06.36.19.71.38,1.03,0,0,0,0,0,0,.2.35.49.64.82.86,0,0,0,0,0,0l4.17,2.79h0c.37.24.77.42,1.2.53.42.11.84.16,1.27.17h0c.42,0,.83-.03,1.24-.11.39-.07.77-.19,1.13-.36l.07-.03,4.79-3.81.08-.13c.18-.26.32-.55.43-.85h0c.12-.34.16-.69.13-1.05h0s0-.02,0-.02c-.04-.38-.18-.74-.39-1.06h0s0,0,0,0c-.25-.37-.58-.68-.96-.92h.02s-4.21-2.81-4.21-2.81h0c-.35-.23-.74-.4-1.15-.49-.41-.1-.83-.15-1.25-.16h0ZM108.88,109.6l.04.11s-.03-.05-.04-.11ZM109.47,108.58c-.26-.05-.53.06-.67.17h0s-1.11.89-1.11.89h-.01c-.19.18-.3.41-.33.66-.03.19,0,.38.06.56h0s2.86,7.51,2.86,7.51l-2.85,2.28h-.01c-.13.13-.29.19-.46.2h0s-.08-.02-.11-.05h0s-.04-.09-.04-.09l-.54-1.39c-.02-.06-.03-.13-.02-.19h0s0-.02,0-.02c0-.14.03-.27.08-.4h0c.05-.16.13-.32.22-.47h0s0,0,0,0c.08-.13.18-.25.3-.35h0s1.47-1.18,1.47-1.18h.01c.11-.11.21-.23.28-.36.16-.23.22-.51.14-.78v-.03s-.49-1.31-.49-1.31l-.06-.08c-.16-.21-.54-.35-.79-.3-.25.04-.39.15-.53.26,0,0,0,0,0,0l-1.97,1.58h0c-.34.29-.62.64-.84,1.03-.24.41-.43.84-.57,1.3-.14.45-.23.92-.26,1.39-.04.47.03.94.2,1.38l.87,2.29.17.25v.02c.24.28.52.51.84.67.31.16.65.25,1,.28.35.03.71-.01,1.05-.12.37-.11.71-.29,1.01-.54l4.97-3.97.02-.02c.18-.17.28-.4.32-.64.04-.19.05-.39,0-.58v-.04s-3.5-9.16-3.5-9.16c-.03-.1-.07-.16-.09-.2-.04-.06-.07-.1-.1-.13-.1-.12-.26-.27-.51-.33h0ZM37.1,23.29c-15.72,11.25-25.07,29.38-25.1,48.71.02,11.95,3.61,23.63,10.31,33.53l4.53-2.82c-6.17-9.05-9.48-19.75-9.5-30.71.03-17.49,8.43-33.92,22.59-44.18l-2.83-4.53ZM106.9,23.26l-2.83,4.54c14.18,10.27,22.58,26.7,22.6,44.21-.01,10.74-3.19,21.23-9.12,30.18l4.22,3.3c6.66-9.89,10.22-21.55,10.23-33.47-.02-19.34-9.37-37.49-25.1-48.74h0Z"/>
  <path fill="#ffd318" d="M51.27,13.9h8.23c.66.07,1.25.29,1.77.67.52.38.97.86,1.34,1.44.37.58.66,1.24.87,1.97.21.73.34,1.48.38,2.24.04.76,0,1.51-.14,2.25-.14.74-.37,1.41-.71,2.02-.34.6-.77,1.11-1.31,1.51-.53.4-1.18.65-1.93.75h-8.49v-12.86ZM55.4,22.34c.92.04,1.65.04,2.18,0s.94-.14,1.2-.31c.27-.16.44-.41.51-.73.08-.32.13-.74.15-1.26.01-.55-.09-.97-.3-1.25-.21-.29-.51-.49-.89-.62-.38-.12-.83-.19-1.33-.2-.5,0-1.02-.01-1.55-.01l.02,4.38ZM84.88,26.7v-5.04l-4.53-7.73h4.03l2.53,4.3,2.53-4.3h4.03l-4.53,7.73v5.04h-4.07Z"/>
  <path fill="#ffd318" d="M77.49,21.86c.51-.42.89-.92,1.15-1.48.29-.64.42-1.33.38-2.07-.04-.73-.23-1.41-.57-2.04-.33-.63-.81-1.17-1.43-1.62-.61-.44-1.36-.71-2.24-.79h-8.23v12.86h4.12l.06-3.75h2.94l.97,3.75h4.11l-1.25-4.86h-.01ZM70.67,20.67v-4.24c.53,0,1.05.01,1.55.01.5.01.94.08,1.33.2.38.12.68.33.89.62.21.28.31.7.3,1.25-.03.52-.08.93-.15,1.23-.08.31-.25.53-.53.68-.27.15-.68.24-1.21.27-.54.03-1.26.02-2.18-.02Z"/>`;

/**
 * Detailed WET tire artwork (inline fills, no <style>).
 * Original viewBox 0 0 144 144, rendered inside a scaling group.
 */
const WET_TIRE_PATHS = `
  <path fill="#333" d="M72,0C32.24,0,0,32.24,0,72s32.24,72,72,72,72-32.24,72-72S111.76,0,72,0ZM72,41.27c16.97,0,30.73,13.76,30.73,30.73h0c0,16.97-13.76,30.73-30.73,30.73h0c-16.97,0-30.73-13.76-30.73-30.73h0c0-16.97,13.76-30.73,30.73-30.73h0Z"/>
  <path fill="#a8a8a8" d="M72,32c-22.09,0-40,17.91-40,40s17.91,40,40,40,40-17.91,40-40-17.91-40-40-40ZM72,41.27c16.97,0,30.73,13.76,30.73,30.73h0c0,16.97-13.76,30.73-30.73,30.73h0c-16.97,0-30.73-13.76-30.73-30.73h0c0-16.97,13.76-30.73,30.73-30.73h0Z"/>
  <path fill="#078cd1" d="M72,38.67c-18.41,0-33.33,14.92-33.33,33.33s14.92,33.33,33.33,33.33,33.33-14.92,33.33-33.33-14.92-33.33-33.33-33.33ZM69.6,43.45v16.81c-.88.18-1.74.46-2.56.83l-9.87-13.59c3.78-2.29,8.03-3.68,12.43-4.05h0ZM74.4,43.45c4.4.38,8.65,1.76,12.43,4.05l-9.87,13.58c-.82-.38-1.68-.66-2.56-.84v-16.79h0ZM90.72,50.31c3.34,2.89,5.97,6.51,7.68,10.59l-15.97,5.19c-.44-.78-.97-1.52-1.58-2.18l9.88-13.6h0ZM53.29,50.33l9.87,13.58c-.61.66-1.14,1.39-1.59,2.18l-15.99-5.2c1.72-4.07,4.36-7.68,7.71-10.56h0ZM72,64c4.42,0,8,3.58,8,8s-3.58,8-8,8h0c-4.42,0-8-3.58-8-8h0c0-4.42,3.58-8,8-8ZM44.12,65.46l15.96,5.19c-.05.45-.08.9-.08,1.35,0,.45.04.9.09,1.35l-15.97,5.19c-.51-2.14-.78-4.33-.79-6.53.01-2.2.27-4.39.79-6.54h0ZM99.88,65.47c.51,2.14.78,4.33.79,6.53-.01,2.2-.27,4.39-.79,6.54l-15.96-5.19c.05-.45.08-.9.08-1.35,0-.45-.04-.9-.09-1.35l15.97-5.19h0ZM61.58,77.91c.44.78.97,1.51,1.58,2.18l-9.88,13.6c-3.34-2.89-5.97-6.51-7.67-10.59l15.97-5.19h0ZM82.43,77.91l15.99,5.2c-1.72,4.07-4.36,7.68-7.71,10.56l-9.87-13.58c.61-.66,1.14-1.39,1.59-2.18h0ZM76.96,82.91l9.87,13.59c-3.78,2.29-8.03,3.68-12.43,4.05v-16.81c.88-.18,1.74-.46,2.56-.83h0ZM67.04,82.91c.82.38,1.68.66,2.56.84v16.79c-4.4-.38-8.65-1.76-12.43-4.05l9.87-13.58h0Z"/>
  <path fill="#078cd1" d="M103.88,114.19l4.69-3.81c1.41-1.02,2.88-.37,4.41,1.94,1.53,2.31,1.6,4.09.21,5.35l-4.57,3.7-1.17-1.75,4.03-3.28c.27-.2.43-.52.4-.86-.32-1.04-.88-1.99-1.62-2.78-.23-.23-.6-.28-.88-.12l-4.28,3.47-1.22-1.87ZM106.47,122.59l-2.13,1.32-3.79-7.73,2.17-1.35,3.75,7.76ZM99.45,117.03l2.8,8.19-5.29,2.42c-1.51.73-2.61.23-3.3-1.5l-1.91-5.58,2.07-.95,1.72,5.13c.14.55.43.7.89.45l2.88-1.33-2.01-5.87,2.15-.96ZM84.63,131.43l-.35-2.4,4.27-1.07-.42-2.9c-.12-.5-.44-.71-.97-.63l-5.05,1.26-.37-2.4,5.72-1.42c1.83-.36,2.89.48,3.17,2.52l.43,2.96.68-.18.35,2.4-7.44,1.86ZM71.9,132.62l.35-8.59,5.77-.34c1.66-.14,2.5.72,2.52,2.57l-.23,5.87-2.26.13.27-5.37c.07-.56-.15-.8-.66-.73l-3.14.19-.25,6.13-2.36.14ZM67.28,128.59l-3.13-.39c-.41-.09-.81.16-.91.57,0,0,0,.01,0,.02-.12.44.06.73.55.87l3.15.39.33-1.46ZM69.05,132.47l-5.9-.73c-1.74-.52-2.47-1.58-2.18-3.2.12-1.12.78-2.12,1.77-2.67l-.84-2.93,2.83.35.82,2.82,2.25.28.59-2.62,2.55.31-1.91,8.38ZM56.52,127.33l.37-.84-3.63-1.14-.29.66c-.31.59-.24,1,.22,1.23l2.2.68c.59.17.97-.03,1.13-.59h0ZM61.02,122.82l-2.3,5.39c-.78,1.6-2.06,2.16-3.85,1.67l-2.77-.87c-1.57-.61-2.05-1.71-1.45-3.31l2.31-5.42,2.17.68-1.03,2.4,3.63,1.15,1.03-2.42,2.25.72ZM40.42,123.57l1.35-2.03,3.87,2.06,1.62-2.42c.24-.35.15-.83-.2-1.06-.03-.02-.06-.04-.1-.06l-4.58-2.46,1.33-2.02,5.21,2.77c1.6.96,1.82,2.29.67,4l-1.66,2.48.63.32-1.37,2.02-6.76-3.59ZM38.9,115.63c.16-.33.1-.73-.15-1l-1.85-1.48c-.29-.21-.67-.25-1-.11-.3.06-.75.4-1.35,1.04-.61.63-.91,1.11-.91,1.42,0,.34.15.67.42.89l1.42,1.14c.39.3.92.34,1.35.1.25-.08.65-.39,1.19-.93.54-.55.84-.91.87-1.09h0ZM37.69,110.83l3.16,2.54c1.41,1.12,1.09,2.72-.97,4.8-2.06,2.12-3.84,2.58-5.33,1.4l-2.59-2.09c-1.58-1.22-1.35-2.85.69-4.89,1.97-2.24,3.65-2.83,5.04-1.75h0Z"/>
  <path fill="#078cd1" d="M106.9,23.26l-2.83,4.54c14.18,10.27,22.58,26.7,22.6,44.21-.01,10.74-3.19,21.23-9.12,30.18l4.22,3.3c6.66-9.89,10.22-21.55,10.23-33.47-.02-19.34-9.37-37.49-25.1-48.74h0Z"/>
  <path fill="#078cd1" d="M37.1,23.29c-15.72,11.25-25.07,29.38-25.1,48.71.02,11.95,3.61,23.63,10.31,33.53l4.53-2.82c-6.17-9.05-9.48-19.75-9.5-30.71.03-17.49,8.43-33.92,22.59-44.18l-2.83-4.53Z"/>
  <polygon fill="#078cd1" points="95.86 13.86 95.86 16.37 91.19 16.37 91.17 26.76 87.06 26.76 87.08 16.37 82.45 16.37 82.45 13.86 95.86 13.86"/>
  <polygon fill="#078cd1" points="66.34 13.94 63.28 26.76 59.14 26.76 57.54 22.05 55.94 26.76 51.8 26.76 48.74 13.94 52.81 13.94 54.21 19.83 55.5 16.04 59.58 16.04 60.87 19.83 62.27 13.94 66.34 13.94"/>
  <polygon fill="#078cd1" points="72.31 16.41 72.31 18.9 76.73 18.9 76.73 21.41 72.31 21.41 72.31 24.25 80.54 24.25 80.54 26.76 68.19 26.76 68.19 13.9 80.54 13.9 80.54 16.41 72.31 16.41"/>`;

const DEFAULT_TIRES: DriverTire[] = [{ TireIndex: 0, TireCompoundType: "Dry" }];

type DriverTire = { TireIndex: number; TireCompoundType: string };

const TireCode = z.enum(["lf", "rf", "lr", "rr"]);

const TireServiceSettings = CommonSettings.extend({
  action: z.enum(["change-all-tires", "clear-tires", "toggle-tires", "change-compound"]).default("change-all-tires"),
  tires: z.array(TireCode).default(["lf", "rf", "lr", "rr"]),
  // Legacy boolean fields — kept for backward-compatible migration only
  lf: z.coerce.boolean().optional(),
  rf: z.coerce.boolean().optional(),
  lr: z.coerce.boolean().optional(),
  rr: z.coerce.boolean().optional(),
});

type TireServiceSettings = z.infer<typeof TireServiceSettings>;

/**
 * @internal Exported for testing
 *
 * Migrates legacy boolean tire settings (lf/rf/lr/rr) to the new tires array.
 * Only runs when tires key is absent from the raw settings and legacy booleans are present.
 */
export function migrateTireSettings(raw: unknown): TireServiceSettings {
  const parsed = TireServiceSettings.safeParse(raw);
  const data = parsed.success ? parsed.data : TireServiceSettings.parse({});

  const rawRecord = raw as Record<string, unknown> | undefined;

  if (!rawRecord || rawRecord.tires !== undefined) {
    return data;
  }

  const hasLegacy =
    rawRecord.lf !== undefined ||
    rawRecord.rf !== undefined ||
    rawRecord.lr !== undefined ||
    rawRecord.rr !== undefined;

  if (hasLegacy) {
    const migrated: Array<"lf" | "rf" | "lr" | "rr"> = [];

    if (data.lf !== false) migrated.push("lf");

    if (data.rf !== false) migrated.push("rf");

    if (data.lr !== false) migrated.push("lr");

    if (data.rr !== false) migrated.push("rr");

    return { ...data, tires: migrated };
  }

  return data;
}

/**
 * @internal Exported for testing
 *
 * Returns whether a tire position is selected in the tires array.
 */
export function isTireSelected(settings: TireServiceSettings, tire: "lf" | "rf" | "lr" | "rr"): boolean {
  return settings.tires.includes(tire);
}

/**
 * @internal Exported for testing
 *
 * Get available tire compounds from session info.
 * Returns the DriverTires array from the first driver, or a single "Hard" fallback.
 */
export function getDriverTires(): DriverTire[] {
  try {
    const sessionInfo = getSDK().sdk.getSessionInfo();
    const driverInfo = sessionInfo?.DriverInfo as Record<string, unknown> | undefined;
    const tires = driverInfo?.DriverTires as DriverTire[] | undefined;

    return tires && tires.length > 0 ? tires : DEFAULT_TIRES;
  } catch {
    return DEFAULT_TIRES;
  }
}

/**
 * @internal Exported for testing
 *
 * Get F1-style color for a compound type. Case-insensitive. Falls back to gray.
 */
export function getCompoundColor(compoundType: string): string {
  return COMPOUND_COLORS[compoundType.toLowerCase()] ?? GRAY;
}

/**
 * @internal Exported for testing
 *
 * Get display name for a compound index.
 * - 1 compound: use its actual name, uppercased
 * - 2 compounds with one "Wet": the non-wet compound is "DRY", the wet is "WET"
 * - 3+ compounds: use the actual compound type name
 */
export function getCompoundName(compound: number): string {
  const tires = getDriverTires();
  const tire = tires.find((t) => t.TireIndex === compound);
  const typeName = tire?.TireCompoundType ?? "Dry";

  if (tires.length === 1) {
    return typeName.toUpperCase();
  }

  if (tires.length === 2 && tires.some((t) => t.TireCompoundType.toLowerCase() === "wet")) {
    return typeName.toLowerCase() === "wet" ? "WET" : "DRY";
  }

  return typeName;
}

/**
 * @internal Exported for testing
 *
 * Generate detailed tire artwork for a compound type.
 * Uses the DRY (yellow) or WET (blue) tire SVG, scaled to fill the canvas.
 */
export function generateTireIcon(compoundType: string): string {
  const isWet = compoundType.toLowerCase() === "wet";
  const paths = isWet ? WET_TIRE_PATHS : DRY_TIRE_PATHS;

  return `<g transform="translate(7, 7) scale(0.9)">${paths}</g>`;
}

/**
 * @internal Exported for testing
 *
 * Generate a status bar overlay for the compound change action.
 * Matches the full-width status bar used by toggle switches (x=0, y=100, 144×44).
 * - "STAY ON": compound color bar (yellow/blue)
 * - "CHANGE TO": compound color bar (yellow/blue); on pit road: text flashes on/off as warning
 * - "CHANGING": white bar with flashing text during pit service
 */
export function generateCompoundStatusBox(
  compoundType: string,
  isChanging: boolean,
  isServiceInProgress: boolean = false,
  isPitRoadWarning: boolean = false,
  flashVisible: boolean = true,
): string {
  // State 5: pit service in progress — white bar, "CHANGING" flashes
  if (isServiceInProgress) {
    const textEl = flashVisible
      ? `<text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="#1a1a1a" font-family="Arial" font-size="22" font-weight="700">CHANGING</text>`
      : "";

    return `
    <rect x="0" y="100" width="144" height="44" fill="${WHITE}"/>
    ${textEl}`;
  }

  const isWet = compoundType.toLowerCase() === "wet";
  const boxColor = isWet ? WET_COMPOUND_COLOR : DRY_COMPOUND_COLOR;
  const textColor = isWet ? "#ffffff" : "#1a1a1a";
  const label = isChanging ? "CHANGE TO" : "STAY ON";

  // State 3: on pit road with compound change queued — text flashes as warning
  if (isPitRoadWarning) {
    const textEl = flashVisible
      ? `<text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${textColor}" font-family="Arial" font-size="22" font-weight="700">${label}</text>`
      : "";

    return `
    <rect x="0" y="100" width="144" height="44" fill="${boxColor}"/>
    ${textEl}`;
  }

  return `
    <rect x="0" y="100" width="144" height="44" fill="${boxColor}"/>
    <text x="72" y="129" text-anchor="middle" dominant-baseline="central"
          fill="${textColor}" font-family="Arial" font-size="22" font-weight="700">${label}</text>`;
}

/**
 * Get tire fill color based on settings and current state.
 * Black: not configured (nothing happens on press).
 * Red: configured and currently OFF (will turn ON on press).
 * Green: configured and currently ON (will turn OFF on press).
 */
function getTireColor(isConfigured: boolean, isCurrentlyOn: boolean): string {
  if (!isConfigured) return "#000000ff";

  if (isCurrentlyOn) return "#44FF44";

  return "#FF4444";
}

/**
 * Get current tire change state from telemetry flags.
 */
function getTireState(telemetry: TelemetryData | null): {
  lf: boolean;
  rf: boolean;
  lr: boolean;
  rr: boolean;
} {
  if (!telemetry || telemetry.PitSvFlags === undefined) {
    return { lf: false, rf: false, lr: false, rr: false };
  }

  const flags = telemetry.PitSvFlags;

  return {
    lf: hasFlag(flags, PitSvFlags.LFTireChange),
    rf: hasFlag(flags, PitSvFlags.RFTireChange),
    lr: hasFlag(flags, PitSvFlags.LRTireChange),
    rr: hasFlag(flags, PitSvFlags.RRTireChange),
  };
}

/**
 * Get tire compound info from telemetry.
 * playerCompound: tires currently on the car.
 * pitSvCompound: compound selected for the next pit stop.
 * pitSvStatus: pit service status (None, InProgress, Complete).
 */
function getCompoundState(telemetry: TelemetryData | null): {
  player: number;
  pitSv: number;
  pitSvStatus: number;
  onPitRoad: boolean;
  inPitStall: boolean;
} {
  return {
    player: telemetry?.PlayerTireCompound ?? 0,
    pitSv: telemetry?.PitSvTireCompound ?? 0,
    pitSvStatus: telemetry?.PlayerCarPitSvStatus ?? PitSvStatus.None,
    onPitRoad: telemetry?.OnPitRoad ?? false,
    inPitStall: telemetry?.PlayerCarInPitStall ?? false,
  };
}

/**
 * @internal Exported for testing
 *
 * Builds a pit macro string to toggle the configured tires.
 * Returns null if no tires are configured.
 */
export function buildTireToggleMacro(settings: TireServiceSettings): string | null {
  const parts = settings.tires.map((t) => `!${t}`);

  return parts.length > 0 ? `#${parts.join(" ")}` : null;
}

/**
 * @internal Exported for testing
 *
 * Generates dynamic tire indicator SVG paths for the toggle-tires action.
 * Uses the same coordinate space as the car body with per-tire scaling for visibility.
 */
export function generateToggleTiresIconContent(
  settings: TireServiceSettings,
  currentState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
  bodyColor: string,
): string {
  const lfColor = getTireColor(isTireSelected(settings, "lf"), currentState.lf);
  const rfColor = getTireColor(isTireSelected(settings, "rf"), currentState.rf);
  const lrColor = getTireColor(isTireSelected(settings, "lr"), currentState.lr);
  const rrColor = getTireColor(isTireSelected(settings, "rr"), currentState.rr);

  return `
  <path d="M59.91,45.74l-8.02-3.5v1.06c0,.96.47,1.82,1.22,2.16l7.92,3.67.12-.87c.14-1.08-.38-2.14-1.24-2.52ZM61.79,38.44h-8.93c-.53,0-.97.43-.97.97v.38c0,.54.44.97.97.97h8.87c.48,0,.88-.34.95-.81l.06-.39c.11-.59-.35-1.12-.95-1.12ZM58.07,112.1h-8.11c-.54,0-.98.43-.98.97v.78c0,.54.44.97.98.97h8.11c.53,0,.96-.43.96-.97v-.78c0-.54-.43-.97-.96-.97ZM66.88,10.06l-2.44-1.73-18.03,3.98-5.6,3.78-2.36,5.65h2.89l3.56-3.98,11.75-1.19,7.61,8.37.7-3.66-4.89-5.3,5.93-.66.88-5.26ZM57.84,121.03l-8.86-4.34v.66c0,1,.59,1.9,1.49,2.32l6.52,3.1c.33.15.69.12.98-.08.6-.43.52-1.34-.13-1.66ZM68.05,127.28l-6.72-9.64c-.42-.6-1.36-.3-1.36.43v4.74c0,.95-.77,1.71-1.72,1.71h-6.21s-.02.02-.06.03c-.01.01-.02.01-.03.01h-.03c-.16.01-.33.03-.5.08-.03.01-.07.02-.12.04-.04.01-.09.03-.14.05-.07.02-.14.05-.2.09-.05.01-.11.04-.17.08-.07.04-.14.09-.21.14-.51.35-.87.87-1.09,1.47-.04.11-.07.23-.1.34-.04.14-.07.28-.09.42,0,.01-.01.03-.01.05-.02.22-.05.44-.05.67h.03l.02,2.15v1.52c0,.41.32.75.74.75h17.41c.41,0,.74-.34.74-.75v-3.95c0-.15-.04-.3-.13-.43ZM86.18,121.03c-.66.32-.73,1.23-.13,1.66.28.2.65.23.97.08l6.53-3.1c.9-.42,1.48-1.32,1.48-2.32v-.66l-8.85,4.34ZM103.21,16.09l-5.6-3.78-18.04-3.98-2.43,1.73.88,5.26,5.93.66-4.9,5.3.71,3.66,7.61-8.37,11.75,1.19,3.56,3.98h2.89l-2.36-5.65ZM84.11,45.74c-.86.38-1.38,1.44-1.24,2.52l.12.87,7.92-3.67c.74-.34,1.22-1.2,1.22-2.16v-1.06l-8.02,3.5ZM94.75,127.99h.02c0-.23-.02-.45-.05-.67,0-.02,0-.04,0-.05-.01-.14-.04-.28-.08-.42-.03-.11-.06-.23-.11-.34-.21-.6-.57-1.12-1.08-1.47-.07-.05-.14-.1-.22-.14-.05-.04-.11-.07-.16-.08-.06-.04-.13-.07-.2-.09-.05-.02-.1-.04-.15-.05-.04-.02-.08-.03-.12-.04-.16-.05-.33-.07-.5-.08h-.02s-.02,0-.03-.01c-.04-.01-.07-.03-.07-.03h-6.2c-.95,0-1.72-.76-1.72-1.71v-4.74c0-.73-.94-1.03-1.36-.43l-6.72,9.64c-.09.13-.14.28-.14.43v3.95c0,.41.34.75.75.75h17.41c.42,0,.75-.34.75-.75v-1.33s-.01-.19-.01-.19l.02-2.15ZM94.06,112.1h-8.11c-.53,0-.96.43-.96.97v.78c0,.54.43.97.96.97h8.11c.53,0,.97-.43.97-.97v-.78c0-.54-.44-.97-.97-.97ZM82.97,49.14h.02s-.02,0-.02,0ZM91.16,38.44h-8.94c-.59,0-1.05.53-.95,1.12l.06.39c.08.47.48.81.96.81h8.87c.53,0,.97-.43.97-.97v-.38c0-.54-.44-.97-.97-.97ZM94.76,133.25h-45.5l-.02,3.15c0,.12.05.24.06.34.09.8.43,1.54,1.06,2.08.44.38,1.03.66,1.65.66h5.18c.65,0,1.19-.53,1.19-1.19s.53-1.18,1.18-1.18h24.9c.65,0,1.18.53,1.18,1.18s.53,1.19,1.19,1.19h5.18c.62,0,1.2-.28,1.64-.66.64-.54.98-1.28,1.06-2.08.02-.1.06-.22.06-.34v-3.15ZM72.04,130.11h-.06c-1.1,0-2.09-.48-2.8-1.29v3.59h5.65v-3.59c-.71.81-1.69,1.29-2.79,1.29ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM76.83,59.43h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48ZM67.18,60.94h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM72.1,47.47h-.18c-3.35.01-10.95,5.03-10.96,25.34.08,8.83.66,17.74,3.01,26.31.98,3.53,2.96,6.97,5.37,9.72,1.01,1.14,1.99,2.02,2.64,2.02.01,0,.02-.01.03-.01s.02.01.03.01c.65,0,1.63-.88,2.64-2.02,2.41-2.75,4.39-6.19,5.37-9.72,2.35-8.57,2.93-17.48,3.01-26.31-.01-20.31-7.61-25.33-10.96-25.34ZM78.47,77.78c0,2.84-2.31,5.15-5.15,5.15h-2.62c-2.84,0-5.16-2.31-5.16-5.15v-18.92c0-.67.56-1.22,1.23-1.22h10.48c.67,0,1.22.55,1.22,1.22v18.92ZM67.18,60.94h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM76.83,59.43h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48ZM76.83,59.43h-9.65c-.26,0-.46.21-.46.48v.55c0,.26.2.48.46.48h9.65c.26,0,.47-.22.47-.48v-.55c0-.27-.21-.48-.47-.48ZM72.04,69.28h-.06c-3.04,0-5.51,2.79-5.51,6.23s2.47,6.24,5.51,6.24h.06c3.04,0,5.51-2.79,5.51-6.24s-2.47-6.23-5.51-6.23ZM95.03,110.2v.66l-7.96-3.9c-2.04,4.69-4.54,9.17-7.47,13.37l-5.3,7.6c-.52.74-1.36,1.18-2.26,1.18h-.06c-.9,0-1.75-.44-2.26-1.18l-5.3-7.6c-2.93-4.2-5.43-8.68-7.48-13.37l-7.96,3.9v-.66c0-1,.59-1.9,1.49-2.32l5.73-2.72c-1.13-3-3.54-10.13-5.15-17.48-1.49-6.8-1.75-11.71-1.71-14.57.02-1.88.32-3.74.92-5.51,2.75-8.13,7.28-8.32,8.77-10.69,6.46-10.37,10.44-50.77,10.44-50.77,0-.01,0-.02.01-.03.08-1.14.93-2.07,2.03-2.28v34.14c-.01,4.05-1.94,7.84-5.2,10.23-5.89,4.34-6.87,18.14-6.87,18.14-.92,13.76-1.79,29.25,5.39,41.92,1.25,2.59,5.37,8.84,7.01,11.23,0,0,.09.01.17.01s.16-.01.17-.01c1.64-2.39,5.76-8.64,7.01-11.23,7.17-12.67,6.31-28.16,5.39-41.92,0,0-.98-13.8-6.87-18.14-3.26-2.39-5.19-6.18-5.19-10.23V3.83c1.09.21,1.94,1.14,2.02,2.28.01.01.01.02.01.03,0,0,3.97,40.4,10.44,50.77,1.49,2.37,6.02,2.56,8.77,10.69.6,1.77.9,3.63.92,5.51.04,2.86-.22,7.77-1.71,14.57-1.61,7.35-4.02,14.48-5.15,17.48l5.73,2.72c.9.42,1.48,1.32,1.48,2.32Z" fill="${bodyColor}"/>
  <rect x="34.02" y="24.94" width="16.28" height="32.7" rx="3" fill="${lfColor}" stroke="${GRAY}" stroke-width="2"/>
  <rect x="93.76" y="24.94" width="16.28" height="32.7" rx="3" fill="${rfColor}" stroke="${GRAY}" stroke-width="2"/>
  <rect x="30.16" y="95.56" width="16.28" height="34" rx="3" fill="${lrColor}" stroke="${GRAY}" stroke-width="2"/>
  <rect x="97.32" y="95.56" width="16.28" height="34" rx="3" fill="${rrColor}" stroke="${GRAY}" stroke-width="2"/>`;
}

/**
 * @internal Exported for testing
 *
 * Generates an SVG data URI icon for the tire service based on settings and current tire state.
 */
export function generateTireServiceSvg(
  settings: TireServiceSettings,
  currentState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
  compoundState: { player: number; pitSv: number; pitSvStatus?: number } = { player: 0, pitSv: 0 },
  flashVisible: boolean = true,
): string {
  switch (settings.action) {
    case "change-all-tires": {
      const colors = resolveIconColors(changeAllTiresIconSvg, getGlobalColors(), settings.colorOverrides);
      const title = resolveTitleSettings(
        changeAllTiresIconSvg,
        getGlobalTitleSettings(),
        settings.titleOverrides,
        "ALL TIRES\nCHANGE",
      );

      const border = resolveBorderSettings(changeAllTiresIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

      return assembleIcon({
        graphicSvg: changeAllTiresIconSvg,
        colors,
        title,
        border,
      });
    }
    case "change-compound": {
      const compoundType = getCompoundName(compoundState.pitSv);
      const isChanging = compoundState.player !== compoundState.pitSv;
      const isWet = compoundType.toLowerCase() === "wet";
      // Service is "in progress" while pit crew is actively changing tires —
      // use PitSvFlags tire change bits (same as toggle-tires) since PlayerTireCompound
      // updates before the physical service completes
      const tiresBeingChanged = currentState.lf || currentState.rf || currentState.lr || currentState.rr;
      const isServiceInProgress =
        compoundState.pitSvStatus === PitSvStatus.InProgress && (isChanging || tiresBeingChanged);
      // Pit road warning: on pit road but not in stall yet, with compound change queued
      const isPitRoadWarning =
        isChanging && compoundState.onPitRoad && !compoundState.inPitStall && !isServiceInProgress;

      const iconContent = generateTireIcon(compoundType);
      const textElement = generateCompoundStatusBox(
        compoundType,
        isChanging,
        isServiceInProgress,
        isPitRoadWarning,
        flashVisible,
      );

      const compoundColors = resolveIconColors(tireServiceTemplate, getGlobalColors(), settings.colorOverrides);
      // Border: red flash on pit road warning, white during service, compound color otherwise
      let compoundBorderColor: string;

      if (isPitRoadWarning) {
        compoundBorderColor = flashVisible ? RED : isWet ? WET_COMPOUND_COLOR : DRY_COMPOUND_COLOR;
      } else if (isServiceInProgress) {
        compoundBorderColor = WHITE;
      } else {
        compoundBorderColor = isWet ? WET_COMPOUND_COLOR : DRY_COMPOUND_COLOR;
      }

      const border = resolveBorderSettings(
        tireServiceTemplate,
        getGlobalBorderSettings(),
        settings.borderOverrides,
        compoundBorderColor,
      );
      const borderSvg = generateBorderParts(border);

      const compoundSvg = renderIconTemplate(tireServiceTemplate, {
        iconContent,
        textElement,
        borderDefs: borderSvg.defs,
        borderContent: borderSvg.rects,
        ...compoundColors,
      });

      return svgToDataUri(compoundSvg);
    }
    case "clear-tires": {
      const colors = resolveIconColors(clearTiresIconSvg, getGlobalColors(), settings.colorOverrides);
      const title = resolveTitleSettings(
        clearTiresIconSvg,
        getGlobalTitleSettings(),
        settings.titleOverrides,
        "TIRES\nCLEAR",
      );

      const border = resolveBorderSettings(clearTiresIconSvg, getGlobalBorderSettings(), settings.borderOverrides);

      return assembleIcon({ graphicSvg: clearTiresIconSvg, colors, title, border });
    }
    default: {
      const toggleColors = resolveIconColors(tireServiceTemplate, getGlobalColors(), settings.colorOverrides);
      const bodyColor = (toggleColors as Record<string, string>).graphic1Color || WHITE;
      const toggleIconContent = generateToggleTiresIconContent(settings, currentState, bodyColor);

      const border = resolveBorderSettings(tireServiceTemplate, getGlobalBorderSettings(), settings.borderOverrides);
      const borderSvg = generateBorderParts(border);

      const svg = renderIconTemplate(tireServiceTemplate, {
        iconContent: toggleIconContent,
        textElement: "",
        borderDefs: borderSvg.defs,
        borderContent: borderSvg.rects,
        ...toggleColors,
      });

      return svgToDataUri(svg);
    }
  }
}

/**
 * Tire Service
 * Manages tire pit service: toggle tire changes, change compound, or clear tire selections.
 * Toggle mode: dynamic icon shows car with tire colors based on current iRacing state.
 * Green = will be changed, Red = configured but not active, Black = not configured.
 */
export const TIRE_SERVICE_UUID = "com.iracedeck.sd.core.tire-service" as const;

export class TireService extends ConnectionStateAwareAction<TireServiceSettings> {
  private activeContexts = new Map<string, TireServiceSettings>();
  private lastState = new Map<string, string>();
  private flashToggle = new Map<string, boolean>();

  override async onWillAppear(ev: IDeckWillAppearEvent<TireServiceSettings>): Promise<void> {
    await super.onWillAppear(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    await this.updateDisplayWithEvent(ev, settings);

    this.sdkController.subscribe(ev.action.id, (telemetry) => {
      const storedSettings = this.activeContexts.get(ev.action.id);

      if (storedSettings) {
        this.updateDisplayFromTelemetry(ev.action.id, telemetry, storedSettings);
      }
    });
  }

  override async onWillDisappear(ev: IDeckWillDisappearEvent<TireServiceSettings>): Promise<void> {
    await super.onWillDisappear(ev);
    this.sdkController.unsubscribe(ev.action.id);
    this.activeContexts.delete(ev.action.id);
    this.lastState.delete(ev.action.id);
    this.flashToggle.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: IDeckDidReceiveSettingsEvent<TireServiceSettings>): Promise<void> {
    await super.onDidReceiveSettings(ev);
    const settings = this.parseSettings(ev.payload.settings);
    this.activeContexts.set(ev.action.id, settings);

    const telemetry = this.sdkController.getCurrentTelemetry();
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);

    const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateTireServiceSvg(settings, tireState, compound));

    const stateKey = this.buildStateKey(settings, tireState, compound);
    this.lastState.set(ev.action.id, stateKey);
  }

  override async onKeyDown(ev: IDeckKeyDownEvent<TireServiceSettings>): Promise<void> {
    this.logger.info("Key down received");
    this.executeAction(ev.payload.settings);
  }

  override async onDialDown(ev: IDeckDialDownEvent<TireServiceSettings>): Promise<void> {
    this.logger.info("Dial down received");
    this.executeAction(ev.payload.settings);
  }

  private parseSettings(settings: unknown): TireServiceSettings {
    return migrateTireSettings(settings);
  }

  private async updateDisplayWithEvent(
    ev: IDeckWillAppearEvent<TireServiceSettings>,
    settings: TireServiceSettings,
  ): Promise<void> {
    const telemetry = this.sdkController.getCurrentTelemetry();
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);

    const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
    await ev.action.setTitle("");
    await this.setKeyImage(ev, svgDataUri);
    this.setRegenerateCallback(ev.action.id, () => generateTireServiceSvg(settings, tireState, compound));

    const stateKey = this.buildStateKey(settings, tireState, compound);
    this.lastState.set(ev.action.id, stateKey);
  }

  private async updateDisplayFromTelemetry(
    contextId: string,
    telemetry: TelemetryData | null,
    settings: TireServiceSettings,
  ): Promise<void> {
    const tireState = getTireState(telemetry);
    const compound = getCompoundState(telemetry);
    const isChanging = compound.player !== compound.pitSv;
    const tiresBeingChanged = tireState.lf || tireState.rf || tireState.lr || tireState.rr;
    const isServiceInProgress = compound.pitSvStatus === PitSvStatus.InProgress && (isChanging || tiresBeingChanged);
    const isPitRoadWarning = isChanging && compound.onPitRoad && !compound.inPitStall && !isServiceInProgress;

    // Toggle flash state every telemetry tick (4Hz → 2Hz flash) for pit road warning or service in progress
    if ((isServiceInProgress || isPitRoadWarning) && settings.action === "change-compound") {
      const currentFlash = this.flashToggle.get(contextId) ?? true;
      this.flashToggle.set(contextId, !currentFlash);
      const svgDataUri = generateTireServiceSvg(settings, tireState, compound, currentFlash);
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => generateTireServiceSvg(settings, tireState, compound, currentFlash));

      return;
    }

    // Reset flash toggle when not flashing
    this.flashToggle.delete(contextId);

    const stateKey = this.buildStateKey(settings, tireState, compound);
    const lastStateKey = this.lastState.get(contextId);

    if (lastStateKey !== stateKey) {
      this.lastState.set(contextId, stateKey);
      const svgDataUri = generateTireServiceSvg(settings, tireState, compound);
      await this.updateKeyImage(contextId, svgDataUri);
      this.setRegenerateCallback(contextId, () => generateTireServiceSvg(settings, tireState, compound));
    }
  }

  private buildStateKey(
    settings: TireServiceSettings,
    tireState: { lf: boolean; rf: boolean; lr: boolean; rr: boolean },
    compound: { player: number; pitSv: number },
  ): string {
    // Static-icon modes don't depend on telemetry — avoid unnecessary re-renders
    if (settings.action === "change-all-tires" || settings.action === "clear-tires") {
      return settings.action;
    }

    const tires = getDriverTires();
    const compoundType = getCompoundName(compound.pitSv);
    const bo = settings.borderOverrides;
    const borderKey = `${bo?.enabled ?? ""}|${bo?.borderWidth ?? ""}|${bo?.borderColor ?? ""}|${bo?.glowEnabled ?? ""}|${bo?.glowWidth ?? ""}`;

    return `${settings.action}|${settings.tires.join(",")}|${tireState.lf}|${tireState.rf}|${tireState.lr}|${tireState.rr}|${compound.player}|${compound.pitSv}|${tires.length}|${compoundType}|${borderKey}`;
  }

  private executeAction(rawSettings: unknown): void {
    if (!this.sdkController.getConnectionStatus()) {
      this.logger.info("Not connected to iRacing");

      return;
    }

    const settings = this.parseSettings(rawSettings);

    switch (settings.action) {
      case "change-all-tires": {
        this.logger.debug("Sending change all tires macro");
        const success = getCommands().chat.sendMessage("#t");

        if (success) {
          this.logger.info("Change all tires sent");
        } else {
          this.logger.warn("Failed to send change all tires");
        }

        break;
      }
      case "change-compound": {
        const telemetry = this.sdkController.getCurrentTelemetry();
        const { pitSv } = getCompoundState(telemetry);
        const compounds = getDriverTires();
        const currentArrayIdx = compounds.findIndex((t) => t.TireIndex === pitSv);
        const nextArrayIdx = (currentArrayIdx + 1) % compounds.length;
        const nextTire = compounds[nextArrayIdx];

        this.logger.debug(`Changing compound from ${getCompoundName(pitSv)} to ${getCompoundName(nextTire.TireIndex)}`);
        const success = getCommands().pit.tireCompound(nextTire.TireIndex);

        if (success) {
          this.logger.info("Tire compound change sent");
        } else {
          this.logger.warn("Failed to send tire compound change");
        }

        break;
      }
      case "clear-tires": {
        this.logger.debug("Sending clear tires");
        const success = getCommands().pit.clearTires();

        if (success) {
          this.logger.info("Clear tires sent");
        } else {
          this.logger.warn("Failed to send clear tires");
        }

        break;
      }
      default: {
        const macro = buildTireToggleMacro(settings);

        if (!macro) {
          this.logger.warn("No tires configured");

          return;
        }

        this.logger.debug(`Sending pit macro: ${macro}`);
        const success = getCommands().chat.sendMessage(macro);

        if (success) {
          this.logger.info("Tire toggle sent");
        } else {
          this.logger.warn("Failed to send tire toggle");
        }

        break;
      }
    }
  }
}
