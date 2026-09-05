import {
  CalloutScriptEntrySchema,
  FrameDefinitionSchema,
  NO_FRAME,
  POOL_DEFINITION_NAME_PATTERN,
  PoolDefinitionSchema,
  RESERVED_FRAME_NAME_MESSAGE,
  SCENARIO_ID_PATTERN,
} from "@iracedeck/callout-script";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { SynthesizeOptions } from "./elevenlabs.ts";
import type { Manifest } from "./manifest.ts";

// Voice and group keys must start with a letter — they're category labels and
// never purely numeric in practice.
const kebab = z.string().regex(/^[a-z][a-z0-9-]*$/, "must be lowercase kebab-case (a-z, 0-9, dashes)");

// The keys of the three callout-script maps (#1064). Each is the rule
// `CalloutScriptSchema` applies to the same map in the extracted
// `voice/<voice-id>/callouts.json` — or a stricter one — so a config that
// parses here always yields an artifact `parseCalloutScript` accepts, and an
// author's mistake is reported against the file they edited rather than
// against a generated one.
const scenarioId = z.string().regex(SCENARIO_ID_PATTERN, "must be a scenario id: non-empty, no whitespace");

// Stricter than the artifact's rule (any non-whitespace name): a frame is a
// category label like a group, so it takes the same kebab-case shape. `none` is
// the reserved "unframed" marker and can never be defined — refused in the
// grammar's own words, so the config and the artifact report the same mistake
// the same way.
const frameName = kebab.refine((name) => name !== NO_FRAME, RESERVED_FRAME_NAME_MESSAGE);

// A DEFINED pool never carries a slash: a slashed reference always means a
// direct `group/base` of the voice's own clips, which is what keeps the two
// namespaces from colliding.
const poolDefinitionName = z
  .string()
  .regex(POOL_DEFINITION_NAME_PATTERN, "must be a pool name: lowercase letters, digits and dashes, no slash");

// Entry file names may start with a digit (e.g. "0", "42-laps-to-go"). Also
// accepts a JSON number and coerces it to its String() form so `"name": 0`
// becomes `"0"`.
const entryName = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase alphanumeric/dashes"));

// Accept either a string or a number in text-ish fields; numbers are coerced
// to their String() representation so a bare `0` in JSON still generates a
// valid TTS input ("zero"). Refuses booleans, null, arrays, objects.
const textual = z.union([z.string(), z.number()]).transform((v) => String(v));

export const VoiceSettingsSchema = z.object({
  stability: z.number().min(0).max(1),
  similarity_boost: z.number().min(0).max(1),
  style: z.number().min(0).max(1).default(0),
  speed: z.number().min(0.7).max(1.2).default(1.0),
  use_speaker_boost: z.boolean().default(true),
  // ElevenLabs accepts language_code as a top-level body field, but we group
  // it here so it rides along with stability/speed/etc. and can be set at any
  // level (voice, entry) — useful for per-entry overrides like
  // `"language_code": "fi"` on a Finnish-name entry. It's extracted at
  // request time and sent as a top-level body field per the API contract.
  language_code: z.string().optional(),
});

// Per-entry override schema. Intentionally NOT `VoiceSettingsSchema.partial()`:
// that variant still applies Zod defaults during parse (so an entry override of
// just `{ speed: 0.9 }` materializes as `{ speed: 0.9, style: 0, use_speaker_boost: true }`,
// and the resulting object clobbers the voice's `style`/`use_speaker_boost` in
// the shallow merge). Here every field is plain `.optional()` with no default,
// so a parsed override contains exactly the keys the user wrote — preserving
// the voice's base values for everything else.
export const VoiceSettingsOverrideSchema = z.object({
  stability: z.number().min(0).max(1).optional(),
  similarity_boost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
  use_speaker_boost: z.boolean().optional(),
  language_code: z.string().optional(),
});

export const PronunciationDictionaryLocatorSchema = z.object({
  pronunciation_dictionary_id: z.string().min(1),
  version_id: z.string().min(1),
});

export const ApplyTextNormalizationSchema = z.enum(["auto", "on", "off"]);

