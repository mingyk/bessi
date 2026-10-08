import { getTypesafeKey } from "./typesafe-key";
import type { DialogueLine, Steer, TurnDecision } from "./turn-decision";

type ChoiceAnswer = {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

type NoulAnswer = {
  noul?: number;
};

const QUESTIONS = {
  turn: {
    type: "choice",
    instructions: "What is the guest's latest line?",
    criteria: {
      noise:
        "Not speech aimed at the host: a cough, a hum, or background with no request. A greeting, thanks, goodbye, yes, no, a name, a time, or any short real answer is not noise.",
      social:
        "Talking to the host without a restaurant request: thanks, okay, goodbye, or a greeting at the very start. Checking whether the host is still there mid-call (hello?, are you there?) is still this, not a new request.",
      restaurant:
        "A real request about this restaurant: menu, price, portions, hours, address, parking, to-go, pre-order, deals, wait, the waitlist, a reservation detail such as a time, date, party size, or name, an answer to the host's last restaurant question, or any other question about visiting this restaurant. A garbled time, name, party size, or yes/no still counts if they are answering the host.",
      out_of_scope:
        "A clear request that is not about this restaurant, such as weather, trivia, or math that is not a bill or a headcount. Do not use this when they seem to be answering the host about a reservation, wait, or order, even if a word looks like another topic (a misheard time or name).",
    },
  },
  name: {
    type: "noul",
    instructions:
      "Is the guest mainly saying a person's name, or spelling a name letter by letter? A name in a different language from the rest of the sentence still counts. A sentence about a time, date, or party size does not.",
    criteria: {
      true: "They are giving a name or spelling one",
      false: "They are not giving a name",
    },
  },
  checkin: {
    type: "noul",
    instructions:
      "Is the guest only checking that the host is still on the line, with no new request and no yes or no to the last question?",
    criteria: {
      true: "They are checking the host is still there: a bare hello, are you there, can you hear me, or the same idea after a pause. Not a greeting that starts the call, not thanks, not okay, not goodbye, not hesitation (um, uh), and not an answer.",
      false: "They are greeting at the start, answering, asking something, hesitating, thanking, or ending.",
    },
  },
} as const;

const EXPECT_NAME = {
  expect: {
    type: "noul",
    instructions:
      "Is the host waiting for the guest to give a person's name, or to spell a name letter by letter?",
    criteria: {
      true: "The host's latest line asks for a name, asks to hear a name again, or asks the guest to spell it. Still true when that line also asks for a time, a date, or a party size.",
      false: "The host is not waiting for a name or a spelling.",
    },
  },
} as const;

function chosen(answer: ChoiceAnswer | undefined, minimum: number) {
  if (!answer || answer.choice == null) return null;
  const probability = answer.probabilities?.[answer.choice];
  const confidence = answer.confidence ?? probability ?? 0;
  if (confidence < minimum) return null;
  if (probability != null && probability < minimum) return null;
  return answer.choice;
}

function contentWords(latest: string) {
  return latest
    .trim()
    .split(/\s+/)
    .filter((word) => word.replace(/[^\p{L}\p{N}]/gu, "").length > 1).length;
}

export function toDecision(
  answers: {
    turn?: ChoiceAnswer;
    name?: NoulAnswer;
    checkin?: NoulAnswer;
  },
  latest = "",
): TurnDecision {
  const naming = (answers.name?.noul ?? 0) >= 0.55;
  const hesitation = /^(um+|uh+|hmm+|어+|음+)[.?!\s]*$/i.test(latest);
  const checkin = !naming && !hesitation && (answers.checkin?.noul ?? 0) >= 0.55;
  const turn = chosen(answers.turn, 0.55);
  const noiseSure = chosen(answers.turn, 0.85) === "noise";
  const restaurantP = answers.turn?.probabilities?.restaurant ?? 0;
  let steer: Steer = "none";
  if (noiseSure && restaurantP <= 0.15 && !naming) {
    steer = contentWords(latest) >= 4 ? "noise" : "ignore";
  } else if (
    !naming &&
    turn === "out_of_scope" &&
    chosen(answers.turn, 0.62) === "out_of_scope"
  ) {
    steer = "out_of_scope";
  }
  return { steer, naming, checkin };
}

export async function decideTurn(input: {
  latest: string;
  history: DialogueLine[];
}): Promise<TurnDecision> {
  const none: TurnDecision = {
    steer: "none",
    naming: false,
    checkin: false,
  };
  const latest = input.latest.trim();
  if (!latest) return none;
  const key = await getTypesafeKey();
  if (!key) return none;

  const history = input.history
    .slice(-6)
    .map((line) => ({
      speaker: line.speaker,
      text: line.text.slice(0, 240),
    }));

  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "jev-latest",
      state: { earlier: history, latest },
      questions: QUESTIONS,
    }),
    signal: AbortSignal.timeout(650),
  });
  if (!response.ok) return none;
  const data = (await response.json()) as { answers?: {
    turn?: ChoiceAnswer;
    name?: NoulAnswer;
    checkin?: NoulAnswer;
  } };
  if (!data.answers) return none;
  return toDecision(data.answers, latest);
}

export async function decideExpectName(input: {
  latest: string;
  history: DialogueLine[];
}): Promise<boolean | null> {
  const latest = input.latest.trim();
  if (!latest) return null;
  const key = await getTypesafeKey();
  if (!key) return null;

  const history = input.history
    .slice(-6)
    .map((line) => ({
      speaker: line.speaker,
      text: line.text.slice(0, 240),
    }));

  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "jev-latest",
      state: { earlier: history, latest },
      questions: EXPECT_NAME,
    }),
    signal: AbortSignal.timeout(650),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { answers?: { expect?: NoulAnswer } };
  const noul = data.answers?.expect?.noul;
  if (typeof noul !== "number") return null;
  return noul >= 0.55;
}
