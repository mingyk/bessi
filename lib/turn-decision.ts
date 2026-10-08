export type Steer = "none" | "ignore" | "noise" | "out_of_scope" | "slip" | "third_value" | "resume";

export type TurnDecision = {
  steer: Steer;
  naming?: boolean;
  recall?: boolean;
  checkin?: boolean;
};

export type DialogueLine = {
  speaker: "guest" | "host";
  text: string;
};

export function steerInstructions(
  decision: TurnDecision,
  options?: { repeats?: number; need?: string | null },
) {
  if (decision.steer === "none" || decision.steer === "ignore") return "";
  if (decision.steer === "resume") {
    const need = options?.need;
    if (need) {
      return `They are only checking you are still on the line. This is not a new call and not a request for help. Do not greet, do not thank them for calling, and do not ask how you can help. In one short sentence, ask only for ${need}.`;
    }
    return "They are only checking you are still on the line. Do not greet and do not restart. In one short sentence, say you are here and ask if there is anything else. Nothing else.";
  }
  if (decision.steer === "noise") {
    const need = options?.need;
    if ((options?.repeats ?? 0) >= 1) {
      if (need) {
        return `The last transcript was likely a mishear, not a new request. Do not mention it and do not ask them to repeat. In one short sentence, ask only for ${need} as the next booking question. If you already asked that, offer one specific time inside hours and wait.`;
      }
      return "The last transcript was likely a mishear. Do not mention it and do not ask them to repeat. In one short sentence, continue the restaurant conversation from where you left off.";
    }
    if (need) {
      return `You could not make out their answer. In one short sentence, ask for ${need} again. Do not mention what you thought you heard. Nothing else.`;
    }
    return "You could not make out what they said. In one short sentence, ask them to say that again. Nothing else.";
  }
  if (decision.steer === "out_of_scope") {
    return "They asked for something outside this call. In one short warm sentence, say you can't help with that but are happy to help with anything about the restaurant. Nothing else.";
  }
  if (decision.steer === "slip") {
    return "They may have slipped. In one warm sentence, ask which of the two values they mean. Do not pick one. Do not confirm a booking.";
  }
  return "They named a new value that is neither of the two you offered. Use that new value. Do not go back to the earlier pair. If name, party size, time, or date is missing, ask only for what is missing. Do not say the table is booked until all four are known.";
}
