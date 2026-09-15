"use client";

import { useEffect, useRef } from "react";
import type { VoiceStatus } from "@/lib/voice-session";

type Props = {
  status: VoiceStatus;
  level: number;
};

export function Orb({ status, level }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({ status, level, t: 0, mix: 0 });
  state.current.status = status;
  state.current.level = level;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const size = 400;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    let frame = 0;
    const idleColors = [
      ["#dff2ef", "#4f908d"],
      ["#c8ddef", "#587f9e"],
      ["#b8dbce", "#3f776f"],
      ["#efddb8", "#aa8957"],
      ["#e7ebe7", "#708286"],
    ];
    const liveColors = [
      ["#c8f4ea", "#2c9b91"],
      ["#bedff5", "#347da5"],
      ["#a9e2d0", "#25796d"],
      ["#f3dfa9", "#bd8c3d"],
      ["#e5efec", "#587b80"],
    ];
    const toRgb = (hex: string) => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const blend = (from: string, to: string, amount: number) => {
      const a = toRgb(from);
      const b = toRgb(to);
      return `rgb(${a
        .map((value, index) => Math.round(value + (b[index] - value) * amount))
        .join(",")})`;
    };

    const ribbon = (
      phase: number,
      width: number,
      color: string,
      alpha: number,
      energy: number,
    ) => {
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(phase * 0.23);
      ctx.translate(-size / 2, -size / 2);
      ctx.beginPath();
      const amplitude = 25 + energy * 18;
      ctx.moveTo(-60, size * 0.52);
      for (let x = -60; x <= size + 60; x += 12) {
        const y =
          size * 0.5 +
          Math.sin(x * 0.018 + phase) * amplitude +
          Math.sin(x * 0.041 - phase * 1.4) * 10;
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.restore();
    };

    const draw = () => {
      const { status: s, level: l } = state.current;
      const live = s !== "idle" && s !== "connecting";
      const energy = Math.min(1, l * 1.4 + (live ? 0.12 : 0));
      const targetMix = live ? 1 : 0;
      state.current.mix += (targetMix - state.current.mix) * 0.035;
      const mix = state.current.mix;
      state.current.t += 0.005 + energy * 0.018;
      const t = state.current.t;
      const cx = size / 2;
      const cy = size / 2;
      const pulse =
        Math.sin(t * 3.1) * (1.2 + energy * 2.8) +
        Math.sin(t * 6.7) * energy * 1.4;
      const r = size * 0.43 + pulse;

      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();

      const base = ctx.createRadialGradient(
        cx - r * 0.2,
        cy - r * 0.25,
        r * 0.04,
        cx,
        cy,
        r * 1.08,
      );
      base.addColorStop(0, blend("#e8f2ee", "#dcf5ee", mix));
      base.addColorStop(0.34, blend("#8fb9b7", "#69b5ae", mix));
      base.addColorStop(0.7, blend("#456f7b", "#286d78", mix));
      base.addColorStop(1, blend("#1d303c", "#102b38", mix));
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, size, size);

      ctx.globalCompositeOperation = "screen";
      idleColors.forEach(([idleLight, idleDark], index) => {
        const [liveLight, liveDark] = liveColors[index];
        const light = blend(idleLight, liveLight, mix);
        const dark = blend(idleDark, liveDark, mix);
        const phase = t * (0.38 + index * 0.07) + index * 1.31;
        const orbit =
          r * (0.24 + (index % 2) * 0.09 + energy * 0.08);
        const x = cx + Math.cos(phase) * orbit;
        const y = cy + Math.sin(phase * 0.83) * orbit;
        const radius = r * (0.55 + Math.sin(phase * 0.7) * 0.09);
        const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
        g.addColorStop(0, light);
        g.addColorStop(0.46, dark);
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.globalAlpha = 0.58;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      ctx.globalCompositeOperation = "overlay";
      ribbon(
        t * 0.8,
        56,
        blend("#d9eee8", "#bff3e7", mix),
        0.26,
        energy,
      );
      ribbon(
        -t * 0.63 + 2.2,
        38,
        blend("#86afc2", "#65b6c1", mix),
        0.3,
        energy,
      );
      ribbon(
        t * 0.48 + 4.1,
        25,
        blend("#d5e4ef", "#b7dff0", mix),
        0.32,
        energy,
      );
      ribbon(
        -t * 0.34 + 1.4,
        14,
        blend("#f1ddb3", "#f4d795", mix),
        0.28,
        energy,
      );

      ctx.filter = "none";
      ctx.globalCompositeOperation = "soft-light";
      for (let i = 0; i < 7; i += 1) {
        ctx.beginPath();
        const a = t * (0.2 + i * 0.018) + i * 0.78;
        ctx.ellipse(
          cx + Math.cos(a) * r * 0.09,
          cy + Math.sin(a * 0.81) * r * 0.08,
          r * (0.77 - i * 0.055),
          r * (0.18 + i * 0.035),
          a,
          0,
          Math.PI * 2,
        );
        ctx.strokeStyle = `rgba(255, 243, 225, ${0.17 - i * 0.012})`;
        ctx.lineWidth = 7 - i * 0.55;
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "screen";
      for (let i = 0; i < 13; i += 1) {
        const phase = t * (0.18 + (i % 4) * 0.025) + i * 2.399;
        const distance = r * (0.14 + ((i * 37) % 73) / 100);
        const x = cx + Math.cos(phase) * distance;
        const y = cy + Math.sin(phase * 0.91) * distance;
        const mote = 1.2 + (i % 3) * 0.65 + energy;
        ctx.beginPath();
        ctx.arc(x, y, mote, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 242, 220, ${0.18 + (i % 4) * 0.05})`;
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      const shade = ctx.createRadialGradient(
        cx - r * 0.25,
        cy - r * 0.3,
        r * 0.08,
        cx,
        cy,
        r,
      );
      shade.addColorStop(0, "rgba(255, 250, 241, 0)");
      shade.addColorStop(0.57, "rgba(30, 60, 68, 0)");
      shade.addColorStop(0.88, "rgba(18, 45, 56, 0.2)");
      shade.addColorStop(1, "rgba(8, 27, 38, 0.62)");
      ctx.fillStyle = shade;
      ctx.fillRect(0, 0, size, size);

      const shine = ctx.createRadialGradient(
        cx - r * 0.28,
        cy - r * 0.32,
        4,
        cx - r * 0.22,
        cy - r * 0.28,
        r * 0.48,
      );
      shine.addColorStop(0, "rgba(255, 253, 248, 0.82)");
      shine.addColorStop(0.24, "rgba(255, 245, 232, 0.28)");
      shine.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shine;
      ctx.beginPath();
      ctx.ellipse(
        cx - r * 0.25,
        cy - r * 0.32,
        r * 0.3,
        r * 0.13,
        -0.58,
        0,
        Math.PI * 2,
      );
      ctx.fill();

      ctx.restore();

      ctx.beginPath();
      ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 247, 237, 0.48)";
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(17, 49, 61, 0.3)";
      ctx.lineWidth = 1;
      ctx.stroke();

      frame = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={canvasRef} className="orb-canvas" aria-hidden />;
}
