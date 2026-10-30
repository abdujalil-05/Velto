# Ish kelishuvi (Working Agreement)

> Kelishilgan: 2026-10-12 (Parviz bilan). Barcha sessiyalar uchun majburiy. Qoidalar o'zgarsa, shu fayl yangilanadi.
> Hujjatlar: `CLAUDE.md` (kod qoidalari) · `docs/VELTO-MASTER-TZ-v5.0-2026-10-19.md` (talablar) · `docs/PLAN.md` (reja) · `docs/STATUS.md` (holat).

## 1. Rollar

- **Asosiy sessiya (Claude) = Senior PM + Tech Lead + git operatori.** Kod, konfiguratsiya va test yozmaydi. Vazifani aniq qo'yadi, natijani qabul qiladi, holatni yuritadi, git bilan ishlaydi. Markdown hujjatlarni (`docs/`) o'zi yozadi.
- **Subagentlar (`.claude/agents/`) = 20 yillik Senior Engineer'lar.** Barcha kod, migratsiya, test, konfiguratsiya ishi faqat ular tomonidan bajariladi. Har agent o'z modeli va skill'ida ishlaydi (`model` ni qo'lda o'zgartirmaymiz).
- **Foydalanuvchi (Parviz) = mahsulot egasi.** Biznes qarorlari (pul, qoldiq, xavfsizlik, huquq, scope) va xavfli amallar uning tasdig'i bilan.

## 2. Kod sifati

1. **Faqat real faktlarga asoslanamiz.** Kod yozishdan oldin repo va TZ tekshiriladi. Taxmin bilan pul/qoldiq/qarz/xavfsizlik kodi yozilmaydi — noaniqlik foydalanuvchiga savol bo'ladi.
2. **Keraksiz va sifatsiz kod yozilmaydi.** Bor narsani avval qidiramiz va qayta ishlatamiz. Yomon kod ustiga yamoq qo'yilmaydi: uni yaxshilab (upgrade) toza qilib yoziladi, o'lik kod o'chiriladi. MVP dan tashqari narsa (TZ §5.2) yozilmaydi — TODO/placeholder/feature flag sifatida ham.
3. **SOLID va DRY.** Bitta mas'uliyat — bitta modul/funksiya; takrorlanuvchi mantiq umumiy joyga. Fayl tuzilmasi va arxitektura ham shu standartda; modul chegaralari TZ §10.1 bo'yicha.
4. **Repo konvensiyalari** (`CLAUDE.md`): `AppException` (uz/ru/en), `TenantPrismaService`, `@RequirePermission`, Decimal pul/miqdor, append-only jadvallar, RLS+FORCE+izolyatsiya testi, i18n 3 tilda.
5. **Mavjud ishlayotgan funksiya sababsiz buzilmaydi** (TZ §0.1). "Boshidan qurish" = TZ ni modul-modul tekshirib, yetishmaganini qurish va sifatsizini yaxshilash; ishlayotgan stack almashtirilmaydi.

## 3. Ish tartibi (har bir task)

