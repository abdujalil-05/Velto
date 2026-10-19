# Velto — reja (Master TZ v5.0 bo'yicha MVP ni to'liq yakunlash)

> Qoidalar: `docs/WORKING-AGREEMENT.md`. Joriy holat: `docs/STATUS.md`. Talablar: `docs/VELTO-MASTER-TZ-v5.0-2026-10-19.md`.
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
- F5.3 ✅ (F5.3+, 2026-10-19; G4 buxgalter imzosi ochiq) 1C eksport: pilot konfiguratsiya mapping'i (foydalanuvchi/buxgalter ishtiroki), CSV/XLSX fallback, takroriy eksport himoyasi.
- F5.4 Notifications/job holatlari UI; audit UI.

## Faza 6 — Platforma (TZ M00/M11)
- F6.1 Trial holati, sozlamalar testi. (`PLATFORM_ADMIN` support kirishi qilinmaydi — ADR-003b; Faza 8 ga qarang.)
- F6.2 Onboarding to'liq yo'l (wizard → import → agent qo'llanmasi), P1 foydalanuvchanlik.

## Faza 7 — Chiniqtirish va reliz (TZ §12, §16.4, §17)
- F7.1 E2E (order→confirm→issue→invoice→payment→report), yuk testi (50/100 agent, NFR-PERF).
- F7.0 **Production'ga chiqish** (hozir yopiq, faqat F0–F6 tugagach): production rol modeli o'tkazish (`deploy/README.md` runbook), deploy, `main` ga merge.
- F7.2 Backup/restore mashqi (RPO/RTO), `/health/live|ready`, monitoring/alert, deploy tekshiruvi (port 3101 va PM2 haqiqiy konfiguratsiya bilan).
- F7.3 a11y, i18n CI tekshiruvi, hardcoded string tekshiruvi, performance hisoboti.
- F7.4 Reliz oldi checklist (§16 hammasi), TZ ↔ kod nomuvofiqliklarini yopish, hujjatlar (OpenAPI).

## Faza 8 — v5.0 gap-tahlil tartibi (qarorlar: STATUS ADR-028..033)

Tartib: hujjat gigienasi → moliya/ma'lumot → 1C → offline/PWA → platforma → chiniqtirish. Faqat Mode A (ADR-028).
- F8.0 Hujjat gigienasi (TZ v5 havolalari, ADR nomlash, ziddiyatlar) — **BAJARILDI (2026-10-19)**.
- F8.1 ✅ **BAJARILDI (2026-10-19, branch `feat/f8-1-payment-handover`)**: `PENDING_HANDOVER` oqimi + REJECTED (sabab majburiy); agent to'lovi har qanday usulda PENDING_HANDOVER; `payments.handover` faqat OWNER+CASHIER. Ochiq qoldi: opening balance importi, ADR-032 OWNER alert. Asl doira: `PENDING_HANDOVER` oqimi (ADR-029: agent naqdi qarzni kamaytirmaydi, kassir smenada qabul qilgach POSTED+FIFO; kassir/ofis to'lovi darhol POSTED), majburiy rad etish sababi, opening balance importi (sana, manba, sign-off), summa chegarasidan oshgan reversal/adjust uchun OWNER alert+audit (ADR-032; chegara TBD). → `db-rls`, `finance-stock`, `qa-engineer`
- F5.3+ ✅ **BAJARILDI (2026-10-19, branch `feat/f5-3-1c-hardening`, ADR-034..039; pilot buxgalter imzosi G4 ochiq)** 1C: ExportJob `GENERATED → ACCOUNTING_ACCEPTED | FAILED_REVIEW`, qo'lda ACK UI (checksum+izoh, audit), retry/fileHash/CSV zaxira/reversal bilan lock/davr TZ (ADR-024/025/030), signed URL + expiry, web 1C eksport sahifasi. → `integrations-dev`, `web-dev`
- F4.5 ✅ **BAJARILDI (2026-10-19, branch `feat/f4-5-offline-pwa`)**: PWA manifest (ikonkalarsiz), yagona holat yorliqlari, per-dataset staleness, revoke-wipe (403 AUTH_ACCOUNT_BLOCKED, ADR-022 karantin). Qurilma matritsasi (`docs/OFFLINE-DEVICE-MATRIX.md`) to'ldirilishi foydalanuvchi ma'lumotiga bog'liq; ikonkalar kerak. Keyingi: F6, F7. → `miniapp-dev`, `qa-engineer`
- F6 Platforma: trial holati, onboarding yo'li, UI yorlig'i "Ichki hisob" / "Внутренний счёт" / "Internal invoice" (ADR-033). **PLATFORM_ADMIN support access QILINMAYDI (ADR-003b)** — F6.1 dagi "cheklangan support kirishi" bekor. → `web-dev`, `i18n-sync`
- F7 Chiniqtirish: outbox qarori (ochiq), rate-limit, `/health/live|ready`, runbook'lar, restore drill, yagona yuk profili (TZ §12.5) bo'yicha perf. → `devops`, `qa-engineer`

### Gate'lar
- **v0.9 (yopiq pilot):** Mode A; F8.1 (PENDING_HANDOVER, opening balance); F5.3+ ACK + pilot 1C konfiguratsiyasida eksport qabuli; F4.5 pilot qurilmalarda matritsa; kunlik backup + restore drill (RPO 15m talab qilinmaydi); sign-off 3 imzo: Product, Accounting, Security.
- **v1.0 (GA):** barcha F5–F7 + §16 P0; RPO ≤15m (WAL/incremental) va RTO ≤4h isbotlangan; to'liq §16.5 matritsa imzolari; yuk profili (§12.5) hisoboti.
- **v1.1:** Mode B/DATA_CUTOVER, 4-eyes tasdiq, `/api/v1` prefiksi.

## Har faza oxirida
STATUS yangilanadi → foydalanuvchiga qisqa hisobot + "`/clear` qilsangiz bo'ladi" → branch push → keyingi faza.
