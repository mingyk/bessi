import { cloverOrders } from "./clover";
import { squareOrders } from "./square";
import type { Connectors } from "./types";
import { waitwhileList } from "./waitwhile";

export type { Connectors } from "./types";

let cached: Connectors | null = null;

export function connectorsFromEnv(env: Record<string, string | undefined> = process.env): Connectors {
  if (env === process.env && cached) return cached;
  const orders =
    env.BESSI_ORDERS === "clover"
      ? cloverOrders(env)
      : env.BESSI_ORDERS === "square"
        ? squareOrders(env)
        : null;
  const waitlist = env.BESSI_WAITLIST === "waitwhile" ? waitwhileList(env) : null;
  const made = { orders, waitlist };
  if (env === process.env) cached = made;
  return made;
}
