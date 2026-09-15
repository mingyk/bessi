import { AGENT_INSTRUCTIONS, MODEL, VOICE } from "./constants";

export const realtimeSession = {
  type: "realtime" as const,
  model: MODEL,
  instructions: AGENT_INSTRUCTIONS,
  output_modalities: ["audio"],
  audio: {
    input: {
      noise_reduction: { type: "near_field" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.4,
        prefix_padding_ms: 150,
        silence_duration_ms: 200,
        create_response: true,
        interrupt_response: true,
      },
    },
    output: {
      voice: VOICE,
      speed: 1.05,
    },
  },
};
