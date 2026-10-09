import { callJson, type WaitSystem } from "./types";

type Env = Record<string, string | undefined>;

const minutesOf = (seconds: unknown) =>
  typeof seconds === "number" && seconds >= 0 ? Math.round(seconds / 60) : null;

export function waitwhileList(env: Env): WaitSystem | null {
  const key = env.WAITWHILE_API_KEY;
  const location = env.WAITWHILE_LOCATION_ID;
  if (!key || !location) return null;
  const base = "https://api.waitwhile.com/v2";
  const headers = { apikey: key, "Content-Type": "application/json" };

  return {
    name: "waitwhile",
    async status(party) {
      const data = await callJson("waitwhile", `${base}/location-status/${location}`, { headers });
      const reason = typeof data.naEstWaitReason === "string" ? data.naEstWaitReason : null;
      const byParty = data.waitByPartySize as Record<string, number> | undefined;
      const seconds = party != null && byParty && typeof byParty[String(party)] === "number"
        ? byParty[String(party)]
        : data.wait;
      return {
        open: data.isWaitlistOpen !== false && !(reason && reason.startsWith("LOCATION_IS")),
        minutes: minutesOf(seconds),
        parties: typeof data.numWaiting === "number" ? data.numWaiting : null,
        reason,
      };
    },
    async join(guest) {
      const data = await callJson("waitwhile", `${base}/visits`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          locationId: location,
          name: guest.name,
          partySize: guest.party,
          state: "WAITING",
          ...(guest.phone ? { phone: guest.phone } : {}),
        }),
      });
      return {
        id: typeof data.id === "string" ? data.id : "",
        position: typeof data.position === "number" ? data.position : null,
        minutes: minutesOf(data.estWaitDuration),
      };
    },
    async check() {
      const data = await callJson("waitwhile", `${base}/location-status/${location}`, { headers });
      return [
        `location status: ${data.numWaiting ?? "?"} parties waiting, wait ${minutesOf(data.wait) ?? "n/a"} min, waitlist open ${data.isWaitlistOpen ?? "?"}${data.naEstWaitReason ? `, ${String(data.naEstWaitReason)}` : ""}`,
      ];
    },
  };
}
