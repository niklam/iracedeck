/**
 * @iracedeck/deck-adapter-vsd
 *
 * VSDinside Stream Dock adapter for the deck-core platform abstraction.
 */

export { VSDPlatformAdapter } from "./adapter.js";
export {
  VSDClient,
  parseConnectionParams,
  type VSDConnectionParams,
  type VSDEvent,
  type VSDEventHandler,
} from "./vsd-client.js";
