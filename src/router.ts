export type Line = { sku: string; quantity: number };

export type ShipTo = { country?: string | null; state?: string | null; zip?: string | number | null };

export type OrderEvent =
  | { type: "order_created"; orderNumber: string; at: string; shipTo: ShipTo; lines: Line[] }
  | { type: "order_edited"; orderNumber: string; at: string; addedLines: Line[] };

export type Order = { orderNumber: string; createdAt: string; shipTo: ShipTo; lines: Line[] };

export type Warehouse = {
  code: string;
  city: string;
  enabled: boolean;
  inventory: Record<string, { available: number; dailyVelocity: number } | undefined>;
};

export type Zones = Record<string, Record<string, number | undefined> | undefined>;

export type Catalog = {
  products: { sku: string }[];
  bundles: { sku: string; components: Line[] }[];
};

export type RouteResult = {
  orderNumber: string;
  destination: string; // warehouse code or PARTNER
  zone: number | null;
  reason: string;
  needsReview: boolean; // domestic order that still ended up at the international partner
};

export const PARTNER = "PARTNER";
export const EDIT_WINDOW_MINUTES = 30;
const PRIORITY = ["WH-NJ", "WH-GA", "WH-NV", "WH-TX"];

export function normalizeZip(zip: unknown): { zip: string | null; prefix: string | null; note?: string } {
  // A numeric ZIP lost its leading zeros when it was serialized; restore them.
  if (typeof zip === "number" && Number.isInteger(zip) && zip >= 0) {
    const padded = String(zip).padStart(5, "0");
    const result = { zip: padded, prefix: padded.slice(0, 3) };
    return padded === String(zip) ? result : { ...result, note: `ZIP ${zip} padded to ${padded}` };
  }
  if (typeof zip !== "string" || zip.trim() === "") return { zip: null, prefix: null };
  // No length check: ZIP+4 ("07030-1834") is valid and only the first 3 digits matter.
  const trimmed = zip.trim();
  return { zip: trimmed, prefix: trimmed.slice(0, 3) };
}

export function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}

export function parseZones(raw: Record<string, unknown>): Zones {
  // Keep only warehouse tables; drops "_note" and any other non-object metadata.
  const zones: Zones = {};
  for (const [code, table] of Object.entries(raw)) {
    if (table !== null && typeof table === "object") zones[code] = table as Record<string, number>;
  }
  return zones;
}

export function buildOrders(
  events: OrderEvent[],
  editWindowMinutes = EDIT_WINDOW_MINUTES,
): { orders: Order[]; warnings: string[] } {
  const warnings: string[] = [];
  const timed = events.flatMap((event) => {
    const time = Date.parse(event.at);
    if (Number.isNaN(time)) {
      warnings.push(`${event.orderNumber}: ${event.type} has unreadable timestamp ${JSON.stringify(event.at)}, skipped`);
      return [];
    }
    return [{ event, time }];
  });
  timed.sort((a, b) => a.time - b.time); // stable, so equal timestamps keep file order

  const orders = new Map<string, Order & { time: number }>();
  for (const { event, time } of timed) {
    if (event.type === "order_created") {
      if (orders.has(event.orderNumber)) {
        warnings.push(`${event.orderNumber}: duplicate order_created ignored`);
        continue;
      }
      orders.set(event.orderNumber, {
        orderNumber: event.orderNumber,
        createdAt: event.at,
        shipTo: event.shipTo,
        lines: event.lines.map((line) => ({ ...line })),
        time,
      });
      continue;
    }

    const order = orders.get(event.orderNumber);
    if (!order) {
      warnings.push(`${event.orderNumber}: order_edited at ${event.at} has no matching order_created, ignored`);
      continue;
    }
    const minutes = (time - order.time) / 60_000;
    if (minutes > editWindowMinutes) {
      warnings.push(
        `${event.orderNumber}: order_edited ${minutes.toFixed(1)} min after creation is outside the ${editWindowMinutes}-min window, ignored`,
      );
      continue;
    }
    for (const added of event.addedLines) {
      const existing = order.lines.find((line) => normalizeSku(line.sku) === normalizeSku(added.sku));
      if (existing) existing.quantity += added.quantity;
      else order.lines.push({ ...added });
    }
  }

  const sorted = [...orders.values()].sort((a, b) => a.time - b.time);
  return { orders: sorted.map(({ time, ...order }) => order), warnings };
}

export function expandLines(
  lines: Line[],
  catalog: Catalog,
): { items: Map<string, number>; unknownSkus: string[]; notes: string[] } {
  const products = new Set(catalog.products.map((p) => normalizeSku(p.sku)));
  const bundles = new Map(catalog.bundles.map((b) => [normalizeSku(b.sku), b.components]));
  const items = new Map<string, number>();
  const unknownSkus: string[] = [];
  const notes: string[] = [];
  const add = (sku: string, quantity: number) => items.set(sku, (items.get(sku) ?? 0) + quantity);

  for (const line of lines) {
    const sku = normalizeSku(line.sku);
    if (sku !== line.sku) notes.push(`SKU ${line.sku} read as ${sku}`);
    const components = bundles.get(sku);
    if (components) {
      const parts = components.map((c) => ({ sku: normalizeSku(c.sku), quantity: c.quantity * line.quantity }));
      for (const part of parts) add(part.sku, part.quantity);
      notes.push(`bundle ${sku} x${line.quantity} expanded to ${parts.map((p) => `${p.sku} x${p.quantity}`).join(" + ")}`);
    } else if (products.has(sku)) {
      add(sku, line.quantity);
    } else {
      unknownSkus.push(sku);
    }
  }
  return { items, unknownSkus, notes };
}

