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

## Runtime requirements

- Node: 22 LTS, minimum 22.12 (`engines.node` = `>=22.12 <27`, `.nvmrc` = 22, CI = 22). Tekshirilgan: 22.23.4, 24.22.1, 26.12.1. Node < 21 da API ishga tushmaydi.
- ADR-059 pul aniqligi: `assertJsonSourceSupport()` (`json-number-guard.ts`, `bootstrap.ts`) `JSON.parse` reviver `context.source` ni sinab ko'radi; yo'q bo'lsa boot to'xtaydi (fail-closed).
- PM2 `pm2 start` qilgan shell'dagi `node` ni ishlatadi. Serverda `node -v` tekshiring (>=22.12) va `pm2 start` ni shu node bilan ishga tushiring; kerak bo'lsa ecosystem'da `interpreter: '/abs/path/to/node'` qo'ying (yo'li serverda tasdiqlanmagan, repo'da yozilmagan).
- Majburiy env (`apps/api/src/common/config/env.schema.ts`, default'siz): DATABASE_URL, DATABASE_SYSTEM_URL, REDIS_URL, JWT_ACCESS_SECRET (>=32), MFA_ENCRYPTION_KEY (base64, 32 bayt), S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET. Qiymatlar repo'da saqlanmaydi.

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
#    Parol buyruq satrida BO'LMASIN: PGPASSFILE (0600) + PGHOST/PGPORT/PGUSER (admin rol), URL-with-password emas.
# DIQQAT: skript current_database() ustida ishlaydi -> -d <ilova bazasi> (postgres EMAS); production: -v velto_env=production
psql -d <ilova_bazasi> -v ON_ERROR_STOP=1 -v velto_env=production -f packages/database/scripts/provision-roles.sql
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

## Pilot server prerequisites

- `gpg` o'rnatilgan (`gpg --version`); zaxira shifrlash shu bilan.
- Redis: `requirepass` bor, `appendonly yes`, `maxmemory-policy noeviction` (BullMQ kalitlari o'chirilmasligi uchun). `redis-cli CONFIG GET maxmemory-policy`.
- `pm2-logrotate` o'rnatilgan (`pm2 install pm2-logrotate`).
- PM2 Node >=22.12 <27 bilan ishlaydi: `pm2 describe velto-api` -> `node version`.
- Rol nomlari: `provision-roles.sql` standarti `velto_owner`/`velto_app`/`velto_system`. Bu hostda `velto_app_system` / `velto_app_owner` ishlatiladi (pastdagi "Postgres rollari" va runbook, `sed` bilan almashtirilgan nusxa) — README to'g'ri, repo skripti boshqa hostlar uchun.
- Zaxira (D-3, variant A): `deploy.sh` endi `backup.sh`ni CHAQIRMAYDI va `BACKUP_PASSPHRASE_FILE` TALAB QILMAYDI. Zaxirani root'ning `velto-backup.service` (soatlik timer) oladi: DB (`velto_backup` roli) + S3 obyektlar + offsite + tekshiruv, so'ng `/var/lib/velto-backup/status` (root:root 0644, katalog root:root 0755) attestatsiyasini atomik yozadi. `deploy.sh` (velto-deploy) uni tekshiradi: root egasi, g/o yozish yo'q, `result=ok`, yosh <= `VELTO_BACKUP_MAX_AGE_MIN` (60), arxivlar mavjud, o'lcham va ciphertext sha256 mos. Har qanday xato = deploy install/migrate'dan OLDIN to'xtaydi; avtomatik restore YO'Q. O'rnatish: `backup/velto-backup.{service,timer}.example`, `system/`.
- Nima uchun ciphertext'ni deploy guruhi o'qiy oladi (0640 root:velto-deploy): sha256 ni deploy O'ZI qayta hisoblaydi (status/sidecar'ga ishonmaydi: ular arxiv almashtirilgandan keyin ham mos qolishi mumkin). Arxiv AES256 bilan shifrlangan, passphrase deploy'da yo'q; katalog deploy uchun yozilmaydi (o'chira/almashtira olmaydi). O'qib bo'lmasa — gate YIQILADI (sidecar'ga fallback yo'q).
- Kunlik cron o'rniga soatlik timer (RPO <= 1 soat maqsadi): `backup/velto-backup.timer.example`. Tanlov/o'lchov: `docs/release/RPO-RTO-ASSESSMENT.md`.
- Offsite nusxa (alohida kredensiallar, put-only, versioning + Object Lock 30 kun): `backup/policies/README.md`, `backup/offsite-sync.sh` (ilova kaliti bilan ishlamaydi — tekshiradi).
- Restore sinovi: `deploy/backup/restore-drill.sh` (faqat lokal/staging).

## Foydalanuvchilar va kim nimani o'qiydi (D-2)

Rollar: `velto-deploy` (release), `velto` (PM2 runtime, imtiyozsiz), `root` (backup xizmati), `velto-monitor`. Provision namunasi: `deploy/system/` (`provision-users.sh.example`, `velto-deploy.sudoers`, `velto-tmpfiles.conf`, `pg_hba.velto_backup.example`). Hozirgi hostda hammasi root bilan ishlaydi — o'tish alohida, rejalashtirilgan o'zgarish (downtime + oldindan zaxira); jarayon nomlari va portlar (velto-api 3101 / web 3100 / miniapp 3102) O'ZGARMAYDI.

| Resurs | root (backup) | velto-deploy | velto (runtime) | velto-monitor |
|---|---|---|---|---|
| `/etc/velto/app.env` (DATABASE_URL, SYSTEM_URL, JWT, S3 app kaliti) | o'qiydi (faqat S3_ACCESS_KEY solishtirish) | fayl o'qiy olmaydi, LEKIN `ecosystem.config.js` (uning kodi) velto sifatida ishlaydi -> amalda runtime secret'larga yetadi (ishonchli rol, pastdagi "Residual risks") | o'qiydi (0600 velto) | YO'Q |
| `/etc/velto/migrate.env` (faqat DATABASE_MIGRATE_URL) | o'qiydi | o'qiydi (0640 root:velto-deploy), yozolmaydi | YO'Q | YO'Q |
| `/etc/velto/backup.env`, `backup.pass` (DB backup roli, S3 read-only, offsite put-only, passphrase) | o'qiydi | YO'Q | YO'Q | YO'Q |
| `/var/backups/velto/*.gpg` ciphertext | yozadi | o'qiydi (guruh, 0640), yozolmaydi | YO'Q | katalog ACL (faylsiz) |
| `/var/lib/velto-backup/status` | yozadi | o'qiydi (soxtalashtira olmaydi) | o'qiydi (0644) | o'qiydi |
| checkout (kod, build) | o'qiydi | yozadi (egasi) | o'qiydi, yozolmaydi | YO'Q |
| `apps/{web,miniapp}/.env.production.local` (faqat NEXT_PUBLIC_*) | - | yozadi/o'qiydi | o'qiydi (0640 velto-deploy:velto) | YO'Q |
| PM2 (`~velto/.pm2`) | - | faqat sudoers qoidasi orqali | egasi | YO'Q |
| sudo | - | FAQAT: `systemctl start velto-backup.service`; `sudo -u velto pm2 startOrReload <checkout>/deploy/ecosystem.config.js --update-env` va `pm2 save --force` | yo'q | yo'q |

Qarorlar: (1) runtime env checkout'dan tashqarida (`/etc/velto/app.env`, `ecosystem.config.js` avtomatik topadi; `VELTO_ENV_FILE` bilan almashtiriladi) — deploy fayl sifatida uni o'qiy olmaydi, lekin baribir ishonchli (3-band). (2) migratsiya `DATABASE_MIGRATE_URL`ni faqat `migrate.env`dan oladi (`deploy.sh` split rejimi; `DATABASE_URL`ga schema talabi uchun vaqtincha shu URL qo'yiladi, `directUrl` migrate'da ishlatiladi), runtime bu faylni o'qimaydi. (3) deploy = kod yetkazuvchi: `ecosystem.config.js` velto sifatida ishlaydi, shuning uchun velto-deploy runtime secret'lar (`app.env`) bilan ISHONCHLI rol (u baribir velto kodini yozadi, demak ularni o'qiy oladi); u backup secret'lariga (`backup.env`, passphrase, offsite kalit) ishonilMAGAN va yeta olmaydi. Himoya: velto-deploy SSH kaliti + MFA; kompromat velto -> deploy'ga o'tolmaydi (checkout velto uchun read-only). (4) `.env` parsing: `ecosystem.config.js` va `deploy.sh` bitta qoidadan foydalanadi (`deploy/env-file.js`): satr oxiridagi `# izoh` TAQIQ (xato beradi), `$`/backtick kengaytirilmaydi, bitta juft qo'shtirnoq olib tashlanadi. Regression: `deploy/tests/env-parse.test.sh`.
Tekshirilmagan (serverda sinash kerak): `pm2 startOrReload` sudo ostida `always_set_home` bilan; `.next/cache` ga velto yoza oladimi (Next image/ISR keshi, kod velto uchun read-only); `prisma generate` DATABASE_URL=owner URL bilan.

### Backup skriptlarini root nusxasiga o'rnatish (velto-deploy yoza oladigan checkout'dan EMAS)

velto-deploy checkout'ga yozadi; root uni to'g'ridan-to'g'ri nusxalasa, deploy foydalanuvchisi root kodini almashtira oladi. Faqat tekshirilgan manbadan o'rnating (root sifatida):

```bash
# variant A: imzolangan teg -> root'ning o'z katalogiga archive
git -C /srv/velto/app verify-tag <teg> && install -d -m 700 -o root -g root /root/velto-src \
  && git -C /srv/velto/app archive <teg> deploy | tar -x -C /root/velto-src
# variant B: diff -r bilan ko'rib chiqish (o'zgarishlarni o'qing), so'ng nusxalash
diff -r /srv/velto/app/deploy /opt/velto/deploy
install -d -m 755 -o root -g root /opt/velto /opt/velto/deploy /opt/velto/deploy/backup /opt/velto/deploy/monitoring
install -m 755 -o root -g root /root/velto-src/deploy/backup/*.sh /opt/velto/deploy/backup/
```

`/opt/velto` va ichidagi hamma narsa root:root, katalog 0755, fayl 0755 (yoki 0644 kutubxona), group/world-writable EMAS. `backup-run.sh` boshida o'z katalogi va source qilinadigan kutubxonalar uid 0 egaligida va g/o-yozilmaydigan ekanini tekshiradi, aks holda ishlamaydi. `BACKUP_ALERT_CMD` ham root egaligida va g/o-yozilmaydigan katalogda bo'lishi shart.

## Residual risks

- Backup gate (`verify-backup-status.sh`) xavfsizlik to'sig'i (xato/eskirgan zaxira bilan deploy'ni to'xtatadi), kompromat qilingan velto-deploy'ga qarshi nazorat EMAS: velto-deploy runtime secret'larga yetadi va `migrate.env` orqali `prisma migrate`ni gate'siz to'g'ridan-to'g'ri ishga tushira oladi.
- velto-deploy SSH kaliti va MFA himoyasi — asosiy nazorat; kalit kompromati = runtime secret'lar + sxema ustidan nazorat.

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

## MFA_ENCRYPTION_KEY (majburiy secret, ADR-058)

TOTP secret'larni AES-256-GCM bilan shifrlaydi; base64 formatda AYNAN 32 bayt.
Yo'q yoki noto'g'ri bo'lsa `velto-api` boot'da yiqiladi (env.schema.ts).
Faqat `.env.production.local` (chmod 600) da; gitga, logga, CI'ga doimiy qiymat qo'yilmaydi.

- Yaratish: `openssl rand -base64 32`
- Zaxira: kalitni parol menejerida saqlang (backup'dan alohida) — yo'qolsa barcha TOTP secret'lar o'qilmaydi, foydalanuvchilar MFA'ni qayta ro'yxatdan o'tkazadi.
- Rotatsiya: kalitni almashtirishdan oldin ma'lumotlarni `keyVersion` bo'yicha qayta shifrlash kerak (eski kalit bilan ochib, yangisi bilan yozish, `keyVersion` ni oshirish). Kalitni to'g'ridan-to'g'ri almashtirish mavjud yozuvlarni buzadi. Avval staging'da sinang.
- CI har run'da vaqtinchalik tasodifiy kalit yaratadi (`ci.yml`).

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
# PGPASSFILE (0600) + PGHOST/PGPORT/PGUSER sozlangan bo'lsin; parol argv'da bo'lmasin
pg_dump -d velto -Fc -f /root/velto-pre-roles-$(date +%Y%m%d-%H%M%S).dump
pg_dumpall --globals-only -f /root/velto-globals-$(date +%Y%m%d-%H%M%S).sql   # rollar/atributlar (superuser)
```

Dump hajmi/o'qilishini tekshiring (`pg_restore -l <dump> | head`).

### 2. Skript nusxasi (host nomlari bilan) va ishga tushirish

```bash
sed -e 's/velto_owner/velto_app_owner/g' -e 's/velto_system/velto_app_system/g' \
  packages/database/scripts/provision-roles.sql > /root/provision-roles.prod.sql
grep -c 'velto_system' /root/provision-roles.prod.sql   # 0 bo'lishi shart
psql -d <ilova_bazasi> -v ON_ERROR_STOP=1 -v velto_env=production -f /root/provision-roles.prod.sql
# parolni interaktiv o'rnating (argv/history'ga tushmaydi): psql -d postgres, so'ng  \password velto_app_owner
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
  Productionda telefon/kod hech qachon loglanmaydi; token yo'q bo'lsa parolni
  tiklash so'rovi 503 `SMS_NOT_CONFIGURED` qaytaradi. Qo'lda tiklash:
  `docs/release/ACCOUNT-RECOVERY-RUNBOOK.md`.
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

Bucket: `velto-files`. Anonim siyosat FAQAT `s3:GetObject` va FAQAT `products/*` prefiksi (mahsulot rasmlari) uchun (`deploy/minio-policy.json`); `exports/`, `imports/`, `opening/` anonim o'qilmaydi (403).

⚠️ `mc anonymous set download` ISHLATMANG — u `s3:GetObject` bilan birga
`s3:ListBucket` ni ham beradi, ya'ni `GET /velto-files/?list-type=2` butun
kalitlar ro'yxatini qaytaradi va istalgan begona odam
`exports/1c/<companyId>/*` fayllarini sanab chiqa oladi. Bu bazadagi RLS
izolyatsiyasini obyekt qatlamida bekor qiladi. Siyosatni shunday o'rnating:

```bash
mc anonymous set-json deploy/minio-policy.json <alias>/velto-files
# tekshirish: ro'yxatlash 403, products/* obyekti 200, exports/1c/* obyekti 403
curl -o /dev/null -w '%{http_code}\n' 'https://auto-message.uz/velto-files/?list-type=2'   # 403
curl -o /dev/null -w '%{http_code}\n' 'https://auto-message.uz/velto-files/products/<companyId>/<mavjud-rasm>'   # 200
curl -o /dev/null -w '%{http_code}\n' 'https://auto-message.uz/velto-files/exports/1c/<companyId>/<mavjud-fayl>'   # 403
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
