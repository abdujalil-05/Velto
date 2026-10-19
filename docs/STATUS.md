# Velto — loyiha holati

> Yangilangan: 2026-10-19 (v5.0 review qarorlari, ADR-028..033) · Manba: `architect` agenti auditi (kod ↔ `docs/VELTO-MASTER-TZ-v5.0-2026-10-19.md` §5.1 va §16).
> Bu hujjat holat uchun. Qoidalar `CLAUDE.md` da. Har katta ishdan keyin shu fayl yangilanadi.
> Audit yuzaki: "Tayyor" = real kod + test bor; chuqur QA o'tkazilmagan.

## Faza tracker (reja: `docs/PLAN.md`)

| Faza | Holat |
|---|---|
| F0 Poydevor va baseline (baza, testlar, M08 tasdiq) | **Deyarli tayyor** — lokal baza ko'tarildi, migratsiyalar qo'llandi, **274/274 test o'tdi** (database 29, api 223, miniapp 22; lint/typecheck/build toza, 2026-10-12). Qoldi: production rol modeli (foydalanuvchi tekshiradi), web testi yo'q, MinIO image yuklanmadi |
| F1 Xavfsizlik va shartnoma (traceId, auth P0, idempotentlik) | **Jarayonda** — F1.1 traceId ✅ (branch `feat/f1-1-trace-id`); F1.2 auth P0 ✅ (branch `test/f1-2-auth-p0`: refresh-reuse audit, initData 10 daq oyna + 20 foydalanish limiti, constant-time HMAC, 403+audit testlari; 295/295 test). F1.3 idempotentlik ✅ (branch `feat/f1-3-idempotency`: `IdempotencyRecord` + RLS, `@Idempotent()` interceptor (Idempotency-Key ixtiyoriy, 72 soat), order `FOR UPDATE`, stock `ON CONFLICT`, web/miniapp kalit; 312/312 test). F1.4 rollar ADR + ACCOUNTANT cheklovi testi ✅ (branch `test/f1-4-roles-accountant`). F1.5 audit + scan ✅ (branch `feat/f1-5-audit-scan`: audit maskalash `redactAuditJson`, `payment.allocate`/`export.create`/`import.confirm` eventlari, gitleaks CI job (sha256 bilan), `audit --audit-level=high` bloklaydi, zaif paketlar tuzatildi; 340 test: api 283+1 skip, database 35, miniapp 22). F1 FAZASI TUGADI. Eski qoldiq: audit testi + CI secret/dependency scan |
| F2 Ombor va moliya yadrosi | **Jarayonda** — F1 main'ga merge qilindi (lokal, `origin` ga push qilinmagan). F2.1 main'ga merge qilindi (lokal). F2.4 main'ga merge qilindi. F2.5 main'ga merge qilindi. Faza 5 (hisobot, import, 1C) ✅ QISMAN: `feat/f5-reports-import-1c` — F5.1 hisobot eksporti XLSX+CSV (ekran servisi bilan bir xil), `reports.export`, audit `report.export`, `Company.timezone` kun chegarasi; F5.2 import create-only (preview/confirm, bo'lakli yozish + kursor, zip-bomb/qator limiti, 1000 mijoz/2000 mahsulot testi, MinIO'siz e2e); F5.4 bildirishnoma qo'ng'irog'i, import progress UI. **F5.3 (1C eksport mustahkamlash: retry, fileHash, CSV zaxira, reversal bilan lock, davr TZ) BAJARILMAGAN**, sxema tayyor (`ExportJob.fileHash/recordCount/mappingVersion/attemptCount`). Faza 4 (offline/sinxronizatsiya) ✅ kod tomoni: `feat/f4-offline-sync` — `changeSeq` kursori + `SyncTombstone`, push natijalari ACCEPTED/DUPLICATE/REJECTED/CONFLICT/RETRY, `PRICE_CHANGED`, agent doirasi (faqat o'z marshruti), `clientId` egalik tekshiruvi, miniapp Dexie v4 (seq tartib, egalik, karantin), navbat/konflikt ekrani, service worker, yangilanish vaqti ko'rsatkichlari; **qo'lda qurilma matritsasi (§8.5) bajarilmagan**. Faza 3 ✅: `feat/f3-field-courier` — server GPS statusi (6 natija, tashrif bloklanmaydi, `gpsStatus` DB'da, `gpsOk` trigger bilan hosil), `SKIPPED`+sabab, marshrut yakuni validatsiyasi (`routes.finish`, `skip-stop`, 409 `openStops`), kompaniya radius/aniqlik sozlamasi, kunlik in-app alert, web Tashriflar sahifasi, miniapp GPS. Oldingi: `feat/f2-5-reconciliation`: F2.5 ✅ + F2.2 drift job ✅ (kunlik 03:00 Toshkent, faqat aniqlash; `ReconciliationRun/Finding`, `reconciliation.read` OWNER+ACCOUNTANT, `reconciliation.fix` faqat OWNER, in-app alert, `/reconciliation` web sahifa). F2.4 ✅ (qisman yetkazish, `SalesOrderLine.deliveredQty`, 1 order = 1 invoice, qoldiq rezervdan bo'shatiladi, kuryer faqat to'liq; parallel testlar `delivery-race.test.ts`); F2.1 reversal ✅ (Payment/StockMovement append-only trigger, `PaymentReversal`, `payments.reverse`/`stock.reverse`, smena/1C taqiqi), F2.2 avans ✅ qisman (ledger formula, `advance`, `payments.allocate`; **drift reconciliation job + alert yo'q**, backfill skripti yozilgan, ishga tushirilmagan), F2.3 ✅ qisman (aging asOf+TZ guruhlari, invoices, 5 qatorli VAT testi; **yaxlitlash strategiyasi testi yo'q**). F5 dan keyin 698 test (api 552, database 65, miniapp 81). Qoldi: F2.6 parallel testlar (oxirgi qoldiq, sequence); F2.5 qoldiq reconciliation va drift job bajarilgan |
| F3 Dala savdosi va kuryer | **✅** — branch `feat/f3-field-courier` (server GPS 6 natija, marshrut yakuni validatsiyasi, web Tashriflar, miniapp GPS); qoldiq qarzlar "Qarorlar" bo'limida |
| F4 Offline/sync | **✅ kod tomoni** — branch `feat/f4-offline-sync`; **qo'lda qurilma matritsasi (§8.5) bajarilmagan** (pilot qurilmalar ro'yxati kerak) |
| F5 Hisobot, import/eksport, 1C | **Qisman** — F5.1 hisobot eksporti, F5.2 import, F5.4 ✅; **F5.3 (1C mustahkamlash + ACK, ADR-030) bajarilmagan**; web 1C sahifasi va signed URL yo'q |
| F6 Platforma | Boshlanmagan |
| F7 Chiniqtirish va reliz | Boshlanmagan |

