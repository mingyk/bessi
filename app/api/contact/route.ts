import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function read(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export async function POST(request: Request) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL;
  if (!apiKey || !to) {
    return NextResponse.json(
      { error: "email isn’t set up yet" },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const first = read(body?.first, 80);
  const last = read(body?.last, 80);
  const email = read(body?.email, 200);
  const phone = read(body?.phone, 40);
  const need = read(body?.need, 4000);

  if (!first || !last || !phone || !need || !EMAIL.test(email)) {
    return NextResponse.json({ error: "please fill everything in" }, { status: 400 });
  }

  const from = process.env.CONTACT_FROM_EMAIL || "Bessi <onboarding@resend.dev>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: email,
      subject: `bessi contact — ${first} ${last}`,
      text: [
        `${first} ${last}`,
        email,
        phone,
        "",
        need,
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: "couldn’t send" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
