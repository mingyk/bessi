import {
  dayAt,
  dealAt,
  hhmm,
  hoursSpoken,
  localNow,
  menuItems,
  monthIndex,
  rangesFor,
  spokenClock,
  text,
  timeZoneOf,
  zonedIso,
  type Day,
  type GalbiDoc,
} from "./galbi-doc";
import { ConnectorError, type Connectors } from "./connectors/types";
import { sendSms } from "./sms";

const PREP_MINUTES = 15;
const LAST_SEAT_MINUTES = 30;
const SEARCH_DAYS = 8;
const FIRST_TAKEN_ODDS = 0.8;

type Booking = { key: string; minute: number; party: number; name: string };

export type DeskState = {
  wait: { minutes: number; parties: number };
  firstTaken: boolean;
  firstUsed: boolean;
  taken: string[];
  cleared: string[];
  booking: Booking | null;
  waitlist: { name: string; party: number } | null;
  order: { name: string; total: string; pickup: string } | null;
  formSent: boolean;
};

export function newDeskState(): DeskState {
  return {
    wait: {
      minutes: (2 + Math.floor(Math.random() * 10)) * 5,
      parties: 1 + Math.floor(Math.random() * 6),
    },
    firstTaken: Math.random() < FIRST_TAKEN_ODDS,
    firstUsed: false,
    taken: [],
    cleared: [],
    booking: null,
    waitlist: null,
    order: null,
    formSent: false,
  };
}

export function readDeskState(value: unknown): DeskState {
  const base = newDeskState();
  if (!value || typeof value !== "object") return base;
  const row = value as Partial<DeskState>;
  return {
    wait:
      row.wait && typeof row.wait.minutes === "number" && typeof row.wait.parties === "number"
        ? { minutes: row.wait.minutes, parties: row.wait.parties }
        : base.wait,
    firstTaken: typeof row.firstTaken === "boolean" ? row.firstTaken : base.firstTaken,
    firstUsed: row.firstUsed === true,
    taken: Array.isArray(row.taken) ? row.taken.filter((key) => typeof key === "string") : [],
    cleared: Array.isArray(row.cleared) ? row.cleared.filter((key) => typeof key === "string") : [],
    booking:
      row.booking && typeof row.booking.key === "string" && typeof row.booking.minute === "number"
        ? row.booking
        : null,
    waitlist: row.waitlist ?? null,
    order: row.order ?? null,
    formSent: row.formSent === true,
  };
}

type Block = { start: number; end: number };

type Clock = { minute: number; exact: boolean; vague: boolean };

class Desk {
  readonly doc: GalbiDoc;
  readonly today: { year: number; month: number; day: number };
  readonly nowMinute: number;
  readonly maxParty: number;
  readonly collectName: boolean;

  constructor(doc: GalbiDoc, at = Date.now()) {
    this.doc = doc;
    const now = localNow(timeZoneOf(doc), at);
    this.today = { year: now.year, month: now.month, day: now.day };
    this.nowMinute = now.minute;
    this.maxParty = doc.reservation?.max_party_size ?? 8;
    this.collectName = doc.reservation?.collect_name !== false;
  }

  day(offset: number): Day {
    return dayAt(this.today, offset);
  }

  dayFromKey(key: string): Day | null {
    for (let offset = 0; offset < 400; offset += 1) {
      const day = this.day(offset);
      if (day.key === key) return day;
    }
    return null;
  }

