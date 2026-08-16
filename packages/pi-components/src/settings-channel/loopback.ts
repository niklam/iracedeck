/**
 * Loopback transport for the settings-channel router: the ONE place that
 * builds the plugin's `ws://127.0.0.1:<port>/ws?t=<token>` URL and adapts a
 * native WebSocket to the router's `LoopbackSocket` (issue #993, phase 2).
 * Shared by the Elgato/Mirabox PI bridge and the Ulanzi PI bridge.
 *
 * Satisfies the router's `openLoopback` contract: `onClose` fires exactly
 * once — whether the connect fails, the socket errors, or it closes cleanly
 * — via the `closeOnce` guard below, and no handler is ever invoked
 * synchronously from inside this function (a native WebSocket's `onopen` /
 * `onmessage` / `onclose` / `onerror` callbacks are always async).
 */
import type { LoopbackHandlers, LoopbackSocket, PiFrame, SettingsChannel } from "./router.js";

export function loopbackUrl(channel: SettingsChannel): string {
  return `ws://127.0.0.1:${channel.port}/ws?t=${encodeURIComponent(channel.token)}`;
}

export function openLoopbackSocket(
  channel: SettingsChannel,
  handlers: LoopbackHandlers,
  Native: typeof WebSocket,
): LoopbackSocket {
  const socket = new Native(loopbackUrl(channel));
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;

    closed = true;
    handlers.onClose();
  };

  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (ev: MessageEvent) => {
    let frame: PiFrame;

    try {
      frame = JSON.parse(String(ev.data)) as PiFrame;
    } catch {
      return;
    }

    handlers.onMessage(frame);
  };
  socket.onclose = closeOnce;
  socket.onerror = closeOnce;

  return {
    send: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.close(),
  };
}
