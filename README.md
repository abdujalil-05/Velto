# Velto

O'zbekiston distribyutor kompaniyalari uchun savdo operatsiyalari va distribyutsiya boshqaruv platformasi.

Velto savdo agenti, direktor, ombor, kassa va buxgalteriyani bitta oqimga bog'laydi:

**Mijoz/nuqta → tashrif → buyurtma → tasdiqlash → ombor chiqimi → faktura → to'lov taqsimoti (FIFO) → qarzdorlik va hisobot → 1C eksporti**

Velto 1C yoki boshqa buxgalteriya tizimini almashtirmaydi. U mavjud tizim bilan yonma-yon ishlaydigan dala savdosi va distribyutsiya qatlami.

## Imkoniyatlar (MVP v1.0)

- **Mijozlar va nuqtalar:** agentga biriktirish, dublikat ogohlantirishi, bloklash
- **Katalog va narxlar:** SKU, qadoq, narx ro'yxatlari, sozlanadigan QQS
- **Ombor:** qoldiq, rezerv, kirim/chiqim, harakatlar jurnali (append-only)
- **Sotuv:** buyurtma holatlari, narx snapshot'i, faktura, hujjat raqamlash
- **To'lov va qarzdorlik:** qisman to'lov, FIFO, avans, aging, kassa smenasi, reversal
- **Dala savdosi:** marshrut, tashrif, GPS tekshiruvi (server tomonda)
- **Offline Mini App:** Telegram orqali, lokal navbat va idempotent sinxronizatsiya
- **Hisobotlar va eksport:** dashboard, CSV/XLSX, 1C eksporti
- **Xavfsizlik:** RBAC, audit log, PostgreSQL RLS orqali tenant izolyatsiyasi
- **Til:** uz (lotin), ru, en

## Tuzilma

Turborepo + pnpm monorepo.

```
apps/
  api/        NestJS 10 backend (BullMQ navbatlari shu jarayon ichida)
  web/        Next.js 15 — owner/director/ombor/kassir/buxgalter interfeysi
  miniapp/    Next.js 15 — savdo agentlari uchun Telegram Mini App (offline-first)
packages/
  database/   Prisma sxema, migratsiyalar, tenant-aware klient, seed/bootstrap
deploy/       nginx, PM2, MinIO siyosati, deploy.sh
docs/         VELTO-TZ-v4.0.md — texnik topshiriq (asosiy manba)
.claude/      Claude Code subagentlari va skill'lari
```

Backend modullari (`apps/api/src/modules`): `auth`, `users`, `customers`, `catalog`, `stock`, `sales`, `finance`, `field`, `import`, `integrations`, `notifications`, `analytics`, `audit`, `settings`, `sync`.

## Texnologiyalar

Node.js 22 · pnpm 11 · TypeScript 5.9 · NestJS 10 · Next.js 15 · Prisma · PostgreSQL 16 (RLS) · Redis 7 · BullMQ · MinIO (S3) · Dexie/IndexedDB · next-intl · TanStack Query · Vitest

## Ishga tushirish

Talab: Node.js ≥ 22, pnpm, Docker.

```bash
pnpm install
cp .env.example .env
docker-compose up -d        # host ports: postgres:5433 (container 5432), redis:6380 (container 6379), minio:9000/9001

# Har bir baza uchun bir marta, Postgres superuser sifatida (ilova roli emas).
# Login va fon ishlar uchun BYPASSRLS `velto_system` rolini yaratadi.
psql "$DATABASE_URL" -f packages/database/scripts/provision-roles.sql

pnpm db:migrate             # prisma migrate dev
pnpm db:seed                # demo tenant "Demo Distribution" (production'da ishlamaydi)
pnpm dev                    # barcha ilovalar
```

| Ilova | Port (o'zgaruvchi) | Standart |
|---|---|---|
| API | `API_PORT` | 3001 |
| Web | `WEB_PORT` | 3000 |
| Mini App | `MINIAPP_PORT` | 3002 |

Muhit o'zgaruvchilari ishga tushishda zod bilan tekshiriladi (`apps/api/src/common/config/env.schema.ts`); noto'g'ri yoki yetishmayotgan qiymat darrov xato beradi.

Faqat Owner'li toza tenant yaratish (parol bir marta stdout'ga chiqadi):

```bash
pnpm --filter @velto/database exec tsx src/bootstrap-owner.ts [companyName] [ownerPhone] [firstName] [lastName]
```

## Buyruqlar

```bash
pnpm build        # barcha workspace'larni yig'ish
pnpm lint
pnpm typecheck
pnpm test         # ishlayotgan Postgres + Redis kerak

# Bitta test fayli
pnpm --filter @velto/api exec vitest run src/modules/sales/sales.service.test.ts
pnpm --filter @velto/database exec vitest run src/__tests__/tenant-isolation.test.ts
```

Testlarning ko'pi mock'siz, RLS yoqilgan haqiqiy Postgres'ga qarshi integratsiya testlari. CI tartibi (`.github/workflows/ci.yml`): install → `prisma generate` → `migrate deploy` → provision-roles.sql → lint → typecheck → test → `pnpm audit --prod` → build, alohida Semgrep SAST ishi bilan.

## Arxitektura qisqacha

- **Multi-tenancy bazada:** har bir tenant jadvalida RLS va `FORCE ROW LEVEL SECURITY`. Kod `withTenant(companyId, fn)` orqali ishlaydi; u tashqarisida so'rov nol qator qaytaradi (xavfsiz yopiladi). API'da `TenantPrismaService` ishlatiladi.
- **Auth:** `JwtAuthGuard` (imzo tekshiruvi) → `TenantContextInterceptor` (tranzaksiyani ochadi, rol/ruxsatlarni har so'rovda bazadan o'qiydi, `@RequirePermission` tekshiradi).
- **Xatolar:** `AppException` → `{ code, message: { uz, ru, en }, details? }`.
- **Pul va miqdor:** `Decimal` (`Float` hech qachon). `StockMovement`, `Payment`, `AuditLog` faqat qo'shiladi, o'zgartirilmaydi.
- **Offline:** Mini App'da Dexie + har qator uchun AES-GCM, lokal navbat, `/sync/pull` va `/sync/push`.

Batafsil: [`CLAUDE.md`](./CLAUDE.md) va [`docs/VELTO-TZ-v4.0.md`](./docs/VELTO-TZ-v4.0.md).

## Deploy

Production bitta domen ostida, nginx orqali (`/velto/`, `/velto/api/`, `/velto/app/`). Portlar 31xx oralig'ida: web `3100`, API `3101`, Mini App `3102`. Batafsil qo'llanma: [`deploy/README.md`](./deploy/README.md).

## Hujjatlar va Claude Code

- Texnik topshiriq: `docs/VELTO-TZ-v4.0.md` (hajmi katta — `grep -n '^#'` bilan bo'limni toping)
- Claude Code uchun qoidalar va subagent jadvali: `CLAUDE.md`
- Subagentlar `.claude/agents/`, ularning skill'lari `.claude/skills/velto-*`

## Litsenziya

Xususiy (private). Barcha huquqlar himoyalangan.
