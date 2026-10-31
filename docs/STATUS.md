# Velto — joriy holat

> Yangilangan: 2026-10-31. **Bu fayl ≤60 qator:** faqat joriy holat. Tugagan ish, ADR, eski qarz va tarix → `docs/STATUS-ARCHIVE.md` (faqat grep bilan).

## Fazalar
F0–F6, F8.1, F5.3+, F4.5: ✅ kod tomoni. F7 chiniqtirish: ✅ kod, yuk mezonlari qisman. Oxirgi to'liq checks: 1067/1067 (2026-10-30). Hamma ish feature branch'larda; joriy: `feat/approved-decisions` (`feat/f7-6-dashboard-perf` ustida).

## F7.6 dashboard miss (TZ §12.1): kod yopildi, maqsad lokal isbotlanmadi
Kod: ADR-056 (SWR, permit yo'lagi, pool boot tekshiruvi), refresh backoff ttl/4, P2028 expired tx -> 503 SERVICE_BUSY (deliver rollback va retry real testlangan), `PERF_METRICS` (default off). Reviewer, security-auditor PASS; api test 845/845, lint/typecheck/build toza.
Nazorat o'lchovi (M50, 91f2cb2, 1 takror, `docs/perf/F7-load-report.md`): miss p95 cold 1070, warm 1225 ms (n=3); hit p95 cold 52, warm 710 ms (maqsad <300, O'TMADI). 5xx 0. Warm'da 4 P2028 (2 write, 2 hisobot). Permit wait 0-1 ms: rad etildi. Compute 318-1868 ms tinch vaqtda; 4800-12185 ms faqat 12 s oynada (LA 18.9, event loop max 559 ms).
**Isbotlanmagan:** bu oyna sababi (host yoki o'z yukimiz). Maqsad production'ga o'xshash stendda o'lchanadi. Integrity ikki run'dan keyin 1 marta: 0 topilma (`max_parallel_workers_per_gather=0` bilan; birinchi urinish Docker /dev/shm 64 MB tufayli yiqildi).
Ma'lum LOW: `perf-metrics.ts:41` `start()`siz xotira o'sishi (faqat flag yoqilganda); `auth.service.ts:213` Telegram replay hisoblagichi tx'dan oldin oshadi, retry maxUses ni yeyishi mumkin. Docker Postgres `shm_size` oshirilmagan.

## Joriy task: ADR-057..064 (PO qarorlari yakuniy, kod YOZILMAGAN)
Qarorlar: `STATUS-ARCHIVE.md`. Verdikt va tartib: `docs/parity/PLAN-ADR-057-064.md`. Real moliyaviy pilot gate'i BLOCKED (ADR-058).
ADR-057/057a API ✅ (commit, push): auth test 58/58 (2 marta ketma-ket), tsc toza; reviewer va security-auditor PASS. Kontrakt o'zgardi (`requiresCompanySelection`, `requiresAccountSelection`, yangi `/auth/login/select-company`, `/auth/password-reset/select-account`): web ekranlarisiz `main` ga chiqmaydi. LOW: reset limitini sarflab egasini ~1 soat bloklash mumkin (egallash yo'q); N>3 akkaunt login vaqtida sezilarli; login 3x argon2 (sekinroq); IP yo'q so'rovlar umumiy `unknown` limitida.
ADR-061 read-only audit skripti ✅ (`packages/database/src/audit-deleted-customers.ts`, test 3/3, reviewer PASS). velto_dev: 8 kompaniyada o'chirilgan mijozlarning 36 CONFIRMED buyurtmasi rezerv bilan; 4 kompaniyada `code` faol mijozda (restore to'qnashuvi); post-delete to'lov, qarz, avans, PENDING_HANDOVER 0. Dev ma'lumot pilotni isbotlamaydi: pilotda ham ishlatish kerak. `close()` (`sales.service.ts:613`) to'lovni tekshirmaydi, shuning uchun o'chirishning o'zi qarz/avans/handover'ni tekshiradi. LOW: `:77` join katta kompaniyada sekin.
OCHIQ, tashqi: buxgalter sign-off (HALF_UP), real 1C import, qurilmalar matritsasi, stendda F7 yuk, GA sign-off.

## Keyingi qadamlar
1. ADR-057 web (`web-dev`, keyin `i18n-sync`).
2. F7 qoldig'i: stendda yuk o'lchovi (F7.6 maqsadi, shubhali r2 run'lar, ko'p tenantda hisobot semafori kvotasi), GA sign-off (inson imzosi), v0.9/v1.0 gate'lar (`docs/PLAN.md`).
