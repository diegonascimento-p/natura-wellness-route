import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import {
  applyEnabledOverrides,
  buildOrders,
  daysOfCover,
  expandLines,
  normalizeSku,
  normalizeZip,
  parseZones,
  routeAll,
  routeOrder,
} from "./router.js";
import type { Catalog, OrderEvent, Warehouse } from "./router.js";

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8")) as T;

const catalog = load<Catalog>("catalog.json");
const warehouses = load<Warehouse[]>("warehouses.json");
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

describe("daysOfCover", () => {
  test("is the smallest available / velocity across the order's SKUs", () => {
    const nj = warehouses.find((w) => w.code === "WH-NJ")!;
    const items = new Map([
      ["NW-VITD-60", 1],
      ["NW-MAG-90", 1],
    ]);
    expect(daysOfCover(nj, items)).toBeCloseTo(0.1); // MAG 2/20, not VITD 400/40
  });

  test("returns null for zero velocity instead of Infinity or NaN (WH-TX)", () => {
    const tx = warehouses.find((w) => w.code === "WH-TX")!;
    expect(daysOfCover(tx, new Map([["NW-VITD-60", 1]]))).toBeNull();
  });
});

describe("routeAll on the real data (hand-traced)", () => {
  const { orders } = buildOrders(events);
  const results = routeAll(orders, warehouses, zones, catalog);
  const byOrder = new Map(results.map((r) => [r.orderNumber, r]));

  test("routes every order exactly once", () => {
    expect(results).toHaveLength(26);
    expect(byOrder.size).toBe(26);
  });

  test.each([
    ["#2031", "WH-NJ", 1],
    ["#2032", "WH-GA", 1],
    ["#2033", "WH-NJ", 3], // padded ZIP
    ["#2034", "WH-GA", 5], // tie with NJ, GA has more cover
    ["#2035", "WH-GA", 4], // GA VITD 4 -> 3
    ["#2036", "WH-NV", 2],
    ["#2038", "WH-NV", 4],
    ["#2039", "WH-NJ", 1], // ZIP+4; uses NJ's last 2 MAG
    ["#2040", "WH-GA", 5], // bundle; NJ out of MAG; GA VITD 3 -> 2
    ["#2041", "WH-GA", 7], // merged edit; NV has no MULTI; GA VITD 2 -> 1
    ["#2043", "WH-NV", 3],
    ["#2044", "WH-GA", 6],
    ["#2045", "WH-GA", 3], // lowercase SKU
    ["#2047", "WH-GA", 4],
    ["#2048", "WH-NJ", 5], // tie with GA, NJ has more cover
    ["#2049", "WH-GA", 4],
    ["#2050", "WH-NJ", 5], // cascade: GA has 1 VITD left, needs 2
    ["#2051", "WH-NV", 2], // NV still enabled in Part A
    ["#2052", "WH-NV", 5],
    ["#2053", "WH-NJ", 2],
    ["#2054", "WH-GA", 4],
    ["#2055", "WH-GA", 8], // tie with NJ, GA has more cover
    ["#2056", "WH-GA", 5], // bundle; NJ out of MAG
  ])("%s -> %s zone %i", (orderNumber, destination, zone) => {
    expect(byOrder.get(orderNumber)).toMatchObject({ destination, zone });
  });

  test("mentions normalizations in the reason", () => {
    expect(byOrder.get("#2033")?.reason).toMatch(/02134/);
    expect(byOrder.get("#2045")?.reason).toMatch(/nw-mag-90/);
  });

  test.each([["#2040"], ["#2056"]])("%s notes the bundle expansion", (orderNumber) => {
    expect(byOrder.get(orderNumber)?.reason).toMatch(/bundle NW-BNDL-ESS x1 expanded to NW-VITD-60 x1 \+ NW-MAG-90 x1/);
  });

  test.each([
    ["#2037", /non-US/, false],
    ["#2042", /968/, true],
    ["#2046", /no ZIP/, true],
  ])("%s -> PARTNER", (orderNumber, reason, needsReview) => {
    const r = byOrder.get(orderNumber);
    expect(r).toMatchObject({ destination: "PARTNER", zone: null, needsReview });
    expect(r?.reason).toMatch(reason);
  });

  test("does not mutate the input warehouses", () => {
    expect(warehouses.find((w) => w.code === "WH-GA")?.inventory["NW-VITD-60"]?.available).toBe(4);
  });
});

