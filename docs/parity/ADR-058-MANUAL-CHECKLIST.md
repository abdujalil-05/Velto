# ADR-058 MFA — inson tasdig'i kerak bo'lgan qabul tekshiruvlari

Holat: **KUTILMOQDA** (hech biri PASS emas, faqat inson tasdiqlagandan keyin belgilanadi).
Avtomatlashtirilgan va brauzerda bajarilgan ssenariylar: `docs/STATUS.md` (ADR-058 bo'limi).

| # | Ssenariy | Kutilgan natija | Holat |
|---|----------|-----------------|-------|
| 1 | Haqiqiy telefondagi autentifikator ilovasi (Google Authenticator / Aegis) bilan QR'ni skanerlash, birinchi enroll va keyingi login | Ilova kodi qabul qilinadi; recovery kodlar bir marta ko'rsatiladi | ⏳ |
| 2 | Haqiqiy Telegram'da imtiyozli rol (OWNER/SALES_DIRECTOR/CASHIER) bilan Mini App'ga kirish | 403 `MFA_WEB_LOGIN_REQUIRED`, tushunarli xabar; MFA chetlab o'tilmaydi (hozircha faqat e2e) | ⏳ |
| 3 | Mini App UI: sessiya tugashi (`AUTH_SESSION_EXPIRED`) va MFA reset'dan keyin token bekor qilinishi | "Sessiya tugadi" xabari, qayta login; offline navbat saqlanadi | ⏳ |
| 4 | Bir xil 30 s oynada TOTP kodini qayta ishlatish (login va step-up reset) | Ikkinchi urinish rad etiladi (`lastUsedStep`), audit yozuvi bor | ⏳ |

Tasdiqlovchi: ________  Sana: ________
