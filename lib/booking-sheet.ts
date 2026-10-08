export type BookingIntent = "propose" | "accept" | "reject" | "none";

export type BookingUpdate = {
  intent: BookingIntent;
  time: string | null;
  party: string | null;
  date: string | null;
  name: string | null;
};

export type Detail = {
  accepted: string | null;
  pending: string | null;
};

export type TimeSlot = {
  pending: string | null;
  held: string | null;
  booked: string | null;
};

export type BookingSheet = {
  name: Detail;
  party: Detail;
  date: Detail;
  time: TimeSlot;
  offer: string | null;
};

export type HostBooking = {
  offer: string | null;
  booked: string | null;
};

function detail(): Detail {
  return { accepted: null, pending: null };
}

export function emptySheet(): BookingSheet {
  return {
    name: detail(),
    party: detail(),
    date: detail(),
    time: { pending: null, held: null, booked: null },
    offer: null,
  };
}

function clean(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length ? text : null;
}

function readDetail(value: unknown): Detail {
  if (!value || typeof value !== "object") return detail();
  const row = value as { accepted?: unknown; pending?: unknown };
  return { accepted: clean(row.accepted), pending: clean(row.pending) };
}

export function readSheet(value: unknown): BookingSheet {
  if (!value || typeof value !== "object") return emptySheet();
  const row = value as {
    name?: unknown;
    party?: unknown;
    date?: unknown;
    time?: unknown;
    offer?: unknown;
  };
  const time = row.time;
  const slot =
    time && typeof time === "object"
      ? (time as { pending?: unknown; held?: unknown; booked?: unknown })
      : {};
  return {
    name: readDetail(row.name),
    party: readDetail(row.party),
    date: readDetail(row.date),
    time: {
      pending: clean(slot.pending),
      held: clean(slot.held),
      booked: clean(slot.booked),
    },
    offer: clean(row.offer),
  };
}

function stated(field: Detail, value: string | null): Detail {
  if (!value) return field;
  if (!field.accepted || field.accepted === value) {
    return { accepted: value, pending: null };
  }
  return { accepted: field.accepted, pending: value };
}

function promote(sheet: BookingSheet) {
  for (const key of ["name", "party", "date"] as const) {
    const pending = sheet[key].pending;
    if (pending) sheet[key] = { accepted: pending, pending: null };
  }
}

export function applyUpdate(sheet: BookingSheet, update: BookingUpdate): BookingSheet {
  if (update.intent === "none") return sheet;
  const next: BookingSheet = {
    name: { ...sheet.name },
    party: { ...sheet.party },
    date: { ...sheet.date },
    time: { ...sheet.time },
    offer: sheet.offer,
  };

  if (update.intent === "reject") {
    next.time.pending = null;
    next.offer = null;
    return next;
  }

  if (update.intent === "propose") {
    const time = clean(update.time);
    if (time && /\d|am|pm|noon|midnight|o'?clock/i.test(time)) {
      next.time.pending = time;
      next.offer = null;
    }
    const party = clean(update.party);
    const date = clean(update.date);
    if (party) next.party = { accepted: party, pending: null };
    if (date) next.date = { accepted: date, pending: null };
    next.name = stated(next.name, clean(update.name));
    return next;
  }

  if (!next.offer && !next.time.pending) return sheet;

  if (next.offer) {
    next.time.booked = next.offer;
    next.time.pending = null;
    next.time.held = null;
    next.offer = null;
    promote(next);
    return next;
  }
  if (next.time.pending && (next.time.booked || next.time.held)) {
    next.time.booked = next.time.pending;
    next.time.pending = null;
    next.time.held = null;
    promote(next);
    return next;
  }
  if (next.time.pending) {
    next.time.held = next.time.pending;
    next.time.pending = null;
    promote(next);
  }
  return next;
}

export function applyHost(sheet: BookingSheet, host: HostBooking): BookingSheet {
  const offer = clean(host.offer);
  let booked = clean(host.booked);
  if (offer && booked) booked = null;
  const next: BookingSheet = {
    name: { ...sheet.name },
    party: { ...sheet.party },
    date: { ...sheet.date },
    time: { ...sheet.time },
    offer: sheet.offer,
  };
  if (booked) {
    const known = [next.time.pending, next.time.held, next.time.booked, next.offer];
    if (known.some((value) => value && value === booked)) {
      next.time.booked = booked;
      next.time.pending = null;
      next.time.held = null;
      next.offer = null;
      return next;
    }
  }
  if (offer && !next.time.held && !next.time.booked && offer !== next.time.pending) {
    next.time.pending = offer;
    return next;
  }
  if (
    offer &&
    next.time.held &&
    offer !== next.time.pending &&
    offer !== next.time.held &&
    offer !== next.time.booked
  ) {
    next.offer = offer;
  }
  return next;
}

