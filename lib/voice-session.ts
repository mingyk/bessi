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
  private outputGain: GainNode | null = null;
  private outputSource: MediaStreamAudioSourceNode | null = null;
  private raf = 0;
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
    this.remoteEl = new Audio();
    this.remoteEl.autoplay = true;
    this.remoteEl.muted = true;

    const [tokenRes, localStream] = await Promise.all([
      fetch("/api/session", { method: "POST" }),
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
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
      if (!stream || !this.audioContext) return;
      if (this.remoteEl) {
        this.remoteEl.srcObject = stream;
        void this.remoteEl.play().catch(() => undefined);
      }
      this.outputSource?.disconnect();
      const source = this.audioContext.createMediaStreamSource(stream);
      const gain = this.audioContext.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(this.audioContext.destination);
      this.outputSource = source;
      this.outputGain = gain;
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
    cancelAnimationFrame(this.raf);
    this.cutOutput();
    this.dc?.close();
    this.pc?.getSenders().forEach((sender) => sender.track?.stop());
    this.pc?.close();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.outputSource?.disconnect();
    this.outputGain?.disconnect();
    if (this.remoteEl) {
      this.remoteEl.pause();
      this.remoteEl.srcObject = null;
    }
    this.audioContext?.close().catch(() => undefined);
    this.pc = null;
    this.dc = null;
    this.localStream = null;
    this.analyser = null;
    this.outputSource = null;
    this.outputGain = null;
    this.remoteEl = null;
    this.audioContext = null;
    this.onLevel(0);
    this.onStatus("idle");
  }

  private send(payload: unknown) {
    if (this.dc?.readyState === "open") {
      this.dc.send(JSON.stringify(payload));
    }
  }

  private cutOutput() {
    const ctx = this.audioContext;
    const gain = this.outputGain;
    if (ctx && gain) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(0, ctx.currentTime);
    }
  }

  private restoreOutput() {
    const ctx = this.audioContext;
    const gain = this.outputGain;
    if (ctx && gain) {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(1, ctx.currentTime);
    }
  }

  private bargeIn() {
    this.cutOutput();
    this.send({ type: "output_audio_buffer.clear" });
    this.send({ type: "response.cancel" });
  }

  private onEvent(event: { type?: string }) {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.bargeIn();
        this.onStatus("listening");
        break;
      case "input_audio_buffer.speech_stopped":
        this.onStatus("live");
        break;
      case "output_audio_buffer.started":
        this.restoreOutput();
        this.onStatus("speaking");
        break;
      case "output_audio_buffer.stopped":
        this.onStatus("live");
        break;
      case "output_audio_buffer.cleared":
        this.cutOutput();
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
