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
