import { NextResponse } from "next/server";
import { callLog } from "@/lib/call-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    event?: unknown;
    detail?: unknown;
  } | null;
  if (typeof body?.event === "string" && body.event.trim()) {
    const detail =
      body.detail && typeof body.detail === "object" && !Array.isArray(body.detail)
        ? (body.detail as Record<string, unknown>)
        : {};
    callLog(body.event.trim(), detail);
  }
  return NextResponse.json({ ok: true });
}