export const EntrySchema = z.object({
  name: entryName,
  text: textual.pipe(z.string().min(1)),
  // Deterministic seed for the ElevenLabs request. Same seed + same voice +
  // same text + same settings = byte-identical audio. Defaults to 1 if omitted.
  seed: z.number().int().min(0).max(4_294_967_295).default(1),
  // Context to improve prosody on line boundaries. ElevenLabs uses these as
  // "what came before / after this clip" hints without speaking them.
  previous_text: textual.optional(),
  next_text: textual.optional(),
  // Request IDs of previously-generated clips to improve cross-line continuity.
  // Each element is either a `<group>/<entry-name>` reference (resolved at
  // generate-time against `generate.manifest.json` for the current voice) or a
  // raw ElevenLabs request-id string. The `/` is the disambiguator: any string
  // containing it is treated as a reference, anything else passes through to
  // ElevenLabs verbatim. References are resolved per-voice so the same chain
  // block produces a per-voice link without duplication. See
  // `validateReferences` and `resolveRequestIds`.
  previous_request_ids: z.array(z.string()).max(3).optional(),
  next_request_ids: z.array(z.string()).max(3).optional(),
  // Per-entry overrides — each falls back to the voice's value when omitted.
  // Shallow-merge semantics for `voice_settings`; scalar replacement for the
  // rest. All audio-affecting overrides feed the per-entry hash, so flipping
  // any of them on a single entry invalidates only that entry's cache.
  voice_settings: VoiceSettingsOverrideSchema.optional(),
  model_id: z.string().optional(),
  output_format: z.string().optional(),
  apply_text_normalization: ApplyTextNormalizationSchema.optional(),
  apply_language_text_normalization: z.boolean().optional(),
  optimize_streaming_latency: z.number().int().min(0).max(4).optional(),
  pronunciation_dictionary_locators: z.array(PronunciationDictionaryLocatorSchema).max(3).optional(),
  use_pvc_as_ivc: z.boolean().optional(),
});

export const VoiceConfigSchema = z.object({
  // Voice metadata — required.
  id: z.string().min(1),
  label: z.string().min(1),
  // TTS defaults for this voice. Each voice is self-contained: nothing
  // falls back across voice files. Different voices need different
  // models / speeds / settings, so sharing them across the pack would
  // be a footgun — `model_id` is intentionally required (no implicit
  // default) so a typo or omission fails loudly instead of silently
  // picking a wrong model.
  model_id: z.string().min(1),
  voice_settings: VoiceSettingsSchema,
  // Optional voice-level defaults (per-entry may still override).
  use_pvc_as_ivc: z.boolean().optional(),
  output_format: z.string().optional(),
  apply_text_normalization: ApplyTextNormalizationSchema.optional(),
  apply_language_text_normalization: z.boolean().optional(),
  enable_logging: z.boolean().optional(),
  optimize_streaming_latency: z.number().int().min(0).max(4).optional(),
  pronunciation_dictionary_locators: z.array(PronunciationDictionaryLocatorSchema).max(3).optional(),
  // The actual content.
  groups: z.record(kebab, z.array(EntrySchema)),
  // The voice's callout script (#1064): what the Race Engineer says for each
  // scenario the code declares, the frames wrapped around a callout, and the
  // named pools a sequence draws from. Authored here — one file per voice —
  // and extracted verbatim by `pnpm generate:callout-scripts` into the
  // committed `voice/<voice-id>/callouts.json` the plugin and the voice packs
  // ship; the `groups` above never leave this package. All three are optional
  // so a clips-only voice stays a valid config: an absent map is an empty map
  // in the artifact, and a scenario with no entry is a callout that voice
  // never makes.
  scenarios: z.record(scenarioId, CalloutScriptEntrySchema).optional(),
  frames: z.record(frameName, FrameDefinitionSchema).optional(),
  pools: z.record(poolDefinitionName, PoolDefinitionSchema).optional(),
});

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;
export type VoiceSettingsOverride = z.infer<typeof VoiceSettingsOverrideSchema>;
export type Entry = z.infer<typeof EntrySchema>;
export type PronunciationDictionaryLocator = z.infer<typeof PronunciationDictionaryLocatorSchema>;
export type ApplyTextNormalization = z.infer<typeof ApplyTextNormalizationSchema>;

// Filenames in `configs/` follow `<voice-id>.voice.json`; the stem becomes
// the runtime voice id (kebab-case, matches the on-disk `voice/<id>/...`
// directory).
const VOICE_FILE_SUFFIX = ".voice.json";

/**
 * Load every per-voice config from a directory of `<voice-id>.voice.json`
 * files. The filename stem (`default` from `default.voice.json`) is the
 * voice id used in the generator output path and the runtime manifest.
 * Order is sorted by id for deterministic iteration.
 *
 * Per-voice `validateReferences` runs eagerly so a typoed
 * `<group>/<entry-name>` reference fails fast.
 */