  blocks(day: Day): Block[] {
    const merged: Block[] = [];
    for (const range of rangesFor(this.doc, day.weekday)) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ start: range.start, end: range.end });
    }
    return merged;
  }

  openNow() {
    return this.blocks(this.day(0)).some(
      (block) => this.nowMinute >= block.start && this.nowMinute < block.end,
    );
  }

  closesAt() {
    const block = this.blocks(this.day(0)).find(
      (item) => this.nowMinute >= item.start && this.nowMinute < item.end,
    );
    return block ? spokenClock(block.end) : null;
  }

  nextOpening() {
    for (let offset = 0; offset < SEARCH_DAYS; offset += 1) {
      const day = this.day(offset);
      for (const block of this.blocks(day)) {
        if (offset === 0 && block.start <= this.nowMinute) continue;
        return { day, minute: block.start };
      }
    }
    return null;
  }

  spokenDay(day: Day, minute?: number) {
    if (day.offset === 0) return minute != null && minute >= 17 * 60 ? `tonight, ${day.long}` : `today, ${day.long}`;
    if (day.offset === 1) return `tomorrow, ${day.long}`;
    return day.long;
  }

  spokenSlot(day: Day, minute: number) {
    return `${this.spokenDay(day, minute)}, at ${spokenClock(minute)}`;
  }

  key(day: Day, minute: number) {
    return `${day.key} ${hhmm(minute)}`;
  }

  parseDay(input: unknown): number | null | "unknown" {
    const said = text(input).toLowerCase();
    if (!said || /^(any|whenever|none|null|not said|unspecified)$/.test(said)) return null;
    if (/day after tomorrow/.test(said)) return 2;
    if (/\btomorrow\b/.test(said)) return 1;
    if (/\b(today|tonight|this (morning|afternoon|evening)|now)\b/.test(said)) return 0;
    const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(said);
    if (iso) return this.offsetTo(Number(iso[1]), Number(iso[2]), Number(iso[3]), false);
    const monthFirst = /\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(said);
    if (monthFirst && monthIndex(monthFirst[1]) >= 0) {
      return this.offsetTo(this.today.year, monthIndex(monthFirst[1]) + 1, Number(monthFirst[2]), true);
    }
    const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\b/.exec(said);
    if (dayFirst && monthIndex(dayFirst[2]) >= 0) {
      return this.offsetTo(this.today.year, monthIndex(dayFirst[2]) + 1, Number(dayFirst[1]), true);
    }
    const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(said);
    if (slash) return this.offsetTo(this.today.year, Number(slash[1]), Number(slash[2]), true);
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const named = names.findIndex((name) => said.includes(name) || said.includes(name.slice(0, 3)));
    if (named >= 0) {
      const todayIndex = names.indexOf(this.day(0).weekday);
      let offset = (named - todayIndex + 7) % 7;
      if (offset === 0 && /\bnext\b/.test(said)) offset = 7;
      return offset;
    }
    return "unknown";
  }

  offsetTo(year: number, month: number, date: number, rollYear: boolean) {
    const base = Date.UTC(this.today.year, this.today.month - 1, this.today.day);
    let offset = Math.round((Date.UTC(year, month - 1, date) - base) / 86_400_000);
    if (offset < 0 && rollYear) {
      offset = Math.round((Date.UTC(year + 1, month - 1, date) - base) / 86_400_000);
    }
    return offset < 0 ? "unknown" : offset;
  }

  parseClock(input: unknown): Clock | null {
    let said = text(input).toLowerCase();
    if (!said) return null;
    said = said
      .replace(/\b([ap])\.?\s?m\.?/g, "$1m")
      .replace(/o'?\s?clock/g, "")
      .replace(/-/g, " ");
    if (/\bnoon\b|\bmidday\b/.test(said)) return { minute: 12 * 60, exact: true, vague: false };
    if (/\bmidnight\b/.test(said)) return { minute: 0, exact: true, vague: false };
    const words: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    };
    said = said.replace(/\b(twenty|forty|fifty) (one|two|three|four|five|six|seven|eight|nine)\b/g, (_, tens: string, ones: string) =>
      String(words[tens] + words[ones]),
    );
    said = said.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)\b/g, (word) =>
      String(words[word]),
    );
    said = said.replace(/\b(\d{1,2}) (?:oh |o )?(\d{1,2})\b/g, (whole, hour: string, minute: string) => {
      const value = Number(minute);
      return Number(hour) <= 12 && value < 60 && (minute.length === 2 || value >= 10) ? `${hour}:${minute.padStart(2, "0")}` : whole;
    });
    let match = /\bhalf past (\d{1,2})\b/.exec(said);
    if (match) said = said.replace(match[0], `${match[1]}:30`);
    match = /\bquarter past (\d{1,2})\b/.exec(said);
    if (match) said = said.replace(match[0], `${match[1]}:15`);
    match = /\bquarter (?:to|till|of) (\d{1,2})\b/.exec(said);
    if (match) said = said.replace(match[0], `${(Number(match[1]) + 10) % 12 + 1}:45`);

    const clock = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(said);
    const compact = /\b(\d{3,4})\s*(am|pm)?\b/.exec(said);
    let hour: number | null = null;
    let minute = 0;
    let half: string | undefined;
    if (compact && !clock?.[2]) {
      const digits = compact[1];
      hour = Number(digits.slice(0, digits.length - 2));
      minute = Number(digits.slice(-2));
      half = compact[2];
    } else if (clock) {
      hour = Number(clock[1]);
      minute = Number(clock[2] ?? 0);
      half = clock[3];
    }
    if (hour != null && hour <= 23 && minute < 60) {
      if (half === "pm" && hour < 12) hour += 12;
      if (half === "am" && hour === 12) hour = 0;
      const exact = Boolean(half) || hour === 0 || hour > 12;
      return { minute: hour * 60 + minute, exact, vague: false };
    }
    if (/\bbrunch\b/.test(said)) return { minute: 11 * 60 + 30, exact: true, vague: true };
    if (/\blunch/.test(said)) return { minute: 12 * 60 + 30, exact: true, vague: true };
    if (/\bafternoon\b/.test(said)) return { minute: 15 * 60, exact: true, vague: true };
    if (/\b(dinner|evening|tonight|night|supper)\b/.test(said)) return { minute: 19 * 60, exact: true, vague: true };
    if (/\bmorning\b/.test(said)) return { minute: 10 * 60, exact: true, vague: true };
    return null;
  }

  distanceToHours(day: Day, minute: number) {
    let best = Infinity;
    for (const block of this.blocks(day)) {
      if (minute >= block.start && minute <= block.end) return 0;
      best = Math.min(best, Math.abs(minute - block.start), Math.abs(minute - block.end));
    }
    return best;
  }

  placeClock(day: Day, clock: Clock) {
    if (clock.exact) return clock.minute;
    const hour = Math.floor(clock.minute / 60);
    const rest = clock.minute % 60;
    const morning = (hour % 12) * 60 + rest;
    const evening = ((hour % 12) + 12) * 60 + rest;
    return this.distanceToHours(day, morning) < this.distanceToHours(day, evening) ? morning : evening;
  }

  tableOk(day: Day, minute: number) {
    if (day.offset === 0 && minute <= this.nowMinute) return false;
    return this.blocks(day).some(
      (block) => minute >= block.start && minute <= block.end - LAST_SEAT_MINUTES,
    );
  }

  pickupOk(day: Day, minute: number) {
    if (day.offset === 0 && minute < this.nowMinute + PREP_MINUTES) return false;
    return this.blocks(day).some(
      (block) => minute - PREP_MINUTES >= block.start && minute <= block.end,
    );
  }

  tableGrid(day: Day) {
    const grid: number[] = [];
    for (const block of this.blocks(day)) {
      const first = Math.ceil(block.start / 30) * 30;
      if (block.start % 30 !== 0) grid.push(block.start);
      for (let minute = first; minute <= block.end - LAST_SEAT_MINUTES; minute += 30) grid.push(minute);
    }
    return grid.filter((minute) => this.tableOk(day, minute));
  }

  nearestTable(day: Day, minute: number, skip: Set<string>) {
    let best: number | null = null;
    for (const option of this.tableGrid(day)) {
      if (skip.has(this.key(day, option))) continue;
      if (
        best == null ||
        Math.abs(option - minute) < Math.abs(best - minute) ||
        (Math.abs(option - minute) === Math.abs(best - minute) && option > best)
      ) {
        best = option;
      }
    }
    return best;
  }

  sameClockLater(fromOffset: number, minute: number, ok: (day: Day, at: number) => boolean) {
    for (let offset = fromOffset; offset < fromOffset + SEARCH_DAYS; offset += 1) {
      const day = this.day(offset);
      if (ok(day, minute)) return day;
    }
    return null;
  }

  resolve(dayInput: unknown, timeInput: unknown) {
    const offset = this.parseDay(dayInput);
    if (offset === "unknown") return { problem: "day_unclear" as const };
    const clock = this.parseClock(timeInput);
    if (!clock) return { problem: "time_missing" as const };
    if (offset != null) {
      const day = this.day(offset);
      return { day, minute: this.placeClock(day, clock), clock, daySaid: true };
    }
    const today = this.day(0);
    const todayMinute = this.placeClock(today, clock);
    const todayLeft = this.blocks(today).some((block) => block.end > this.nowMinute);
    if (todayLeft && todayMinute > this.nowMinute) {
      return { day: today, minute: todayMinute, clock, daySaid: false };
    }
    for (let next = 1; next < SEARCH_DAYS; next += 1) {
      const day = this.day(next);
      if (this.blocks(day).length) return { day, minute: this.placeClock(day, clock), clock, daySaid: false };
    }
    return { day: today, minute: todayMinute, clock, daySaid: false };
  }

  whyNot(day: Day, minute: number) {
    if (day.offset === 0 && minute <= this.nowMinute) return "already_past";
    if (this.blocks(day).length === 0) return "closed_that_day";
    return "outside_hours";
  }
}

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

