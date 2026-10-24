# Skills test: order routing (about 1 hour)

Natura Wellness is a fictional online supplement brand made up for this test (any real company with a similar name is unrelated) that ships across the US from several warehouses. Every order has to be routed to one warehouse. We want it to go to the warehouse closest to the customer that can ship the whole order in one parcel.

Use any language, tools, or AI you like. Rough is fine; we're judging your decisions, not polish.

We expect you to use AI, and we'll ask for a link to the conversation. We want to see how you directed it and checked its work, not just what it produced.

## Files in this folder

- `orders.json`: today's order events, in the order they arrived  
- `warehouses.json`: our warehouses with their available stock and how many units of each product they ship per day  
- `zones.json`: the shipping zone from each warehouse to each ZIP prefix (lower is closer, cheaper, and faster)  
- `catalog.json`: products and bundles  
- `ops-notes.md`: recent messages from the operations team

## Part A: order router (about 40 minutes)

Write a script (TypeScript/Node preferred) that routes every order in `orders.json` and prints one line per order: the order number, the warehouse (or PARTNER), and the reason or zone. The routing rules:

1. Orders shipping outside the US go to PARTNER, our international partner warehouse.  
2. An order with no ZIP, or whose ZIP prefix (first three digits) isn't in `zones.json`, goes to PARTNER.  
3. A warehouse can take an order only if it's enabled and has enough available stock for every item. Orders are never split across warehouses.  
4. Of the warehouses that can take it, pick the lowest zone.  
5. If there's a tie, pick the warehouse with the most days of cover for the order. For each product in the order, days of cover is available ÷ daily velocity; the order's cover at a warehouse is the smallest of those.  
6. If it's still tied, use this priority: WH-NJ, WH-GA, WH-NV, WH-TX.  
7. If no warehouse can take it, it goes to PARTNER.

Route orders in the order they were created. Each routed order reserves its stock, so later orders see less. Customers can add items for up to 30 minutes after ordering (an `order_edited` event); route each order once, with everything in it.

For Part A, apply these rules to the files exactly as given; the ops notes come in at Part B. The data is real-world messy. Put your script and the output it printed (`routes.txt`) in a GitHub repo or gist.

## Part B: decisions (about 15 minutes)

Use your Part A results and `ops-notes.md` to prepare answers to these two questions. **You'll discuss your answers and reasoning during your technical call with Sean, our Development Team Lead.**

**Question 1\. Where should each of these orders actually ship from today?**

Answer for the router as it runs today, plus anything in the ops notes that affects where an order can ship. Don't apply your answer to question 4 here; that's a separate decision.

- Orders: \#2033, \#2037, \#2040, \#2041, \#2045, \#2050, \#2051  
- Choices for each: WH-NJ, WH-GA, WH-NV, WH-TX, Partner warehouse, Hold for a person to decide

**Question 2\. Marco asks whether the router should stop sending orders to WH-GA until Monday. What do you ship?**

- Turn WH-GA off in the router until Monday  
- Keep routing to WH-GA as normal  
- Route away from WH-GA only when another warehouse is within one zone of it  
- Turn WH-GA off, and turn WH-NV back on to take the extra volume

## Submission & next steps

Please complete the assessment **within 24 hours of receiving your invitation email**.

Once you've completed the assessment, [book your technical call with Sean](https://calendly.com/sean-raicom/intro-1-on-1-call).

When booking, you'll be asked to provide:

1. **Your GitHub repo or gist link**, containing your script and the `routes.txt` output.  
2. **Your AI conversation link(s):** a share link from ChatGPT, Claude, Gemini, etc. If you worked in an editor like Cursor or Copilot, export the chat into your repo and provide the file path. If you didn't use AI, write "none".

**During the call**, you'll walk Sean through your solution and discuss your answers to Part B’s Questions 1 and 2\. You can also ask questions about the role and the development team.