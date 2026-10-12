# Velto — reja (TZ v4.0 bo'yicha MVP ni to'liq yakunlash)

> Qoidalar: `docs/WORKING-AGREEMENT.md`. Joriy holat: `docs/STATUS.md`. Talablar: `docs/VELTO-TZ-v4.0.md`.
> Reja faza darajasida; har faza boshida `architect` uni DoR (§15.2) bilan aniq tasklarga bo'ladi. Tartib xavf va bog'liqlik bo'yicha: avval to'g'rilik/xavfsizlik, keyin funksiya, keyin chiniqtirish.

Boshlang'ich holat: kod bazasi katta qismi yozilgan (audit 2026-10-12, `STATUS.md`). Yondashuv — **modul-modul tekshirib, yetishmaganini qurish, sifatsizini yaxshilash** (qayta yozish emas).

## Faza 0 — Poydevor va haqiqiy baseline
- F0.1 Lokal baza (Docker, portlar 5433/6380), migratsiyalar, **barcha mavjud testlar haqiqiy bazada**: natija = haqiqiy qizil/yashil ro'yxat (`checks`).
- F0.2 M08 Xarid ni bazada tasdiqlash (13 test + izolyatsiya), `backfill-permissions.ts` zarurati.
- F0.3 Git gigienasi: branch tuzilmasi, mantiqiy commitlar, push.
- F0.4 Qizil testlar bo'lsa — tuzatish (`fixer`/egasi agent).
- **Chiqish:** testlar real DB'da yashil; STATUS da M08 = Tayyor.

## Faza 1 — Xavfsizlik va shartnoma poydevori (TZ §7.1, §10.4, §11, §16.3)
- F1.1 `traceId`/korrelyatsiya ID: error filter + interceptor + JSON loglar (NFR §12.3).
- F1.2 Auth P0 testlari: refresh-reuse (family revoke), `initData` valid/invalid/expired/replay, 403+audit.
- F1.3 Idempotentlik: confirm/deliver/cash-session close/to'lov — `Idempotency-Key` yoki `clientId` (NFR-REL-007); stock `ensureStockLevelRow` race (P2002) tuzatish.
- F1.4 Rollar: ADR-003/003a rasmiylashtirish (COURIER qoladi, PLATFORM_ADMIN oqimi), `ACCOUNTANT` cheklovlari testi.
- F1.5 Audit moduli testi va maskalash; secret-scan/dependency-scan CI.
- **Chiqish:** §16.3 P0 xavfsizlik bandlari testlar bilan yopilgan; `security-auditor` PASS.

## Faza 2 — Ombor va moliya yadrosi (TZ §6.3–6.6, §10.5, §16.1)
- F2.1 Reversal/correction oqimi: Payment void/reversal, StockMovement correction (faqat ruxsatli admin oqimi).
- F2.2 Avans ko'rinishi (ledger), balans = formula, `cachedBalance` drift reconciliation job + alert (§6.4/6.5).
- F2.3 Aging as-of qoidasi va testi; invoices testlari; 5 qatorli VAT/chegirma P0 ssenariysi; yaxlitlash strategiyasi testi.
- F2.4 Ombor chiqimi (goods issue) aniq operatsiya sifatida: movement + status bitta tx; qisman bajarish (`deliveredQty`) testlari.
- F2.5 Qoldiq qayta hisoblash (admin-only reconciliation job).
- F2.6 Parallel testlar: oxirgi qoldiq, parallel allocation, sequence (§10.5).
- **Chiqish:** §16.1 moliya/ombor bandlari testlar bilan yopilgan.

## Faza 3 — Dala savdosi va kuryer (TZ §9.4, M07, ADR-003a)
- F3.1 GPS natijalari: ruxsat yo'q / aniqlik past / koordinata yo'q / radiusdan tashqari — server tomonda alohida.
- F3.2 Marshrut yakuni server validatsiyasi; koordinatasiz nuqta uchun data-quality alert.
- F3.3 Kuryer oqimi MVP chegarasida (oddiy yetkazish) — tekshirish va sifatini yaxshilash, TZ ga ADR.

## Faza 4 — Offline/sinxronizatsiya (TZ §8, §16.2)
- F4.1 Stale price/stock konflikt UI; "Saved on device"/"Synced" holatlari.
- F4.2 Pending navbatni cache cleanup o'chira olmasligi; storage quota; logout/revoke xatti-harakati.
- F4.3 Offline qabul testlari (airplane mode, 20 order, 3x resend, mid-sync cut) + qo'llab-quvvatlanadigan qurilmalar matritsasi.
- F4.4 Sync perf (NFR-PERF-004..006).

## Faza 5 — Hisobot, import/eksport, 1C (TZ §7.3, M09/M10/M12)
- F5.1 Hisobot eksporti = ekrandagi filtrlar (test); hisobot formulalari ekranda.
- F5.2 Import: 1000 mijoz/2000 mahsulot preview, xato qatorlari, takroriy importda dublikat yo'q (test).
- F5.3 1C eksport: pilot konfiguratsiya mapping'i (foydalanuvchi/buxgalter ishtiroki), CSV/XLSX fallback, takroriy eksport himoyasi.
- F5.4 Notifications/job holatlari UI; audit UI.

## Faza 6 — Platforma (TZ M00/M11)
- F6.1 Trial holati, sozlamalar testi; `PLATFORM_ADMIN` (cheklangan, auditli support kirishi).
- F6.2 Onboarding to'liq yo'l (wizard → import → agent qo'llanmasi), P1 foydalanuvchanlik.

## Faza 7 — Chiniqtirish va reliz (TZ §12, §16.4, §17)
- F7.1 E2E (order→confirm→issue→invoice→payment→report), yuk testi (50/100 agent, NFR-PERF).
- F7.2 Backup/restore mashqi (RPO/RTO), `/health/live|ready`, monitoring/alert, deploy tekshiruvi (port 3101 va PM2 haqiqiy konfiguratsiya bilan).
- F7.3 a11y, i18n CI tekshiruvi, hardcoded string tekshiruvi, performance hisoboti.
- F7.4 Reliz oldi checklist (§16 hammasi), TZ ↔ kod nomuvofiqliklarini yopish, hujjatlar (OpenAPI).

## Har faza oxirida
STATUS yangilanadi → foydalanuvchiga qisqa hisobot + "`/clear` qilsangiz bo'ladi" → branch push → keyingi faza.