function partyOf(value: unknown) {
  const number = typeof value === "number" ? value : Number(text(value));
  return Number.isInteger(number) && number > 0 ? number : null;
}

function matchItem(doc: GalbiDoc, said: string) {
  const norm = (value: string) =>
    value.toLowerCase().replace(/\bcombo\b/g, "combination").replace(/[^a-z0-9]/g, "");
  const wanted = norm(said);
  if (!wanted) return null;
  const items = menuItems(doc);
  return (
    items.find((item) => norm(item.name) === wanted) ??
    items.find((item) => wanted.includes(norm(item.name)) || norm(item.name).includes(wanted)) ??
    null
  );
}

function priceList(doc: GalbiDoc, raw: unknown) {
  const rows = Array.isArray(raw) ? raw : [];
  const lines: { item: string; quantity: number; line_total: string }[] = [];
  const unknown: string[] = [];
  let total = 0;
  for (const row of rows) {
    const entry = row as { item?: unknown; quantity?: unknown };
    const said = text(entry.item);
    const quantity = partyOf(entry.quantity) ?? 1;
    const item = matchItem(doc, said);
    if (!item) {
      if (said) unknown.push(said);
      continue;
    }
    total += item.price * quantity;
    lines.push({ item: item.name, quantity, line_total: money(item.price * quantity) });
  }
  return { lines, unknown, total };
}

