export type VoiceStatus =
  | "idle"
  | "connecting"
  | "live"
  | "listening"
  | "speaking"
  | "redirect";

type StatusFn = (status: VoiceStatus) => void;

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
  private audioContext: AudioContext | null = null;
  private raf = 0;
  private bargeTimer = 0;
  private idleTimer = 0;
  private maxTimer = 0;
  private closing = false;
  private speaking = false;
  private awaitingReply = false;
  private closeWait = 0;
  private onStatus: StatusFn;
  private onLevel: (level: number) => void;

  constructor(onStatus: StatusFn, onLevel: (level: number) => void) {
    this.onStatus = onStatus;
    this.onLevel = onLevel;
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
      fetch("/api/session", { method: "POST" }),
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
      }),
    ]);
    const tokenData = await tokenRes.json();
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
      this.maxTimer = window.setTimeout(() => this.finishUp(), 60_000);
      this.send({
        type: "response.create",
        response: {
          instructions: "Hi, this is Bessi. How can I help?",
        },
      });
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
  }

  stop() {
    window.clearTimeout(this.bargeTimer);
    window.clearTimeout(this.idleTimer);
    window.clearTimeout(this.maxTimer);
    this.closing = false;
    this.speaking = false;
    this.awaitingReply = false;
    window.clearTimeout(this.closeWait);
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

  private send(payload: unknown) {
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify(payload));
    }
  }

  private muteOutput(muted: boolean) {
    if (this.remoteEl) this.remoteEl.muted = muted;
  }

  private onEvent(event: { type?: string }) {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (this.closing) return;
        this.bumpIdle();
        window.clearTimeout(this.bargeTimer);
        this.bargeTimer = window.setTimeout(() => {
          this.muteOutput(true);
          this.send({ type: "output_audio_buffer.clear" });
          this.onStatus("listening");
        }, 180);
        break;
      case "input_audio_buffer.speech_stopped":
        if (this.closing) return;
        window.clearTimeout(this.bargeTimer);
        this.awaitingReply = true;
        this.bumpIdle();
        this.onStatus("live");
        break;
      case "response.created":
        this.awaitingReply = true;
        break;
      case "output_audio_buffer.started":
        this.speaking = true;
        this.awaitingReply = false;
        this.bumpIdle();
        this.muteOutput(false);
        this.onStatus("speaking");
        break;
      case "output_audio_buffer.stopped":
        this.speaking = false;
        this.awaitingReply = false;
        if (this.closing) {
          this.stop();
          return;
        }
        this.bumpIdle();
        this.onStatus("live");
        break;
      case "response.done":
        this.awaitingReply = false;
        if (this.closing && !this.speaking) this.stop();
        break;
      default:
        break;
    }
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
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
}
