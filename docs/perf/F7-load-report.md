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

## F7.6 qayta o'lchov (2026-10-22, kod: 2bb2cc4)
**Lokal, SLA emas.** Kod: dashboard stale-while-revalidate kesh, 6 ta parallel qisqa per-query tenant tx, top-10 qarzdor SQL LIMIT, Payment indekslari (migratsiya 20261022100000, `velto_load` da qo'llangan — `migrate deploy`: "No pending"). `velto_load` (3 tenant, 40k buyurtma/tenant), API dist qayta qurilgan, `LOAD_PASSWORD` runtime'da tasodifiy (diskka yozilmagan). Konfiguratsiya B (`REPORTS=1`), mixed, har run 120 s, cold = yangi API jarayoni, warm = keyingi run. Klon foydalanuvchilar `prepare-multi-load-data.sh` bilan qayta yaratildi (LOAD_AGENT_CLONES=20). Xom natijalar: `scripts/load/results/F76_*` (git'da emas).

**Host bosimi (SHUBHALI — barcha run'lar og'ir bosim ostida):** load average 6.6-27.7 (asosan 14-18), swap 4.2-5.9 GB / 5-7 GB, bo'sh RAM ~0.5-1.5 GB; boshqa loyihaning (RuschaAi) vitest jarayonlari ~60% CPU dan olib turdi. Shuning uchun mutlaq raqamlar (ayniqsa write/sync/miss) yuqoriga siljigan; hit p95 esa shunga qaramay past. Run'lar oldingi hisobotdagi mezon bo'yicha shubhali deb belgilanadi, lekin hit/miss farqi aniq.

| Run | read p95 | write p95 | sync-push-20 p95 | dashboard HIT p95 (n) | dashboard MISS p95 (n) | 5xx | 503 | Tx closed | 55P03 | deadlock | verify |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S20 B cold | 238 | 414 | 3031 | 113 (75) | 4917 (6) | 0 | 0 | 0 | 0 | 0 | 0 topilma |
| S20 B warm | 242 | 378 | 4592 | 113 (78) | 6195 (4) | 0 | 2 | 0 | 0 | 0 | 0 |
| M50 B cold (3 tenant) | 673 | 1000 | 6958 | 379 (170) | 7620 (14) | 1 (write) | 11 | 1 | 0 | 0 | 0 |
| M50 B warm | 316 | 606 | 4488 | 139 (192) | 11315 (11) | 0 | 7 | 0 | 0 | 0 | 0 |
| M100 B cold (3 tenant) | 399 | 779 | 7187 | 162 (288) | 11088 (32) | 0 | 247 (dashboard 13) | 0 | 0 | 0 | 0 |

**Maqsadlar (TZ §12.1, ADR-053):**
- Dashboard **hit** p95 < 300 ms: S20 113/113 **O'TDI**; M50 warm 139 **O'TDI**, M50 cold 379 **O'TMADI (oz)** (cold boshlanishida, host bosimi); M100 cold 162 **O'TDI**. Oldingi (ffe847e): hit 2.1-9.8 s -> endi 0.11-0.38 s (~20-60x yaxshi). Hit yo'li semaforsiz va DB'siz ishlayapti; payload 9.75 KB, yuk ostida emas.
- Dashboard **miss** p95 <= 2 s: **O'TMADI** — 4.9-11.3 s (n=4-32). Oldingi 5.5-13.6 s; sezilarli yaxshilanish yo'q (n kichik, host bosimi bilan aralash).
- Boshqa: S20 (haqiqiy distribyutor) read/write NFR ichida (238-242 / 378-414 < 300/700 — read p95 S20 da oldingi 57-76 ms dan ancha yuqori — host bosimi); M50 warm o'tdi; M50 cold read 673/write 1000 limitdan tashqari (bosim); sync-push-20 3-7 s (DocumentCounter, doira tashqarisi). M100 B da 503 faqat hisobot yo'llari (247), dashboard 13.
- Integrity: verify-integrity har run'dan keyin 0 topilma; deadlocks 0; 55P03 0; 'Transaction already closed' jami 1 (M50 cold, 1 ta 5xx write bilan bog'liq bo'lishi mumkin — log keyingi cold restart'da qayta yozilgani uchun tasdiqlanmadi).

**Miss diagnozi (dalil bilan):**
1. Bo'sh tizimda (yuksiz, yangi API, 1 so'rov, tenant `load`): miss **0.65 s** (cold), TTL dan keyin **0.96 s**; hit 8-34 ms. Demak so'rovlar o'zi (SQL LIMIT, indekslar, parallel tx) ichki <= 2 s ga sig'adi; 5-13 s yuk/kutish natijasi, hisoblash narxi emas.
2. Yuk ostida miss uzayishi manbalari (kod bo'yicha; mustaqil ravishda alohida o'lchanmagan): (a) `dashboard.service.ts:146` `limiter.acquire` — miss hisobot semaforidan (1+5 per-tenant) o'tadi, sales/overview og'ir hisobotlari bilan bir navbatda; (b) `dashboard.service.ts:163-183` — bitta compute 6 ta pool ulanishini bir vaqtda oladi, 50-100 VU yozuv/sync bilan (pool default `num_cpus*2+1`, `start-api.sh` `LOAD_POOL` bo'sh) pool kutish ehtimoli; (c) host CPU/swap bosimi (load avg 14-28) event loop va Postgres'ni sekinlashtiradi. (a)/(b)/(c) ulushi alohida aniqlanmadi (pool-wait metrikasi va event-loop lag o'lchovi yo'q).
3. Tavsiya (kod o'zgartirilmadi): miss uchun alohida yengil permit (yoki semafordan chiqarish — dashboard 6 qisqa query, og'ir hisobot emas); compute'ni so'rovdan emas, fon yangilashga (SWR refresh) ko'chirish va birinchi yuklanishda warm-up; pool o'lchamini va pool-wait/event-loop lag metrikalarini qo'shib, sokin hostda 3 takror qayta o'lchash.

**O'lchanmagan:** M100 r2/warm; miss uchun pool-wait/event-loop/semafor navbat vaqti; sokin host; M50 cold 1 ta 5xx sababi; 3 takror yo'q.

## F7.6 qayta o'lchov #2 (2026-10-30, kod: 2c4bd46 — ADR-056: to'liq SWR, alohida dashboard permit lane, pool boot tekshiruvi, fon yangilash backoff)
**Lokal, SLA emas.** `velto_load` (3 tenant `load/load2/load3`, 40k buyurtma/tenant), `velto_dev` ga tegilmagan. API dist qayta qurildi, port 3011. Konfiguratsiya B (`REPORTS=1`), mixed, 120 s, S20 = 20 VU / 1 tenant, M50 = 50 VU / 3 tenant. Cold = yangi API jarayoni, warm = o'sha jarayonda keyingi run. 3 takror (r1-r3), jami 12/12 run tugadi. `LOAD_PASSWORD` runtime'da tasodifiy, `velto_load` foydalanuvchilariga argon2 hash qilib o'rnatildi (diskka/hujjatga yozilmagan). Klonlar `prepare-multi-load-data.sh` (LOAD_AGENT_CLONES=20) bilan. Pool: `LOAD_POOL` bo'sh qoldi; boot tekshiruvi (`PRISMA_POOL_SIZE >= 6x(REPORT+DASHBOARD concurrency)+6`) default'lar bilan (30 >= 6x(2+2)+6 = 30) o'tdi, API ko'tarildi — alohida qiymat kerak bo'lmadi. Xom natijalar: `scripts/load/results/F76b_*` (git'da emas; `.api.log`, `.host`, `_verify.txt`).
**Muhit:** Apple M1 8 GB; Docker Postgres 16/Redis (velto-*) ishlab turdi; `ruscha-local-*` konteynerlari (7 ta, shu jumladan `ruscha-local-web-1` o'zi restart tsiklida) va boshqa loyiha jarayonlari tegilmagan va butun vaqt ishlab turdi. Docker daemon muammosiz. Mening API jarayonim oxirida to'xtatildi (3011 bo'sh).

**Host bosimi:** load average (5 s oralig'ida 1-daq qiymat) barcha run'larda 8 dan oshdi (diapazon 4.9-36.5, ko'pchiligi 11-20), swap ishlatilishi ~4.7-6.1 GB. Qoida bo'yicha **barcha 12 run SUSPECT**. Eng og'ir: S20 r1 warm (LA 36.5), M50 r3 warm (33.8). Bosimning sababi (tashqi jarayonlar) tekshirilmadi.

| Run | read p95 (n) | write p95 (n) | sync-push-20 p95 (n) | dashboard HIT p95 (n) | dashboard MISS p95 (n) | 5xx | 503 | Tx closed | 55P03 | deadlock | verify | LA min-max | swap MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S20 r1 cold | 450 (798) | 969 (528) | 11515 (40) | 153 (85) | 3797 (3) | 0 | 2 | 0 | 0 | 0 | 0 | 12.8-21.8 | 5460-5846 |
| S20 r1 warm | 225 (836) | 335 (570) | 4896 (44) | 85 (89) | - (0) | 0 | 1 | 0 | 0 | 0 | 0 | 12.8-36.5 | 5315-5459 |
| M50 r1 cold | 267 (2554) | 485 (1416) | 6725 (99) | 223 (228) | 1196 (4) | 0 | 0 | 0 | 0 | 0 | 0 | 10.8-16.9 | 4974-5251 |
| M50 r1 warm | 216 (2428) | 386 (1401) | 3954 (99) | 112 (257) | - (0) | 0 | 2 | 0 | 0 | 0 | 0 | 10.9-16.1 | 4718-4950 |
| S20 r2 cold | 73 (986) | 95 (627) | 1391 (48) | 24 (92) | 1037 (1) | 0 | 0 | 0 | 0 | 0 | 0 | 5.0-9.7 | 4746-4939 |
| S20 r2 warm | 350 (819) | 854 (558) | 10712 (44) | 182 (86) | - (0) | 0 | 8 | 0 | 0 | 0 | 0 | 4.9-18.2 | 4919-6050 |
| M50 r2 cold | 508 (2043) | 901 (1284) | 8874 (90) | 236 (191) | 6450 (7) | 0 | 14 | 0 | 0 | 0 | 0 | 12.5-15.2 | 4927-5620 |
| M50 r2 warm | 364 (1963) | 758 (1278) | 7317 (90) | 133 (171) | - (0) | 0 | 22 | 0 | 0 | 0 | 0 | 11.7-14.6 | 4835-5307 |
| S20 r3 cold | 303 (637) | 602 (522) | 4572 (40) | 159 (63) | 1381 (2) | 0 | 13 | 0 | 0 | 0 | 0 | 11.6-16.5 | 5336-5647 |
| S20 r3 warm | 326 (704) | 567 (543) | 5273 (44) | 172 (78) | - (0) | 0 | 5 | 0 | 0 | 0 | 0 | 11.0-14.6 | 5428-5683 |
| M50 r3 cold | 639 (1544) | 1282 (993) | 11989 (65) | 309 (154) | 2043 (8) | 0 | 52 | 0 | 0 | 0 | 0 | 9.7-19.9 | 5253-5659 |
| M50 r3 warm | 624 (1423) | 1234 (957) | 13496 (63) | 293 (136) | - (0) | 0 | 67 | 0 | 0 | 0 | 0 | 14.8-33.8 | 5368-5554 |

(503 — hisobot semafori "busy"; 429/conn_err/4xx 0. 'Tx closed', 55P03, deadlock — API log segmenti bo'yicha hisoblangan.)

**Maqsadlar (hit < 300 ms, miss <= 2 s; barcha run'lar SUSPECT):**
- Dashboard **hit** p95 < 300 ms: 11/12 run **O'TDI** (24-293 ms). **O'TMADI**: M50 r3 cold 309 ms (chegarada, LA 9.7-19.9). Oldingi o'lchov (2bb2cc4) hit 113-379 ms edi; endi 24-309 ms.
- Dashboard **miss** p95 <= 2 s: miss faqat cold run'larda kuzatildi (n=1-8, har run'da juda kam). **O'TDI**: S20 r2 1037, S20 r3 1381, M50 r1 1196. **O'TMADI**: S20 r1 3797 (n=3), M50 r2 6450 (n=7), M50 r3 2043 (n=8, chegarada). Warm run'larning hammasida (6/6) miss 0 — SWR eskirgan javobni qaytardi, foydalanuvchi miss'ni ko'rmadi. Oldingi o'lchovda miss 4.9-11.3 s edi; endi 1.0-6.5 s, lekin 3/6 cold run FAIL va n kichik — statistik jihatdan ishonchsiz.
- Boshqa (maqsad emas, ma'lumot): read p95 73-639, write p95 95-1282 (S20 r2 cold eng sokin: 73/95; M50 r3 eng yomon, LA 20-34); sync-push-20 1.4-13.5 s (DocumentCounter, doira tashqarisi). Natijalar run'dan run'ga host bosimi bilan keskin tebranadi.
- **5xx = 0 barcha 12 run'da.** Shuning uchun eski M50 cold write 5xx (2bb2cc4) sababi bu o'lchovda tushuntirilmadi va qayta ishlab chiqarilmadi — u noaniq qoladi. 'Transaction already closed' 0, 55P03 0, deadlock 0. verify-integrity har run'dan keyin 0 topilma.
- 503 (hisobot semafori) M50 r2-r3 da o'sdi (14-67), conn_err 0; qaysi yo'llar ekani bu jadvalda ajratilmadi (to'liq: `F76b_*.md`).

**Isbotlanmagan / cheklovlar:** (1) Barcha run'lar SUSPECT (LA > 8) — mutlaq raqamlar yuqoriga siljigan. (2) Miss n=1-8, warm miss 0 — miss p95 uchun kafolat yo'q; miss'ning sababi (pool-wait / permit navbat / host bosimi) alohida o'lchanmagan. (3) Hit/miss ajratish `cached` bayrog'iga tayanadi; SWR da "hit" eskirgan ma'lumot qaytarishi mumkin (yangilik chegarasi bu testda tekshirilmagan). (4) Sokin host, 100 VU, bitta noutbuk — SLA emas. (5) 5xx sababi: kuzatilmadi, shuning uchun eski nuqson haqida xulosa yo'q.

## Ko'p tenantli qayta o'lchov (2026-10-20, kod: ffe847e, F7 merge) — QISMAN, tebranish yuqori
**Lokal, SLA emas.** `velto_load` qayta yaratildi (migrate deploy, velto_owner), 3 tenant (`load`, `load2`, `load3`, har biri 40 000 buyurtma, 2k SKU, 1k mijoz), API dist qayta qurildi. Yangi: `scripts/load/prepare-multi-load-data.sh` (tenant boshiga noyob telefonli klonlar: 40 OWNER/20 AGENT/2 CASHIER) va `velto-load.js` da `fixtures.tenants` + `TENANTS=n` (umumiy VU teng bo'linadi, har VU bitta tenantda). Parol runtime'da tasodifiy (hujjat/diskka yozilmagan; Docker qayta ishga tushgani uchun 4 marta almashtirilgan). Har run 120 s, cold = yangi API jarayoni, warm = keyingi run. verify-integrity va deadlocks har run'dan keyin tekshirildi.
**MUHIM cheklovlar (halol):** (1) Host 8 GB, swap 9/10 GB, load average 24-32 (tashqi jarayonlar) — Docker daemon 2 marta o'zi to'xtadi; shu davrdagi run'lar (X_*, BAD_*, BAD2_* prefiksli fayllar `scripts/load/results/`, hisobga olinmadi) yaroqsiz. (2) Yaroqli 30 run ichida ham M50_C_r2, M100_A_r2, M100_B_r2 host bosimi davriga to'g'ri kelgan (rps 50 -> 13-28, r1 bilan 5-10x farq) — SHUBHALI, quyida `*` bilan. Ishonchli: S20 (6), M50_A_r1, M50_B_r1, M100_C_r1/r2, M50_A_r2, M50_B_r2, M100_A_r1, M100_B_r1, M50_C_r1. (3) Har konfiguratsiya 2 takror, lekin r1/r2 turli sharoitda. (4) Stok kamayishi sababli product ro'yxati keyingi prepare'da (>200 mavjud) qayta tanlangan. (5) Lock-ulushi namunasi (pg_locks) bu seriyada o'lchanmadi.

p95 ms read / write / sync-push-20 (ikkinchi qatorda 5xx/503); 3 tenant jami VU, har biri ~1/3:
| Konf. | r1 cold | r1 warm | r2 cold | r2 warm |
|---|---|---|---|---|
| S20 A (1 tenant) | 75/82/967 | 72/78/936 | - | - |
| S20 B (1 tenant) | 57/79/801 (503:6) | 58/91/899 (503:8) | - | - |
| S20 C (1 tenant) | 76/86/1522 | 71/85/1290 | - | - |
| M50 A | 128/178/1828 | 72/128/1556 | 67/117/2397 | 489/532/9813 |
| M50 B | 188/269/3391 (503:76) | 277/327/6044 (503:78) | 350/503/7318 (503:40) | 147/253/2776 (503:20) |
| M50 C | 394/608/6457 | 361/471/7979 | 1650*/2542*/32870* (5xx 2) | 735*/1235*/13696* |
| M100 A | 188/396/5379 | 156/345/4434 | 1076*/2053*/19723* | 2520*/4250*/39169* (5xx 25, 503:85) |
| M100 B | 253/500/5627 (503:252) | 405/685/8310 (503:313) | 3695*/6173*/60025* (5xx 61, 503:470) | 6947*/8179*/60014* (5xx 135, 503:653) |
| M100 C | 443/619/9670 | 401/625/8875 | 429/637/9936 | 286/494/6829 (conn 17) |

503 bo'yicha (B): M100 B r1 cold dashboard 12 / overview 100 / sales 140; warm 35/108/170 — faqat hisobot yo'llari (per-tenant semafor 1+5, har tenantga ~33 VU). M50 B: 20-78, ham faqat hisobotlar. A va C (hisobotsiz) r1 da 503 = 0. 5xx: yaroqli r1 run'larda 0; *-lar da bor (host bosimi bilan aralash). 'Transaction already closed': yaroqli r1 run'larda 0; shubhali r2 da 3 / 71 / 82 / 180; 55P03: 0 (r1), M100 B r2 warm 10. verify-integrity 0 topilma (hamma run), deadlocks 0.
**Dashboard (B, hit fast path bilan), p95:** S20 hit 2.1-3.6 s (n=64-67), miss 5.5-9.8 s (n=4); M50 hit 3.5-9.5 s (n=114-159), miss 8.4-13.6 s (n=10-12); M100 r1 hit 8.5-9.8 s (n=273-327), miss 10.9-12.0 s. Hit endi semaforsiz, lekin hali >2 s: sabab navbat emas, umumiy event loop/pool bandligi (yoki hit fast path JSON hajmi) — alohida tekshirish kerak.

**Haqiqiy distribyutor (1 tenant, 20 VU):** read p95 57-76, write 78-91 ms (limit 300/700 — **O'TDI**), sync-push-20 0.8-1.5 s, 5xx 0, 'Transaction already closed' 0, deadlocks 0. B da 503 faqat hisobot (6-8). Dashboard hit 2.1-3.6 s, miss 5.5-9.8 s — **O'TMADI** (<=2 s).
**Mezonlar (realistik per-tenant yuk, ishonchli run'lar):** 50 VU read/write p95 — A **O'TDI** (r1; r2 warm 489/532 limitdan tashqari, tebranish), B **qisman** (r1 188-277/269-327, r2 147-350/253-503 — o'tdi, lekin 503 hisobotlar 20-78), C r1 **O'TDI**. 100 VU: A r1 va C (r1, r2) 5xx=0 **O'TDI** (read p95 156-443, write 345-637 — 700 ms dan past, lekin 100 VU da limit emas, sync 4.4-9.9 s); B 5xx=0 lekin 503 252-313 (hisobotlar) — "xatosiz" mezoni qat'iy o'qilsa **O'TMADI**. verify-integrity va deadlocks **O'TDI**.
**Xulosa:** per-tenant ~17-33 VU da (1/3 tenantga bo'lingan) A va C rejimda yozuv/o'qish p95 NFR (300/700 ms) ichida, 5xx yo'q — avvalgi bitta-tenant 100 VU natijalari (write 1-2 s, 5xx) real distribyutor yukiga xos emasligi tasdiqlandi. Qolgan: (a) `DocumentCounter` har tenantda baribir ketma-ket nuqta (S20 C sync-push p95 1.3-1.5 s, M100 C sync p95 7-10 s: tenant boshiga 33 VU, ~50% agent); counter blokli/PG sequence bo'lishi kerak; (b) hisobot semafori (1+5) har tenantda ortiqcha hisobotni 503 ga aylantiradi (B100 252-313); (c) dashboard hit/miss >2 s; (d) shubhali r2 run'larni sokin hostda qayta o'lchash kerak (M50_C_r2, M100_A_r2, M100_B_r2); (e) lock-ulushi bu seriyada o'lchanmadi.
**Qayta davom ettirish:** `LOAD_PASSWORD` yangidan, `UPDATE "User" SET "passwordHash"=<argon2> WHERE "firstName" LIKE 'Load%'` (velto_load, superuser), `bash scripts/load/prepare-multi-load-data.sh scripts/load/results/fixtures-multi.json load load2 load3` (LOAD_AGENT_CLONES=20), `bash scripts/load/restart-api.sh`, so'ng `EXTRA_ENV="-e REPORTS=<0|1> -e TENANTS=3 -e FIXTURES=/work/results/fixtures-multi.json" bash scripts/load/run.sh <label> <mixed|syncheavy> <VUS> 120s`. Docker/RAM: boshqa og'ir ilovalarni yoping.

## Oldingi (bitta tenant): eng so'nggi qayta o'lchov (2026-10-20, kod: 8f0cea8, branch feat/f7-hardening — SO raqami kech ajratiladi + lock_timeout 2 s, stableSeq tenant predikati, customerId FK indekslari (migratsiya 20261020110000), dashboard o'z tx + handler scope, permission-first hisobot ruxsati, reconciliation handler scope)
**Lokal, SLA emas.** Muhit yuqoridagidek. `apps/api/dist` qayta qurildi (nest build, 06:45), `velto_load` `db:load:reset` (migrate deploy, velto_owner — oxirgi qo'llangan migratsiya 20261020110000) + `db:load:seed` bilan qayta yaratildi (velto_dev o'zgarmagani skript bilan tasdiqlandi), `prepare-load-data.sh` (100 OWNER/30 AGENT/2 CASHIER klon). Parol runtime'da tasodifiy, faqat jarayon env'ida (diskka/hujjatga yozilmagan). 24 run x 120 s: A (hisobotsiz aralashma), B (hisobotli), C (`syncheavy`, hisobotsiz) x 50/100 VU x 2 takror x cold/warm. Har run'da 2 s oraliqda `pg_locks`/`pg_stat_activity` namunasi (kutilayotgan lock ob'ekti + kutuvchi so'rov), API logidan "Transaction already closed" / 55P03 / SERVICE_BUSY hisoblandi, har run'dan keyin verify-integrity va `pg_stat_database.deadlocks`.
**Ogohlantirishlar:** (1) dataset BITTA tenant (`load`) — ko'p tenantli B ishga tushirilmadi; per-tenant semafor (1+5) bitta tenantda hamma hisobotni bitta kvotaga tiqadi, shuning uchun B dagi 503 lar real ko'p-tenantli prod uchun haddan tashqari qattiq (taxminiy 503 ulushi bu yerda ma'nosiz). (2) A100 r2 birinchi urinish: warm run API jarayoni tushib ketgani sababli (login status 0, sababi aniqlanmadi) o'tmadi; A100 r2 cold+warm ALOHIDA, hamma 24 run tugagach qayta o'tkazildi — DB o'sgan (SalesOrder 100k -> ~172k), shuning uchun r2 A100 dagi yomonroq raqam (846/1877) qisman DB o'sishi + tebranish; birinchi (yo'qolgan) cold urinish edi 369/1011. (3) 8 GB noutbuk, 2 takror — tebranish 2-3x.

p95 ms read / write(order-create+confirm+deliver+handover) / sync-push-20 (r1c r1w r2c r2w); keyingi qatorda 5xx/503:
| Konf. | r1 cold | r1 warm | r2 cold | r2 warm |
|---|---|---|---|---|
| A50 read/write/sync | 66/136/2725 | 157/331/4801 | 121/250/3032 | 136/275/4208 |
| A50 5xx/503 | 0/0 | 0/0 | 0/0 | 0/0 |
| B50 read/write/sync | 171/326/3654 | 413/993/11512 | 191/389/5202 | 522/1092/9197 |
| B50 5xx/503 | 0/282 | 0/346 | 0/288 | 0/316 |
| A100 read/write/sync | 418/1022/12784 | 438/1156/14012 | 846/1877/25866 | 827/2106/27231 |
| A100 5xx/503 | 0/0 | 0/0 | 0/0 | 3/0 |
| B100 read/write/sync | 656/1633/22715 | 893/1951/23083 | 561/1387/15380 | 442/915/15027 |
| B100 5xx/503 | 0/708 | 0/715 | 0/784 | 0/855 |
| C50 read/write/sync | 229/418/8350 | 284/555/11778 | 399/829/13071 | 271/643/12437 |
| C50 order-create p95 | 562 | 736 | 1163 | 762 |
| C50 5xx/503 | 0/0 | 0/0 | 0/0 | 0/0 |
| C100 read/write/sync | 627/1665/23982 | 798/1779/28400 | 735/1736/27104 | 867/2071/29099 |
| C100 order-create p95 | 2205 | 2438 | 2417 | 2694 |
| C100 5xx/503 (conn_err) | 0/0 (0) | 0/1 (2) | 0/0 (14) | 0/0 (0) |

Dashboard (B): hit p95 B50 2362/5907/3713/3031 (n=100-186), B100 6615/10444/9990/4527; miss p95 (n=3-4/run) B50 11.2/18.5/13.2/13.5 s, B100 17.0/23.2/21.1/15.1 s. sync-push-20 p50: A50 622-1744, C50 1954-6368, C100 18.4-20.1 s. RPS: A50 35-37, A100 47-61, B50 31-34, B100 49-66, C50 23-26, C100 41-45. 429 hamma runlarda 0.
**Lock tahlili (C, pg_locks/pg_stat_activity, 8 run):** kutuvchi lock'larning deyarli hammasi `transactionid ShareLock` (boshqa tx tugashini kutish), kutuvchi so'rov bo'yicha: `INSERT INTO "DocumentCounter"` 3445+96 (tuple) namuna ~95%, `SELECT ... FROM "Customer" WHERE id=$1 FOR UPDATE` 58+3, `FOR KEY SHARE` 12, `RELEASE SAVEPOINT sales_order_create` 11, `INSERT INTO "StockLevel"` 9. Ya'ni SO raqamini kech ajratish ham to'sqichni yo'qotmadi — `DocumentCounter` qatori hanuz yagona serial nuqta. Lock ulushi (velto_app faol sessiyalarda wait_event_type=Lock): A50 4-10%, B50 5-11%, A100 27-31%, B100 23-27%, C50 27-39%, C100 44-46% (oldin: 37/29/53/42/70/71% — kamaygan). 'Transaction already closed' (log): A100 r2 rerun 1/3, C100 4/4/1/6 (jami 19; C50 va qolgan runlarda 0; oldin 126+). 55P03 (lock_timeout 2 s -> RETRY/503): C100 1/3/1/0, A100 r2 warm 1; ochiq SERVICE_BUSY logda 0 (hisobot 503 lari logga yozilmaydi, k6 hisobi: yuqorida). verify-integrity 24/24 (+2 qayta run) = 0 topilma; deadlocks 0 (har run'da).

| Mezon | Oldin (eba0895) | Keyin (8f0cea8) | Holat |
|---|---|---|---|
| 50 VU read p95 <= 300 | A 89-252, B 59-367, C 113-371 | A 66-157, B 171-522, C 229-399 | A **O'TDI** 4/4; B 2/4; C 3/4 |
| 50 VU write p95 <= 700 | A 193-707, B 97-1003, C 407-1007 | A 136-331, B 326-1092, C 418-829 | A **O'TDI** 4/4; B 2/4; C 3/4 — umuman **qisman O'TMADI** |
| 100 VU 5xx = 0 | A 11/0/0/0, B 0, C 5/12/2/0 | A 0/0/0/3, B 0/0/0/0, C 0/0/0/0 (ulanish uzilishi C100 r2 cold 14) | B, C **O'TDI**; A 7/8 (r2 warm 3 ta 5xx) — **deyarli** |
| 503 (alohida) | B50 197-311, B100 859-895 | B50 282-346, B100 708-855; C100 1 | hisobotlar semafori, bitta tenant |
| Dashboard p95 <= 2 s | hit B50 0.9-2.8 s, B100 1.7-3.7 s; miss 5.9-14.9 s | hit B50 2.4-5.9 s, B100 4.5-10.4 s; miss 11-23 s | **O'TMADI** (hit ham yomonlashdi) |
| 'Transaction already closed' | A100 37, C50 6, C100 83 | 19 jami (C100 15, A100 r2 4) | **kamaydi**, nolga tushmadi |
| verify-integrity = 0 | 0 (24/24) | 0 (24/24 + 2) | **O'TDI** |
| deadlocks = 0 | 0 | 0 | **O'TDI** |

**Xulosa:** 5xx deyarli yo'qoldi (A100 r2 warm da 3 ta bundan mustasno), 'Transaction already closed' ~126 -> 19, lock ulushi C da 70% -> 44-46%, sync p95 A50 va A100 cold da yaxshilandi. Hali o'tmaydi: (a) C va A100 write/sync p95 (C100 sync 24-29 s, order-create 2.2-2.7 s) — to'sqich `INSERT INTO "DocumentCounter"` (≈95% kutish), ya'ni raqamni kech ajratish counter qatorini ketma-ket qilib qoldirgan; (b) dashboard hit/miss — hisobot semafori (1+5) navbati hit ni ham sekinlashtiradi (hit 2.4-10 s), miss 11-23 s; (c) B50/C50 warm da read/write limitdan o'tmaydi (hisobot / sync bilan raqobat). Takliflar (prod kodiga tegilmadi): `DocumentCounter` ni per-user/blokli (masalan 20 ta oldindan band qilish, alohida avtonom tx da) yoki PG sequence; dashboard hit uchun keshni semafordan OLDIN tekshirish; miss uchun fon isitish.

## Oldingi: Yangi kod bilan qayta o'lchov (2026-10-20, kod: eba0895 — sync push hujjat-bo'yicha tx, hisobot semafori per-tenant kvota, dashboard kesh, indeks, 40P01 tuzatish, pool 30, health kesh)
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