// Smallest available / velocity across the order's SKUs. Null when any velocity is
// missing or zero: the cover is unknown, and the warehouse ranks last on this tiebreak.
export function daysOfCover(warehouse: Warehouse, items: Map<string, number>): number | null {
  let cover = Infinity;
  for (const sku of items.keys()) {
    const stock = warehouse.inventory[sku];
    if (!stock || !(stock.dailyVelocity > 0)) return null;
    cover = Math.min(cover, stock.available / stock.dailyVelocity);
  }
  return Number.isFinite(cover) ? cover : null;
}

function canFulfil(warehouse: Warehouse, items: Map<string, number>): boolean {
  for (const [sku, quantity] of items) {
    if ((warehouse.inventory[sku]?.available ?? 0) < quantity) return false;
  }
  return true;
}

function priorityRank(code: string): number {
  const index = PRIORITY.indexOf(code);
  return index === -1 ? PRIORITY.length : index;
}

// More cover sorts first; unknown (null) cover sorts after any known value, and two unknowns tie.
function compareCover(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

const formatCover = (cover: number | null) => (cover === null ? "unknown" : cover.toFixed(2));

// `reserve` holds the expanded items that were stock-checked, set only when a warehouse was picked.
export type RouteDecision = { result: RouteResult; reserve: Map<string, number> | null };

export function routeOrder(order: Order, warehouses: Warehouse[], zones: Zones, catalog: Catalog): RouteDecision {
  const partner = (reason: string, needsReview: boolean): RouteDecision => ({
    result: { orderNumber: order.orderNumber, destination: PARTNER, zone: null, reason, needsReview },
    reserve: null,
  });

  const country = order.shipTo.country?.trim().toUpperCase();
  if (!country) return partner("no country", true);
  if (country !== "US") return partner(`non-US destination (${country})`, false);

  const zip = normalizeZip(order.shipTo.zip);
  const notes = zip.note ? [zip.note] : [];
  if (!zip.prefix) return partner("no ZIP", true);
  if (!Object.values(zones).some((table) => table?.[zip.prefix!] !== undefined)) {
    return partner([`ZIP prefix ${zip.prefix} not in zones`, ...notes].join("; "), true);
  }

  const expanded = expandLines(order.lines, catalog);
  notes.push(...expanded.notes);
  if (expanded.unknownSkus.length > 0) {
    return partner([`unknown SKU ${expanded.unknownSkus.join(", ")}`, ...notes].join("; "), true);
  }

  const candidates = warehouses
    .filter((w) => w.enabled && canFulfil(w, expanded.items))
    .flatMap((w) => {
      const zone = zones[w.code]?.[zip.prefix!];
      return zone === undefined ? [] : [{ warehouse: w, zone, cover: daysOfCover(w, expanded.items) }];
    });
  if (candidates.length === 0) {
    return partner(["no enabled warehouse has stock for the whole order", ...notes].join("; "), true);
  }

  candidates.sort(
    (a, b) =>
      a.zone - b.zone ||
      compareCover(a.cover, b.cover) ||
      priorityRank(a.warehouse.code) - priorityRank(b.warehouse.code),
  );
  const [best, runnerUp] = candidates as [(typeof candidates)[number], ...typeof candidates];

  let reason = `zone ${best.zone}`;
  if (runnerUp && runnerUp.zone === best.zone) {
    reason +=
      runnerUp.cover === best.cover
        ? ` (tie with ${runnerUp.warehouse.code}, broken by priority)`
        : ` (tie with ${runnerUp.warehouse.code}, more days of cover: ${formatCover(best.cover)} vs ${formatCover(runnerUp.cover)})`;
  }
  return {
    result: {
      orderNumber: order.orderNumber,
      destination: best.warehouse.code,
      zone: best.zone,
      reason: [reason, ...notes].join("; "),
      needsReview: false,
    },
    reserve: expanded.items,
  };
}

// Routes in the given order, reserving stock as it goes. Works on a copy of the inventory.
export function routeAll(orders: Order[], warehouses: Warehouse[], zones: Zones, catalog: Catalog): RouteResult[] {
  const stock: Warehouse[] = structuredClone(warehouses);
  return orders.map((order) => {
    const { result, reserve } = routeOrder(order, stock, zones, catalog);
    const warehouse = stock.find((w) => w.code === result.destination);
    if (warehouse && reserve) {
      for (const [sku, quantity] of reserve) warehouse.inventory[sku]!.available -= quantity;
    }
    return result;
  });
}

export function formatRoute(result: RouteResult): string {
  const review = result.needsReview ? "  [REVIEW: domestic order sent to partner]" : "";
  return `${result.orderNumber.padEnd(7)}${result.destination.padEnd(9)}${result.reason}${review}`;
}
