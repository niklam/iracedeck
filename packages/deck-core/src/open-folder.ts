/**
 * Reveal a file in Windows Explorer (issue #993 — the settings window's
 * "Open folder"). The SECOND child_process use in the plugin beside the
 * settings-window spawn; the path always comes from the plugin's own store,
 * never from a page. `openUrl` is deliberately http(s)-only, so this does not
 * go through it.
 */
import { spawn } from "node:child_process";

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
