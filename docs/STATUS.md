# Velto — joriy holat

> Yangilangan: 2026-10-30. **Bu fayl ≤60 qator:** faqat joriy holat. Tugagan ish, ADR, eski qarz va tarix → `docs/STATUS-ARCHIVE.md` (faqat grep bilan).

## Fazalar
F0–F6, F8.1, F5.3+, F4.5: ✅ kod tomoni. F7 chiniqtirish: ✅ kod, yuk mezonlari qisman. Oxirgi to'liq checks: 1067/1067 (2026-10-30). Hamma ish feature branch'larda; joriy: `feat/f7-6-dashboard-perf`.

## Joriy task: F7.6 dashboard miss (TZ §12.1)
Kod ✅ (ADR-056: to'liq SWR, alohida permit yo'lagi, pool boot tekshiruvi). Reviewer va security-auditor PASS, checks: api 834, database 113, miniapp 120; lint/typecheck/build toza (2026-10-30).
Refresh xatosidan keyin backoff (ttl/4) qo'shildi: reviewer PASS, api test 835/835, lint/typecheck toza.
**Qayta o'lchov #3 (12/12 run, S20/M50, `docs/perf/F7-load-report.md`; #2 ham shu yerda):** hit p95 10/12 <300 ms (o'tmadi: S20 r3 cold 432, M50 r3 cold 556). Miss p95 10/12 ≤2 s (o'tmadi: M50 r1 cold 2495 n=5, S20 r3 warm 2306 n=1), har run'da n=1-5, ishonchsiz. Integrity 0 topilma. Hisobot 503: S20 65, M50 125.
5xx 1 ta: M50 r3 cold, `POST /orders/:id/deliver` 500, 'Transaction already closed' (timeout 5000 ms, 5037 ms o'tgan); host bosimiga mos, isbotlanmagan. Eski M50 cold 5xx bilan bir xilligi tasdiqlanmagan.
**Isbotlanmagan:** 7/12 run SUSPECT (baseline load maks. >8, `ruscha-local` va VS Code ishlab turgan). Toza 5 run: hit 25-113 ms, miss 825-2495 ms, 5xx 0. Miss maqsadi to'liq O'TMADI.

## Foydalanuvchi qarori kutilmoqda
1. F7.6: natijani qabul qilish yoki miss/deliver timeout bo'yicha pool-wait va event-loop lag o'lchovini qo'shish.
2. Ochiq savollar (telefon noyobligi, MFA, HALF_UP, CSV ajratgich, 1C pilot, qurilmalar ro'yxati): `grep -n -A12 '^## Ochiq savollar' docs/STATUS-ARCHIVE.md`.

## Keyingi qadamlar
1. Joriy task.
2. F7 qoldig'i: hisobot semafori kvotasi, shubhali r2 run'lar, GA sign-off (inson imzosi), v0.9/v1.0 gate'lar (`docs/PLAN.md`).
