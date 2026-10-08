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

export function TalkButton({
  sessionPath = "/api/session",
  maxMs = 60_000,
  decidePath,
}: {
  sessionPath?: string;
  maxMs?: number;
  decidePath?: string;
} = {}) {
  const session = useRef<VoiceSession | null>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [run, setRun] = useState(0);
  const active = status !== "idle";

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

  const toggle = useCallback(async () => {
    setError("");
    if (active) {
      hangup();
      return;
    }

    const next = new VoiceSession(setStatus, setLevel, {
      sessionPath,
      maxMs,
      decidePath,
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
          ? "allow the mic"
          : "try again",
      );
    }
  }, [active, decidePath, hangup, maxMs, sessionPath]);

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
        <div className="timer-track" aria-hidden>
          <span
            key={run}
            className="timer-fill"
            style={{ animationDuration: `${maxMs}ms` }}
          />
        </div>
      ) : null}
      {error ? <p className="hint">{error}</p> : null}
    </div>
  );
}
