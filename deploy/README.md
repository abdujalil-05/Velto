# Deploy — auto-message.uz/velto

Velto bitta umumiy domen ostida, boshqa loyihalar (landing, MarketCo, Auto Builder)
bilan yonma-yon ishlaydi. Alohida subdomen yoki alohida TLS sertifikati yo'q —
hammasi mavjud `auto-message.uz` nginx server blokiga snippet sifatida ulanadi.

## Public manzillar

| Manzil | Nima | Jarayon |
| --- | --- | --- |
| `https://auto-message.uz/velto/` | Back-office (owner/director/warehouse/cashier/accountant) | `velto-web`, Next.js SSR, `127.0.0.1:3100` |
| `https://auto-message.uz/velto/api/` | NestJS API | `velto-api`, `127.0.0.1:3101` |
| `https://auto-message.uz/velto/app/` | Telegram Mini App (sotuv agentlari) | `velto-miniapp`, Next.js SSR, `127.0.0.1:3102` |
| `https://auto-message.uz/velto-files/` | MinIO obyektlari (mahsulot rasmlari, 1C eksport) | `minio`, `127.0.0.1:9000` |

Portlar 31xx oralig'ida, chunki bu hostda 3000/3001 ni MarketCo egallagan.
Barcha backend portlari faqat loopback'da — tashqariga chiqish yagona yo'li nginx.

## Yo'l prefiksi (`/velto`) — qayerda qattiq bog'langan

Prefiks REGISTRGA SEZGIR va uch joyda mos bo'lishi shart:

1. `deploy/nginx.conf` — `location` bloklari.
2. `apps/web/.env.production.local` → `NEXT_PUBLIC_BASE_PATH=/velto`
3. `apps/miniapp/.env.production.local` → `NEXT_PUBLIC_BASE_PATH=/velto/app`

`NEXT_PUBLIC_*` qiymatlari klient bundle'iga **build paytida** yoziladi —
o'zgartirilsa `pm2 restart` emas, to'liq qayta build kerak.

nginx API prefiksini kesadi (`proxy_pass` oxirida `/`), Next ilovalari uchun esa
kesmaydi (`basePath` ilovaning o'zida). Shuning uchun API kodida hech qanday
global prefiks sozlanmagan.

## Birinchi marta o'rnatish

```bash
cd /root/projects/parviz_aka/Velto

# 1. Bog'liqliklar + Prisma klienti
pnpm install
pnpm db:generate

# 2. Baza (bir marta, superuser sifatida)
#    provision-roles.sql BYPASSRLS `*_system` rolini yaratadi — usiz
#    telefon bo'yicha login va cross-tenant fon vazifalari ishlamaydi.
#    ⚠️ Bu hostda skript AYNAN shu holida ishlatilmagan — pastdagi
#    "Postgres rollari" bo'limiga qarang.
#    TARTIB: avval rollar (provision-roles.sql), keyin migratsiya.
#    migrate deploy DATABASE_MIGRATE_URL (schema egasi roli) talab qiladi.
#    Mavjud production bazasi uchun pastdagi "Rol modelini production'ga
#    o'tkazish" runbook'iga qarang.
psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f packages/database/scripts/provision-roles.sql
pnpm --filter @velto/database exec prisma migrate deploy

# 3. Build (barcha workspace'lar)
pnpm build

# 4. nginx snippet
cp deploy/nginx.conf /etc/nginx/snippets/velto.conf
#    auto-message.uz server blokida `include /etc/nginx/snippets/velto.conf;`
#    qatori SPA fallback `location /` dan OLDIN turishi kerak.
nginx -t && systemctl reload nginx

# 5. Jarayonlar
pm2 start deploy/ecosystem.config.js
pm2 save
```

## Yangilash (deploy)

```bash
cd /root/projects/parviz_aka/Velto
git pull
pnpm install
pnpm db:generate
pnpm --filter @velto/database exec prisma migrate deploy   # migratsiya bo'lsa; DATABASE_MIGRATE_URL kerak (yoki ./deploy/deploy.sh)
pnpm build
pm2 restart velto-api velto-web velto-miniapp
```

## Postgres rollari — bu hostdagi chetlanish

`packages/database/scripts/provision-roles.sql` `velto` / `velto_system`
nomlarini qattiq yozadi. Bu Postgres klasterida o'sha nomdagi rollar ALLAQACHON
bor edi — ular iste'foga chiqarilgan boshqa loyihaga (`velto_prod`) tegishli.
Skriptni o'zgarishsiz ishlatish o'sha begona rolga bizning bazamizda ALL huquq
berardi. Shuning uchun bu deploy uchun alohida rollar ishlatilgan:

| Rol | Vazifa |
| --- | --- |
| `velto_app` | ilova roli, RLS unga TO'LIQ tegishli (BYPASSRLS yo'q) |
| `velto_app_system` | BYPASSRLS — faqat telefon bo'yicha login va cross-tenant fon vazifalari |

`velto_app` bazasida `PUBLIC` uchun `CONNECT` bekor qilingan, ya'ni eski
`velto`/`velto_system` rollari bu bazaga umuman ulana olmaydi.