describe("routeAll edge cases", () => {
  test("cascade: without #2041's edit, #2050 gets GA's VITD at zone 1", () => {
    const lateEdit = events.map((e) =>
      e.type === "order_edited" ? { ...e, at: "2026-10-20T14:30:00.000Z" } : e,
    );
    const { orders } = buildOrders(lateEdit);
    const byOrder = new Map(routeAll(orders, warehouses, zones, catalog).map((r) => [r.orderNumber, r]));
    expect(byOrder.get("#2041")).toMatchObject({ destination: "WH-NV", zone: 2 });
    expect(byOrder.get("#2050")).toMatchObject({ destination: "WH-GA", zone: 1 });
  });

  test("unknown SKU goes to PARTNER with a distinct reason", () => {
    const { orders } = buildOrders([
      {
        type: "order_created",
        orderNumber: "#1",
        at: "2026-10-20T13:00:00.000Z",
        shipTo: { country: "US", zip: "07030" },
        lines: [{ sku: "NW-FAKE-1", quantity: 1 }],
      },
    ]);
    const [r] = routeAll(orders, warehouses, zones, catalog);
    expect(r).toMatchObject({ destination: "PARTNER", needsReview: true });
    expect(r?.reason).toMatch(/unknown SKU/);
  });

  test("no warehouse with full stock goes to PARTNER", () => {
    const { orders } = buildOrders([
      {
        type: "order_created",
        orderNumber: "#1",
        at: "2026-10-20T13:00:00.000Z",
        shipTo: { country: "US", zip: "07030" },
        lines: [{ sku: "NW-MULTI-30", quantity: 10_000 }],
      },
    ]);
    const [r] = routeAll(orders, warehouses, zones, catalog);
    expect(r).toMatchObject({ destination: "PARTNER", zone: null });
    expect(r?.reason).toMatch(/stock/);
  });

  test("falls back to priority NJ, GA, NV, TX when zone and cover tie", () => {
    const twins: Warehouse[] = ["WH-NV", "WH-GA"].map((code) => ({
      code,
      city: "",
      enabled: true,
      inventory: { "NW-VITD-60": { available: 10, dailyVelocity: 1 } },
    }));
    const flat = { "WH-NV": { "070": 3 }, "WH-GA": { "070": 3 } };
    const { orders } = buildOrders([
      {
        type: "order_created",
        orderNumber: "#1",
        at: "2026-10-20T13:00:00.000Z",
        shipTo: { country: "US", zip: "07030" },
        lines: [{ sku: "NW-VITD-60", quantity: 1 }],
      },
    ]);
    expect(routeAll(orders, twins, flat, catalog)[0]?.destination).toBe("WH-GA");
  });

  test("falls back to priority when both tied warehouses have unknown cover", () => {
    const twins: Warehouse[] = ["WH-TX", "WH-NV"].map((code) => ({
      code,
      city: "",
      enabled: true,
      inventory: { "NW-VITD-60": { available: 10, dailyVelocity: 0 } },
    }));
    const flat = { "WH-TX": { "070": 3 }, "WH-NV": { "070": 3 } };
    const { orders } = buildOrders([
      {
        type: "order_created",
        orderNumber: "#1",
        at: "2026-10-20T13:00:00.000Z",
        shipTo: { country: "US", zip: "07030" },
        lines: [{ sku: "NW-VITD-60", quantity: 1 }],
      },
    ]);
    const [r] = routeAll(orders, twins, flat, catalog);
    expect(r?.destination).toBe("WH-NV");
    expect(r?.reason).toMatch(/priority/);
  });

  test("known cover beats unknown cover in a zone tie", () => {
    const twins: Warehouse[] = [
      { code: "WH-NJ", city: "", enabled: true, inventory: { "NW-VITD-60": { available: 10, dailyVelocity: 0 } } },
      { code: "WH-TX", city: "", enabled: true, inventory: { "NW-VITD-60": { available: 1, dailyVelocity: 100 } } },
    ];
    const flat = { "WH-NJ": { "070": 3 }, "WH-TX": { "070": 3 } };
    const { orders } = buildOrders([
      {
        type: "order_created",
        orderNumber: "#1",
        at: "2026-10-20T13:00:00.000Z",
        shipTo: { country: "US", zip: "07030" },
        lines: [{ sku: "NW-VITD-60", quantity: 1 }],
      },
    ]);
    expect(routeAll(orders, twins, flat, catalog)[0]?.destination).toBe("WH-TX");
  });
});

