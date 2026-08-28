import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DECK_HOSTS, pluginSourceDir, resolveAppPath, resolvePluginsDir } from "./deck-hosts.mjs";
import { linkPlugin, unlinkPlugin } from "./plugin-link.mjs";

const WIN = { platform: "win32" };
const LINUX = { platform: "linux" };

/** Collects console-shaped output so a script's messages can be asserted. */
function fakeLog() {
  return { log: vi.fn(), error: vi.fn() };
}

/** Every line the fake logger received, joined — order-independent matching. */
function allOutput(log) {
  return [...log.log.mock.calls, ...log.error.mock.calls].map((args) => args.join(" ")).join("\n");
}

describe("DECK_HOSTS", () => {
  it("keys match each host's own id", () => {
    for (const [key, host] of Object.entries(DECK_HOSTS)) {
      expect(host.id).toBe(key);
    }
  });

  it("gives every host a distinct env var, folder and package", () => {
    const hosts = Object.values(DECK_HOSTS);
    for (const field of ["pluginsDirEnv", "appPathEnv", "pluginFolder", "package"]) {
      const values = hosts.map((host) => host[field]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("keeps the Ulanzi plugin folder on the host's *.ulanziPlugin scan suffix", () => {
    // UlanziStudio only scans folders ending in `.ulanziPlugin`; renaming this
    // silently stops the host from ever seeing the plugin.
    expect(DECK_HOSTS.ulanzi.pluginFolder).toMatch(/\.ulanziPlugin$/);
  });
});

describe("resolvePluginsDir", () => {
  it("prefers the environment variable over the platform default", () => {
    const env = { MIRABOX_PLUGINS_DIR: "D:\\custom", APPDATA: "C:\\Users\\me\\AppData\\Roaming" };

    expect(resolvePluginsDir(DECK_HOSTS.mirabox, { env, ...WIN })).toBe("D:\\custom");
  });

  it("derives the Windows default from APPDATA", () => {
    const env = { APPDATA: join("C:", "Users", "me", "AppData", "Roaming") };

    expect(resolvePluginsDir(DECK_HOSTS.mirabox, { env, ...WIN })).toBe(
      join(env.APPDATA, "HotSpot", "StreamDock", "plugins"),
    );
    expect(resolvePluginsDir(DECK_HOSTS.ulanzi, { env, ...WIN })).toBe(
      join(env.APPDATA, "Ulanzi", "UlanziDeck", "Plugins"),
    );
  });

  it("derives nothing off Windows, or without APPDATA", () => {
    expect(resolvePluginsDir(DECK_HOSTS.ulanzi, { env: { APPDATA: "C:\\x" }, ...LINUX })).toBeUndefined();
    expect(resolvePluginsDir(DECK_HOSTS.ulanzi, { env: {}, ...WIN })).toBeUndefined();
  });
});

describe("resolveAppPath", () => {
  it("prefers the environment variable over the platform default", () => {
    const env = { ULANZI_APP_PATH: "D:\\Ulanzi\\UlanziDeck.exe", "ProgramFiles(x86)": "C:\\Program Files (x86)" };

    expect(resolveAppPath(DECK_HOSTS.ulanzi, { env, ...WIN })).toBe("D:\\Ulanzi\\UlanziDeck.exe");
  });

  it("derives the Windows default from ProgramFiles(x86)", () => {
    const env = { "ProgramFiles(x86)": join("C:", "Program Files (x86)") };

    expect(resolveAppPath(DECK_HOSTS.ulanzi, { env, ...WIN })).toBe(
      join(env["ProgramFiles(x86)"], "Ulanzi Studio", "UlanziDeck.exe"),
    );
    expect(resolveAppPath(DECK_HOSTS.mirabox, { env, ...WIN })).toBe(
      join(env["ProgramFiles(x86)"], "StreamDock", "StreamDock.exe"),
    );
  });

  it("derives nothing off Windows, or without ProgramFiles(x86)", () => {
    expect(resolveAppPath(DECK_HOSTS.mirabox, { env: { "ProgramFiles(x86)": "C:\\x" }, ...LINUX })).toBeUndefined();
    expect(resolveAppPath(DECK_HOSTS.mirabox, { env: {}, ...WIN })).toBeUndefined();
  });
});

describe("pluginSourceDir", () => {
  it("points at the plugin folder inside its package", () => {
    expect(pluginSourceDir(DECK_HOSTS.ulanzi, join("C:", "repo"))).toBe(
      join("C:", "repo", "packages", "iracing-plugin-ulanzi", "com.ulanzi.iracedeck.ulanziPlugin"),
    );
  });
});

describe("linkPlugin", () => {
  it("fails naming the env var and an example when nothing resolves", () => {
    const log = fakeLog();

    expect(linkPlugin(DECK_HOSTS.ulanzi, { root: join("C:", "repo"), env: {}, ...LINUX, log })).toBe(1);
    expect(allOutput(log)).toContain("ULANZI_PLUGINS_DIR");
    expect(allOutput(log)).toContain(DECK_HOSTS.ulanzi.examplePluginsDir);
  });

  it("fails when the plugin has not been built", () => {
    const log = fakeLog();
    const env = { ULANZI_PLUGINS_DIR: join("C:", "nope", "plugins") };

    expect(linkPlugin(DECK_HOSTS.ulanzi, { root: join("C:", "no-such-repo"), env, ...WIN, log })).toBe(1);
    expect(allOutput(log)).toContain("is not built");
    // Names the missing build output, not merely the folder.
    expect(allOutput(log)).toContain(join("bin", "plugin.js"));
  });
});

describe("unlinkPlugin", () => {
  it("is a no-op when no destination resolves", () => {
    const log = fakeLog();

    expect(unlinkPlugin(DECK_HOSTS.mirabox, { root: join("C:", "repo"), env: {}, ...LINUX, log })).toBe(0);
    expect(allOutput(log)).toContain("nothing to unlink");
  });

  it("is a no-op when nothing is linked", () => {
    const log = fakeLog();
    const env = { ULANZI_PLUGINS_DIR: join("C:", "definitely", "not", "here") };

    expect(unlinkPlugin(DECK_HOSTS.ulanzi, { root: join("C:", "repo"), env, ...WIN, log })).toBe(0);
    expect(allOutput(log)).toContain("nothing to unlink");
  });
});
