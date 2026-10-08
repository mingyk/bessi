import {
  INPUT_TRANSCRIPTION,
  DEMO_TURN_SILENCE_MS,
  NAME_TURN_SILENCE_MS,
  turnDetection,
} from "./session-config";
import {
  steerInstructions,
  type DialogueLine,
  type TurnDecision,
} from "./turn-decision";

export type VoiceStatus =
  | "idle"
  | "connecting"
  | "live"
  | "listening"
  | "speaking"
  | "redirect";

type StatusFn = (status: VoiceStatus) => void;

const FILL_AFTER_MS = 500;
const FILL_MIN_SPEECH_MS = 800;
const BARGE_AFTER_MS = 600;
const LOCAL_SPEECH_SHARE = 0.4;
const LOCAL_MIN_SNR = 3;
const LOCAL_GAP_MS = 200;
const FALSE_BARGE_MS = 1500;

function waitForIce(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    setTimeout(done, 180);
  });
}

export class VoiceSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private remoteEl: HTMLAudioElement | null = null;
  private analyser: AnalyserNode | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private remoteQuietSince = 0;
  private remoteHeard = false;
  private audioContext: AudioContext | null = null;
  private roomTone: HTMLAudioElement | null = null;
  private raf = 0;
  private idleTimer = 0;
  private fillTimer = 0;
  private filling = false;
  private filledTurn = false;
  private speechEndAt = 0;
  private transcription: Record<string, unknown> = INPUT_TRANSCRIPTION;
  private lastInputItemId = "";
  private lastHostItemId = "";
  private fillerResponseId = "";
  private fillerHeard = "";
  private recentFillers: string[] = [];
  private serverVadOff = false;
  private localSpeechSince = 0;
  private localQuietSince = 0;
  private noiseFloor = 0;
  private speechLevel = 0;
  private bargeCheck = 0;
  private seenItems = new Set<string>();
  private turnText = "";
  private bargeTimer = 0;
  private maxTimer = 0;
  private closing = false;
  private speaking = false;
  private awaitingReply = false;
  private responseOpen = false;
  private wantsReply = false;
  private speechStartedAt = 0;
  private replyWait = 0;
  private replyHold = 0;
  private replySent = false;
  private replyTries = 0;
  private decisionReady = false;
  private activeResponseId = "";
  private closeWait = 0;
  private opening = "Hi, this is Bessi. How can I help?";
  private openingExact = false;
  private greetingTimer = 0;
  private greetingSent = false;
  private greetingFinished = false;
  private greetLocked = false;
  private turnWaitStart = 0;
  private guestLed = false;
  private guestTalking = false;
  private decidePath = "";
  private decideAbort: AbortController | null = null;
  private expectAbort: AbortController | null = null;
  private toolPath = "";
  private desk: unknown = null;
  private toolBusy = false;
  private turnId = 0;
  private expectId = 0;
  private nameHold = false;
  private steerApplied = false;
  private suppressReply = false;
  private hearChecks = 0;
  private queuedSteer = "";
  private history: DialogueLine[] = [];
  private pendingTranscript = "";
  private expectTranscript = false;
  private maxMs: number;
  private sessionPath: string;
  private onStatus: StatusFn;
  private onLevel: (level: number) => void;

  constructor(
    onStatus: StatusFn,
    onLevel: (level: number) => void,
    options?: { sessionPath?: string; maxMs?: number; decidePath?: string; toolPath?: string },
  ) {
    this.onStatus = onStatus;
    this.onLevel = onLevel;
    this.sessionPath = options?.sessionPath ?? "/api/session";
    this.maxMs = options?.maxMs ?? 60_000;
    this.decidePath = options?.decidePath ?? "";
    this.toolPath = options?.toolPath ?? "";
  }

  async start() {
    this.onStatus("connecting");
    const context = new AudioContext({ latencyHint: "interactive" });
    this.audioContext = context;
    await context.resume().catch(() => undefined);

    const remote = new Audio();
    remote.autoplay = true;
    remote.setAttribute("playsinline", "true");
    this.remoteEl = remote;

    const [tokenRes, localStream] = await Promise.all([
      fetch(this.sessionPath, { method: "POST" }),
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      }),
    ]);
    const tokenData = await tokenRes.json();
    if (tokenData.transcription && typeof tokenData.transcription === "object") {
      this.transcription = tokenData.transcription;
    }
    if (typeof tokenData.greeting === "string" && tokenData.greeting.trim()) {
      this.opening = tokenData.greeting.trim();
      this.openingExact = true;
    }
    if (tokenData.desk && typeof tokenData.desk === "object") this.desk = tokenData.desk;
    if (!tokenRes.ok || typeof tokenData.value !== "string") {
      localStream.getTracks().forEach((track) => track.stop());
      throw new Error(tokenData.error || "Could not start a voice session");
    }

    const pc = new RTCPeerConnection();
    this.pc = pc;

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream || !this.remoteEl) return;
      this.remoteEl.srcObject = stream;
      void this.remoteEl.play().catch(() => undefined);
      if (this.audioContext) {
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 256;
        this.audioContext.createMediaStreamSource(stream).connect(analyser);
        this.remoteAnalyser = analyser;
      }
    };

    this.localStream = localStream;
    this.localStream
      .getTracks()
      .forEach((track) => pc.addTrack(track, this.localStream!));
    this.watchLevel(this.localStream);

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.addEventListener("open", () => {
      this.onStatus("live");
      this.bumpIdle();
      this.maxTimer = window.setTimeout(() => this.finishUp(), this.maxMs);
      if (this.openingExact) this.greetLocked = true;
      this.sayGreeting();
    });
    dc.addEventListener("message", (event) => {
      try {
        this.onEvent(JSON.parse(event.data));
      } catch {
        // ignore malformed events
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: pc.localDescription?.sdp ?? offer.sdp,
      headers: {
        Authorization: `Bearer ${tokenData.value}`,
        "Content-Type": "application/sdp",
      },
    });

    if (!sdpResponse.ok) {
      throw new Error("Voice connection failed");
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });
    this.startRoomTone();
    if (this.decidePath) {
      void fetch(this.decidePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latest: "" }),
      }).catch(() => {});
    }
  }

  private startRoomTone() {
    if (!this.decidePath || this.roomTone) return;
    const room = new Audio("/demo/restaurant.mp3");
    room.loop = true;
    room.volume = 0.08;
    room.setAttribute("playsinline", "true");
    void room.play().catch(() => undefined);
    this.roomTone = room;
  }

  stop() {
    this.decideAbort?.abort();
    this.expectAbort?.abort();
    window.clearTimeout(this.greetingTimer);
    window.clearTimeout(this.bargeTimer);
    window.clearTimeout(this.bargeCheck);
    window.clearTimeout(this.fillTimer);
    window.clearTimeout(this.replyWait);
    window.clearTimeout(this.replyHold);
    window.clearTimeout(this.idleTimer);
    window.clearTimeout(this.maxTimer);
    this.closing = false;
    this.speaking = false;
    this.awaitingReply = false;
    this.responseOpen = false;
    this.wantsReply = false;
    window.clearTimeout(this.closeWait);
    if (this.roomTone) {
      this.roomTone.pause();
      this.roomTone.src = "";
      this.roomTone = null;
    }
    cancelAnimationFrame(this.raf);
    this.dc?.close();
    this.pc?.getSenders().forEach((sender) => sender.track?.stop());
    this.pc?.close();
    this.localStream?.getTracks().forEach((track) => track.stop());
    if (this.remoteEl) {
      this.remoteEl.pause();
      this.remoteEl.srcObject = null;
    }
    this.audioContext?.close().catch(() => undefined);
    this.pc = null;
    this.dc = null;
    this.localStream = null;
    this.analyser = null;
    this.remoteAnalyser = null;
    this.remoteEl = null;
    this.audioContext = null;
    this.onLevel(0);
    this.onStatus("idle");
  }

  private bumpIdle() {
    if (this.closing) return;
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.stop(), 30_000);
  }

  finishUp() {
    if (this.closing) return;
    this.closing = true;
    window.clearTimeout(this.idleTimer);
    window.clearTimeout(this.maxTimer);
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: false,
            },
          },
        },
      },
    });
    if (this.speaking || this.awaitingReply) {
      this.closeWait = window.setTimeout(() => this.stop(), 8_000);
      return;
    }
    this.stop();
  }

  private sayGreeting() {
    if (this.closing || this.greetingSent) return;
    this.greetingSent = true;
    this.greetLocked = true;
    this.responseOpen = true;
    this.setMic(false);
    this.log("greeting", { text: this.opening });
    this.send({
      type: "response.create",
      response: {
        instructions: this.openingExact
          ? `Say exactly this in English and nothing else: ${this.opening}`
          : this.opening,
      },
    });
  }

  private send(payload: unknown) {
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify(payload));
    }
  }

  private setMic(on: boolean) {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = on;
    });
  }

  private muteOutput(muted: boolean) {
    if (this.remoteEl) this.remoteEl.muted = muted;
  }

  private hostBusy() {
    return (
      this.greetLocked ||
      this.toolBusy ||
      ((this.speaking || this.responseOpen) && !this.filling) ||
      (this.wantsReply && !this.replySent)
    );
  }

  private scheduleFill() {
    window.clearTimeout(this.fillTimer);
    if (!this.decidePath || this.closing || this.greetLocked || this.toolBusy) return;
    if (this.speaking || this.responseOpen) return;
    if (this.speechEndAt - this.speechStartedAt < FILL_MIN_SPEECH_MS) return;
    this.fillTimer = window.setTimeout(() => this.fill(), FILL_AFTER_MS);
  }

  private fill() {
    if (this.closing || this.greetLocked || this.guestTalking || this.toolBusy) return;
    if (this.speaking || this.responseOpen) return;
    const turnForThisSpeech = this.turnWaitStart >= this.speechEndAt;
    if (turnForThisSpeech && (this.decisionReady || this.replySent)) return;
    if (!this.lastInputItemId) return;
    this.filling = true;
    this.filledTurn = true;
    this.fillerHeard = "";
    this.responseOpen = true;
    this.awaitingReply = true;
    const input = [{ type: "item_reference", id: this.lastInputItemId }];
    const recent = this.recentFillers.length
      ? ` You recently said ${this.recentFillers.map((line) => `"${line}"`).join(", ")}; say something different from those.`
      : "";
    this.send({
      type: "response.create",
      response: {
        conversation: "none",
        input,
        instructions:
          `You are a restaurant host in the middle of a phone call that is already underway. The caller just spoke and you will answer in a moment. Say only a tiny phone murmur, the way a person actually sounds before they answer — not a sentence, not a translation of an English filler. If the call is in Korean, say only 네, 네네, 아 네, or 음. Never 알겠습니다, 그렇군요, 잠깐만요, 좋아요, 알겠어요, or 잠시만요. If the call is in English, say only okay, mm-hmm, yeah, or gotcha. In any other language, use that same kind of native murmur, not a translated "got it" or "one moment". Use the same language as the caller if they just spoke a full sentence; otherwise stay with the language you have been using.${recent} Never greet, never thank them for calling, never say goodbye, never answer, never ask a question, never mention a name, time, price, or detail, and never say you are checking or looking anything up.`,
        metadata: { kind: "filler" },
        tool_choice: "none",
      },
    });
    this.log("filler", { turn: this.turnId });
  }

  private startReply() {
    if (this.greetLocked) return;
    if (this.closing || this.responseOpen || this.replySent || this.speaking) {
      this.log("reply_skip", {
        turn: this.turnId,
        closing: this.closing,
        responseOpen: this.responseOpen,
        replySent: this.replySent,
        speaking: this.speaking,
      });
      return;
    }
    this.replySent = true;
    this.replyTries += 1;
    this.wantsReply = false;
    this.responseOpen = true;
    this.awaitingReply = true;
    const steer = this.queuedSteer;
    this.queuedSteer = "";
    if (steer) this.steerApplied = true;
    window.clearTimeout(this.fillTimer);
    const followUp = this.filledTurn
      ? "You already acknowledged them out loud. Start directly with the answer, with no acknowledgement."
      : "";
    this.filledTurn = false;
    const note = [steer, followUp].filter(Boolean).join(" ");
    if (note) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: `For this next reply only: ${note}` }],
        },
      });
    }
    this.send({ type: "response.create" });
    this.log("reply", {
      turn: this.turnId,
      afterFiller: Boolean(followUp),
      waitedMs: this.speechEndAt ? Date.now() - this.speechEndAt : null,
      steer: steer || "none",
    });
  }

  private log(event: string, detail: Record<string, unknown> = {}) {
    if (!this.decidePath) return;
    void fetch("/api/demo/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, detail }),
    }).catch(() => undefined);
  }

  private note(speaker: "guest" | "host", text: string) {
    const clean = text.trim();
    if (!clean) return;
    const last = this.history[this.history.length - 1];
    if (last?.speaker === speaker && last.text === clean) return;
    this.history.push({ speaker, text: clean });
    if (this.history.length > 8) this.history.shift();
    this.log(speaker, { turn: this.turnId, text: clean });
  }

  private kickDecide(turn: number, text: string) {
    const latest = text.trim();
    if (!this.decidePath || latest.length < 2) {
      this.decisionReady = true;
      this.flushReply();
      return;
    }
    this.decideAbort?.abort();
    const controller = new AbortController();
    this.decideAbort = controller;
    const history = this.history
      .filter((line) => line.text.trim() !== latest)
      .slice(-6);
    const timer = window.setTimeout(() => controller.abort(), 1200);
    void fetch(this.decidePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latest, history }),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((decision: TurnDecision | null) => {
        window.clearTimeout(timer);
        if (turn !== this.turnId) return;
        this.decisionReady = true;
        if (!decision) {
          this.flushReply();
          return;
        }
        if (decision.steer === "ignore" && !this.nameHold) {
          this.ignoreTurn();
          return;
        }
        let instructions = "";
        if (decision.steer === "noise") {
          instructions = steerInstructions(decision, { repeats: this.hearChecks });
          this.hearChecks += 1;
        } else {
          this.hearChecks = 0;
          instructions = steerInstructions(decision);
        }
        if (!instructions && decision.checkin && decision.steer === "none") {
          instructions = steerInstructions({ ...decision, steer: "resume" });
        }
        if (instructions) this.queuedSteer = instructions;
        this.log("decide", {
          turn: this.turnId,
          steer: decision.steer,
          naming: decision.naming === true,
          checkin: decision.checkin === true,
          hears: this.hearChecks,
          queued: instructions || "none",
        });
        if (this.replySent) {
          this.log("late_jev", { turn: this.turnId });
          return;
        }
        if (!this.wantsReply) return;
        this.flushReply();
      })
      .catch(() => {
        window.clearTimeout(timer);
        if (turn !== this.turnId) return;
        this.decisionReady = true;
        this.flushReply();
      });
  }

  private setServerVad(on: boolean) {
    if (!this.decidePath || this.closing) return;
    if (on !== this.serverVadOff) return;
    this.serverVadOff = !on;
    if (!on) this.guestTalking = false;
    if (on && !this.localSpeechSince) this.send({ type: "input_audio_buffer.clear" });
    this.localSpeechSince = 0;
    this.localQuietSince = 0;
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            transcription: this.transcription,
            turn_detection: on
              ? turnDetection(this.nameHold ? NAME_TURN_SILENCE_MS : DEMO_TURN_SILENCE_MS)
              : null,
          },
        },
      },
    });
  }

  private watchLocalBarge(rms: number) {
    if (this.greetLocked || this.closing) return;
    if (!this.serverVadOff) {
      this.localSpeechSince = 0;
      this.localQuietSince = 0;
      if (this.guestTalking) {
        if (rms > this.noiseFloor * 2) {
          this.speechLevel = this.speechLevel ? this.speechLevel * 0.95 + rms * 0.05 : rms;
        }
      } else if (!this.speaking && !this.responseOpen) {
        this.noiseFloor = this.noiseFloor ? this.noiseFloor * 0.98 + rms * 0.02 : rms;
      }
      return;
    }
    if (!this.noiseFloor || this.speechLevel < this.noiseFloor * LOCAL_MIN_SNR) return;
    const threshold = this.noiseFloor + (this.speechLevel - this.noiseFloor) * LOCAL_SPEECH_SHARE;
    const now = Date.now();
    if (rms >= threshold) {
      if (!this.localSpeechSince) this.localSpeechSince = now;
      this.localQuietSince = 0;
      if (now - this.localSpeechSince >= BARGE_AFTER_MS) this.barge("local");
      return;
    }
    if (!this.localSpeechSince) return;
    if (!this.localQuietSince) this.localQuietSince = now;
    else if (now - this.localQuietSince > LOCAL_GAP_MS) {
      this.localSpeechSince = 0;
      this.localQuietSince = 0;
    }
  }

  private setNameHold(on: boolean) {
    if (this.nameHold === on || this.closing) return;
    this.nameHold = on;
    this.log("name_hold", { on });
    if (this.serverVadOff) return;
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            transcription: this.transcription,
            turn_detection: turnDetection(on ? NAME_TURN_SILENCE_MS : DEMO_TURN_SILENCE_MS),
          },
        },
      },
    });
  }

  private kickExpectName(text: string) {
    const latest = text.trim();
    if (!this.decidePath || latest.length < 2) return;
    this.expectAbort?.abort();
    const controller = new AbortController();
    this.expectAbort = controller;
    const id = ++this.expectId;
    const history = this.history
      .filter((line) => !(line.speaker === "host" && line.text.trim() === latest))
      .slice(-6);
    const timer = window.setTimeout(() => controller.abort(), 1500);
    void fetch(this.decidePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latest, history, ask: "expect_name" }),
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { expectName?: boolean | null } | null) => {
        window.clearTimeout(timer);
        if (!data || id !== this.expectId || typeof data.expectName !== "boolean") return;
        this.setNameHold(data.expectName);
      })
      .catch(() => window.clearTimeout(timer));
  }

  private async runTools(calls: { call_id: string; name: string; arguments: string }[]) {
    const turn = this.turnId;
    this.toolBusy = true;
    for (const call of calls) {
      let output: unknown = { result: "desk_unavailable" };
      try {
        const response = await fetch(this.toolPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: call.name, arguments: call.arguments, state: this.desk }),
        });
        if (response.ok) {
          const data = (await response.json()) as { output?: unknown; state?: unknown };
          output = data.output ?? output;
          if (data.state && typeof data.state === "object") this.desk = data.state;
        }
      } catch {
        // the model still gets an answer so it never waits on a dead call
      }
      this.log("tool", { turn, name: call.name, args: call.arguments, output });
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) },
      });
    }
    this.toolBusy = false;
    if (this.closing) return;
    if (turn !== this.turnId || this.guestTalking) {
      this.afterHost();
      return;
    }
    this.responseOpen = true;
    this.awaitingReply = true;
    this.send({ type: "response.create" });
  }

  private ignoreTurn() {
    if (this.replySent) return;
    this.steerApplied = true;
    this.suppressReply = true;
    this.wantsReply = false;
    this.queuedSteer = "";
    this.log("ignore", { turn: this.turnId });
    window.clearTimeout(this.replyWait);
    window.clearTimeout(this.replyHold);
    this.afterHost();
  }

  private resumeReply(reason: string) {
    if (this.closing || this.greetLocked || this.guestTalking) return;
    if (this.speaking || this.responseOpen) return;
    if (this.replyTries >= 2) return;
    if (!this.queuedSteer) this.queuedSteer = steerInstructions({ steer: "resume" });
    this.log("reply_resume", { turn: this.turnId, reason, tries: this.replyTries });
    this.replySent = false;
    this.wantsReply = true;
    this.decisionReady = true;
    this.flushReply();
  }

  private flushReply() {
    if (this.suppressReply) {
      this.wantsReply = false;
      return;
    }
    if (!this.wantsReply || this.closing || this.replySent || this.greetLocked) return;
    if (this.guestTalking) return;
    window.clearTimeout(this.replyWait);
    window.clearTimeout(this.replyHold);
    if (this.responseOpen || this.speaking) return;
    this.startReply();
  }

  private beginTurn(text: string) {
    const held = this.pendingTranscript.trim();
    const next = text.trim();
    const latest = held && held !== next ? `${held} ${next}`.trim() : next;
    if (!latest) return;
    this.guestLed = true;
    this.turnId += 1;
    this.steerApplied = false;
    this.suppressReply = false;
    this.replySent = false;
    this.replyTries = 0;
    this.decisionReady = false;
    this.queuedSteer = "";
    this.turnWaitStart = Date.now();
    this.pendingTranscript = "";
    this.expectTranscript = false;
    this.wantsReply = true;
    this.turnText = latest;
    this.kickDecide(this.turnId, latest);
    this.onStatus("live");
  }

  private barge(source: "server" | "local" = "server") {
    if (this.closing || this.greetLocked) return;
    if (!this.speaking && !this.responseOpen) return;
    const lostReply = this.replySent && !this.filling;
    const turn = this.turnId;
    if (this.responseOpen) this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    this.speaking = false;
    this.responseOpen = false;
    this.awaitingReply = false;
    this.filling = false;
    this.remoteQuietSince = 0;
    this.setServerVad(true);
    this.log("barge", {
      turn,
      source,
      floor: Number(this.noiseFloor.toFixed(4)),
      speech: Number(this.speechLevel.toFixed(4)),
    });
    window.clearTimeout(this.bargeCheck);
    if (lostReply) {
      this.bargeCheck = window.setTimeout(() => {
        if (this.closing || this.guestTalking || turn !== this.turnId) return;
        if (this.speaking || this.responseOpen) return;
        this.log("barge_false", { turn });
        this.replySent = false;
        this.wantsReply = true;
        this.decisionReady = true;
        this.flushReply();
      }, FALSE_BARGE_MS);
    }
    this.onStatus("listening");
  }

  private audioDone(reason: string) {
    if (!this.speaking && reason !== "cleared") return;
    this.speaking = false;
    this.remoteQuietSince = 0;
    this.log("audio_done", { turn: this.turnId, reason, responseOpen: this.responseOpen });
    if (this.closing) {
      this.stop();
      return;
    }
    this.bumpIdle();
    if (reason !== "stopped" && this.responseOpen) {
      this.responseOpen = false;
      this.awaitingReply = false;
    }
    this.afterHost();
  }

  private afterHost() {
    if (this.speaking || this.responseOpen || this.toolBusy) return;
    this.filling = false;
    this.fillerHeard = "";
    this.setServerVad(true);
    if (this.greetLocked && this.greetingSent) {
      this.releaseGreeting();
      return;
    }
    if (this.closing) {
      this.stop();
      return;
    }
    if (this.wantsReply && !this.replySent) {
      if (this.decisionReady && !this.guestTalking) this.flushReply();
      return;
    }
    const heard = this.pendingTranscript.trim();
    if (heard && !this.guestTalking) {
      this.beginTurn(heard);
      return;
    }
    this.onStatus("live");
  }

  private releaseGreeting() {
    if (!this.greetLocked || this.speaking) return;
    this.greetLocked = false;
    this.greetingFinished = true;
    this.setMic(true);
    this.log("greeting_done", { turn: this.turnId });
    const heard = this.pendingTranscript.trim();
    this.pendingTranscript = "";
    if (heard) this.beginTurn(heard);
    else this.onStatus("live");
  }

  private onEvent(event: {
    type?: string;
    transcript?: string;
    delta?: string;
    item_id?: string;
    response?: {
      id?: string;
      status?: string;
      status_details?: { error?: { type?: string; code?: string; message?: string } };
      output?: {
        id?: string;
        type?: string;
        role?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
      }[];
      metadata?: { kind?: string } | null;
    };
    response_id?: string;
  }) {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (this.closing) return;
        this.bumpIdle();
        this.guestTalking = true;
        this.speechStartedAt = Date.now();
        window.clearTimeout(this.bargeCheck);
        window.clearTimeout(this.fillTimer);
        window.clearTimeout(this.bargeTimer);
        if (!this.greetLocked && (this.speaking || this.responseOpen)) {
          this.bargeTimer = window.setTimeout(() => {
            if (this.guestTalking) this.barge();
          }, BARGE_AFTER_MS);
          return;
        }
        if (this.hostBusy()) return;
        this.onStatus("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        if (this.closing) return;
        window.clearTimeout(this.bargeTimer);
        this.guestTalking = false;
        this.speechEndAt = Date.now();
        this.bumpIdle();
        if (!this.speaking && !this.responseOpen && !this.greetLocked) {
          this.onStatus("live");
          this.scheduleFill();
        }
        break;
      case "input_audio_buffer.committed":
        if (typeof event.item_id === "string") this.lastInputItemId = event.item_id;
        break;
      case "response.created": {
        const id = event.response?.id;
        if (id) this.activeResponseId = id;
        if (id && event.response?.metadata?.kind === "filler") this.fillerResponseId = id;
        this.responseOpen = true;
        this.awaitingReply = true;
        this.setServerVad(false);
        break;
      }
      case "output_audio_buffer.started":
        this.setServerVad(false);
        this.speaking = true;
        this.remoteQuietSince = 0;
        this.awaitingReply = false;
        this.bumpIdle();
        this.muteOutput(false);
        this.onStatus("speaking");
        break;
      case "output_audio_buffer.stopped":
        this.audioDone("stopped");
        break;
      case "output_audio_buffer.cleared":
        this.audioDone("cleared");
        break;
      case "response.done": {
        const id = event.response?.id;
        if (id && this.activeResponseId && id !== this.activeResponseId) break;
        this.responseOpen = false;
        this.awaitingReply = false;
        if (!this.filling) {
          const spoken = event.response?.output?.find(
            (item) => item.type === "message" && item.role === "assistant" && item.id,
          );
          if (spoken?.id) this.lastHostItemId = spoken.id;
        }
        const error = event.response?.status_details?.error;
        const status = event.response?.status ?? "unknown";
        this.log("response_done", {
          turn: this.turnId,
          status,
          speaking: this.speaking,
          ...(error ? { error: error.code || error.type, message: error.message } : {}),
        });
        if (!this.filling && status === "failed") {
          this.resumeReply(status);
          break;
        }
        const calls = (event.response?.output ?? []).flatMap((item) =>
          item.type === "function_call" && item.call_id && item.name
            ? [{ call_id: item.call_id, name: item.name, arguments: item.arguments ?? "{}" }]
            : [],
        );
        if (calls.length && !this.filling && this.toolPath && status === "completed") {
          void this.runTools(calls);
          break;
        }
        this.afterHost();
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (typeof event.transcript !== "string") break;
        const itemId = typeof event.item_id === "string" ? event.item_id : "";
        if (itemId) {
          if (this.seenItems.has(itemId)) break;
          this.seenItems.add(itemId);
        }
        const heard = event.transcript.trim();
        if (!heard) {
          this.afterHost();
          break;
        }
        this.note("guest", heard);
        const hostTalking = (this.speaking || this.responseOpen) && !this.filling;
        if (this.greetLocked || hostTalking) {
          this.pendingTranscript = this.pendingTranscript
            ? `${this.pendingTranscript} ${heard}`
            : heard;
          this.log("held", { turn: this.turnId, text: this.pendingTranscript });
          break;
        }
        if (this.wantsReply && !this.replySent && this.turnText) {
          this.pendingTranscript = this.turnText;
          this.log("merge", { turn: this.turnId, text: `${this.turnText} ${heard}` });
        }
        this.beginTurn(heard);
        break;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (!this.filling || typeof event.delta !== "string") break;
        this.fillerHeard += event.delta;
        if (this.fillerHeard.trim().split(/\s+/).filter(Boolean).length >= 3) {
          this.send({ type: "response.cancel" });
          this.send({ type: "output_audio_buffer.clear" });
          this.log("filler_cut", { turn: this.turnId, text: this.fillerHeard.trim() });
        }
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (typeof event.transcript === "string") {
          const fromFiller = event.response_id
            ? event.response_id === this.fillerResponseId
            : this.filling;
          if (fromFiller) {
            const line = event.transcript.trim();
            this.log("filler_line", { turn: this.turnId, text: line });
            if (line && line.split(/\s+/).filter(Boolean).length < 3) {
              this.recentFillers = [...this.recentFillers.slice(-2), line];
            }
            break;
          }
          this.note("host", event.transcript);
          if (
            !this.greetLocked &&
            event.transcript.trim() !== this.opening
          ) {
            this.kickExpectName(event.transcript);
          }
        }
        break;
      case "error": {
        const error = (event as { error?: { code?: string; message?: string } }).error;
        if (error?.code === "response_cancel_not_active") break;
        this.log("server_error", { code: error?.code ?? null, message: error?.message ?? null });
        break;
      }
      default:
        break;
    }
  }

  private checkHostQuiet() {
    const analyser = this.remoteAnalyser;
    if (!analyser || !this.speaking || this.responseOpen) {
      this.remoteQuietSince = 0;
      return;
    }
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
    if (peak > 3) {
      this.remoteHeard = true;
      this.remoteQuietSince = 0;
      return;
    }
    if (!this.remoteHeard) return;
    const now = Date.now();
    if (!this.remoteQuietSince) this.remoteQuietSince = now;
    else if (now - this.remoteQuietSince > 1500) this.audioDone("quiet");
  }

  private watchLevel(stream: MediaStream) {
    const context = this.audioContext;
    if (!context) return;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.analyser = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const wave = new Float32Array(analyser.fftSize);
    let last = 0;

    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (const value of data) sum += value;
      const next = Math.min(1, sum / data.length / 48);
      if (Math.abs(next - last) > 0.04) {
        last = next;
        this.onLevel(next);
      }
      analyser.getFloatTimeDomainData(wave);
      let energy = 0;
      for (const value of wave) energy += value * value;
      this.watchLocalBarge(Math.sqrt(energy / wave.length));
      this.checkHostQuiet();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
}
