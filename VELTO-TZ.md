# VELTO — Texnik Topshiriq (Yagona hujjat)

> **Mahsulot:** Velto — O'zbekiston distribyutorlari uchun savdo va distribyutsiya boshqaruv platformasi
> **Hujjat versiyasi:** 3.2 (birlashtirilgan)
> **Sana:** 2026-yil iyul
> **Holat:** Ishlab chiqishga tayyor — **hozirgi reliz: v1.0 MVP**
> **Manba hujjatlar:** `VELTO-TZ-MASTER.md` (v2.0) + `VELTO-TZ-v1.0-MVP.md` — bu ikkalasi birlashtirilib, shu yagona faylga aylantirildi. Bundan buyon faqat shu fayl yuritiladi.

---

## ⚠️ 0. AI AGENT / CLAUDE CODE UCHUN QAT'IY QOIDA — HAMMASIDAN OLDIN O'QING

Bu hujjat ikki qismdan iborat va ular **aralashtirilmaydi**:

| Qism | Bo'lim | Nima qilish kerak |
|---|---|---|
| **A. MVP v1.0 — QURILAYOTGAN QISM** | 1–11-bo'limlar | Shu yerdagi HAMMA narsa quriladi, va **faqat shu**. To'liq UI bilan, stub emas. |
| **B. KELAJAK (v1.1, v1.2, v2.0, v3.0)** | 12-bo'lim | Bu faqat **rejalashtirish uchun**. Hech qanday kod, model, endpoint, UI elementi bugun yozilmaydi. |

**Qoidalar (Claude Code avtomatik ishlayotganda ham, qo'lda ham amal qiladi):**

1. Har bir talab satrida `[MVP-v1.0]` yorlig'i bor — faqat shu yorliqli narsalarni amalga oshiring.
2. `[v1.1]`, `[v1.2]`, `[v2.0]`, `[v3.0]` yorlig'i bilan belgilangan HECH NARSANI hozir qurmang — na backend model, na bo'sh UI joy (placeholder tugma, "tez orada" ekrani), na kommentariyadagi TODO orqali ham.
3. Agar talab noaniq bo'lsa yoki qaysi versiyaga tegishli ekani aniq bo'lmasa — **savol bering**, taxmin qilib kelajak funksiyani qurmang.
4. Prisma sxemasida kelajak uchun "ehtiyot" ustun yoki jadval qo'shmang (masalan `batchNumber`, `markingCode` kabi v1.2 maydonlari — bular hozir sxemada BO'LMASIN).
5. Har bir ekran **to'liq ishlaydigan UI** bilan topshiriladi: forma validatsiyasi, bo'sh holat (empty state), yuklanish holati (skeleton), xato holati, muvaffaqiyat xabari. "Backend tayyor, UI keyin" qabul qilinmaydi — MVP UI'siz MVP emas.
6. 12-bo'limni faqat kontekst uchun o'qing — u sizga "buni ham qo'shib qo'yay" degan signal bermasin.

---

## 0.1 Hujjatni yangilash qoidasi

1. Talabni **o'chirmang** — statusini `DEPRECATED`/`CANCELLED` ga o'zgartirib, sababini yozing.
2. Talab mazmuni jiddiy o'zgarsa — yangi ID bering, eskisini `SUPERSEDED BY F-XXX` deb belgilang.
3. Hujjat versiyasi: `MAJOR.MINOR` — MAJOR: yo'nalish/arxitektura o'zgarishi, MINOR: talab qo'shildi/aniqlashtirildi.
4. Har bir modul kodi va talab ID'si (`F-`, `NFR-`, `SEC-`, `INT-`, `UX-`) barqaror — o'chirilmaydi, qayta ishlatilmaydi.

**Talab prefikslari:** `F-` funksional, `NFR-` nofunksional, `SEC-` xavfsizlik, `INT-` integratsiya, `UX-` dizayn. Format: `F-<modul>-<raqam>`.

**MoSCoW:** **M**ust (relizsiz bo'lmaydi) · **S**hould (kerak, blokerlamaydi) · **C**ould (vaqt qolsa) · **W**on't (ongli ravishda keyinga qoldirilgan).

### O'zgarishlar tarixi

| Versiya | Sana | O'zgarish |
|---|---|---|
| 0.1.0 | 2026-07 | Birinchi qoralama — umumiy inventar/ERP skeleti |
| 2.0 (Master) | 2026-07 | To'liq qayta ishlash: bozor tahlili, Customer/qarzdorlik/agent/marshrut domeni, komplayens (EHF, markirovka), NFR/SEC kengaytirildi, versiya yo'l xaritasi |
| v1.0-MVP | 2026-07 | Master'dan kelib chiquvchi, faqat MVP relizga tegishli qisqa hujjat |
| **3.0** | **2026-07** | **Master va MVP hujjatlari bitta faylga birlashtirildi. MVP to'liq UI talabi bilan aniqlashtirildi. AI-agent qurish qoidasi (0-bo'lim) qo'shildi.** |
| **3.1** | **2026-08** | **4.1: rollar 9 tadan 6 taga qisqartirildi — `SUPERVISOR`, `OPERATOR`, `VIEWER` olib tashlandi (qayta ishlatilmaydi); `OWNER`→"Admin", `SALES_DIRECTOR`→"Direktor" nomi o'zgardi (kod barqaror qoldi). 11.5 demo seed shunga mos yangilandi.** |
| **3.2** | **2026-08** | **Mijoz talabi bilan qorong'i rejim v1.1'dan MVP-v1.0'ga ko'chirildi (5.4, 9.5, 12-bo'lim v1.1 ro'yxati yangilandi) va `apps/web`da amalga oshirildi (`next-themes`, yorug'/qorong'i/tizim, topbar'da almashtirgich).** |
| **3.3** | **2026-08** | **Mijoz talabi bilan yana bir soddalashtirish bosqichi: (1) buyurtmada ombordagi qoldiqdan oshgan miqdorga mini-app aniq raqam bilan ogohlantiradi (8.1); (2) tashrif GPS tekshiruvi qat'iylashtirildi — 150m'dan uzoqda "sabab" bilan o'tib bo'lmaydi (`reasonIfFar` olib tashlandi), Yandex Maps xaritasi qo'shildi, yangi "marshrutni tugatish" amali va `RouteRun` modeli (6.8, 9.4); (3) kredit limiti va `ON_HOLD` tasdiqlash bosqichi butunlay olib tashlandi — endi bitta oddiy `CONFIRMED` bosqichi (`Customer.creditLimit`, `OrderStatus.ON_HOLD` sxemadan o'chirildi, 8.1, 8.7); (4) INN/tin maydoni `Company`/`Customer`/`Supplier`dan olib tashlandi, dublikat aniqlash endi faqat telefon/koordinata/nom bo'yicha (6.3); (5) 4.1: `SALES_AGENT` ko'rsatiladigan nomi "Savdo agenti"dan "Agent"ga o'zgardi; (6) marshrut ekranida kun nomi bilan birga sana ham ko'rsatiladi (9.4); (7) 4 asosiy hisobotning barchasi uchun Excel eksport qo'shildi (`/reports/{sales,agents,overview}/export`, 9.2/11.1 andozasi bo'yicha).** |
| **3.4** | **2026-08** | **Mijoz talabi bilan rollar ro'yxati 5 taga qisqartirildi: `ACCOUNTANT` (Buxgalter) olib tashlandi — kompaniya uchun alohida hisob shart emas, 1C eksportini endi Admin (`OWNER`) ishga tushiradi (4.1, 11.5 seed va `ROLE_PERMISSIONS` shunga mos yangilandi). `SALES_DIRECTOR` ko'rsatiladigan nomi "Direktor"dan "Director"ga o'zgardi.** |
| **3.5** | **2026-08** | **Mijoz talabi bilan `ACCOUNTANT` (Buxgalter) roli qayta tiklandi (3.4'da olib tashlangan edi) — 4.1 rol jadvali, 11.5 seed, `bootstrap-owner.ts` va uch tilning `roles` lokalizatsiyasi (uz/ru/en) yana 6 rolga qaytarildi.** |

### Tasdiqlanmagan taxminlar (birinchi 5 mijozdan keyin qayta tekshiriladi)

- Distribyutorlarning asosiy og'rig'i — agent↔ofis o'rtasidagi qo'lda ma'lumot uzatish
- Mijozlar 1C'ni almashtirishga emas, unga qo'shimchaga tayyor
- Narx sezgirligi: oyiga $150–400 o'rta distribyutor uchun qabul qilinadi
- Agentlarning 90%+ da Android telefon bor va Telegram o'rnatilgan

---

## 1. Qisqacha mazmun

**Muammo.** O'zbekistondagi distribyutor kompaniyalarda savdo agenti do'konda buyurtmani qog'ozga yozadi yoki Telegram'ga tashlaydi. Ofisdagi operator uni 1C'ga qayta kiritadi. Agent omborda nima borligini bilmaydi, mijozning qarzini bilmaydi, rahbariyat agent qayerda ekanini bilmaydi. Debitorlik Excel'da yuritiladi va u har doim eskirgan.

**Yechim.** Velto — agentning telefonidan boshlanib, omborga, yetkazib berishga, kassaga va buxgalteriyaga uzluksiz o'tadigan yagona jarayon. 1C'ni almashtirmaydi — u bilan sinxronlashadi.

**Farqlovchi jihatlar:**
1. **Offline-first** — agent internetsiz to'liq ishlaydi (raqobatchilarning zaif joyi)
2. **Telegram Mini App** — o'rnatish talab qilmaydi, agent 30 soniyada ishga tushadi
3. **Komplayens ichida** — EHF va markirovka qo'shimcha emas, jarayon ichida (v1.2)
4. **1C bilan ikki tomonlama** — buxgalter o'z tizimida qoladi, ikki marta kiritish yo'qoladi
5. **Tez joriy etish** — 5 ish kunida ishga tushadi

**Maqsadli natija.** Distribyutorning savdo bo'limi samaradorligi 4–5 barobar oshadi (3.2-bo'limdagi o'lchov).

---

## 2. Bozor tahlili

### 2.1 Bozor holati

- **Raqamlashtirish majburiy bo'lib bormoqda** — markirovka, EHF, onlayn NKT endi tanlov emas. 2026-yil 1-iyuldan markirovkalangan tovarlar uchun EHF'da avtomatik tekshiruvlar joriy etildi — bu bozorda majburiy talab yaratdi.
- Ko'pchilik hali qog'oz/Excel/Telegram'da (ayniqsa 5–50 agentli o'rta kompaniyalar).
- 1C hukmron, lekin dala ishi uchun deyarli yaroqsiz.
- Mobil internet yaxshilangan, lekin barqaror emas — offline ishlash hal qiluvchi omil.

