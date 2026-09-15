const ON_TOPIC =
  /\b(bessi|voice|agent|support|pricing|price|plan|pilot|demo|integrat|api|call|phone|customer|setup|security|privacy|latency|handoff|rollout|onboard|troubleshoot|mic|microphone|hang up|talk|conversation|brand)\b/i;

const OFF_TOPIC =
  /\b(weather|forecast|recipe|cook|sports|score|nba|nfl|mlb|homework|essay|president|election|politic|bitcoin|crypto|stock market|poem|joke|riddle|horoscope|translate this|write (a |me |code|an )|python|javascript function|math problem|girlfriend|boyfriend|therapy|medical advice|who won|tell me a story|meaning of life)\b/i;

export function isOffTopic(transcript: string): boolean {
  const text = transcript.trim();
  if (text.length < 12) return false;
  if (ON_TOPIC.test(text)) return false;
  return OFF_TOPIC.test(text);
}
