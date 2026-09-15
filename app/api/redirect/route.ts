import { NextResponse } from "next/server";
import { REDIRECT_PHRASE, VOICE } from "@/lib/constants";
import { getOpenAIKey } from "@/lib/openai-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Cache = { bytes?: ArrayBuffer };
const cache = globalThis as typeof globalThis & Cache;

export async function GET() {
  const headers = {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  if (cache.bytes) {
    return new NextResponse(cache.bytes, { headers });
  }

  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 503 });
  }

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: VOICE,
      input: REDIRECT_PHRASE,
      instructions:
        "Warm, brief, like a support person on a phone call. Not chipper. Not robotic.",
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: "Redirect clip unavailable" }, { status: 503 });
  }

  cache.bytes = await response.arrayBuffer();
  return new NextResponse(cache.bytes, { headers });
}
