# Velto — loyiha holati

> Yangilangan: 2026-10-12 · Manba: `architect` agenti auditi (kod ↔ `docs/VELTO-TZ-v4.0.md` §5.1 va §16).
> Bu hujjat holat uchun. Qoidalar `CLAUDE.md` da. Har katta ishdan keyin shu fayl yangilanadi.
> Audit yuzaki: "Tayyor" = real kod + test bor; chuqur QA o'tkazilmagan.

## Faza tracker (reja: `docs/PLAN.md`)

| Faza | Holat |
|---|---|
| F0 Poydevor va baseline (baza, testlar, M08 tasdiq) | **Deyarli tayyor** — lokal baza ko'tarildi, migratsiyalar qo'llandi, **274/274 test o'tdi** (database 29, api 223, miniapp 22; lint/typecheck/build toza, 2026-10-12). Qoldi: production rol modeli (foydalanuvchi tekshiradi), web testi yo'q, MinIO image yuklanmadi |
| F1 Xavfsizlik va shartnoma (traceId, auth P0, idempotentlik) | **Jarayonda** — F1.1 traceId ✅ (branch `feat/f1-1-trace-id`); F1.2 auth P0 ✅ (branch `test/f1-2-auth-p0`: refresh-reuse audit, initData 10 daq oyna + 20 foydalanish limiti, constant-time HMAC, 403+audit testlari; 295/295 test). F1.3 idempotentlik ✅ (branch `feat/f1-3-idempotency`: `IdempotencyRecord` + RLS, `@Idempotent()` interceptor (Idempotency-Key ixtiyoriy, 72 soat), order `FOR UPDATE`, stock `ON CONFLICT`, web/miniapp kalit; 312/312 test). F1.4 rollar ADR + ACCOUNTANT cheklovi testi ✅ (branch `test/f1-4-roles-accountant`). F1.5 audit + scan ✅ (branch `feat/f1-5-audit-scan`: audit maskalash `redactAuditJson`, `payment.allocate`/`export.create`/`import.confirm` eventlari, gitleaks CI job (sha256 bilan), `audit --audit-level=high` bloklaydi, zaif paketlar tuzatildi; 340 test: api 283+1 skip, database 35, miniapp 22). F1 FAZASI TUGADI. Eski qoldiq: audit testi + CI secret/dependency scan |
| F2 Ombor va moliya yadrosi | **Jarayonda** — F1 main'ga merge qilindi (lokal, `origin` ga push qilinmagan). F2.1 main'ga merge qilindi (lokal). F2.4 main'ga merge qilindi. F2.5 main'ga merge qilindi. Faza 3 (dala savdosi va kuryer) ✅: `feat/f3-field-courier` — server GPS statusi (6 natija, tashrif bloklanmaydi, `gpsStatus` DB'da, `gpsOk` trigger bilan hosil), `SKIPPED`+sabab, marshrut yakuni validatsiyasi (`routes.finish`, `skip-stop`, 409 `openStops`), kompaniya radius/aniqlik sozlamasi, kunlik in-app alert, web Tashriflar sahifasi, miniapp GPS. Oldingi: `feat/f2-5-reconciliation`: F2.5 ✅ + F2.2 drift job ✅ (kunlik 03:00 Toshkent, faqat aniqlash; `ReconciliationRun/Finding`, `reconciliation.read` OWNER+ACCOUNTANT, `reconciliation.fix` faqat OWNER, in-app alert, `/reconciliation` web sahifa). F2.4 ✅ (qisman yetkazish, `SalesOrderLine.deliveredQty`, 1 order = 1 invoice, qoldiq rezervdan bo'shatiladi, kuryer faqat to'liq; parallel testlar `delivery-race.test.ts`); F2.1 reversal ✅ (Payment/StockMovement append-only trigger, `PaymentReversal`, `payments.reverse`/`stock.reverse`, smena/1C taqiqi), F2.2 avans ✅ qisman (ledger formula, `advance`, `payments.allocate`; **drift reconciliation job + alert yo'q**, backfill skripti yozilgan, ishga tushirilmagan), F2.3 ✅ qisman (aging asOf+TZ guruhlari, invoices, 5 qatorli VAT testi; **yaxlitlash strategiyasi testi yo'q**). F3 dan keyin 531 test (api 446+1 skip, database 55, miniapp 29). Qoldi: F2.5 qoldiq reconciliation job, F2.6 parallel testlar (oxirgi qoldiq, sequence), drift job |
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

- **F2.1 ochiq biznes savollar (javob kutilmoqda):** (a) `reverse()`/`allocate()` o'chirilgan (soft-deleted) mijozda ruxsat berilsinmi (hozir ruxsat; tavsiya: rad, `lockActiveOrThrow`) — o'chirilgan mijozga ko'rinmaydigan ledger yozuvi; (b) `GET /stock/movements` `stock.read` bilan ochiq, SALES_AGENT ham ko'radi (tavsiya: alohida ruxsat, agentsiz); (c) `customers.remove` ochiq CONFIRMED/SHIPPED buyurtmali mijozni rad etsinmi (o'chirilgan mijozning CONFIRMED buyurtmasi deliver bo'lmaydi, rezerv qo'lda cancel).
- F2.1 qarzlar: GoodsReceipt'dan kelgan RECEIVE ni reversal qaytarmaydi (manba hujjat orqali); `Invoice.cancelledAt` yo'q (o'tgan sana aging'ida bekor faktura har doim chiqarib tashlanadi); dashboard ↔ aging o'rtasida asOf/Toshkent-kun hisobi farqi; aging barcha jonli fakturalarni sahifalashsiz yuklaydi; `Payment`↔`CashSession` aloqasi sxemada yo'q (taqiq predikat bilan aniqlanadi, ustun emas); mavjud tenantlarda `backfill-permissions.ts` va `backfill-advance-balance.ts` (`--dry-run` avval) ishga tushirilmagan; stock movements UI mahsulot nomini birinchi 100 mahsulotdan oladi; aging faqat Excel (CSV yo'q); `reverse()` va 1C eksport parallel race faqat mantiqiy tahlil (test yo'q).
- **Hodisa (2026-10-12):** `prisma migrate diff` xato shadow URL bilan `velto_dev` ni reset qildi; qo'lda kiritilgan dev ma'lumot yo'qoldi (sxema tiklandi, `pnpm db:seed` kerak).
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
