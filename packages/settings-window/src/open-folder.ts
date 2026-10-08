/**
 * Reveal a file in Windows Explorer (issue #993 — the settings window's
 * "Open folder"). The SECOND child_process use in the plugin beside the
 * settings-window spawn; the path always comes from the plugin's own store,
 * never from a page. `openUrl` is deliberately http(s)-only, so this does not
 * go through it.
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";

/**
 * Explorer's documented form is `/select,"<path>"` — the quotes are part of
 * the argument, not shell quoting. Without them libuv quotes the whole token
 * itself (a path containing a space forces it), producing
 * `"/select,C:\...\Stream Deck\global-settings.json"`, which Explorer does
 * not parse. Hence the explicit quotes here plus `windowsVerbatimArguments`
 * at the spawn, so Node hands the string through untouched.
 */
export function explorerSelectArgs(filePath: string): string[] {
  return [`/select,"${filePath}"`];
}

export function openFolderInExplorer(filePath: string): void {
  const child = spawn("explorer.exe", explorerSelectArgs(filePath), {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    windowsVerbatimArguments: true,
  });

  // A ChildProcess with no "error" listener THROWS on a spawn failure (e.g.
  // explorer.exe missing from PATH), which would take the plugin down over a
  // convenience button. There is no logger on this seam, so swallow it: the
  // user simply sees no window, and the path is on screen to open by hand.
  child.on("error", () => {});
  child.unref();
}

/**
 * Open a DIRECTORY in Windows Explorer (issue #1100 — the settings window's
 * "Open voice packs folder").
 *
 * Deliberately not {@link openFolderInExplorer}, which reveals a FILE: Explorer's
 * `/select,"<path>"` shows the path's PARENT with the path highlighted, so
 * handing it the voice-packs directory opens `…\Race Engineer\` with `Voices`
 * merely selected. That is one level above where the text beside the button
 * tells the user to drop a pack, and a pack dropped there is one the scanner
 * never looks at — present, silent, and in neither the installed list nor the
 * problems list.
 *
 * The directory is created first. It may genuinely not exist yet — nothing else
 * guarantees it before the first install — and Explorer given a missing path
 * silently opens somewhere else entirely, which is a worse answer than an empty
 * folder at the address the user was just told to use.
 */
export function openDirectoryInExplorer(dirPath: string): void {
  try {
    mkdirSync(dirPath, { recursive: true });
  } catch {
    // Opening it is still worth attempting: the folder may exist but be
    // unwritable by this process, which Explorer can show perfectly well.
  }

  const child = spawn("explorer.exe", [`"${dirPath}"`], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    windowsVerbatimArguments: true,
  });

  child.on("error", () => {});
  child.unref();
}