Skript boshqa hostda ishlatilsa (nomlar bo'sh bo'lsa) o'zgartirishsiz ishlaydi.

## Rol modeli (yangi) va env

| Env | Rol | Kim ishlatadi |
| --- | --- | --- |
| `DATABASE_URL` | ilova roli (DML, NOBYPASSRLS) | `velto-api` runtime |
| `DATABASE_SYSTEM_URL` | BYPASSRLS, DML | `velto-api` (login, fon vazifalari), `pg_dump` zaxira |
| `DATABASE_MIGRATE_URL` | schema egasi (NOSUPERUSER NOBYPASSRLS) | FAQAT `prisma migrate deploy` (`deploy.sh` ishga tushirgach `unset` qiladi, `ecosystem.config.js` API env'idan olib tashlaydi) |
| `DATABASE_ADMIN_URL` | superuser | FAQAT bir martalik `provision-roles.sql`; serverda doimiy saqlanmaydi |

Bu hostda nomlar: ilova `velto_app`, system `velto_app_system`, egasi — yangi
`velto_app_owner` (pastdagi runbook). `.env.production.local` ga
`DATABASE_MIGRATE_URL` qo'shiladi (chmod 600).

## Rol modelini production'ga o'tkazish (bir martalik runbook)

⚠️ `provision-roles.sql` ni production'da AYNAN shu holida ishlatmang: u
`velto_owner/velto_app/velto_system` nomlarini qattiq yozadi (eski begona
`velto_system` ga BYPASSRLS + DML berardi), hamda yangi rollarga default
parol (`=rol nomi`) qo'yadi. Avval hozirgi holatni tekshiring (faqat o'qish).

### 0. Tekshiruv (read-only, `psql` superuser sifatida, prod bazaga)

```sql
-- hozir ilova ishlatayotgan rol(lar) atributlari
SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcanlogin
  FROM pg_roles WHERE rolname ~ '^velto' ORDER BY 1;
SELECT current_user, session_user;   -- DATABASE_URL bilan ulanib ham ishga tushiring
-- obyekt egalari
SELECT pg_get_userbyid(datdba) AS db_owner FROM pg_database WHERE datname = current_database();
SELECT pg_get_userbyid(nspowner) AS schema_owner FROM pg_namespace WHERE nspname = 'public';
SELECT pg_get_userbyid(relowner) AS owner, relkind, count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND relkind IN ('r','p','S','v') GROUP BY 1,2;
SELECT pg_get_userbyid(proowner) AS owner, count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' GROUP BY 1;
-- RLS haqiqatan majburiymi
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND relkind = 'r' AND NOT (relrowsecurity AND relforcerowsecurity);
```

Kutiladi: `velto_app` rolsuper=f, rolbypassrls=f. Agar ilova roli superuser
yoki BYPASSRLS bo'lsa — RLS hozir ishlamayapti; bu alohida incident, davom
etishdan oldin to'xtating va xabar bering. Jadvallar egasi odatda `velto_app`
bo'ladi (migratsiyalar shu rol bilan yurgan) — skript egalikni yangi owner'ga
o'tkazadi.

### 1. Zaxira (majburiy, o'zgartirishdan OLDIN)

```bash
pg_dump "${DATABASE_SYSTEM_URL%%\?*}" -Fc -f /root/velto-pre-roles-$(date +%Y%m%d-%H%M%S).dump
pg_dumpall --globals-only -f /root/velto-globals-$(date +%Y%m%d-%H%M%S).sql   # rollar/atributlar (superuser)
```

Dump hajmi/o'qilishini tekshiring (`pg_restore -l <dump> | head`).

### 2. Skript nusxasi (host nomlari bilan) va ishga tushirish

```bash
sed -e 's/velto_owner/velto_app_owner/g' -e 's/velto_system/velto_app_system/g' \
  packages/database/scripts/provision-roles.sql > /root/provision-roles.prod.sql
grep -c 'velto_system' /root/provision-roles.prod.sql   # 0 bo'lishi shart
psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -f /root/provision-roles.prod.sql
psql "$DATABASE_ADMIN_URL" -c "ALTER ROLE velto_app_owner PASSWORD '<kuchli-parol>'"
rm /root/provision-roles.prod.sql
```

