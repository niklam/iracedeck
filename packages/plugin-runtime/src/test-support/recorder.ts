/**
 * Test-only call recorder for the bootstrap's collaborators (#1349).
 *
 * A module mocked through `recordingModule` keeps its non-function exports
 * real (constants, schemas, enums) and replaces every function export with a
 * stub that appends its name to `callLog`. A stub's return value is another
 * stub, so `getController().subscribe(…)` records
 * `"getController().subscribe"` and `new IRacingNative()` records
 * `"new IRacingNative"`. `implement(name, fn)` gives one recorded name a real
 * return value for a test; the call is still logged.
 *
 * Two facts every test author needs: a stub is never thenable (`.then` reads
 * `undefined`), so code that calls `.then(…)` on a stubbed result needs
 * `implement("<path>", () => new Promise(() => {}))` for that path; and a
 * stub's `Symbol.iterator` is an empty generator, so `new Set(stub)` and
 * `[...stub]` are empty.
 */
export const callLog: string[] = [];

type Impl = (...args: unknown[]) => unknown;

const impls = new Map<string, Impl>();

export function resetRecorder(): void {
  callLog.length = 0;
  impls.clear();
}

/** Give a recorded call a real implementation. `name` is the logged name (`"isSettingsStoreReady"`, `"new AudioNative"`, `"createVoicePackService().refresh"`). */
export function implement(name: string, impl: Impl): void {
  impls.set(name, impl);
}

function invoke(name: string, args: unknown[]): unknown {
  callLog.push(name);

  return impls.has(name) ? impls.get(name)?.(...args) : stub(`${name}()`);
}

/** A permissive stand-in reached through `path`. */
export function stub(path: string): any {
  const target = function () {
    // a callable, constructible target for the traps below
  };

  return new Proxy(target, {
    get(_target, prop) {
      // Never thenable: `void x.catch(…)`, `await`, and Vitest's own module checks must not treat a stub as a promise.
      if (prop === "then") return undefined;

      if (prop === Symbol.toPrimitive) return () => `[stub ${path}]`;

      if (prop === Symbol.iterator) return function* () {};

      if (typeof prop === "symbol") return undefined;

      return stub(`${path}.${prop}`);
    },
    apply: (_target, _this, args: unknown[]) => invoke(path, args),
    construct: (_target, args: unknown[]) => {
      const result = invoke(`new ${path}`, args);

      return typeof result === "object" || typeof result === "function" ? (result as object) : stub(`${path}#instance`);
    },
  });
}

/** A mock module: real constants, recorded functions and classes. */
export function recordingModule(actual: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [name, typeof value === "function" ? stub(name) : value]),
  );
}

/**
 * The first place `actual` departs from `expected`, worded for an assertion
 * message: which call ran where another was expected.
 */
export function describeFirstDifference(actual: readonly string[], expected: readonly string[]): string {
  const index = actual.findIndex((name, i) => name !== expected[i]);

  if (index === -1) {
    return actual.length === expected.length
      ? "identical"
      : `the sequences agree for ${actual.length} calls, then ${actual.length < expected.length ? `"${expected[actual.length]}" never ran` : `"${actual[expected.length]}" ran extra`}`;
  }

  return `call #${index}: expected "${expected[index]}", but "${actual[index]}" ran there — "${actual[index]}" and "${expected[index]}" swapped places or one moved`;
}