export function loadVoiceConfigs(configsDir: string): Map<string, VoiceConfig> {
  const entries = readdirSync(configsDir).filter((f) => f.endsWith(VOICE_FILE_SUFFIX));
  const ids = entries.map((f) => f.slice(0, -VOICE_FILE_SUFFIX.length)).sort();
  const map = new Map<string, VoiceConfig>();

  for (const voiceId of ids) {
    kebab.parse(voiceId);

    const fileName = `${voiceId}${VOICE_FILE_SUFFIX}`;
    const raw = readFileSync(path.join(configsDir, fileName), "utf-8");
    let json: unknown;

    try {
      json = JSON.parse(raw);
    } catch (err) {
      // Generic SyntaxError from JSON.parse doesn't say which file failed —
      // in a multi-voice loader that's hostile to debugging.
      throw new Error(`Failed to parse ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const parsed = VoiceConfigSchema.safeParse(json);

    if (!parsed.success) {
      // Same reason as the JSON.parse guard above: a bare ZodError names the
      // path of the problem but not the file, and since #1064 the callout
      // script is authored in this file too, by a pack author who may never
      // have seen the generator.
      throw new Error(`Invalid ${fileName}:\n${describeIssues(parsed.error)}`);
    }

    const voiceConfig = parsed.data;

    validateReferences(voiceId, voiceConfig);
    map.set(voiceId, voiceConfig);
  }

  return map;
}

/**
 * One line per issue, `<path>: <message>`. Hand-rolled rather than
 * `z.prettifyError` for one reason: a record key that fails its rule (a frame
 * named `none`, a pool name with a slash) is reported by zod as a generic
 * "Invalid key in record" with the rule's own message nested underneath, and
 * the nested message is the one that says what to fix.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const detail =
        issue.code === "invalid_key" ? issue.issues.map((nested) => nested.message).join("; ") : issue.message;

      return `  ${z.core.toDotPath(issue.path)}: ${detail}`;
    })
    .join("\n");
}

/**
 * Resolve the effective voice_settings stack — voice-level then per-entry
 * override. `VoiceSettings` is flat so a shallow merge is sufficient.
 */
export function resolveVoiceSettings(voice: VoiceConfig, entry?: Entry): VoiceSettings {
  return {
    ...voice.voice_settings,
    ...(entry?.voice_settings ?? {}),
  };
}

/**
 * Reference-syntax test: any element of `previous_request_ids` /
 * `next_request_ids` containing a forward slash is a `<group>/<entry-name>`
 * reference; anything else is a raw ElevenLabs request-id (which never
 * contains `/`).
 */
export function isReference(idOrRef: string): boolean {
  return idOrRef.includes("/");
}

/**
 * Cross-entry validation for a single voice config: reject any
 * `<group>/<entry-name>` reference that doesn't point to a known entry in
 * the same voice file (typo guard). Raw IDs (no `/`) are passed through
 * untouched. Errors list valid candidates so a typo is easy to fix without
 * grepping the file.
 *
 * Runs once per voice in `loadVoiceConfigs`, before any manifest lookup or
 * API call, so config-shape errors surface immediately and aren't hidden
 * behind a long generation run.
 */
export function validateReferences(voiceId: string, voice: VoiceConfig): void {
  const candidates = new Set<string>();

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      candidates.add(`${groupName}/${entry.name}`);
    }
  }

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      for (const field of ["previous_request_ids", "next_request_ids"] as const) {
        const ids = entry[field];

        if (!ids) continue;

        for (const id of ids) {
          if (!isReference(id)) continue;

          if (!candidates.has(id)) {
            const valid = [...candidates].sort().join("\n  ");

            throw new Error(
              `Invalid ${field} reference "${id}" on entry "${groupName}/${entry.name}" ` +
                `(voice "${voiceId}"). No such entry. ` +
                `Valid <group>/<entry-name> candidates:\n  ${valid}`,
            );
          }
        }
      }
    }
  }
}

/**
 * Resolve `<group>/<entry-name>` references in a request-id list to the
 * matching `requestId` from `generate.manifest.json` for the given voice.
 * Raw IDs (no `/`) pass through unchanged.
 *
 * Resolution is per-voice: the same reference produces `default`'s
 * requestId for voice `default`, `titan`'s requestId for voice `titan`.
 * The dependency must already exist in the manifest (run
 * `--voice <v> --group <dep-group>` first, or order dependencies before
 * dependents in the config so a single full run completes them in the
 * right order).
 *
 * Returns `undefined` when given `undefined` so callers can still drop the
 * field from the request body when no chain context is configured.
 */
export function resolveRequestIds(
  ids: string[] | undefined,
  voiceName: string,
  manifest: Manifest,
): string[] | undefined {
  if (!ids) return undefined;

  return ids.map((id) => {
    if (!isReference(id)) return id;

    const key = `voice/${voiceName}/${id}.mp3`;
    const target = manifest.entries[key];

    if (!target) {
      throw new Error(
        `Reference "${id}" for voice "${voiceName}" has no matching entry in generate.manifest.json ` +
          `(looked up "${key}"). Generate the dependency first, e.g. ` +
          `\`pnpm --filter @iracedeck/audio-assets generate --voice ${voiceName} --group ${id.split("/")[0]}\`.`,
      );
    }

    if (!target.requestId) {
      throw new Error(
        `Reference "${id}" for voice "${voiceName}" resolved to manifest entry "${key}" but it has no ` +
          `requestId (likely generated before request-id capture, or the provider didn't return one). ` +
          `Re-cut the dependency with \`--voice ${voiceName} --group ${id.split("/")[0]}\` to refresh it.`,
      );
    }

    return target.requestId;
  });
}

