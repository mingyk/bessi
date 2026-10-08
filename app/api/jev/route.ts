import { NextResponse } from "next/server";
import { extractGuestBooking, extractHostBooking } from "@/lib/booking-extract";
import { readSheet } from "@/lib/booking-sheet";
import { callLog } from "@/lib/call-log";
import { guardRestaurantSteer } from "@/lib/guardrail";
import { decideExpectName, decideTurn } from "@/lib/jev";
import type { DialogueLine } from "@/lib/turn-decision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const none = { steer: "none" };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    latest?: unknown;
    history?: unknown;
    ask?: unknown;
    sheet?: unknown;
  } | null;
  const expectName = body?.ask === "expect_name";
  const hostBooking = body?.ask === "host_booking";
  const latest = typeof body?.latest === "string" ? body.latest : "";
  const history = Array.isArray(body?.history)
    ? body.history.flatMap((line): DialogueLine[] => {
        if (!line || typeof line !== "object") return [];
        const row = line as { speaker?: unknown; text?: unknown };
        if (
          (row.speaker !== "guest" && row.speaker !== "host") ||
          typeof row.text !== "string"
        ) {
          return [];
        }
        return [{ speaker: row.speaker, text: row.text }];
      })
    : [];

  const sheet = readSheet(body?.sheet);
  if (!latest.trim()) return NextResponse.json(expectName ? { expectName: null } : none);

  try {
    if (expectName) {
      const waiting = await decideExpectName({ latest, history });
      callLog("expect_name", { latest, waiting });
      return NextResponse.json({ expectName: waiting });
    }
    if (hostBooking) {
      const heard = await extractHostBooking({ latest, sheet });
      callLog("host_booking", {
        latest,
        offer: heard?.offer ?? null,
        booked: heard?.booked ?? null,
      });
      return NextResponse.json(heard ?? { offer: null, booked: null });
    }
    const [raw, booking] = await Promise.all([
      decideTurn({ latest, history }),
      extractGuestBooking({ latest, history, sheet }),
    ]);
    const decision = guardRestaurantSteer(raw, latest, history, sheet);
    callLog("jev", {
      latest,
      steer: decision.steer,
      raw: raw.steer,
      naming: decision.naming === true,
      recall: decision.recall === true,
      checkin: decision.checkin === true,
    });
    callLog("booking", {
      intent: booking?.intent ?? "null",
      time: booking?.time ?? null,
      party: booking?.party ?? null,
      date: booking?.date ?? null,
      name: booking?.name ?? null,
    });
    callLog("sheet", {
      pending: sheet.time.pending,
      held: sheet.time.held,
      booked: sheet.time.booked,
      offer: sheet.offer,
      name: sheet.name.accepted ?? sheet.name.pending,
      party: sheet.party.accepted ?? sheet.party.pending,
      date: sheet.date.accepted ?? sheet.date.pending,
    });
    return NextResponse.json({ ...decision, booking });
  } catch (err) {
    callLog("jev_error", { name: err instanceof Error ? err.name : "error" });
    console.error("Jev decide failed", err instanceof Error ? err.name : "error");
    if (expectName) return NextResponse.json({ expectName: null });
    if (hostBooking) return NextResponse.json({ offer: null, booked: null });
    return NextResponse.json(none);
  }
}
