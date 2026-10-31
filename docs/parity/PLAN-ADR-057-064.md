# ADR-057..064: kod tekshiruvi va reja (architect, 2026-10-31)

Kod o'zgartirilmagan, testlar ishga tushirilmagan: kod va test nomlari bo'yicha statik tekshiruv. Yo'llar `apps/api/src/modules` ga nisbatan.

## Verdiktlar
- **057 GAP (xavfsizlik).** `auth/auth.service.ts:103-116` birinchi mos tenantga kiritadi; `:129-133` birinchi kompaniya nofaol bo'lsa boshqa faol akkauntni bloklaydi; `:103,112` da dummy hash yo'q (timing). Challenge: Redis, `SHA-256(id)` kaliti, TTL 5 daq, `GETDEL`, Redis yo'q bo'lsa fail-closed, opaque handle, companyId qabul qilinmaydi. Ekran: web `login/page.tsx:55`, `lib/auth/auth-context.tsx:66`. Miniapp o'zgarmaydi.
- **058 GAP/BLOCKER.** MFA yo'q, API'da shifrlash helper'i yo'q. `auth.service.ts:214` Telegram login MFA'ni aylanib o'tadi. Tartib: parol -> kompaniya -> TOTP/enrollment -> token. `UserMfa` (AES-256-GCM, AAD `companyId:userId`, `keyVersion`, `lastUsedStep`), `UserMfaRecoveryCode` (argon2id, `usedAt`), `MFA_ENCRYPTION_KEY`, `MFA_REQUIRED_ROLES=['OWNER']`, `Company.mfaExempt` faqat provisioning skripti bilan. Yoqilganda OWNER refresh tokenlari bekor.
- **059 serverda izchil, testlar qisman.** Hujjatlanadigan farqlar: `sales.service.ts:340,366` PRICE_CHANGED, klient float `miniapp/src/lib/offline/pricing.ts:12`, `web/components/orders/order-line-editor.tsx:40`, `Prisma.Decimal` precision=20. Yo'q: `x.xx5` tie testi, klient-server golden vektorlari, kasrli eksport totallari.
- **060 GAP.** Alert yo'q: `payments.service.ts:422`, `stock/stock.service.ts:169,279`. `notifications.service.ts:44-60` Telegram'ni tx ichida yuboradi (rollback'da soxta xabar), `:132` xatoni yutadi. Dizayn: Notification tx ichida, unique `(companyId, recipientId, dedupKey)`, kalit `payment.reverse:<reversalId>`, `stock.adjust:<movementId>`, `telegramStatus/attempts/lastError`, afterCommit + BullMQ retry + sweep. Yetkazish at-least-once.
- **061a GAP.** `payments.service.ts:384,436` `deletedAt` tekshirmaydi; restore yo'li yo'q (`customers.controller.ts:11`), `code` to'qnashuvi hal qilinishi kerak (`customers.service.ts:346`). Tarixiy audit qilinmagan.
- **061b GAP.** `rbac-catalog.ts:122`, `stock/stock.controller.ts:23-24`. Yangi `stock.movements.read` (`stock.read` egalari, agentsiz). Avval additive backfill, keyin route. Iste'molchi faqat web `MovementsSection`.
- **061c GAP.** `customers.service.ts:366-372`. Bloklaydi: DRAFT, SUBMITTED, CONFIRMED, SHIPPED. Bloklamaydi: DELIVERED, CLOSED, CANCELLED. Yangi lock kerak emas, race testi kerak.
- **062 asosan qoplangan.** Test yo'q: 1C CSV'da vergul/qo'shtirnoqli maydon, import o'qishda BOM/CRLF/`;` (`import/parsers/read-workbook.ts:38-42`), `OPENING_FILE_ALREADY_UPLOADED`. **Pul xavfi:** bir xil opening fayl ikkinchi batch sifatida post qilinmasligi isbotlanmagan (`opening-balances.service.ts:203` faqat warning).
- **064 dizayn yetarli, testlar qisman.** Yo'q: export/import rollback'da enqueue yo'qligi, import stale/terminal holat (`import-recovery.service.ts:39`), import worker'ga boshqa companyId, sweep ko'p-tenant. `ImportJob` da attempt soni yo'q.

## Tartib (har biridan keyin reviewer; DB/auth'da security-auditor; oxirida checks)
1. 061a/c read-only audit skripti: `db-rls`, `packages/database/src/`.
2. 057: `api-dev`, keyin `web-dev`, `i18n-sync`. Test: bitta/ko'p/nofaol kompaniya, replay, begona handle, muddat, Redis yo'q, dummy hash.
3. 058 (foydalanuvchi tasdig'idan keyin): `db-rls`, `api-dev`, `web-dev`, `security-auditor`.
4. 061b: `db-rls`, `api-dev`, `web-dev`, `qa-engineer`.
5. 061a guard: `finance-stock`.
6. 061c: `finance-stock`.
7. 061a restore: `db-rls`, `api-dev`, `web-dev`.
8. 060: `db-rls`, `integrations-dev`, `finance-stock`.
9. 059 testlari: `qa-engineer` (semantika diff'i nol).
10. 062 testlari: `qa-engineer`; ikkinchi batch post bo'lsa `finance-stock`.
11. 064 testlari: `qa-engineer`; yetishmovchilik bo'lsa `integrations-dev`.

## Foydalanuvchi qarori kerak
1. TOTP kutubxonasi: `otpauth` 9.5.2 aniq pin (MIT, dep `@noble/hashes`; mustaqil audit tasdiqlanmagan), muqobil `otplib` 13.5.0.
2. OWNER uchun `/auth/telegram` rad etilsinmi (tavsiya: ha). SALES_DIRECTOR/CASHIER MFA pilotga kiradimi (tavsiya: DIRECTOR ha, CASHIER pilot ma'lumotidan keyin).
3. `password-reset.service.ts:37`: bitta SMS barcha tenantdagi parolni almashtirishi saqlanadimi.
4. 060: `reverseMovement` ham alert qiladimi (tavsiya: ha). Opening stock va `reverseForRef` tashqarida (taxmin).
5. DELIVERED, balans 0 mijozni o'chirish ruxsatmi (tavsiya: ha).