function tableAnswer(desk: Desk, state: DeskState, args: Record<string, unknown>, booking: boolean) {
  const party = partyOf(args.party);
  if (!party) return { result: "need_party_size" };
  if (party > desk.maxParty) {
    return { result: "party_too_large", max_party: desk.maxParty, form_already_sent: state.formSent };
  }
  const place = desk.resolve(args.day, args.time);
  if ("problem" in place) return { result: place.problem === "day_unclear" ? "need_day" : "need_time" };
  if (place.clock.vague) return { result: "need_time", heard: text(args.time) };
  const { day, minute } = place;
  const asked = desk.spokenSlot(day, minute);

  if (!desk.tableOk(day, minute)) {
    const why = desk.whyNot(day, minute);
    const options: string[] = [];
    if (why !== "closed_that_day") {
      const near = desk.nearestTable(day, minute, new Set(state.taken));
      if (near != null) options.push(desk.spokenSlot(day, near));
    }
    const later = desk.sameClockLater(day.offset + 1, minute, (next, at) => desk.tableOk(next, at));
    if (later) options.push(desk.spokenSlot(later, minute));
    return {
      result: why,
      asked,
      hours_that_day: hoursSpoken(rangesFor(desk.doc, day.weekday)),
      options,
    };
  }

  const key = desk.key(day, minute);
  const cleared = state.cleared.includes(key);
  let taken = state.taken.includes(key);
  if (!taken && !cleared && state.firstTaken && !state.firstUsed) {
    state.firstUsed = true;
    state.taken.push(key);
    taken = true;
  }
  if (taken) {
    const skip = new Set(state.taken);
    const steps = [30, -30, 60, -60, 90, -90];
    let alternative: string | null = null;
    for (const step of steps) {
      const at = minute + step;
      if (desk.tableOk(day, at) && !skip.has(desk.key(day, at))) {
        alternative = desk.spokenSlot(day, at);
        state.cleared.push(desk.key(day, at));
        break;
      }
    }
    if (!alternative) {
      const later = desk.sameClockLater(day.offset + 1, minute, (next, at) => desk.tableOk(next, at) && !skip.has(desk.key(next, at)));
      if (later) {
        alternative = desk.spokenSlot(later, minute);
        state.cleared.push(desk.key(later, minute));
      }
    }
    return { result: "taken", asked, party, alternative };
  }
  if (!cleared) state.cleared.push(key);

  const deal = dealAt(desk.doc, day.weekday, minute);
  if (!booking) {
    return {
      result: "available",
      slot: asked,
      party,
      day_was_assumed: !place.daySaid,
      deal,
      already_booked: state.booking ? bookingSpoken(desk, state.booking) : null,
    };
  }

  const name = text(args.name);
  if (desk.collectName && !name) return { result: "need_name", slot: asked, party };
  const before = state.booking ? bookingSpoken(desk, state.booking) : null;
  state.booking = { key, minute, party, name };
  return {
    result: "booked",
    slot: asked,
    party,
    name: name || null,
    replaced: before,
    deal,
  };
}

