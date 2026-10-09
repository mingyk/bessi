import { callJson, itemKey, type OrderRequest, type OrderSystem } from "./types";

type Env = Record<string, string | undefined>;
type CloverItem = { id: string; name: string; price: number | null };

export function cloverOrders(env: Env): OrderSystem | null {
  const token = env.CLOVER_API_TOKEN;
  const merchant = env.CLOVER_MERCHANT_ID;
  if (!token || !merchant) return null;
  const base =
    env.CLOVER_ENV === "production"
      ? env.CLOVER_REGION === "eu"
        ? "https://api.eu.clover.com"
        : "https://api.clover.com"
      : "https://apisandbox.dev.clover.com";
  const orderType = env.CLOVER_ORDER_TYPE_ID || "";
  const currency = env.CLOVER_CURRENCY || "USD";
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "Bessi/1.0",
    "Content-Type": "application/json",
  };
  const root = `${base}/v3/merchants/${merchant}`;
  let inventory: Promise<Map<string, CloverItem>> | null = null;

  const loadItems = async () => {
    const found = new Map<string, CloverItem>();
    const data = await callJson("clover", `${root}/items?limit=1000`, { headers });
    for (const item of (data.elements as Record<string, any>[] | undefined) ?? []) {
      if (!item?.id || !item?.name) continue;
      found.set(itemKey(item.name), {
        id: item.id,
        name: item.name,
        price: typeof item.price === "number" ? item.price : null,
      });
    }
    return found;
  };
  const items = () => {
    inventory ??= loadItems().catch((err) => {
      inventory = null;
      throw err;
    });
    return inventory;
  };

  return {
    name: "clover",
    async place(order: OrderRequest) {
      const known = await items();
      const lineItems = order.lines.flatMap((line) => {
        const match = known.get(itemKey(line.name));
        const one = match ? { item: { id: match.id } } : { name: line.name, price: line.unitCents };
        return Array.from({ length: line.quantity }, () => one);
      });
      const data = await callJson("clover", `${root}/atomic_order/orders`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          orderCart: {
            currency,
            state: "open",
            title: `Pickup ${order.pickupSpoken} — ${order.guest}`,
            note: [`Phone order by Bessi for ${order.guest}`, order.phone, `pickup ${order.pickupSpoken}`]
              .filter(Boolean)
              .join(", "),
            ...(orderType ? { orderType: { id: orderType } } : {}),
            lineItems,
          },
        }),
      });
      return {
        id: typeof data.id === "string" ? data.id : "",
        totalCents: typeof data.total === "number" ? data.total : null,
        payLink: null,
        visibleToStaff: true,
      };
    },
    async check(menu: string[]) {
      const report: string[] = [];
      const data = await callJson("clover", root, { headers });
      report.push(`merchant ${String(data.name ?? "?")}`);
      const known = await items();
      const matched = menu.filter((name) => known.has(itemKey(name)));
      const missing = menu.filter((name) => !known.has(itemKey(name)));
      report.push(`inventory has ${known.size} items; ${matched.length}/${menu.length} menu items matched by name`);
      if (missing.length) report.push(`sent as custom lines (not in inventory): ${missing.join(", ")}`);
      if (!orderType) report.push("CLOVER_ORDER_TYPE_ID not set: orders land without a To-Go order type");
      return report;
    },
  };
}
