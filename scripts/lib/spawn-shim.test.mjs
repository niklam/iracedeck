/**
 * The `.cmd` shim spawn (#1149): one quoted command line through the shell on
 * Windows, no shell elsewhere, and never an args array beside `shell: true`.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real `spawnSync`, recorded: the shape tests read the calls, the
// deprecation test needs a real child process.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const { spawnSync } = await import("node:child_process");
const { shellCommandLine, spawnSyncShim } = await import("./spawn-shim.mjs");

const HELPER_URL = pathToFileURL(fileURLToPath(new URL("./spawn-shim.mjs", import.meta.url))).href;

beforeEach(() => {
  vi.mocked(spawnSync).mockClear();
});

describe("shellCommandLine", () => {
  it("space-joins plain arguments with no quoting", () => {
    expect(shellCommandLine("pnpm", ["exec", "turbo", "run", "build"])).toBe("pnpm exec turbo run build");
  });

  it("leaves the characters our literals use unquoted", () => {
    expect(shellCommandLine("npx", ["release-it", "--preRelease=rc", "--filter=@iracedeck/x", "./a/b:c"])).toBe(
      "npx release-it --preRelease=rc --filter=@iracedeck/x ./a/b:c",
    );
  });

  it("quotes an argument containing a space", () => {
    expect(shellCommandLine("pnpm", ["--filter=@iracedeck/iracing-plugin-stream-deck", "with space"])).toBe(
      'pnpm --filter=@iracedeck/iracing-plugin-stream-deck "with space"',
    );
  });

  it("quotes and escapes an argument containing a double quote", () => {
    expect(shellCommandLine("pnpm", ['say "hi"'])).toBe('pnpm "say \\"hi\\""');
  });

  it.each(["a&b", "a|b", "a<b", "a>b", "a^b", "(a)"])("quotes %o so cmd.exe does not read its operator", (arg) => {
    expect(shellCommandLine("pnpm", [arg])).toBe(`pnpm "${arg}"`);
  });

  it.each(["%PATH%", "50%", "a\nb", "a\r\nb", 'say "&" now'])(
    "refuses %o, which cmd.exe would not pass intact",
    (arg) => {
      expect(() => shellCommandLine("pnpm", [arg])).toThrow(TypeError);
    },
  );

  it("stringifies non-string arguments", () => {
    expect(shellCommandLine("pnpm", [42])).toBe("pnpm 42");
  });
});

describe("spawnSyncShim", () => {
  it("hands Windows ONE command line with shell: true and no args array", () => {
    spawnSyncShim("pnpm", ["--version"], { encoding: "utf8", shell: false }, "win32");

    const [file, argsOrOptions, maybeOptions] = vi.mocked(spawnSync).mock.calls[0];
    expect(file).toBe("pnpm --version");
    expect(Array.isArray(argsOrOptions)).toBe(false);
    expect(argsOrOptions).toEqual({ encoding: "utf8", shell: true });
    expect(maybeOptions).toBeUndefined();
  });

  it.each(["linux", "darwin"])("spawns directly with no shell on %s", (platform) => {
    spawnSyncShim("pnpm", ["--version"], { encoding: "utf8", shell: true }, platform);

    expect(vi.mocked(spawnSync).mock.calls[0]).toEqual(["pnpm", ["--version"], { encoding: "utf8", shell: false }]);
  });
});

// The regression guard the issue asks for: a real `pnpm --version` through the
// helper, in a child running under `--throw-deprecation`, so DEP0190 coming back
// fails the child rather than printing a line nobody reads. The deprecation is
// emitted asynchronously, after `spawnSync` has returned, so the child's exit
// code is the signal — not whether the spawn itself threw.
describe("under --throw-deprecation", () => {
  function runChild(body) {
    const script = `import { spawnSync } from "node:child_process";
import { spawnSyncShim } from ${JSON.stringify(HELPER_URL)};
${body}
if (r.error) throw r.error;
if (r.status !== 0) process.exit(r.status ?? 1);
process.stdout.write("pnpm " + r.stdout.trim());`;
    return spawnSync(process.execPath, ["--throw-deprecation", "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("spawns pnpm --version through the helper with no deprecation", () => {
    const child = runChild(`const r = spawnSyncShim("pnpm", ["--version"], { encoding: "utf8" });`);

    expect(child.stderr).not.toContain("DEP0190");
    expect(child.status).toBe(0);
    expect(child.stdout).toMatch(/^pnpm \d+\.\d+\.\d+$/);
  });

  // Positive control: the shape the helper replaced must FAIL this harness, or
  // the test above proves nothing. Node only emits DEP0190 from 24 on.
  it.runIf(Number(process.versions.node.split(".")[0]) >= 24)("fails the old shell: true + args array shape", () => {
    const child = runChild(`const r = spawnSync("pnpm", ["--version"], { encoding: "utf8", shell: true });`);

    expect(child.stderr).toContain("DEP0190");
    expect(child.status).not.toBe(0);
  });
});
