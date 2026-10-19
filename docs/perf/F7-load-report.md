# F7 yuk testi hisoboti (TZ §12.1/§12.5, ADR-053)

**Lokal, SLA emas.** Bitta noutbuk, docker Postgres, bitta Node jarayoni; raqamlar faqat taqqoslash va nuqsonlarni topish uchun.

## Muhit
- Apple M1, 8 yadro, 8 GB RAM; Docker VM 8 CPU / 4 GB; macOS 27.0; Node v24.19.0; pnpm 11.17.0.
- PostgreSQL 16.14 (sozlanmagan: shared_buffers 128MB, work_mem 4MB, max_connections 100), Redis (docker, 6380), MinIO YO'Q (image pull rad etildi).
- Yuk vositasi: `grafana/k6:1.3.0` (docker). API: `apps/api/dist` alohida port 3011, `velto_app` (RLS) -> `velto_load`, `READ_ONLY_MODE=false`, `NODE_ENV=development`, BULLMQ_PREFIX alohida. `velto_dev` ga tegilmagan.
- Ma'lumot: `velto_load` tenanti: 100 000 buyurtma, 2 000 SKU, 1 000 mijoz, 3 ombor. Foydalanuvchilar: sintetik klonlar (100 OWNER, 30 SALES_AGENT, 2 CASHIER), har VU o'z userId si bilan (throttler userId bo'yicha 120/daq, env orqali o'zgarmaydi — `app.module.ts:49`; 429 hisoblandi: barcha runlarda 0).
- Hisob/parol hujjatga yozilmagan (`LOAD_PASSWORD` env).

## Stsenariy (`scripts/load/velto-load.js`, `run.sh`, `prepare-load-data.sh`, `start-api.sh`)
Aralash profil: ~20% agent (sync push 20 hujjat + 2 pull), ~15-20% yozuv zanjiri (buyurtma yaratish -> tasdiqlash -> yetkazish), 1 kassir (handover accept), qolgani o'qish (mahsulot/mijoz/narx/qoldiq/buyurtma/balans, + dashboard/sales/overview hisobotlari). `REPORTS=0` hisobotlarsiz variant (sababni ajratish uchun). 90-120 s. 429 va 5xx va ulanish xatolari alohida sanaladi.

