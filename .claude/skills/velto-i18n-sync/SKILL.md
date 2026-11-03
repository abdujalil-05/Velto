---
name: velto-i18n-sync
description: Locale/role catalog sync rules and uz/ru terminology; preloaded by the i18n-sync subagent.
---

Sync targets: (1) role codes in `packages/database/src/rbac-catalog.ts` (single source; seed/bootstrap-owner import it); (2) `apps/web/messages/{uz,ru,en}.json` identical key trees, no empty/English-in-uz-ru values; (3) every role `code` ⇒ `AppShell.roles.<code>` in all 3 locales.

MVP role codes → display (uz): OWNER=Admin · SALES_DIRECTOR=Direktor · SALES_AGENT=Agent · WAREHOUSE=Omborchi · CASHIER=Kassir · ACCOUNTANT=Buxgalter · PLATFORM_ADMIN (platform context only). ADR-003: never delete an existing role; if ACCOUNTANT is missing in seed, flag it — adding needs a db-rls migration.

Uzbek (Latin) glossary (TZ §20): Mijoz=Customer · Nuqta=Outlet · Buyurtma=Order · Faktura=Invoice · To'lov=Payment · Qarzdorlik=Receivables/debt · Ombor=Warehouse · Qoldiq=Stock · Marshrut=Route · Tashrif=Visit · Kassa smenasi=Cash session · Avans=Advance · Chiqim/Kirim=Issue/Receipt.
Formats: money `1 234 567,00 so'm`; uz is Latin script only (Cyrillic is v1.2).
Sync-state wording must keep device vs server distinct: "Saved on this device" ≠ "Synced"; plus "Waiting to sync", "Needs attention". Errors must state cause + next action, never bare "Xatolik yuz berdi".
