import { setTimeout as sleep } from "node:timers/promises";

import type { ApplyTextNormalization, PronunciationDictionaryLocator, VoiceSettings } from "./config.ts";

const BASE_URL = "https://api.elevenlabs.io/v1";

export interface SynthesizeOptions {
  apiKey: string;
  voice_id: string;

  // Body fields (POST /v1/text-to-speech/{voice_id}).
  text: string;
  model_id: string;
  voice_settings: VoiceSettings;
  seed: number;
  previous_text?: string;
  next_text?: string;
  previous_request_ids?: string[];
  next_request_ids?: string[];
  language_code?: string;
  apply_text_normalization?: ApplyTextNormalization;
  apply_language_text_normalization?: boolean;
  pronunciation_dictionary_locators?: PronunciationDictionaryLocator[];
  use_pvc_as_ivc?: boolean;

  // Query params.
  output_format?: string;
  enable_logging?: boolean;
  optimize_streaming_latency?: number;
}

export interface SynthesizeResult {
  mp3: Buffer;
  requestId: string | null;
}

/**
 * POST /v1/text-to-speech/{voice_id} — returns the MP3 bytes plus the
 * response's request-id header (for later `previous_request_ids` chaining).
 *
 * Raw fetch (no SDK). Retries once on 429 using the Retry-After header when
 * present. All other non-2xx responses throw with the status + body.
 *
 * Field names deliberately mirror the ElevenLabs raw API (snake_case) so the
 * shape is 1:1 with their docs and there's no mental translation.
 */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<SynthesizeResult> {
  const {
    apiKey,
    voice_id,
    output_format = "mp3_44100_128",
    enable_logging,
    optimize_streaming_latency,
    ...bodyFields
  } = options;

  const query = new URLSearchParams({ output_format });

  if (enable_logging !== undefined) query.set("enable_logging", String(enable_logging));

  if (optimize_streaming_latency !== undefined) {
    query.set("optimize_streaming_latency", String(optimize_streaming_latency));
  }

  const url = `${BASE_URL}/text-to-speech/${encodeURIComponent(voice_id)}?${query.toString()}`;
  // Strip undefined fields so they don't serialize as nulls and confuse the API.
  const body = JSON.stringify(Object.fromEntries(Object.entries(bodyFields).filter(([, v]) => v !== undefined)));
  const maxAttempts = 2;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body,
    });

    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      const requestId = res.headers.get("request-id") ?? res.headers.get("x-request-id");

      return { mp3: Buffer.from(arrayBuffer), requestId };
    }

    const errorBody = await res.text().catch(() => "");
    lastError = new Error(`ElevenLabs ${res.status} ${res.statusText}: ${errorBody || "(empty body)"}`);

    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfterSec = Number(res.headers.get("retry-after") ?? 5);
      await sleep(retryAfterSec * 1000);
      continue;
    }

    break;
  }

  throw lastError ?? new Error("ElevenLabs request failed with no response");
}
