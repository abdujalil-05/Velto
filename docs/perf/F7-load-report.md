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

## Yangi kod bilan qayta o'lchov (2026-10-20, kod: eba0895 — sync push hujjat-bo'yicha tx, hisobot semafori per-tenant kvota, dashboard kesh, indeks, 40P01 tuzatish, pool 30, health kesh)
**Lokal, SLA emas.** Muhit yuqoridagidek; `apps/api/dist` qayta qurildi (yangilangani tekshirildi), `velto_load` `db:load:reset`+`seed` bilan qayta yaratildi, parol sessiya uchun tasodifiy (hech qayerga yozilmagan). 24 run x 120 s; har konfiguratsiya 2 marta (cold = yangi API jarayoni, warm = keyingi run). (A) hisobotsiz aralashma, (B) hisobotli aralashma, (C) sync-push dominant (`MODE=syncheavy`, yangi: agentlar 50% (maks 30) + ~20% yozuv + 1 kassir + o'qish; hisobotsiz). Hamma 24 run: verify-integrity 0 topilma, `pg_stat_database.deadlocks` 0. Lock ulushi = 2 s oraliqda `pg_stat_activity` (velto_app, state != idle) namunalarida `wait_event_type=Lock` ulushi.

p95 ms read / write(order-create+confirm+deliver+handover) / sync-push-20; keyingi qatorda 5xx/503 (r1c r1w r2c r2w):
| Konf. | r1 cold | r1 warm | r2 cold | r2 warm |
|---|---|---|---|---|
| A50 p95 read/write/sync | 180/518/7968 | 89/193/3709 | 252/707/9100 | 107/251/4372 |
| A50 5xx/503 | 0/0 | 0/0 | 0/0 | 0/0 |
| B50 p95 read/write/sync | 59/97/2674 | 95/170/3254 | 367/1003/11316 | 142/389/7845 |
| B50 5xx/503 | 0/197 | 0/212 | 0/300 | 0/311 |
| A100 p95 read/write/sync | 1024/2572/23820 | 280/1232/18663 | 85/264/5855 | 83/211/6038 |
| A100 5xx/503 | 11/0 | 0/0 | 0/0 | 0/0 |
| B100 p95 read/write/sync | 114/470/7480 | 182/648/11437 | 119/436/8294 | 213/802/11991 |
| B100 5xx/503 | 0/887 | 0/895 | 0/874 (+13 conn) | 0/859 |
| C50 p95 read/write/sync | 121/453/11238 | 113/407/8531 | 371/1007/12111 | 163/873/12597 |
| C50 order-create p95 | 1068 | 812 | 1781 | 1578 |
| C50 5xx/503 | 0/0 | 0/0 | 0/0 | 0/0 |
| C100 p95 read/write/sync | 935/1797/22701 | 645/2231/27892 | 307/1036/18187 | 227/940/18140 |
| C100 order-create p95 | 3414 | 3760 | 1681 | 1750 |
| C100 5xx/503 | 5/0 | 12/0 | 2/0 | 0/0 |

sync-push-20 p50 (ms): A50 1566/1300/3838/2433; B50 988/1167/5316/4689; C50 1470/2722/7008/7916; C100 8926/22228/5715/7553 (bitta so'rov = 20 hujjat ketma-ket, har biri o'z tx i). Dashboard hit p95 (B50): 913/1137/2803/1776; (B100): 1653/2768/2472/3666; miss (n=3-4/run): 50 VU 5.9-13.2 s, 100 VU 8.5-14.9 s.
Lock ulushi (4 run jami): A50 37%, B50 29%, A100 53%, B100 42%, C50 70%, C100 71%. "Transaction already closed" (API logidan, run bo'yicha): A100 34/3/0/0; C50 0/0/6/0; C100 30/38/12/3; qolganlari 0. Sync hujjat tx timeout endi 500 emas, shu hujjat uchun `RETRY` natijasi (k6 check "20 ACCEPTED/DUPLICATE" yiqilgan: A100 r1cold 22/103 so'rov, C50 r2cold 6/187, C100 25/128, 3/213).

| Mezon | Oldin (4f145f5) | Keyin | Holat |
|---|---|---|---|
| 50 VU read p95 <= 300 | A 47-247, B 1159-1719 | A 89-252, B 59-367 | A **O'TDI** 4/4; B 3/4 (B50 r2cold 367) |
| 50 VU write p95 <= 700 | A 186-1219, B 3887-5046 | A 193-707, B 97-1003 | A 3/4 (r2cold 707 — chegarada), B 3/4 (r2cold 1003) — **qisman O'TMADI**; C50 3/4 emas: 453/407/1007/873 |
| 100 VU 5xx = 0 | A 27-126, B 99-110 | A 11/0/0/0; B 0/0/0/0; C 5/12/2/0 | A,C **O'TMADI** (cold/warm tebranish); B 5xx o'tdi, lekin 503 859-895 |
| 503 SERVICE_BUSY | B100 567-778 | B50 197-311, B100 859-895; A,C ~0 (A100 11, C100 5-12 ichki) | hammasi `/reports/*` (per-tenant semafor: 1 parallel + 5 navbat, bitta tenant => ko'p rad); retryable |
| Dashboard p95 <= 2 s | hit 5.8-12.2 s | hit B50 0.9-2.8 s (3/4 o'tdi), B100 1.7-3.7 s (1/4); miss 5.9-14.9 s | hit qisman, miss **O'TMADI** |
| 'Transaction already closed' | 446+ (500) | A100 37, C50 6, C100 83 (RETRY/order-create 5xx) | 5xx **kamaydi**, nolga tushmadi |
| verify-integrity = 0 | 0 | 0 (24/24) | **O'TDI** |
| deadlocks | 0 | 0 | **O'TDI** |

**Xulosa va sabablar**
1. Yaxshilandi: 5xx 100-126 -> 0-12 (asosan 0); hisobotli aralashmada read p95 1.2-1.7 s -> 59-367 ms, write 3.9-5.0 s -> 97-1003 ms (semafor: ortiqcha hisobotlar tezda 503, pool band bo'lmaydi); sync 500 lar yo'q.
2. Hali o'tmaydi: (a) sync-push-20 p95 2.7-28 s — hujjatlar ketma-ket, har biri lock kutadi; Lock ulushi C da 70%, A100 53% — to'sqich hanuz bitta qatorli resurs (DocumentCounter 'SO' + Customer FOR UPDATE; `sales.service.ts:365`, `document-numbering.service.ts:44`), tx lari qisqargan lekin hanuz ketma-ket. Bu run'da lock ob'ekti alohida o'lchanmadi (oldingi run pg_locks tahliliga tayanadi). (b) C50 write p95 453-1007 va order-create p95 0.8-1.8 s: sync agentlar bilan counter navbati. (c) 100 VU cold: A100 r1cold (read p95 1024, sync 23.8 s, 11 5xx), C100 r1 — sovuq jarayon + lock navbati 5 s tx timeout dan oshadi (`TenantContextInterceptor` default 5 s, order-create). (d) Dashboard miss 6-15 s — keshsiz hisoblash `report-sql.ts` hanuz og'ir, semafor navbat kutishini qo'shadi; hit B100 da 1.7-3.7 s (semafor navbati).
3. B da 503 ulushi 37% (50 VU) / 66% (100 VU) hisobotlarning — sinov bitta tenantdan (per-tenant kvota 1+5 `env.schema.ts:10-11`); ko'p tenantli prod uchun kvota umumiy emas, shuning uchun lokal natija bu yerda qattiq.
4. Variatsiya katta (r2cold vs r1warm 2-5x): bitta laptop, 2 takror.

**Takliflar (prod kodiga tegilmadi)**: `document-numbering.service.ts:44` hujjat raqamini tx oxiriga yoki per-user/blokli ajratish (counter bloki oldindan 20 ga), `sync.service.ts` hujjat tx timeout/lock_timeout ni qisqartirish va RETRY ni mijoz tomonida exponential backoff bilan; order-create (`TenantContextInterceptor` 5 s) uchun `@TenantTx({timeout})`; dashboard miss uchun fon isitish (cron) yoki materialized agregat.

## Oldingi: Yakuniy qayta o'lchov: (A) hisobotsiz vs (B) hisobotli (2026-10-20, kod: 4f145f5 — kesh, `@TenantTx(15s)`, invoiceDebtAsOfMany, SalesOrder(companyId,createdAt) indeksi, 40P01->503)
**Lokal, SLA emas.** Muhit yuqoridagidek; pool default 30; API qayta qurildi (dist eskirgan edi) va har juftlikdan oldin restart (cold = yangi jarayon, warm = keyingi run). `velto_load` qayta yaratildi (migratsiya `20261020100000` qo'llangan), parol sessiya uchun tasodifiy, hech qayerga yozilmagan. Har run 120 s, har konfiguratsiya 2 marta (cold/warm, cold2/warm2). (A) `REPORTS=0`; (B) `REPORTS=1` — hisobotlar jami so'rovlarning ~12-13% i (maqsad 5-10% dan biroz ko'p). Dashboard hit/miss `cached` maydoni bo'yicha alohida (`dash_dur`). Hamma 16 run: verify-integrity 0 topilma, `pg_stat_database.deadlocks` 0.

p95 ms (read / write / sync-push-20), 5xx (503 alohida):
| Konfiguratsiya | run1 cold | run1 warm | run2 cold | run2 warm |
|---|---|---|---|---|
| (A) 50 VU p95 read/write/sync | 53/248/3662 | 47/186/2202 | 53/241/1999 | **247/1219/6897** (anomaliya, sync 500: 19) |
| (A) 50 VU 5xx / 503 | 0/0 | 0/0 | 0/0 | 24/0 |
| (A) 100 VU p95 read/write/sync | 652/1919/8373 | 1102/3667/10247 | 500/984/7137 | 106/893/5686 |
| (A) 100 VU 5xx / 503 | 78/0 | 126/0 | 32/0 | 27/0 |
| (B) 50 VU p95 read/write/sync | 1159/3887/8499 | 1624/5046/8462 | 1468/5035/8091 | 1719/4627/8134 |
| (B) 50 VU 5xx / 503 | 83/0 | 95/6 | 94/2 | 108/11 |
| (B) 100 VU p95 read/write/sync | 2338/5626/10736 | 2218/4505/8719 | 2176/4647/10394 | 2201/4814/10464 |
| (B) 100 VU 5xx / 503 | 106/772 | 99/567 | 110/632 | 99/778 |

Dashboard p95 (ms), (B): 50 VU hit 5780/8074/8097/9786, miss (n=4/run) 12-14 s; 100 VU hit 8422/8758/7519/12214, miss 9-15 s. RPS: (A) 50 VU 32-37, 100 VU 52-67; (B) 50 VU 14-22, 100 VU 22-25.

| Mezon | Oldin (to'liq, avvalgi run) | Keyin (A, hisobotsiz) | Keyin (B, hisobotli) | Holat |
|---|---|---|---|---|
| 50 VU read p95 <= 300 | cold 1561 / warm 750 | 47-53 (1 ta outlier 247) | 1159-1719 | A **O'TDI**, B **O'TMADI** |
| 50 VU write p95 <= 700 | cold 4662 / warm 3188 | 186-248 (1 ta outlier 1219) | 3887-5046 | A 3/4 run o'tdi, B **O'TMADI** |
| 100 VU 5xx = 0 | 303 / 345 | 27-126 (hammasi tx timeout 500, 503 yo'q) | 99-110 (+503 567-778) | **O'TMADI** ikkalasi |
| Dashboard p95 <= 2 s | 9.7 s (500 lar bilan) | - | hit 5.8-12.2 s; miss 9-15 s | **O'TMADI** |
| verify-integrity = 0 | 0 | 0 | 0 | **O'TDI** |
| deadlocks = 0 | 0 | 0 | 0 | **O'TDI** |

**Sabablar (o'lchangan)**
1. Hisobotlar (B) hamma narsani ~5-10x sekinlatadi (RPS 36 -> 14-22; read p50 18 -> 124-736 ms): hisobot tx lari pool (30) ni ushlab turadi, yagona Node jarayonida event loop bandligi. Dashboard KESH HIT ham sekin (p95 5.8-12 s), chunki `TenantContextInterceptor` kesh tekshirilishidan OLDIN tx/ulanish oladi va pool navbatida kutadi; miss 9-15 s (15 s timeout yaqinida), `GET /reports/sales` 10 ta 500 (B50 cold).
2. Write p95 sababi hisobot emas, `Lock/transactionid` kutish (A da ham): pg_locks bo'yicha eng ko'p kutuvchi `INSERT INTO "DocumentCounter"` (`document-numbering.service.ts:44`) va `SELECT ... FROM "Customer" ... FOR UPDATE` — to'sqich: boshqa `/sync/push` tx lari (bitta tx da 20 hujjat, `sync.service.ts:296` mijoz FOR UPDATE + counter ushlab turadi, commitgacha ~5 s). `POST /orders` `sales.service.ts:365` (`docNumbering.next`) sync-push ushlagan counter qatorini kutadi. Diagnostika run (A, 100 VU, 90 s): order-create p50 818 / p95 4060, sync-push-20 p50 5490 ms. pool/CPU emas: Node CPU o'rtacha 16-35%, PG `idle in transaction ClientRead` ko'p (tx lar ilova tomonida kutmoqda).
3. Barcha 5xx = `Transaction already closed ... 5000 ms` (446+25 ta diagnostikada): `SyncService.push` hali Prisma default 5 s timeout'da (`@TenantTx` faqat hisobot/opening/reconciliation da), 20 hujjat counter/mijoz lock kutishi bilan 5 s dan oshadi. Deadlock yo'q (40P01 tuzatilgan).
4. 100 VU 503 (B) asosan read (pool kutishi 10 s), (A) da 503 yo'q.

**Takliflar (prod kodiga tegilmadi)**: (a) `sync.service.ts:296` — tx ni hujjat-bo'yicha (yoki kichik partiyalar) qilish, counter blokini (`docNumbering`) tx oxiriga yoki alohida qisqa tx ga ajratish; `SyncController` push uchun `@TenantTx({timeout})` yoki timeout'ni RETRY/503 ga xaritalash. (b) Dashboard keshini `TenantContextInterceptor` dan oldin (guard darajasida) o'qish yoki hisobotlar uchun alohida kichik pool / semafor (bir vaqtda N hisobot); hisobotlar o'qish replikasiga. (c) `DocumentCounter` ni `INSERT ... ON CONFLICT` o'rniga hujjat tx i boshida emas, oxirida olish (lock ushlanish vaqtini qisqartirish). (d) outlier A50_warm2 (19 sync 500) tebranish — sabab shu 5 s timeout + lock navbati; qayta tekshirish kerak.

## Oldingi qayta o'lchov (2026-10-20, kod: edcbd62, 5c5c1b1, 591c14a, 3b323d2, 8474a4f, 52655ab)
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
