# VELTO — Yagona mahsulot va texnik topshiriq (MASTER TZ)

> **Mahsulot:** Velto — O‘zbekiston distribyutor kompaniyalari uchun savdo operatsiyalari va distribyutsiya boshqaruv platformasi  
> **Hujjat versiyasi:** 4.0  
> **Sana:** 2026-10-12  
> **Status:** Strategik, mahsulot va texnik talablarni birlashtirgan yagona manba. Mavjud kod auditi va pilot natijalari bilan versiyalanadi.  
> **Asosiy qoida:** shu hujjatdagi MVP scope — hozir quriladigan qism. Yo‘l xaritasidagi keyingi funksiyalar faqat alohida reliz boshlanganda amalga oshiriladi.

---

## 0. Ushbu hujjatdan foydalanish qoidalari

### 0.1 Single source of truth

- Ushbu fayl mahsulot, texnik arxitektura, MVP, qabul mezonlari va roadmap bo‘yicha yagona amaldagi hujjat hisoblanadi.
- Koddagi holat, ishlab turgan funksiyalar va deploy konfiguratsiyasi hujjatdan farq qilsa, dasturchi avval repository, testlar, migratsiyalar va production sozlamalarini tekshiradi; keyin farqni yozib chiqadi. Ishlayotgan funksiyani hujjatga moslash bahonasida sababsiz buzish mumkin emas.
- Har qanday yangi talabga barqaror ID beriladi: `F-*` funksional, `NFR-*` nofunksional, `SEC-*` xavfsizlik, `INT-*` integratsiya, `UX-*` interfeys, `OPS-*` deployment/operatsiya.
- Talabni jim o‘chirish taqiqlanadi. O‘zgartirilgan yoki bekor qilingan talab `SUPERSEDED`, `DEPRECATED` yoki `CANCELLED` statusi va sabab bilan qoladi.

### 0.2 AI-agent / Claude Code uchun majburiy qoidalar

1. Ishni boshlashdan oldin repository tuzilmasi, `package.json`, `pnpm-lock.yaml`, Prisma schema/migrations, mavjud testlar, `.env.example`, PM2/Docker konfiguratsiyasi va Git statusini tekshir.
2. Birinchi navbatda mavjud kodni tushun. Yangi arxitektura, kutubxona yoki frameworkni faqat real bo‘shliq bor bo‘lsa qo‘sh; “zamonaviyroq” ko‘rinishi uchun ishlayotgan stackni almashtirma.
3. MVP scope’dan tashqari funksiyani hozir yozma: model, endpoint, UI placeholder, TODO, feature flag yoki “tez orada” tugmasi sifatida ham qo‘shma.
4. Talab noaniq bo‘lsa, biznes natijasiga ta’sir qiluvchi eng xavfsiz xatti-harakatni tanla, farazni ADR/decision log’da qayd et. Ma’lumotlar, pul, qarz, qoldiq yoki xavfsizlikka taalluqli noaniqlikda taxmin bilan kod yozma.
5. Har bir ekran to‘liq UI holatlariga ega bo‘lsin: loading/skeleton, empty, success, validation error, server error va qayta urinish. “Backend tayyor, UI keyin” MVP yakuni hisoblanmaydi.
6. Har bir biznes qoidasi backendda tekshiriladi. Frontend validatsiyasi qulaylik uchun, xavfsizlik chegarasi emas.
7. Har bir o‘zgarish test, tarjima, kuzatuvchanlik va talab ID’si bilan bog‘lanadi. Critical path testlari o‘tmagan kod relizga kirmaydi.
8. SQL migratsiya, seed, production ma’lumoti yoki secrets ustida xavfli buyruqni tekshirmasdan ishlatma. Destruktiv amaldan oldin backup va rollback rejasi bo‘lishi shart.

### 0.3 MoSCoW

- **M — Must:** MVP ishlashi uchun shart.
- **S — Should:** pilotga yoki birinchi pullik mijozga kuchli ta’sir qiladi; reliz doirasida rejalashtiriladi.
- **C — Could:** qiymati isbotlangandan keyin.
- **W — Won’t now:** roadmap’da qoladi, joriy MVP’da qurilmaydi.

### 0.4 Fakt, faraz va maqsadni ajratish

- **Fakt:** sanasi va tekshiriladigan manbasi bor tashqi ma’lumot.
- **Faraz:** mijoz intervyusi yoki pilot bilan tasdiqlanishi kerak bo‘lgan fikr.
- **Maqsad:** Velto bilan erishishni ko‘zlayotgan, hali kafolatlanmagan natija.
- Hujjatdagi KPI maqsadlari mijozning boshlang‘ich holati o‘lchanmaguncha reklamada fakt sifatida ishlatilmaydi.

---

# 1. Executive summary

## 1.1 Velto nima?

Velto — distribyutor kompaniyaning savdo agenti, savdo direktori, ombori va pul yig‘ish jarayonlarini bir operatsion oqimga bog‘laydigan B2B SaaS platforma. U qog‘oz, Telegram chatlari va tarqoq Excel fayllari sababli yuzaga keladigan qayta kiritish, kechikkan ma’lumot, noto‘g‘ri buyurtma, ko‘rinmaydigan qoldiq va qarzdorlik kabi muammolarni kamaytiradi.

Velto’ning asosiy oqimi:

**Mijoz/nuqta → tashrif → buyurtma → tasdiqlash → ombor chiqimi/yetkazish holati → hisob-faktura → to‘lov taqsimoti → qarzdorlik va hisobot → buxgalteriya tizimiga eksport.**

Velto umumiy ERP yoki buxgalteriya tizimini birdaniga almashtirishga intilmaydi. Birinchi versiyada u mavjud hisob tizimlari bilan yonma-yon ishlaydigan dala savdosi va distribyutsiya operatsiyalari qatlami bo‘ladi.

## 1.2 Biznes tezisi

Dastlabki segment — 5–50 ta agentli, 1–5 ta omborli, ko‘p SKU va savdo nuqtasiga xizmat ko‘rsatadigan FMCG va unga yaqin distribyutorlar. Ular ko‘pincha hisobot va hisob uchun mavjud tizimdan foydalanadi, lekin agentning kunlik ishi, buyurtma oqimi va qarzdorlik nazorati bir nechta alohida vositaga bo‘lingan bo‘lishi mumkin. Bu holat barcha kompaniyalarga tegishli deb taxmin qilinmaydi — intervyuda tasdiqlanadi.

Velto mijozga “ko‘proq funksiya” va’dasini emas, quyidagi qiymatni taklif qiladi:

1. Buyurtma bir marta kiritiladi, keyingi bo‘limlarga qayta qo‘lda ko‘chirilmaydi.
2. Agent yo‘lda mahsulot, o‘ziga biriktirilgan mijoz, oxirgi narx va oxirgi ma’lum qoldiqni ko‘ra oladi.
3. Rahbar buyurtma, tashrif, tushum va qarzdorlik bo‘yicha bir xil operatsion manbaga qaraydi.
4. Sinxronizatsiya xatosi yashirilmaydi: har bir offline hujjatning holati va keyingi amali ko‘rinadi.
5. Joriy etish, ma’lumot importi va foydalanuvchini o‘rgatish mahsulotning o‘ziga kiritiladi.

## 1.3 MVP natijasi

Pilot distribyutor kamida bitta real savdo jamoasini Velto orqali yurita olishi kerak. MVP tugagan deb hisoblash uchun faqat kod yozilgani yetarli emas. Agentlardan foydalanish, offline holat, qoldiq/qarz hisobining to‘g‘riligi, 1C eksportining pilot konfiguratsiyada sinovdan o‘tishi va mijozning to‘lovga tayyorligi tasdiqlanadi.

## 1.4 Velto qilmaydigan ishlar

- Birinchi versiyada 1C yoki boshqa to‘liq buxgalteriya tizimini almashtirmaydi.
- EHF/Asl Belgisi/markirovka integratsiyasini ishlaydigan va yuridik jihatdan tekshirilgan adapter bo‘lmaguncha “tayyor” deb ko‘rsatmaydi.
- Sun’iy intellekt, talab bashorati yoki marshrut optimallashtirishni real ma’lumot va tasdiqlangan biznes qiymatisiz MVP’ga qo‘shmaydi.
- GPS’ni firibgarlikdan mutlaq himoya vositasi deb ko‘rsatmaydi. GPS — operatsion signal, uning cheklovlari bor.
- Qurilma internetga qaytib, server hujjatni qabul qilmaguncha, jismonan yo‘qolgan yoki buzilgan telefondagi ma’lumotni “hech qachon yo‘qolmaydi” deb kafolatlamaydi.

---

# 2. Bozor va mijoz muammosi

## 2.1 Tekshirilgan bozor faktlari

| Ko‘rsatkich | Tekshirilgan fakt | Velto uchun ma’nosi |
|---|---|---|
| O‘zbekiston ulgurji savdo aylanmasi | 2025-yilda 543,3 trln so‘m; o‘sish 12,5% | Bozor iqtisodiy jihatdan sezilarli. Bu Velto’ning TAM/SAM/SOM’i emas. |
| Ulgurji savdo korxonalari | 2026-yil 1-yanvar holatida 51 667 ta faol korxona | ICP filtri kerak: hammasi distribyutor yoki SaaS xaridori emas. |
| Markirovka qoidalari | Soliq qo‘mitasi 2026-yil 1-iyuldan majburiy markirovkali tovarlarni EHF va onlayn NKT orqali realizatsiya qilishga qo‘shimcha tekshiruvlar joriy etilganini bildirgan | Komplayens va integratsiyani roadmap’da rejalashtirish kerak, lekin MVP’da soxta tayyorlik yaratmaslik kerak. |
| 1C | 1C’ning O‘zbekiston uchun savdo boshqaruv yechimi savdo, ta’minot, ombor, moliya va taqsimot jarayonlarini qamrab olishini o‘z tavsifida bildiradi | “1C distribyutsiyani bajara olmaydi” degan pozitsiya noto‘g‘ri. Velto dala ishini soddalashtiruvchi qo‘shimcha qatlam sifatida sotiladi. |
| Sales Doctor | Mahsulot tavsifida agent, buyurtma, GPS tashrif, marshrut, qoldiq, qarzdorlik, yetkazish, qaytarish, chegirma va 1C integratsiyasi borligi ko‘rsatilgan; Digital Pool sahifasi 2 500+ mijoz va o‘rtacha bir haftalik joriy etish ko‘rsatkichlarini e’lon qiladi | Sales Doctor — real to‘g‘ridan-to‘g‘ri raqib. Velto uni faqat funksiyalar ro‘yxati bilan yenga olmaydi. |
| Telegram Mini Apps | Telegram’ning rasmiy hujjatida Mini App uchun DeviceStorage/CloudStorage imkoniyatlari qayd etilgan; DeviceStorage har bot/user uchun 5 MB limitli | Telegram kirish to‘sig‘ini kamaytiradi, ammo katta offline ma’lumotlar ombori uchun IndexedDB/PWA sinovlari zarur. |

