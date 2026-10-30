# Velto — joriy holat

> Yangilangan: 2026-10-30. **Bu fayl ≤60 qator:** faqat joriy holat. Tugagan ish, ADR, eski qarz va tarix → `docs/STATUS-ARCHIVE.md` (faqat grep bilan).

## Fazalar
F0–F6, F8.1, F5.3+, F4.5: ✅ kod tomoni. F7 chiniqtirish: ✅ kod, yuk mezonlari qisman. Oxirgi to'liq checks: 1061/1061 (2026-10-22). Hamma ish feature branch'larda; joriy: `feat/f7-6-dashboard-perf` (push qilinmagan).

## Joriy task: F7.6 dashboard miss (TZ §12.1, ADR-053)
O'lchov (host band, natijalar shubhali, `docs/perf/F7-load-report.md`): hit p95 113–379 ms (M50 cold 379 dan tashqari maqsadda), miss p95 4.9–11.3 s (maqsad ≤2 s); yuksiz miss 0.65–0.96 s. M50 cold da 1 write 5xx, sababi noma'lum.

Architect rejasi (kutilmoqda — pastdagi 1-qaror):
1. api-dev: compute uchun bitta log qatori (`permitWaitMs`, `poolWaitMs`, `computeMs`, `mode`).
2. api-dev: to'liq SWR — TTL tugagach eski qiymat (yoshi <2×TTL), fon refresh single-flight; xato loglanadi; aniq `companyId` bilan `tenantPrisma.run`, ALS ga tayanmaydi.
3. api-dev: dashboard'ga alohida `ReportConcurrencyLimiter` instansi (`DASHBOARD_MAX_CONCURRENCY=2`, `DASHBOARD_TENANT_MAX_CONCURRENCY=1`).
4. qa-engineer: refresh tenant izolyatsiyasi, parallel 10 chaqiruvda 1 compute.
5. reviewer → fixer → security-auditor → checks. ADR-056 yoziladi.
6. Yuk o'lchovi — faqat foydalanuvchi hostni bo'shatganini aytganda (S20, M50, 3 takrordan).

## Foydalanuvchi qarori kutilmoqda
1. Dashboard TTL tugagach birinchi foydalanuvchiga ham ~31 s gacha eskirgan qiymat ko'rsatilsinmi (reja shunga tayanadi)?
2. Ochiq savollar (telefon noyobligi, MFA, HALF_UP, CSV ajratgich, 1C pilot, qurilmalar ro'yxati): `grep -n -A12 '^## Ochiq savollar' docs/STATUS-ARCHIVE.md`.

## Keyingi qadamlar
1. Joriy task.
2. F7 qoldig'i: hisobot semafori kvotasi, shubhali r2 run'lar, GA sign-off (inson imzosi), v0.9/v1.0 gate'lar (`docs/PLAN.md`).
