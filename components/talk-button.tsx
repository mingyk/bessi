"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Orb } from "@/components/orb";
import { VoiceSession, type VoiceStatus } from "@/lib/voice-session";

export const IDLE_MS = 30_000;
export const MAX_MS = 60_000;

export function TalkButton() {
  const session = useRef<VoiceSession | null>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [run, setRun] = useState(0);
  const active = status !== "idle";
  const busy = status === "listening" || status === "speaking";

  const hangup = useCallback(() => {
    session.current?.stop();
    session.current = null;
  }, []);

  useEffect(() => {
    return () => {
      session.current?.stop();
      session.current = null;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.callActive = active ? "true" : "false";
    return () => {
      delete document.documentElement.dataset.callActive;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const max = window.setTimeout(hangup, MAX_MS);
    return () => window.clearTimeout(max);
  }, [active, run, hangup]);

  useEffect(() => {
    if (!active || status === "connecting" || busy) return;
    const idle = window.setTimeout(hangup, IDLE_MS);
    return () => window.clearTimeout(idle);
  }, [active, status, busy, hangup]);

  const toggle = useCallback(async () => {
    setError("");
    if (active) {
      hangup();
      return;
    }

    const next = new VoiceSession(setStatus, setLevel);
    session.current = next;
    setRun((value) => value + 1);
    try {
      await next.start();
    } catch (err) {
      next.stop();
      session.current = null;
      setError(
        err instanceof Error && /not allowed|permission/i.test(err.message)
          ? "allow the mic"
          : "try again",
      );
    }
  }, [active, hangup]);

  return (
    <div className="talk">
      <button
        type="button"
        className={`orb ${status}`}
        onClick={toggle}
        aria-pressed={active}
        aria-label={active ? "end" : "talk"}
        style={{ "--voice-level": level } as CSSProperties}
      >
        <span className="orb-wave" aria-hidden />
        <span className="orb-ring orb-ring-one" aria-hidden />
        <span className="orb-ring orb-ring-two" aria-hidden />
        <Orb status={status} level={level} />
      </button>
      {active && status !== "connecting" ? (
        <div
          className="timer-track"
          aria-hidden
        >
          <span
            key={run}
            className="timer-fill"
            style={{ animationDuration: `${MAX_MS}ms` }}
          />
        </div>
      ) : null}
      {error ? <p className="hint">{error}</p> : null}
    </div>
  );
}
