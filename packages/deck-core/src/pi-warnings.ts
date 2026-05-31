/**
 * Reusable Property Inspector warning store (issue #610).
 *
 * Warning records are persisted in the `_warnings` global setting as a JSON
 * array. Each record is keyed by `id` so independent producers (e.g. the
 * elevation-mismatch detector) can post and clear their own banner without
 * clobbering others. The `ird-warnings` PI component renders the array at the
 * top of every Property Inspector.
 */
import { z } from "zod";

import { getGlobalSettings, updateGlobalSettings } from "./global-settings.js";

export type PiWarningLevel = "info" | "warning" | "error";

export interface PiWarning {
  id: string;
  level: PiWarningLevel;
  message: string;
}

const WARNINGS_KEY = "_warnings";

/**
 * Schema for one persisted warning record. `_warnings` is plugin-written, but it
 * round-trips through global settings (persisted on disk, echoed by the host),
 * so every entry is validated before `setWarning`/`clearWarning` dereference
 * `w.id`. Validating settings shapes with Zod follows the deck-core convention
 * (see `global-settings.ts` / `common-settings.ts`).
 */
const PiWarningSchema = z.object({
  id: z.string(),
  level: z.enum(["info", "warning", "error"]),
  message: z.string(),
});

function readWarnings(): PiWarning[] {
  const raw = (getGlobalSettings() as Record<string, unknown>)[WARNINGS_KEY];

  if (typeof raw !== "string" || raw === "") return [];

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((item) => {
      const result = PiWarningSchema.safeParse(item);

      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Upsert a warning by id. Replaces an existing record with the same id;
 * appends otherwise. Skips the write when an identical record already exists
 * so it never churns global settings on repeated calls.
 */
export function setWarning(id: string, level: PiWarningLevel, message: string): void {
  const list = readWarnings();
  const existing = list.find((w) => w.id === id);

  if (existing && existing.level === level && existing.message === message) return;

  const next = list.filter((w) => w.id !== id);
  next.push({ id, level, message });
  updateGlobalSettings({ [WARNINGS_KEY]: JSON.stringify(next) });
}

/**
 * Remove the warning with the given id. No-op (no write) when absent.
 */
export function clearWarning(id: string): void {
  const list = readWarnings();
  const next = list.filter((w) => w.id !== id);

  if (next.length === list.length) return;

  updateGlobalSettings({ [WARNINGS_KEY]: JSON.stringify(next) });
}
