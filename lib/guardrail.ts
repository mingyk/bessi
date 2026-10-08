import type { DialogueLine, TurnDecision } from "./turn-decision";

const ON_TOPIC =
  /\b(bessi|voice|agent|support|pricing|price|plan|pilot|demo|integrat|api|call|phone|customer|setup|security|privacy|latency|handoff|rollout|onboard|troubleshoot|mic|microphone|hang up|talk|conversation|brand)\b/i;

const OFF_TOPIC =
  /\b(weather|forecast|recipe|cook|sports|score|nba|nfl|mlb|homework|essay|president|election|politic|bitcoin|crypto|stock market|poem|joke|riddle|horoscope|translate this|write (a |me |code|an )|python|javascript function|math problem|girlfriend|boyfriend|therapy|medical advice|who won|tell me a story|meaning of life)\b/i;

const CLEAR_OFF_TOPIC =
  /\b(weather|forecast|temperature outside|who (won|is the president)|capital of|homework|riddle|horoscope|bitcoin|stock market|tell me a (joke|story)|recipe for)\b/i;

const TASK =
  /\b(reserv|book|table|tomorrow|tonight|party|o'?clock|\d\s*(am|pm)|waitlist|to-?go|menu|galbi)\b/i;

const HOST_ASKS =
  /\b(time|o'?clock|pm|am|party|how many|name|date|tomorrow|tonight|when|what time|reserv|book|table)\b/i;

export function isOffTopic(transcript: string): boolean {
  const text = transcript.trim();
  if (text.length < 12) return false;
  if (ON_TOPIC.test(text)) return false;
  return OFF_TOPIC.test(text);
}

function midRestaurantTask(history: DialogueLine[]) {
  const host = [...history].reverse().find((line) => line.speaker === "host");
  if (host && HOST_ASKS.test(host.text)) return true;
  return history.some((line) => TASK.test(line.text));
}

export function guardRestaurantSteer(
  decision: TurnDecision,
  latest: string,
  history: DialogueLine[],
): TurnDecision {
  if (decision.steer !== "out_of_scope") return decision;
  if (CLEAR_OFF_TOPIC.test(latest)) return decision;
  if (!midRestaurantTask(history)) return decision;
  return { ...decision, steer: "noise" };
}
