import { existsSync } from "node:fs";
import { connectorsFromEnv } from "../lib/connectors";
import { loadDoc, menuItems } from "../lib/galbi-doc";
import { newDeskState, runDeskTool } from "../lib/host-desk";
import { smsReady } from "../lib/sms";

if (existsSync(".env")) process.loadEnvFile(".env");

const flags = new Set(process.argv.slice(2));
const phone = process.argv.find((arg) => /^\+[1-9]\d{6,14}$/.test(arg)) ?? null;
const doc = loadDoc();
const connectors = connectorsFromEnv();
const menu = menuItems(doc).map((item) => item.name);

async function report(run: () => Promise<string[]>) {
  try {
    for (const line of await run()) console.log(`  ${line}`);
  } catch (err) {
    console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  console.log(`orders: ${connectors.orders?.name ?? "simulated (BESSI_ORDERS not set or keys missing)"}`);
  if (connectors.orders) await report(() => connectors.orders!.check(menu));

  console.log(`waitlist: ${connectors.waitlist?.name ?? "simulated (BESSI_WAITLIST not set or keys missing)"}`);
  if (connectors.waitlist) await report(() => connectors.waitlist!.check());

  console.log(`sms: ${smsReady() ? "ready" : "off (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM)"}`);

  const sandbox =
    (process.env.SQUARE_ENV ?? "sandbox") !== "production" && (process.env.CLOVER_ENV ?? "sandbox") !== "production";

  if (flags.has("--order")) {
    if (!sandbox) console.log("refusing --order against production");
    else {
      const result = await runDeskTool(
        doc,
        newDeskState(),
        "place_togo_order",
        { name: "Bessi Test", items: [{ item: "Galbi", quantity: 2 }, { item: "Soju", quantity: 1 }] },
        { connectors, caller: phone },
      );
      console.log("test order:", JSON.stringify(result.output));
    }
  }

  if (flags.has("--join")) {
    const result = await runDeskTool(
      doc,
      newDeskState(),
      "join_wait_list",
      { name: "Bessi Test", party: 2 },
      { connectors, caller: phone },
    );
    console.log("test wait list join:", JSON.stringify(result.output));
  }
}

void main();
