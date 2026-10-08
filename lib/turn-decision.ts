export type Steer = "none" | "ignore" | "noise" | "out_of_scope" | "resume";

export type TurnDecision = {
  steer: Steer;
  naming?: boolean;
  checkin?: boolean;
};

export type DialogueLine = {
  speaker: "guest" | "host";
  text: string;
};

export function steerInstructions(decision: TurnDecision, options?: { repeats?: number }) {
  if (decision.steer === "none" || decision.steer === "ignore") return "";
  if (decision.steer === "resume") {
    return "They are only checking you are still on the line. This is not a new call. Do not greet, do not thank them for calling, and do not ask how you can help. In one short sentence, say you're here and pick the open task back up where it was; if nothing is open, ask if there's anything else.";
  }
  if (decision.steer === "noise") {
    if ((options?.repeats ?? 0) >= 1) {
      return "The last transcript was likely a mishear. Do not mention it and do not ask them to repeat. In one short sentence, continue from where you left off.";
    }
    return "You could not make out what they said. In one short sentence, ask them to say that again. Nothing else.";
  }
  return "They asked for something outside this call. In one short warm sentence, say you can't help with that but are happy to help with anything about the restaurant. Nothing else.";
}
