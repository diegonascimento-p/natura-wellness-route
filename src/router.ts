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

export const EDIT_WINDOW_MINUTES = 30;

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
