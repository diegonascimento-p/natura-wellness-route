import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { applyEnabledOverrides, buildOrders, formatRoute, parseZones, routeAll } from "./router.js";
import type { Catalog, OrderEvent, Warehouse } from "./router.js";

// Usage: npm run route -- [--disable WH-NV] [--enable WH-TX]
const { values: args } = parseArgs({
  options: {
    disable: { type: "string", multiple: true, default: [] },
    enable: { type: "string", multiple: true, default: [] },
  },
});
const overrides: Record<string, boolean> = {};
for (const code of args.enable) overrides[code] = true;
for (const code of args.disable) overrides[code] = false;
const hasOverrides = Object.keys(overrides).length > 0;

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8")) as T;

const catalog = load<Catalog>("catalog.json");
const zones = parseZones(load<Record<string, unknown>>("zones.json"));
const events = load<OrderEvent[]>("orders.json");
const { warehouses, warnings: overrideWarnings } = applyEnabledOverrides(
  load<Warehouse[]>("warehouses.json"),
  overrides,
);

const { orders, warnings } = buildOrders(events);
for (const warning of [...overrideWarnings, ...warnings]) console.warn(`WARNING ${warning}`);
if (hasOverrides) {
  const summary = Object.entries(overrides).map(([code, on]) => `${code} ${on ? "enabled" : "disabled"}`);
  console.warn(`Overrides: ${summary.join(", ")} (routes.txt not written)`);
}

const lines = routeAll(orders, warehouses, zones, catalog).map(formatRoute);
const output = lines.join("\n") + "\n";
process.stdout.write(output);
// routes.txt is the Part A answer: only write it for the config as given.
if (!hasOverrides) writeFileSync(new URL("../routes.txt", import.meta.url), output);
