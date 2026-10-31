# Velto — joriy holat

> Yangilangan: 2026-10-31. **Bu fayl ≤60 qator:** faqat joriy holat. Tugagan ish, ADR, eski qarz va tarix → `docs/STATUS-ARCHIVE.md` (faqat grep bilan).

## Fazalar
F0–F6, F8.1, F5.3+, F4.5: ✅ kod tomoni. F7 chiniqtirish: ✅ kod, yuk mezonlari qisman. Oxirgi to'liq checks: 1067/1067 (2026-10-30). Hamma ish feature branch'larda; joriy: `feat/approved-decisions` (`feat/f7-6-dashboard-perf` ustida).

## F7.6 dashboard miss (TZ §12.1): kod yopildi, maqsad lokal isbotlanmadi
Kod: ADR-056 (SWR, permit yo'lagi, pool boot tekshiruvi), refresh backoff ttl/4, P2028 expired tx -> 503 SERVICE_BUSY (deliver rollback va retry real testlangan), `PERF_METRICS` (default off). Reviewer, security-auditor PASS; api test 845/845, lint/typecheck/build toza.
Nazorat o'lchovi (M50, 91f2cb2, 1 takror, `docs/perf/F7-load-report.md`): miss p95 cold 1070, warm 1225 ms (n=3); hit p95 cold 52, warm 710 ms (maqsad <300, O'TMADI). 5xx 0. Warm'da 4 P2028 (2 write, 2 hisobot). Permit wait 0-1 ms: rad etildi. Compute 318-1868 ms tinch vaqtda; 4800-12185 ms faqat 12 s oynada (LA 18.9, event loop max 559 ms).
**Isbotlanmagan:** bu oyna sababi (host yoki o'z yukimiz). Maqsad production'ga o'xshash stendda o'lchanadi. Integrity ikki run'dan keyin 1 marta: 0 topilma (`max_parallel_workers_per_gather=0` bilan; birinchi urinish Docker /dev/shm 64 MB tufayli yiqildi).
Ma'lum LOW: `perf-metrics.ts:41` `start()`siz xotira o'sishi (faqat flag yoqilganda); `auth.service.ts:213` Telegram replay hisoblagichi tx'dan oldin oshadi, retry maxUses ni yeyishi mumkin. Docker Postgres `shm_size` oshirilmagan.

## Joriy task: ADR-057..064 (qarorlar qabul qilingan, kod YOZILMAGAN)
Qarorlar: `STATUS-ARCHIVE.md`. Verdikt va tartib: `docs/parity/PLAN-ADR-057-064.md`. Real moliyaviy pilot gate'i BLOCKED (ADR-058).
OCHIQ, tashqi: buxgalter sign-off (HALF_UP), real 1C import, qurilmalar matritsasi, stendda F7 yuk, GA sign-off.

## Foydalanuvchi qarori kutilmoqda
Reja oxiridagi 5 savol (TOTP kutubxonasi, OWNER Telegram login, parol tiklash, reverseMovement alert, DELIVERED mijozni o'chirish).

## Keyingi qadamlar
1. Reja bo'yicha 1-vazifa (read-only audit), keyin ADR-057.
2. F7 qoldig'i: stendda yuk o'lchovi (F7.6 maqsadi, shubhali r2 run'lar, ko'p tenantda hisobot semafori kvotasi), GA sign-off (inson imzosi), v0.9/v1.0 gate'lar (`docs/PLAN.md`).
