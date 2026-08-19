/**
 * Minimal Chrome DevTools Protocol client (issue #1010).
 *
 * Pure transport: it connects, sends commands and resolves their replies. It
 * knows nothing about the Settings window, so the capture orchestration can be
 * tested against a fake with the same three methods.
 *
 * Dependency-free on purpose — Node 22+ ships a global `WebSocket`, so this
 * needs neither `ws` nor a browser-automation library. The repo already finds
 * and launches a Chromium itself (`chromium-browser.ts`), and this is the
 * matching "drive it" half.
 */

/** How long a single CDP command may take before we give up on it. */
export const CDP_COMMAND_TIMEOUT_MS = 30_000;

/** How long to wait for the browser's debugging endpoint to come up. */
export const CDP_ENDPOINT_TIMEOUT_MS = 20_000;

/**
 * Poll the browser's HTTP debugging endpoint until it answers with the
 * WebSocket URL to talk to.
 *
 * Chromium writes the endpoint only once it is ready, and refuses connections
 * until then, so the failures being swallowed here are the expected ones while
 * it starts.
 *
 * @param {number} port - `--remote-debugging-port` the browser was given.
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl] - Injected for tests.
 * @param {() => number} [deps.now] - Injected clock, for tests.
 * @param {(ms: number) => Promise<void>} [deps.delay] - Injected sleep.
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<string>} The browser-level WebSocket debugger URL.
 */
export async function waitForDebuggerUrl(port, deps = {}) {
  const {
    fetchImpl = fetch,
    now = () => Date.now(),
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = CDP_ENDPOINT_TIMEOUT_MS,
  } = deps;
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);

      if (response.ok) {
        const info = await response.json();

        if (typeof info?.webSocketDebuggerUrl === "string") return info.webSocketDebuggerUrl;
      }
    } catch {
      // Not listening yet — keep waiting until the deadline.
    }

    if (now() >= deadline) {
      throw new Error(`Chromium's debugging endpoint did not come up on port ${port} within ${timeoutMs}ms`);
    }

    await delay(100);
  }
}

/**
 * Connect to a CDP endpoint.
 *
 * @param {string} url - WebSocket debugger URL.
 * @param {object} [deps]
 * @param {new (url: string) => WebSocket} [deps.WebSocketImpl] - Injected for tests.
 * @param {number} [deps.commandTimeoutMs]
 * @returns {Promise<{send: (method: string, params?: object, sessionId?: string) => Promise<any>, close: () => void, onEvent: (listener: (message: any) => void) => void}>}
 */
export async function connectCdp(url, deps = {}) {
  const { WebSocketImpl = WebSocket, commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS } = deps;
  const socket = new WebSocketImpl(url);
  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, timer: any}>} */
  const pending = new Map();
  /** @type {((message: any) => void)[]} */
  const eventListeners = [];
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`Could not connect to the Chromium debugger at ${url}`)),
      { once: true },
    );
  });

  socket.addEventListener("message", (event) => {
    let message;

    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return; // Not something we sent; ignore rather than tear the run down.
    }

    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timer);

      if (message.error) {
        reject(new Error(`CDP error: ${message.error.message ?? JSON.stringify(message.error)}`));
      } else {
        resolve(message.result);
      }

      return;
    }

    for (const listener of eventListeners) listener(message);
  });

  return {
    /**
     * Send one command and await its result. `sessionId` targets a page
     * session rather than the browser itself.
     */
    send(method, params = {}, sessionId) {
      const id = nextId++;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP command ${method} timed out after ${commandTimeoutMs}ms`));
        }, commandTimeoutMs);

        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    close() {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP connection closed while the command was in flight"));
      }

      pending.clear();
      socket.close();
    },
  };
}
