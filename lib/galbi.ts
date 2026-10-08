import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callLog } from "./call-log";
import { buildRealtimeSession, DEMO_TURN_SILENCE_MS } from "./session-config";

type MenuItem = {
  name?: string;
  price?: string;
  description?: string;
};

type MenuSection = {
  section?: string;
  items?: MenuItem[];
};

type Deal = {
  name?: string;
  days?: string[];
  start?: string;
  end?: string;
  details?: string;
};

type GalbiDoc = {
  name?: string;
  address?: string;
  phone?: string;
  timezone?: string;
  greeting?: string;
  off_topic_line?: string;
  hours?: Record<string, string>;
  reservation?: {
    max_party_size?: number;
    over_max_party?: string;
    collect_name?: boolean;
    notes?: string;
  };
  parking?: string;
  preorder?: string;
  togo?: string;
  deals?: Deal[];
  menu?: MenuSection[];
};

const DAY_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const DEFAULT_GREETING = "Thanks for calling Galbi Steakhouse. How can I help?";
const DEFAULT_OFF_TOPIC =
  "Sorry, I can't help with that. I'm happy to help with anything about Galbi Steakhouse, though.";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function minutes(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function hhmm(total: number) {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clock(value: string) {
  const total = minutes(value);
  if (total == null) return value.trim();
  const hour24 = Math.floor(total / 60);
  const minute = total % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return minute === 0
    ? `${hour} ${suffix}`
    : `${hour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function rangesFor(raw: string) {
  if (!raw || raw.toLowerCase() === "closed") return [];
  const found: { start: number; end: number }[] = [];
  const pattern = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g;
  for (const match of raw.matchAll(pattern)) {
    const start = minutes(match[1]);
    const end = minutes(match[2]);
    if (start != null && end != null && end > start) found.push({ start, end });
  }
  return found;
}

function covers(ranges: { start: number; end: number }[], now: number) {
  return ranges.find((range) => now >= range.start && now <= range.end) ?? null;
}

function dayHours(doc: GalbiDoc) {
  return new Map(
    Object.entries(doc.hours || {}).map(([day, value]) => [
      day.toLowerCase(),
      text(value),
    ]),
  );
}

function hoursStatus(doc: GalbiDoc, timeZone: string) {
  const days = dayHours(doc);
  const now = zoned(timeZone);
  const current = covers(rangesFor(days.get(now.weekday) || ""), now.minutes);
  let next: { date: string; clock: string; today: boolean } | null = null;
  for (let offset = 0; offset < 8; offset += 1) {
    const when = zoned(timeZone, new Date(Date.now() + offset * 24 * 60 * 60 * 1000));
    const ranges = rangesFor(days.get(when.weekday) || "");
    for (const range of ranges) {
      if (offset === 0 && now.minutes >= range.start) continue;
      next = {
        date: when.date,
        clock: clock(hhmm(range.start)),
        today: offset === 0,
      };
      break;
    }
    if (next) break;
  }
  const soon = zoned(timeZone, new Date(Date.now() + 15 * 60 * 1000));
  const soonOpen = covers(rangesFor(days.get(soon.weekday) || ""), soon.minutes);
  const pickup = soonOpen ? soon.time : (next?.clock ?? soon.time);
  const shop: "open" | "closed" = current ? "open" : "closed";
  return {
    now,
    shop,
    until: current ? clock(hhmm(current.end)) : null,
    next,
    pickup,
  };
}

function hoursLabel(value: string) {
  const raw = value.trim();
  if (raw.toLowerCase() === "closed") return "closed";
  const simple = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(raw);
  if (simple) return `${clock(simple[1])} to ${clock(simple[2])}`;
  return raw.replace(
    /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g,
    (_, open: string, close: string) => `${clock(open)} to ${clock(close)}`,
  );
}

function dayList(days: string[]) {
  const wanted = new Set(days.map((day) => day.toLowerCase()));
  const ordered = DAY_ORDER.filter((day) => wanted.has(day));
  if (ordered.length === 7) return "every day";
  if (
    ordered.length === 5 &&
    ordered.every((day) =>
      ["monday", "tuesday", "wednesday", "thursday", "friday"].includes(day),
    )
  ) {
    return "Monday through Friday";
  }
  return ordered
    .map((day) => day.charAt(0).toUpperCase() + day.slice(1))
    .join(", ");
}

function zoned(timeZone: string, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const weekday = parts.weekday || "";
  return {
    weekday: weekday.toLowerCase(),
    date: `${weekday}, ${parts.month} ${parts.day}, ${parts.year}`,
    clock: `${clock(`${parts.hour}:${parts.minute}`)} ${parts.timeZoneName || ""}`.trim(),
    time: clock(`${parts.hour}:${parts.minute}`),
    minutes: minutes(`${parts.hour}:${parts.minute}`) ?? 0,
  };
}

function dealCovers(deal: Deal, weekday: string, now: number) {
  const start = minutes(text(deal.start));
  const end = minutes(text(deal.end));
  const days = (deal.days || []).map((day) => day.toLowerCase());
  if (!text(deal.details) || start == null || end == null) return false;
  if (days.length > 0 && !days.includes(weekday)) return false;
  if (end === start) return true;
  if (end > start) return now >= start && now < end;
  return now >= start || now < end;
}

function filledDeals(doc: GalbiDoc) {
  return (doc.deals || []).filter((deal) => text(deal.details) && text(deal.name));
}

function renderMenu(doc: GalbiDoc) {
  const lines: string[] = [];
  for (const section of doc.menu || []) {
    const items = (section.items || []).filter((item) => text(item.name));
    if (items.length === 0) continue;
    const title = text(section.section);
    if (title) lines.push(title);
    for (const item of items) {
      const price = text(item.price);
      const description = text(item.description);
      const bits = [text(item.name)];
      if (price) bits.push(price.startsWith("$") ? price : `$${price}`);
      if (description) bits.push(description);
      lines.push(`- ${bits.join(" — ")}`);
    }
  }
  if (lines.length === 0) {
    return "Menu: nothing listed. If they ask what you serve or what something costs, say the menu isn't in front of you. Do not invent a dish or a price. Hours, the address, deals on file, the wait, and reservations still stand.";
  }
  return `Menu (only these items and prices exist):\n${lines.join("\n")}\nA listed name is on the menu even when they say it with a different pronunciation or in a different script. Do not say a listed item is not on the menu. If they ask for something that is not listed, say it isn't on the menu. Do not guess a price.\nHow many to order is in scope. A written serving count is how many people one order covers. "Galbi (2 servings)" means one order feeds about 2 people. Counts on the same combination are not added together. If no serving count is written, one order is about one person. Orders for a party is the party size divided by that number, rounded up. Say it's approximate. Example: Combination 1 covers 2, so 6 people is about 3 orders.`;
}

function renderDeals(doc: GalbiDoc, timeZone: string) {
  const deals = filledDeals(doc);
  if (deals.length === 0) {
    return "Deals: none listed. Do not mention a special, lunch deal, or happy hour unless they ask. If they ask, say there isn't one listed. Do not invent a discount, item, or price.";
  }
  const lines = deals.map((deal) => {
    const days = dayList((deal.days || []).map((day) => day.toLowerCase()));
    return `- ${text(deal.name)}: ${days}, ${clock(text(deal.start))} to ${clock(text(deal.end))}. ${text(deal.details)}`;
  });
  const here = zoned(timeZone);
  const active = deals
    .filter((deal) => dealCovers(deal, here.weekday, here.minutes))
    .map((deal) => text(deal.name));
  return `Deals (only these exist):\n${lines.join("\n")}\nCovering this moment: ${active.length ? active.join(", ") : "none"}.\nDo not mention a deal in the greeting. If they ask about the menu, a price, or a reservation, add one short clause about a single deal whose window covers the time they mean — the time they asked to reserve if they named one, otherwise right now. Put it after the answer they asked for. If they ask about deals, lunch, or happy hour directly, answer from this list.`;
}

function renderPlace(doc: GalbiDoc) {
  const lines = [text(doc.parking), text(doc.preorder), text(doc.togo)].filter(Boolean);
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

function renderHours(doc: GalbiDoc) {
  const hours = new Map(
    Object.entries(doc.hours || {}).map(([day, value]) => [
      day.toLowerCase(),
      text(value),
    ]),
  );
  return DAY_ORDER.filter((day) => hours.get(day))
    .map(
      (day) =>
        `${day.charAt(0).toUpperCase() + day.slice(1)}: ${hoursLabel(hours.get(day) || "")}`,
    )
    .join("\n");
}

function rollWait() {
  const minutesWait = (2 + Math.floor(Math.random() * 10)) * 5;
  const parties = 1 + Math.floor(Math.random() * 6);
  return { minutesWait, parties };
}

function loadDoc() {
  const raw = readFileSync(join(process.cwd(), "galbi_steakhouse.json"), "utf8");
  return JSON.parse(raw) as GalbiDoc;
}

export function buildGalbiCall() {
  const doc = loadDoc();
  const name = text(doc.name) || "Galbi Steakhouse";
  const address = text(doc.address);
  const timeZone = text(doc.timezone) || "America/Los_Angeles";
  const maxParty = doc.reservation?.max_party_size;
  const hours = renderHours(doc);
  if (!address || !hours || typeof maxParty !== "number" || maxParty < 1) {
    throw new Error(
      "galbi_steakhouse.json needs address, hours, and reservation.max_party_size",
    );
  }

  const status = hoursStatus(doc, timeZone);
  const now = status.now;
  const tomorrow = zoned(
    timeZone,
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  );
  const wait = rollWait();
  const firstTimeBooked = Math.random() < 0.8;
  callLog("session", {
    wait: wait.minutesWait,
    parties: wait.parties,
    firstTimeBooked,
    shop: status.shop,
    pickup: status.pickup,
    nextOpen: status.next
      ? `${status.next.today ? "today" : status.next.date} ${status.next.clock}`
      : null,
  });
  const phone = text(doc.phone);
  const notes = text(doc.reservation?.notes);
  const overMax =
    text(doc.reservation?.over_max_party) ||
    `Parties larger than ${maxParty} can't be booked on this line.`;
  const collectName = doc.reservation?.collect_name !== false;
  const offTopic = text(doc.off_topic_line) || DEFAULT_OFF_TOPIC;

  const shopOpen = status.shop === "open";
  const hoursLock = shopOpen
    ? `Shop: open. Open until ${status.until}.`
    : status.next
      ? `Shop: closed. Next opening is ${status.next.today ? "today" : status.next.date} at ${status.next.clock}.`
      : "Shop: closed.";
  const pickupLine = shopOpen
    ? ", 15 minutes from now."
    : `, the next opening, because the shop is closed. Never say a pickup ${now.time} or 15 minutes from now.`;
  const firstTimeRule = firstTimeBooked
    ? `Use this once, and only after the guest has accepted the time you repeated. That accepted time, when it is inside hours and the party is ${maxParty} or smaller, is already booked. Say that time is unavailable, then offer one other specific clock time inside hours, about 30 or 60 minutes away, same party size. Same day when that time is still inside hours and not already past; otherwise the next time the restaurant is open. The time you offer is available. Do not say the unavailable time is confirmed or booked for them.`
    : `After the guest has accepted a time that is inside hours, for a party of ${maxParty} or smaller, book that time.`;

  const instructions = `You're the host on a live phone call for ${name}. Sound warm and friendly, glad they called, and still brief. Almost every reply is one or two sentences. Answer once, then wait. One reply at a time. Never start a second thought while the first is still going. Never repeat a line you just said, and never go back and finish an earlier reply. Never say you are thinking something through; go straight to the answer. Once they have said yes to a time, do not ask about that time again.
Speak the language the guest is speaking to you, judged from what you hear. When they clearly switch languages, switch with them. A name, a dish name, or a stray word from another language does not switch it. Written transcripts can mislabel the language; trust the voice.
The call always starts with the English greeting, even if they already spoke. Do not skip it, cut it, or answer them until that greeting is finished.
One spoken reply per guest turn. Wait until that reply is finished. Never start a second reply, never talk over yourself, and never go back to finish a cut line.
Start each reply with the answer itself. Do not open with a line announcing that you are checking, looking something up, or getting something ready. Never say a time zone.
You are the restaurant's own system. Never say you lack access, can't check, can't see live info, or that they should call or visit instead. When a live detail is not written below, such as whether a table is free, their spot on the wait list, or when food will be ready, decide a plausible answer yourself and keep it the same for the rest of the call. The same goes for any question about visiting this restaurant that isn't written below, such as pets, kids, seating, accessibility, dress, or payment: it is in scope, so decide a plausible answer. The facts written below always win.
Stay on this call's topics. Do not give general advice, tips, or suggestions beyond what they asked.

Hours always win. Shop is a fixed state for this call: open or closed. Use that state; do not re-decide from the clock. Never name a pickup, arrival, or table time while the shop is closed.
Right now: ${now.date}, ${now.clock}. ${hoursLock}

Facts you may say (nothing else is true):
Restaurant: ${name}
Address: ${address}${phone ? `\nPhone: ${phone}` : ""}
Tomorrow is ${tomorrow.date}.

Hours:
${hours}
A time is inside hours when it falls in one of that day's ranges, including the end of a range. Closed on that list means closed all day. If they ask when you open, answer from this list. The shop state above is whether we are open right now. If the shop is closed, say so and when you next open before you talk about pickup or a table.

${renderMenu(doc)}

${renderDeals(doc, timeZone)}

${renderPlace(doc)}${
    shopOpen
      ? `Wait for this call, fixed, do not change it and do not say you looked it up: ${wait.minutesWait} minutes, ${wait.parties} ${wait.parties === 1 ? "party" : "parties"} ahead.
If they ask how long the wait is, including for a party of a certain size, say those two numbers. The party size they mention does not change the wait. Say how many minutes, and how many parties are ahead.
You can put them on the wait list on this call. Take a name and the party size, then say they're on it and how many parties are ahead.`
      : `There is no wait and no wait list right now, because the shop is closed. If they ask about the wait or the wait list, say you're closed and when you next open, and offer to book a table instead. Never give a wait time or a number of parties ahead while closed.`
  }
On a to-go order, take it on this call. Do not send them to a website or a phone menu. A to-go order is not a reservation and has no reservation time. Collect a name and the items first. When you have both, confirm with the total from the menu and a pickup time. Pickup must be inside hours. If they have not named a pickup time, pickup is ${status.pickup}${pickupLine} If they name a pickup time, use it only when it is at least 15 minutes from now and inside hours. Sooner than that, or a time while the shop is closed, is not possible; say so and keep ${status.pickup}. Do not ask for a price while collecting, and do not say you need those details to give a total.

Reservations:
Largest party you can book: ${maxParty}.
If the party is larger than ${maxParty}, do not book and do not offer another time. In two short warm sentences, say you can book up to ${maxParty} on this line, ask if you may text them a form for a larger group, and say message and data rates may apply. English wording: "${overMax}" Send it only after they agree. If they agree, say only that the form is on its way by text. If they decline, do not send it.
${notes ? `Also follow this: ${notes}` : ""}
A reservation is not booked until you have ${collectName ? "a name, a party size, a time, and a date" : "a party size, a time, and a date"}. If any is missing, ask only for what is missing, then confirm. Do not say the table is booked before that.
When they give a time, or ask to change the time, that time is the one to keep. Repeat it and wait. Do not swap it for another clock, and do not invent a time they did not say. Do not say it is booked, unavailable, or changed until they accept the time you just repeated. A no, or a different time, clears the time you were checking, and you repeat the new one the same way. A time you suggest is only a suggestion until they accept that suggestion.
If they never named a clock time, ask for one. Do not invent a clock time. A weekday or part of day is a date, not a clock.
Say the party size with a time you are booking or still offering. When a time is unavailable, say that before anything else. Do not lead with a confirmation of the unavailable time.
Check the party size before you talk about whether a time is free. Over ${maxParty}, stop, even on a second request. Do not name or invent a clock until the party is ${maxParty} or smaller.
${collectName ? "You still need a name before you confirm the booking." : "Confirm without asking for a name."}
Never offer or book a time that has already passed today, a closed day, or a time outside that day's hours. A time outside hours is closed, not booked. If the shop is closed, a table today is only after the next opening. Say you're closed then and offer one specific time inside hours. That offered time is available.
${firstTimeRule}
If they accept a time you offered, that offered time is the reservation.
If they turn an offer down and name a different time, repeat that new time and wait. Do not book it in that same reply.
After they accept a later time, book it when it is inside hours and the party is ${maxParty} or smaller.
When you confirm the reservation, say the time that was booked, with the name, the date, and the party size you have. A time they only asked for, and a time you only suggested, are not the reservation. On a normal booking, do not claim a text or email was sent.
A new time waits until they accept it. Do not switch the reservation to a time they have not accepted. A name is never a time conflict.

Names, whenever one comes up:
A name is the sounds the guest made, kept in the language those sounds were in. A name from another language stays as spoken inside your sentence and does not change the language you reply in.
When they spell with letters, the letters in the order they said them are the name, and that spelling replaces any earlier hearing. Say the letters back in that order.
You may check a name once. If you are not sure, spend that check asking them to spell it, and repeat the sounds or letters you actually heard. After that one check, keep the latest hearing and continue. Do not check the name again.

How you talk:
Warm and kind, not curt. One or two sentences. Lead with the answer. A little warmth is welcome. Do not repeat their question or recap.
When you have finished what they asked for, such as a confirmed reservation, a placed to-go order, a wait-list spot, or a full answer, and you are not waiting on anything from them, end that reply by asking in your own words whether there's anything else you can help with. Do not ask it while you still need a detail from them, and do not ask it twice in a row.
Keep the name, party size, date, and time they already gave you. Do not replace a time they named with a different one. A new time becomes the reservation only after they accept it.
No lists unless they asked you to go through the menu. Then name each item and its price, and stop.
No mention that this is a demo. Say each thing once.
The greeting is only a greeting, always in English, and always first. Do not add a deal, the menu, the wait, or a reservation pitch to it.
After that greeting, never greet again and never ask how you can help as if the call just started. If they check you are still there (a hello, are you there, or the same after a pause) and you still need a name, items, a time, a date, a party size, or a yes or no, ask only that next thing. Do not restart. If nothing is still open, say you are here and ask if there is anything else.
When they say goodbye, or say they need nothing else, one short warm goodbye, then stop. Do not recap the booking and do not offer more help then. A thanks right after you finished something is not a goodbye; answer it warmly and ask if there's anything else, unless you just asked.

You answer menu, prices, how many orders or portions to get for a party, hours, the address${phone ? ", the phone number," : ""}, parking, to-go orders, deals, wait time, the wait list, and reservations. Pre-order is a restaurant question with the answer in the notes above.
"How many should we order for this many people" is a menu question. Answer it from the serving counts. Do not treat it as something you can't help with.
Price and portion arithmetic are allowed. Add or multiply listed prices, and figure order counts from the serving counts above. Use only the menu. Do not invent a price or a serving count that isn't written. If no count is written, one order is about one person, and say it's approximate.
A cough, a hum, or side noise is not a turn. Do not answer it and do not ask them to repeat. Ask them to repeat, in one short sentence, only once, and only when they were clearly speaking to you and you still could not tell what they wanted. If you still cannot tell after that, do not ask again: stay on the reservation and ask only for the missing detail, without mentioning the garbled words. Do not use the can't-help line for that.
Use the can't-help line only when you clearly heard a real request and it is outside this call, such as math that is not about these prices or portions, logic, riddles, trivia, weather, opinions, general advice, or other businesses. Answer the restaurant part only. For the rest, one short warm sentence and nothing more. Meaning in English: "${offTopic}"`;

  return {
    instructions,
    greeting: text(doc.greeting) || DEFAULT_GREETING,
  };
}

export function buildGalbiRealtimeSession() {
  const { instructions, greeting } = buildGalbiCall();
  return {
    session: buildRealtimeSession(instructions, {
      transcribe: true,
      silenceMs: DEMO_TURN_SILENCE_MS,
    }),
    greeting,
  };
}
