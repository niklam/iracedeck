/**
 * Reveal a file in Windows Explorer (issue #993 — the settings window's
 * "Open folder"). The SECOND child_process use in the plugin beside the
 * settings-window spawn; the path always comes from the plugin's own store,
 * never from a page. `openUrl` is deliberately http(s)-only, so this does not
 * go through it.
 */
import { spawn } from "node:child_process";

export function explorerSelectArgs(filePath: string): string[] {
  return [`/select,${filePath}`];
}

export function openFolderInExplorer(filePath: string): void {
  spawn("explorer.exe", explorerSelectArgs(filePath), { detached: true, stdio: "ignore", windowsHide: false }).unref();
}