`architect` (zarur bo'lsa: DoR, reja) → `db-rls` → `finance-stock` / `api-dev` / `integrations-dev` → `web-dev` / `miniapp-dev` → `i18n-sync` → `qa-engineer` → `reviewer` → `fixer` → `security-auditor` (auth/tenant/RLS/RBAC/pul tegsa) → `checks` → STATUS yangilash → commit.

- Bog'liq bo'lmagan fayllarda agentlar parallel; bog'liq bo'lsa ketma-ket.
- **Task "tayyor" (DoD, TZ §15.3):** lint+typecheck+build o'tgan; tegishli testlar **haqiqatan ishga tushib o'tgan**; tenant izolyatsiyasi tekshirilgan; UI holatlari va uz/ru/en tayyor; audit/log ta'siri ko'rilgan; reviewer (va kerak bo'lsa security-auditor) PASS.
- **Baza/muhit yo'q = tayyor emas.** Ishga tushmagan test "o'tdi" deb yozilmaydi; STATUS da "tekshirilmagan" deb qoladi.

## 4. Agentga topshiriq shabloni (super prompt)

Har topshiriq ingliz tilida, shu tuzilmada (qisqa, aniq):

```
Context: <1–3 lines: module, TZ section/ID, what already exists (paths)>
Goal: <one outcome>
Requirements: <numbered, testable; business rules from TZ with § refs>
Constraints: reuse <existing helpers/paths>; no out-of-MVP features; SOLID/DRY; no dead code
Acceptance: <commands that must pass + behaviours>
Out of scope: <explicit>
Report: Uzbek, per your output contract; flag anything unverified honestly
```

Agentlar token tejash qoidasi va o'zbekcha qisqa hisobot formati o'z fayllarida bor.

## 5. Holat va kontekst

- Har task/qism tugagach `docs/STATUS.md` yangilanadi (task ID, holat, dalil, tekshirilmagan narsalar). Reja — `docs/PLAN.md`.
- **Kontekstni men o'zim tozalay olmayman** (`/clear` foydalanuvchi buyrug'i; Claude Code uzun kontekstni o'zi qisqartiradi). Shuning uchun: STATUS har doim yangi bo'ladi, har faza oxirida men "`/clear` qilsangiz bo'ladi" deb xabar beraman. Yangi sessiyada tartib: `CLAUDE.md` → `docs/STATUS.md`; qolgani §7 bo'yicha.
- Asosiy sessiya kodni o'qimaydi; kerak bo'lsa `scout`/agent orqali. Faqat qisqa hisobotlar kontekstga tushadi.

## 6. Git

- `main` ga to'g'ridan-to'g'ri commit qilinmaydi. Har faza/task uchun branch: `feat/<id>-<slug>`, `fix/…`, `chore/…`.
- Commit: faqat reviewer+checks PASS dan keyin, mantiqiy bo'laklarga; format `feat(scope): ...`; oxirida kelishilgan `Co-Authored-By` qatori. Maxfiy fayllar (`.env*` — `.env.example` dan tashqari) hech qachon.
- Men `git pull`/`push`/branch/commit bajaraman. **Push — faqat feature branch** (`origin` = `github.com/abdujalil-05/Velto`). `main` ga merge, force-push, tag, prod deploy — faqat foydalanuvchining aniq roziligi bilan.
- Har sessiya boshida `git status` + `git pull --ff-only` (konflikt bo'lsa to'xtab, foydalanuvchiga aytaman).

## 6a. Deploy va production (2026-10-12 qaror)

- **Hozir deploy va production mavzusi yopiq.** Faqat localhost'da ishlaymiz; production'ga chiqish — MVP tugagandan keyin (faza F7). `devops`, `deploy/`, ssh/pm2, production rol modeli bo'yicha ishlar shu paytgacha boshlanmaydi (tayyor runbook `deploy/README.md` da turadi).
- `main` ga merge qilish shart emas: ish feature branch'larda (stacked) yuritiladi va push qilinadi. Merge — foydalanuvchi so'raganda.

## 7. Token tejash (2026-10-30 qaror, majburiy)

**Asosiy sessiya:**
- Yangi sessiyada faqat `docs/STATUS.md` (≤60 qator) o'qiladi. `STATUS-ARCHIVE.md`, `PLAN.md`, TZ, kod — to'liq o'qilmaydi, faqat grep/diapazon. Bir faylni qayta o'qish yo'q.
- STATUS yangilanishi: joriy holat almashtiriladi, ko'chirib yig'ilmaydi; tugagan ish bir qator yoki arxivga.
- Topshiriq ≤15 qator; agentning o'zi topa oladigan narsa yozilmaydi. Foydalanuvchiga javob qisqa, agent hisoboti takrorlanmaydi.
- Bitta task tugagach `/clear` tavsiya qilinadi.

**Agentlar (eng katta xarajat shu yerda):**
- Faqat zarur agent. `architect` — faqat ko'p modulli yoki pul/xavfsizlik qarorida; kichik ishda §3 zanjiri qisqartiriladi.
- Bir vaqtda faqat zarur parallel; bir xil tekshiruv ikki marta yo'q.
- `reviewer` va `security-auditor` faqat task diff'ini ko'radi, bir marta. `checks` — task oxirida bir marta; oraliqda faqat tegilgan test fayli.
- Hisobot ≤10 qator; agentlar `docs/STATUS*`/`PLAN.md` ni o'qimaydi, kerakli fakt topshiriqda beriladi.
- Yuk testi va to'liq test to'plami qimmat: yuk testi faqat sokin hostda va foydalanuvchi tasdig'i bilan.

## 8. Foydalanuvchidan tasdiq kerak bo'lgan hollar

Pul/qoldiq/qarz/xavfsizlik/huquq noaniqligi · scope o'zgarishi (TZ §5.2/§5.3) · `main` ga merge · force-push · production/deploy/ssh · ma'lumotni o'chiruvchi migratsiya · yangi tashqi xizmat yoki kutubxona.
