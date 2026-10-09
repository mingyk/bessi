import { callJson, itemKey, type OrderRequest, type OrderSystem } from "./types";

const VERSION = "2026-07-15";

type Env = Record<string, string | undefined>;
type CatalogEntry = { name: string; variationId: string; cents: number | null };

export function squareOrders(env: Env): OrderSystem | null {
  const token = env.SQUARE_ACCESS_TOKEN;
  const location = env.SQUARE_LOCATION_ID;
  if (!token || !location) return null;
  const base =
    env.SQUARE_ENV === "production"
      ? "https://connect.squareup.com/v2"
      : "https://connect.squareupsandbox.com/v2";
  const currency = env.SQUARE_CURRENCY || "USD";
  const headers = {
    Authorization: `Bearer ${token}`,
    "Square-Version": VERSION,
    "Content-Type": "application/json",
  };
  let catalog: Promise<Map<string, CatalogEntry>> | null = null;

  const loadCatalog = async () => {
    const found = new Map<string, CatalogEntry>();
    let cursor = "";
    do {
      const data = await callJson(
        "square",
        `${base}/catalog/list?types=ITEM${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers },
      );
      for (const object of (data.objects as Record<string, any>[] | undefined) ?? []) {
        const item = object.item_data;
        const variation = item?.variations?.[0];
        if (!item?.name || !variation?.id) continue;
        const cents = variation.item_variation_data?.price_money?.amount;
        found.set(itemKey(item.name), {
          name: item.name,
          variationId: variation.id,
          cents: typeof cents === "number" ? cents : null,
        });
      }
      cursor = typeof data.cursor === "string" ? data.cursor : "";
    } while (cursor);
    return found;
  };
  const items = () => {
    catalog ??= loadCatalog().catch((err) => {
      catalog = null;
      throw err;
    });
    return catalog;
  };

  return {
    name: "square",
    async place(order: OrderRequest) {
      const known = await items();
      const body = {
        idempotency_key: order.key,
        order: {
          location_id: location,
          line_items: order.lines.map((line) => {
            const match = known.get(itemKey(line.name));
            return match
              ? { catalog_object_id: match.variationId, quantity: String(line.quantity) }
              : {
                  name: line.name,
                  quantity: String(line.quantity),
                  base_price_money: { amount: line.unitCents, currency },
                };
          }),
          fulfillments: [
            {
              type: "PICKUP",
              state: "PROPOSED",
              pickup_details: {
                schedule_type: "SCHEDULED",
                pickup_at: order.pickupAt,
                recipient: {
                  display_name: order.guest,
                  ...(order.phone ? { phone_number: order.phone } : {}),
                },
              },
            },
          ],
        },
      };
      const data = await callJson("square", `${base}/online-checkout/payment-links`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const link = data.payment_link as { url?: string; order_id?: string } | undefined;
      const made = (data.related_resources as { orders?: Record<string, any>[] } | undefined)?.orders?.[0];
      return {
        id: link?.order_id ?? made?.id ?? "",
        totalCents: made?.total_money?.amount ?? null,
        payLink: link?.url ?? null,
        visibleToStaff: false,
      };
    },
    async check(menu: string[]) {
      const report: string[] = [];
      const data = await callJson("square", `${base}/locations/${location}`, { headers });
      const place = data.location as Record<string, any> | undefined;
      report.push(
        `location ${place?.name ?? "?"} (${place?.timezone ?? "?"}, ${place?.currency ?? "?"}), status ${place?.status ?? "?"}`,
      );
      const known = await items();
      const matched = menu.filter((name) => known.has(itemKey(name)));
      const missing = menu.filter((name) => !known.has(itemKey(name)));
      report.push(`catalog has ${known.size} items; ${matched.length}/${menu.length} menu items matched by name`);
      if (missing.length) report.push(`sent as custom lines (not in catalog): ${missing.join(", ")}`);
      report.push(
        "orders go out as Square payment links; they reach the POS once the guest pays",
      );
      return report;
    },
  };
}