## Umumiy

MVP kodining katta qismi yozilgan: F0–F2 asosan, F3 ✅, F4 kod tomoni ✅, F5 qisman (698 test, 2026-10-15). Qolgan bo'shliqlar (v5.0 gap-tahlili): **PENDING_HANDOVER** (ADR-029), **1C ACK + eksport mustahkamlash** (ADR-030), majburiy rad etish sababi, opening balance importi, qurilma matritsasi, signed URL, PWA manifest, trial/onboarding, outbox/rate-limit/live-ready/runbook/restore drill. Pilot (1C qabul, backup-restore mashqi) hali o'tmagan. Qaror: MVP/v0.9/v1.0 da faqat Mode A (ADR-028).

## Modullar (TZ §5.1)

| # | Modul | Holat | Dalil | Yetishmaydi |
|---|---|---|---|---|
| M00 | Platform/tenant | Qisman | `modules/settings`, web `settings` | trial holati, settings testi, `PLATFORM_ADMIN` oqimi (faqat skript) |
| M01 | Auth/RBAC | Deyarli tayyor | `modules/auth`, `telegram-init-data.ts`, `rbac-catalog.ts`; testlar: refresh rotation/reuse, initData valid/invalid/expired/replay, 403+audit | logout-all alohida endpoint yo'q; login limitining HTTP orqali 10 urinish zanjiri testlanmagan; ACCOUNTANT cheklovi testi |
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