/** A located config entry — its group plus the entry object. */
export type EntryRef = { groupName: string; entry: Entry };

/**
 * Build a `<group>/<entry-name>` → entry lookup for one voice. Used by
 * `entryHash` to recurse into request-id dependencies and by the generator
 * to map references back to their config entries.
 */
export function buildEntryLookup(voice: VoiceConfig): Map<string, EntryRef> {
  const lookup = new Map<string, EntryRef>();

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      lookup.set(`${groupName}/${entry.name}`, { groupName, entry });
    }
  }

  return lookup;
}

/**
 * Reject any reference *cycle* in a voice's `<group>/<entry-name>` request-id
 * graph (A → B → … → A). The generator requires an acyclic graph because:
 *   - `entryHash` hashes dependencies recursively — a cycle would recurse
 *     forever (and conceptually has no fixed-point content hash);
 *   - `resolveRequestIds` needs each dependency generated *before* its
 *     dependents, which a cycle makes impossible from an empty manifest.
 *
 * Runs before any generation work so a cyclic config fails fast with the
 * exact cycle path rather than looping or deadlocking mid-run. Raw
 * passthrough IDs (no `/`) are not graph edges and are ignored.
 */
export function detectReferenceCycles(voiceId: string, voice: VoiceConfig): void {
  const adjacency = new Map<string, string[]>();

  for (const [groupName, entries] of Object.entries(voice.groups)) {
    for (const entry of entries) {
      const refs = [...(entry.previous_request_ids ?? []), ...(entry.next_request_ids ?? [])].filter(isReference);
      adjacency.set(`${groupName}/${entry.name}`, refs);
    }
  }

  // Standard 3-colour DFS: white = unseen, grey = on the current DFS stack,
  // black = fully explored. An edge into a grey node closes a cycle.
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    colour.set(node, GREY);
    stack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      const state = colour.get(next) ?? WHITE;

      if (state === GREY) {
        const cycle = [...stack.slice(stack.indexOf(next)), next];

        throw new Error(
          `Reference cycle detected in voice "${voiceId}":\n  ${cycle.join(" → ")}\n` +
            `request-id references must form an acyclic graph — break the cycle by removing one of ` +
            `the previous_request_ids / next_request_ids links above.`,
        );
      }

      if (state === WHITE) visit(next);
    }

    stack.pop();
    colour.set(node, BLACK);
  };

  for (const node of adjacency.keys()) {
    if ((colour.get(node) ?? WHITE) === WHITE) visit(node);
  }
}

/**
 * Sort-keyed JSON so hashes are insensitive to property insertion order.
 * Arrays preserve order (order matters for them semantically).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";

  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",") + "}";
}

/**
 * Construct the `synthesizeSpeech` options for one entry, resolving
 * voice-level then per-entry fields in that order.
 *
 * `previous_request_ids` / `next_request_ids` are left as their **raw**
 * `<group>/<entry-name>` reference strings (or raw passthrough IDs) here —
 * they are resolved to provider request IDs only at API-call time via
 * `resolveEntryRequestIds`. Keeping them raw is what lets `entryHash` stay
 * a pure function of config *content* rather than volatile provider IDs.
 * `apiKey` is injected separately at the call site.
 */
