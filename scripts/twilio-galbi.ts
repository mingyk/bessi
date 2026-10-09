import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { MODEL, VOICE } from "../lib/constants";
import { buildGalbiCall } from "../lib/galbi";
import { loadDoc } from "../lib/galbi-doc";
import { connectorsFromEnv } from "../lib/connectors";
import { runDeskTool } from "../lib/host-desk";
import { getOpenAIKey } from "../lib/openai-key";
import { loadRoomLoop, mixRoom, ROOM_FRAME } from "../lib/room-mix";

const ROOM_LEAD_MS = 80;
const GREET_DELAY_MS = 1200;
const VAD_THRESHOLD = 0.7;
const VAD_SILENCE_MS = 500;
const SILENCE_HOLD_MS = 3000;
const HOLD_MAX_MS = 6000;
const HOLD_LINE =
  "You're still working on the caller's last request and have gone quiet for a few seconds. In the caller's language, say only one short line that you need a moment, as if you're still checking. Don't answer, ask anything, or mention any details.";

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_BASE = (process.env.TWILIO_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

type TwilioEvent = {
  event?: string;
  streamSid?: string;
  start?: { streamSid?: string; customParameters?: Record<string, string> };
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

function twiml(streamUrl: string, caller: string) {
  const from = /^\+[1-9]\d{6,14}$/.test(caller)
    ? `\n      <Parameter name="caller" value="${caller}" />`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">${from}
    </Stream>
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
  sendXml(response, twiml(stream, params.From || ""));
}

async function attachOpenAI(twilio: WebSocket) {
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    twilio.close();
    return;
  }
  const { instructions, greeting, tools, desk: firstDesk } = buildGalbiCall();
  const doc = loadDoc();
  let desk = firstDesk;
  let caller: string | null = null;
  let toolQueue = Promise.resolve();
  const connectors = connectorsFromEnv();
  const openai = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );

  let streamSid = "";
  let latestMedia = 0;
  let responseStart: number | null = null;
  let lastAssistant = "";
  let greeted = false;
  let greetTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let sessionReady = false;
  let greetLock = true;
  let guestTalking = false;
  let guestSpokeInLock = false;
  let waitTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let heldThisTurn = false;
  let holdActive = false;
  let holdCurrent = "";
  let holdSafety: ReturnType<typeof setTimeout> | 0 = 0;
  const holdIds = new Set<string>();
  let queued: { item: string; audio: Buffer }[] = [];
  let toolsPending = 0;
  const room = loadRoomLoop();
  let roomAt = 0;
  let pump: ReturnType<typeof setInterval> | 0 = 0;
  let playStart = 0;
  let sentMs = 0;

  const aheadMs = () => sentMs - (Date.now() - playStart);

  const sendAudio = (host: Buffer | null, length: number) => {
    if (!streamSid) return;
    if (!playStart || aheadMs() < 0) {
      playStart = Date.now();
      sentMs = 0;
    }
    const mixed = mixRoom(host, length, room, roomAt);
    roomAt = mixed.next;
    sentMs += length / 8;
    sendTwilio({
      event: "media",
      streamSid,
      media: { payload: mixed.audio.toString("base64") },
    });
  };

  const resetPlayback = () => {
    playStart = 0;
    sentMs = 0;
  };

  const stopPump = () => {
    if (pump) clearInterval(pump);
    pump = 0;
  };

  const startPump = () => {
    if (pump || !streamSid) return;
    pump = setInterval(() => {
      while (streamSid && (!playStart || aheadMs() < ROOM_LEAD_MS)) {
        sendAudio(null, ROOM_FRAME);
      }
    }, 20);
  };

  const sendOpenAI = (event: object) => {
    if (openai.readyState === WebSocket.OPEN) openai.send(JSON.stringify(event));
  };
  const sendTwilio = (event: object) => {
    if (twilio.readyState === WebSocket.OPEN) twilio.send(JSON.stringify(event));
  };

  const audioInput = () => ({
    format: { type: "audio/pcmu" },
    noise_reduction: { type: "near_field" },
    turn_detection: {
      type: "server_vad",
      threshold: VAD_THRESHOLD,
      prefix_padding_ms: 300,
      silence_duration_ms: VAD_SILENCE_MS,
      create_response: !greetLock && toolsPending === 0,
      interrupt_response: !greetLock,
    },
  });

  const applyTurns = () => {
    sendOpenAI({
      type: "session.update",
      session: { type: "realtime", audio: { input: audioInput() } },
    });
  };

  const startSession = () => {
    sendOpenAI({
      type: "session.update",
      session: {
        type: "realtime",
        model: MODEL,
        instructions,
        output_modalities: ["audio"],
        tools,
        tool_choice: "auto",
        audio: {
          input: audioInput(),
          output: {
            format: { type: "audio/pcmu" },
            voice: VOICE,
          },
        },
      },
    });
  };

  const playbackEnd = () => (playStart ? playStart + sentMs : Date.now());

  const unlockGreeting = () => {
    if (!greetLock) return;
    greetLock = false;
    applyTurns();
    if (guestSpokeInLock && !guestTalking) sendOpenAI({ type: "response.create" });
    console.log("[call] greeting_done");
  };

  const clearWait = () => {
    if (waitTimer) clearTimeout(waitTimer);
    waitTimer = 0;
  };

  const armWait = (delay: number) => {
    if (waitTimer || heldThisTurn || greetLock) return;
    waitTimer = setTimeout(() => {
      waitTimer = 0;
      if (heldThisTurn || holdActive || guestTalking) return;
      heldThisTurn = true;
      holdActive = true;
      holdCurrent = "";
      holdSafety = setTimeout(releaseHold, HOLD_MAX_MS);
      sendOpenAI({
        type: "response.create",
        response: {
          conversation: "none",
          metadata: { purpose: "hold" },
          output_modalities: ["audio"],
          instructions: HOLD_LINE,
          tool_choice: "none",
          max_output_tokens: 80,
        },
      });
      console.log("[call] hold");
    }, Math.max(0, delay));
  };

  const sendHost = (item: string, audio: Buffer) => {
    if (item && item !== lastAssistant) {
      responseStart = latestMedia + Math.max(0, aheadMs());
      lastAssistant = item;
    }
    sendAudio(audio, audio.length);
  };

  const releaseHold = () => {
    if (holdSafety) clearTimeout(holdSafety);
    holdSafety = 0;
    holdActive = false;
    holdCurrent = "";
    const rows = queued;
    queued = [];
    for (const row of rows) sendHost(row.item, row.audio);
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
    sendOpenAI({ type: "response.create", response: { metadata: { purpose: "greeting" } } });
    setTimeout(unlockGreeting, 15000);
    console.log("[call] phone_greeting");
  };

  const scheduleGreeting = () => {
    if (greeted || greetTimer || !sessionReady || !streamSid) return;
    greetTimer = setTimeout(greet, GREET_DELAY_MS);
  };

  const barge = () => {
    if (holdActive && holdCurrent) sendOpenAI({ type: "response.cancel", response_id: holdCurrent });
    for (const item of new Set(queued.map((row) => row.item))) {
      if (item === lastAssistant) continue;
      sendOpenAI({ type: "conversation.item.truncate", item_id: item, content_index: 0, audio_end_ms: 0 });
    }
    queued = [];
    if (holdSafety) clearTimeout(holdSafety);
    holdSafety = 0;
    holdActive = false;
    holdCurrent = "";
    if (lastAssistant && responseStart != null) {
      sendOpenAI({
        type: "conversation.item.truncate",
        item_id: lastAssistant,
        content_index: 0,
        audio_end_ms: Math.max(0, latestMedia - responseStart),
      });
    }
    sendTwilio({ event: "clear", streamSid });
    resetPlayback();
    lastAssistant = "";
    responseStart = null;
  };

  openai.on("open", startSession);
  openai.on("message", (raw) => {
    const event = JSON.parse(String(raw)) as {
      type?: string;
      delta?: string;
      item_id?: string;
      response_id?: string;
      response?: {
        id?: string;
        status?: string;
        metadata?: { purpose?: string } | null;
        output?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string }[];
      };
    };
    const purpose = event.response?.metadata?.purpose;
    if (event.type === "session.updated") {
      sessionReady = true;
      scheduleGreeting();
    }
    if (event.type === "input_audio_buffer.speech_started") {
      guestTalking = true;
      if (greetLock) guestSpokeInLock = true;
      else {
        clearWait();
        barge();
      }
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      guestTalking = false;
      if (!greetLock) {
        heldThisTurn = false;
        clearWait();
        armWait(toolsPending ? 0 : SILENCE_HOLD_MS - VAD_SILENCE_MS);
      }
    }
    if (event.type === "response.created" && !purpose && toolsPending && event.response?.id) {
      sendOpenAI({ type: "response.cancel", response_id: event.response.id });
    }
    if (event.type === "response.created" && purpose === "hold" && event.response?.id) {
      holdIds.add(event.response.id);
      if (holdActive && !holdCurrent) holdCurrent = event.response.id;
      else sendOpenAI({ type: "response.cancel", response_id: event.response.id });
    }
    if (
      (event.type === "response.output_audio.delta" ||
        event.type === "response.audio.delta") &&
      event.delta
    ) {
      const speech = Buffer.from(event.delta, "base64");
      if (event.response_id && holdIds.has(event.response_id)) {
        if (holdActive && event.response_id === holdCurrent) sendAudio(speech, speech.length);
      } else {
        clearWait();
        if (holdActive) queued.push({ item: event.item_id || "", audio: speech });
        else sendHost(event.item_id || "", speech);
      }
    }
    if (event.type === "response.done" && purpose === "hold") {
      if (event.response?.id === holdCurrent) releaseHold();
      return;
    }
    if (event.type === "response.done" && purpose === "greeting") {
      setTimeout(unlockGreeting, Math.max(0, playbackEnd() - Date.now()));
    }
    if (event.type === "response.done" && event.response?.status === "completed") {
      const calls = (event.response.output ?? []).filter(
        (item) => item.type === "function_call" && item.call_id && item.name,
      );
      if (calls.length) {
        toolsPending += 1;
        applyTurns();
        armWait(playbackEnd() - Date.now() + SILENCE_HOLD_MS);
        toolQueue = toolQueue
          .then(async () => {
            for (const call of calls) {
              let output: unknown;
              try {
                const result = await runDeskTool(doc, desk, call.name!, call.arguments ?? "{}", {
                  connectors,
                  caller,
                });
                desk = result.state;
                output = result.output;
              } catch (err) {
                console.error("[call] tool_error", err instanceof Error ? err.message : err);
                output = { ok: false, reason: "lookup_failed" };
              }
              console.log("[call] tool", JSON.stringify({ name: call.name, args: call.arguments, output }));
              sendOpenAI({
                type: "conversation.item.create",
                ...(call.id ? { previous_item_id: call.id } : {}),
                item: {
                  type: "function_call_output",
                  call_id: call.call_id,
                  output: JSON.stringify(output),
                },
              });
            }
          })
          .catch((err) => console.error("[call] tool_error", err instanceof Error ? err.message : err))
          .finally(() => {
            toolsPending -= 1;
            if (toolsPending) return;
            applyTurns();
            if (!guestTalking) sendOpenAI({ type: "response.create" });
          });
      }
    }
    if (event.type === "error") console.error("[call] openai_error", event);
  });
  openai.on("close", () => {
    stopPump();
    clearWait();
    if (greetTimer) clearTimeout(greetTimer);
    if (holdSafety) clearTimeout(holdSafety);
    twilio.close();
  });
  openai.on("error", (err) => {
    console.error("[call] openai_ws", err.message);
    twilio.close();
  });

  twilio.on("message", (raw) => {
    const data = JSON.parse(String(raw)) as TwilioEvent;
    if (data.event === "start") {
      streamSid = data.start?.streamSid || data.streamSid || "";
      caller = data.start?.customParameters?.caller || null;
      console.log("[call] phone_stream", streamSid);
      startPump();
      scheduleGreeting();
    }
    if (data.event === "media" && data.media?.payload) {
      latestMedia = Number(data.media.timestamp || latestMedia);
      sendOpenAI({
        type: "input_audio_buffer.append",
        audio: data.media.payload,
      });
    }
    if (data.event === "stop") {
      stopPump();
      openai.close();
      twilio.close();
    }
  });
  twilio.on("close", () => {
    stopPump();
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
