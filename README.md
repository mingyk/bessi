# Bessi

Voice AI agent for customer support. One-page site with a talk button, connected to OpenAI `gpt-realtime-2`.

## Local test

You need Node 18+ and a microphone. The API key stays in `.env` and is never sent to the browser.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

1. Click the orb (allow the microphone when asked).
2. Ask something about Bessi — what it is, how it works, pricing, this demo.
3. Say something off-topic (weather, a joke, homework). You should hear the same short redirect: *“That's outside what I can help with. Ask me anything about Bessi though.”*
4. Click the orb again to hang up.

Use Chrome or Safari. The browser only allows the mic on `localhost` or HTTPS.

Off-topic replies use a cached Marin clip (same voice as the live agent). If that clip can’t be built, the agent says the same line live.

## Email (contact form)

Vercel does not send mail by itself. The contact form uses [Resend](https://resend.com) from a serverless route.

Add these env vars locally and in Vercel:

```
RESEND_API_KEY=
CONTACT_TO_EMAIL=you@yourdomain.com
CONTACT_FROM_EMAIL=Bessi <onboarding@resend.dev>
```

`CONTACT_FROM_EMAIL` can stay on Resend’s test domain until you verify your own. Test-domain mail can only be delivered to the Resend account email.

## Deploy on Vercel

```bash
npx vercel
```

In the Vercel project, add `OPENAI_API_KEY`, `RESEND_API_KEY`, and `CONTACT_TO_EMAIL`. Redeploy after saving them.
