export function callLog(kind: string, detail: Record<string, unknown> = {}) {
  const bits = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${print(value)}`);
  console.log(`[call] ${kind}${bits.length ? ` ${bits.join(" ")}` : ""}`);
}

function print(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    return text.includes(" ") ? JSON.stringify(text.slice(0, 240)) : text.slice(0, 240);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
