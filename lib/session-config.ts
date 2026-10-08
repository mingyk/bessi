import { AGENT_INSTRUCTIONS, MODEL, VOICE } from "./constants";

export const TURN_SILENCE_MS = 620;
export const DEMO_TURN_SILENCE_MS = 500;
export const NAME_TURN_SILENCE_MS = 1500;
export const INPUT_TRANSCRIPTION: { model: string; prompt?: string } = {
  model: "gpt-4o-mini-transcribe",
};

export function turnDetection(silenceMs: number) {
  return {
    type: "server_vad" as const,
    threshold: 0.7,
    prefix_padding_ms: 300,
    silence_duration_ms: silenceMs,
    create_response: false,
    interrupt_response: false,
  };
}

export function buildRealtimeSession(
  instructions: string,
  options?: { transcribe?: boolean; transcriptionPrompt?: string; silenceMs?: number },
) {
  const transcription = options?.transcriptionPrompt
    ? { ...INPUT_TRANSCRIPTION, prompt: options.transcriptionPrompt }
    : INPUT_TRANSCRIPTION;
  return {
    type: "realtime" as const,
    model: MODEL,
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        ...(options?.transcribe ? { transcription } : {}),
        turn_detection: turnDetection(options?.silenceMs ?? TURN_SILENCE_MS),
      },
      output: {
        voice: VOICE,
      },
    },
  };
}

export const realtimeSession = buildRealtimeSession(AGENT_INSTRUCTIONS);