function gaps(sheet: BookingSheet) {
  const missing: string[] = [];
  if (!sheet.name.accepted) missing.push("a name");
  if (!sheet.party.accepted) missing.push("a party size");
  if (!sheet.date.accepted) missing.push("a date");
  return missing;
}

export function nextNeededAsk(
  sheet: BookingSheet,
  history: { speaker: "guest" | "host"; text: string }[] = [],
) {
  const host = [...history].reverse().find((line) => line.speaker === "host");
  const asked = host?.text ?? "";
  if (sheet.time.pending) {
    return `whether ${sheet.time.pending} is the time they want`;
  }
  if (sheet.offer) {
    return `whether ${sheet.offer} works for them`;
  }
  if (/\b(item|order|dish|menu|what would you like)\b/i.test(asked)) {
    return "the name and the items for the order";
  }
  if (/\b(how many|party size|how many people|for how many)\b/i.test(asked)) {
    return "the party size";
  }
  if (/\b(what time|which time|o'?clock|\bpm\b|\bam\b|pickup)\b/i.test(asked)) {
    return "what time they want";
  }
  if (/\b(name|who('s| is) it under|under whose)\b/i.test(asked)) {
    return "the name";
  }
  if (/\b(what day|which day|what date)\b/i.test(asked)) {
    return "the date";
  }
  const time = sheet.time.held || sheet.time.booked;
  if (time && !sheet.party.accepted && !sheet.party.pending) return "the party size";
  if (time && !sheet.date.accepted && !sheet.date.pending) return "the date";
  if (time && !sheet.name.accepted && !sheet.name.pending) return "the name";
  return null;
}

export function bookingInstructions(
  sheet: BookingSheet,
  update: BookingUpdate | null,
  recall: boolean,
) {
  const speak = "";
  const pending = sheet.time.pending;
  const booked = sheet.time.booked;
  const held = sheet.time.held;

  if (update?.intent === "propose" && update.time && pending) {
    return `They gave a time. Check ${pending} back with them in a natural short question, and wait for their answer. Do not say that time is booked, unavailable, or changed yet, and do not offer a different time. ${speak}`;
  }
  if (update?.intent === "reject") {
    const kept = booked ? ` The reservation time is still ${booked}.` : "";
    return `They did not accept that time. Ask what time they want. Do not announce a booking from the time they refused.${kept} ${speak}`;
  }
  if (update?.intent === "accept" && booked) {
    const missing = gaps(sheet);
    if (missing.length) {
      return `They accepted ${booked}. If you say the time, say ${booked}. Ask only for ${missing.join(", ")}. Do not say the table is booked until those are known, and do not say a different time. ${speak}`;
    }
    const details = [
      sheet.name.accepted ? `Name: ${sheet.name.accepted}.` : "",
      sheet.party.accepted ? `Party: ${sheet.party.accepted}.` : "",
      sheet.date.accepted ? `Date: ${sheet.date.accepted}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `The reservation time is ${booked}. If you confirm, say ${booked} and no other time. ${details} ${speak}`;
  }
  if (update?.intent === "accept" && held) {
    return `They agreed the time they mean is ${held}. You may now say whether ${held} is available. If you book it, that is the reservation time. If it is not available, say ${held} is unavailable and offer one other time. Do not say the reservation is booked at ${held} when you are offering another time, and do not name any earlier time. ${speak}`;
  }
  if (recall && booked) {
    const details = [
      sheet.name.accepted ? `Name: ${sheet.name.accepted}.` : "",
      sheet.party.accepted ? `Party: ${sheet.party.accepted}.` : "",
      sheet.date.accepted ? `Date: ${sheet.date.accepted}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `They want the reservation. The booked time is ${booked}. Say ${booked}. ${details} Do not say a different time. ${speak}`;
  }
  if (recall && sheet.offer) {
    return `There is no booked time yet. The suggestion waiting for a yes is ${sheet.offer}. Do not say an earlier time is the reservation. ${speak}`;
  }
  return "";
}
