import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { MODEL, VOICE } from "../lib/constants";
import { buildGalbiCall } from "../lib/galbi";
import { getOpenAIKey } from "../lib/openai-key";

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE = (process.env.TWILIO_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

type TwilioEvent = {
  event?: string;
  streamSid?: string;
  start?: { streamSid?: string };
  media?: { payload?: string; timestamp?: string };
};

function loadEnv() {
  try {
    const text = readFileSync(join(process.cwd(), ".env"), "utf8");
    for (const row of text.split(/\r?\n/)) {
      const line = row.trim();
      if (!line || line.startsWith("#")) continue;
      const cut = line.indexOf("=");
      if (cut < 1) continue;
      const name = line.slice(0, cut).replace(/^export\s+/, "").trim();
      if (process.env[name]) continue;
      let value = line.slice(cut + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[name] = value;
    }
  } catch {
    // Cloud Run / production inject env directly.
  }
}

function form(body: string) {
  const params = new URLSearchParams(body);
  const rows: Record<string, string> = {};
  for (const [key, value] of params) rows[key] = value;
  return rows;
}

function validTwilio(url: string, params: Record<string, string>, signature: string) {
  if (!AUTH_TOKEN) return true;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((key) => key + params[key])
      .join("");
  const expected = createHmac("sha1", AUTH_TOKEN).update(data).digest("base64");
  return expected === signature;
}

function publicUrl(request: IncomingMessage, path: string) {
  if (PUBLIC_BASE) return `${PUBLIC_BASE}${path}`;
  const host = request.headers.host || `127.0.0.1:${PORT}`;
  const proto = request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  return `${proto}://${host}${path}`;
}

function twiml(streamUrl: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendXml(response: ServerResponse, xml: string, status = 200) {
  response.writeHead(status, { "Content-Type": "text/xml; charset=utf-8" });
  response.end(xml);
}

async function handleVoice(request: IncomingMessage, response: ServerResponse) {
  const body = request.method === "POST" ? await readBody(request) : "";
  const params = form(body);
  const url = publicUrl(request, "/voice");
  const signature = String(request.headers["x-twilio-signature"] || "");
  if (AUTH_TOKEN && !validTwilio(url, params, signature)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  const stream = publicUrl(request, "/media").replace(/^http/, "ws");
  sendXml(response, twiml(stream));
}

async function attachOpenAI(twilio: WebSocket) {
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    twilio.close();
    return;
  }
  const { instructions, greeting } = buildGalbiCall();
  const openai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  let streamSid = "";
  let latestMedia = 0;
  let responseStart: number | null = null;
  let lastAssistant = "";
  let greeted = false;

  const sendOpenAI = (event: object) => {
    if (openai.readyState === WebSocket.OPEN) openai.send(JSON.stringify(event));
  };
  const sendTwilio = (event: object) => {
    if (twilio.readyState === WebSocket.OPEN) twilio.send(JSON.stringify(event));
  };

  const startSession = () => {
    sendOpenAI({
      type: "session.update",
      session: {
        type: "realtime",
        model: MODEL,
        instructions,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.6,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcmu" },
            voice: VOICE,
          },
        },
      },
    });
  };

  const greet = () => {
    if (greeted) return;
    greeted = true;
    sendOpenAI({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `The call just connected. Say exactly this English greeting, then wait: "${greeting}"`,
          },
        ],
      },
    });
    sendOpenAI({ type: "response.create" });
    console.log("[call] phone_greeting");
  };

  const barge = () => {
    if (!lastAssistant) return;
    if (responseStart != null) {
      sendOpenAI({
        type: "conversation.item.truncate",
        item_id: lastAssistant,
        content_index: 0,
        audio_end_ms: Math.max(0, latestMedia - responseStart),
      });
    }
    sendTwilio({ event: "clear", streamSid });
    lastAssistant = "";
    responseStart = null;
  };

  openai.on("open", startSession);
  openai.on("message", (raw) => {
    const event = JSON.parse(String(raw)) as {
      type?: string;
      delta?: string;
      item_id?: string;
    };
    if (event.type === "session.updated") greet();
    if (event.type === "input_audio_buffer.speech_started") barge();
    if (
      (event.type === "response.output_audio.delta" ||
        event.type === "response.audio.delta") &&
      event.delta
    ) {
      if (event.item_id && event.item_id !== lastAssistant) {
        responseStart = latestMedia;
        lastAssistant = event.item_id;
      }
      sendTwilio({
        event: "media",
        streamSid,
        media: { payload: event.delta },
      });
    }
    if (event.type === "error") console.error("[call] openai_error", event);
  });
  openai.on("close", () => twilio.close());
  openai.on("error", (err) => {
    console.error("[call] openai_ws", err.message);
    twilio.close();
  });

  twilio.on("message", (raw) => {
    const data = JSON.parse(String(raw)) as TwilioEvent;
    if (data.event === "start") {
      streamSid = data.start?.streamSid || data.streamSid || "";
      console.log("[call] phone_stream", streamSid);
    }
    if (data.event === "media" && data.media?.payload) {
      latestMedia = Number(data.media.timestamp || latestMedia);
      sendOpenAI({
        type: "input_audio_buffer.append",
        audio: data.media.payload,
      });
    }
    if (data.event === "stop") {
      openai.close();
      twilio.close();
    }
  });
  twilio.on("close", () => {
    if (openai.readyState === WebSocket.OPEN) openai.close();
  });
}

const server = createServer((request, response) => {
  const path = request.url?.split("?")[0] || "/";
  if (path === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === "/voice") {
    void handleVoice(request, response).catch((err) => {
      console.error("[call] voice", err);
      response.writeHead(500).end("error");
    });
    return;
  }
  response.writeHead(404).end("not found");
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const path = request.url?.split("?")[0] || "/";
  if (path !== "/media") {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    void attachOpenAI(ws);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[call] galbi phone bridge on :${PORT}`);
  if (PUBLIC_BASE) console.log(`[call] public ${PUBLIC_BASE}`);
});