export function buildEntryOptions(entry: Entry, voice: VoiceConfig): Omit<SynthesizeOptions, "apiKey"> {
  // Resolve the 2-level voice_settings stack (voice → entry) and split off
  // language_code so it ships as the top-level body field per the
  // ElevenLabs API contract — `voice_settings` itself stays clean.
  const merged = resolveVoiceSettings(voice, entry);
  const { language_code, ...voice_settings } = merged;

  return {
    voice_id: voice.id,
    text: entry.text,
    model_id: entry.model_id ?? voice.model_id,
    voice_settings,
    seed: entry.seed,
    previous_text: entry.previous_text,
    next_text: entry.next_text,
    previous_request_ids: entry.previous_request_ids,
    next_request_ids: entry.next_request_ids,
    language_code,
    apply_text_normalization: entry.apply_text_normalization ?? voice.apply_text_normalization,
    apply_language_text_normalization:
      entry.apply_language_text_normalization ?? voice.apply_language_text_normalization,
    pronunciation_dictionary_locators:
      entry.pronunciation_dictionary_locators ?? voice.pronunciation_dictionary_locators,
    use_pvc_as_ivc: entry.use_pvc_as_ivc ?? voice.use_pvc_as_ivc,
    output_format: entry.output_format ?? voice.output_format,
    // `enable_logging` is excluded from the hash (it doesn't change the
    // audio), so keep it voice-level only.
    enable_logging: voice.enable_logging,
    optimize_streaming_latency: entry.optimize_streaming_latency ?? voice.optimize_streaming_latency,
  };
}

/**
 * Resolve the raw `<group>/<entry-name>` references in an options object
 * (from `buildEntryOptions`) to concrete provider request IDs for the API
 * call. Separated from `buildEntryOptions` so the hash never sees the
 * volatile resolved IDs.
 */
export function resolveEntryRequestIds(
  options: Omit<SynthesizeOptions, "apiKey">,
  voiceName: string,
  manifest: Manifest,
): Omit<SynthesizeOptions, "apiKey"> {
  return {
    ...options,
    previous_request_ids: resolveRequestIds(options.previous_request_ids, voiceName, manifest),
    next_request_ids: resolveRequestIds(options.next_request_ids, voiceName, manifest),
  };
}

/**
 * Content hash for one entry — the generator's cache key.
 *
 * Hashes the entry's own audio-affecting config (text, voice settings,
 * model, seed, the **raw** request-id reference strings, …) plus, for every
 * `<group>/<entry-name>` reference, the recursively-computed `entryHash` of
 * that dependency. So the key changes when the entry's own config changes
 * *or* when any (transitive) dependency's config changes — but NOT when a
 * dependency is merely re-cut and handed a fresh provider request ID.
 *
 * This is why request-id stitching no longer makes the cache thrash: the
 * provider returns a new request ID on every generation, and hashing those
 * would re-cut every dependent on every run (and loop forever on a cycle).
 * Hashing config content instead is stable and still cascades correctly on
 * a real change. The recursion terminates because `detectReferenceCycles`
 * guarantees the graph is acyclic; the `visiting` guard turns any missed
 * cycle into a clear error rather than a stack overflow.
 *
 * An entry with **no** `<group>/<entry-name>` dependencies keeps the
 * pre-existing cache-key shape (hash of its options alone) — its hashing
 * semantics never changed, so it must stay a cache hit. Only entries that
 * actually have dependency references move to the `{ self, deps }` shape.
 *
 * `memo` is shared across a voice's entries so each entry is hashed once.
 */
export function entryHash(
  entry: Entry,
  groupName: string,
  voice: VoiceConfig,
  lookup: Map<string, EntryRef>,
  memo: Map<string, string> = new Map(),
  visiting: Set<string> = new Set(),
): string {
  const key = `${groupName}/${entry.name}`;
  const cached = memo.get(key);

  if (cached !== undefined) return cached;

  if (visiting.has(key)) {
    throw new Error(
      `Reference cycle reached "${key}" while hashing — call detectReferenceCycles() before entryHash().`,
    );
  }

  visiting.add(key);

  const { enable_logging: _omitted, ...selfOptions } = buildEntryOptions(entry, voice);

  const depHashes: string[] = [];

  for (const id of [...(entry.previous_request_ids ?? []), ...(entry.next_request_ids ?? [])]) {
    if (!isReference(id)) continue;

    const dep = lookup.get(id);

    if (!dep) {
      // `validateReferences` already rejects unknown references at load time;
      // this guards against a lookup built from a different voice.
      throw new Error(`entryHash: reference "${id}" on "${key}" has no matching entry in the lookup.`);
    }

    depHashes.push(entryHash(dep.entry, dep.groupName, voice, lookup, memo, visiting));
  }

  visiting.delete(key);

  // Ref-less entries hash their options directly (the historical shape), so
  // a config that doesn't use request-id chains sees no churn from this
  // change. Entries with dependencies fold in the recursive dep hashes.
  const hashInput = depHashes.length === 0 ? selfOptions : { self: selfOptions, deps: depHashes };

  const hash = createHash("sha256").update(stableStringify(hashInput)).digest("hex").slice(0, 16);

  memo.set(key, hash);

  return hash;
}