describe("routeOrder", () => {
  test("returns the expanded items it checked, for the reservation", () => {
    const { orders } = buildOrders(events);
    const order = orders.find((o) => o.orderNumber === "#2040")!;
    const { result, reserve } = routeOrder(order, warehouses, zones, catalog);
    expect(result.destination).not.toBe("PARTNER");
    expect(Object.fromEntries(reserve!)).toEqual({ "NW-VITD-60": 1, "NW-MAG-90": 1 });
  });

  test("reserves nothing when the order goes to PARTNER", () => {
    const { orders } = buildOrders(events);
    const order = orders.find((o) => o.orderNumber === "#2037")!;
    expect(routeOrder(order, warehouses, zones, catalog).reserve).toBeNull();
  });
});

describe("applyEnabledOverrides", () => {
  test("overrides enabled on copies, leaving the input alone", () => {
    const { warehouses: overridden, warnings } = applyEnabledOverrides(warehouses, { "WH-NV": false });
    expect(overridden.find((w) => w.code === "WH-NV")?.enabled).toBe(false);
    expect(overridden.find((w) => w.code === "WH-NJ")?.enabled).toBe(true);
    expect(warehouses.find((w) => w.code === "WH-NV")?.enabled).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("warns about an unknown warehouse code", () => {
    expect(applyEnabledOverrides(warehouses, { "WH-XX": false }).warnings).toHaveLength(1);
  });
});

describe("routeAll with WH-NV disabled (Part B, question 1)", () => {
  const { orders } = buildOrders(events);
  const noNv = applyEnabledOverrides(warehouses, { "WH-NV": false }).warehouses;
  const byOrder = new Map(routeAll(orders, noNv, zones, catalog).map((r) => [r.orderNumber, r]));

  test.each([
    ["#2033", "WH-NJ", 3],
    ["#2037", "PARTNER", null],
    ["#2040", "WH-GA", 5],
    ["#2041", "WH-GA", 7],
    ["#2045", "WH-GA", 3],
    ["#2050", "WH-NJ", 5],
    ["#2051", "WH-GA", 7], // takes GA's last VITD
    ["#2056", "PARTNER", null], // cascade from #2051: GA has no VITD left, NJ no MAG
  ])("%s -> %s zone %s", (orderNumber, destination, zone) => {
    expect(byOrder.get(orderNumber)).toMatchObject({ destination, zone });
  });

  test("no order is routed to WH-NV", () => {
    expect([...byOrder.values()].some((r) => r.destination === "WH-NV")).toBe(false);
  });
});

describe("parseZones", () => {
  test("skips the _note key", () => {
    expect(Object.keys(zones).sort()).toEqual(["WH-GA", "WH-NJ", "WH-NV", "WH-TX"]);
  });
});
