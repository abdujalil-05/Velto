# Velto — loyiha holati

> Yangilangan: 2026-10-12 · Manba: `architect` agenti auditi (kod ↔ `docs/VELTO-TZ-v4.0.md` §5.1 va §16).
> Bu hujjat holat uchun. Qoidalar `CLAUDE.md` da. Har katta ishdan keyin shu fayl yangilanadi.
> Audit yuzaki: "Tayyor" = real kod + test bor; chuqur QA o'tkazilmagan.

## Faza tracker (reja: `docs/PLAN.md`)

| Faza | Holat |
|---|---|
| F0 Poydevor va baseline (baza, testlar, M08 tasdiq) | **Deyarli tayyor** — lokal baza ko'tarildi, migratsiyalar qo'llandi, **274/274 test o'tdi** (database 29, api 223, miniapp 22; lint/typecheck/build toza, 2026-10-12). Qoldi: production rol modeli (foydalanuvchi tekshiradi), web testi yo'q, MinIO image yuklanmadi |
| F1 Xavfsizlik va shartnoma (traceId, auth P0, idempotentlik) | **Jarayonda** — F1.1 traceId kodda tayyor (branch `feat/f1-1-trace-id`, review+security PASS, bazasiz 17 test o'tgan; DB testlari kutilmoqda). F1.2–F1.5 boshlanmagan |
| F2 Ombor va moliya yadrosi | Boshlanmagan |
| F3 Dala savdosi va kuryer | Boshlanmagan |
| F4 Offline/sync | Boshlanmagan |
| F5 Hisobot, import/eksport, 1C | Boshlanmagan |
| F6 Platforma | Boshlanmagan |
| F7 Chiniqtirish va reliz | Boshlanmagan |

## Umumiy

MVP kodining katta qismi yozilgan. Asosiy bo'shliqlar: **M08 Xarid yo'q**, **reversal/correction yo'q**, **offline va auth P0 testlari yetarli emas**, **traceId yo'q**. Pilot (1C qabul, backup-restore) hali o'tmagan.

## Modullar (TZ §5.1)

| # | Modul | Holat | Dalil | Yetishmaydi |
|---|---|---|---|---|
| M00 | Platform/tenant | Qisman | `modules/settings`, web `settings` | trial holati, settings testi, `PLATFORM_ADMIN` oqimi (faqat skript) |
| M01 | Auth/RBAC | Qisman | `modules/auth`, `telegram-init-data.ts`, `database/src/rbac-catalog.ts` | refresh-reuse va initData (valid/invalid/expired/replay) testlari, 403+audit testi |
| M02 | Mijozlar/nuqtalar | Tayyor | `modules/customers`, `duplicate-detection.ts` | tarix ko'rinishi tekshirilmagan |
| M03 | Katalog/narx | Tayyor | `modules/catalog/*`, `minPrice` | rasm yuklash tekshirilmagan |
| M04 | Ombor | Qisman | `modules/stock`, concurrent rezerv testi | alohida chiqim endpointi (deliver orqali), reversal/correction |
| M05 | Sotuv | Tayyor | `modules/sales`, `common/document-numbering`, `test/order-flow.e2e.test.ts` | 5 qatorli VAT/chegirma P0 ssenariysi aniq emas |
| M06 | To'lov/qarzdorlik | Qisman | `modules/finance/*` | reversal, avans ko'rinishi (hozir "unallocated"), aging va invoices testlari |
| M07 | Dala savdosi | Qisman | `modules/field/{routes,visits}`, `geo.ts` | GPS no-permission / low-accuracy natijalari |
| M08 | Xarid | **Tayyor (kod+real DB testlari, ADR-011)** | `modules/purchases` (13 test yozilgan), migratsiya `20261012120000_restore_purchasing`, web `/purchases/*` | 14 test real DB'da o'tdi; ad-hoc qabullar ro'yxati va append-only trigger qo'shildi; qoldi: mavjud tenantlar uchun `backfill-permissions.ts`, web e2e |
| M09 | Hisobot | Qisman | `modules/analytics`, finance aging/export | eksport ↔ ekrandagi filtr moslik testi |
| M10 | Integratsiya | Qisman | `integrations/export-1c` (CommerceML+Excel, 4 test), notifications | pilot 1C konfiguratsiyasida qabul |
| M11 | Audit/bildirishnoma | Qisman | `modules/audit`, `notifications` | audit testi, job/xato holati UI |
| M12 | Onboarding | Qisman | `modules/import`, web `onboarding`, `import` | 1000/2000 qator preview va qayta importda dublikat yo'qligi testi |
| M13 | Offline/sync | Qisman | `modules/sync`, `miniapp/src/lib/offline` | stale price/stock conflict UI, pending'ni cleanup o'chirmasligi, logout/revoke testlari |

## P0 qabul mezonlari (§16)

- **§16.1 biznes:** testlangan: FIFO, parallel rezerv, parallel to'lov, clientId idempotentlik. Yo'q/testlanmagan: reversal, avans, aging as-of, GPS 3 natija, hisobot-eksport moslik, 1C pilot sign-off.
- **§16.2 offline:** testlangan: clientId 3x yuborish, DUPLICATE. Yo'q: airplane-mode 20 order, sync uzilishidan tiklanish, stale conflict UI, cleanup himoyasi, logout/revoke/storage error.
- **§16.3 xavfsizlik:** testlangan: RLS (barcha `companyId` jadvallari + FORCE). Yo'q: refresh-reuse, initData replay/expired, 403+audit, secret-scan, backup-restore mashqi.

## TZ ↔ kod nomuvofiqliklari

- **traceId:** F1.1 da qo'shildi (xato javobi, `X-Request-Id`, loglar, BullMQ joblari, `AuditLog.traceId`). Qoldirilgan: `AuditLog.userAgent` ustuni yo'q (TZ §11.4 "kerak bo'lganda") — qaror kerak bo'lsa alohida migratsiya.
- **Rollar:** `rbac-catalog.ts` da 7 ta (OWNER, SALES_DIRECTOR, SALES_AGENT, **COURIER**, WAREHOUSE, CASHIER, ACCOUNTANT). TZ: 6 operatsion + `PLATFORM_ADMIN`. COURIER TZ da yo'q, `PLATFORM_ADMIN` roli yo'q. Katalog bitta joyda (`rbac-catalog.ts`), seed va bootstrap-owner uni import qiladi.
- **Idempotentlik:** `clientId` unique faqat SalesOrder, Payment, Visit da. confirm/deliver/cash-session close da `Idempotency-Key` yo'q.
- **COURIER (ADR-003a, qoladi):** COURIER roli, kuryer marshrut/`assign-courier`, miniapp `delivery/[id]`, web couriers — §5.2 "to'liq logistika" chegarasida.
- Mos: hujjat raqamlash (`DocumentCounter`), RLS qamrovi, portlar (`.env.example` ↔ `env.schema`; prod 3100–3102 `deploy/README.md` da).

## Qarorlar

- **2026-10-12 — ADR-011:** M08 Xarid MVP da QOLADI va tiklanadi (Supplier, PurchaseOrder(+line), GoodsReceipt(+line), qabul → `StockMovement RECEIVE`). Supplier o'chirilishi bekor qilinadi.
- **2026-10-12 — ADR-003a:** COURIER roli va kuryer marshrutlari MVP da QOLADI ("oddiy yetkazish" doirasi, M05). TZ §5.2 dagi to'liq logistika (reys, ekspeditor GPS, dalolatnoma) qurilmaydi. TZ ga ADR sifatida kiritilishi kerak.

## Texnik qarzlar / bloker

- **Hal qilindi (2026-10-12):** lokal baza Docker'da (Postgres 5433, Redis 6380). 102 ta test yiqilishi sababi — ilova roli superuser edi (RLS chetlab o'tilardi); yangi rollar: `velto_owner` (migratsiya), `velto_app` (runtime), `velto_system` (BYPASSRLS). CI ham shu modelga o'tkazildi.
- **Production (F7.0, hozir yopiq — qaror 2026-10-12: avval localhost, prod oxirida):** productionda ilova roli superuser emasligi va obyektlar egasi tekshirilmagan; `DATABASE_MIGRATE_URL` kerak. Runbook: `deploy/README.md`.
- **MinIO** image'i yuklanmadi (`pull access denied`) — S3 kerak bo'ladigan oqimlar lokal tekshirilmagan.
- `stock.receiveForRef` → `ensureStockLevelRow` (upsert): yangi product/ombor juftligiga parallel birinchi kirimda P2002 bo'lishi mumkin (mavjud stock moduli).
- M08: `GET /purchases/receipts` ro'yxati va GoodsReceipt(+Line) uchun UPDATE/DELETE taqiqlovchi trigger (LOW).

