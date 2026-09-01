import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECK_HOSTS,
  findHost,
  hostNames,
  pluginSourceDir,
  resolveAppPath,
  resolveAppPathSource,
  resolvePluginsDir,
  resolvePluginsDirSource,
} from "./deck-hosts.mjs";

const WIN = { platform: "win32" };
const LINUX = { platform: "linux" };

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

  it("gives every host both default resolvers", () => {
    // These used to be id-keyed maps beside the descriptors. A host added or
    // renamed in one place and not the other resolved to `undefined` and threw
    // a TypeError — on Windows only, so CI stayed green. Keeping them ON the
    // descriptor makes that drift impossible; this test pins it.
    for (const host of Object.values(DECK_HOSTS)) {
      expect(typeof host.defaultPluginsDir).toBe("function");
      expect(typeof host.defaultAppPath).toBe("function");
    }
  });

  it("describes every field the scripts actually read", () => {
    for (const host of Object.values(DECK_HOSTS)) {
      for (const field of ["label", "linkScript", "unlinkScript", "examplePluginsDir", "exampleAppPath"]) {
        expect(typeof host[field]).toBe("string");
        expect(host[field]).not.toBe("");
      }
    }
  });

  it("names pnpm scripts that follow the host's own id", () => {
    // Messages build script names from the descriptor rather than by
    // concatenation, so these must agree with the root package.json entries.
    for (const host of Object.values(DECK_HOSTS)) {
      expect(host.linkScript).toBe(`link:${host.id}`);
      expect(host.unlinkScript).toBe(`unlink:${host.id}`);
    }
  });

  it("keeps the Ulanzi plugin folder on the host's *.ulanziPlugin scan suffix", () => {
    // UlanziStudio only scans folders ending in `.ulanziPlugin`; renaming this
    // silently stops the host from ever seeing the plugin.
    expect(DECK_HOSTS.ulanzi.pluginFolder).toMatch(/\.ulanziPlugin$/);
  });
});

describe("findHost", () => {
  it("resolves a known host and returns undefined otherwise", () => {
    expect(findHost("ulanzi")).toBe(DECK_HOSTS.ulanzi);
    expect(findHost("nope")).toBeUndefined();
    expect(findHost(undefined)).toBeUndefined();
  });

  it("lists the valid names for an error message", () => {
    expect(hostNames()).toContain("ulanzi");
    expect(hostNames()).toContain("mirabox");
  });
});

describe("resolvePluginsDir", () => {
  it("prefers the environment variable over the platform default", () => {
    const env = { MIRABOX_PLUGINS_DIR: "D:\\custom", APPDATA: "C:\\Users\\me\\AppData\\Roaming" };

    expect(resolvePluginsDir(DECK_HOSTS.mirabox, { env, ...WIN })).toBe("D:\\custom");
    expect(resolvePluginsDirSource(DECK_HOSTS.mirabox, { env, ...WIN }).source).toBe("env");
  });

  it("derives the Windows default from APPDATA", () => {
    const env = { APPDATA: join("C:", "Users", "me", "AppData", "Roaming") };

    expect(resolvePluginsDir(DECK_HOSTS.mirabox, { env, ...WIN })).toBe(
      join(env.APPDATA, "HotSpot", "StreamDock", "plugins"),
    );
    expect(resolvePluginsDir(DECK_HOSTS.ulanzi, { env, ...WIN })).toBe(
      join(env.APPDATA, "Ulanzi", "UlanziDeck", "Plugins"),
    );
    expect(resolvePluginsDirSource(DECK_HOSTS.ulanzi, { env, ...WIN }).source).toBe("default");
  });

  it("treats a blank environment variable as unset rather than as a path", () => {
    // `FOO=` in .env.local previously passed `??` as "", which suppressed the
    // platform default and then reported "not set and no default derived".
    const env = { ULANZI_PLUGINS_DIR: "   ", APPDATA: join("C:", "Users", "me", "AppData", "Roaming") };

    expect(resolvePluginsDir(DECK_HOSTS.ulanzi, { env, ...WIN })).toBe(
      join(env.APPDATA, "Ulanzi", "UlanziDeck", "Plugins"),
    );
  });

  it("derives nothing off Windows, or without APPDATA", () => {
    expect(resolvePluginsDir(DECK_HOSTS.ulanzi, { env: { APPDATA: "C:\\x" }, ...LINUX })).toBeUndefined();
    expect(resolvePluginsDir(DECK_HOSTS.ulanzi, { env: {}, ...WIN })).toBeUndefined();
    expect(resolvePluginsDirSource(DECK_HOSTS.ulanzi, { env: {}, ...WIN }).source).toBe("none");
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
    expect(resolveAppPathSource(DECK_HOSTS.mirabox, { env: {}, ...WIN }).source).toBe("none");
  });
});

describe("pluginSourceDir", () => {
  it("points at the plugin folder inside its package", () => {
    expect(pluginSourceDir(DECK_HOSTS.ulanzi, join("C:", "repo"))).toBe(
      join("C:", "repo", "packages", "iracing-plugin-ulanzi", "com.ulanzi.iracedeck.ulanziPlugin"),
    );
  });
});