function bookingSpoken(desk: Desk, booking: Booking) {
  const day = desk.dayFromKey(booking.key.split(" ")[0]);
  const slot = day ? desk.spokenSlot(day, booking.minute) : booking.key;
  return `${slot}, party of ${booking.party}${booking.name ? `, under ${booking.name}` : ""}`;
}

function typicalWait(weekday: string, minute: number) {
  const busyNight = weekday === "friday" || weekday === "saturday";
  if (minute >= 18 * 60 && minute < 20 * 60 + 30) return busyNight ? 40 : 25;
  if (minute >= 12 * 60 && minute < 13 * 60 + 30) return 15;
  if (minute >= 17 * 60 && minute < 21 * 60) return busyNight ? 20 : 10;
  return 5;
}

function waitAnswer(desk: Desk, state: DeskState, args: Record<string, unknown>) {
  const now = !text(args.time) && (!text(args.day) || desk.parseDay(args.day) === 0);
  if (now) {
    if (!desk.openNow()) {
      const next = desk.nextOpening();
      return {
        result: "closed_now",
        next_opening: next ? desk.spokenSlot(next.day, next.minute) : null,
      };
    }
    return {
      result: "wait_now",
      minutes: state.wait.minutes,
      parties_ahead: state.wait.parties,
      on_wait_list: state.waitlist ? state.waitlist.name : null,
    };
  }
  const place = desk.resolve(args.day, args.time || "dinner");
  if ("problem" in place) return { result: "need_day" };
  const { day, minute } = place;
  if (!desk.blocks(day).some((block) => minute >= block.start && minute <= block.end)) {
    return {
      result: desk.whyNot(day, minute),
      asked: desk.spokenSlot(day, minute),
      hours_that_day: hoursSpoken(rangesFor(desk.doc, day.weekday)),
    };
  }
  const booking = state.booking;
  const overlap =
    booking && booking.key.startsWith(day.key) && Math.abs(booking.minute - minute) <= 90
      ? bookingSpoken(desk, booking)
      : null;
  return {
    result: "typical_walk_in_wait",
    asked: desk.spokenSlot(day, minute),
    minutes: typicalWait(day.weekday, minute),
    their_reservation_then: overlap,
  };
}

