# Velto — joriy holat

> Yangilangan: 2026-10-30. **Bu fayl ≤60 qator:** faqat joriy holat. Tugagan ish, ADR, eski qarz va tarix → `docs/STATUS-ARCHIVE.md` (faqat grep bilan).

## Fazalar
F0–F6, F8.1, F5.3+, F4.5: ✅ kod tomoni. F7 chiniqtirish: ✅ kod, yuk mezonlari qisman. Oxirgi to'liq checks: 1067/1067 (2026-10-30). Hamma ish feature branch'larda; joriy: `feat/f7-6-dashboard-perf`.

## Joriy task: F7.6 dashboard miss (TZ §12.1)
Kod ✅ (ADR-056: to'liq SWR, alohida permit yo'lagi, pool boot tekshiruvi). Reviewer va security-auditor PASS, checks: api 834, database 113, miniapp 120; lint/typecheck/build toza (2026-10-30).
**Isbotlanmagan:** miss/hit maqsadi yuk ostida qayta o'lchanmagan. Sokin host va foydalanuvchi tasdig'i kerak (S20, M50, 3 takrordan, `docs/perf/F7-load-report.md`). M50 cold dagi 1 write 5xx sababi noma'lum. Refresh xatosidan keyin backoff (ttl/4) qo'shildi: reviewer PASS, api test 835/835, lint/typecheck toza. 2026-10-30 da host load average 50 edi, yuk testi o'tkazilmadi.

## Foydalanuvchi qarori kutilmoqda
1. Yuk o'lchovi vaqti (hostni bo'shatish).
2. Ochiq savollar (telefon noyobligi, MFA, HALF_UP, CSV ajratgich, 1C pilot, qurilmalar ro'yxati): `grep -n -A12 '^## Ochiq savollar' docs/STATUS-ARCHIVE.md`.

## Keyingi qadamlar
1. Joriy task.
2. F7 qoldig'i: hisobot semafori kvotasi, shubhali r2 run'lar, GA sign-off (inson imzosi), v0.9/v1.0 gate'lar (`docs/PLAN.md`).