### 2.2 Raqobat landshafti

| Raqobatchi | Kuchli tomoni | Zaif tomoni | Velto qanday yutadi |
|---|---|---|---|
| **1C** | Buxgalteriya, arzon, mutaxassis har shaharda bor | Dala uchun yaroqsiz, offline yo'q, UI eskirgan | Almashtirmaymiz — ustama bo'lamiz |
| **Smartup** | Keng funksiya, yirik mijozlar | Og'ir, qimmat, joriy etish uzoq | Tezlik: 5 kun vs oylar; kichik-o'rta segmentga fokus |
| **Sales Doctor** | Mobil savdoga fokus | Tor funksiya | Kengroq qamrov + komplayens |
| **Billz, HIPPO** | Chakana savdoga mos | Distribyutsiya emas | Domen ixtisoslashuvi |
| **Excel + Telegram + qog'oz** | Bepul, tanish | Nazorat yo'q, masshtablanmaydi | **Asosiy raqobatchi shu.** O'rganish narxini nolga tushirish |

> **Xulosa:** Sotuv argumenti "funksiya ko'p" emas, **"birinchi haftadayoq ko'rinadigan foyda"**.

### 2.3 Bozor bo'shliqlari

1. Kichik-o'rta distribyutor (5–50 agent) e'tibordan chetda
2. Haqiqiy to'liq offline (kesh emas) kam uchraydi
3. Komplayens alohida mahsulot sifatida sotiladi — Velto'da jarayon ichida
4. Telegram Mini App'dan deyarli foydalanilmayapti — o'rnatish to'sig'ini yo'q qiladi
5. Joriy etish tezligi bo'yicha hech kim raqobat qilmayapti

### 2.4 Ideal mijoz profili (ICP)

| Parametr | Qiymat |
|---|---|
| Faoliyat | FMCG distribyutsiyasi (oziq-ovqat, ichimlik, maishiy kimyo, gigiyena) |
| Savdo agentlari | 8–40 kishi |
| Faol savdo nuqtalari | 500–5000 |
| Omborlar | 1–3 |
| SKU | 200–3000 |
| Hozirgi holati | 1C + Excel + Telegram, agentda dastur yo'q |
| Joylashuv | Toshkent va viloyat markazlari |
| Qaror qabul qiluvchi | Egasi yoki savdo direktori |

**Kim ICP emas:** chakana do'konlar, marketplace sotuvchilari, ishlab chiqaruvchilar.

### 2.5 Pozitsiyalash

> **8–40 agentli distribyutor kompaniyalar** uchun, kimlarki buyurtmalarni hali qog'oz va Telegram orqali yig'adi, **Velto** — savdo agenti telefonidan omborga va buxgalteriyaga uzluksiz o'tadigan platforma. 1C'ni almashtiradigan og'ir ERP'lardan farqli o'laroq, Velto 1C bilan ishlaydi, bir hafta ichida joriy etiladi va internetsiz ham ishlaydi.

### 2.6 Narx modeli

| Tarif | Kim uchun | Narx (oyiga) | Ichiga kiradi |
|---|---|---|---|
| **Start** | 1–5 agent | $99 | Asosiy modullar, 1 ombor, 500 mijoz |
| **Growth** | 6–20 agent | $249 | + marshrut, aksiya, 1C sinx, 3 ombor |
| **Scale** | 21–60 agent | $549 | + EHF, markirovka, cheksiz ombor, API |
| **Enterprise** | 60+ | Kelishuv | + SLA, on-premise opsiya |

Sinov: 14 kun bepul, karta talab qilinmaydi, **mijozning o'z ma'lumoti bilan** ishlash imkoni bo'lsin. *Agent boshiga narxlamang.*

### 2.7 GTM strategiyasi

