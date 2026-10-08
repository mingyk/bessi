import { getOpenAIKey } from "./openai-key";
import type { BookingSheet, BookingUpdate } from "./booking-sheet";
import type { DialogueLine } from "./turn-decision";

const NONE_UPDATE: BookingUpdate = {
  intent: "none",
  time: null,
  party: null,
  date: null,
  name: null,
};

const GUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    about: { type: "string", enum: ["reservation", "togo", "other"] },
    intent: { type: "string", enum: ["propose", "accept", "reject", "none"] },
    time: { type: ["string", "null"] },
    party: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    name: { type: ["string", "null"] },
  },
  required: ["about", "intent", "time", "party", "date", "name"],
} as const;

const HOST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    offer: { type: ["string", "null"] },
    booked: { type: ["string", "null"] },
  },
  required: ["offer", "booked"],
} as const;

function blank(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length ? text : null;
}

const CLOCK =
  /\b((?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)|(?:[01]?\d|2[0-3]):[0-5]\d|noon|midnight|(?:1[0-2]|0?[1-9])\s*o'?clock)\b/i;
const PARTY =
  /\b(?:party|table|group)\s+(?:of|for)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s*(?:people|person|guests?)\b/i;
const DAY =
  /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const WORD_CLOCK =
  /\b((?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s*o'?clock|\s*(?:a\.?m\.?|p\.?m\.?)))\b/i;
const AT_CLOCK =
  /\bat\s+((?:1[0-2]|0?[1-9]|2[0-3]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::[0-5]\d)?(?:\s*(?:a\.?m\.?|p\.?m\.?))?)\b/i;

export function clockTime(value: string | null | undefined) {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;
  const match = CLOCK.exec(text) ?? WORD_CLOCK.exec(text) ?? AT_CLOCK.exec(text);
  if (!match) return null;
  return match[1].replace(/\s+/g, " ");
}

function dayWord(value: string | null | undefined) {
  if (!value) return null;
  const match = DAY.exec(value);
  return match ? match[1] : null;
}

function partySize(value: string | null | undefined) {
  if (!value) return null;
  const match = PARTY.exec(value);
  return match ? (match[1] || match[2] || null) : null;
}

function saidName(value: unknown, latest: string) {
  const name = blank(value)?.replace(/[\s.,!?;:]+$/u, "");
  if (!name) return null;
  return latest.toLowerCase().includes(name.toLowerCase()) ? name : null;
}

function guestUpdate(value: unknown, latest: string): BookingUpdate {
  if (!value || typeof value !== "object") {
    return fallbackGuest(latest);
  }
  const row = value as {
    about?: unknown;
    intent?: unknown;
    time?: unknown;
    party?: unknown;
    date?: unknown;
    name?: unknown;
  };
  if (row.about !== "reservation") return NONE_UPDATE;
  const clock = clockTime(latest);
  const party = partySize(latest);
  const date = dayWord(latest);
  const intent: BookingUpdate["intent"] =
    row.intent === "propose" || row.intent === "accept" || row.intent === "reject"
      ? row.intent
      : "none";
  const time = clock ?? clockTime(blank(row.time));
  const namedParty = blank(row.party) ?? party;
  let namedDate = date ?? dayWord(blank(row.date));
  const shifted = dayWord(blank(row.time));
  if (!time && shifted) namedDate = namedDate ?? shifted;
  const name = saidName(row.name, latest);

  if (clock) {
    return {
      intent: "propose",
      time: clock,
      party: namedParty,
      date: namedDate,
      name,
    };
  }
  if (intent === "accept" || intent === "none") {
    if (namedParty || namedDate || name) {
      return {
        intent: "propose",
        time: null,
        party: namedParty,
        date: namedDate,
        name,
      };
    }
    return { intent, time: null, party: null, date: null, name: null };
  }
  if (intent === "reject") {
    return { intent: "reject", time: null, party: null, date: null, name: null };
  }
  return {
    intent: "propose",
    time,
    party: namedParty,
    date: namedDate,
    name,
  };
}

async function complete(
  schemaName: string,
  schema: object,
  instructions: string,
  payload: unknown,
  timeoutMs = 800,
) {
  const key = await getOpenAIKey();
  if (!key) return null;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: JSON.stringify(payload) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return JSON.parse(content) as unknown;
}

export async function extractGuestBooking(input: {
  latest: string;
  history: DialogueLine[];
  sheet: BookingSheet;
}): Promise<BookingUpdate | null> {
  const latest = input.latest.trim();
  if (!latest) return null;
  try {
    const parsed = await complete(
      "guest_booking",
      GUEST_SCHEMA,
      `Read the latest guest line against the booking sheet.
about: reservation when the latest line, read with the earlier lines, is about booking a table. togo when it is about a to-go order, including its pickup time. other for anything else.
time is a clock they spoke: an hour with minutes or an am/pm. A weekday or part of day is date, never time. An order, a menu item, a form, or a party size is never a time.
Copy a time, party size, date, or name only when that line says one, using the words in the line. When they correct themselves inside the line, copy the value they end on. Do not invent a clock.
intent propose: they give or change a clock time, party size, date, or name. A refusal that includes a replacement clock is propose. A line that names a clock is propose even if they also say they want to keep something.
intent accept: they agree to the pending or offered clock and do not name a different clock.
intent reject: they refuse that clock and do not name a replacement.
intent none: hesitation, a line that is not about the reservation clock, or anything else. Hesitation is never accept or reject.
On accept or a bare reject, leave time, party, date, and name null.`,
      {
        sheet: input.sheet,
        earlier: input.history.slice(-4),
        latest,
      },
    );
    return guestUpdate(parsed, latest);
  } catch {
    return fallbackGuest(latest);
  }
}

function fallbackGuest(latest: string): BookingUpdate {
  const time = clockTime(latest);
  const party = partySize(latest);
  const date = dayWord(latest);
  if (!time && !party && !date) return NONE_UPDATE;
  return {
    intent: "propose",
    time,
    party,
    date,
    name: null,
  };
}

export async function extractHostBooking(input: {
  latest: string;
  sheet: BookingSheet;
}): Promise<{ offer: string | null; booked: string | null } | null> {
  const latest = input.latest.trim();
  if (!latest) return null;
  try {
    const parsed = await complete(
      "host_booking",
      HOST_SCHEMA,
      `Read the latest host line against the booking sheet.
offer and booked are clocks the host spoke about a table reservation. A to-go pickup time, an order, a form, a menu item, or a party size is never either field.
offer is a new clock the host suggests. booked is a clock the host actually gives as the reservation.
Repeating the pending time while waiting for a yes is neither. A time the host says is unavailable is never booked.
Leave a field null when the line has no clock.`,
      { sheet: input.sheet, latest },
      1400,
    );
    if (!parsed || typeof parsed !== "object") return null;
    const row = parsed as { offer?: unknown; booked?: unknown };
    return {
      offer: clockTime(blank(row.offer)),
      booked: clockTime(blank(row.booked)),
    };
  } catch {
    return null;
  }
}
