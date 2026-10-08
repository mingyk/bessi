import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOM_FRAME = 160;
const ROOM_GAIN = 0.08;

function ulawToLinear(u: number) {
  const inv = ~u & 0xff;
  const sign = inv & 0x80;
  const exponent = (inv >> 4) & 7;
  const mantissa = inv & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function linearToUlaw(sample: number) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; exponent -= 1) {
    mask >>= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function loadRoomLoop() {
  return readFileSync(join(process.cwd(), "assets", "restaurant.ulaw"));
}

export function mixRoomFrame(host: Buffer, room: Buffer, roomAt: number) {
  const out = Buffer.alloc(ROOM_FRAME);
  for (let i = 0; i < ROOM_FRAME; i += 1) {
    const speech = ulawToLinear(host[i] ?? 0x7f);
    const bed = ulawToLinear(room[(roomAt + i) % room.length]) * ROOM_GAIN;
    let sample = speech + bed;
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    out[i] = linearToUlaw(sample);
  }
  return { frame: out, next: (roomAt + ROOM_FRAME) % room.length };
}