**0-bosqich (1–3 oy):** 3 pilot mijoz, bepul, haftalik fikr-mulohaza sharti bilan.
**1-bosqich (3–9 oy):** Referral — mamnun mijoz 3–5 lead beradi (tavsiya qiluvchiga 2 oy bepul).
**2-bosqich (6–18 oy):** Ishlab chiqaruvchilar orqali kanal (sell-out ma'lumoti).
**3-bosqich:** Komplayens to'lqini kutilib, oldindan tayyor bo'lish.

**Demo qoidasi:** 15 daqiqadan oshmasin, faqat 3 narsa: (1) agentda 90 soniyada buyurtma, (2) ofisda darhol ko'rinishi, (3) qarzdorlik ekrani.

---

## 3. Mahsulot vizyoni va o'lchanadigan maqsadlar

> Distribyutor kompaniyada bir marta kiritilgan ma'lumot ikkinchi marta hech qachon qo'lda kiritilmasin.

### 3.1 "4–5x" — aniq o'lchovlar (baseline har mijozda joriy etishdan oldin o'lchanadi)

| Ko'rsatkich | Odatiy holat | Velto bilan maqsad | Barobar |
|---|---|---|---|
| Bitta nuqtada buyurtma olish vaqti | 12–15 daq | 3–4 daq | ~4x |
| Agent kuniga xizmat ko'rsatgan nuqta | 12–18 | 30–40 | ~2.5x |
| Buyurtmani operator kiritishi | 3–5 daq | 0 daq | ∞ |
| Buyurtma → yetkazish sikli | 1.5–3 kun | 4–24 soat | ~4x |
| Buyurtmadagi xato | 10–15% | <2% | ~6x |
| Akt sverka tayyorlash | 2–3 kun/oy | Real vaqt | ∞ |

### 3.2 Mahsulot prinsiplari

1. Agent uchun sodda bo'lmasa — ishlatilmaydi (ekranda 3 tugmadan ko'p bo'lmasin)
2. Internet yo'qligi — **asosiy holat**, online — bonus
3. 1C dushman emas — har funksiya "buxgalter buni 1C'da ko'radimi?" savoliga javob bersin
4. Har bir ekran bitta savolga javob bersin
5. Ma'lumot yo'qolmaydi — telefon o'chsa/suvga tushsa ham buyurtma yo'qolmaydi
6. Tezlik funksiyadan muhim

---

## 4. Foydalanuvchi rollari va personalar

### 4.1 Rollar `[MVP-v1.0: barchasi kiradi]`

| Rol | Kod | Vazifasi | Interfeys |
|---|---|---|---|
| Platforma admini | `PLATFORM_ADMIN` | Tenantlar, tariflar | Web (alohida panel) — `[v1.1]` to'liq UI, MVP'da faqat DB darajasida |
| Admin | `OWNER` | To'liq huquq, moliya, sozlamalar | Web |
| Director | `SALES_DIRECTOR` | Reja, agentlar, analitika, buyurtma tasdiqlash | Web + mobil |
| Agent | `SALES_AGENT` | Tashrif, buyurtma, pul yig'ish | **Telegram Mini App** |
| Omborchi | `WAREHOUSE` | Qabul, chiqarish | Web |
| Kassir | `CASHIER` | To'lov qabul qilish, kassa smenasi | Web |
| Buxgalter | `ACCOUNTANT` | 1C eksport, hisobotlar | Web |

Rollar tizimli (`isSystem`) — MVP'da tayyor rollar bilan ishlaydi. **Maxsus rol yaratish UI** — `[v1.1]`.

> **3.1 soddalashtirish:** dastlabki 9 ta rol (+`PLATFORM_ADMIN`) 6 taga qisqartirildi — `SUPERVISOR` (ruxsatlari deyarli to'liq `SALES_DIRECTOR` ichida edi, 8–40 agentli ICP'da alohida guruh boshqaruvchisi shart emas), `OPERATOR` (telefon buyurtmasini endi Direktor/Admin qabul qiladi) va `VIEWER` (foydalanuvchisi/persona'si yo'q edi) olib tashlandi — oddiy foydalanuvchi rol tanlashda adashmasligi uchun. `OWNER`/`SALES_DIRECTOR`/`SALES_AGENT` kod nomlari o'zgarmadi (kod ularga bog'liq), faqat ko'rsatiladigan nomi Admin/Direktor/Agent bo'ldi.
>
> **3.4 soddalashtirish:** `SALES_DIRECTOR` ko'rsatiladigan nomi "Direktor"dan "Director"ga o'zgardi. (`ACCOUNTANT` roli shu bosqichda vaqtincha olib tashlangan, keyin mijoz talabi bilan qayta tiklandi — 3.5'ga qarang.)
>
> **3.5:** `ACCOUNTANT` (Buxgalter) roli mijoz talabi bilan qayta tiklandi (3.4'da olib tashlangan edi).

### 4.2 Personalar

**Anvar — savdo agenti, 27 yosh.** Kuniga 20–30 do'kon aylanadi, ko'chada, shoshilib. Internet bozorda yo'qoladi. *Velto unga:* 90 soniyada buyurtma, qoldiq va qarz ko'rinadi, bir tugma bilan takrorlash.

**Dilshod — savdo direktori, 41 yosh.** "Kecha qancha sotdik?" javobini tushgacha kutadi. *Velto unga:* real vaqt dashboard, reja/fakt, muddati o'tgan qarz.

**Nodira — buxgalter, 35 yosh.** 1C'da 8 yil ishlaydi, o'zgarishni yoqtirmaydi. *Velto unga:* hech narsa o'zgarmaydi, ma'lumot 1C'ga o'zi keladi.

**Sardor — ekspeditor, 33 yosh.** `[v1.1]` — MVP'da yetkazish moduli yo'q, ekspeditor roli hozircha ishlatilmaydi.

---

# QISM A — v1.0 MVP: TO'LIQ QAMROV (HOZIR QURILADI)

> Barcha quyidagi bo'limlar (5–11) — **shu kunlarda yoziladigan kod**. Har bir talab `[MVP-v1.0]` deb hisoblanadi, boshqacha yozilmagan bo'lsa.

## 5. MVP maqsadi va muvaffaqiyat mezoni

### 5.1 Maqsad

Bitta distribyutor kompaniya Velto'dan foydalanib **butun savdo siklini** bajara olsin: agent do'konda buyurtma oladi → ofisda darhol ko'rinadi → ombor beradi → to'lov qabul qilinadi → qarz kuzatiladi → ma'lumot 1C'ga o'tadi.

### 5.2 Muvaffaqiyat mezoni

- [ ] Pilot mijozda kamida **5 agent 2 hafta uzluksiz** ishlatsa
- [ ] Buyurtmalarning **95%+ i agent telefonidan** kelsa
- [ ] Agent bitta nuqtada buyurtmani **4 daqiqadan tez** yaratsa
- [ ] Internetsiz yaratilgan buyurtmalarning **100%i** yo'qolmay serverga yetsa
- [ ] Rahbar kechagi natijani **30 soniyada** ko'rsa
- [ ] Mijoz **to'lashga rozi bo'lsa**

### 5.3 Qamrov — nima KIRADI `[MVP-v1.0]`

| Modul | Kiradi |
|---|---|
| M01 Mijozlar | Mijoz, nuqta, geokoordinata, agentga biriktirish, dublikat aniqlash (telefon/koordinata/nom), bloklash |
| M02 Katalog | Mahsulot, qadoq (dona/blok/quti), rasm, narx ro'yxatlari, QQS, minimal narx |
| M03 Ombor | Qoldiq (mavjud/rezerv/erkin), harakatlar, rezerv, konkurentlik himoyasi (row lock), buyurtmada qoldiqdan oshganda ogohlantirish |
| M04 Sotish | Buyurtma to'liq sikli (bitta oddiy tasdiqlash bosqichi — kredit limiti/ON_HOLD yo'q), qisman bajarish, hujjat raqamlash |
| M05 Moliya | Qisman to'lov, FIFO taqsimlash, qarz, aging, kassa smenasi |
| M06 Dala | Marshrut (kun + sana), tashrif, qat'iy GPS tekshiruvi (150m, sababsiz o'tib bo'lmaydi), marshrutni tugatish, Yandex xarita |
| M09 Xaridlar | Yetkazib beruvchi, xarid buyurtmasi, qabul (soddalashtirilgan) |
| M11 Analitika | Dashboard, 4 asosiy hisobot, Excel eksport |
| M12 Integratsiya | 1C eksport (bir tomonlama), Telegram Bot API |
| M13 Boshqaruv | RBAC, audit log (backend + UI) |
| M14 Bildirishnoma | In-app + Telegram |
| M15 Onboarding | Excel import, setup wizard, 60s agent qo'llanma |

### 5.4 Qamrov — nima KIRMAYDI `[muhokama qilinmaydi]`

Har bir qo'shimcha — relizning kechikishi:

- ❌ EHF integratsiyasi → `[v1.2]`
- ❌ Markirovka → `[v1.2]`
- ❌ Aksiya va murakkab chegirmalar → `[v1.1]` (MVP'da faqat oddiy foizli chegirma)
- ❌ Logistika moduli (yig'ish varaqasi, ekspeditor ilovasi) → `[v1.1]`
- ❌ Vozvrat → `[v1.1]`
- ❌ Inventarizatsiya, omborlar aro ko'chirish → `[v1.1]`
- ❌ Payme/Click → `[v1.2]`
- ❌ Partiya va yaroqlilik muddati → `[v1.2]`
- ❌ Akt sverka PDF → `[v1.1]`
- ❌ 1C'dan import, ikki tomonlama sinx → `[v1.1]`
- ❌ React Native, hisobot konstruktori, maxsus rol yaratish UI, audit filtr UI → keyingi relizlar

---

## 6. Domen modeli va ma'lumotlar bazasi sxemasi `[MVP-v1.0]`

### 6.1 Asosiy tamoyillar

1. **Harakatlar — haqiqat manbai.** `StockMovement`, `LedgerEntry`/`Payment` — append-only. Qoldiq/balans ulardan hisoblanadi yoki proyeksiya sifatida saqlanadi.
2. **Hech qanday 1:1 unique.** `Invoice ↔ Order`, `Payment ↔ Invoice` — barchasi 1:N yoki N:M.
3. **Pul — `Decimal(18,2)`.** `Float` hech qayerda ishlatilmaydi. Miqdor — `Decimal(18,3)`. Foiz — `Decimal(5,2)`.
4. **Tenant izolyatsiyasi ma'lumotlar bazasi darajasida** — middleware'ga tayanmaydi (RLS, 6.9-bo'lim).
5. **Soft delete tarixiy hujjatlarga tegmaydi** — eski buyurtmadagi nom/narx snapshot sifatida saqlanadi.

### 6.2 Tenant va foydalanuvchilar

```prisma
// Barcha modellarda majburiy: id (uuid), createdAt, updatedAt
// Tenant-ga tegishli modellarda: companyId + RLS policy

model Tenant {
  id          String   @id @default(uuid()) @db.Uuid
  name        String
  slug        String   @unique
  plan        Plan     @default(START)
  isActive    Boolean  @default(true)
  trialEndsAt DateTime?
  companies   Company[]
}

model Company {
  id             String   @id @default(uuid()) @db.Uuid
  tenantId       String   @db.Uuid
  name           String
  legalName      String?
  phone          String?
  address        String?
  currency       String   @default("UZS")
  defaultVatRate Decimal  @default(12) @db.Decimal(5,2)
  docPrefix      String   @default("")
  timezone       String   @default("Asia/Tashkent")
  isActive       Boolean  @default(true)
  tenant         Tenant   @relation(fields: [tenantId], references: [id])
  @@index([tenantId])
}

model User {
  id           String   @id @default(uuid()) @db.Uuid
  companyId    String   @db.Uuid
  firstName    String
  lastName     String
  phone        String                   // asosiy identifikator
  email        String?
  passwordHash String?                  // agentda bo'lmasligi mumkin
  telegramId   BigInt?                  // Telegram orqali kirish
  isActive     Boolean  @default(true)
  lastLoginAt  DateTime?
  roles        UserRole[]
  @@unique([companyId, phone])
  @@unique([telegramId])
  @@index([companyId])
}

model Role       { id String @id @default(uuid()) @db.Uuid; companyId String @db.Uuid; name String; code String; isSystem Boolean @default(false); permissions RolePermission[]; @@unique([companyId, code]) }
model Permission { id String @id @default(uuid()) @db.Uuid; module String; code String; @@unique([module, code]) }
model RolePermission { roleId String @db.Uuid; permissionId String @db.Uuid; @@id([roleId, permissionId]) }
model UserRole       { userId String @db.Uuid; roleId String @db.Uuid; @@id([userId, roleId]) }

model RefreshToken {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  tokenHash String                     // xom token saqlanmaydi
  familyId  String   @db.Uuid          // rotatsiya oilasi
  expiresAt DateTime
  revokedAt DateTime?
  userAgent String?
  ip        String?
  @@index([userId])
  @@index([familyId])
}
```

### 6.3 Mijozlar va nuqtalar

```prisma
model Customer {
  id              String   @id @default(uuid()) @db.Uuid
  companyId       String   @db.Uuid
  code            String
  name            String
  phone           String?
  contactPerson   String?
  priceListId     String?  @db.Uuid
  paymentTermDays Int      @default(0)
  isBlocked       Boolean  @default(false)                 // qo'lda bloklash — kredit limitiga bog'liq emas
  blockReason     String?
  cachedBalance   Decimal  @default(0) @db.Decimal(18,2)   // proyeksiya, 6.7-bo'lim
  isActive        Boolean  @default(true)
  deletedAt       DateTime?
  outlets         Outlet[]
  @@unique([companyId, code])
  @@index([companyId, name])
}

model Outlet {
  id         String     @id @default(uuid()) @db.Uuid
  companyId  String     @db.Uuid
  customerId String     @db.Uuid
  name       String
  type       OutletType @default(SHOP)
  address    String?
  latitude   Decimal?   @db.Decimal(10,7)
  longitude  Decimal?   @db.Decimal(10,7)
  photoUrl   String?     // [v1.1]
  isActive   Boolean    @default(true)
  deletedAt  DateTime?
  customer   Customer   @relation(fields: [customerId], references: [id])
  @@index([companyId, customerId])
  @@index([companyId, latitude, longitude])
}

enum OutletType { SHOP MINIMARKET SUPERMARKET BAZAAR HORECA WAREHOUSE OTHER }
```

**Domen qoidasi (F-M01, hammasi M):** mijoz to'laqonli obyekt — matn maydoni emas. Dublikat aniqlash telefon, koordinata (50m radius) va nom o'xshashligi bo'yicha ogohlantirish beradi (INN/tin maydoni soddalashtirish bosqichida loyihadan olib tashlandi). Mijoz kartochkasida: joriy qarz, oxirgi 10 buyurtma, oxirgi to'lov, tashriflar tarixi.

### 6.4 Katalog va narxlar

```prisma
model ProductCategory {
  id        String  @id @default(uuid()) @db.Uuid
  companyId String  @db.Uuid
  name      String
  parentId  String? @db.Uuid
  @@unique([companyId, name, parentId])
}

model Product {
  id           String   @id @default(uuid()) @db.Uuid
  companyId    String   @db.Uuid
  categoryId   String?  @db.Uuid
  sku          String
  barcode      String?
  name         String
  brand        String?
  baseUnit     String                       // "dona", "kg", "litr"
  vatRate      Decimal  @default(12) @db.Decimal(5,2)
  minPrice     Decimal? @db.Decimal(18,2)   // agent undan past sota olmaydi
  imageUrl     String?
  externalCode String?                      // 1C moslashtirish uchun, 1C eksport majburiy
  isActive     Boolean  @default(true)
  deletedAt    DateTime?
  packagings   ProductPackaging[]
  @@unique([companyId, sku])
  @@index([companyId, name])
  @@index([companyId, barcode])
}

model ProductPackaging {           // dona → blok → quti
  id             String  @id @default(uuid()) @db.Uuid
  productId      String  @db.Uuid
  name           String            // "dona", "blok", "quti"
  qtyInBaseUnit  Decimal @db.Decimal(18,3)
  isDefault      Boolean @default(false)
  product        Product @relation(fields: [productId], references: [id])
}

model PriceList     { id String @id @default(uuid()) @db.Uuid; companyId String @db.Uuid; name String; isDefault Boolean @default(false) }
model PriceListItem { id String @id @default(uuid()) @db.Uuid; priceListId String @db.Uuid; productId String @db.Uuid; price Decimal @db.Decimal(18,2); @@unique([priceListId, productId]) }
```

### 6.5 Ombor

```prisma
model Warehouse { id String @id @default(uuid()) @db.Uuid; companyId String @db.Uuid; name String; address String?; isActive Boolean @default(true) }

model StockLevel {          // proyeksiya — StockMovement'dan qayta hisoblanadi
  productId    String  @db.Uuid
  warehouseId  String  @db.Uuid
  onHand       Decimal @default(0) @db.Decimal(18,3)
  reserved     Decimal @default(0) @db.Decimal(18,3)
  // available = onHand - reserved (hisoblanadi)
  @@id([productId, warehouseId])
}

model StockMovement {      // haqiqat manbai — append-only
  id          String   @id @default(uuid()) @db.Uuid
  companyId   String   @db.Uuid
  productId   String   @db.Uuid
  warehouseId String   @db.Uuid
  type        StockMovementType   // RECEIVE ISSUE RESERVE RELEASE ADJUST
  qty         Decimal  @db.Decimal(18,3)   // ishorali: + kirim, - chiqim
  refType     String?             // "SalesOrder", "PurchaseOrder"...
  refId       String?  @db.Uuid
  note        String?
  createdAt   DateTime @default(now())
  @@index([companyId, productId, warehouseId])
}

enum StockMovementType { RECEIVE ISSUE RESERVE RELEASE ADJUST }
```

**Qoida (F-M03, M):** konkurent operatsiyalarda ortiqcha sotishni oldini olish — row-level lock (`SELECT ... FOR UPDATE`) majburiy rezerv operatsiyasida.

### 6.6 Sotish

```prisma
model SalesOrder {
  id          String   @id @default(uuid()) @db.Uuid
  companyId   String   @db.Uuid
  number      String              // SO-2026-000123
  customerId  String   @db.Uuid
  outletId    String?  @db.Uuid
  agentId     String?  @db.Uuid
  status      OrderStatus @default(DRAFT)
  clientId    String?  @unique    // offline idempotentlik kaliti
  note        String?
  createdAt   DateTime @default(now())
  lines       SalesOrderLine[]
  @@unique([companyId, number])
  @@index([companyId, customerId])
  @@index([companyId, agentId, createdAt])
}

model SalesOrderLine {
  id            String  @id @default(uuid()) @db.Uuid
  orderId       String  @db.Uuid
  productId     String  @db.Uuid
  packagingId   String  @db.Uuid
  qty           Decimal @db.Decimal(18,3)
  unitPrice     Decimal @db.Decimal(18,2)
  discountPct   Decimal @default(0) @db.Decimal(5,2)
  vatRate       Decimal @db.Decimal(5,2)
  lineTotal     Decimal @db.Decimal(18,2)   // serverda hisoblanadi, agent yubormaydi
  order         SalesOrder @relation(fields: [orderId], references: [id])
}

enum OrderStatus { DRAFT SUBMITTED CONFIRMED SHIPPED DELIVERED CLOSED CANCELLED }
// MVP'da PICKING holati ishlatilmaydi (logistika moduli v1.1) — CONFIRMED to'g'ridan DELIVERED'ga o'tishi mumkin.
// ON_HOLD (kredit limiti/supervayzer tasdig'i) soddalashtirish bosqichida olib tashlandi — SUBMITTED → CONFIRMED bitta oddiy tasdiqlash bosqichi.

model Invoice {
  id         String   @id @default(uuid()) @db.Uuid
  companyId  String   @db.Uuid
  number     String              // INV-2026-000142
  customerId String   @db.Uuid
  orderId    String?  @db.Uuid   // N:M munosabat kelajakda — MVP'da 1 order = 1 invoice soddalashtirilgan
  total      Decimal  @db.Decimal(18,2)
  status     InvoiceStatus @default(OPEN)
  createdAt  DateTime @default(now())
  lines      InvoiceLine[]
  @@unique([companyId, number])
}

model InvoiceLine { id String @id @default(uuid()) @db.Uuid; invoiceId String @db.Uuid; productId String @db.Uuid; qty Decimal @db.Decimal(18,3); unitPrice Decimal @db.Decimal(18,2); vatRate Decimal @db.Decimal(5,2); lineTotal Decimal @db.Decimal(18,2) }

enum InvoiceStatus { OPEN PARTIALLY_PAID PAID CANCELLED }
```

### 6.7 To'lovlar — qisman to'lovning asosi

```prisma
model Payment {
  id          String   @id @default(uuid()) @db.Uuid
  companyId   String   @db.Uuid
  number      String              // PAY-2026-000311
  customerId  String   @db.Uuid
  amount      Decimal  @db.Decimal(18,2)
  method      PaymentMethod       // CASH CARD TRANSFER
  collectedBy String?  @db.Uuid   // agent/kassir
  clientId    String?  @unique    // offline idempotentlik
  createdAt   DateTime @default(now())
  allocations PaymentAllocation[]
  @@unique([companyId, number])
}

model PaymentAllocation {         // N:M Payment ↔ Invoice — qisman to'lovning yuragi
  id        String  @id @default(uuid()) @db.Uuid
  paymentId String  @db.Uuid
  invoiceId String  @db.Uuid
  amount    Decimal @db.Decimal(18,2)
  @@index([paymentId])
  @@index([invoiceId])
}

enum PaymentMethod { CASH CARD TRANSFER }

model CashSession {   // kassa smenasi
  id         String    @id @default(uuid()) @db.Uuid
  companyId  String    @db.Uuid
  userId     String    @db.Uuid
  openedAt   DateTime  @default(now())
  closedAt   DateTime?
  openAmount Decimal   @db.Decimal(18,2)
  closeAmount Decimal? @db.Decimal(18,2)
}
```

**Qoida (F-M05, M):** 1 hisob-faktura = ko'p to'lov, 1 to'lov = ko'p hisob-faktura. Har doim FIFO avtomatik taqsimlash + qo'lda o'zgartirish imkoni. Balans **hech qachon** to'g'ridan-to'g'ri UPDATE qilinmaydi:

```
Balans = Σ(Invoice.total) − Σ(PaymentAllocation.amount)
```

`Customer.cachedBalance` tezlik uchun saqlanadi, har tranzaksiyada bir tranzaksiya ichida yangilanadi, kunlik job orqali qayta hisoblanib tekshiriladi (drift detection).

### 6.8 Dala: marshrut va tashrif

```prisma
model Route     { id String @id @default(uuid()) @db.Uuid; companyId String @db.Uuid; agentId String @db.Uuid; weekday Int /* 1-7 */; name String }
model RouteStop { id String @id @default(uuid()) @db.Uuid; routeId String @db.Uuid; outletId String @db.Uuid; sortOrder Int }

// Bir kunlik "marshrutni tugatish" holati — Route o'zi haftalik shablon
// (bitta kalendar sanaga bog'lanmagan), shuning uchun har bir kun uchun
// alohida RouteRun yozuvi kerak.
model RouteRun {
  id          String    @id @default(uuid()) @db.Uuid
  companyId   String    @db.Uuid
  routeId     String    @db.Uuid
  date        DateTime  @db.Date
  completedAt DateTime?
  @@unique([routeId, date])
}

model Visit {
  id           String    @id @default(uuid()) @db.Uuid
  companyId    String    @db.Uuid
  agentId      String    @db.Uuid
  outletId     String    @db.Uuid
  startedAt    DateTime
  endedAt      DateTime?
  latitude     Decimal   @db.Decimal(10,7)
  longitude    Decimal   @db.Decimal(10,7)
  gpsOk        Boolean?            // null = nuqtada koordinata yo'q (tekshirib bo'lmaydi); true/false = 150m radiusda tekshirildi
  outcome      VisitOutcome
  noOrderReason String?
  clientId     String?   @unique
}

enum VisitOutcome { ORDERED NO_ORDER }
```
// Qat'iy qoida (9.4-follow-up): 150m'dan uzoqda tashrifni "sabab" bilan
// o'tkazib yuborib bo'lmaydi — reasonIfFar maydoni olib tashlandi. Nuqtada
// koordinata umuman yo'q bo'lsa, bu admin ma'lumot bo'shlig'i, agentning
// aybi emas — shuning uchun bloklanmaydi (gpsOk = null).

### 6.9 Infratuzilma (audit, outbox, import)

```prisma
model AuditLog {
  id        String   @id @default(uuid()) @db.Uuid
  companyId String   @db.Uuid
  userId    String?  @db.Uuid
  action    String              // "order.create", "payment.delete"...
  entity    String
  entityId  String   @db.Uuid
  oldValue  Json?
  newValue  Json?
  ip        String?
  createdAt DateTime @default(now())
  @@index([companyId, entity, entityId])
}
// Append-only — o'chirish/o'zgartirish imkonsiz (DB trigger orqali ta'minlanadi)

model OutboxEvent {
  id          String   @id @default(uuid()) @db.Uuid
  companyId   String   @db.Uuid
  eventType   String
  payload     Json
  processedAt DateTime?
  createdAt   DateTime @default(now())
}

model ImportJob {
  id         String   @id @default(uuid()) @db.Uuid
  companyId  String   @db.Uuid
  type       String              // "customers", "products"
  status     String              // PENDING PROCESSING DONE FAILED
  fileUrl    String
  errorLog   Json?
  createdAt  DateTime @default(now())
}
```

### 6.10 Row Level Security — MAJBURIY (SEC-001..005)

- Har bir tenant-ga tegishli jadvalda PostgreSQL RLS yoqilgan.
- Har bir so'rov `SET LOCAL app.current_company_id` bilan boshlanadi.
- Prisma Client Extension orqali `companyId` avtomatik inject qilinadi — dasturchi buni unutishi **mumkin bo'lmasin**.
- Har bir yangi jadval uchun izolyatsiya testi majburiy: A tenant B tenantning ma'lumotini ko'ra olmasligi kerak. CI'da "cross-tenant leak" testi avtomatik ishlaydi va bloklaydi.

---

## 7. API `[MVP-v1.0]`

### 7.1 Umumiy qoidalar

- REST, JSON. Barcha yozuv (`POST`/`PUT`/`PATCH`) so'rovlarida `Idempotency-Key` yoki `clientId` majburiy.
- Ro'yxat endpoint'larida pagination majburiy (default 25, max 100).
- Xatolar: `{ code, message, details }` formatida, uch tilda `message`.
- Ruxsat tekshiruvi serverda; frontend faqat UI yashiradi.

### 7.2 Asosiy endpoint guruhlari

| Guruh | Endpointlar |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/telegram` |
| Katalog | `GET/POST /products`, `GET/POST /price-lists`, `POST /products/:id/image` |
| Mijozlar | `GET/POST /customers`, `GET /customers/:id`, `POST /customers/:id/block` |
| Ombor | `GET /stock`, `POST /stock/receive`, `POST /stock/adjust` |
| Buyurtmalar | `POST /orders`, `GET /orders`, `GET /orders/:id`, `POST /orders/:id/confirm`, `POST /orders/:id/cancel` |
| Fakturalar/to'lov | `GET /invoices`, `POST /payments`, `GET /customers/:id/balance`, `GET /reports/aging` |
| Dala | `GET /routes/:agentId`, `POST /visits`, `POST /orders` (agent orqali) |
| Sinxronizatsiya | `GET /sync/pull?since=`, `POST /sync/push` |
| Hisobot/integratsiya | `GET /reports/dashboard`, `GET /reports/sales`, `POST /export/1c`, `POST /import/customers`, `POST /import/products` |

### 7.3 Sinxronizatsiya (offline) — batafsil 9-bo'limda

`GET /sync/pull?since=<cursor>` — katalog, narx, mijoz, marshrut, qoldiq delta'sini qaytaradi.
`POST /sync/push` — 20 tadan guruhlangan hujjatlar, har biri `clientId` bilan, javob: `ACCEPTED | DUPLICATE | ADJUSTED | REJECTED`.

---

## 8. Biznes qoidalari `[MVP-v1.0]`

### 8.1 Buyurtma yaratish (F-M04)

- Yaratuvchi: agent (mobil), direktor/admin (web).
- Kredit limiti va ON_HOLD tasdiqlash bosqichi loyihadan olib tashlandi (soddalashtirish) — yangi buyurtma to'g'ridan-to'g'ri `SUBMITTED` holatida yaratiladi, keyin bitta oddiy `CONFIRMED` bosqichi bilan tasdiqlanadi (`orders.update` huquqi kifoya).
- Mijoz qo'lda bloklangan bo'lsa (`isBlocked`), buyurtma yaratish butunlay rad etiladi — limbo holatga o'tkazilmaydi.
- Agent qadoqlanган miqdorni tanlaganda, tanlangan mahsulot ombordagi qoldiqdan oshsa, mini-app darhol aniq raqam bilan ogohlantiradi ("Omborda N ta mavjud, iltimos tovar sonini kamaytiring") va saqlash tugmasi bloklanadi — real rezervatsiya esa hamon tasdiqlash bosqichida bo'ladi (8.3).
- Oxirgi buyurtmani bir tugma bilan takrorlash.
- Qatorda qadoq birligi tanlanadi (dona/blok/quti) — miqdor avtomatik bazaviy birlikka o'giriladi.

### 8.2 Hisob-kitob tartibi

Har bir qatorda: `lineTotal = qty × unitPrice × (1 − discountPct/100) × (1 + vatRate/100)` — **serverda hisoblanadi**, klient yubormaydi (xavfsizlik: klient narx bilan o'ynay olmasligi kerak).

### 8.3 Qoldiq rezerv qilish (F-M03-005)

Buyurtma `CONFIRMED` bo'lganda qoldiq rezervga o'tadi (`StockMovement type=RESERVE`). Row-level lock bilan — ikki foydalanuvchi oxirgi donani bir vaqtda so'rasa, biri rezerv oladi, ikkinchisiga xato/ogohlantirish qaytadi.

### 8.4 To'lovni taqsimlash — FIFO (F-M05-003)

To'lov kelganda eng eski ochiq fakturadan boshlab avtomatik taqsimlanadi (`PaymentAllocation` yozuvlari yaratiladi). Qolgan summa bo'lsa — mijoz balansiga avans sifatida tushadi. Kassir/direktor qo'lda taqsimlashni o'zgartira oladi.

### 8.5 Mijoz balansi

6.7-bo'limdagi formula bilan hisoblanadi, hech qachon to'g'ridan-to'g'ri yozilmaydi.

### 8.6 Hujjat raqamlash (F-M04-009, 15.2-bo'lim)

| Hujjat | Format | Misol |
|---|---|---|
| Sotish buyurtmasi | `SO-{yil}-{6 raqam}` | `SO-2026-000142` |
| Hisob-faktura | `INV-{yil}-{6 raqam}` | `INV-2026-000142` |
| To'lov | `PAY-{yil}-{6 raqam}` | `PAY-2026-000311` |
| Xarid buyurtmasi | `PO-{yil}-{6 raqam}` | `PO-2026-000027` |

Raqamlar kompaniya doirasida ketma-ket va uzluksiz. Bekor qilingan hujjat raqami qayta ishlatilmaydi, hujjat saqlanib qoladi.

### 8.7 Buyurtma holat diagrammasi (MVP soddalashtirilgan)

```
DRAFT ──► SUBMITTED ──► CONFIRMED ──► DELIVERED ──► CLOSED
              │
              ▼
          CANCELLED
```

ON_HOLD holati (kredit limiti/supervayzer tasdig'i) soddalashtirish bosqichida olib tashlandi — `SUBMITTED` → `CONFIRMED` bitta oddiy bosqich.

`PICKING`/`SHIPPED` oraliq holatlari va ekspeditor jarayoni — `[v1.1]` (logistika moduli).

---

## 9. Interfeyslar — TO'LIQ UI `[MVP-v1.0]`

> **Bu bo'lim majburiy va MVP'ning ajralmas qismi.** Har bir ekran quyidagi holatlar bilan **to'liq** ishlab chiqiladi: bo'sh holat, yuklanish (skeleton), muvaffaqiyatli, xato. Faqat backend tayyor bo'lib, UI "keyinroq" qilinmaydi.

### 9.1 Umumiy UI qoidalari (UX-001..012)

- Tezlik birinchi — har ekranda asosiy amal bitta tegishda.
- Ranglar semantik: qizil — qarz/xato, yashil — to'langan/tayyor, sariq — kutilmoqda.
- Har ro'yxatda: qidiruv, filtr, saralash, Excel eksport — bir xil joyda.
- Bo'sh holat har doim keyingi qadamni taklif qiladi ("Hali mijoz yo'q — Excel'dan import qiling yoki qo'lda qo'shing").
- Xato xabari: nima bo'ldi + nima qilish kerak. "Xatolik yuz berdi" taqiqlanadi.
- Barcha summalar bir xil formatda: `1 234 567,00 so'm`.
- Uch til: o'zbek (lotin), rus, ingliz — hech bir matn kodda qattiq yozilmagan.
- Kontrast ≥ 4.5:1, mobilda shrift ≥ 16px.

### 9.2 Web (Next.js) — to'liq ekranlar ro'yxati

| Ekran | Yo'l | Kim uchun | UI holati |
|---|---|---|---|
| Kirish | `/login` | Barcha | To'liq: forma, xato, "parolni unutdim" |
| Sozlash ustasi | `/onboarding` | OWNER (birinchi kirish) | To'liq wizard: kompaniya → ombor → mahsulot → mijoz → agent |
| Dashboard | `/` | OWNER, SALES_DIRECTOR | To'liq — 9.3-bo'lim |
| Buyurtmalar | `/orders` | Operator, direktor | Jadval, filtr, status badge, bo'sh holat |
| Buyurtma kartochkasi | `/orders/:id` | | To'liq: qatorlar, tarix, tasdiqlash/bekor qilish tugmalari |
| Mijozlar | `/customers` | | Jadval + qidiruv + "yangi mijoz" |
| Mijoz kartochkasi | `/customers/:id` | | Balans, oxirgi 10 buyurtma, tashriflar, bloklash tugmasi |
| Qarzdorlik | `/receivables` | | Aging jadval (5 guruh), eksport |
| To'lovlar | `/payments` | | Ro'yxat + yangi to'lov formasi (taqsimlash UI bilan) |
| Kassa | `/cash` | Kassir | Smena ochish/yopish, kunlik summalar |
| Mahsulotlar | `/products` | | Jadval + rasm yuklash + qadoq sozlash |
| Narx ro'yxatlari | `/price-lists` | | Jadval ko'rinishida narx tahrirlash |
| Ombor | `/stock` | | Qoldiq jadvali (mavjud/rezerv/erkin) |
| Qabul qilish | `/stock/receive` | Omborchi | Forma: mahsulot, miqdor, sabab |
| Yetkazib beruvchilar | `/suppliers` | | CRUD |
| Xaridlar | `/purchases` | | Xarid buyurtmasi yaratish, qabul qilish |
| Agentlar | `/agents` | | Ro'yxat, har biriga marshrut va bugungi natija |
| Marshrutlar | `/routes` | | Marshrut yaratish/tahrirlash, nuqta biriktirish |
| Hisobotlar | `/reports` | | 4 hisobot: sotuv, qarzdorlik, agent samaradorligi (asosiy), umumiy |
| Import | `/import` | | Shablon yuklab olish → fayl yuklash → validatsiya xatolari jadvali → tasdiqlash |
| Foydalanuvchilar | `/users` | | CRUD, rolga biriktirish |
| Audit | `/audit` | | Ro'yxat ko'rinishi (filtr/qidiruv UI — `[v1.1]`, MVP'da faqat oddiy ro'yxat) |
| Sozlamalar | `/settings` | | Valyuta, QQS, hujjat prefiksi, ish vaqti |

### 9.3 Dashboard tarkibi

**Yuqori qator — 4 karta:** Bugungi aylanma · Buyurtmalar soni · Yig'ilgan pul · Muddati o'tgan qarz (har birida kechagiga nisbatan % o'zgarish).

**Ikkinchi qator:** Chapda — oxirgi 30 kun aylanma grafigi. O'ngda — bugungi agentlar jadvali (tashrif reja/fakt, buyurtma, summa).

**Uchinchi qator:** Eng katta 10 qarzdor ro'yxati. (Tasdiqlash kutayotgan buyurtmalar/`ON_HOLD` kartasi soddalashtirish bosqichida olib tashlandi — endi barcha buyurtmalar bitta oddiy tasdiqlash bosqichidan o'tadi, 8.1.)

### 9.4 Agent ilovasi (Telegram Mini App) — to'liq ekranlar

**Ekran 1 — Bosh sahifa**
```
┌─────────────────────────────┐
│  Salom, Anvar          🔄 3 │  ← sinxronizatsiya kutayotgan hujjat
├─────────────────────────────┤
│  BUGUN                       │
│  8 / 22 nuqta                │
│  4 200 000 so'm               │
│  Yig'ilgan: 1 800 000        │
├─────────────────────────────┤
│  [  MARSHRUT  ]              │
│  [  BUYURTMA  ]              │
│  [  HISOBOT   ]              │
└─────────────────────────────┘
```

**Ekran 2 — Marshrut.** Sarlavha ostida kun nomi **va sana** (masalan "Dushanba, 06.08.2026"). Nuqtalar ro'yxati: nom, masofa, holat (✅/⏳), qarz summasi qizil rangda. Barcha nuqtalar GPS-tasdiqlangan tashrif bilan yopilgach — **"Marshrutni tugatish"** tugmasi paydo bo'ladi (server har bir bekatni qayta tekshiradi, birortasi yetishmasa aniq ro'yxat bilan rad javobi qaytaradi).

**Ekran 3 — Tashrif.** Yandex xaritada nuqta va agentning joriy joylashuvi ko'rsatiladi. GPS avtomatik olinadi → 150m radiusdan tashqarida bo'lsa, tugmalar butunlay bloklanadi (qat'iy qoida — sababli o'tib bo'lmaydi, 9.4-follow-up). Nuqtada koordinata umuman ro'yxatga olinmagan bo'lsa, bu holat tekshirilmaydi va bloklanmaydi. Mijoz nomi, joriy qarzi katta shriftda, oxirgi buyurtma sanasi. Ikki tugma: `Buyurtma olish` · `Buyurtmasiz ketish`.

**Ekran 4 — Buyurtma.** Yuqorida qidiruv + kategoriya filtri. Mahsulotlar kartochka ko'rinishida: rasm (majburiy ko'rinadi), nom, narx, qoldiq. Miqdor: `−` `12` `+` va qadoq tanlash — kiritilgan miqdor ombordagi qoldiqdan oshsa, kartochka ostida qizil matn bilan aniq raqam ko'rsatiladi ("Omborda N ta mavjud, iltimos tovar sonini kamaytiring") va `SAQLASH` tugmasi bloklanadi. Pastda doimiy: `Jami: 1 240 000 so'm` va `SAQLASH`. Eng yuqorida — oxirgi buyurtmani takrorlash tugmasi.

**Ekran 5 — To'lov.** Mijozning to'lanmagan fakturalari ro'yxati → summa kiritish → FIFO avtomatik taqsimlanadi → kvitansiya (Telegram orqali mijozga yuborish mumkin).

**Qat'iy qoidalar (10.3-bandidan):**
- Bosh ekranda faqat 3 element: bugungi marshrut, buyurtma yaratish, kunlik natija
- Buyurtma yaratish maksimal 4 qadam: mijoz → mahsulot → miqdor → tasdiqlash
- Hech qanday ixtiyoriy maydon majburiy qilinmaydi
- Har bir ekran offline'da to'liq ishlaydi, sinxronizatsiya holati doim yuqori o'ng burchakda
- Barcha tugmalar ≥ 48px balandlikda

### 9.5 Dizayn tizimi

shadcn/ui + Tailwind, ustiga Velto token qatlami (`packages/ui/tokens`). Ikonkalar — Lucide, bitta to'plamdan. Qorong'i rejim — `[MVP-v1.0]` (3.2'da v1.1'dan ko'chirildi): yorug'/qorong'i/tizim, `next-themes` orqali, `class` strategiyasi, tanlov `localStorage`'da saqlanadi.

---

## 10. Offline arxitekturasi `[MVP-v1.0]`

> Bu — texnik jihatdan eng qiyin va eng qimmatli qism.

### 10.1 Ma'lumot toifalari

| Toifa | Yo'nalish | Misol | Strategiya |
|---|---|---|---|
| Ma'lumotnoma | Server → qurilma | Katalog, narx, mijoz, marshrut | To'liq yuklab olish + delta yangilanish |
| Holat | Server → qurilma | Qoldiq, qarz balansi | Delta, "oxirgi ma'lum" deb belgilanadi |
| Hujjat | Qurilma → server | Buyurtma, tashrif, to'lov | Lokal navbat + kafolatli yuborish |

### 10.2 Lokal baza (Dexie.js)

```ts
db.version(1).stores({
  products:   'id, sku, name, categoryId',
  packagings: 'id, productId',
  prices:     '[priceListId+productId], productId',
  customers:  'id, code, name, tin',
  outlets:    'id, customerId',
  stock:      '[productId+warehouseId], productId',
  balances:   'customerId',
  routes:     'id, weekday',
  routeStops: 'id, routeId, outletId',
  queue:      'clientId, type, status, createdAt',   // chiquvchi navbat
  meta:       'key'                                   // cursor, lastSync
});
```

- Katalog va mijozlar — to'liq lokalda. Buyurtmalar tarixi — oxirgi 90 kun.
- Fotolar siqilgan (max 1280px, ~200KB), yuborilgandan keyin o'chiriladi.
- Umumiy hajm chegarasi 50 MB — oshsa eski ma'lumot tozalanadi (navbatga tegilmaydi).
- Lokal baza shifrlangan holda saqlanadi.

### 10.3 Navbat ishlashi

```
Hujjat yaratildi → clientId = uuidv4() → queue ga PENDING → UI darhol "saqlandi" ko'rsatadi

Har 30 soniyada yoki aloqa paydo bo'lganda:
  → PENDING hujjatlar 20 tadan guruhlab yuboriladi
  → ACCEPTED/DUPLICATE → queue'dan o'chiriladi
  → ADJUSTED → o'chiriladi + foydalanuvchiga xabar
  → REJECTED → FAILED, ekranda ko'rsatiladi, qo'lda qayta yuborish
  → xato bo'lsa: eksponensial kechikish (2s, 4s, 8s ... max 5 daq)
```

### 10.4 Konflikt qoidalari

| Holat | Qoida |
|---|---|
| Offline'da narx eski bo'lgan buyurtma | **Server narxi ustun**, buyurtma qabul qilinadi, agentga xabar beriladi |
| Qoldiq tugagan bo'lsa | `SUBMITTED` holatida qabul qilinadi, rezerv qilinmaydi, direktor/admin hal qiladi — buyurtma yo'qolmaydi |
| Mijoz offline'da bloklangan edi | `REJECTED` bilan rad etiladi, aniq xato ko'rsatiladi — hujjat FAILED sifatida ekranda qoladi, jimgina yo'qolmaydi |
| Bir hujjat ikki marta yuborilgan | `clientId` bo'yicha rad etiladi (200 qaytariladi, xato emas) |

**Asosiy tamoyil:** serverga yetib kelgan hujjat hech qachon jimgina yo'qolmaydi.

### 10.5 Test ssenariylari (majburiy)

- [ ] Aviarejim → 20 buyurtma → yoqish → hammasi yetib keldi
- [ ] Sinxronizatsiya o'rtasida aloqa uzildi → qayta ulanish → dublikat yo'q
- [ ] Bir hujjat 3 marta yuborildi → serverda bitta
- [ ] Offline'da narx eskirgan → server tuzatdi → agent xabar oldi
- [ ] Offline'da mijoz bloklandi → buyurtma REJECTED, aniq xato bilan ekranda qoladi, yo'qolmadi
- [ ] Lokal baza to'ldi → eski ma'lumot tozalandi, navbat tegilmadi

---

## 11. 1C eksporti, sprint reja, sifat va yetkazish `[MVP-v1.0]`

### 11.1 1C eksporti

Bir tomonlama: Velto → 1C. Format: CommerceML 2 (XML) + Excel muqobili. Eksport qilinadi: kontragentlar, sotish hujjatlari, to'lovlar. Buxgalter `/export/1c`'da davrni tanlaydi → fayl BullMQ orqali fon rejimida generatsiya qilinadi → yuklab olinadi. `Product.externalCode` maydoni majburiy (1C moslashtirish uchun).

### 11.2 Texnologiya va arxitektura

| Qatlam | Texnologiya |
|---|---|
| Monorepo | Turborepo + pnpm |
| Backend | NestJS 10, TypeScript 5.7, Node 22 |
| ORM | Prisma + PostgreSQL 16 (RLS bilan) |
| Kesh/sessiya | Redis 7 |
| Navbat | BullMQ |
| Web frontend | Next.js 15, React 19, Tailwind, shadcn/ui |
| Agent ilovasi | Telegram Mini App (Next.js) + PWA fallback |
| Offline saqlash | IndexedDB (Dexie.js) |
| Fayl saqlash | S3-mos (MinIO/bulut) |
| Monitoring | OpenTelemetry + Grafana/Sentry |
| Konteyner | Docker, `node:22-alpine` |
| CI/CD | GitHub Actions |

**Arxitektura prinsiplari:** modulli monolit (mikroservis emas). Har modul: `module/{controller, service, repository, dto, events}`. Modullar bir-biriga faqat servis interfeysi orqali murojaat qiladi. Domen hodisalari `OutboxEvent` orqali.

### 11.3 Sprint rejasi (8–10 hafta + 2 hafta bufer)

| Hafta | Ish | Natija |
|---|---|---|
| 1 | Loyiha skeleti, Prisma sxema, RLS, migratsiyalar, seed, CI | Baza tayyor, izolyatsiya testi o'tadi |
| 2 | Auth, RBAC, refresh rotatsiya, audit interceptor | Kirish ishlaydi |
| 3 | Katalog: mahsulot, qadoq, kategoriya, narx, rasm yuklash | Web'da katalog to'liq boshqariladi |
| 4 | Mijozlar, nuqtalar, dublikat tekshiruv (telefon/koordinata/nom), Excel import | Mijoz bazasi import qilinadi |
| 5 | Ombor: qoldiq, harakatlar, rezerv, qulflash. Xarid va qabul | Tovar kirim/chiqim ishlaydi |
| 6 | Buyurtma jarayoni to'liq, hujjat raqamlash, faktura | Web'da buyurtma → yetkazish |
| 7 | To'lov, taqsimlash, balans, aging, kassa smenasi | Qarzdorlik ishlaydi |
| 8 | Telegram Mini App: marshrut, tashrif, buyurtma, to'lov | Agent telefonda ishlaydi (online) |
| 9 | Offline: Dexie, navbat, sinx, konflikt qoidalari | Internetsiz to'liq ishlaydi |
| 10 | Dashboard, hisobotlar, Excel/1C eksport, sayqallash, yuk testi | Reliz tayyor |

Har hafta oxirida: staging'ga deploy + o'zi agent sifatida sinab ko'rish.

### 11.4 Qabul mezonlari

**Funksional:** agent 90s'da 5 qatorli buyurtma yaratadi · 10s'da web'da ko'rinadi · aviarejimdagi 20 buyurtma 30s'da yetadi · takroriy yuborish dublikat bermaydi · ombordagi qoldiqdan oshgan miqdorga aniq raqam bilan ogohlantirish · 1 500 000 so'm to'lov 3 fakturaga FIFO taqsimlanadi · aging 5 guruhda to'g'ri · konkurent buyurtmada biri rezerv oladi ikkinchisi ogohlantiriladi · 1000 mijoz+2000 mahsulot Excel'dan xatosiz import · hujjat raqamlari uzluksiz · 1C eksport fayli yuklanadi · har bir hisobot Excel'ga eksport qilinadi · 150m'dan uzoqda tashrif/marshrutni tugatish bloklanadi · barcha ekranlar 3 tilda.

**Nofunksional:** API p95 <200ms o'qish / <500ms yozish · agent ilovasi 3G'da 3s'da ochiladi · offline qidiruv <100ms · 100 bir vaqtdagi agent yuk testi xatosiz · lokal baza <50MB.

**Xavfsizlik — bloklovchi:** cross-tenant testi har jadval uchun · ruxsatsiz endpoint 403 + audit · refresh token qayta ishlatilsa oila bekor bo'ladi · Telegram `initData` har so'rovda tekshiriladi · parol `argon2id` · SAST kritik topilma bermaydi · barcha pul maydoni `Decimal`, kodda `Float` yo'q.

### 11.5 Seed va demo ma'lumot

```
Tenant: "Demo Distribution" (slug: demo) · Company: "Demo Savdo MChJ"
6 foydalanuvchi (OWNER, SALES_DIRECTOR, 2×SALES_AGENT, WAREHOUSE, CASHIER)
1 ombor · 120 mahsulot (rasm bilan), 5 kategoriya · 2 narx ro'yxati
80 mijoz / 95 nuqta (Toshkent koordinatalari) · 5 marshrut · 30 kunlik tarixiy ma'lumot
```
Prod muhitda seed ishlamaydi. Parollar `.env`dan, kodda yozilmaydi.

### 11.6 Deploy

Konteynerlar: `api` (3001), `worker`, `web` (3000), `miniapp` (3002), `postgres`, `redis`, `minio`. Migratsiyalar orqaga mos, deploy nol to'xtash bilan (rolling), rollback 5 daqiqada.

### 11.7 Reliz oldidan tekshiruv ro'yxati

- [ ] Barcha qabul mezonlari o'tdi
- [ ] Yuk testi bajarildi, zaxira nusxa olindi va tiklash sinovdan o'tkazildi
- [ ] Monitoring/ogohlantirish sozlandi, xato tracker ulandi
- [ ] SSL, HSTS, xavfsizlik sarlavhalari tekshirildi, rate limiting ishlaydi
- [ ] Rollback rejasi sinovdan o'tdi
- [ ] Foydalanuvchi qo'llanmasi (agent — 1 sahifa, rahbar — 3 sahifa)
- [ ] Pilot mijoz ma'lumoti import qilindi va tekshirildi, agentlar 1 soat o'qitildi

---

# QISM B — KELAJAK (FAQAT REJA, HOZIR QURILMAYDI)

> ⚠️ **Eslatma (0-bo'limdan takror):** quyidagi bo'lim — faqat yo'l xaritasi. AI agent yoki dasturchi bu yerdagi hech bir talabni MVP davomida amalga oshirmaydi. Bu bo'lim mavjud bo'lishining yagona sababi — Master TZ'dagi uzoq muddatli vizyonni yo'qotmaslik.

## 12. Versiya yo'l xaritasi

### v1.1 — Operatsion to'liqlik (6–8 hafta, MVP'dan keyin)

> Maqsad: distribyutorning butun kunlik sikli tizim ichida

| Modul | Talablar |
|---|---|
| M07 Logistika | Yig'ish varaqasi, reys, ekspeditor ilovasi, topshirish tasdig'i (F-M07-001..007) |
| M08 Vozvrat | Qaytarish hujjati, sabab, balansga ta'sir, tasdiqlash zanjiri (F-M08-001..004) |
| M10 Trade-marketing | Chegirma turlari, aksiya shartlari, avtomatik qo'llash (F-M10-001..003) |
| M03 Ombor | Inventarizatsiya, omborlar aro ko'chirish (F-M03-006, 007) |
| M05 Moliya | Akt sverka PDF/Excel (F-M05-009) |
| M06 Dala | Xaritada agentlar, javon fotosi, agent KPI/reja-fakt (F-M06-008, 009, 011) |
| M09 Xaridlar | Yetkazib beruvchi qarzi, tannarx (o'rtacha/FIFO), marja (F-M09-003..005) |
| M12 Integratsiya | 1C'dan import, ikki tomonlama avtomatik sinx, SMS gateway (INT-1C-002, 003, INT-SMS-001) |
| M13 Boshqaruv | Audit UI (filtr/qidiruv), maxsus rol yaratish UI (F-M13-002, 004) |
| M01 Mijozlar | Nuqta fotosi (F-M01-011) |
| M02 Katalog | Hajm bo'yicha narx zinapoyasi, mijoz toifasiga ko'ra yashirish (F-M02-007, 008) |
| M04 Sotish | Oldindan buyurtma (preorder), buyurtma shabloni (F-M04-011, 012) |

> **3.2:** "UX | Qorong'i rejim" qatori shu ro'yxatdan ko'chirildi — MVP-v1.0'ga muddatidan oldin qo'shildi, qarang 9.5.

### v1.2 — Komplayens va pul (8–10 hafta)

> Maqsad: markirovka talab qiladigan segmentlarga kirish (bozorni kengaytiruvchi reliz)

| Modul | Talablar |
|---|---|
| M12 Integratsiya | EHF (Didox yoki muqobil), EHF holatini kuzatish (INT-EHF-001, 002) |
| M02/M03 | Markirovka / "Asl belgisi", partiya va yaroqlilik muddati, FEFO (INT-MRK-001,002, F-M02-010,011, F-M03-009,010) |
| M05 Moliya | Payme/Click, qarz undirish rejasi (F-M05-013, F-M05-012, INT-PAY-001) |
| M01 Mijozlar | A/B/C segmentatsiya, dublikat merge (F-M01-012, 013) |
| M04 Sotish | EHF avtomatik shakllantirish (F-M04-013) |
| M10 | Aksiya samaradorligi hisoboti, bonus/agent motivatsiyasi (F-M10-004, 006) |
| M12 | Ochiq REST API + OpenAPI hujjat (INT-API-001) |
| M13 | 2FA majburiy opsiya (F-M13-008) |
| I18N | O'zbek kirill |

### v2.0 — Masshtab va aql (3–4 oy)

- React Native mobil ilova (og'ir foydalanuvchilar uchun)
- Savdo uskunalari nazorati (muzlatgich, stellaj) — F-M01-015
- Import va bojxona, tannarxga xarajat taqsimlash — F-M09-007
- Xarid ehtiyojini bashorat qilish — F-M09-006
- Marshrut optimallashtirish (real algoritm) — F-M06-010, F-M07-008
- Sell-out ma'lumotini ishlab chiqaruvchiga uzatish — F-M11-009
- Hisobot konstruktori — F-M11-010
- Webhook'lar va marketplace integratsiyalari — INT-WH-001
- Ombor uyalari (bin location) — F-M03-011
- Raqobatchi narx qayd etish, tashrif checklist — F-M06-012, 013

### v3.0 — Platforma (kelajak)

- Mijoz (do'kon) uchun B2B portal — o'zi buyurtma beradi
- Ishlab chiqaruvchi kabineti (o'z distribyutorlarini ko'radi)
- Talab bashorati (ML)
- Kredit skoring
- Ochiq ekotizim: uchinchi tomon ilovalari

---

## 13. Risklar va ularni kamaytirish (barcha versiyalarga tegishli)

| Risk | Ehtimol | Ta'sir | Kamaytirish |
|---|---|---|---|
| Agentlar ilovani ishlatishdan bosh tortadi | Yuqori | Kritik | Ilovani radikal soddalashtirish; pilotda agent bilan ko'chaga chiqish |
| 1C integratsiyasi kutilganidan murakkab | Yuqori | Yuqori | v1.0'da faqat bir tomonlama eksport |
| Offline sinxronizatsiya bug'lari ishonchni yo'qotadi | O'rta | Kritik | Alohida, qattiq test qilingan modul; har hujjat holati ko'rinadi |
| Yirik raqobatchi narxni tushiradi | O'rta | O'rta | Narx bo'yicha raqobat qilmaslik; tezlik va sodda joriy etish |
| Markirovka talablari o'zgaradi | Yuqori | O'rta | Integratsiyani alohida, almashtiriladigan modul sifatida qurish |
| Bitta yirik mijozga qaramlik | O'rta | Yuqori | Birinchi yilda kamida 10 mijoz, hech biri 30%+ daromad bo'lmasin |
| Jamoa hajmi (bitta dasturchi) | Yuqori | Kritik | Qamrovni qattiq cheklash; v1.0'ni kengaytirmaslik |

---

## 14. Nofunksional talablar (global — barcha versiyalarga tegishli, MVP'dan boshlab amal qiladi)

### 14.1 Ishlash

| ID | Talab | Maqsad |
|---|---|---|
| NFR-PERF-001 | API javob (p95), oddiy o'qish | < 200 ms |
| NFR-PERF-002 | API javob (p95), hisobot | < 2 s |
| NFR-PERF-003 | Agent ilovasi ochilish (sovuq start) | < 3 s |
| NFR-PERF-004 | Offline katalog qidiruvi | < 100 ms |
| NFR-PERF-005 | Buyurtma saqlash (offline, lokal) | < 300 ms |
| NFR-PERF-006 | Offline sinx (100 buyurtma) | < 30 s |
| NFR-PERF-008 | Tenant boshiga ma'lumot hajmi | 5M buyurtma qatorigacha degradatsiyasiz |
| NFR-PERF-009 | Bir vaqtda faol agentlar | 500+ tenant bo'yicha |

Har ro'yxat endpoint'ida pagination majburiy, N+1 so'rovlar CI'da tekshiriladi, og'ir hisobotlar BullMQ orqali fon rejimida.

### 14.2 Ishonchlilik

| ID | Talab | Maqsad |
|---|---|---|
| NFR-REL-001 | Uptime | 99.5% (v1), 99.9% (v2) |
| NFR-REL-002 | RPO | ≤ 5 daqiqa |
| NFR-REL-003 | RTO | ≤ 2 soat |
| NFR-REL-007 | Barcha yozuv operatsiyalari idempotent | Majburiy |

### 14.3 Offline (MVP'dan amal qiladi)

NFR-OFF-001..007 — 10-bo'limda batafsil yoritilgan (to'liq offline ishlash, lokal shifrlash, sinxronizatsiya holati ko'rinishi, 50MB chegara).

### 14.4 Kengayuvchanlik

Backend stateless (NFR-SCA-001), sessiya Redis'da (SCA-002), fon vazifalar alohida worker'da (SCA-003), fayllar S3-mos (SCA-005).

### 14.5 Foydalanuvchanlik

NFR-UX-001..007 — 9-bo'limda amalga oshirilgan (≤6 tegish bilan buyurtma, 10 daqiqada birinchi buyurtma, uch tilda xato xabarlari, WCAG 2.1 AA).

### 14.6 Lokalizatsiya

Uch til (o'zbek lotin, rus, ingliz) MVP'dan. O'zbek kirill — `[v1.2]`.

### 14.7 Kuzatuvchanlik

Strukturali JSON loglar + `traceId` (OBS-001), OpenTelemetry (OBS-002), Sentry (OBS-003), health endpoint: DB/Redis/navbat/integratsiyalar (OBS-006), loglarda shaxsiy ma'lumot/parol bo'lmasligi (OBS-007).

---

## 15. Xavfsizlik talablari (global — hech biri "keyinroq"ga qoldirilmaydi)

### 15.1 Tenant izolyatsiyasi — SEC-001..005

6.10-bo'limda batafsil. RLS + Prisma extension + majburiy izolyatsiya testi.

### 15.2 Autentifikatsiya — SEC-010..019

Parol ≥10 belgi, keng tarqalgan parollarga qarshi tekshiruv · `argon2id` xesh · access token 15 daqiqa (JWT) · refresh token bazada, rotatsiya bilan, qayta ishlatilsa butun oila bekor · barcha qurilmadan logout · agent kirishi: telefon+SMS yoki Telegram `initData` · `initData` HMAC imzosi har so'rovda tekshiriladi · brute-force himoyasi (5 urinishdan keyin kechikish, 10dan keyin blok) · 2FA (TOTP) OWNER/ACCOUNTANT uchun majburiy opsiya (`[v1.2]` to'liq UI, MVP'da backend tayyor bo'lishi mumkin) · login'da companyId so'ralmaydi.

### 15.3 Avtorizatsiya — SEC-020..024

RBAC granular (`modul.harakat`) · obyekt darajasida tekshiruv (agent faqat o'z mijozini ko'radi) · tekshiruv serverda · ruxsat rad etilsa 403 + audit · privilege escalation imkonsiz.

### 15.4 Ma'lumot himoyasi — SEC-030..037

TLS 1.3 majburiy, HSTS · DB encryption at rest · zaxira nusxalar shifrlangan · telefonda lokal baza shifrlangan · secrets faqat secret manager'da · **ma'lumot lokalizatsiyasi: O'zbekiston fuqarolarining shaxsiy ma'lumotlari O'zbekiston serverlarida saqlanadi** (markirovka uchun alohida qonuniy talab) · mijoz o'z ma'lumotini eksport/o'chirishni so'rashi mumkin.

### 15.5 Ilova darajasidagi himoya — SEC-040..048

Server-tomon validatsiya (`class-validator`/`zod`, whitelist) · faqat parametrlangan SQL so'rovlar · XSS ekranlash, `dangerouslySetInnerHTML` taqiqlanadi · CSRF himoyasi · rate limiting (IP/user/tenant) · fayl yuklashda MIME+kengaytma+hajm tekshiruvi · CSP/X-Frame-Options/HSTS sarlavhalari · xato xabarida stack trace chiqmaydi · dependency skanerlash (`npm audit`, Dependabot) CI'da bloklaydi.

### 15.6 Audit va javobgarlik — SEC-050..054

Barcha yozuv audit'ga: kim, qachon, nima, eski→yangi qiymat, IP · append-only, o'chirib bo'lmaydi · kirish/chiqish va ruxsat rad etilishi ham yoziladi · moliyaviy operatsiyalar alohida belgilanadi · saqlash muddati ≥3 yil.

### 15.7 Xavfsizlik jarayoni — SEC-060..065

Har PR uchun kod ko'rib chiqish majburiy · SAST CI'da · yillik pentest (20+ mijozdan keyin) · hodisaga javob rejasi hujjatlashtirilgan · prod'ga kirish faqat 2FA bilan · prod ma'lumotlari faqat anonimlashtirilgan holda dev'ga ko'chiriladi.

---

## 16. Test strategiyasi va CI/CD (global)

| Daraja | Qamrov maqsadi | Nima tekshiriladi |
|---|---|---|
| Unit | ≥ 70% | Narx, chegirma, balans, GPS radiusi kabi biznes qoidalari |
| Integratsiya | Barcha kritik oqim | API + DB, tenant izolyatsiyasi |
| E2E | 10 asosiy ssenariy | Buyurtma → yetkazish → to'lov |
| Offline | Majburiy | Aloqa uzilishi, qayta ulanish, konflikt |
| Yuk (load) | Har relizda | 500 bir vaqtdagi agent |
| Xavfsizlik | Har relizda | Cross-tenant, RBAC, injection |

**CI/CD:** PR → lint+typecheck → unit → integratsiya (Postgres+Redis konteynerda) → xavfsizlik skaneri → build → preview deploy → kod ko'rib chiqish → merge → staging avtomatik deploy → smoke test → prod'ga qo'lda tasdiq bilan deploy. Migratsiyalar orqaga mos, rollback 5 daqiqada.

**Definition of Done (har vazifa uchun):** kod ko'rib chiqilgan · unit+integratsiya test yozilgan va o'tmoqda · tenant izolyatsiya tekshirilgan · uch tilga tarjima · offline holati ishlangan (agentga tegishli bo'lsa) · xato holatlari ishlangan · API hujjati yangilangan · shu TZ'dagi talab ID'si bilan bog'langan.

---

## 17. Ilovalar

### 17.1 Glossariy

| Termin | Ma'nosi |
|---|---|
| Nuqta (outlet) | Jismoniy savdo nuqtasi |
| Mijoz (customer) | Yuridik shaxs/kontragent, bir nechta nuqtasi bo'lishi mumkin |
| Marshrut | Agentning ma'lum kunda aylanadigan nuqtalar ketma-ketligi |
| Tashrif (visit) | Agentning nuqtaga bir marta borishi |
| SFA | Sales Force Automation |
| Sell-in/Sell-out | Distribyutorga sotish / distribyutordan do'konga sotish |
| Aging | Qarzning yoshi bo'yicha taqsimoti |
| EHF | Elektron hisobvaraq-faktura |
| Markirovka | Majburiy raqamli markirovka ("Asl belgisi") |
| FEFO | First Expired First Out |
| Akt sverka | Taraflar o'rtasidagi o'zaro hisob-kitob dalolatnomasi |

### 17.2 KPI ta'riflari

| KPI | Formula |
|---|---|
| Marshrut bajarilishi | bajarilgan tashrif / rejalashtirilgan tashrif |
| Effektiv tashrif | buyurtmali tashrif / jami tashrif |
| O'rtacha chek | jami aylanma / buyurtmalar soni |
| Faol mijoz bazasi | davr ichida ≥1 buyurtma bergan nuqtalar |
| DSO (qarz aylanishi) | (o'rtacha debitorlik / aylanma) × kunlar |
| Muddati o'tgan ulush | muddati o'tgan qarz / jami qarz |

---

*Hujjat oxiri. Bu — Velto uchun yagona amaldagi TZ. Master va MVP alohida fayllari endi eskirgan (arxivlanadi). Keyingi yangilanish: birinchi 5 pilot mijoz intervyusidan so'ng, shuningdek MVP tugagach `[v1.1]` bo'limi to'liq reliz hujjatiga aylantiriladi.*
