---
name: velto-web-dev
description: Velto web screens, UI-state and accessibility rules from TZ v4.0; preloaded by the web-dev subagent.
---

# Screens (§9.2) — paths are examples; keep existing routes
login · onboarding (company→warehouse→product→customer→agent; import preview + error download) · dashboard (today's turnover, orders, payments received, overdue debt, 30-day sales chart, agent plan/fact, top debtors) · orders (+ detail with status history/audit, confirm/cancel) · customers (+ card: balance, open invoices, last 10 orders, block reason) · receivables (aging, FIFO view, export) · payments (allocation preview/edit, reversal if permitted) · cash (open/close session, difference+reason) · products · price-lists · stock · purchases/receive · agents · routes · reports (each shows formula + filters) · import/exports (template, preview, mapping, job status) · users · audit (field masking) · settings.

# Every screen
All states: loading/skeleton, empty (states the next step), success, validation error, server error + retry, no-permission. Tables: search/filter/sort/pagination in the standard place. Export button only for permitted roles (server re-checks).

# UX/a11y (§9.1)
Mobile-first; touch targets ≥48px; WCAG 2.1 AA contrast; errors never colour-only (text + icon); locale-correct numbers/dates, money `1 234 567,00 so'm`; uz(Latin)/ru/en with no hardcoded strings (CI checks); theme change must not break features. Money/qty are decimal strings — format only.

# Rules
Frontend validation ≠ security; UI never computes authoritative totals. A visible button must do a real action — no stub/"coming soon" (§3.4). Reports must state date range, currency, status filter, definition (§3.4).