**Manbalar:** [Stat.uz — 2025-yil ulgurji savdo](https://stat.uz/en/press-center/news-of-committee/66440-ulgurzhi-savdo-tovar-ajlanmasi-azhmi-543-3-trln-s-mga-etdi-4); [Soliq qo‘mitasi — 2026-yil 1-iyul talablari](https://gov.uz/oz/soliq/news/view/178522); [1C: Управление торговлей для Узбекистана](https://1c.uz/v8/generic_products/uz_trade_management.php); [Sales Doctor — Digital Pool](https://digitalpool.gov.uz/en/product/sales-doctor); [Telegram Mini Apps](https://core.telegram.org/bots/webapps).

## 2.2 Muammo gipotezalari — intervyuda tekshirish majburiy

Quyidagilarni butun bozor haqida isbotlangan fakt sifatida qabul qilish mumkin emas. Har bir gipoteza kamida 15–20 ta maqsadli mijoz intervyusi, so‘ng 3–5 ta pilot orqali tekshiriladi.

| Gipoteza | Muammoning ko‘rinishi | Velto’dagi yechim | Validatsiya dalili |
|---|---|---|---|
| H1. Buyurtma ikki marta kiritiladi | Agent qog‘oz/chatga yozadi, ofis qayta tizimga kiritadi | Agentdan kelgan buyurtma bir marta kiritiladi va ofisga ko‘rinadi | Hozirgi 20 ta buyurtma oqimi kuzatiladi; qayta kiritish daqiqalari o‘lchanadi |
| H2. Agentning qoldiq/qarzga ishonchli kirishi yo‘q | Agent ofisga qo‘ng‘iroq qiladi yoki eski jadvalga qaraydi | Oxirgi sync vaqti ko‘rsatilgan lokal katalog, qoldiq va qarz | Internet uzilgan joyda amaliy sinov; xato va qaror vaqti qayd etiladi |
| H3. Rahbar kun yakunidagi natijani kech oladi | Excel va Telegram hisobotlari jamlanadi | Dashboard va agentlar kesimida kunlik hisobot | “Kecha qancha sotildi?” savoliga javob olish vaqti o‘lchanadi |
| H4. Qarz va to‘lov moslashuvi ko‘p vaqt oladi | To‘lovlar bir nechta faktura bo‘yicha qo‘lda taqsimlanadi | FIFO taqsimoti, avans qoldig‘i, aging va audit izi | Tanlangan 30 ta haqiqiy hisob-kitobda moslik tekshiriladi |
| H5. Katta ERP joriy etish qimmat/uzoq tuyuladi | Kompaniya mavjud tizimni o‘zgartirishdan qo‘rqadi | Cheklangan scope, import andozalari, pilot onboarding | Joriy etish kuni, mijoz sarflagan ish soati va xizmat xarajati o‘lchanadi |
| H6. Agent yangi ilovani ishlatmaydi | Qo‘shimcha dastur murakkab yoki sekin | Telegram Mini App orqali kirish va PWA fallback | Agentlarning faolligi, buyurtma yaratish vaqti va 14 kunlik retention |

## 2.3 Ideal mijoz profili (ICP)

**Birinchi segment:** FMCG (oziq-ovqat, ichimlik, uy kimyosi, gigiyena), farmatsevtika yoki markirovka talablari yuqori bo‘lgan segmentlar keyingi bosqichda; 5–50 faol agent, 1–5 ombor, 500–10 000 savdo nuqtasi, taxminan 200–5 000 SKU. Ko‘rsatkichlar boshlang‘ich segmentatsiya gipotezasi, qat’iy texnik cheklov emas.

- **Qaror egasi:** kompaniya egasi yoki tijorat/savdo direktori.
- **Kundalik foydalanuvchilar:** agent, omborchi, kassir, direktor, admin.
- **Mavjud stack:** 1C yoki boshqa hisob tizimi + Excel/Telegram/qo‘lda aloqa bo‘lishi mumkin.
- **Geografiya:** avval Toshkent va viloyat markazlari; keyinchalik boshqa hududlar.
- **Yaxshi pilot mijoz:** real ma’lumot beradi, mas’ul egasi bor, agentlarni pilotga chiqaradi, haftalik fikr bildiradi va to‘lovga tayyorligini ochiq muhokama qiladi.

**Dastlabki ICP emas:** faqat bitta chakana savdo nuqtasi, marketplace sotuvchisi, ishlab chiqaruvchi zavodning to‘liq ERP ehtiyoji, maxsus on-premise talabi bor yirik holding yoki logistika/WMS chuqur avtomatizatsiyasi kerak bo‘lgan kompaniya — alohida tahlilsiz.

## 2.4 Raqobatchilar: realist taqqoslash

| Muqobil | Kuchli jihatlari | Velto u bilan qanday raqobatlashadi | Nima tasdiqlanishi kerak |
|---|---|---|---|
| **Sales Doctor** | Dala savdosi va distribyutsiya uchun ko‘p funksiyali, 1C integratsiyasi borligi e’lon qilingan | Tor va aniq MVP; tezkor onboarding; agent uchun kam qadamli UX; offline ishonchliligini ochiq sinov natijasi bilan ko‘rsatish; narxning tushunarliligi | Offline qamrovi, real implementatsiya muddati, narx va mijozning total cost of ownership’ini demo orqali solishtirish |
| **1C: Управление торговлей / 1C:Бухгалтерия** | Savdo, zaxira, moliya va hisobotlar uchun keng imkoniyat; lokal hamkorlar va mos konfiguratsiyalar | “Almashtirish” emas, dala savdosi uchun qo‘shimcha qatlam; qayta kiritish va agent UX’ini kamaytirish | Pilotdagi aniq 1C konfiguratsiyasi, ma’lumot almashuv formati, egasi va buxgalter uchun qabul mezonlari |
| **HIPPO / WMS va ulgurji savdo yechimlari** | Ombor operatsiyalari, ulgurji savdo va agent/wms takliflari | Velto’ning birinchi fokusini omborning chuqur WMS’i emas, agent buyurtmasi–to‘lov–qarzdorlik oqimiga qaratish | Qaysi modul overlap qiladi, narx va joriy etish bo‘yicha real taqqoslash |
| **BILLZ va retail POS mahsulotlari** | Chakana savdo nuqtasi, kassalar va do‘kon operatsiyalariga mos | Distributorning agentlar, marshrut, bir nechta mijoz nuqtasi va qarzdorlik oqimi | Mijozlar amalda retail platformadan distribyutorlik ishida foydalanyaptimi — intervyu bilan tekshirish |
| **Excel + Telegram + qog‘oz** | Arzon, tanish, egiluvchan, dastlabki xarajat kam | Ma’lumotni bir marta kiritish, bitta manba, rol bo‘yicha ruxsat, izlanadigan audit, aniq import/export, offline navbat holati | Velto xarajati tejalgan vaqt/xatodan yuqoriligini ko‘rsatishi kerak |
| **Ichki/maxsus dastur** | Biznesga moslashtirilgan bo‘lishi mumkin | Yangilanish, standart jarayon, support va qayta ishlatiladigan mahsulot | Kompaniyada custom software bor-yo‘qligi, almashtirish narxi |

**Muhim qoida:** raqibning mavjud funksiyasi yoki zaifligi demo, hujjat yoki ishonchli manba bilan tasdiqlanmaguncha “yo‘q” deb yozilmaydi. Raqobat jadvali har chorakda yangilanadi. Velto’ning “offline-first”, “5 kunda ishga tushadi”, “eng arzon” kabi da’volari pilotda o‘lchanmaguncha kafolatlangan reklama va’dasi bo‘lmaydi.

## 2.5 Velto’ning farqlanishi — amalda isbotlanadigan ustunliklar

1. **Narrow ICP:** umumiy ERP’ga raqobat qilish emas, 5–50 agentli distribyutorning dala savdosi va operatsiyalarini birinchi o‘ringa qo‘yish.
2. **Agent-first UX:** buyurtma yaratish jarayoni qisqa; takror buyurtma va tez qidiruv; ma’lumot kam bo‘lsa tushunarli xato.
3. **Offline’ning shaffof modeli:** oxirgi sync vaqti, keshdagi qoldiqning eskirganligi, pending/synced/rejected holati va qayta yuborish; “offline hammasi ishlaydi” degan tekshirilmagan va’da emas.
4. **1C’ni saqlash:** dastlab sinovdan o‘tgan eksport, keyin real mijoz talabiga ko‘ra ikki tomonlama integratsiya.
5. **Mahalliy onboarding:** Excel andozalari, uz/ru UI, so‘m formatlari, aniq foydalanuvchi qo‘llanmasi va birinchi 14 kunlik muvaffaqiyat rejasi.
6. **Audit qilinadigan moliya va qoldiq:** tarixni jim o‘zgartirmaslik, reversal hujjatlar, balans va qoldiqni qayta hisoblash.
7. **Pilot isboti:** Velto joriy etilishidan oldingi va keyingi metrikalar bir xil ta’rif bilan o‘lchanadi.

Bu ustunliklar mahsulot tamoyili. Bozor ustunligiga aylanishi faqat real mijozlar, o‘lchovlar va retention bilan isbotlanadi.

---

# 3. Mahsulot strategiyasi va muvaffaqiyat ko‘rsatkichlari

## 3.1 Positioning

> **Velto — 5–50 agentli distribyutorlar uchun savdo nuqtasidagi buyurtmadan qarzdorlik va buxgalteriya eksportigacha bo‘lgan operatsion jarayonni birlashtiruvchi, mavjud hisob tizimi bilan ishlay oladigan platforma.**

Sotuvdagi asosiy gap: “ERP’ingizni almashtiring” emas — “agentdan keladigan savdo ma’lumotini yo‘qotmasdan, tezroq va tekshiriladigan shaklda ofisga olib keling.”

## 3.2 Qiymat formulasi

Velto qiymati quyidagi ko‘rsatkichlar bilan isbotlanadi:

**Net foyda = tejalgan xodim soati qiymati + kamroq xato/qayta ishlash qiymati + tezroq pul yig‘ishdan kelgan foyda − Velto obunasi − joriy etish/support xarajati.**

Bu hisobni har bir pilot uchun mijozning haqiqiy raqamlari bilan to‘ldirish kerak. Hujjatda oldindan yozilgan “4–5x samaradorlik” bozor fakti emas.

## 3.3 Pilot KPI’lari

| KPI | Boshlang‘ich daraja | MVP maqsadi | O‘lchash usuli |
|---|---|---|---|
| Agentda 5 qatorli buyurtma yaratish vaqti | Pilotdan oldin o‘lchanadi | Median ≤ 4 daqiqa; tezkor foydalanuvchi uchun 90 soniya stretch goal | 20 real task, median va p90 alohida |
| Buyurtmalar orasida qayta qo‘lda kiritish | Mavjud jarayondan o‘lchanadi | Pilotda Velto’dan kelgan buyurtma qayta kiritilmasligi | Buyurtma ID’lari orqali solishtirish |
| Offline hujjatlarning serverga yetib borishi | Sinov holatida 0%/baseline | 100% sinov ssenariysida, lokal saqlash buzilmagan sharoitda va sync tugagach | Offline test to‘plami, clientId bo‘yicha audit |
| Dublikat buyurtma/to‘lov | Baseline o‘lchanadi | Takror yuborish dublikat yozuv yaratmaydi | Idempotency va DB unique testlari |
| Buyurtma xatolari | Mijoz bilan aniqlanadi | Pilot davomida baseline’dan ≥30% kamayish — stretch target | Qayta tuzilgan/bekor qilingan buyurtma sabab kodi |
| Kechagi sotuv natijasini topish | Mavjud jarayon o‘lchanadi | ≤30 soniya | 5 foydalanuvchi task testi |
| Qarzdorlik mosligi | Mavjud hisobga nisbatan tekshiriladi | Tanlangan nazorat to‘plamida 100% matematik moslik | Invoice/payment/allocation reconciliation |
| Agent haftalik faolligi | Pilot boshida belgilanadi | 2 hafta davomida taklif qilingan agentlarning ≥80% haftasiga kamida 4 kun faol | Event analytics; faol foydalanuvchi ta’rifi aniq |
| Pullik konversiya | 0 | Kamida 1 pilot pullik davomga o‘tishga rozilik bildirishi | Imzolangan buyurtma yoki faktura, og‘zaki maqtov emas |

## 3.4 Mahsulot prinsiplari

- **Bir ekran — bir asosiy vazifa.** Agent interfeysida bosh sahifa uchta asosiy yo‘nalishni ko‘rsatadi: marshrut, buyurtma, kunlik natija.
- **Server — rasmiy haqiqat manbai.** Lokal qurilmadagi qoldiq/qarz “oxirgi sinxronlangan holat” sifatida belgilanadi.
- **Moliyaviy tarixni o‘chirib bo‘lmaydi.** Xatoni reversal/correction hujjati bilan tuzatish mumkin.
- **Tezlik va tushunarlilik funksiyalar sonidan muhim.** MVP’da ehtiyotsiz feature expansion bo‘lmaydi.
- **Offline ishlash aniq doirada ta’riflanadi.** Offline’da buyurtma/tashrifni lokal yozish — birinchi maqsad. Kassa yakuniyligi, qoldiqni rezerv qilish, huquq bekor qilinganidan keyingi yozuvlar server tekshiruvisiz kafolatlanmaydi.
- **Barcha raqamlar izohlanishi kerak.** Dashboarddagi metrikada sana oralig‘i, valyuta, holat filtri va hisoblash ta’rifi hujjatlashtiriladi.
- **Hech bir modul demo/stub bo‘lib qolmaydi.** MVP scope’da yoqilgan tugma haqiqiy biznes amali bajaradi.

---

# 4. Rollar, tenant va ruxsatlar

## 4.1 MVP rollari

| Rol kodi | Ko‘rsatiladigan nom | Asosiy vakolat | Interfeys |
|---|---|---|---|
| `OWNER` | Admin | Kompaniya sozlamalari, foydalanuvchilar, moliya va eksportga to‘liq ruxsat | Web |
| `SALES_DIRECTOR` | Direktor | Buyurtma tasdiqlash, agentlar, marshrut, KPI, hisobot, qarzdorlik kuzatuvi | Web + kerak bo‘lsa mobil |
| `SALES_AGENT` | Agent | O‘ziga biriktirilgan mijoz/nuqtalar, tashrif, buyurtma, ruxsat berilgan to‘lovni qayd etish | Telegram Mini App + PWA fallback |
| `WAREHOUSE` | Omborchi | Ombor qabul qilish, qoldiq, buyurtmani yig‘ish/chiqarish doirasidagi ruxsatlar | Web |
| `CASHIER` | Kassir | To‘lovni qabul qilish va kassa smenasi | Web |
| `ACCOUNTANT` | Buxgalter | Moliyaviy hisobotlar, qarzdorlik reconciliation va 1C/Excel eksporti; posted yozuvlarni bevosita tahrirlash vakolati default’da yo‘q | Web |
| `PLATFORM_ADMIN` | Platforma administratori | SaaS tenant va platforma operatsiyasi; mijoz biznes ma’lumotiga odatiy holatda kirish yo‘q | Alohida, cheklangan admin konteksti |

Yuklangan TZ’ning v3.5 o‘zgarish tarixida `ACCOUNTANT` roli foydalanuvchi talabi bilan qayta tiklangani qayd etilgan. Shu sababli mahsulot spetsifikatsiyasida 6 ta operatsion rol (va ulardan alohida `PLATFORM_ADMIN`) belgilangan. Biroq mavjud repository bilan nomuvofiqlik ehtimoli bor: implementatsiyadan oldin repository, production DB, seed va `ROLE_PERMISSIONS` tekshiriladi. Agar rol kodda yo‘q bo‘lsa, backward-compatible migration va permission tests bilan qo‘shiladi; agar mavjud bo‘lsa, uni o‘chirish taqiqlanadi. Buxgalter posted payment, invoice yoki stock movement’ni bevosita o‘zgartira olmaydi; xato tuzatish alohida ruxsatli reversal/correction oqimi orqali bajariladi.

## 4.2 RBAC qoidalari

- Har bir endpoint backendda rol va obyekt doirasini tekshiradi.
- Ruxsatlar `module.action` shaklida: masalan, `orders.read`, `orders.confirm`, `payments.create`, `stock.receive`, `reports.export`.
- Agent boshqa agentga biriktirilgan mijozni ko‘ra olmaydi, agar alohida ruxsat berilmagan bo‘lsa.
- Frontend tugmani yashirgani server tekshiruvi o‘rnini bosa olmaydi.
- Ruxsat rad etilgani auditga yoziladi; javobda boshqa tenant/kompaniya ma’lumoti ochilmaydi.
- `PLATFORM_ADMIN` tenant biznes jadvallarida oddiy tenant sifatida yurmaydi. Support access vaqt bilan chegaralangan, sababli, auditli va zarurat bo‘lgandagina yoqiladi.

---

# 5. MVP doirasi — v1.0

## 5.1 MVP ichiga kiradigan modullar

| Modul | Scope | Prioritet |
|---|---|---|
| M00 Platform/tenant | Tenant/kompaniya, sozlamalar, ishga tushirish va trial holati; real subscription billing integratsiyasi hozircha yo‘q | M |
| M01 Auth va ruxsat | Login, refresh/logout, Telegram `initData` tekshiruvi, RBAC, sessiya va token revocation | M |
| M02 Mijozlar/nuqtalar | Mijoz, savdo nuqtalari, agentga biriktirish, telefon/nom/koordinata bo‘yicha dublikat ogohlantirishi, bloklash, tarix | M |
| M03 Katalog/narx | Mahsulot/SKU, kategoriya, barcode, rasm, bazaviy birlik, qadoq koeffitsiyenti, narx ro‘yxati, QQS sozlamasi, minimal narx siyosati | M |
| M04 Ombor | Qoldiq, rezerv, erkin qoldiq, qabul, chiqim, harakatlar jurnali, konkurent rezervda locking | M |
| M05 Sotuv | Buyurtma yaratish/tasdiqlash/bekor qilish, statuslar, narx snapshot, oddiy foiz chegirma, faktura va hujjat raqamlash, oddiy yetkazish/chiqim tasdig‘i | M |
| M06 To‘lov/qarzdorlik | Qisman to‘lov, FIFO taqsimlash, avans, qarzdorlik aging, kassa smenasi, reversal bilan tuzatish | M |
| M07 Dala savdosi | Haftalik marshrut shabloni, kunlik RouteRun, tashrif, GPS masofasi, buyurtmali/buyurtmasiz tashrif, marshrutni tugatish | M |
| M08 Xarid | Yetkazib beruvchi, xarid buyurtmasi, soddalashtirilgan qabul va omborga kirim | M |
| M09 Hisobot | Dashboard va sotuv, qarzdorlik, agent samaradorligi, umumiy ko‘rsatkichlar; CSV/XLSX eksport | M |
| M10 Integratsiya | Bir tomonlama, sinovdan o‘tgan 1C eksport adapteri va Excel/CSV fallback; Telegram Bot API; import statuslari | M |
| M11 Audit/bildirishnoma | Audit log, in-app va Telegram bildirishnomalari, job/xato holatlari | M |
| M12 Onboarding | Setup wizard, shablon yuklab olish, Excel import, validatsiya xatolari, import natijasi, agent uchun qisqa qo‘llanma | M |
| M13 Offline/sinxronizatsiya | Lokal buyurtma/tashrif navbati, idempotency, konfliktlarni ko‘rsatish, sync holati, qayta yuborish | M — faqat 10-bo‘limdagi qo‘llab-quvvatlanadigan muhit doirasida |

## 5.2 MVP ichiga kirmaydigan funksiyalar

Quyidagilar MVP’da kodlanmaydi, model yoki placeholder UI ham bo‘lmaydi:

- Elektron hisobvaraq-faktura (EHF) to‘liq yaratish/imzolash/yuborish integratsiyasi.
- “Asl Belgisi” va boshqa markirovka kodlari bilan to‘liq serializatsiya/track-and-trace.
- Click/Payme to‘lov gateway’lari va onlayn to‘lov checkout’i.
- Murakkab trade-marketing: bonus, ko‘p bosqichli aksiya, combo, hajm bo‘yicha narx zinapoyasi.
- To‘liq logistika: reys, ekspeditor mobil ilovasi, GPS yetkazish marshruti, topshirish dalolatnomasi.
- Qaytarish (returns) va qaytarish sabablariga asoslangan hisob-kitob; shu sababli prod moliyaviy hujjatni o‘chirish yoki return orqali “tuzatish” MVP’da amalga oshmaydi — reversal/correction faqat ruxsatli admin oqimi orqali.
- Partiya/lot, yaroqlilik muddati, FEFO, omborlararo transfer, to‘liq inventarizatsiya WMS’i.
- Ikki tomonlama 1C sinxronizatsiyasi; faqat MVP’da tekshirilgan eksport.
- Custom role builder, hisobot konstruktori, ochiq API/webhook marketplace.
- Talab bashorati, AI yordamchi, ML, kredit scoring, ishlab chiqaruvchi kabineti, B2B buyurtma portali.
- React Native alohida ilovasi; PWA/TMA mavjud imkoniyatlari pilot uchun yetarli bo‘lmasa, alohida qaror chiqariladi.

## 5.3 MVP scope’ni boshqarish qoidasi

Har bir yangi feature quyidagi savollarga javob bermasa, MVP’ga qo‘shilmaydi:

1. Qaysi tasdiqlangan mijoz muammosini hal qiladi?
2. Qaysi KPI’ni yaxshilaydi?
3. Qanday test bilan qabul qilinadi?
4. MVP muddatiga va joriy arxitekturaga ta’siri nima?
5. Qaysi mavjud talab yoki ishni siqib chiqaradi?

---

# 6. Biznes obyektlari va ma’lumotlar modeli

> Bu bo‘lim arxitektura shartlarini belgilaydi, lekin mavjud repository’ni ko‘rmasdan butun Prisma schema’ni birdaniga almashtirishga ruxsat bermaydi. Model va migrationlar mavjud kod bilan solishtirilib, bosqichma-bosqich yangilanadi.

## 6.1 Umumiy qoidalar

- Har bir biznes yozuvi UUID primary key, `companyId`, `createdAt`, kerakli joyda `updatedAt`, va zarur bo‘lsa `createdBy`/`updatedBy`ga ega bo‘ladi.
- Har bir tenantga tegishli query serverdan olingan valid `companyId` scope bilan bajariladi. `companyId` client body’dan ishonchli qiymat sifatida qabul qilinmaydi.
- Pul uchun `Decimal`, miqdor uchun `Decimal`, foiz uchun cheklangan aniqlik ishlatiladi. Pul hisoblarida JavaScript `number` yoki PostgreSQL `float` orqali yakuniy summa hisoblanmaydi. API pul summalarini JSON’da aniq decimal string yoki hujjatlashtirilgan minor-unit formatida uzatadi.
- Hujjatdagi mahsulot nomi, SKU, birlik, narx, QQS stavkasi va chegirma kabi qiymatlar yaratilish vaqtida snapshot qilib saqlanadi. Keyinchalik katalog o‘zgarsa tarixiy hujjat mazmuni o‘zgarmaydi.
- Hujjatlar va moliyaviy harakatlar hard-delete qilinmaydi. Xato — reversal/correction yoki status amali orqali tuzatiladi; asl yozuv auditda qoladi.
- Qoldiq va balans uchun harakatlar jurnali haqiqat manbai hisoblanadi. Tezlik uchun materialized/projection balans saqlanishi mumkin, lekin uni harakatlardan qayta hisoblash va farqni aniqlash mexanizmi bo‘lishi shart.
- Har bir relation kompaniya doirasida validatsiya qilinadi. Bir kompaniyaning `SalesOrder`i boshqa kompaniyaning `Customer`, `Product`, `Invoice` yoki `Warehouse` obyektini bog‘lay olmaydi.
- Har bir sanali hujjatda timezone aniq bo‘ladi; kompaniya default timezone’i `Asia/Tashkent`. DB vaqtni UTC’da saqlaydi, hisobotlar kompaniya timezone’i bo‘yicha guruhlanadi.

## 6.2 Asosiy obyektlar

### Platforma va ruxsat

- `Tenant`: SaaS mijoz/tenant, status, tarif va trial tugash sanasi.
- `Company`: tenant ichidagi operatsion kompaniya, valyuta, QQS default’i, timezone va hujjat prefiksi.
- `User`, `Role`, `Permission`, `UserRole`, `RolePermission`: foydalanuvchi va granular RBAC.
- `RefreshToken`: faqat token hash’i, family, expiry, revoke va kerakli xavfsizlik metama’lumoti.
- `AuditLog`: append-only operatsion audit.
- `DocumentSequence`: kompaniya + hujjat turi + yil bo‘yicha parallel raqamlash uchun transaction-safe sequence.
- `IdempotencyRecord` yoki har bir biznes hujjatdagi scoped unique `clientId`: takroriy mutation’ni xavfsiz qayta ishlash.

### Mijoz va dala savdosi

- `Customer`: kontragent, kod, nom, telefon, payment term, blok statusi/sababi, narx ro‘yxati, balans proyeksiyasi.
- `Outlet`: jismoniy nuqta, mijozga bog‘lanish, tur, manzil va optional koordinata.
- `AgentAssignment`: agentning mijoz/nuqtaga joriy yoki tarixiy biriktirilishi; audit bilan.
- `Route`, `RouteStop`, `RouteRun`: haftalik marshrut shabloni, stop tartibi, aniq kalendar kunining bajarilish holati.
- `Visit`: agent, outlet, start/end, server tasdiqlagan GPS natijasi, natija va buyurtmasiz qolish sababi.

### Katalog va ombor

- `ProductCategory`, `Product`, `ProductPackaging`, `PriceList`, `PriceListItem`.
- `Warehouse`, `StockLevel`, `StockMovement`, `StockReservation` yoki shu ma’noni yo‘qotmaydigan teng model.
- `Supplier`, `PurchaseOrder`, `PurchaseOrderLine`, `GoodsReceipt` va tegishli line’lar.

### Sotuv va moliya

- `SalesOrder`, `SalesOrderLine`, `Shipment`/`GoodsIssue` va line’lari.
- `Invoice`, `InvoiceLine`.
- `Payment`, `PaymentAllocation`, `CustomerCredit/Advance` yoki avansni tekshiriladigan usulda ifodalovchi ledger yozuvi.
- `CashSession`, `CashMovement`.
- `LedgerEntry`/moliyaviy yozuvlar append-only bo‘lishi; invoice, payment allocation va avanslarni bir-biriga moslashtirish mumkin bo‘lishi kerak.

### Operatsion infratuzilma

- `OutboxEvent`: transaction ichida yaratiladigan event, fon worker tomonidan qayta ishlanadi.
- `ImportJob`, `ExportJob`, `IntegrationJob`: holat, progress, error summary, retry soni va yaratuvchi.
- `Notification`: kanal, recipient, yuborish holati va qayta urinish.
- `SyncCursor` yoki monoton server cursor: delta sync uchun.

## 6.3 Hujjat statuslari va raqamlash

### Buyurtma statuslari

MVP’da qo‘llanadigan asosiy holatlar:

`DRAFT → SUBMITTED → CONFIRMED → DELIVERED → CLOSED`

`SUBMITTED` holatidan `CANCELLED`ga o‘tish mumkin. `CONFIRMED`dan keyingi bekor qilish qoldiq rezervi va auditga ta’sir qilgani sabab alohida server amali bo‘ladi. Har qanday status o‘zgarishi tranzaksiyada biznes qoidasi bilan tekshiriladi va audit yozuvi qoldiradi.

- `DRAFT`: hali topshirilmagan, serverga yuborilmaguncha lokal holat ham bo‘lishi mumkin.
- `SUBMITTED`: server qabul qilgan, tasdiq kutilmoqda.
- `CONFIRMED`: vakolatli direktor/admin tasdiqlagan, qoldiq rezervlanadi.
- `DELIVERED`: MVP’da ombor chiqimi/topshirish tasdiqlangan; alohida ekspeditor marshruti kirmaydi.
- `CLOSED`: yetkazish va kerakli moliyaviy hujjatlar bo‘yicha ish tugagan. Qarzdorlik qolishi mumkin — “closed” status to‘langan degani emas.
- `CANCELLED`: sabab bilan bekor qilingan. Tarixiy hujjat o‘chmaydi.

Qisman bajarish MVP’da kerak bo‘lsa, bu faqat status so‘zi bilan qilinmaydi: `ShipmentLine.deliveredQty`/chiqim qatorlari orqali buyurtma qatoridan qancha miqdor berilgani saqlanadi. “Qisman bajarish” va “to‘liq yetkazish” bo‘yicha testlar bo‘lmasa, qisman bajarish qobiliyati release notes’da e’lon qilinmaydi.

### Hujjat raqamlari

- Buyurtma: `SO-{YYYY}-{6-digit}`
- Faktura: `INV-{YYYY}-{6-digit}`
- To‘lov: `PAY-{YYYY}-{6-digit}`
- Xarid: `PO-{YYYY}-{6-digit}`

Raqamlash DB transaction/locking orqali concurrent so‘rovda ham takrorlanmaydi. Bekor qilingan raqam qayta ishlatilmaydi. “Uzluksiz va gapsiz” raqamlashni texnik va qonuniy talablar bilan tekshirmasdan va’da qilinmaydi; uzilish yuz bersa sabab auditlanadi.

## 6.4 Ombor hisobi

`StockMovement` harakatlari qoldiq o‘zgarishining asosiy izi: `RECEIVE`, `RESERVE`, `RELEASE`, `ISSUE`, `ADJUST` (nomlar implementatsiyada mavjud enum bilan moslashtiriladi). Harakatlar append-only. `StockLevel` proyeksiya sifatida yangilanishi mumkin.

- `available = onHand - reserved`.
- `CONFIRMED`da qoldiq rezerv qilinadi; konkurent operatsiyalar `SELECT ... FOR UPDATE` yoki ekvivalent serializable transaction bilan himoyalanadi.
- Ombor chiqimi tasdiqlanmaguncha rezerv qoldiqdan chiqarilgan real tovar bilan tenglashtirilmaydi.
- Manfiy qoldiq faqat explicit kompaniya sozlamasi va huquq bilan ruxsat etilishi mumkin; default — taqiqlangan.
- Har bir `ADJUST` sabab, foydalanuvchi va audit bilan yoziladi.
- Qoldiqni tarixiy harakatlardan qayta hisoblash uchun admin-only reconciliation job bo‘ladi; oddiy CRUD orqali qoldiqni qo‘lda yozib qo‘yish taqiqlanadi.

## 6.5 Moliya va qarzdorlik

Asosiy formula:

`Invoice open amount = invoice total − valid allocations − valid credits/adjustments`.

`Customer balance = all posted receivables − allocated payments − applied credits/advances`.

- FIFO avtomatik taqsimoti eng eski ochiq fakturadan boshlanadi; foydalanuvchi taqsimotni o‘zgartirsa, auditda eski/yangi allocation ko‘rinadi.
- To‘lov fakturadan ortiq bo‘lsa, qolgan summa yo‘qolmaydi — avans sifatida ledger’da qoladi.
- To‘lov va invoice allocation bitta DB tranzaksiyasida validatsiya qilinadi. Bitta payment allocation summalarining yig‘indisi payment amount’dan oshmaydi.
- To‘lovni `DELETE` qilish mumkin emas; xato to‘lov reversal/void operatsiyasi bilan tuzatiladi.
- `cachedBalance` ishlatilsa, u transaction ichida asosiy ledger bilan birga yangilanadi; kunlik reconciliation drift aniqlaydi va alert beradi.
- Aging guruhi boshlang‘ich sozlama sifatida: muddati kelmagan, 1–7, 8–30, 31–60, 60+ kun. Guruhlar to‘lov shartlari va hisobot sanasiga asoslanadi, kalendar farqi aniq belgilanadi.
- To‘lovni “agent qabul qildi” deb offline qayd etish va “kassaga tushdi/bank tasdiqladi” holatlari aralashtirilmaydi. Naqd pul bo‘yicha handover/reconciliation qoidasi alohida status va audit bilan ifodalanadi.

## 6.6 Pul, QQS va narx

- Summalar decimal formatda; rounding strategiyasi yagona va test bilan qamrab olinadi.
- Narx, discount, QQS va total serverda hisoblanadi. Frontenddan kelgan `lineTotal` ishonchli hisob sifatida qabul qilinmaydi.
- Buyurtma liniyasi narx manbasi (`priceListId`, price version/as-of timestamp), unit, packaging conversion, discount va VAT snapshot’ini saqlaydi.
- Minimal narxdan past narx siyosati aniq: default’da server rad etadi yoki tasdiqlash vakolatini talab qiladi. Agentning client-side tugmani yashirishi yetarli emas.
- QQS stavkasi hardcode qilinmaydi. Kompaniya va mahsulot bo‘yicha sozlanadigan stavka, amal qilish sanasi va eksport xaritalashi yuritiladi. Amaldagi stavka/yuridik talqin buxgalter va soliq mutaxassisi bilan tasdiqlanadi.
- Chet el valyutasi MVP’da ishlatilmasa, `UZS` yagona valyuta deb belgilanadi; multi-currency keyingi relizga qoladi.

---

# 7. API, integratsiya va backend arxitekturasi

## 7.1 API standartlari

- REST + JSON, URL versiyalash strategiyasi hujjatlashtiriladi (masalan `/api/v1`). Mavjud API bilan moslikni buzadigan o‘zgarish version/deprecation bilan joriy qilinadi.
- Ro‘yxatlarda pagination majburiy: default 25, maximum 100; cursor pagination katta tarixiy jadvallar uchun afzal.
- Standart xato shakli: `{ code, message, details, traceId }`. `message` uz/ru/en lokalizatsiyalanadi; `code` barqaror machine-readable qiymat.
- Create/money/stock/sync operatsiyalari `Idempotency-Key` yoki scoped `clientId` bilan idempotent bo‘ladi. Oddiy `GET` uchun idempotency kerak emas.
- Barcha request DTO serverda validate qilinadi; noma’lum field’lar qabul qilinmaydi.
- Har bir list endpoint’da company scope, permission check, pagination, sort/filter whitelist va N+1 nazorati bor.
- OpenAPI/Swagger API bilan birga yangilanadi.

## 7.2 MVP endpoint guruhlari

Bu ro‘yxat joriy koddagi route nomlariga moslashtiriladi; nomlashning o‘zi amaldagi endpointni ko‘rmasdan majburan o‘zgartirilmaydi.

| Guruh | Minimal imkoniyatlar |
|---|---|
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, Telegram auth/initData exchange |
| Users/RBAC | Foydalanuvchilar CRUD, aktivlik, rol biriktirish, permission check |
| Customers | Ro‘yxat, detail, create/update, assign agent, block/unblock, audit trail |
| Products/prices | Katalog CRUD, qadoq, narx ro‘yxatlari, bulk price import, rasm yuklash |
| Stock | Qoldiq, harakatlar, receive/adjust, reserve/release, goods issue |
| Orders | Create/list/detail, confirm, cancel, deliver/close, order history |
| Finance | Invoices, payments, allocations, customer balance, aging, cash session |
| Field sales | Routes, route run, visits, visit end/result, route completion validation |
| Purchases | Supplier, purchase order, goods receipt |
| Reports | Dashboard, sales, receivables, agent performance, overview, export |
| Import/export | Import job yaratish/status/error download, 1C/CSV/XLSX export job |
| Sync | `GET /sync/pull?cursor=...`, `POST /sync/push` idempotent batches |
| Ops | `/health/live`, `/health/ready`, build/version info faqat xavfsiz maydonlar bilan |

## 7.3 1C integratsiyasi — realistik yondashuv

**MVP sharti:** kamida bitta real pilot mijozning haqiqiy 1C konfiguratsiyasida eksport fayli importdan o‘tishi. “CommerceML 2” yoki boshqa formatni tanlashning o‘zi universal 1C integratsiyasi hisoblanmaydi: konfiguratsiya, katalog moslashtirish, kontragent kodlari va hujjat turi bo‘yicha test talab etiladi.

- Pilot boshida ma’lumot mapping’i kelishiladi: mahsulot kodi, kontragent kodi, birlik, QQS, hujjat sana/raqami, summa va to‘lov turi.
- Export job background’da bajarilishi mumkin; statuslar `PENDING/PROCESSING/DONE/FAILED` va xato sababi ko‘rinadi.
- Fayl hash’i, yaratuvchi, davr, record count va mapping versiyasi auditlanadi.
- Eksport qayta ishga tushsa duplicate accounting document yuzaga kelmasligi uchun tashqi ID/unique mapping yoki import qoidasi aniqlanadi.
- Birinchi relizda xavfsiz CSV/XLSX fallback bor; XML eksport faqat konkret konfiguratsiyada testdan o‘tsa “supported” deb belgilanadi.
- 1C’dan import va ikki tomonlama sync — v1.1; takroriy import, update conflict va source-of-truth qoidalari kelishilmasdan boshlanmaydi.

## 7.4 Telegram Bot API va autentifikatsiya

- `initData` imzosi backendda Telegram’ning rasmiy tekshiruv algoritmi asosida tekshiriladi. Frontend jo‘natgan `user.id`ning o‘zi ishonchli auth emas.
- `auth_date` eskirishi, replay, bot token maxfiyligi, HTTPS, rate limiting va account binding qoidalari aniq bo‘ladi.
- Agar telefon+SMS ishlatilsa, SMS gateway xarajati, resend limiti, abuse protection va delivery status talab sifatida yoziladi; MVP uchun SMS provider tanlanmagan bo‘lsa, uni tasdiqlangan dependency deb ko‘rsatma.
- Telegram Mini App doimiy internet ulanishi va doimiy background process’i bor native ilova deb qabul qilinmaydi.

## 7.5 Event va fon ishlar

- Muhim DB mutation va `OutboxEvent` yozuvi bitta transaction’da yaratiladi.
- Worker idempotent bo‘lib, event takror ishlansa ikkilamchi payment/export/notification yaratmaydi.
- Retry exponential backoff, maksimal urinish va dead-letter/error ko‘rinishi bo‘ladi.
- Queue, Redis yoki BullMQ mavjud bo‘lsa ulardan foydalan; faqat texnik moda uchun yangi queue infratuzilmasi kiritma. Export/import kabi uzoq ishlar request timeout’ga bog‘lanmaydi.

---

# 8. Offline-first va sinxronizatsiya

> Offline — Velto’ning muhim mahsulot gipotezasi, lekin “telefon internetdan uzilganida tizimning istalgan qismi to‘liq ishlaydi” degani emas. MVP’dagi offline doirasi faqat testlangan operatsiyalar bilan belgilanadi.

## 8.1 Platforma yondashuvi

- Agent Telegram Mini App orqali oson kiradi.
- Offline-capable UI uchun PWA fallback va service-worker asset caching ko‘zda tutiladi; Mini App ichida offline support qurilma/Telegram versiyasi bo‘yicha sinovdan o‘tadi.
- Ishga tushganidan keyin birinchi marta internet talab qilinadi: asset, ruxsat, foydalanuvchi va ish uchun kerakli ma’lumotlarni yuklab olish.
- Offline’da buyurtma/tashrif lokal navbatga yozilishi mumkin; server talab qiladigan real rezerv, yakuniy to‘lov tasdig‘i yoki permission revocation’ni telefondagi eski cache bilan kafolatlab bo‘lmaydi.
- `IndexedDB` asosiy offline ma’lumot bazasi bo‘lishi mumkin. Telegram `DeviceStorage` kichik limitli bo‘lgani sabab katta katalog, buyurtma queue yoki fotosuratlar uchun yagona baza qilinmaydi.
- Qurilma brauzeri storage’ni tozalashi yoki ilova ma’lumoti o‘chishi mumkin. Shu sababli serverga sync bo‘lmagan hujjat yonida ogohlantirish, lokal backup/export imkoniyati yoki aniq recovery yo‘li belgilanadi. Hujjat server ACK olmaguncha “serverda saqlandi” deyilmaydi.

## 8.2 Lokal saqlanadigan ma’lumot

- Mahsulotlar, qadoqlar, narxlar, agentga biriktirilgan mijoz/nuqtalar, marshrut va oxirgi ma’lum stock/balance.
- Offline yaratilgan buyurtma, tashrif va ruxsat etilgan payment collection intent’lari.
- Sync queue: `clientId`, entity type, schema version, createdAt, attempt count, last error, status.
- “Qoldiq oxirgi marta qachon yangilangan?” va “qarz qachon sinxronlangan?” doim ko‘rinadi.
- Shaxsiy/moliya ma’lumotlarini lokal saqlash minimum zaruriyat tamoyiliga ko‘ra cheklanadi; chiqish/logout, qurilma almashtirish va account revoke holati sinovdan o‘tadi.

## 8.3 Sinxronizatsiya qoidalari

- Client-generated UUID `clientId` birinchi yaratishda hosil bo‘ladi va barcha retrylarda o‘zgarmaydi.
- `POST /sync/push` batch’ni 20 tagacha hujjat bilan qabul qilishi mumkin; limit konfiguratsiyalanadi. Har item natijasi mustaqil: `ACCEPTED`, `DUPLICATE`, `CONFLICT`, `REJECTED`, `RETRY`.
- Server har bir yozuvni atomik qayta ishlaydi. Butun batch muvaffaqiyatsiz bo‘lsa ham ilgari qabul qilingan hujjatlar takror yaratilmaydi.
- `GET /sync/pull` server cursor yoki monotonic change sequence’dan foydalanadi. Faqat vaqtga asoslangan `updatedAt` cursor teng timestamp/clock skew muammosini hal qilmaydi.
- Sync ACK kelmaguncha lokal hujjat queue’dan o‘chirilmaydi. `DUPLICATE` serverda o‘sha `clientId` bilan mavjud hujjat ekanini tasdiqlaganda muvaffaqiyatli yakun sifatida talqin qilinadi.
- Konflikt foydalanuvchiga tushunarli xabar, oldingi va yangi qiymat, ruxsatli keyingi amal bilan chiqariladi.
- Server qabul qilgan offline hujjat uchun server response ID va final status lokal queue’ga yoziladi.

## 8.4 Konfliktlarni hal qilish

| Vaziyat | Talab qilinadigan xatti-harakat |
|---|---|
| Narx offline paytida o‘zgardi | Eski narx yashirincha yangi narxga almashtirilmaydi. Server narx versiyasini tekshiradi; farq bo‘lsa agent/mas’ulga yangi jami ko‘rsatiladi va biznes siyosatiga qarab tasdiq yoki qayta yuborish talab etiladi. |
| Qoldiq sync’dan keyin tugadi | Buyurtma ma’lumotini jimgina yo‘qotmasdan `CONFLICT`/`SUBMITTED` sifatida saqlash yoki aniq rad etish. Real reserve faqat server transaction’da. Direktor yechimi auditlanadi. |
| Mijoz offline’da bloklandi | Server hujjatni biznes qoidasiga muvofiq rad etishi mumkin; hujjat agent ekranida xato/sabab bilan qoladi va ruxsat etilgan amalsiz o‘chirib tashlanmaydi. |
| Bir request bir necha marta jo‘natildi | Idempotency orqali bitta biznes yozuvi; response `DUPLICATE` bilan bir xil server ID’ni beradi. |
| Telefon qayta ishga tushdi | Ilova qayta ochilganda pending queue qayta tiklanadi. |
| User/agent vakolati bekor qilindi | Server keyingi sync’da yangi hujjatlarni rad etadi; lokal ma’lumotning access/revoke siyosati bajariladi. Avval server qabul qilgan yozuvlar auditda qoladi. |
| Qisman sync yoki tarmoq uzildi | Faqat ACK olingan item’lar synced bo‘ladi; qolganlari keyingi urinishda qayta yuboriladi. |
| Lokal storage kvotasi tugadi | Foydalanuvchiga oldindan signal; pending queue hech qachon avtomatik tozalanmaydi. Eski cache xavfsiz tozalanishi mumkin. |

## 8.5 Offline qabul testlari

- [ ] Birinchi yuklab olishdan keyin airplane mode’da ilova qayta ochilib, cache mavjud bo‘lsa buyurtma/tashrif lokal saqlanadi.
- [ ] 20 ta offline buyurtma, qayta ulanib bo‘lgach, serverda 20 ta unique client ID sifatida ko‘rinadi.
- [ ] Har bir buyurtmani 3 marta qayta jo‘natish duplicate record yaratmaydi.
- [ ] Sync’ning yarmida tarmoq uziladi; qayta ulanganda faqat ACK olinmagan item’lar qayta yuboriladi.
- [ ] Narx o‘zgarganda buyurtma narxi yashirincha almashtirilmaydi.
- [ ] Qoldiq tugasa stock reservation race testidan o‘tadi.
- [ ] Mijoz bloklanganidan keyingi offline order tushunarli statusda qoladi.
- [ ] Lokal storage to‘lsa pending queue yo‘qolmaydi va foydalanuvchi ogohlantiriladi.
- [ ] Kamida Android + iOS, amaldagi Telegram clientlar va PWA brauzerlari uchun support matrix tuziladi.
- [ ] O‘sha test ssenariylari internet sekin bo‘lgan holatda takrorlanadi.

---

# 9. UI/UX talablar

## 9.1 Umumiy dizayn standartlari

- Web: mavjud loyihadagi komponent tizimi va styling saqlanadi; agar hali tanlanmagan bo‘lsa, React/Next.js + Tailwind + shadcn/ui kabi komponent yondashuvi tavsiya etiladi. Stack mavjud repository’dan ustun qo‘yilmaydi.
- Mobil: avval mobile-first. Har bir asosiy action minimum 48px touch target, normal matn mobil ekranda o‘qiladigan, muhim xabarlar faqat rang bilan ifodalanmaydi.
- Uz (lotin), ru, en MVP’dan qo‘llanadi. UI matnlari kodda qattiq yozilmaydi; tarjimalar type/key bo‘yicha CI’da tekshiriladi.
- Uzbek Cyrillic, ikkinchi tillar yoki yangi valyuta MVP’da bo‘lmasa, keyingi reliz roadmap’iga yoziladi.
- Yorug‘/qorong‘i/tizim rejimi mavjud bo‘lsa saqlanadi; theme o‘zgarishi biznes funksiyasini buzmaydi.
- Raqamlar, pul va sanalar locale’ga mos va consistent formatda chiqadi. So‘m default: `1 234 567,00 so‘m`.
- WCAG 2.1 AA darajasidagi kontrast maqsad qilinadi. Xato faqat qizil rang bilan belgilanmaydi; matn va ikonka ham bo‘ladi.
- Jadvalda search/filter/sort/pagination standart joylashadi. Excel export faqat shu ruxsatga ega role’da ko‘rinadi va serverda qayta tekshiriladi.
- Empty state har doim keyingi qadamni aytadi. Xato matni “Xatolik yuz berdi” bilan tugamaydi; sabab va mumkin bo‘lgan amal ko‘rsatiladi.

## 9.2 Web ekranlari

| Ekran | Yo‘l (namuna) | Talab |
|---|---|---|
| Login | `/login` | Validatsiya, lockout/limit xabari, loading/error, xavfsiz logout |
| Onboarding | `/onboarding` | Kompaniya → ombor → mahsulot → mijoz → agent. Importni oldindan ko‘rish va xatolarni yuklab olish |
| Dashboard | `/` | Bugungi aylanma, order count, olingan to‘lov, muddati o‘tgan qarz; 30 kunlik sotuv grafigi; agentlar reja/fakt; top qarzdorlar |
| Buyurtmalar | `/orders` | Status, agent, mijoz, sana, summa filtrlari; detail; status history; confirm/cancel |
| Buyurtma kartochkasi | `/orders/:id` | Snapshot qatorlari, price/stock warning, audit/status history, invoice/shipment bog‘lanishi |
| Mijozlar | `/customers` | Qidiruv, dublikat ogohlantirish, import, assign agent, block/unblock |
| Mijoz kartochkasi | `/customers/:id` | Balans, to‘lanmagan fakturalar, oxirgi 10 buyurtma, to‘lov/tashriflar, block reason |
| Qarzdorlik | `/receivables` | Aging, filter, FIFO allocation ko‘rish, export |
| To‘lovlar | `/payments` | Payment create, allocation preview/edit, receipt/reference, reversal flow (ruxsatli) |
| Kassa | `/cash` | Smena ochish/yopish, boshlang‘ich/yakuniy summa, farq va sabab, audit |
| Mahsulotlar | `/products` | SKU, category, qadoq, barcode, rasm, status, bulk import |
| Narxlar | `/price-lists` | Narx tahriri, validatsiya, amal qilish/snapshot policy |
| Ombor | `/stock` | On-hand/reserved/available, movement history, export |
| Kirim/xarid | `/purchases`, `/stock/receive` | Yetkazib beruvchi, PO, receipt, real qoldiqqa ta’sir |
| Agentlar | `/agents` | Agentlar, kunlik natija, biriktirilgan mijozlar, faollik |
| Marshrutlar | `/routes` | Haftalik route, stop ordering, tarixiy route run |
| Hisobotlar | `/reports` | Sales, receivables, agents, overview; har report uchun formula/filters |
| Import/export | `/import`, `/exports` | Template, preview, mapping, validatsiya, job status/error detail, qayta urinish |
| Foydalanuvchi/ruxsat | `/users` | CRUD, aktiv/deaktiv, rol, server ruxsatlariga mos UI |
| Audit | `/audit` | Actor, amal, vaqt, entity, old/new (field-level masking bilan) |
| Sozlamalar | `/settings` | Kompaniya, timezone, currency, VAT defaults, document prefix, integrations |

Har bir ekran uchun acceptance test bo‘ladi. Bo‘sh jadval, loading, server error, validation error, no permission va success holatlari qamrab olinadi.

## 9.3 Agent Telegram Mini App / PWA

### Ekranlar

1. **Bosh sahifa:** bugungi route completion, pending sync count/holat, `Marshrut`, `Buyurtma`, `Kunlik natija`.
2. **Marshrut:** kun nomi va aniq sana; stop nomi, masofa, tashrif statusi, oxirgi ma’lum qarz va “qarz eskirgan” yorlig‘i.
3. **Tashrif:** outlet koordinatasi, agentning joriy GPS aniqligi, 150m policy tekshiruvi, `Buyurtma olish` va `Buyurtmasiz ketish`; no-order reason kerak bo‘lsa ro‘yxatdan tanlanadi.
4. **Buyurtma:** mijoz, katalog qidiruv/kategoriya, qadoq, miqdor, narx, stock status, discount/VAT va jami; oldingi buyurtmani takrorlash.
5. **To‘lov qaydi:** ochiq fakturalar, summa, to‘lov turi, FIFO preview va tasdiq; offline’da naqd yig‘im intent’i alohida pending bo‘ladi.
6. **Kunlik natija:** tashriflar, buyurtmalar, summa, yig‘ilgan pul va sync holati.

### Qat’iy UX qoidalari

- Agentning buyurtma flow’i: mijoz → mahsulot → miqdor → ko‘rib chiqish/saqlash. Qatorlar uchun foydalanuvchi kerak bo‘lsa qadoqni o‘zgartiradi.
- Saqlash uchun kamida to‘rtta ortiqcha forma bosqichi majburiy qilinmaydi.
- Sinxronizatsiya doim ko‘rinadi: `Saved on this device`, `Waiting to sync`, `Synced`, `Needs attention` kabi holatlar aniq tarjima qilinadi.
- Offline’dagi qoldiq/qarz yonida `Oxirgi yangilanish: ...` kabi vaqt ko‘rsatiladi.
- “Saqlandi” so‘zi qurilmada saqlanganmi yoki serverda qabul qilinganmi, noaniq bo‘lmasin.
- GPS ruxsati yo‘q, permission denied, location accuracy yetarli emas, koordinata kiritilmagan va GPS radiusdan tashqarida holatlari farqli xabar bilan ishlanadi.

## 9.4 GPS va marshrut qoidalari

- 150 metr default nazorat radiusi — biznes konfiguratsiyasi; kompaniyaga moslashtirilishi mumkin, o‘zgarish auditlanadi.
- Koordinatasi bor outlet uchun server masofani qayta hisoblaydi; client yuborgan `gpsOk` qiymati yakuniy haqiqat emas.
- Coords bo‘lmasa `gpsOk = null` va tashrifni avtomatik bloklamaslik mumkin, lekin admin data quality task/alert oladi.
- GPS fix accuracy, timestamp, app/browser holati va texnik signal mavjud bo‘lsa loglanadi. Aniqligi juda past GPS natijasi tasdiqlangan tashrif hisoblanmaydi yoki aniq warning bilan manual review’ga yuboriladi — threshold pilotda aniqlanadi.
- Fake GPS yoki location spoofing’ni oddiy radius tekshiruvi to‘liq bartaraf etmaydi. Buni “firibgarlikni imkonsiz qiladi” deb reklama qilish taqiqlanadi.
- Route completion server tomonida tekshiriladi: talab etilgan stoplar visited/skip statusga ega va siyosatga mos bo‘lishi kerak.

---

# 10. Texnik arxitektura va real repository bilan moslik

## 10.1 Arxitektura qarori

**Modulli monolit — MVP uchun default.** Mikroservislarga bo‘linmaydi. Domen chegaralari aniq bo‘ladi; modullar bir-biri bilan service/application interface yoki domain event orqali ishlaydi, boshqa modulning DB ichki tuzilmasiga bevosita bog‘lanmaydi.

## 10.2 Stack siyosati

Mavjud loyiha kontekstida Velto NestJS + TypeScript + pnpm + Prisma/PostgreSQL va tenant RLS yo‘nalishida ishlab chiqilmoqda. Shu asos saqlanadi. Prioritetlar:

- **Backend:** mavjud NestJS API; modul chegaralari `auth`, `users/rbac`, `customers`, `catalog`, `stock`, `orders`, `finance`, `field-sales`, `purchases`, `reports`, `integrations`, `audit`, `sync`.
- **ORM/DB:** Prisma + PostgreSQL, migration-first. Schema o‘zgarishlari code review va test bilan.
- **Cache/queue:** Redis faqat ishlayotgan yoki asoslangan ehtiyoj bor joyda. Uzoq export/import va notification uchun mavjud infra bilan mos queue/worker.
- **Frontend:** repository’da bor web/miniapp stack saqlanadi. Yangi UI yaratilsa, API contract’lar va shared validation/types bo‘lishi maqsadga muvofiq; backendga UI texnologiyasi aralashmaydi.
- **Offline:** IndexedDB/Dexie yoki mavjud ekvivalent; service worker bilan asset caching va PWA fallback, ammo test qilinmagan platforma “support qilingan” deb belgilanmaydi.
- **Fayllar:** S3-compatible object storage yoki mavjud xavfsiz file service; local diskda yagona nusxa sifatida saqlash prod uchun yetarli emas.
- **Monitoring:** strukturali JSON log, trace/request ID, error tracker, DB/Redis health check va deploy version.
- **CI/CD:** format/lint, typecheck, unit/integration, tenant isolation, build, staging smoke test, manual production approval.

Node, NestJS, Prisma, Next.js va boshqa paketlarning aniq versiyalari mavjud `package.json` va lockfile asosida belgilanadi. Ushbu hujjatdagi versiya nomlari bahona qilib barcha paketlarni bir vaqtda yangilash taqiqlanadi.

## 10.3 Mavjud deploy bilan moslik

Mavjud ishchi muhit bo‘yicha hozirgacha qayd etilgan parametrlar: VPS loyihasi `~/projects/parviz_aka/Velto`, PM2 process `velto-api`, API porti `3101`. Deploydan oldin `pm2 describe`, process environment, reverse proxy, `.env` va repository konfiguratsiyasi bilan bular qayta tekshiriladi.

- Ishlayotgan port/process nomi Docker misoli yoki eski TZ dagi port (masalan 3001) uchun sababsiz almashtirilmaydi.
- Docker Compose, alohida worker/web/miniapp container yoki rolling deployment faqat hozirgi infratuzilmaga mosligi isbotlanganda joriy qilinadi.
- Productiondagi muhit o‘zgarishi backup, rollback va downtime riskini ko‘rsatgan reja bilan bajariladi.
- Secret’lar repoga yoki logga yozilmaydi. `.env.example` faqat kalit nomlari va xavfsiz namunalarni o‘z ichiga oladi.

## 10.4 PostgreSQL RLS — xavfsizlikning kritik chizig‘i

- Har bir company-scoped jadvalda RLS yoqiladi va table owner bypass xavfi audit qilinadi; kerak bo‘lsa `FORCE ROW LEVEL SECURITY` qo‘llanadi.
- Application DB role superuser bo‘lmaydi va RLS’ni chetlab o‘tish vakolatiga ega bo‘lmaydi.
- `SET LOCAL app.current_company_id = ...` kerakli DB transaction ichida o‘rnatiladi. Connection pool ishlatilganda context keyingi request’ga oqib o‘tmasligi test qilinadi.
- Context authenticated server session’dan olinadi. Body, query, header yoki frontend state’dagi `companyId`ga yolg‘iz ishonilmaydi.
- Prisma middleware/extension qo‘shimcha himoya bo‘lishi mumkin, lekin RLS va DB constraints’ni almashtirmaydi.
- Tenant A/B izolatsiyasi har bir tenant model, report, export, background worker va file access uchun avtomatik test qilinadi.
- Integration test RLS’ni chetlab o‘tuvchi DB user bilan emas, production’ga yaqin vakolatdagi app user bilan ishlaydi.

## 10.5 Ma’lumotlar izchilligi va concurrency

- Qoldiq rezervi, to‘lov taqsimoti, hujjat raqamlash va status transition bitta DB transaction bilan himoyalanadi.
- Race condition testlari: oxirgi qoldiqni ikki agent buyurtma qilishi; bitta to‘lovga ikki parallel allocation; bir xil clientId bilan ikki parallel sync; bir xil hujjat sequence.
- Uzoq ishlar request ichida uzoq transaction ochib turmaydi.
- Cache hech qachon moliyaviy/ombor haqiqatining mustaqil manbai bo‘lmaydi.
- Muhim read-modify-write uchun optimistic version yoki pessimistic lock strategiyasi hujjatlashtiriladi.

---

# 11. Xavfsizlik, maxfiylik va qonunchilik

## 11.1 Autentifikatsiya

- Password ishlatilsa, parol hash’i Argon2id kabi mos algoritm bilan saqlanadi; xom parol hech qachon DB/logda qolmaydi.
- Access token qisqa muddatli; refresh token rotation, revocation va reuse detection bilan himoyalanadi.
- Login endpoint’ida user/IP/tenant bo‘yicha rate limit; brute-force va credential stuffing uchun kechikish/vaqtinchalik blok.
- Telegram `initData` serverda rasmiy HMAC tekshiruvdan o‘tadi, `auth_date` freshness limit bilan tekshiriladi.
- Logout kerakli session/refresh token’ni bekor qiladi; “barcha qurilmalardan chiqish” capability’si mavjud bo‘ladi.
- MFA/2FA’ni talab qiluvchi role va majburiyati xavf tahlili bilan belgilanadi. TOTP yoki boshqa yechim ishlatilsa, recovery code va account recovery qoidalari bo‘ladi.

## 11.2 Avtorizatsiya va tenant xavfsizligi

- Har request: authenticated actor → role/permission → company scope → object ownership → biznes qoida.
- Agent faqat o‘ziga biriktirilgan outlet va ruxsatli amallarni bajaradi. Object ID’ni almashtirib boshqa kompaniya hujjatiga kirish (IDOR) test qilinadi.
- Support/admin access default deny. Vaqtincha kirish, sabab, muddat va audit kerak.
- Export, import, file download va background job’da ham tenant scope tekshiruvi bor.
- Error response boshqa tenant borligi/ID’si haqida ma’lumot bermaydi.

## 11.3 Transport, saqlash va secrets

- Prod uchun HTTPS; TLS konfiguratsiyasi joriy hosting/reverse proxy imkoniyatiga qarab kuchli standart bilan sozlanadi; HSTS va xavfsiz headers.
- Production DB porti ochiq internetga chiqarilmaydi; minimal network ACL.
- DB va backup uchun encryption-at-rest imkoniyati yoqiladi; backup access primary app credential’dan ajratiladi.
- Browser/IndexedDB ma’lumotlari XSS bilan o‘g‘irlanishi ehtimoli bor. Shifrlash kerak bo‘lsa, kalit saqlash/rotatsiya va runtime threat modeli yoziladi. Faqat “IndexedDB encrypted” deb yozish xavfsizlik isboti emas.
- `BOT_TOKEN`, DB password, signing key, object storage secret va boshqa credential’lar Git va logga tushmaydi; rotation jarayoni hujjatlashtiriladi.
- Fayl yuklashda MIME, kengaytma, hajm va ruxsat tekshiriladi; original filename ishonchli path sifatida ishlatilmaydi; faylga private access kerak bo‘lsa signed URL va expiry qo‘llanadi.

## 11.4 Audit va moliyaviy javobgarlik

Audit kamida quyidagilarni qayd etadi: actor, kompaniya, vaqt, amal, entity/type, entity ID, old/new qiymat (maxfiy field’lar maskalanadi), trace ID va kerak bo‘lganda IP/user agent.

- Audit append-only; UI’dan tahrirlash/o‘chirish mumkin emas.
- Parol, access/refresh token, OTP, bot token yoki boshqa secret auditga tushmaydi.
- To‘lov, allocation, ombor adjustment, order confirm/cancel, rol/ruxsat o‘zgarishi va export/import alohida audit event hisoblanadi.
- Audit retention muddati yuridik va shartnomaviy talablar bilan belgilanadi; eski TZ’dagi “kamida 3 yil” avtomatik qoida sifatida qabul qilinmaydi, huquqiy maslahatchi va mijoz talabiga ko‘ra tasdiqlanadi.

## 11.5 O‘zbekiston shaxsiy ma’lumotlar qonunchiligi

2026-yil 27-martdan kuchga kirgan O‘RQ-1125 o‘zgartirishida majburiy ravishda O‘zbekiston hududida saqlanishi kerak bo‘lgan ayrim toifalar (jumladan biometrik, genetik va telekommunikatsiya xizmatlaridan foydalanuvchilarga taalluqli ma’lumotlar) ajratilgan, boshqa ma’lumotlar esa belgilangan shartlar bajarilganda chet elda saqlanishi/qayta ishlanishi mumkinligi ko‘rsatilgan. Shu sababli eski hujjatdagi “O‘zbekiston fuqarolarining barcha shaxsiy ma’lumotlari faqat O‘zbekiston serverida” degan umumiy ibora qayta ko‘rib chiqilishi kerak.

Velto uchun majburiy ishlar:

1. **Data inventory:** qanday shaxsiy ma’lumot yig‘iladi, kimga tegishli, nima maqsadda, qayerda saqlanadi, qaysi processor/subprocessor ko‘radi.
2. **Legal review:** amaldagi qonun matni, normativ talablar, State Register majburiyati, cross-border processing shartlari va kompaniyaning data controller/processor roli bo‘yicha yuridik mutaxassis xulosasi olinadi.
3. **Default deployment:** qonuniy tahlil va mijoz talabi yakunlanguncha production primary DB va backup’ni O‘zbekistonda joylashtirish xavfi pastroq boshlang‘ich tanlov sifatida ko‘riladi, ammo bu yuridik xulosa o‘rnini bosmaydi.
4. **Vendor register:** cloud hosting, error tracker, analytics, email/SMS, Telegram va boshqa subprocessors qayd etiladi. Ularga yuboriladigan ma’lumot minimumga tushiriladi.
5. **Consent/notice:** xodim GPS’i va kontaktlari kabi shaxsiy ma’lumotlar uchun maqsad, xabardor qilish, access va retention tartibi belgilanadi.
6. **Data subject requests:** qonuniy doiradagi access, tuzatish, eksport/o‘chirish so‘rovlarini bajarish jarayoni yoziladi. Moliyaviy audit hujjatlarini o‘chirish majburiyatlar bilan ziddiyatga kelmasligi alohida hal qilinadi.
7. **Incident response:** breach aniqlash, ta’sir doirasini chegaralash, dalillarni saqlash, mijoz va tegishli idoralarga xabar berish muddatlari yuridik talablar asosida belgilanadi.

**Manba:** [LEX.UZ — O‘RQ-1125, 26.03.2026, kuchga kirishi 27.03.2026](https://www.lex.uz/ru/docs/8104580?ONDATE=27.03.2026). Ushbu TZ yuridik maslahat emas; qonunchilik o‘zgarishi kuzatilib, release oldidan huquqiy review yangilanadi.

## 11.6 AppSec va supply chain

- DTO validation/whitelist, parameterized SQL, output encoding va CSP.
- XSS/CSRF, SSRF, IDOR, privilege escalation, file upload, token replay va rate-limit testlari.
- Dependency va secret scanning CI’da; critical/high finding release’ni to‘xtatadi yoki imzolangan risk acceptance talab qiladi.
- Prod ma’lumot dev/test’ga ko‘chirilmaydi; test dataset synthetic yoki anonimlashtirilgan bo‘ladi.
- Production deploy uchun faqat zarur vakolatga ega account, MFA/SSH key va audit.
- Security event uchun kontakt va incident runbook mavjud.

---

# 12. Nofunksional talablar (NFR)

Metrikalar target muhitda va aniq workload bilan o‘lchanadi. Quyidagi sonlar benchmark uchun initial target; mavjud server imkoniyatidan tashqarida bo‘lsa, pilot oldidan load test va qaror bilan tuzatiladi, shunchaki bajarildi deb belgilanmaydi.

## 12.1 Performance

| ID | Talab | MVP maqsadi |
|---|---|---|
| NFR-PERF-001 | Oddiy list/detail API latency | p95 ≤ 300 ms, 50 concurrent agent testida |
| NFR-PERF-002 | Mutatsiya API latency | p95 ≤ 700 ms, fon ishlar kiritilmaydi |
| NFR-PERF-003 | Oddiy dashboard/report | p95 ≤ 2 s yoki uzoq ish uchun job/progress ko‘rsatiladi |
| NFR-PERF-004 | Offline katalog qidiruvi | p95 ≤ 150 ms, pilot ma’lumot hajmida |
| NFR-PERF-005 | Lokal buyurtma saqlash | p95 ≤ 300 ms, storage muvaffaqiyatli bo‘lganda |
| NFR-PERF-006 | 100 pending hujjat sinxi | testdagi tarmoq sharoitida ≤ 30 s maqsad; har item statusi saqlanadi |
| NFR-PERF-007 | Pagination | max page 100; katta eksport async job |
| NFR-PERF-008 | Scale test | 100 concurrent agent va demo dataset bilan xatosiz critical-flow load test |

## 12.2 Availability va tiklanish

| ID | Talab | MVP maqsadi |
|---|---|---|
| NFR-REL-001 | Uptime | Dastlab monthly 99.5% target, texnik monitoring asosida o‘lchanadi; SLA bilan bir xil deb qabul qilinmaydi |
| NFR-REL-002 | RPO | ≤ 15 daqiqa maqsad; backup/WAL texnologiyasiga mos ravishda tasdiqlanadi |
| NFR-REL-003 | RTO | ≤ 4 soat maqsad; restore drill bilan isbotlanadi |
| NFR-REL-004 | Backup | Daily encrypted backup + DB hajmi/RPO talabiga mos incremental strategy |
| NFR-REL-005 | Restore | Pilot yoki relizdan oldin backup’dan staging’ga tiklash mashqi |
| NFR-REL-006 | Degraded mode | Redis/queue vaqtincha ishlamasa API qaysi amallarni davom ettirishi va qaysilarni rad etishi hujjatlashtiriladi |
| NFR-REL-007 | Idempotency | Buyurtma, to‘lov, stock movement, import/export va sync’da dublikatdan himoya |

## 12.3 Observability

- Har request/job’da `traceId`/correlation ID.
- JSON logs; parol, token, shaxsiy ma’lumotning keraksiz qismi loglanmaydi.
- `/health/live` process tirikligini, `/health/ready` esa kerakli dependency’larni bildiradi.
- Error tracker va alert: 5xx spike, sync failure, worker backlog, DB connection, backup failure, RLS test failure.
- Dashboard business KPI va system telemetry alohida saqlanadi.
- Har deploy’da commit/build version qayd etiladi.

## 12.4 Accessibility va localization

- Uz/ru/en uchun asosiy yo‘llarda tarjimalar to‘liq.
- Kontrast va klaviatura navigatsiyasi tekshiriladi.
- Date, currency, decimal va timezone testlari.
- Frontend matnlarida tarjimasiz key qolmasligi CI’da tekshiriladi.
- Server error code foydalanuvchiga tushunarli lokal matnga xaritalanadi.

---

# 13. Biznes model va go-to-market

## 13.1 Tariflash — gipoteza, tasdiqlangan narx emas

Oldingi TZ’dagi `$99 / $249 / $549` narxlar real mijoz willingness-to-pay ma’lumoti bilan tasdiqlanmagan. Ularni “final price list” emas, tajriba uchun gipoteza sifatida ishlatish kerak. Narx UZS yoki USD ekvivalentida ko‘rsatilishi, to‘lov va soliq masalalari alohida tekshirilishi kerak.

Tavsiya qilinadigan sinov modeli:

| Paket | Mijoz turi | Paketlash farazi |
|---|---|---|
| **Starter** | 1–5 agentli kichik distribyutor | 1 kompaniya, 1 ombor, standart order/debt/dashboard; cheklangan support |
| **Growth** | 6–20 agent | Marshrut, ko‘proq ombor/mijoz, integratsiya konfiguratsiyasi, kengroq hisobot |
| **Scale** | 21–60 agent | Yuqori limit, ko‘p ombor, admin controls, ustuvor support va kengroq integratsiya |
| **Enterprise** | 60+ agent yoki maxsus talab | Faqat discovery va alohida SLA/hosting xavfi hisoblangach tijorat taklifi |

Agent boshiga, kompaniya boshiga yoki aktiv foydalanuvchiga narxlashni 10–15 ta xaridor intervyusi va 3 ta to‘lov tajribasi bilan solishtirish kerak. Limitlar narxni tushunarli qilish uchun; ular yashirin overage jarimasiga aylanmasligi kerak.

## 13.2 Trial va pilot

- Taklif: 14 kunlik trial yoki 30 kunlik nazoratli pilot. Qaysi biri ishlashi funnel data bilan tanlanadi.
- Trial’da mijoz o‘zining anonimlashtirilgan yoki ruxsatli real ma’lumotini import qilib, kamida bitta real agent ish jarayonini sinaydi.
- Setup checklist: ma’lumot tozalash → import → katalog/narx validatsiyasi → rollar → 1 agent bilan sinov → guruh bo‘yicha ishga tushirish.
- Pilot sharti: mas’ul biznes egasi, texnik kontakt, agentlar, haftalik review va boshlang‘ich metrikalarni o‘lchashga rozilik.
- Trial tugaganda qaysi ma’lumot qolishi, eksport qilinishi yoki o‘chirilishi mijozga oldindan tushuntiriladi.

## 13.3 Sotuv va demo

15 daqiqalik demo uchta real vazifaga qaratiladi:

1. Agent mijozni topib buyurtma tuzadi.
2. Ofis darhol buyurtma holatini ko‘radi va ombor rezerv/chiqim oqimini bajaradi.
3. Mijoz qarzi, payment allocation va kechagi natija ko‘rinadi.

Keyin ikki daqiqalik qo‘shimcha demo: internetni o‘chirib local order saqlash va keyin sync. Faqat testlangan qurilmada ko‘rsatiladi.

## 13.4 Mijoz jalb qilish reja

- **Discovery:** 15–20 ta distributor intervyusi; hech qanday “market fit bor” xulosasi faqat tanishlar fikriga asoslanmaydi.
- **Design partners:** 3–5 ta kompaniya; bepul pilot sharti o‘zaro yozma kelishiladi. Bepul foydalanishdan real willingness-to-pay haqida xulosa qilinmaydi.
- **Proof of value:** har bir pilotda oldingi/keyingi baseline hisobot, xatolar va adoption metrikasi.
- **Referral:** faqat retention va customer satisfaction tasdiqlangandan keyin referral benefit sinovi.
- **Partner kanal:** 1C implementatorlari va mahalliy distribyutor maslahatchilari bilan sinov; ular bilan lead source va komissiya modeli huquqiy/tijoriy ravishda belgilanadi.
- **Marketing:** reklamada faqat isbotlangan case, o‘lchangan natija va qo‘llab-quvvatlanadigan integratsiyalar ko‘rsatiladi.

## 13.5 Unit economics nazorati

Har oy quyidagilar o‘lchanadi:

- MRR/ARR va pullik tenant soni.
- Gross margin = (SaaS revenue − hosting/variable support/integration direct cost) / revenue.
- CAC payback (reklama/sotuv xarajati va bir mijozni jalb qilish vaqti).
- Churn va 90-day retention.
- Har mijozga onboarding/support soati.
- Integration cost: standart setup va maxsus ishlarga ketgan soat.
- NPS/CSAT bilan birga faol foydalanish va pullik davom ko‘rsatkichi.

Agar bir mijoz uchun maxsus kod yozish xarajati oylik obunaga nisbatan katta bo‘lsa, u ish standart mahsulotga kiritilmaydi yoki alohida professional service sifatida narxlanadi.

---

# 14. Reliz yo‘l xaritasi

Roadmap — biznes ustuvorliklari. Ushbu jadval kelajak funksiyalarni hozir implement qilishga ruxsat bermaydi. Har bir keyingi reliz boshlanishida alohida scope, schema review va acceptance criteria tasdiqlanadi.

## Phase 0 — Product validation va mavjud kod auditi

**Maqsad:** noto‘g‘ri muammoni mukammal qurmaslik.

- Mavjud repository va production holatini audit qilish; ishlayotgan funksiyalar ro‘yxati.
- 15–20 ta distributor intervyusi; 3–5 ta real jarayonni kuzatish.
- Buyurtma, ombor, payment, 1C va mobil internet muammolarini process map qilish.
- 3–5 design partner bilan pilot scope va data agreement.
- Bitta pilotdagi 1C configuration’ni aniqlash.
- Offline device matrix va actual Android/iOS Telegram clientlarda PoC.
- Narx gipotezasi va 14 kun/30 kun pilot modelini tekshirish.

**Exit criteria:** kamida 3 ta kompaniya bir xil muammoni tasdiqlaydi; kamida 2 ta kompaniya real dataset/pilotga rozi; birinchi pilotning muvaffaqiyat mezonlari yozma tasdiqlanadi.

## v1.0 — Sell-in/field-sales MVP

**Maqsad:** agent buyurtmasi → ofis → stock → payment/debt → report/export oqimi ishlashi.

- 5-bo‘limdagi M scope.
- Excel import va real dataset mapping.
- 1C eksporti faqat bitta pilot konfiguratsiyasida test bilan.
- Offline buyurtma/tashrif queue’lari va conflict UI.
- RLS, RBAC, audit, backup/restore, monitoring va critical E2E.

**Exit criteria:** 17-bo‘limdagi P0 acceptance mezonlari, 14 kun pilot evidence va kamida bitta pullik continuation signal.

## v1.1 — Operatsion chuqurlik

Faqat MVP metrikalarini ko‘rgandan keyin:

- To‘liq qaytarish hujjati va uning ombor/moliya ta’siri.
- Inventarizatsiya va omborlararo ko‘chirish.
- Oddiy delivery manifest/route va ekspeditor flow’i.
- 1C’dan kontrollangan import, takroriy import himoyasi va conflict review.
- Akt sverka/statement PDF/XLSX.
- Discount rules va trade promotions — biznes talabi tasdiqlanganda.
- Audit advanced filters va custom role UI.
- Nuqta fotosi yoki shelf-check — agent KPI uchun haqiqiy foyda aniqlanganda.

## v1.2 — Mahalliy komplayens va to‘lov integratsiyalari

- EHF provider bilan qonuniy/texnik shartlar va API availability tasdiqlangach integratsiya.
- Markirovka/Asl Belgisi/serializatsiya va MXIK mapping; mahsulot turlari va talablar doirasi yuridik/buxgalteriya mutaxassisi bilan tasdiqlanadi.
- Click/Payme yoki boshqa payment provider; refund/reconciliation/idempotency talablari.
- Partiya, yaroqlilik muddati va FEFO — faqat ICP’ning amaliy talabi bo‘lsa.
- 2FA/MFA siyosatini kengaytirish.
- O‘zbek kirill interfeysi.
- Open REST API va webhook, rate limit va API key lifecycle.

## v2.0 — Masshtab va qaror qabul qilish

- Native mobile app, faqat PWA/TMA support matrix asosiy segment uchun yetarli bo‘lmasa.
- Marshrutni optimallashtirish (algoritm va real traffic/map API xarajati bilan).
- Talab va xarid ehtiyojini bashoratlash — yetarli tarixiy ma’lumot va baseline modeldan yaxshiroq natija isbotlanganda.
- Ombor lokatsiyalari/bin, WMS deep operations.
- Sell-out analytics ishlab chiqaruvchi yoki brand owner uchun, mijoz roziligi/data contract bilan.
- Advanced reporting/BI builder.
- Webhooks va tashqi marketplace/ERP integratsiyalari.

## v3.0 — Ekotizim

- B2B outlet portal: do‘kon mustaqil buyurtma beradi.
- Manufacturer/brand kabineti: distribyutorlar kesimida shartnomaviy sell-out ma’lumoti.
- Ko‘p tenantli partner ecosystem.
- AI assist/forecast faqat data quality, privacy va ROI mezonlari bilan.

---

# 15. Sprint va yetkazish tamoyillari

Avvalgi TZ’dagi “10 hafta + 2 hafta bufer” bu loyiha uchun kafolatlangan muddat emas. Mavjud kodning holati, jamoa hajmi, integratsiya va pilot data sifatiga ko‘ra timeline qayta baholanadi.

## 15.1 Taklif etiladigan workstream’lar

| Ish oqimi | Tugallanish dalili |
|---|---|
| W0 — Repo/code audit | Mavjud va yetishmayotgan feature mapping; stack/deploy diagram; risklar |
| W1 — Data/security foundation | Migrationlar, RLS isolation tests, Auth/RBAC, audit, seed |
| W2 — Core master data | Customers/outlets, product/catalog, price list, Excel import |
| W3 — Stock/sales | Stock movement/reservation, order status, goods issue/delivery, concurrency tests |
| W4 — Finance | Invoice, payment, FIFO allocations, advances, cash session, reconciliation |
| W5 — Field app/offline | Route, visit, Mini App/PWA, local queue, sync/conflict tests |
| W6 — Reporting/integration | Dashboard, four reports, Excel export, pilot 1C export |
| W7 — Release hardening | E2E/load/security, backup/restore, monitoring, documentation, pilot training |

Har sprint oxirida staging deploy, demo, test natijalari va product owner qabul qarori bo‘ladi. Ishlar paralel qilinishi mumkin, lekin critical domain dependencies buzilmaydi.

## 15.2 Definition of Ready

Task boshlanishidan oldin:

- Muammo va foydalanuvchi roli aniq.
- Business rule va edge case yozilgan.
- Muvaffaqiyat mezoni/test scenario mavjud.
- UI/API/data impact belgilangan.
- MVP yoki roadmap scope status aniq.

## 15.3 Definition of Done

- Kod reviewed (yolg‘iz dasturchi bo‘lsa, kamida alohida review pass/checklist).
- Lint, typecheck, build o‘tgan.
- Unit/integration test bor; pul, stock, tenant, permissions va sync uchun tegishli testlar majburiy.
- Tenant isolation tekshirilgan.
- UI holatlari va uz/ru/en matnlari tayyor.
- Audit/logging va monitoring impact ko‘rib chiqilgan.
- API/OpenAPI va TZ talab ID’si yangilangan.
- Migration rollback yoki recovery rejasi mavjud.
- Staging smoke test o‘tgan.

---

# 16. Qabul mezonlari (release blocker)

## 16.1 P0 — biznes oqimi

- [ ] Yangi kompaniya onboarding’dan o‘tib, mahsulot/mijoz import qila oladi.
- [ ] 1 000 mijoz va 2 000 mahsulotli test fayli import preview beradi; xato qatorlari soni/sababi bilan ko‘rsatiladi; import takrorlansa duplicate paydo bo‘lmaydi.
- [ ] Agent o‘ziga biriktirilgan mijozda 5 qatorli buyurtma yaratadi; server line total, VAT/discount va order total’ni qayta hisoblaydi.
- [ ] Direktor buyurtmani tasdiqlaydi; qoldiq rezervi atomik yoziladi.
- [ ] Ikki parallel tasdiqda qoldiqdan ortiq rezerv hosil bo‘lmaydi.
- [ ] Ombor chiqimi bilan qoldiq harakati va buyurtma statusi bitta business operation sifatida izchil yangilanadi.
- [ ] Faktura summasi buyurtma snapshot’i bilan mos; to‘lov fakturadan ortiq bo‘lsa avans sifatida ko‘rinadi.
- [ ] 1 500 000 so‘m payment 3 invoice’ga FIFO bo‘yicha to‘g‘ri taqsimlanadi; allocation sum payment amount’dan oshmaydi.
- [ ] Reversal/correction asl payment yoki stock movement’ni o‘chirib yubormaydi; balans va qoldiq qayta hisoblanganda mos keladi.
- [ ] Aging hisoboti belgilangan date/as-of qoidasi bilan to‘g‘ri ishlaydi.
- [ ] Agent visit va route completion serverda qayta tekshiriladi; GPS no-permission/low-accuracy/outside-radius alohida natija beradi.
- [ ] To‘rtta report uchun filtrlar va CSV/XLSX export natijasi ekranda ko‘ringan filtrlarga mos.
- [ ] Pilotning aniq 1C konfiguratsiyasida eksport/import natijasi buxgalter tomonidan qabul qilingan.

## 16.2 P0 — offline/sync

- [ ] Oldindan yuklangan supported device’da airplane mode’da order local storage’ga saqlanadi.
- [ ] 20 order offline yaratilib, internet qaytgandan keyin server ACK oladi; queue status to‘g‘ri yangilanadi.
- [ ] Bir clientId’ni 3 marta yuborish bitta biznes hujjati yaratadi.
- [ ] Sync o‘rtasida internet uzilishi recovered bo‘ladi; ACK olgan order takror yaratilmaydi.
- [ ] Stale price va stock conflict agentga tushunarli ko‘rsatiladi; financial value yashirincha o‘zgartirilmaydi.
- [ ] Serverga yuborilmagan pending hujjatni cache cleanup o‘chira olmaydi.
- [ ] Logout, permissions revoke va device storage error holatlari test qilingan.

## 16.3 P0 — xavfsizlik

- [ ] Tenant A foydalanuvchisi Tenant B ma’lumotini ID’ni almashtirib, query orqali, export yoki file link orqali ololmaydi.
- [ ] RLS app DB user bilan test qilinadi; table owner/superuser bypass bo‘lmaydi.
- [ ] Ruxsatsiz endpoint serverdan 403 qaytaradi va kerakli audit event yozadi.
- [ ] Refresh-token reuse aniqlansa tegishli token family revoke qilinadi.
- [ ] Telegram `initData` valid/invalid/expired/replayed ssenariylaridan o‘tadi.
- [ ] Muhim mutationlar idempotent; parallel request’lar duplicate yoki noto‘g‘ri balans yaratmaydi.
- [ ] Secret’lar repo, HTTP response va loglarda yo‘q.
- [ ] Prod backup’dan tiklash jarayoni hujjatga mos sinovdan o‘tgan.

## 16.4 P1 — foydalanuvchanlik va ishlash

- [ ] Agent birinchi onboarding’dan keyin ko‘rsatma bilan 10 daqiqa ichida birinchi buyurtmani yaratadi.
- [ ] 5 ta real foydalanuvchi asosiy dashboard savoliga 30 soniyada javob topadi.
- [ ] Critical ekranlarda loading, empty, success, validation/server error va no-permission state’lari bor.
- [ ] Uz/ru/en tarjimalar to‘liq; hardcoded user-facing string CI yoki review orqali aniqlanadi.
- [ ] Performance test aniq workload/device bilan bajarilgan, natija report sifatida saqlanadi.
- [ ] iOS/Android Telegram client va PWA fallback uchun support matrix mavjud.

---

# 17. Test strategiyasi va CI/CD

| Test turi | Minimal qamrov | Release talabi |
|---|---|---|
| Unit | Narx/VAT/discount, balance, FIFO, status transition, GPS distance, permission policy | Critical business rules 100% edge-case scenario bilan qamrab olinadi; umumiy line coverage yordamchi metrika |
| Integration | Postgres transaction, RLS, stock reservation, payment allocation, import/export, outbox | Majburiy |
| E2E | Order → confirm → stock issue → invoice → payment → report | P0 oqimlarining hammasi o‘tadi |
| Offline | Airplane mode, interrupted sync, stale values, duplicate push, quota failure | P0 sync testlaridan hech biri skip qilinmaydi |
| Security | RLS cross-tenant, RBAC, IDOR, XSS/CSRF, auth replay, secrets/dependency scan | Critical/high issue release blocker yoki hujjatlashtirilgan risk exception |
| Load | 50 concurrency MVP baseline, keyin 100+ load target | Error rate va latency report saqlanadi |
| Backup/restore | Backup’dan yangi staging DB’ga restore | Prod release oldidan majburiy |
| UI/accessibility | Keyboard, contrast, mobile viewport, translated error state | Critical screens testlanadi |

Pipeline tavsiyasi: PR → format/lint → typecheck → unit → integration (PostgreSQL + kerakli dependency) → secret/dependency scan → build → preview/staging deploy → smoke E2E → review → merge → production deploy approval.

Migrationlar backward-compatible bo‘lishi kerak: old schema’dan yangisiga bosqichma-bosqich o‘tish; destructive column/table removal alohida release va recovery strategy bilan. “Rollback 5 daqiqa” kabi va’da real staging drill bilan tasdiqlanmasa, SLA sifatida ishlatilmaydi.

---

# 18. Risklar va mitigation

| Risk | Ehtimol/ta’sir | Kamaytirish |
|---|---|---|
| Agentlar yangi flow’dan foydalanmaydi | Yuqori / Kritik | Agent bilan real nuqtada usability test; 5 qatorli buyurtma vaqti va 14 kunlik faollik o‘lchovi |
| Offline support qurilmada beqaror | Yuqori / Kritik | TMA/PWA support matrix, local queue recovery test, “supported devices”ni aniq belgilash |
| 1C export universal emas | Yuqori / Yuqori | Bitta pilot konfiguratsiyasidan boshlash; mapping va accounting acceptance; CSV fallback |
| Qoldiq/balans xatosi | O‘rta / Kritik | Append-only journal, transaction, locking, daily reconciliation, finance/stock testlar |
| Sales Doctor kabi raqiblar yetukroq | Yuqori / Yuqori | Ulardan “kengroq” deb emas, ICP segmenti, integratsiya tajribasi, onboarding va real KPI bilan farqlanish |
| Pilot narx to‘lashga tayyor emas | Yuqori / Yuqori | Erta willingness-to-pay test; bepul foydalanuvchi sonidan ko‘ra paid continuation o‘lchash |
| Scope creep | Yuqori / Yuqori | MVP lock; har yangi feature uchun nimani almashtirishi va KPI ta’siri |
| Bitta yirik mijozga qaramlik | O‘rta / Yuqori | Birinchi yil bir mijoz daromadining 30%+ bo‘lib qolishini kuzatish; segment bo‘yicha diversifikatsiya |
| Shaxsiy ma’lumot bilan qonuniy nomuvofiqlik | O‘rta / Kritik | Data inventory, legal review, subprocessors, backup/data location nazorati |
| Xavfsizlik yoki tenant leak | O‘rta / Kritik | RLS FORCE, app-role integration tests, CI isolation test, incident plan |
| Solo founder support yuklamasi oshadi | Yuqori / Yuqori | Standart onboarding, self-service import, support runbook, custom work pullik va scope-limited |
| KPI/AI va’dalari isbotsiz | O‘rta / Yuqori | Baseline, pilot evidence, marketing claim approval process |

---

# 19. Ochiq qarorlar (Decision log)

Quyidagi masalalar implementatsiyadan oldin repository va pilot bilan tasdiqlanishi kerak. Ularning mavjudligi loyiha boshlanishiga to‘sqinlik qilmaydi, ammo qaror qayd etilmasdan taxmin bilan yopilmaydi.

| ID | Qaror | Default tavsiya | Tasdiqlash dalili |
|---|---|---|---|
| ADR-001 | Current repo/stack va deploy | Mavjud NestJS/pnpm/Prisma/Postgres/RLS va PM2 konfiguratsiyasini saqlash | Repo audit + `pm2 describe`/deployment config |
| ADR-002 | Agent access | Telegram Mini App + PWA fallback; offline support faqat testlangan platformada | Device matrix test |
| ADR-003 | Role set | Yuklangan TZ v3.5 bo‘yicha 6 operational role (jumladan `ACCOUNTANT`) + ajratilgan platform admin; amaldagi repository/DB holatini audit qilib migration rejasini aniqlash | Repository/DB audit, seed va permission tests |
| ADR-004 | 1C export format | Pilotdagi real 1C config asosida; CSV/XLSX fallback | Buxgalter acceptance sign-off |
| ADR-005 | Currency/tax rules | MVP UZS; VAT company/product configuration, hardcoded rate yo‘q | Buxgalter bilan spec review |
| ADR-006 | Customer/agent GPS | 150m boshlang‘ich radius; accuracy/spoofing caveat va manual review policy | Field test va biznes roziligi |
| ADR-007 | Payment offline | Naqd yig‘im intent pending bo‘lishi mumkin; server ACK va handover reconciliation bilan yakunlanadi | Kassir/agent jarayoni sinovi |
| ADR-008 | Data residency/cross-border | Legal review tugamaguncha UZ primary hosting default; data class va processors ro‘yxati | Huquqiy memo va hosting ma’lumoti |
| ADR-009 | Price/tariffs | `$99/$249/$549` faqat willingness-to-pay gipotezasi | 10–15 buyer interview va paid pilot |
| ADR-010 | Full offline claim | Support matrix va testdan o‘tmaguncha marketing’da mutlaq va’da yo‘q | QA report |

---

# 20. Glossariy

| Termin | Ma’nosi |
|---|---|
| Tenant | SaaS doirasidagi mijoz/izolyatsiya chegarasi |
| Company | Tenant ichidagi operatsion yuridik/biznes birlik |
| Customer | Kontragent yoki xaridor hisob yozuvi |
| Outlet | Jismoniy savdo nuqtasi |
| SFA | Sales Force Automation — dala savdosini avtomatlashtirish |
| Sell-in | Distribyutorga ishlab chiqaruvchi/ta’minotchidan kiruvchi savdo |
| Sell-out | Distribyutordan savdo nuqtasiga sotuv |
| Aging | Debitorlikni muddati/yoshi bo‘yicha taqsimlash |
| RLS | PostgreSQL Row-Level Security |
| Idempotency | Bir request qayta yuborilganda bir biznes amalining takror yaratilmasligi |
| Outbox | DB transaction bilan birga yoziladigan, keyin fon worker qayta ishlaydigan event jurnali |
| EHF | Elektron hisobvaraq-faktura |
| MXIK | Mahsulot/xizmat identifikatsiya kodi |
| Asl Belgisi | O‘zbekiston raqamli markirovka tizimi |
| FEFO | First Expired, First Out — muddati oldin tugaydigan mahsulotni oldin chiqarish |
| MRR | Monthly Recurring Revenue — oylik takrorlanuvchi tushum |
| CAC | Customer Acquisition Cost — bir mijozni jalb qilish qiymati |
| RPO/RTO | Recovery Point Objective / Recovery Time Objective |

---

# 21. Tashqi manbalar va tekshirish holati

Quyidagi ommaviy manbalar 2026-10-12 kuni tekshirildi. Raqobatchi feature set’lari va huquqiy qoidalar o‘zgarishi mumkin; ularni har reliz yoki har chorakda qayta tekshirish kerak.

1. **O‘zbekiston Milliy statistika qo‘mitasi**, “The volume of wholesale trade reached 543.3 trillion soums”, 2026-01-22. [Manba](https://stat.uz/en/press-center/news-of-committee/66440-ulgurzhi-savdo-tovar-ajlanmasi-azhmi-543-3-trln-s-mga-etdi-4)
2. **O‘zbekiston Soliq qo‘mitasi**, raqamli markirovka tizimida 2026-yil 1-iyuldan o‘zgarishlar, 2026-06-15. [Manba](https://gov.uz/oz/soliq/news/view/178522)
3. **1C Uzbekistan**, “1C:Управление торговлей для Узбекистана” — savdo, zaxira, moliya va boshqa operatsiyalar tavsifi. [Manba](https://1c.uz/v8/generic_products/uz_trade_management.php)
4. **Digital Pool / Sales Doctor** — public product overview, integratsiyalar va e’lon qilingan business impact. [Manba](https://digitalpool.gov.uz/en/product/sales-doctor)
5. **HIPPO** — ulgurji savdo va WMS tavsifi. [Manba](https://hippo.uz/uz/wms/)
6. **Telegram Core Docs**, “Telegram Mini Apps” — `DeviceStorage`, `SecureStorage` va boshqa API capabilities. [Manba](https://core.telegram.org/bots/webapps)
7. **LEX.UZ**, O‘RQ-1125, “Shaxsga doir ma’lumotlar to‘g‘risida”gi qonunga o‘zgartirish, 2026-03-26; kuchga kirishi 2026-03-27. [Manba](https://www.lex.uz/ru/docs/8104580?ONDATE=27.03.2026)

**Tahlil chegarasi:** public documentation funksiyalarni kompaniya o‘zi e’lon qilgan darajada ko‘rsatadi. Raqobatchi narxlari, aniq offline xatti-harakati, amaldagi joriy etish muddati va real customer ROI mustaqil ravishda to‘liq audit qilinmagan. Shu sababli TZ bularni tekshirilmagan fact sifatida qabul qilmaydi.

---

# 22. O‘zgarishlar tarixi

| Versiya | Sana | Asosiy o‘zgarish |
|---|---|---|
| v3.x | 2026-yil iyul–avgust (oldingi TZ) | MVP modullari, ma’lumot modeli, UI, offline, 1C eksporti va roadmap jamlangan |
| **v4.0** | **2026-10-12** | **Strategiya va texnik talablar qayta tuzildi; bozor faktlari va raqobatchilar qayta tekshirildi; raqib haqida isbotsiz kamchilik da’volari olib tashlandi; KPI’lar fact emas, pilot maqsadi sifatida belgilandi; offline/TMA cheklovlari aniqlandi; 1C eksporti pilot konfiguratsiyaga bog‘landi; RLS, ledger, stock concurrency, sync conflict, data protection va acceptance criteria kuchaytirildi; mavjud repo/deploy’ni sababsiz almashtirmaslik qoidasi kiritildi.** |

---

**Hujjat yakuni.** MVP boshlanishida yoki ishlab chiqish davomida o‘zgartirish kiritilsa, versiya va decision log yangilanadi. Ushbu fayl mahsulotni muvaffaqiyatli qilish uchun zarur tekshiruvlar, cheklovlar va maqsadlarni ajratadi; real natijalar pilotdan olingan dalil bilan belgilanadi.