function earliestPickup(desk: Desk) {
  for (let offset = 0; offset < SEARCH_DAYS; offset += 1) {
    const day = desk.day(offset);
    for (const block of desk.blocks(day)) {
      let minute = block.start + PREP_MINUTES;
      if (offset === 0) minute = Math.max(minute, Math.ceil((desk.nowMinute + PREP_MINUTES) / 5) * 5);
      if (minute <= block.end && desk.pickupOk(day, minute)) return { day, minute };
    }
  }
  return null;
}

function pickupAnswer(desk: Desk, args: Record<string, unknown>) {
  const earliest = earliestPickup(desk);
  const earliestSpoken = earliest ? desk.spokenSlot(earliest.day, earliest.minute) : null;
  if (!text(args.time)) {
    return { ok: true, pickup: earliestSpoken, open_now: desk.openNow() };
  }
  const place = desk.resolve(args.day, args.time);
  if ("problem" in place) return { ok: false, reason: place.problem, earliest: earliestSpoken };
  const { day, minute } = place;
  if (!desk.pickupOk(day, minute)) {
    const inside = desk.blocks(day).some((block) => minute >= block.start && minute <= block.end);
    const passed = day.offset === 0 && minute <= desk.nowMinute;
    const why = passed ? "already_past" : inside ? "kitchen_needs_15_minutes" : desk.whyNot(day, minute);
    return { ok: false, reason: why, asked: desk.spokenSlot(day, minute), earliest: earliestSpoken };
  }
  return { ok: true, pickup: desk.spokenSlot(day, minute), open_now: desk.openNow() };
}

export const DESK_TOOLS = [
  {
    type: "function",
    name: "check_table",
    description:
      "Check if a table is free. Call it once you know the party size and a clock time. Pass the day the guest said, or leave day empty if they did not say one. The result is the truth for that table.",
    parameters: {
      type: "object",
      properties: {
        party: { type: "integer", description: "Number of people." },
        day: { type: "string", description: "The day as the guest said it, like tonight, tomorrow, Friday, October 9. Empty if not said." },
        time: { type: "string", description: "The clock time as the guest said it, like 7, seven thirty, 6:30 pm." },
      },
      required: ["party", "time"],
    },
  },
  {
    type: "function",
    name: "book_table",
    description:
      "Book a table. Call it only after the guest said yes to a slot a tool gave you and you have their name. Pass that same slot.",
    parameters: {
      type: "object",
      properties: {
        party: { type: "integer" },
        day: { type: "string" },
        time: { type: "string" },
        name: { type: "string", description: "The name the table is under, as the guest said or spelled it." },
      },
      required: ["party", "day", "time", "name"],
    },
  },
  {
    type: "function",
    name: "cancel_table",
    description: "Cancel the table booked on this call, only when the guest asks to cancel it.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "check_wait",
    description:
      "Walk-in wait. Leave day and time empty for the wait right now. Pass a day or time when they ask about the wait at another time.",
    parameters: {
      type: "object",
      properties: {
        day: { type: "string" },
        time: { type: "string", description: "A clock time or a meal, like lunch or dinner." },
        party: { type: "integer", description: "Party size, if they said it." },
      },
    },
  },
  {
    type: "function",
    name: "join_wait_list",
    description: "Put the guest on the walk-in wait list for right now.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        party: { type: "integer" },
      },
      required: ["name", "party"],
    },
  },
  {
    type: "function",
    name: "pickup_time",
    description:
      "To-go pickup. Leave time empty for the earliest pickup, or pass the pickup time the guest asked for to check it.",
    parameters: {
      type: "object",
      properties: {
        day: { type: "string" },
        time: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "price_items",
    description: "Total for menu items. Use it for any price question that needs adding or multiplying.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string", description: "Menu item name." },
              quantity: { type: "integer" },
            },
            required: ["item", "quantity"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    type: "function",
    name: "place_togo_order",
    description:
      "Place a to-go order once you have a name and the items. Pass a pickup day and time only if the guest asked for one. Returns the total and the pickup time.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string" },
              quantity: { type: "integer" },
            },
            required: ["item", "quantity"],
          },
        },
        day: { type: "string" },
        time: { type: "string" },
      },
      required: ["name", "items"],
    },
  },
  {
    type: "function",
    name: "text_party_form",
    description: "Text the large-party form to the caller. Only after they agreed to get it.",
    parameters: { type: "object", properties: {} },
  },
] as const;

