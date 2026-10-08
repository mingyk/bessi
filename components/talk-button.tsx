"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Orb } from "@/components/orb";
import { VoiceSession, type VoiceStatus } from "@/lib/voice-session";

const CALL_START = "bessi:call-start";
const activeCalls = new Set<string>();

function syncPage() {
  document.documentElement.dataset.callActive =
    activeCalls.size > 0 ? "true" : "false";
}

export function TalkButton({
  sessionPath = "/api/session",
  maxMs = 60_000,
  decidePath,
  toolPath,
  idleLabel,
  liveLabel,
  onEnd,
}: {
  sessionPath?: string;
  maxMs?: number;
  decidePath?: string;
  toolPath?: string;
  idleLabel?: string;
  liveLabel?: string;
  onEnd?: () => void;
} = {}) {
  const id = useId();
  const session = useRef<VoiceSession | null>(null);
  const wasLive = useRef(false);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [run, setRun] = useState(0);
  const active = status !== "idle";
  const live = active && status !== "connecting";

  const hangup = useCallback(() => {
    session.current?.stop();
    session.current = null;
  }, []);

  useEffect(() => {
    return () => {
      session.current?.stop();
      session.current = null;
      activeCalls.delete(id);
      syncPage();
    };
  }, [id]);

  useEffect(() => {
    if (active) activeCalls.add(id);
    else activeCalls.delete(id);
    syncPage();
  }, [active, id]);

  useEffect(() => {
    const onOtherCall = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) hangup();
    };
    window.addEventListener(CALL_START, onOtherCall);
    return () => window.removeEventListener(CALL_START, onOtherCall);
  }, [hangup, id]);

  useEffect(() => {
    if (live) wasLive.current = true;
    if (status === "idle" && wasLive.current) {
      wasLive.current = false;
      onEnd?.();
    }
  }, [live, onEnd, status]);

  const toggle = useCallback(async () => {
    setError("");
    if (active) {
      hangup();
      return;
    }

    window.dispatchEvent(new CustomEvent(CALL_START, { detail: id }));
    const next = new VoiceSession(setStatus, setLevel, {
      sessionPath,
      maxMs,
      decidePath,
      toolPath,
    });
    session.current = next;
    setRun((value) => value + 1);
    try {
      await next.start();
    } catch (err) {
      next.stop();
      session.current = null;
      setError(
        err instanceof Error && /not allowed|permission/i.test(err.message)
          ? "allow the mic to talk"
          : "that didn’t connect. try again.",
      );
    }
  }, [active, decidePath, hangup, id, maxMs, sessionPath, toolPath]);

  const caption =
    error ||
    (status === "connecting" ? "connecting…" : live ? liveLabel : idleLabel);

  return (
    <div className="talk">
      <button
        type="button"
        className={`orb ${status}`}
        onClick={toggle}
        aria-pressed={active}
        aria-label={active ? "hang up" : idleLabel || "talk"}
        style={{ "--voice-level": level } as CSSProperties}
      >
        <span className="orb-wave" aria-hidden />
        <span className="orb-ring orb-ring-one" aria-hidden />
        <span className="orb-ring orb-ring-two" aria-hidden />
        <Orb status={status} level={level} />
      </button>
      <div className={live ? "timer-track is-on" : "timer-track"} aria-hidden>
        {live ? (
          <span
            key={run}
            className="timer-fill"
            style={{ animationDuration: `${maxMs}ms` }}
          />
        ) : null}
      </div>
      {caption ? (
        <p className="hint" aria-live="polite">
          {caption}
        </p>
      ) : null}
    </div>
  );
}
