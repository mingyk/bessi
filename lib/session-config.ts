import { AGENT_INSTRUCTIONS, MODEL, VOICE } from "./constants";

export const realtimeSession = {
  type: "realtime" as const,
  model: MODEL,
  instructions: AGENT_INSTRUCTIONS,
  output_modalities: ["audio"],
  audio: {
    input: {
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 280,
        create_response: true,
        interrupt_response: true,
      },
    },
    output: {
      voice: VOICE,
    },
  },
};