export type DeskOptions = {
  at?: number;
  connectors?: Connectors;
  caller?: string | null;
};

function unreachable(err: unknown) {
  const detail = err instanceof ConnectorError ? err.message : err instanceof Error ? err.name : "error";
  console.error("[desk] connector failed", detail);
  return { result: "system_unreachable" };
}

function pickupSlot(desk: Desk, args: Record<string, unknown>) {
  if (!text(args.time)) return earliestPickup(desk);
  const place = desk.resolve(args.day, args.time);
  return "problem" in place ? null : { day: place.day, minute: place.minute };
}

export async function runDeskTool(
  doc: GalbiDoc,
  state: DeskState,
  name: string,
  rawArgs: unknown,
  options: DeskOptions = {},
) {
  const desk = new Desk(doc, options.at ?? Date.now());
  const orders = options.connectors?.orders ?? null;
  const waitlist = options.connectors?.waitlist ?? null;
  const caller = options.caller ?? null;
  const next: DeskState = JSON.parse(JSON.stringify(state)) as DeskState;
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs as Record<string, unknown>;
  }

  let output: Record<string, unknown>;
  switch (name) {
    case "check_table":
      output = tableAnswer(desk, next, args, false);
      break;
    case "book_table":
      output = tableAnswer(desk, next, args, true);
      break;
    case "cancel_table":
      if (!next.booking) output = { result: "nothing_booked" };
      else {
        output = { result: "cancelled", was: bookingSpoken(desk, next.booking) };
        next.booking = null;
      }
      break;
    case "check_wait": {
      output = waitAnswer(desk, next, args);
      if (output.result === "wait_now" && waitlist) {
        try {
          const live = await waitlist.status(partyOf(args.party));
          output = live.open
            ? {
                result: "wait_now",
                minutes: live.minutes,
                parties_ahead: live.parties,
                on_wait_list: next.waitlist ? next.waitlist.name : null,
              }
            : { result: "wait_list_closed", reason: live.reason };
        } catch (err) {
          output = unreachable(err);
        }
      }
      break;
    }
    case "join_wait_list": {
      const party = partyOf(args.party);
      const guest = text(args.name);
      if (!desk.openNow()) {
        const open = desk.nextOpening();
        output = { result: "closed_now", next_opening: open ? desk.spokenSlot(open.day, open.minute) : null };
      } else if (!party || !guest) {
        output = { result: party ? "need_name" : "need_party_size" };
      } else if (party > desk.maxParty) {
        output = { result: "party_too_large", max_party: desk.maxParty };
      } else if (waitlist) {
        try {
          const joined = await waitlist.join({ name: guest, party, phone: caller });
          next.waitlist = { name: guest, party };
          output = {
            result: "added",
            name: guest,
            party,
            position: joined.position,
            minutes: joined.minutes,
            text_updates: Boolean(caller),
          };
        } catch (err) {
          output = unreachable(err);
        }
      } else {
        next.waitlist = { name: guest, party };
        output = { result: "added", name: guest, party, parties_ahead: next.wait.parties, minutes: next.wait.minutes };
      }
      break;
    }
    case "pickup_time":
      output = pickupAnswer(desk, args);
      break;
    case "price_items": {
      const priced = priceList(doc, args.items);
      output = {
        items: priced.lines,
        total: money(priced.total),
        not_on_menu: priced.unknown,
      };
      break;
    }
    case "place_togo_order": {
      const guest = text(args.name);
      const priced = priceList(doc, args.items);
      const pickup = pickupAnswer(desk, args);
      if (!guest) output = { result: "need_name" };
      else if (priced.unknown.length) output = { result: "not_on_menu", items: priced.unknown };
      else if (!priced.lines.length) output = { result: "need_items" };
      else if (!pickup.ok) output = { result: "pickup_not_possible", ...pickup };
      else if (orders) {
        const slot = pickupSlot(desk, args);
        try {
          if (!slot) throw new Error("no_pickup_slot");
          const placed = await orders.place({
            key: `bessi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            guest,
            phone: caller,
            lines: priced.lines.map((line) => {
              const item = matchItem(doc, line.item)!;
              return { name: item.name, quantity: line.quantity, unitCents: Math.round(item.price * 100) };
            }),
            pickupAt: zonedIso(timeZoneOf(doc), slot.day.key, slot.minute),
            pickupSpoken: String(pickup.pickup),
          });
          let payLinkTexted = false;
          if (placed.payLink && caller) {
            payLinkTexted = await sendSms(
              caller,
              `${text(doc.name) || "Your order"}: pay here to send your order to the kitchen ${placed.payLink}`,
            ).catch(() => false);
          }
          const total = placed.totalCents != null ? money(placed.totalCents / 100) : money(priced.total);
          next.order = { name: guest, total, pickup: String(pickup.pickup) };
          output = {
            result: placed.payLink ? (payLinkTexted ? "placed_pay_link_texted" : "pay_link_not_sent") : "placed",
            name: guest,
            items: priced.lines,
            total,
            total_includes_tax: placed.totalCents != null,
            pay_at_pickup: !placed.payLink,
            pickup: pickup.pickup,
          };
        } catch (err) {
          output = unreachable(err);
        }
      } else {
        next.order = { name: guest, total: money(priced.total), pickup: String(pickup.pickup) };
        output = {
          result: "placed",
          name: guest,
          items: priced.lines,
          total: money(priced.total),
          pickup: pickup.pickup,
        };
      }
      break;
    }
    case "text_party_form":
      output = next.formSent ? { result: "already_sent" } : { result: "sent" };
      next.formSent = true;
      break;
    default:
      output = { result: "unknown_tool" };
  }
  return { output, state: next };
}

export function deskFacts(doc: GalbiDoc, at = Date.now()) {
  const desk = new Desk(doc, at);
  const today = desk.day(0);
  const open = desk.openNow();
  const next = desk.nextOpening();
  const pickup = earliestPickup(desk);
  return {
    today: today.long,
    tomorrow: desk.day(1).long,
    now: spokenClock(desk.nowMinute),
    open,
    closesAt: desk.closesAt(),
    nextOpening: next ? desk.spokenSlot(next.day, next.minute) : null,
    earliestPickup: pickup ? desk.spokenSlot(pickup.day, pickup.minute) : null,
  };
}
