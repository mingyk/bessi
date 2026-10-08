import { readFile } from "node:fs/promises";
import { join } from "node:path";

function parseKey(contents: string) {
  const line = contents
    .split(/\r?\n/)
    .find((row) => /^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=/.test(row));
  if (!line) return undefined;
  const value = line.slice(line.indexOf("=") + 1).trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export async function getTypesafeKey() {
  if (process.env.NODE_ENV !== "production") {
    try {
      const localEnv = await readFile(join(process.cwd(), ".env"), "utf8");
      const localKey = parseKey(localEnv);
      if (localKey) return localKey;
    } catch {
      // Fall through to the process environment outside local development.
    }
  }
  return process.env.TYPESAFE_API_KEY;
}
