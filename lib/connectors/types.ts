export type OrderLine = { name: string; quantity: number; unitCents: number };

export type OrderRequest = {
  key: string;
  guest: string;
  phone: string | null;
  lines: OrderLine[];
  pickupAt: string;
  pickupSpoken: string;
};

export type OrderResult = {
  id: string;
  totalCents: number | null;
  payLink: string | null;
  visibleToStaff: boolean;
};

export type WaitStatus = {
  open: boolean;
  minutes: number | null;
  parties: number | null;
  reason: string | null;
};

export type WaitJoin = { id: string; position: number | null; minutes: number | null };

export interface OrderSystem {
  name: string;
  place(order: OrderRequest): Promise<OrderResult>;
  check(menu: string[]): Promise<string[]>;
}

export interface WaitSystem {
  name: string;
  status(party: number | null): Promise<WaitStatus>;
  join(guest: { name: string; party: number; phone: string | null }): Promise<WaitJoin>;
  check(): Promise<string[]>;
}

export type Connectors = { orders: OrderSystem | null; waitlist: WaitSystem | null };

export class ConnectorError extends Error {
  constructor(
    readonly system: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${system} ${status}: ${detail}`);
  }
}

export async function callJson(
  system: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 5000) });
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    data = { raw: raw.slice(0, 300) };
  }
  if (!response.ok) throw new ConnectorError(system, response.status, JSON.stringify(data).slice(0, 400));
  return data;
}

export function itemKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
