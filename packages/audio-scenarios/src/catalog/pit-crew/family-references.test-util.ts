import { type CalloutScript, collectScriptReferences, type ScriptReferences } from "@iracedeck/callout-script";

/**
 * The references a family's own entries make, for the exact-list assertions in
 * a family's test. A voice's frames are left out: their open, close and cut
 * steps (for example the `radio/never-mind` cut tail, #1407) belong to every
 * callout and to no family.
 */
export function familyReferences(script: CalloutScript): ScriptReferences {
  return collectScriptReferences({ ...script, frames: {} });
}
