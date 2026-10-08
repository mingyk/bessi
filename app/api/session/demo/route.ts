import { NextResponse } from "next/server";
import { buildGalbiRealtimeSession } from "@/lib/galbi";
import { getOpenAIKey } from "@/lib/openai-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY" },
      { status: 503 },
    );
  }

  let session: ReturnType<typeof buildGalbiRealtimeSession>;
  try {
    session = buildGalbiRealtimeSession();
  } catch (err) {
    console.error("Galbi demo config", err);
    return NextResponse.json(
      { error: "Galbi demo config is invalid" },
      { status: 500 },
    );
  }

  const response = await fetch(
    "https://api.openai.com/v1/realtime/client_secrets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session: session.session }),
    },
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Realtime session failed", response.status, data?.error?.code);
    return NextResponse.json(
      { error: "Could not start a voice session" },
      { status: 502 },
    );
  }

  const value = data.value ?? data.client_secret?.value;
  if (typeof value !== "string") {
    return NextResponse.json(
      { error: "Could not start a voice session" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    value,
    greeting: session.greeting,
    transcription: session.session.audio.input.transcription,
    desk: session.desk,
  });
}
