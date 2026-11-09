/**
 * A tripwire for a script that should exit once its work is done (#1544).
 *
 * `pnpm capture:settings` once wrote every screenshot and then never exited: a
 * browser it thought it had stopped kept the profile locked, and the profile's
 * removal retried on timers that held the event loop. Nothing failed, so
 * nothing said so. Armed after the script's last output, this turns that shape
 * into a failure that names what is holding the process open.
 *
 * The timer is unref'd, so on a healthy run the process exits before it can
 * fire and it costs nothing; it fires only while something else keeps the
 * event loop alive.
 */

/** How long after its last output the script may still be running. */
export const EXIT_TRIPWIRE_MS = 5_000;

/**
 * Count the entries of a list of names, as `Timeout ×2, TCPWRAP`.
 *
 * @param {readonly string[]} names
 * @returns {string}
 */
function summarise(names) {
  /** @type {Map<string, number>} */
  const counts = new Map();

  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

  if (counts.size === 0) return "none";

  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
}

/**
 * The resources holding the event loop, from Node's own accounting.
 *
 * `process._getActiveHandles` is undocumented, so it is read defensively; it
 * adds the class behind each handle (`Socket`, `ChildProcess`, `Server`),
 * which `getActiveResourcesInfo`'s `TCPWRAP` / `ProcessWrap` does not name.
 *
 * @returns {{resources: string[], handles: string[]}}
 */
function readActiveResources() {
  const handles = /** @type {any} */ (process)._getActiveHandles?.() ?? [];

  return {
    resources: process.getActiveResourcesInfo(),
    handles: handles.map((/** @type {any} */ handle) => handle?.constructor?.name ?? typeof handle),
  };
}

/**
 * Arm the tripwire.
 *
 * @param {object} [deps] - Everything it touches, injected for tests.
 * @param {number} [deps.ms]
 * @param {(fire: () => void, ms: number) => {unref?: () => unknown} | undefined} [deps.setTimer]
 * @param {() => {resources: string[], handles: string[]}} [deps.activeResources]
 * @param {(line: string) => void} [deps.report] - Where the failure is written; stderr by default.
 * @param {string} [deps.hint] - A last line of the report, for what the caller's
 *   failure leaves behind and how to undo it; none by default.
 * @param {(code: number) => void} [deps.exit]
 * @returns {{unref?: () => unknown} | undefined} The timer, already unref'd.
 */
export function armExitTripwire(deps = {}) {
  const {
    ms = EXIT_TRIPWIRE_MS,
    setTimer = (fire, delayMs) => setTimeout(fire, delayMs),
    activeResources = readActiveResources,
    report = (line) => console.error(line),
    exit = (code) => process.exit(code),
    hint,
  } = deps;

  const timer = setTimer(() => {
    const { resources, handles } = activeResources();

    report(
      `The capture finished, but the process was still running ${ms} ms after its last output: ` +
        `something is holding the event loop open.`,
    );
    report(`Active resources: ${summarise(resources)}`);
    report(`Active handles: ${summarise(handles)}`);
    if (hint !== undefined && hint !== "") report(hint);
    exit(1);
  }, ms);

  timer?.unref?.();

  return timer;
}