- **§16.1 biznes:** testlangan: FIFO, parallel rezerv/to'lov, clientId idempotentlik, reversal, avans, aging as-of, GPS natijalari. Yo'q: PENDING_HANDOVER oqimi, yaxlitlash strategiyasi testi, hisobot-eksport filtr moslik testi (qisman), 1C pilot sign-off.
- **§16.2 offline:** kod+testlar F4 da (clientId 3x, DUPLICATE, konflikt UI, cleanup himoyasi, quota). Yo'q: qurilmalarda qo'lda airplane-mode/20 order/mid-sync cut matritsasi.
- **§16.3 xavfsizlik:** testlangan: RLS (FORCE), refresh-reuse, initData replay/expired, 403+audit, secret/dependency scan (F1). Yo'q: backup-restore mashqi, pentest, signed URL, rate-limit sozlamalari.

## TZ ↔ kod nomuvofiqliklari

- **traceId:** F1.1 da qo'shildi (xato javobi, `X-Request-Id`, loglar, BullMQ joblari, `AuditLog.traceId`). Qoldirilgan: `AuditLog.userAgent` ustuni yo'q (TZ §11.4 "kerak bo'lganda") — qaror kerak bo'lsa alohida migratsiya.
- **Rollar:** `rbac-catalog.ts` da 7 operatsion rol (OWNER, SALES_DIRECTOR, SALES_AGENT, COURIER, WAREHOUSE, CASHIER, ACCOUNTANT) — TZ v5.0 §4.1 bilan mos; `PLATFORM_ADMIN` rol/endpoint emas (ADR-003b). Katalog bitta joyda, seed va bootstrap-owner import qiladi.
- **Idempotentlik (F1.3, ADR-031):** create = `clientId` (SalesOrder, Payment, Visit, sync), holat o'tishi = `Idempotency-Key` (`@Idempotent()`, `IdempotencyRecord`, 72 soat). TZ §7.1/§7.6.1 shunga moslangan.
- **COURIER (ADR-003a, qoladi):** COURIER roli, kuryer marshrut/`assign-courier`, miniapp `delivery/[id]`, web couriers — §5.2 "to'liq logistika" chegarasida.
- Mos: hujjat raqamlash (`DocumentCounter`), RLS qamrovi, portlar (`.env.example` ↔ `env.schema`; prod 3100–3102 `deploy/README.md` da).

## Qarorlar

- **2026-10-12 — ADR-011:** M08 Xarid MVP da QOLADI va tiklanadi (Supplier, PurchaseOrder(+line), GoodsReceipt(+line), qabul → `StockMovement RECEIVE`). Supplier o'chirilishi bekor qilinadi.
- **2026-10-12 — ADR-003a:** COURIER roli va kuryer marshrutlari MVP da QOLADI ("oddiy yetkazish" doirasi, M05). TZ §5.2 dagi to'liq logistika (reys, ekspeditor GPS, dalolatnoma) qurilmaydi. TZ ga ADR sifatida kiritilishi kerak.

- **2026-10-12 — ADR-003a/b/c (F1.4):** COURIER qoladi; `PLATFORM_ADMIN` MVP'da rol emas (faqat `velto_system` skriptlari, support access yo'q); ACCOUNTANT faqat o'qish/eksport, `audit.read` yo'q. TZ §4.1 va §19 ga kiritildi; testlar: `rbac-catalog.test.ts`, `accountant-restrictions.e2e.test.ts` (branch `test/f1-4-roles-accountant`).

