# Velto — joriy holat

> Yangilangan: 2026-10-30. **Bu fayl ≤60 qator:** faqat joriy holat. Tugagan ish, ADR, eski qarz va tarix → `docs/STATUS-ARCHIVE.md` (faqat grep bilan).

## Fazalar
F0–F6, F8.1, F5.3+, F4.5: ✅ kod tomoni. F7 chiniqtirish: ✅ kod, yuk mezonlari qisman. Oxirgi to'liq checks: 1067/1067 (2026-10-30). Hamma ish feature branch'larda; joriy: `feat/f7-6-dashboard-perf`.

## Joriy task: F7.6 dashboard miss (TZ §12.1)
Kod ✅ (ADR-056: to'liq SWR, alohida permit yo'lagi, pool boot tekshiruvi). Reviewer va security-auditor PASS, checks: api 834, database 113, miniapp 120; lint/typecheck/build toza (2026-10-30).
Refresh xatosidan keyin backoff (ttl/4) qo'shildi: reviewer PASS, api test 835/835, lint/typecheck toza.
**Qayta o'lchov #2 (2c4bd46, 12/12 run, S20/M50, `docs/perf/F7-load-report.md`):** hit p95 11/12 <300 ms (M50 r3 cold 309). Miss p95 3/6 cold run'da ≤2 s (1037-1381 ms), 3 tasida o'tmadi (2043, 3797, 6450 ms), n=1-8; warm'da miss 0. 5xx, deadlock, 55P03, 'Transaction already closed' 0; integrity 0 topilma. M50 r2-r3 da hisobot 503: 14-67.
**Isbotlanmagan:** hamma run SUSPECT (load 4.9-36.5, swap 4.7-6.1 GB, `ruscha-local` ishlab turgan); yukning qancha qismi testning o'zidan ekani ajratilmagan. Miss maqsadi O'TMADI. Eski M50 cold write 5xx qaytarilmadi, sababi noma'lum.

## Foydalanuvchi qarori kutilmoqda
1. F7.6 miss: `ruscha-local` to'xtatilgan holda qayta o'lchash yoki natijani qabul qilish.
2. Ochiq savollar (telefon noyobligi, MFA, HALF_UP, CSV ajratgich, 1C pilot, qurilmalar ro'yxati): `grep -n -A12 '^## Ochiq savollar' docs/STATUS-ARCHIVE.md`.

## Keyingi qadamlar
1. Joriy task.
2. F7 qoldig'i: hisobot semafori kvotasi, shubhali r2 run'lar, GA sign-off (inson imzosi), v0.9/v1.0 gate'lar (`docs/PLAN.md`).
