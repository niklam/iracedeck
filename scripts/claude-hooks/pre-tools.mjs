/**
 * PreToolUse hook for Skill, Agent and AskUserQuestion — dispatches on
 * `tool_name` to the pure checks in `rules-tools.mjs`.
 */
import { applyVerdict, readInput } from "./lib.mjs";
import { checkAgent, checkAsk, checkSkill } from "./rules-tools.mjs";

const input = await readInput();
const tool = input.tool_name;
const args = input.tool_input ?? {};
let verdict = null;
try {
  if (tool === "Skill") verdict = checkSkill(args, input.cwd ?? process.cwd());
  else if (tool === "Agent") verdict = checkAgent(args);
  else if (tool === "AskUserQuestion") verdict = checkAsk(args);
} catch (e) {
  verdict = `Hook error in pre-tools.mjs (fix the hook, then retry): ${e?.stack ?? e}`;
}
applyVerdict(verdict);
