import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import { buildOrders, expandLines, normalizeSku, normalizeZip, parseZones } from "./router.js";
import type { Catalog, OrderEvent } from "./router.js";

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8")) as T;

const catalog = load<Catalog>("catalog.json");
const zones = parseZones(load<Record<string, unknown>>("zones.json"));
const events = load<OrderEvent[]>("orders.json");

describe("normalizeZip", () => {
  test("pads a numeric ZIP that lost its leading zero (#2033)", () => {
    const result = normalizeZip(2134);
    expect(result.zip).toBe("02134");
    expect(result.prefix).toBe("021");
    expect(result.note).toMatch(/02134/);
  });

  test("takes the prefix of a ZIP+4 without rejecting it (#2039)", () => {
    const result = normalizeZip("07030-1834");
    expect(result.prefix).toBe("070");
    expect(result.note).toBeUndefined();
  });

  test("leaves a normal 5-digit ZIP alone", () => {
    expect(normalizeZip("60614")).toEqual({ zip: "60614", prefix: "606" });
  });

  test.each([[""], ["   "], [null], [undefined]])("treats %j as no ZIP, never 00000", (zip) => {
    expect(normalizeZip(zip)).toEqual({ zip: null, prefix: null });
  });
});

describe("normalizeSku", () => {
  test("trims and uppercases (#2045)", () => {
    expect(normalizeSku(" nw-mag-90 ")).toBe("NW-MAG-90");
  });
});

describe("expandLines", () => {
  test("expands a bundle into components times the ordered quantity", () => {
    const { items } = expandLines([{ sku: "NW-BNDL-ESS", quantity: 2 }], catalog);
    expect(Object.fromEntries(items)).toEqual({ "NW-VITD-60": 2, "NW-MAG-90": 2 });
  });

  test("sums a SKU that appears both alone and inside a bundle", () => {
    const { items } = expandLines(
      [
        { sku: "NW-BNDL-ESS", quantity: 1 },
        { sku: "nw-vitd-60", quantity: 3 },
      ],
      catalog,
    );
    expect(Object.fromEntries(items)).toEqual({ "NW-VITD-60": 4, "NW-MAG-90": 1 });
  });

  test("reports SKUs not in the catalog", () => {
    const { unknownSkus } = expandLines([{ sku: "NW-FAKE-1", quantity: 1 }], catalog);
    expect(unknownSkus).toEqual(["NW-FAKE-1"]);
  });
});

describe("buildOrders", () => {
  const created = (orderNumber: string, at: string): OrderEvent => ({
    type: "order_created",
    orderNumber,
    at,
    shipTo: { country: "US", zip: "07030" },
    lines: [{ sku: "NW-VITD-60", quantity: 1 }],
  });
  const edited = (orderNumber: string, at: string, sku = "NW-MULTI-30"): OrderEvent => ({
    type: "order_edited",
    orderNumber,
    at,
    addedLines: [{ sku, quantity: 1 }],
  });

  test("merges #2041's edit from the real file", () => {
    const { orders, warnings } = buildOrders(events);
    const order = orders.find((o) => o.orderNumber === "#2041");
    expect(order?.lines).toEqual([
      { sku: "NW-VITD-60", quantity: 1 },
      { sku: "NW-MULTI-30", quantity: 1 },
    ]);
    expect(warnings).toEqual([]);
  });

  test("accepts an edit at exactly 30 minutes", () => {
    const { orders } = buildOrders([
      created("#1", "2026-10-20T13:00:00.000Z"),
      edited("#1", "2026-10-20T13:30:00.000Z"),
    ]);
    expect(orders[0]?.lines).toHaveLength(2);
  });

  test("ignores an edit after 30 minutes and warns", () => {
    const { orders, warnings } = buildOrders([
      created("#1", "2026-10-20T13:00:00.000Z"),
      edited("#1", "2026-10-20T13:30:01.000Z"),
    ]);
    expect(orders[0]?.lines).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/#1/);
  });

  test("warns about an edit for an unknown order", () => {
    const { warnings } = buildOrders([edited("#9", "2026-10-20T13:00:00.000Z")]);
    expect(warnings).toHaveLength(1);
  });

  test("sorts by timestamp, so file order doesn't matter", () => {
    const { orders } = buildOrders([
      created("#2", "2026-10-20T13:05:00.000Z"),
      created("#1", "2026-10-20T13:00:00.000Z"),
    ]);
    expect(orders.map((o) => o.orderNumber)).toEqual(["#1", "#2"]);
  });
});

describe("parseZones", () => {
  test("skips the _note key", () => {
    expect(Object.keys(zones).sort()).toEqual(["WH-GA", "WH-NJ", "WH-NV", "WH-TX"]);
  });
});
