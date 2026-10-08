import { NextResponse } from "next/server";
import { callLog } from "@/lib/call-log";
import { loadDoc } from "@/lib/galbi-doc";
import { readDeskState, runDeskTool } from "@/lib/host-desk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    arguments?: unknown;
    state?: unknown;
  } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const state = readDeskState(body?.state);
  const { output, state: next } = runDeskTool(loadDoc(), state, name, body?.arguments);
  callLog("tool", { name, args: body?.arguments, output });
  return NextResponse.json({ output, state: next });
}
