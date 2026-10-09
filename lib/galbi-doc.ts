import { readFileSync } from "node:fs";
import { join } from "node:path";

export type MenuItem = {
  name?: string;
  price?: string;
  description?: string;
};

export type MenuSection = {
  section?: string;
  items?: MenuItem[];
};

export type Deal = {
  name?: string;
  days?: string[];
  start?: string;
  end?: string;
  details?: string;
};

export type GalbiDoc = {
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

export type Range = { start: number; end: number; label: string };

export type Day = {
  key: string;
  weekday: string;
  long: string;
  offset: number;
};

export const DAY_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function loadDoc(): GalbiDoc {
  const raw = readFileSync(join(process.cwd(), "galbi_steakhouse.json"), "utf8");
  return JSON.parse(raw) as GalbiDoc;
}

export function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function hhmmToMinutes(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function hhmm(total: number) {
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function spokenClock(total: number) {
  const hour24 = Math.floor(total / 60) % 24;
  const minute = total % 60;
  if (hour24 === 12 && minute === 0) return "noon";
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return minute === 0 ? `${hour} ${suffix}` : `${hour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function timeZoneOf(doc: GalbiDoc) {
  return text(doc.timezone) || "America/Los_Angeles";
}

export function rangesFor(doc: GalbiDoc, weekday: string): Range[] {
  const raw = text(doc.hours?.[weekday]);
  if (!raw || raw.toLowerCase() === "closed") return [];
  const found: Range[] = [];
  const pattern = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*([a-z ]*)/gi;
  for (const match of raw.matchAll(pattern)) {
    const start = hhmmToMinutes(match[1]);
    const end = hhmmToMinutes(match[2]);
    if (start != null && end != null && end > start) {
      found.push({ start, end, label: match[3].trim() });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

export function insideHours(ranges: Range[], minute: number) {
  return ranges.some((range) => minute >= range.start && minute <= range.end);
}

export function hoursSpoken(ranges: Range[]) {
  if (ranges.length === 0) return "closed";
  return ranges
    .map((range) => {
      const span = `${spokenClock(range.start)} to ${spokenClock(range.end)}`;
      return range.label ? `${span} ${range.label}` : span;
    })
    .join(", ");
}

export function localNow(timeZone: string, at = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function zonedIso(timeZone: string, key: string, minute: number) {
  const [year, month, day] = key.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  const seen = localNow(timeZone, guess);
  const seenAt = Date.UTC(seen.year, seen.month - 1, seen.day, Math.floor(seen.minute / 60), seen.minute % 60);
  return new Date(guess - (seenAt - guess)).toISOString();
}

export function dayAt(base: { year: number; month: number; day: number }, offset: number): Day {
  const at = new Date(Date.UTC(base.year, base.month - 1, base.day + offset));
  const weekday = WEEKDAYS[at.getUTCDay()];
  const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(
    at.getUTCDate(),
  ).padStart(2, "0")}`;
  const long = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
  return { key, weekday, long, offset };
}

export function monthIndex(word: string) {
  const lower = word.toLowerCase();
  return MONTHS.findIndex((month) => month.toLowerCase().startsWith(lower.slice(0, 3)));
}

export function dayList(days: string[]) {
  const wanted = new Set(days.map((day) => day.toLowerCase()));
  const ordered = DAY_ORDER.filter((day) => wanted.has(day));
  if (ordered.length === 7) return "every day";
  if (
    ordered.length === 5 &&
    ordered.every((day) => ["monday", "tuesday", "wednesday", "thursday", "friday"].includes(day))
  ) {
    return "Monday through Friday";
  }
  return ordered.map((day) => day.charAt(0).toUpperCase() + day.slice(1)).join(", ");
}

export function filledDeals(doc: GalbiDoc) {
  return (doc.deals || []).filter((deal) => text(deal.details) && text(deal.name));
}

export function dealAt(doc: GalbiDoc, weekday: string, minute: number) {
  for (const deal of filledDeals(doc)) {
    const start = hhmmToMinutes(text(deal.start));
    const end = hhmmToMinutes(text(deal.end));
    const days = (deal.days || []).map((day) => day.toLowerCase());
    if (start == null || end == null) continue;
    if (days.length > 0 && !days.includes(weekday)) continue;
    const covers =
      end === start ? true : end > start ? minute >= start && minute < end : minute >= start || minute < end;
    if (covers) return `${text(deal.name)}: ${text(deal.details)}`;
  }
  return null;
}

export function menuItems(doc: GalbiDoc) {
  const items: { name: string; price: number; description: string }[] = [];
  for (const section of doc.menu || []) {
    for (const item of section.items || []) {
      const name = text(item.name);
      const price = Number(text(item.price).replace(/[^0-9.]/g, ""));
      if (name && Number.isFinite(price) && price > 0) {
        items.push({ name, price, description: text(item.description) });
      }
    }
  }
  return items;
}
