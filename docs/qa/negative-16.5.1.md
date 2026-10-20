# TZ v5.0 §16.5.1 — negative test traceability

Holat: BOR (kod testi) / QISMAN / YO'Q / QURILMA (faqat pilot-qurilma dalili). Yo'llar `apps/api` ichida, aks holda to'liq ko'rsatilgan. Qator raqamlari 2026-10-19 holati.

| # | Band (TZ matni, qisqa) | Mavjud test (fayl:qator) | Holat | Yetishmayotgan spetsifikatsiya |
|---|---|---|---|---|
| 1 | New owner login, `companyId` tamper -> 403/404 | `test/company-export.e2e.test.ts:221` (B owner, A job id -> 404); `src/modules/sales/sales.service.test.ts:287,547` (spoofed filter); `packages/database/src/__tests__/tenant-isolation.test.ts:16` (RLS) | QISMAN | Yangi owner (bootstrap) bilan login, so'rov body/query/header'ida boshqa `companyId` yuborish -> javob/DB'da faqat o'z tenanti (companyId JWT'dan, body'dan emas). Alohida e2e yo'q. |
| 2 | Parallel duplicate payment IDs -> bitta payment | `src/modules/finance/payments/payments.service.test.ts:178` (ketma-ket clientId), `:232` (parallel allocation), `test/idempotency.e2e.test.ts:172` (cash-session close x4); `src/modules/sync/sync.service.test.ts:286` (cash 3x parallel, bitta clientId, ADR-029) | QISMAN | `POST /payments` HTTP orqali bitta clientId / bitta Idempotency-Key bilan Promise.all x6 -> 1 ta POSTED payment, allocation sum <= amount. Hozir service darajasida parallel same-clientId (create) testi yo'q. |
| 3 | Offline paytda agent roli olinsa -> yangi mutation rad, oxirgi qabul qilinganlar auditda | **YOZILDI**: `test/f7-negative-16.5.1.e2e.test.ts` (test 1). Avval: `test/f4-offline-sync.e2e.test.ts:220` (faqat 403+nothing written). Klient: `miniapp/src/lib/offline/sync-engine-core.test.ts:158` (403 -> batch FAILED, qayta yuborilmaydi) | BOR | — (pilot: qurilmada "E'tibor kerak" UI ko'rinishi G4 dalili) |
| 4 | SKU VAT/narx offline paytda o'zgarsa -> foydalanuvchi qayta tasdiqlashi (eski/yangi jami) | `src/modules/sales/sales.service.test.ts:188,221`; `src/modules/sync/sync.service.test.ts:394`; `test/f4-offline-sync.e2e.test.ts:159`; `miniapp/src/lib/offline/f4-offline-qa.test.ts:62`; `miniapp/src/lib/offline/queue.test.ts:129` (resolveConflictResubmit) | QISMAN | VAT stavkasi o'zgarishi (narx emas) -> CONFLICT + eski/yangi total — alohida test yo'q (faqat unit-price). |
| 5 | Confirm poygasida qoldiq o'zgarsa -> oversell yo'q, ikki marta reserve/issue yo'q | `src/modules/sales/sales.service.test.ts:360` (2 parallel confirm), `:383` (2 parallel deliver), `:1050`; `src/modules/stock/stock.service.test.ts:121` (oxirgi birliklar); `test/idempotency.e2e.test.ts:97,115`; `src/modules/sales/delivery-race.test.ts:268` | BOR | — |
| 6 | Tasdiqdan keyin bekor -> release bir marta, ikkinchi debet yo'q | Avval: `sales.service.test.ts:338` (bitta cancel releases), `:314` (deliverdan keyin cancel rad), `delivery-race.test.ts:268` (cancel vs confirm). **YOZILDI**: `test/f7-negative-16.5.1.e2e.test.ts` (test 2: parallel x4, 2 qator) | BOR | — |
| 7 | 1C import fayli ikki marta -> dublikat rasmiy hujjat yo'q | Eksport: `test/export-1c-idempotency.e2e.test.ts:14`, `test/export-1c-hardening.e2e.test.ts:184` (re-export bir xil hujjatlar); mijoz/mahsulot importi: `test/f5-import.e2e.test.ts:125,159,183` | QISMAN / pilot G4 | Kodda "1C import" (1C -> Velto yoki 1C'ga yuklash natijasi) oqimi yo'q — buxgalter 1C'ga yuklashi pilot konfiguratsiyasida qo'lda: **pilot dalili G4**. Kodda: bir xil eksport faylini ikki marta ACK qilish (`export-1c-ack-download.e2e.test.ts`) mavjud. |
| 8 | `=HYPERLINK(...)` outlet nomi eksportda formula bo'lmaydi | `src/common/export/spreadsheet-safety.test.ts:9`; `test/export-1c-hardening.e2e.test.ts:392-394`; `test/company-export.e2e.test.ts:132,205`; (report-export: `test/report-export-audit.e2e.test.ts`, `test/report-export-permissions.test.ts` — RBAC/audit; formula tozalash report CSV/XLSX uchun alohida tasdiqlanmadi) | QISMAN | Outlet/mijoz nomi `=HYPERLINK(...)` bilan 4 ta report export (CSV+XLSX) -> katak `'` bilan boshlanadi. Hisobot eksportlari uchun to'g'ridan-to'g'ri test topilmadi. |
| 9 | Foydalanuvchi eksport yuklashga ruxsatni yo'qotsa -> havola rad | **YOZILDI**: `test/f7-negative-16.5.1.e2e.test.ts` (test 3: 1C download, shu JWT, rol olinadi -> 403 + audit; deaktivatsiya -> 401). Avval: `company-export.e2e.test.ts:211` (rolsiz 403) | BOR (API oqimi) | Pre-signed URL ishlatilsa (hozir API stream) — URL muddati qisqa/scope: `storage.service.test.ts:11` faqat kalit prefiksi; yo'q. Company-export download uchun rol-olib-tashlash varianti (xuddi shu mexanizm, alohida test yo'q). |
| 10 | Redis/worker 1 soat o'chiq -> commit saqlanadi, event takrorsiz tiklanadi | `src/modules/integrations/export-1c/export-1c.processor.test.ts` (processor), `test/export-1c-hardening.e2e.test.ts` (recovery sweep) — outage stsenariysi emas | YO'Q | Keyingi bosqich (integrations-dev tugagach): Redis to'xtatilgan holda mutation -> DB commit + outbox qatori; qayta ishga tushganda event bir marta, notification/payment dublikati yo'q. |
| 11 | Backup'ni toza muhitga tiklash: DB check, stock/ledger reconciliation, audit continuity, RPO/RTO | `src/modules/reconciliation/reconciliation.service.test.ts` (reconciliation mantig'i, restore emas) | YO'Q (devops drill) | devops staged restore drill + restore'dan keyin reconciliation endpoint/skript natijasi + audit zanjiri butunligi; RPO/RTO hisoboti artefakti. |
| 12 | iPhone TMA IndexedDB evict -> offline qo'llab-quvvatlanadi deb da'vo yo'q | `miniapp/src/lib/offline/storage-budget.test.ts`, `f4-offline-qa.test.ts:251` (quota) — evict emas | QURILMA | Faqat real qurilma dalili (support matrix). Kod testi: IndexedDB mavjud emas/bo'sh -> UI "offline qo'llab-quvvatlanmaydi" + PWA yo'naltirish (miniapp unit, keyingi). |

## §16.1 / §16.2 / §16.3 P0 -> test -> holat (qolgan bo'shliqlar)

| P0 band | Test | Holat |
|---|---|---|
| 16.1 onboarding + import | `test/f5-import.e2e.test.ts` | BOR; to'liq onboarding->import e2e: QISMAN |
| 16.1 1000/2000 preview, xato qatorlar, idempotent | `f5-import.e2e.test.ts:125,159,183` | BOR |
| 16.1 5-qator buyurtma server qayta hisoblaydi | `sales.service.test.ts:615`, `line-total.test.ts` | BOR |
| 16.1 confirm atomik reserve; 2 parallel confirm | `sales.service.test.ts:360`, `idempotency.e2e.test.ts:97` | BOR |
| 16.1 issue = movement + status | `sales.service.test.ts:314,383` | BOR |
| 16.1 faktura = snapshot; ortiqcha to'lov avans | `sales.service.test.ts:835`; `payments.service.test.ts:366` | BOR |
| 16.1 1 500 000 FIFO 3 invoice | `payments.service.test.ts:93` (FIFO, umumiy); aynan 1 500 000/3 invoice qiymati tasdiqlanmadi | QISMAN |
| 16.1 reversal asl yozuvni o'chirmaydi | `payments.service.test.ts:489,535`; `reversal-rbac.e2e.test.ts` | BOR (payment); stock movement reversal: `stock.service.test.ts` — tasdiqlanmadi |
| 16.1 aging as-of | `finance/reports/aging-report.service.test.ts:83,91,102,126` | BOR |
| 16.1 visit/route serverda; GPS natijalari | `field/visits/visits.service.test.ts:127,170`; `field/routes/routes-finish-edge.test.ts`; `test/f3-visits-sync.e2e.test.ts` | BOR |
| 16.1 4 report filtr = export | `aging-report.service.test.ts:126` (faqat aging); `analytics.service.test.ts` | QISMAN (qolgan 3 report uchun screen==export testi yo'q) |
| 16.1 1C buxgalter qabuli | — | Pilot G4 dalili |
| 16.2 airplane mode local save; 20 order; triple resend; mid-sync; cleanup; quota; logout | `miniapp/.../f4-offline-qa.test.ts:122,184,205,251,272,312,325`; `queue.test.ts:72`; `test/f4-offline-sync.e2e.test.ts` | BOR (haqiqiy qurilma airplane-mode: pilot) |
| 16.2 stale price/stock conflict ko'rsatiladi | `sync.service.test.ts:394`; `queue-view.test.ts:35`; stock conflict: `sync.service.test.ts:385` (stock bo'yicha rad emas, qabul — TZ 8.4) | BOR (price), stock: dizayn bo'yicha qabul |
| 16.3 tenant A -> B (ID/query/export/file link) | `tenant-isolation.test.ts`; `export-1c-hardening.e2e.test.ts:220`; `company-export.e2e.test.ts:221`; `storage.service.test.ts:11` | BOR |
| 16.3 RLS app role | `tenant-isolation.test.ts:19` | BOR |
| 16.3 403 + audit | `permission-denied.e2e.test.ts`; `audit-events.e2e.test.ts` | BOR |
| 16.3 refresh reuse -> family revoke | `src/modules/auth/auth.service.test.ts:376` | BOR |
| 16.3 initData valid/invalid/expired/replayed | `auth.service.test.ts:482,563,583,602,632` | BOR |
| 16.3 mutation idempotency parallel | `idempotency.e2e.test.ts`, `f4-offline-sync.e2e.test.ts:209`, `payments.service.test.ts:232` | BOR |
| 16.3 secretlar repo/response/log | `audit-events.e2e.test.ts:168`; `http-exception.filter.test.ts:81`; CI Semgrep | QISMAN (log skaneri testi yo'q) |
| 16.3 backup restore | — | YO'Q (devops drill) |

## Keyingi bosqich (agentlar tugagach)
Redis-outage (#10), maintenance/health/429 e2e, yuk testlari, #1 companyId tamper e2e, #2 HTTP parallel payment, #4 VAT conflict, #8 report export formula, company-export download rol-olib-tashlash varianti.
