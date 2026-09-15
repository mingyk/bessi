import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PHRASE =
  "That's outside what I can help with. Ask me anything about Bessi though.";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function loadKey() {
  try {
    const env = await readFile(join(root, ".env"), "utf8");
    const line = env
      .split(/\r?\n/)
      .find((row) => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=/.test(row));
    if (line) {
      return line
        .slice(line.indexOf("=") + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // Use the environment variable when no project .env exists.
  }
  return process.env.OPENAI_API_KEY;
}

const apiKey = await loadKey();
if (!apiKey) {
  console.error("Set OPENAI_API_KEY before generating the redirect clip.");
  process.exit(1);
}

const response = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "gpt-4o-mini-tts",
    voice: "marin",
    input: PHRASE,
    instructions:
      "Warm, brief, like a support person on a phone call. Not chipper. Not robotic.",
    response_format: "mp3",
  }),
});

if (!response.ok) {
  console.error("TTS failed:", response.status, await response.text());
  process.exit(1);
}

const publicDir = join(root, "public");
await mkdir(publicDir, { recursive: true });
const out = join(publicDir, "redirect.mp3");
await writeFile(out, Buffer.from(await response.arrayBuffer()));
console.log("Wrote public/redirect.mp3");
