import { callLog } from "./call-log";
import {
  DAY_ORDER,
  dayList,
  filledDeals,
  hoursSpoken,
  loadDoc,
  rangesFor,
  spokenClock,
  hhmmToMinutes,
  text,
  type GalbiDoc,
} from "./galbi-doc";
import { DESK_TOOLS, deskFacts, newDeskState } from "./host-desk";
import { buildRealtimeSession, DEMO_TURN_SILENCE_MS } from "./session-config";

const DEFAULT_GREETING = "Thanks for calling Galbi Steakhouse. How can I help?";
const DEFAULT_OFF_TOPIC =
  "Sorry, I can't help with that. I'm happy to help with anything about Galbi Steakhouse, though.";

function renderHours(doc: GalbiDoc) {
  return DAY_ORDER.filter((day) => text(doc.hours?.[day]))
    .map((day) => `${day.charAt(0).toUpperCase()}${day.slice(1)}: ${hoursSpoken(rangesFor(doc, day))}`)
    .join("\n");
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
    return "Menu: nothing listed. If they ask what you serve or what something costs, say the menu isn't in front of you.";
  }
  return `Menu (only these items and prices exist):
${lines.join("\n")}
A listed name is on the menu even when they say it with a different pronunciation or in a different script. A written serving count is how many people one order covers; with no count, one order is about one person. For how many to order, divide the party by that and round up, and say it's approximate.`;
}

function renderDeals(doc: GalbiDoc) {
  const deals = filledDeals(doc);
  if (deals.length === 0) return "Deals: none.";
  const lines = deals.map((deal) => {
    const start = hhmmToMinutes(text(deal.start));
    const end = hhmmToMinutes(text(deal.end));
    const window = start != null && end != null ? `${spokenClock(start)} to ${spokenClock(end)}` : "";
    return `- ${text(deal.name)}: ${dayList(deal.days || [])}${window ? `, ${window}` : ""}. ${text(deal.details)}`;
  });
  return `Deals (only these exist):\n${lines.join("\n")}`;
}

export function buildGalbiCall() {
  const doc = loadDoc();
  const name = text(doc.name) || "Galbi Steakhouse";
  const address = text(doc.address);
  const maxParty = doc.reservation?.max_party_size;
  const hours = renderHours(doc);
  if (!address || !hours || typeof maxParty !== "number" || maxParty < 1) {
    throw new Error("galbi_steakhouse.json needs address, hours, and reservation.max_party_size");
  }
  const facts = deskFacts(doc);
  const desk = newDeskState();
  const phone = text(doc.phone);
  const notes = text(doc.reservation?.notes);
  const overMax =
    text(doc.reservation?.over_max_party) ||
    `We can book parties up to ${maxParty} on this line. For a larger group, I can text you a short form.`;
  const collectName = doc.reservation?.collect_name !== false;
  const offTopic = text(doc.off_topic_line) || DEFAULT_OFF_TOPIC;
  const place = [text(doc.parking), text(doc.preorder)].filter(Boolean).join("\n");

  callLog("session", {
    wait: desk.wait.minutes,
    parties: desk.wait.parties,
    firstTaken: desk.firstTaken,
    open: facts.open,
    nextOpening: facts.nextOpening,
  });

  const instructions = `You're the host on a live phone call for ${name}. Warm, glad they called, and brief: usually one or two sentences. Lead with the answer. One reply per guest turn. Never repeat a line, and never go back to finish a cut line. Never say you are thinking, checking, or looking something up.
Speak the language you hear the guest speaking, and switch only when they clearly switch. A name or a dish name from another language does not switch it.
The call starts with the English greeting. After it, never greet again or ask how you can help as if the call just started. If they only check you are still there, pick the open task back up where it was.

Your desk tools are the restaurant's live system. They are the only source for tables, the wait, the wait list, pickup times, and totals. Whenever one of those comes up, call the tool right away, with no words before it, then say what it returned in your own words. Never decide availability, a wait, a pickup time, or a total yourself, and never contradict a tool. Keep the day when you say a time; you may say it short, like "tomorrow at 7:30".
Tables: you need the party size and a clock time, plus the day if they said one. Ask only for what is missing. When a table is available, say the slot back${collectName ? " and ask for a name" : ""}; book it once they say yes${collectName ? " and you have the name" : ""}. When a slot doesn't work, say why in a few words and offer what the tool offered. A booking stands until they change or cancel it.
Over ${maxParty} people: "${overMax}" Ask if you may text it, mention message and data rates may apply, and send it with text_party_form only after they agree.
To-go: take it on this call. Get a name and the items, then place the order and confirm the total and pickup time it returns.
For any other question about visiting (pets, kids, seating, accessibility, dress, payment), decide a plausible answer and keep it for the rest of the call. You are the restaurant's own system; never say you can't check or that they should call or visit.${notes ? `\n${notes}` : ""}

Right now: ${facts.today}, ${facts.now}. ${
    facts.open
      ? `We are open until ${facts.closesAt}.`
      : `We are closed right now. Next opening: ${facts.nextOpening}.`
  }
Restaurant: ${name}
Address: ${address}${phone ? `\nPhone: ${phone}` : ""}
Hours:
${hours}
${place ? `${place}\n` : ""}
${renderMenu(doc)}

${renderDeals(doc)}
Mention a deal only when it fits what they asked, in one short clause after the answer.

Names: a name is the sounds the guest made, kept as spoken. Spelled letters win over an earlier hearing. Check a name at most once, then keep the latest hearing.
When you finish what they asked and nothing is pending, ask in your own words if there's anything else, but not twice in a row. When they say goodbye or need nothing else, one short warm goodbye.
A cough, a hum, or side noise is not a turn. Ask them to repeat at most once. For a clear request outside this restaurant, say only, in their language: "${offTopic}"`;

  return {
    instructions,
    greeting: text(doc.greeting) || DEFAULT_GREETING,
    tools: DESK_TOOLS,
    desk,
  };
}

export function buildGalbiRealtimeSession() {
  const { instructions, greeting, tools, desk } = buildGalbiCall();
  return {
    session: buildRealtimeSession(instructions, {
      transcribe: true,
      silenceMs: DEMO_TURN_SILENCE_MS,
      tools,
    }),
    greeting,
    desk,
  };
}