Mavjud `velto_app` / `velto_app_system` parollari saqlanadi (skript faqat
yo'q rolni yaratadi). `.env.production.local` ga qo'shing:
`DATABASE_MIGRATE_URL=postgresql://velto_app_owner:<parol>@127.0.0.1:5432/<baza>?schema=public`.
Eski begona `velto`/`velto_system` rollariga bu skript tegmaydi (nomlar almashtirilgan).

### 3. Tekshiruv va deploy

Qayta 0-bo'limdagi so'rovlarni ishga tushiring: barcha obyektlar egasi
`velto_app_owner`, `velto_app` NOBYPASSRLS, RLS qatorlari 0. Keyin
`./deploy/deploy.sh` (u ham yangi `DATABASE_MIGRATE_URL` ni talab qiladi).
Smoke: login, `/velto/api/health`, bitta tenant ro'yxati.

### Rollback

Skript faqat egalik/grant/atributlarni o'zgartiradi (ma'lumotga tegmaydi).
Qaytarish: `ALTER DATABASE/SCHEMA/TABLE ... OWNER TO velto_app` (egalik
konvergensiyasini teskari — 0-bo'limdagi eski egalar jadvaliga qarab), yangi
rolni `DROP OWNED BY velto_app_owner; DROP ROLE velto_app_owner;` (egalik
qaytarilgandan keyin). To'liq buzilsa: `pg_restore --clean --if-exists` yuqoridagi
dump'dan, `velto-api`ni to'xtatib (downtime). Staging'da sinovsiz "5 daqiqada
qaytarish" va'da qilinmaydi.

## Ma'lum kamchiliklar

- **SMS yuborilmaydi.** `SMS_API_TOKEN` bo'sh — Eskiz.uz hisobi ulanmagan.
  Parolni tiklash kodi SMS o'rniga API loglariga yoziladi (`pm2 logs velto-api`).
  Bu `env.schema.ts` dagi ataylab qilingan "ixtiyoriy integratsiya" xatti-harakati.
- **Sentry o'chirilgan.** `SENTRY_DSN` bo'sh.
- **Demo ma'lumotlar.** Baza `seed.ts` demo tenant'i bilan to'ldirilgan
  ("Demo Savdo MChJ"). Real mijozga topshirishdan oldin toza baza +
  `bootstrap-owner.ts` kerak — demo hisoblar (`+998901110001..7`, hammasi
  bitta parol bilan, ichida OWNER ham bor) production'da qolmasin.
- **Umumiy origin.** Velto shu domendagi boshqa ilovalar (`/`, `/marketco`,
  `/autobuilder`, `/ide`) bilan bitta origin'ni bo'lishadi va ularda CSP yo'q.
  Ulardan birortasida XSS bo'lsa, u Velto'ning localStorage'idagi refresh
  tokeni va Mini App'ning IndexedDB shifrlash kalitiga yeta oladi, hamda
  httpOnly cookie bilan `/velto/api/*` ga so'rov yubora oladi. Yagona to'liq
  yechim — Velto'ni alohida subdomenga (masalan `velto.auto-message.uz`)
  ko'chirish. Yo'l prefiksi (`/velto`) ataylab tanlangan, shuning uchun bu
  hozircha qabul qilingan xavf.

## MinIO

Bucket: `velto-files`. Anonim siyosat FAQAT `s3:GetObject` (`deploy/minio-policy.json`).

⚠️ `mc anonymous set download` ISHLATMANG — u `s3:GetObject` bilan birga
`s3:ListBucket` ni ham beradi, ya'ni `GET /velto-files/?list-type=2` butun
kalitlar ro'yxatini qaytaradi va istalgan begona odam
`exports/1c/<companyId>/*` fayllarini sanab chiqa oladi. Bu bazadagi RLS
izolyatsiyasini obyekt qatlamida bekor qiladi. Siyosatni shunday o'rnating:

```bash
mc anonymous set-json deploy/minio-policy.json <alias>/velto-files
# tekshirish: ro'yxatlash 403, aniq obyekt 200 bo'lishi kerak
curl -o /dev/null -w '%{http_code}\n' 'https://auto-message.uz/velto-files/?list-type=2'   # 403
```

`StorageService` imzolanmagan (presigned emas) public URL qaytaradi —
`${S3_ENDPOINT}/${S3_BUCKET}/${key}` — shuning uchun obyektlar anonim o'qishga
ochiq bo'lishi shart, aks holda brauzerda mahsulot rasmlari 403 beradi.
Kalitlar `randomUUID()` asosida, ya'ni himoya "topib bo'lmaydigan URL"
darajasida: ro'yxatlash yopilgandan keyin ham 1C eksport faylining URL'ini
bilgan odam uni yuklab oladi. Real mijoz ma'lumotlaridan oldin
`storage.service.ts` ni presigned GET URL'ga (yoki autentifikatsiyalangan
yuklab olish endpoint'iga) o'tkazish kerak — bu deploy sozlamasi bilan
hal bo'lmaydi, kod o'zgarishi.

`S3_ENDPOINT` public manzil (`https://auto-message.uz`) bo'lishi shart, chunki
API yozish uchun ham, brauzer o'qish uchun ham AYNAN shu manzildan foydalanadi.
nginx `/velto-files/` yo'lini va `Host` sarlavhasini o'zgartirmaydi — SigV4
imzosi ikkalasi ustidan hisoblanadi, tegilsa MinIO 403 qaytaradi.

## Eski `/Velto` deploy'i

Bu manzilda ilgari boshqa kod bazasi (`/root/projects/Velto`, `velto_prod`
bazasi) turgan edi. U to'xtatilgan, lekin kodi ham, bazasi ham o'chirilmagan.
nginx `/Velto` va `/Velto/*` ni `/velto/` ga 301 bilan yo'naltiradi.
Qaytarish kerak bo'lsa: `/root/projects/Velto/deploy/ecosystem.config.js` va
`/etc/nginx/snippets/velto.conf.bak.*` zaxira nusxalari joyida.
