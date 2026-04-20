import { setTimeout as sleep } from "node:timers/promises";

import type { VoiceSettings } from "./config.ts";

const BASE_URL = "https://api.elevenlabs.io/v1";

export interface SynthesizeOptions {
  apiKey: string;
  voiceId: string;
  text: string;
  model: string;
  voiceSettings: VoiceSettings;
  outputFormat?: string;
}

/**
 * POST /v1/text-to-speech/{voice_id} — returns the MP3 bytes.
 *
 * Raw fetch (no SDK). Retries once on 429 using the Retry-After header when
 * present. All other non-2xx responses throw with the status + body.
 */
export async function synthesizeSpeech(options: SynthesizeOptions): Promise<Buffer> {
  const { apiKey, voiceId, text, model, voiceSettings, outputFormat = "mp3_44100_128" } = options;

  const url = `${BASE_URL}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const body = JSON.stringify({
    text,
    model_id: model,
    voice_settings: voiceSettings,
  });
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

      return Buffer.from(arrayBuffer);
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