## Qayta o'lchov (2026-10-20, kod: edcbd62, 5c5c1b1, 591c14a, 3b323d2, 8474a4f, 52655ab)
**Lokal, SLA emas.** Muhit yuqoridagidek (M1, Docker VM 8 CPU/4 GB, PG 16.14 sozlanmagan). Pool: default `PRISMA_POOL_SIZE=30` (oldingi run 17 va 40 edi). `velto_load` `db:load:reset` + `db:load:seed` bilan qayta yaratildi (100 000 buyurtma, 82 031 invoice); parol sessiya uchun tasodifiy, hech qayerga yozilmagan (`seed-load.ts` endi `LOAD_PASSWORD` talab qiladi, default yo'q). Har run: to'liq aralashma (hisobotlar bilan), 120 s, yangi API jarayoni = sovuq (cold), keyingisi isitilgan (warm); har run'dan keyin `verify-integrity`. 503 SERVICE_BUSY endi 5xx dan ALOHIDA sanaladi (`r_503`, `summarize.js`).

| Mezon | Oldin (to'liq aralashma) | Keyin | Holat |
|---|---|---|---|
| 50 VU read p95 <= 300 ms | 12-16 s | cold 1561 / warm 750 ms | **O'TMADI** (yaxshilandi ~10-20x) |
| 50 VU write p95 <= 700 ms | o'tmadi (order-create 1-2.7 s, sync-push-20 5.7-6.3 s) | cold 4662 / warm 3188 ms; sync-push-20 p95 7954/8077 | **O'TMADI** |
| 100 VU 5xx = 0 | 890 (to'liq) | cold 303 / warm 345 (503 alohida: 240 / 279) | **O'TMADI** |
| verify-integrity = 0 | 0 | 0 (4 run'dan keyin ham) | **O'TDI** |
| Deadlock 40P01 (pg_stat_database) | 2-11 (50 VU), 40 (100 VU) | **0** (4 run + diagnostika) | **O'TDI** |
| 503 SERVICE_BUSY | yo'q edi | 50 VU: 0; 100 VU: 240 / 279 (asosan read, pool kutishi) | retryable; 100 VU da ko'p |
| Dashboard <= 2 s (NFR) | 500 (bind limit) | p95 9.7 s, 50 VU da 115/126 so'rov 500 | **O'TMADI** |

Raqamlar (p50/p95, ms; RPS): cold50 RPS 17.9, hammasi 673/5717, 5xx 236; warm50 RPS 21.7, 297/5286, 5xx 207; cold100 RPS 25.7, 1905/6961, 5xx 303, 503 240; warm100 RPS 25.2, 1893/7165, 5xx 345, 503 279, 429: 2. Dashboard 5xx: 115/126, 125/154, 176/198, 172/186. sync-push-20 5xx: 74/80, 64/85, 104/131, 111/141. Bitta run har konfiguratsiyaga — tebranish (~+-20%) bor.

**Qolgan muammolar (sabablari; prod kodiga tegilmagan)**
1. Deadlock 40P01 TUZALDI (0 ta). Hamma 5xx lar Prisma interaktiv tranzaksiya 5000 ms timeout'i (`Transaction already closed ... 5000 ms`, 212 ta, + `Transaction not found` 23) — deadlock emas.
2. `GET /reports/dashboard` hanuz sekin: bitta tx ichidagi `Promise.all` bitta ulanishda ketma-ket bajariladi (`dashboard.service.ts:36-47`): `invoiceDebt` 2 marta (har biri EXPLAIN ANALYZE 864 ms: `report-sql.ts:76-102`, Payment seq scan + PaymentAllocation uchun 66k marta index scan (RLS pastki so'rovi), Sort disk 2.2 MB), `turnoverPerDay` 528 ms (SalesOrder seq scan + 8658x SalesOrderLine index scan, RLS 26k Payment/SalesOrder qidiruvi), + aging. Yig'indi ~4-5 s yagona so'rovda, yuk ostida 5 s dan oshadi. Taklif: `Invoice(status, createdAt)` va `SalesOrder(createdAt, status)` indekslari; `PaymentAllocation` ni `invoiceId` bo'yicha oldindan yig'ish (materialized/cached balance); dashboard tx timeout'ini `@TenantTxOptions` bilan oshirish yoki keshlash (30-60 s).
3. `POST /sync/push` 20 hujjat bitta tx da (`sync.service.ts`) 5 s dan oshadi -> `RETRY` va 500 (50 VU: 64-74, 100 VU: 104-111). Taklif: hujjat-bo'yicha tx yoki tx timeout oshirish; 5s timeout'ni 503/RETRY ga xaritalash.
4. Counter ketma-ketligi: write p95 100 VU da 4.5-4.9 s; dashboard/sync-push bilan pool va event loop birga band — counter (DocumentCounter ~16 ms/hujjat) alohida ajratilmadi (hisobotsiz 100 VU runi qilinmadi), shuning uchun uning ulushi tasdiqlanmagan.
5. 100 VU da 503 (pool 30, kutish 10 s): 145-154 ta read 503 — pool tanqisligi, tx lar uzoq ushlanishi (2-3-bandlar) tufayli.
6. Kompaniya eksporti: MinIO hanuz yo'q (docker-compose minio image pull ishlamagan, boshqa S3-mos image mavjud emas) — eksport davomiyligi qayta o'lchanmadi; faqat oldingi o'qish bosqichi (~161 s) qoladi.

## Oldingi run (kod tuzatishlaridan oldin)
## Mezonlar va natija
| Mezon | Natija |
|---|---|
| 50 VU: read p95 <= 300 ms | **O'TMADI** to'liq aralashmada (p95 12-16 s, hisobotlar tufayli); hisobotsiz **O'TDI** (p95 98-147 ms) |
| 50 VU: write p95 <= 700 ms | **O'TMADI** to'liq aralashmada; hisobotsiz jami write p95 285-774 ms (order-create p95 972-2658 ms, sync-push-20 p95 5.7-6.3 s) — **O'TMADI** |
| 100 VU: 5xx = 0 | **O'TMADI** (to'liq: 890 ta 5xx; hisobotsiz, pool=17: 419; hisobotsiz, pool=40: 179 — hammasi sync push/order-create) |
| run'dan keyin verify-integrity.sql = 0 | **O'TDI** (barcha runlardan keyin 0 topilma: oversell, ledger drift, StockLevel=sum(movement), cachedBalance=ledger) |

## Asosiy raqamlar (ms, p50/p95/p99; to'liq jadvallar `scripts/load/results/*.md`, git'da emas)
- cold50 (to'liq, 90 s): RPS 7.3, p50 2174 / p95 14203 / p99 17183, 5xx 222 (dashboard 100%, sales/overview ~96%).
- noreports50 (90 s): RPS 33.8, read p95 147; write p95 774; sync-push p95 6311, 10 ta 5xx.
- noreports50w (120 s, yangi API): RPS 35.5, read p95 98 / p99 587; write p95 285; order-create p95 972; sync-push-20 p95 5738, 7 ta 5xx.
- full100: RPS 9.4, p95 32.6 s, 890 ta 5xx (64 ta ulanish uzilishi).
- noreports100 (pool 17): RPS 55.7, read p95 1938 (5xx 235), write p95 3696.
- noreports100_pool40: RPS 61.0, read p95 139 / p99 397, **read 5xx 0**; write p95 5118, sync-push-20 p95 7824 (105 ta 5xx).

## Aniqlangan muammolar (prod kodiga tegilmagan; tuzatish tavsiyalari)
1. **Hisobotlar butun buyurtmalarni Node xotirasiga yuklaydi** — `analytics/dashboard.service.ts:79`, `:129`, `analytics/sales-report.service.ts:17`, `analytics/overview-report.service.ts:19` (`findMany` + JS da yig'ish). Dashboard: `too many bind variables ... received 32768` (500) — 30 kunlik ~18 mingta buyurtmada; sales: 5 s tranzaksiya timeout (500). Yakka so'rov (bo'sh tizim): dashboard 500 / 1.8 s, sales 500 / 6.4 s (timeout), overview 200 / 2.6 s, sales(19 kun) 200 / 4.5 s. NFR: dashboard <= 2 s. Bitta jarayonda event loop va pool ni band qilib BARCHA endpointlarni sekinlashtiradi (to'liq aralashmada RPS 7 vs hisobotsiz 34-61). Tavsiya: SQL `GROUP BY` / `SUM` (set-based) agregatsiya, `lines` ni DB da yig'ish.
2. **Prisma ulanish pooli (standart num_cpus*2+1 = 17)** `DATABASE_URL` da `connection_limit` yo'q: 100 VU da o'qishlar `Unable to start a transaction in the given time` (2 s maxWait) bilan 5xx (235 ta); `connection_limit=40` bilan o'qish 5xx = 0, p95 139 ms. Har so'rov butun davomida bitta ulanishni ushlaydi (TenantContextInterceptor tx). Tavsiya: prod `DATABASE_URL` ga `connection_limit` (PG `max_connections` doirasida) + hujjat.
3. **Deadlock 40P01** (hisobotsiz 50 VU da 2-11 ta, 100 VU da 40 ta): sync push (`sync.service.ts:278-287` mijoz `FOR UPDATE` to'plami) <-> `POST /orders` (`sales.service.ts:360` `docNumbering.next` -> `DocumentCounter` ON CONFLICT DO UPDATE, blok raqamlash `+ $5`) <-> `SalesOrder` INSERT. Postgres logi: `SELECT id FROM "Customer" ... FOR UPDATE` / `INSERT INTO "DocumentCounter"` / `INSERT INTO "SalesOrder"` uch jarayonli sikl. `POST /orders` da deadlock 500 qaytaradi (qayta urinish/409 yo'q). Tavsiya: bitta tartib (DocumentCounter oldin, keyin Customer) yoki raqam ajratishni tx oxiriga surish; deadlock da qayta urinish.
4. **`/sync/push` 20 hujjat ~5 s tx timeout (Prisma default 5000 ms)**: yuk ostida p95 5.7-7.8 s, `Transaction already closed` -> 500 (50 VU: 7 ta, 100 VU: 105 ta). STATUS dagi ma'lum qarz (5xx, noto'g'ri status emas) — endi o'lchandi. Tavsiya: `SyncService.push` tx timeout/hujjat-bo'yicha tx, yoki RETRY holatiga o'girish.
5. Ulanish uzilishi (status 0 / EOF): 17-64 ta — k6 keep-alive vs Node `keepAliveTimeout` 5 s poygasi bo'lishi mumkin (mijoz artefakti, tasdiqlanmagan); 5xx ga qo'shilmagan.
6. Boshqa: o'qish endpointlari (`/orders`, `/customers/:id/balance`, `/stock`) hisobotsiz 50 VU da p95 <= 274 ms — EXPLAIN talab qilmadi; indeks takliflari yo'q.

## Kompaniya eksporti (velto_load tenanti, 100k buyurtma)
MinIO yo'qligi sababli job oxirigacha bormadi (`ECONNREFUSED :9000`, FAILED), lekin o'qish/qurish bosqichi ~161 s davom etdi (ExportJob createdAt->updatedAt). Kuzatilgan eng katta `backend_xmin` yoshi (xact_start bo'yicha, 2 s oraliq) = 44 s (< 10 daq) -> ADR-055 uchun hozircha talab yo'q; to'liq o'lchov MinIO bilan qayta o'tkazilishi kerak.

## Qayta ishga tushirish
`bash scripts/load/prepare-load-data.sh` (LOAD_CLONES=100) -> `bash scripts/load/restart-api.sh` -> `LOAD_PASSWORD=... bash scripts/load/run.sh <nom> mixed <VUS> <DAVOMIYLIK>` (REPORTS=0 uchun `EXTRA_ENV="-e REPORTS=0"`); tekshiruv: `pnpm --filter @velto/database db:load:verify`.
