/**
 * Test-only call recorder for the bootstrap's collaborators (#1349).
 *
 * A module mocked through `recordingModule` keeps its non-function exports
 * real (constants, schemas, enums) and replaces every function export with a
 * stub that appends its name to `callLog`. A stub's return value is another
 * stub, so `getController().subscribe(…)` records
 * `"getController().subscribe"`. A constructor call records `"new X"`, and a
 * method called on the instance records `"new X().method"` — the one form,
 * whether the instance is the default stub or the fallback for an
 * `implement("new X", …)` that returned a primitive. `implement(name, fn)`
 * gives one recorded name a real return value for a test; the call is still
 * logged.
 *
 * Three facts every test author needs:
 *
 * - A stub is never thenable (`.then` reads `undefined`), so code that calls
 *   `.then(…)` on a stubbed result needs
 *   `implement("<path>", () => new Promise(() => {}))` for that path.
 * - A stub's `Symbol.iterator` is an empty generator, so `new Set(stub)` and
 *   `[...stub]` are empty.
 * - A stubbed value is a truthy function. Unimplemented, `getGlobalSettings()`
 *   returns a stub whose every property is another stub, so
 *   `if (settings.flag)` takes the true branch, `settings.flag === false` is
 *   false and `settings.flag !== false` is true. A test that needs a specific
 *   settings branch must `implement("getGlobalSettings", …)` explicitly, and
 *   an EXPECTED order list must never be captured from an unimplemented run:
 *   it would pin whichever branches the stubs happened to select.
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

      // A primitive (or null) cannot be a constructor's result; fall back to the
      // default instance stub, so its methods log under the same `new X()` form.
      return (typeof result === "object" && result !== null) || typeof result === "function"
        ? (result as object)
        : stub(`new ${path}()`);
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
 * message: which call ran where another was expected. When one list is a
 * prefix of the other, it names the first call past the shared prefix: one
 * that never ran, or one that ran extra.
 */
export function describeFirstDifference(actual: readonly string[], expected: readonly string[]): string {
  const common = Math.min(actual.length, expected.length);
  // Compare only the shared prefix: past it, `expected[i]` is undefined and
  // every extra call would otherwise read as a mismatch at `common`.
  const index = actual.findIndex((name, i) => i < common && name !== expected[i]);

  if (index === -1) {
    if (actual.length === expected.length) return "identical";

    const next = actual.length < expected.length ? `"${expected[common]}" never ran` : `"${actual[common]}" ran extra`;

    return `the sequences agree for ${common} call${common === 1 ? "" : "s"}, then ${next}`;
  }

  return `call #${index}: expected "${expected[index]}", but "${actual[index]}" ran there — "${actual[index]}" and "${expected[index]}" swapped places or one moved`;
}
