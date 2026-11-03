---
name: velto-finance-stock
description: Velto order/stock/finance rules and P0 acceptance numbers from TZ v4.0 §6.3–6.6, §10.5, §16.1; preloaded by finance-stock.
---

# Order state machine (§6.3)
`DRAFT → SUBMITTED → CONFIRMED → DELIVERED → CLOSED`; `SUBMITTED → CANCELLED`; cancelling after CONFIRMED is a separate server action (releases reservation, audited). Each transition: transaction + rule check + audit. CLOSED ≠ paid. Partial fulfilment only via `ShipmentLine.deliveredQty`-style rows, with tests, else don't advertise it. Numbers `SO|INV|PAY|PO-{YYYY}-{6}` from `DocumentSequence`, never reused.

# Stock (§6.4)
Movements `RECEIVE/RESERVE/RELEASE/ISSUE/ADJUST` append-only; `StockLevel` is a projection. `available = onHand − reserved`. CONFIRMED reserves under `SELECT … FOR UPDATE`/serializable; reservation is not real issue until goods issue confirmed. Negative stock forbidden by default (explicit company setting + permission). ADJUST needs reason+user+audit. No manual write of stock; admin-only reconciliation job rebuilds from movements.

# Finance (§6.5)
`Invoice open = total − valid allocations − valid credits/adjustments`; `Customer balance = posted receivables − allocated payments − applied credits/advances`. FIFO from oldest open invoice; user override audited (old/new). Overpayment ⇒ advance in ledger, never lost. Payment + allocations validated in ONE transaction; Σallocations ≤ payment. No DELETE of payments — reversal/void. `cachedBalance` updated in the same tx as ledger; daily drift reconciliation alerts. Aging buckets default: not due, 1–7, 8–30, 31–60, 60+ days (as-of date explicit). Offline "agent received cash" ≠ "cashier received/bank confirmed": separate statuses + handover reconciliation. Cash session: open/close, expected vs actual, difference + reason.

# Money (§6.6)
Server computes price, discount (simple %), VAT, totals; ignore client `lineTotal`. Line snapshots price source (priceListId/version), unit, packaging conversion, discount, VAT. Below-minimum price ⇒ reject or require approval authority. VAT rate configurable per company/product with effective dates — never hardcoded. UZS only in MVP. One rounding strategy, tested.

# P0 acceptance to satisfy (§16.1)
Server recomputes 5-line order · two parallel confirms never over-reserve · goods issue updates stock movement + order status as one operation · invoice total matches order snapshot · 1 500 000 so'm over 3 invoices splits FIFO, Σ ≤ payment · reversal keeps original rows and balance/stock recompute matches · aging correct for as-of date.
Race tests required (§10.5): last unit by two agents; two parallel allocations on one payment; two parallel syncs with same clientId; same sequence requested concurrently.