## Keyingi qadamlar (ustuvorlik bilan)

1. M08 Xarid tiklash (qaror qabul qilindi): `db-rls` (sxema+RLS+rbac) → `finance-stock`/`api-dev` (modul) → `web-dev` → `i18n-sync` → `qa-engineer` → `reviewer` → `security-auditor`
2. Payment/StockMovement reversal-correction, avans ko'rinishi, aging as-of testi → `finance-stock`, `qa-engineer`
3. traceId/correlation ID: interceptor + error filter + loglar → `api-dev`, keyin `reviewer`
4. Auth P0 testlari: refresh-reuse, initData, 403+audit → `qa-engineer`, `security-auditor`
5. Offline P0: stale conflict UI, cleanup himoyasi, logout/revoke, GPS natijalari → `miniapp-dev`, `api-dev`, `qa-engineer`

## Oxirgi sessiya

- `.claude/agents` (15 agent) va `.claude/skills/velto-*` yaratildi; `CLAUDE.md` yangilandi; `README.md` va shu fayl yozildi.
- Commit qilinmagan: `docs/`, `.claude/`, `README.md`, `CLAUDE.md` o'zgarishlari.
- Git tarixi ma'nosiz commit xabarlariga ega ("a", "sd", "mvp"); keyingi commitlar `feat(finance): ...` shaklida bo'lsin.
