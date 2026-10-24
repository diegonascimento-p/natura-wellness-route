# Natura Wellness order router

Routes each order in `data/orders.json` to a single warehouse, or to PARTNER, following the Part A rules.

## Run

```sh
npm install
npm run route                       # prints routes and writes routes.txt (Part A)
npm run route -- --disable WH-NV    # applies an override; prints only, routes.txt is not changed
npm test                            # vitest
npm run typecheck
```

`--disable` and `--enable` can be repeated. They change a warehouse's `enabled` flag for that run only. The data files are never edited.

## Layout

- `src/router.ts`: pure functions with no I/O. `buildOrders` merges events, `routeOrder` picks a warehouse for one order, `routeAll` routes in creation order and reserves stock on a copy of the inventory.
- `src/index.ts`: reads the files, prints warnings to stderr, and prints one line per order (order, warehouse or PARTNER, zone or reason).
- `src/router.test.ts`: unit tests, plus every order in the real data as I traced it by hand.

## Data issues and how I handled them

| Issue | Order | Handling |
|---|---|---|
| ZIP is the number `2134`, so the leading zero was lost | #2033 | Numeric ZIPs are padded to 5 digits (`02134`, prefix `021`). The state (MA) matches. The reason notes the padding. |
| `country: "CA"` is Canada, but `CA` is also California's state code | #2037 | Routed by `country` only, never by `state`. Goes to PARTNER. |
| ZIP+4 (`07030-1834`) | #2039 | The prefix is the first 3 characters. There is no 5-digit check, so valid ZIP+4s are accepted. |
| Bundle SKU `NW-BNDL-ESS` isn't stocked anywhere | #2040, #2056 | Expanded into components × ordered quantity, with repeated SKUs summed. Stock checks, days of cover and reservations all use the components. The reason notes the expansion. |
| `order_edited` adds an item 18 minutes after creation | #2041 | All events are read first. Edits within 30 minutes (inclusive) are merged, and the order is routed once at its creation-time position. Later edits are ignored with a warning. |
| Hawaii prefix `968` isn't in zones | #2042 | PARTNER, as the rule says, with a review flag (a US order sent to the international partner). |
| Empty ZIP | #2046 | Empty, null and missing ZIPs are all treated as no ZIP (never padded to `00000`). Goes to PARTNER with a review flag. |
| Lowercase SKU `nw-mag-90` | #2045 | Every SKU is trimmed and uppercased before lookup. An SKU still unknown after that goes to PARTNER as "unknown SKU", not as out of stock. |
| `dailyVelocity: 0` | WH-TX | Treated as unknown cover, which ranks last in the tiebreak, so NaN or Infinity never reach a comparison. TX is disabled, so today's results don't change. |
| `_note` key in zones.json | — | Skipped when reading warehouse codes. |

Other choices:
- Events are sorted by timestamp, even though the file is already in order.
- Duplicate `order_created` events and unreadable timestamps are skipped with a warning.
- An order with no country goes to PARTNER.
- Every US order that ends up at PARTNER is flagged `[REVIEW]`.

## Part B

### Question 1: where each order ships today

The ops notes say WH-NV can't ship anything because of water damage. Its `enabled: true` is only stale config. So "the router as it runs today plus the ops notes" means routing with NV disabled (`npm run route -- --disable WH-NV`), which also changes how stock is reserved for later orders. WH-GA routes normally here; Question 2 is a separate decision.

| Order | Ship from | Why |
|---|---|---|
| #2033 | WH-NJ | ZIP padded to 02134. MA confirms prefix 021 (Boston), so the fix is safe without a hold. Zone 3. |
| #2037 | Partner | Canada. Nothing in the ops notes changes that. |
| #2040 | WH-GA | Bundle expanded. NJ has had no Magnesium since #2039, so GA is the only option. Zone 5. |
| #2041 | WH-GA | The edit came 18 minutes after creation, so the order includes Multivitamin. NV has none anyway. Zone 7. |
| #2045 | WH-GA | The lowercase SKU is an obvious typo for a real product. Zone 3. |
| #2050 | WH-NJ | Cascade: GA has 1 Vitamin D left and the order needs 2. Zone 5. |
| #2051 | WH-GA | The router as configured sends it to NV, which can't ship. Without NV, GA (zone 7) beats NJ (zone 8) and has exactly 1 Vitamin D left. |

#2051 is the only one of the seven where the router's answer is wrong in practice.

Disabling NV has a side effect: **#2056** (bundle, NJ) can no longer be shipped by any warehouse. #2051 takes GA's last Vitamin D, and NJ has no Magnesium. I'd **hold it for a person to decide**. Splitting the order or waiting for a restock isn't a choice the router should make on its own.

### Question 2: should the router stop sending orders to WH-GA until Monday?

**I'd ship option 3: route away from GA only when another warehouse is within one zone.**

- **Option 1 (GA off) would send US orders abroad.** With NV down and TX disabled, NJ is the only alternative, and it has 2 Magnesium. Rerouting today's 15 GA orders without GA: 6 of them have no warehouse that can take them, so they'd go to the international partner. For the rest, Priya's numbers still apply: about 70% of GA's ~420 orders a day would pay $2.35 more (~$690/day) for 2 more days in transit, which is about the same as the delay they'd have at GA.
- **Option 3 helps where it's cheap.** For the orders with a warehouse within one zone, rerouting costs about half a day and $0.40, instead of 2 days of backlog. Taking that volume off GA should also help the backlog clear sooner for everyone else.
- **Option 4 isn't viable.** NV is down, so turning it on sends orders to a warehouse that can't ship.

How I'd define and build option 3:
- **Stock-aware:** route away from GA only if a warehouse within one zone can take the whole order and still has at least 2 days of cover after the reservation. Otherwise GA. The cover rule stops reroutes from emptying NJ and pushing its own customers into GA's backlog. Without it, #2036 (Magnesium ×2, a Nevada order) would take NJ's last 2 Magnesium, and #2039, an NJ customer one zone away, would fall back to GA.
- **Ties included:** rerouting a tie costs nothing in shipping and skips the backlog. The same cover rule applies.
- **Implementation:** a temporary zone penalty for GA, applied before the normal ranking, so the stock check and tiebreaks still apply. An on/off switch can't express this.
- **Automatic expiry** on Monday, instead of relying on someone to remember to turn it off.
- **Tell customers** who stay with GA about the delay.

Open question: check with Priya whether her 30% still counts NV as an alternative. Of today's four GA orders whose best alternative is exactly one zone farther, three are Nevada customers who only reach GA because NV is down.
