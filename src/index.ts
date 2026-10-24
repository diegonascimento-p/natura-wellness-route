import { readFileSync, writeFileSync } from "node:fs";
import { buildOrders, formatRoute, parseZones, routeAll } from "./router.js";
import type { Catalog, OrderEvent, Warehouse } from "./router.js";

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8")) as T;

const catalog = load<Catalog>("catalog.json");
const warehouses = load<Warehouse[]>("warehouses.json");
const zones = parseZones(load<Record<string, unknown>>("zones.json"));
const events = load<OrderEvent[]>("orders.json");

const { orders, warnings } = buildOrders(events);
for (const warning of warnings) console.warn(`WARNING ${warning}`);

const lines = routeAll(orders, warehouses, zones, catalog).map(formatRoute);
const output = lines.join("\n") + "\n";
process.stdout.write(output);
writeFileSync(new URL("../routes.txt", import.meta.url), output);