- **2026-10-13 — F2.1 qarorlari (ADR-015..018):** reversal faqat OWNER+SALES_DIRECTOR (`payments.reverse`, `stock.reverse`; ACCOUNTANT yo'q, ADR-003c); yopilgan smena yoki 1C ga eksport qilingan to'lovni qaytarish TAQIQ (predikatlar cash-sessions va export-1c processor bilan bir xil); ombor reversali faqat qo'lda RECEIVE/ADJUST; aging guruhlari TZ §6.5: muddati kelmagan/1–7/8–30/31–60/60+ (`asOf`, Asia/Tashkent); avans keyingi fakturaga avtomatik qo'llanmaydi, faqat qo'lda (`POST /payments/:id/allocate`, ruxsat `payments.allocate`: OWNER/SALES_DIRECTOR/CASHIER, agent va ACCOUNTANT'da yo'q); avans taqsimi yopilgan smena/1C to'lovida RUXSAT; mijozni o'chirish faqat balans aniq 0 bo'lganda (qarz va kredit uchun alohida xato). Mijoz qulfi tartibi: payment → customer → invoices; deliver: SalesOrder → Customer → StockLevel → DocCounter → Invoice; sync push mijozlarni id asc tartibida oldindan qulflaydi.

## Texnik qarzlar / bloker

- **Qaror (2026-10-12) initData:** `auth_date` oynasi 10 daq (`TELEGRAM_INITDATA_MAX_AGE_SECONDS`), bir `hash` oyna ichida ko'pi bilan 20 marta (`TELEGRAM_INITDATA_MAX_USES`), Redis ishlamasa login rad etiladi (fail-closed). Sabab: Mini App bir launch'da bir xil initData ni qayta yuboradi (telefon polling, /auth/me retry, logout-reload).
- **Hal qilindi (2026-10-12):** lokal baza Docker'da (Postgres 5433, Redis 6380). 102 ta test yiqilishi sababi — ilova roli superuser edi (RLS chetlab o'tilardi); yangi rollar: `velto_owner` (migratsiya), `velto_app` (runtime), `velto_system` (BYPASSRLS). CI ham shu modelga o'tkazildi.
- **Production (F7.0, hozir yopiq — qaror 2026-10-12: avval localhost, prod oxirida):** productionda ilova roli superuser emasligi va obyektlar egasi tekshirilmagan; `DATABASE_MIGRATE_URL` kerak. Runbook: `deploy/README.md`.
- **MinIO** image'i yuklanmadi (`pull access denied`) — S3 kerak bo'ladigan oqimlar lokal tekshirilmagan.
- `stock.receiveForRef` → `ensureStockLevelRow` (upsert): yangi product/ombor juftligiga parallel birinchi kirimda P2002 bo'lishi mumkin (mavjud stock moduli).
- **F1.3 qarori (ADR-012):** create'larda scoped `clientId`; holat o'tishlarida (confirm/deliver/cash close) Postgres `IdempotencyRecord` (RLS, tx ichida, unique(companyId,key), 72 soat). Redis ishlatilmaydi. Header ixtiyoriy, row lock har doim.
- F1.3 qarzlar (LOW): unique `(companyId,key)` da `userId` yo'q (boshqa user kalitni band qilib DoS qilishi mumkin); hash'ga query string kirmaydi; `/stock/receive`, `/stock/adjust` da `clientId`/idempotentlik borligi tekshirilmagan; `pnpm audit --prod`: 44 ziyofa (3 kritik, 21 yuqori) — ko'rib chiqilmagan.
- **F1.5 qarori (ADR-013/014):** CI: har qanday secret = fail, prod dependency high/critical = fail (istisno faqat `docs/security/risk-acceptance.md` da muddatli imzo bilan), moderate/low = warn. Audit `oldValue/newValue` markaziy deny-list bilan maskalanadi (eski yozuvlar o'zgarmaydi, append-only).
- F1.5 qarzlar: gitleaks lokal tarix skani bajarilmagan (allowlist taxminiy); `.env.example` butun fayl allowlist'da; `actions/checkout@v4` SHA bilan qotirilmagan; `ImportJob.createdBy` yo'q (actor = confirm qilgan user); import e2e `it.skip` (MinIO yo'q); 10 moderate/low ziyofa major yangilanishni talab qiladi (next-intl 4, Nest 11 → v1.1); risk-acceptance imzolovchisi belgilanmagan; avans uchun `payment.allocate` yozilmaydi (faqat `payment.create`); rol o'zgarishi alohida `role.change` event emas.
- **2026-10-13 — F2.4 qarorlari:** MVP'da bitta order = bitta goods issue/invoice (TZ §6.6); `deliveredQty` `SalesOrderLine`da (Shipment jadvali v1.1); yetkazilmagan qoldiq rezervdan RELEASE qilinadi, order DELIVERED; invoice va `order.total` (DELIVERED/CLOSED holatda) yetkazilgan miqdordan, HALF_UP 2 xona (`line-total.ts`); over-delivery taqiqlangan (`OverDeliveryException`, DB CHECK); qisman yetkazish web'da (ombor/direktor), kuryer `lines` yuborsa 403; StockLevel qulflari productId asc. Analytics (aylanma, agent, dashboard) yetkazilgan summadan hisoblaydi. Yaxlitlash: qator darajasida HALF_UP — biznes tasdiqlashi kerak (1C bilan kopeyka farqi).

- **2026-10-13 — F2.5 qarorlari (ADR-019):** reconciliation faqat aniqlaydi va hisobot beradi, avto-tuzatish yo'q; tuzatish faqat `reconciliation.fix` (OWNER) bilan, finding bo'yicha, audit `reconciliation.fix` bilan; ledger qatorlariga tegilmaydi, faqat StockLevel/cachedBalance proyeksiyasi. Tolerance 0, kunlik 03:00 Asia/Tashkent, alert in-app (OWNER stock+balance, ACCOUNTANT faqat balance, kuniga 1). Detect REPEATABLE READ snapshot'da, qulfsiz; fix advisory try-lock (409 `RECONCILIATION_BUSY`). ACCOUNTANT `stock.read`siz STOCK topilmalarini ko'rmaydi. StockMovement qty konvensiyasi: RECEIVE/RESERVE/RELEASE/ISSUE doim musbat, faqat ADJUST va reversal ishorali (seed.ts shunga moslandi).
- F2.5 qarzlar: drift o'z-o'zidan yo'qolgan OPEN finding eski qiymat bilan OPEN qoladi (fix → `ALREADY_CONSISTENT`); kunlik alert dedupe faqat sana bo'yicha (ertalabki qo'lda run keyin 03:00 run alertini yutishi mumkin); findings'da mahsulot/ombor/mijoz nomi yo'q (faqat id); mavjud tenantlarda `backfill-permissions.ts` ishga tushirilishi shart (aks holda OWNER `/reconciliation` ni ko'rmaydi); web'da notifications UI yo'q.

- **2026-10-13 — F3 qarorlari (ADR-006a, ADR-003a qo'shimchasi):** server GPS natijasini 6 statusga ajratadi (VERIFIED/OUTSIDE_RADIUS/LOW_ACCURACY/NO_PERMISSION/NO_FIX/OUTLET_NO_COORDS), client statusini rad etadi; muammoli tashrif BLOKLANMAYDI (offline'da yo'qolmasin), 'tasdiqlanmagan' + alert (OWNER/SALES_DIRECTOR, kuniga 1); aniqlik yuborilmasa LOW_ACCURACY; radius 150 m va aniqlik 100 m `Company` sozlamasi (audit bilan); marshrut faqat har nuqta VERIFIED/OUTLET_NO_COORDS/SKIPPED+sabab bo'lsa tugaydi (aks holda 409 `openStops`); `routes.finish` agent/direktor/owner, agent faqat o'z marshrutida; kuryer GPS va finish qilmaydi, faqat o'z buyurtmasini to'liq yetkazadi. Kun chegarasi `Company.timezone` (routes, field alert).
- F3 qarzlar: `startedAt` client yuboradi (tashrif kuni shunga bog'liq, offline uchun zarur); GPS koordinatalarini soxtalashtirish TZ §9.4 bo'yicha qabul qilingan; GPS shaxsiy ma'lumot — data-inventory/consent/retention yuridik ko'rigi kerak; `/outlets/no-coords` `customers.update` bilan (alohida `outlets.read` yo'q), to'liq 403 e2e yozilmagan (faqat metadata testi); boshqa joylarda qattiq `Asia/Tashkent`/server `setHours` qolgan (analytics/report-utils, export-1c.service, aging-report, reconciliation constants) — `Company.timezone` ga o'tkazish kerak; mavjud tenantlarda `backfill-permissions.ts` (yangi `routes.finish`, `reconciliation.*`) ishga tushirilmagan; web'da koordinatasiz outletlar sahifasi yo'q.

- **2026-10-13 — F4 qarorlari (ADR-020..023):** (ADR-020) offline buyurtmada narx farqi = CONFLICT `PRICE_CHANGED`, server qayta narxlamaydi, agent yangi jamini ko'rib qayta tasdiqlaydi (`expectedUnitPrice` har qatorda); (ADR-021) pull = global `changeSeq` + tombstone, `updatedAt` kursori bekor; nextval tartibi commit tartibiga teng emas, shuning uchun lookback oynasi (`SYNC_PULL_LOOKBACK_SECONDS`, 60), qayta yuborish idempotent upsert; qayta aktivlashda bolalar `changeSeq` i trigger bilan yangilanadi; (ADR-022) navbat yozuvi `userId/companyId` bilan bog'lanadi, begona hujjat push qilinmaydi; egasiz eski (v2) qatorlar karantinda (yuborilmaydi, faqat eksport/tasdiqli o'chirish), majburiy logout faqat o'z hujjatlarini o'chiradi; (ADR-023) offline buyurtma SUBMITTED yaratiladi, qoldiq push'da tekshirilmaydi, zaxira faqat confirm'da; bloklangan mijoz = REJECTED+sabab. Agent offline'da faqat o'z marshrutidagi mijozlarni ko'radi (qolganlari onlayn qidiruv). `clientId` replay faqat o'sha agent uchun (aks holda `CLIENT_ID_CONFLICT`). Tashrif `startedAt`: kelajak ≤5 daqiqa, o'tmish ≤30 kun (`VISIT_STARTED_AT_MAX_AGE_DAYS`). Push batch limiti `SYNC_PUSH_MAX_BATCH` (20).
- F4 ochiq/qarzlar: (1) TZ §8.4 "direktor qarori auditlanadi" — oldindan 'qoldiq yetishmaydi' belgisi va director resolve oqimi yo'q (qaror kerak, MVP doirasi); (2) §8.5 qurilma matritsasi (`docs/OFFLINE-DEVICE-MATRIX.md`) to'ldirilmagan, pilot telefonlari/Telegram versiyalari ro'yxati foydalanuvchidan kerak; haqiqiy brauzerda offline cold start va Telegram iOS WebView qo'lda sinalmagan; (3) begona hujjatlar qolsa keyingi foydalanuvchi bilan qurilma kaliti umumiy (listAll faqat o'z hujjatlarini ko'rsatadi); (4) pull buyurtmalarni qaytarmaydi (MVP bir tomonlama sync); (5) non-agent `fullResync` products/stock ni tozalamaydi; (6) kursorsiz/soxta kursorli `fullResync` kichik tenant uchun global `changeSeq` indeksidan RLS subquery bilan keng skan qiladi (DoS xavfi, past); (7) NFR-PERF-006 tarmoqsiz o'lchanadi; perf (5k mahsulot+2k mijoz pull 0,7–2,6 s, 20 hujjat push 0,3–2,7 s) chegaraga yaqin; (8) `apps/api` lint skripti `test/` ni qamramaydi (10 ogohlantirish); (9) mavjud tenantlarda `backfill-permissions.ts` ishga tushirilmagan.

- **2026-10-15 — F5 qarorlari (ADR-024..027):** (ADR-024) 1C eksport bir tomonlama, `Ид`=Velto UUID, qayta eksport ruxsat; XML pilot buxgalter imzosigacha 'supported' emas, asosiy yo'l Excel/CSV; (ADR-025) eksport va reversal kompaniya advisory lock'i bilan ketma-ket (HALI amalga oshirilmagan); (ADR-026) import faqat yaratadi, mavjud code/sku qatori xato/skip, faqat to'g'ri qatorlar yoziladi; (ADR-027) hisobot eksporti XLSX+CSV, ekrandagi servis bilan bir xil, kun chegarasi `Company.timezone`, har eksport audit. `BULLMQ_PREFIX` env (standart 'bull'), test fayllari noyob prefiks bilan. Import: bo'lak tx chegarasi 60 s, job lock 120 s, kursor `FOR UPDATE` bilan (stalled qayta yetkazishda ikki marta yozilmaydi).
- F5 ochiq/qarzlar: (1) F5.3 1C eksport mustahkamlash bajarilmagan (agent topshirig'i ruxsat tizimi tomonidan rad etilgan, qayta topshirish foydalanuvchi tasdig'ini kutadi); web'da 1C eksport sahifasi yo'q; (2) pilot 1C konfiguratsiyasi (UT 11/BP 3.0) va buxgalter namunaviy fayli kerak (§7.3); (3) qator darajasidagi HALF_UP yaxlitlash 1C bilan kopeyka farqi berishi mumkin — buxgalter tasdiqlashi kerak; (4) CSV ajratgichi vergul (uz/ru Excel `;` kutishi mumkin); (5) `fileUrl` imzosiz, muddatsiz public URL (signed URL + expiry yo'q, TZ §11.3); (6) sales/payments/visits `list()` filtrlari `Company.timezone` o'rniga default Asia/Tashkent bilan startOfDay/endOfDay chaqiradi; export-1c.service.ts, reconciliation-alert, field-alert fallback'larda qattiq TZ qolgan; (7) hisobot DTO'larida agent/mijoz/status filtri yo'q (faqat davr/asOf); (8) ImportJob'da updatedAt yo'q (tiklash sweep'i queue holatiga tayanadi); (9) report-utils.test.ts `getHours()` server TZ'ga bog'liq; (10) birinchi CI yurishi hali bo'lmagan, `origin` ga push qilinmagan (gitleaks lokal skani toza, 80 commit).

- **F2.1 ochiq biznes savollar (javob kutilmoqda):** (a) `reverse()`/`allocate()` o'chirilgan (soft-deleted) mijozda ruxsat berilsinmi (hozir ruxsat; tavsiya: rad, `lockActiveOrThrow`) — o'chirilgan mijozga ko'rinmaydigan ledger yozuvi; (b) `GET /stock/movements` `stock.read` bilan ochiq, SALES_AGENT ham ko'radi (tavsiya: alohida ruxsat, agentsiz); (c) `customers.remove` ochiq CONFIRMED/SHIPPED buyurtmali mijozni rad etsinmi (o'chirilgan mijozning CONFIRMED buyurtmasi deliver bo'lmaydi, rezerv qo'lda cancel).
- F2.1 qarzlar: GoodsReceipt'dan kelgan RECEIVE ni reversal qaytarmaydi (manba hujjat orqali); `Invoice.cancelledAt` yo'q (o'tgan sana aging'ida bekor faktura har doim chiqarib tashlanadi); dashboard ↔ aging o'rtasida asOf/Toshkent-kun hisobi farqi; aging barcha jonli fakturalarni sahifalashsiz yuklaydi; `Payment`↔`CashSession` aloqasi sxemada yo'q (taqiq predikat bilan aniqlanadi, ustun emas); mavjud tenantlarda `backfill-permissions.ts` va `backfill-advance-balance.ts` (`--dry-run` avval) ishga tushirilmagan; stock movements UI mahsulot nomini birinchi 100 mahsulotdan oladi; aging faqat Excel (CSV yo'q); `reverse()` va 1C eksport parallel race faqat mantiqiy tahlil (test yo'q).
- **Hodisa (2026-10-12):** `prisma migrate diff` xato shadow URL bilan `velto_dev` ni reset qildi; qo'lda kiritilgan dev ma'lumot yo'qoldi (sxema tiklandi, `pnpm db:seed` kerak).
- M08: `GET /purchases/receipts` ro'yxati va GoodsReceipt(+Line) uchun UPDATE/DELETE taqiqlovchi trigger (LOW).

- **2026-10-19 — v5.0 review qarorlari (ADR-028..033; foydalanuvchi qabul qildi, TZ ga kiritildi):**
  - **ADR-028 Mode A only:** MVP, v0.9 va v1.0 faqat Mode A (Velto stock/receivables master). Mode B (1C master, `AWAITING_ACCOUNTING`, `DATA_CUTOVER`) v1.1. TZ §5.2/§6.3/§6.7/§7.6 mos.
  - **ADR-029 PENDING_HANDOVER:** agent naqdi `LOCAL_PENDING` → `PENDING_HANDOVER` (qarzni kamaytirmaydi, "yo'lda") → kassir smenada qabul qilgach `POSTED` + FIFO. Kassir/ofis to'lovi darhol `POSTED`. (TZ §6.5, §6.7.2, §5.4.2 F-01.) Kod: HALI YO'Q (F8.1).
  - **ADR-030 1C ACK:** bir tomonlama eksport; `ExportJob` `GENERATED → ACCOUNTING_ACCEPTED | FAILED_REVIEW`; ACK faqat buxgalterning UI'da qo'lda tasdig'i + checksum (+izoh), auditli; 1C callback yo'q. Kod: yo'q (F5.3+).
  - **ADR-031 Idempotentlik/versiya/prefiks:** create = `clientId`, holat o'tishi = `Idempotency-Key`; optimistic `version` ustunlari qo'shilmaydi (row lock + har qatorda `expectedUnitPrice`, repo ADR-020; `expectedPriceVersion` bekor); `/api/v1` prefiksi v1.1 (MVP'da strategiya hujjatlangan).
  - **ADR-032 4-eyes v1.1:** MVP'da 4-eyes yo'q; summa chegarasidan oshgan reversal/adjust → OWNER'ga darhol alert + audit. Chegara: **TBD — foydalanuvchi belgilaydi.**
  - **ADR-033 Nomlash/atama:** TZ dagi ADR-011..020 = `V5-ADR-011..020`; repo ADR-011..027 shu faylda o'z nomida; yangilari ADR-028 dan. Invoice UI atamasi: uz "Ichki hisob", ru "Внутренний счёт", en "Internal invoice". Pilot (v0.9) sign-off: 3 imzo (Product, Accounting, Security); GA — to'liq §16.5 matritsa. RPO 15m faqat GA; pilotda kunlik backup + drill. Yagona yuk profili: TZ §12.5.

## Ochiq savollar (foydalanuvchi hal qilmagan; TZ §19.2)

1. 1 user = 1 kompaniya (ko'p kompaniyali a'zolik).
2. MFA (rollar, bosqich).
3. Outbox qarori (hozir in-process BullMQ; transactional outbox kerakmi).
4. Qator darajasidagi `HALF_UP` yaxlitlash (1C bilan kopeyka farqi, buxgalter tasdig'i).
5. CSV ajratgich (vergul yoki `;`).
6. F2.1 (a) o'chirilgan mijozda `reverse()/allocate()`, (b) `GET /stock/movements` ruxsati, (c) ochiq buyurtmali mijozni o'chirish (batafsil yuqorida).
7. Reversal/adjust OWNER-alert summa chegarasi (ADR-032).
8. Pilot 1C konfiguratsiyasi (UT 11 / BP 3.0) va buxgalter namunaviy fayli.
9. Pilot qurilmalar va Telegram versiyalari ro'yxati (`docs/OFFLINE-DEVICE-MATRIX.md`).

## Keyingi qadamlar (ustuvorlik bilan)

Batafsil: `docs/PLAN.md` (F8.x gap-tahlil tartibi).
1. F8.1 — PENDING_HANDOVER, majburiy rad etish sababi, opening balance importi → `db-rls`, `finance-stock`, `qa-engineer`
2. F5.3+ — 1C ACK (ADR-030), signed URL, web 1C sahifasi → `integrations-dev`, `web-dev`
3. F4.5 — PWA manifest, holat yorliqlari, qurilma matritsasi → `miniapp-dev`
4. F6 — trial, onboarding, "Ichki hisob" yorlig'i → `web-dev`, `i18n-sync`
5. F7 — outbox qarori, rate-limit, live/ready, runbook, restore drill, perf → `devops`, `qa-engineer`

## Oxirgi sessiya

- 2026-10-19: Master TZ v5.0 ga review qarorlari kiritildi (ADR-028..033), STATUS/PLAN yangilandi. Faqat hujjat o'zgargan, kod yo'q. Branch `docs/tz-v5`, push qilinmagan.
- Commit xabarlari `feat(finance): ...` / `docs: ...` shaklida.
