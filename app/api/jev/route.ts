import { NextResponse } from "next/server";
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
  } | null;
  const expectName = body?.ask === "expect_name";
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

  if (!latest.trim()) return NextResponse.json(expectName ? { expectName: null } : none);

  try {
    if (expectName) {
      const waiting = await decideExpectName({ latest, history });
      callLog("expect_name", { latest, waiting });
      return NextResponse.json({ expectName: waiting });
    }
    const raw = await decideTurn({ latest, history });
    const decision = guardRestaurantSteer(raw, latest, history);
    callLog("jev", {
      latest,
      steer: decision.steer,
      raw: raw.steer,
      naming: decision.naming === true,
      checkin: decision.checkin === true,
    });
    return NextResponse.json(decision);
  } catch (err) {
    callLog("jev_error", { name: err instanceof Error ? err.name : "error" });
    console.error("Jev decide failed", err instanceof Error ? err.name : "error");
    if (expectName) return NextResponse.json({ expectName: null });
    return NextResponse.json(none);
  }
}
