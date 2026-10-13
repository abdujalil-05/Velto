import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SyncEntity, withSavepoint } from '@velto/database';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { GENERIC_MESSAGES } from '../../common/filters/http-exception.filter';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CustomersService } from '../customers/customers.service';
import { CreatePaymentDto } from '../finance/dto/create-payment.dto';
import { PaymentsService } from '../finance/payments/payments.service';
import { CreateVisitDto } from '../field/visits/dto/create-visit.dto';
import { VisitsService } from '../field/visits/visits.service';
import { CreateOrderDto } from '../sales/dto/create-order.dto';
import { SalesService } from '../sales/sales.service';
import {
  SYNC_PUSH_HARD_MAX_BATCH,
  SyncDocType,
  type SyncLocalizedMessage,
  type SyncPushDocumentDto,
  type SyncPushResponse,
  type SyncPushResultItem,
} from './dto/sync-push.dto';
import { SYNC_PULL_DEFAULT_LIMIT, SYNC_PULL_MAX_LIMIT } from './dto/sync-pull.query';
import { ALL_SCOPE, decodeCursor, encodeCursor, scopeFingerprint } from './sync-cursor';
import { SyncBatchTooLargeException } from './sync-exceptions';
import { validatePayload } from './validate-payload';

export type {
  PriceChangedDetails,
  SyncDocStatus,
  SyncLocalizedMessage,
  SyncPushError,
  SyncPushResponse,
  SyncPushResultItem,
} from './dto/sync-push.dto';

/** TZ 10.3 default; overridable via SYNC_PUSH_MAX_BATCH (env.schema.ts). */
export const SYNC_PUSH_DEFAULT_MAX_BATCH = 20;

/** Mirrors env.schema.ts SYNC_PULL_LOOKBACK_SECONDS default. */
export const SYNC_PULL_DEFAULT_LOOKBACK_SECONDS = 60;

@Injectable()
export class SyncService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly sales: SalesService,
    private readonly payments: PaymentsService,
    private readonly visits: VisitsService,
    private readonly customers: CustomersService,
    private readonly config: ConfigService,
  ) {}

  /** Effective per-request document cap — validated by env.schema.ts at boot, re-clamped here defensively. */
  get maxBatch(): number {
    const raw = Number(this.config.get('SYNC_PUSH_MAX_BATCH') ?? SYNC_PUSH_DEFAULT_MAX_BATCH);
    return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, SYNC_PUSH_HARD_MAX_BATCH) : SYNC_PUSH_DEFAULT_MAX_BATCH;
  }

  /** Effective lookback in ms — validated by env.schema.ts at boot (>= 20s), re-clamped here defensively. */
  get pullLookbackMs(): number {
    const raw = Number(this.config.get('SYNC_PULL_LOOKBACK_SECONDS') ?? SYNC_PULL_DEFAULT_LOOKBACK_SECONDS);
    return (Number.isFinite(raw) && raw >= 1 ? raw : SYNC_PULL_DEFAULT_LOOKBACK_SECONDS) * 1000;
  }

  /**
   * 10.1/10.2 + F4: reference + state data for the offline client's Dexie
   * store, one flat array per table (`products`, `packagings`, `prices`,
   * `customers`, `outlets`, `stock`, `balances`, `categories`) plus
   * `tombstones[]`, `routes`/`routeStops` (full snapshot every page — a
   * handful of rows, and RoutesService hard-deletes replaced stops),
   * `defaultPriceListId` and, for a SALES_AGENT, `scope`.
   *
   * CURSOR = global `changeSeq` (DB sequence stamped by trigger; replaces the
   * app-clock `updatedAt > since`). Each call returns the next `limit` items
   * with changeSeq > cursor, merged across all tables in changeSeq order, so a
   * page boundary never splits the order. `hasMore=true` -> call again with
   * the returned cursor. No cursor / unparsable cursor / changed agent scope
   * -> restart from 0 and `fullResync: true`.
   *
   * COMMIT-ORDER SAFETY (nextval order != commit order): a transaction can take
   * seq 100, a second one seq 101 and commit first; a pull that saw 101 and
   * advanced its cursor to 101 would never see 100. Chosen fix: a time-bounded
   * lookback (re-send window; the client applies idempotently — upsert by id,
   * delete by tombstone). A terminal page (hasMore=false) does NOT return the
   * max seq it saw but S0 = the highest changeSeq among rows whose
   * updatedAt/deletedAt is <= (sessionStart - lookback). Proof sketch: any row
   * X with seq < S0 was allocated before S0's row R, i.e. no later than R's
   * time + one request transaction (<= 5s, Prisma default timeout) and commits
   * within another 5s; with lookback >= 20s (env min; default 60s, covering
   * app/DB clock skew too) X committed before the session's first page read
   * (sessionStart; carried in mid-session cursors so a slow multi-page session
   * cannot jump past rows that committed between its pages), hence X was
   * visible to every page and is not lost. Rows younger than the window have
   * seq > S0 and are simply re-sent until they age out. Alternative
   * (pg_snapshot_xmin) rejected: it bounds txids, not the sequence values the
   * in-flight transactions hold, and xid assignment happens after the BEFORE
   * trigger's nextval — a provable bound needs a DB-side change.
   *
   * TOMBSTONES (SyncTombstone, trigger-written on DELETE, soft-delete and
   * isActive true->false): sent with the same cursor. Product/Customer/Outlet
   * rows that are inactive or soft-deleted are never sent as rows. Apply
   * tombstones first, then items: a re-created/reactivated row always has a
   * higher seq than its tombstone, so it wins.
   *
   * AGENT SCOPE (TZ 8.2 minimum data): a SALES_AGENT gets only outlets on
   * their own routes' stops and those outlets' customers; other roles keep the
   * tenant-wide scope. Changing a route does not touch Outlet/Customer rows (no
   * changeSeq bump), so: `scope = { customerIds, outletIds }` (the complete
   * current visible id lists) is returned on every page — the device drops any
   * local customer/outlet not in it — and the cursor carries a fingerprint of
   * that scope; if it differs from the client's, the pull restarts as a
   * `fullResync` so newly-scoped rows (old changeSeq) are delivered. Customer/
   * Outlet tombstones are not sent to agents (scope covers removal; also avoids
   * leaking ids of out-of-scope rows). `scope` is null for non-agents.
   */
  async pull(
    params: { cursor?: string; limit?: number; agentId?: string },
    user: AuthenticatedUser,
  ) {
    const tx = this.tenantPrisma.client;
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? SYNC_PULL_DEFAULT_LIMIT) || SYNC_PULL_DEFAULT_LIMIT, 1), SYNC_PULL_MAX_LIMIT);
    const take = limit + 1;
    const isAgent = user.roles.includes('SALES_AGENT');
    const agentId = isAgent ? user.id : params.agentId;

    const routes = agentId ? await tx.route.findMany({ where: { agentId } }) : [];
    const routeStops = routes.length
      ? await tx.routeStop.findMany({ where: { routeId: { in: routes.map((r) => r.id) } }, orderBy: { sortOrder: 'asc' } })
      : [];

    let scope: { customerIds: string[]; outletIds: string[] } | null = null;
    if (isAgent) {
      const stopOutletIds = [...new Set(routeStops.map((st) => st.outletId))];
      const outlets = stopOutletIds.length
        ? await tx.outlet.findMany({ where: { id: { in: stopOutletIds }, deletedAt: null, isActive: true }, select: { id: true, customerId: true } })
        : [];
      const customers = outlets.length
        ? await tx.customer.findMany({
            where: { id: { in: [...new Set(outlets.map((o) => o.customerId))] }, deletedAt: null, isActive: true },
            select: { id: true },
          })
        : [];
      const customerSet = new Set(customers.map((c) => c.id));
      scope = { customerIds: [...customerSet], outletIds: outlets.filter((o) => customerSet.has(o.customerId)).map((o) => o.id) };
    }
    const fingerprint = scope ? scopeFingerprint(scope.outletIds, scope.customerIds) : ALL_SCOPE;

    const decoded = decodeCursor(params.cursor);
    const fullResync = decoded === null || decoded.f !== fingerprint;
    const s = fullResync ? 0n : decoded.s;
    const now = Date.now();
    const sessionStart = !fullResync && decoded?.t !== undefined && decoded.t <= now ? decoded.t : now;

    const gt = { gt: s };
    const orderBy = { changeSeq: 'asc' as const };
    const liveWhere = { deletedAt: null, isActive: true };
    const [products, packagings, prices, customers, outlets, stock, categories, tombstones, defaultPriceList] = await Promise.all([
      tx.product.findMany({ where: { changeSeq: gt, ...liveWhere }, orderBy, take }),
      tx.productPackaging.findMany({ where: { changeSeq: gt, product: liveWhere }, orderBy, take }),
      tx.priceListItem.findMany({ where: { changeSeq: gt }, orderBy, take }),
      tx.customer.findMany({ where: { changeSeq: gt, ...liveWhere, ...(scope && { id: { in: scope.customerIds } }) }, orderBy, take }),
      tx.outlet.findMany({ where: { changeSeq: gt, ...liveWhere, ...(scope && { id: { in: scope.outletIds } }) }, orderBy, take }),
      tx.stockLevel.findMany({ where: { changeSeq: gt }, orderBy, take }),
      // Order screen category filter (9.4 Ekran 4).
      tx.productCategory.findMany({ where: { changeSeq: gt }, orderBy, take }),
      tx.syncTombstone.findMany({
        where: { changeSeq: gt, ...(scope && { entity: { notIn: [SyncEntity.Customer, SyncEntity.Outlet] } }) },
        orderBy,
        take,
      }),
      // 8.1: SalesService.create()'s fallback price list — a single id, sent every page.
      tx.priceList.findFirst({ where: { isDefault: true } }),
    ]);

    // Merge all sources by the global seq (unique across tables) and cut at `limit`.
    const tagged: Array<{ seq: bigint; key: string }> = [];
    const tag = (kind: string, rows: Array<{ changeSeq: bigint }>) => rows.forEach((r, i) => tagged.push({ seq: r.changeSeq, key: `${kind}:${i}` }));
    tag('products', products);
    tag('packagings', packagings);
    tag('prices', prices);
    tag('customers', customers);
    tag('outlets', outlets);
    tag('stock', stock);
    tag('categories', categories);
    tag('tombstones', tombstones);
    tagged.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
    const hasMore = tagged.length > limit;
    const page = tagged.slice(0, limit);
    const kept = new Set(page.map((p) => p.key));
    const pick = <T>(kind: string, rows: T[]): T[] => rows.filter((_, i) => kept.has(`${kind}:${i}`));

    const pageCustomers = pick('customers', customers);
    // Customer.cachedBalance already carries the up-to-date figure (6.7).
    const balances = pageCustomers.map((c) => ({ customerId: c.id, balance: c.cachedBalance, updatedAt: c.updatedAt }));

    const cursor = hasMore
      ? encodeCursor({ s: page[page.length - 1]!.seq, f: fingerprint, t: sessionStart })
      : encodeCursor({ s: await this.stableSeq(sessionStart - this.pullLookbackMs), f: fingerprint });

    return {
      cursor,
      hasMore,
      fullResync,
      products: pick('products', products),
      packagings: pick('packagings', packagings),
      prices: pick('prices', prices),
      customers: pageCustomers,
      outlets: pick('outlets', outlets),
      stock: pick('stock', stock),
      categories: pick('categories', categories),
      balances,
      tombstones: pick('tombstones', tombstones).map((t) => ({
        entity: t.entity,
        entityId: t.entityId,
        entityKey: t.entityKey,
        deletedAt: t.deletedAt,
        changeSeq: t.changeSeq,
      })),
      routes,
      routeStops,
      defaultPriceListId: defaultPriceList?.id ?? null,
      scope,
    };
  }

  /** Highest changeSeq (any synced table or tombstone) last written at or before `cutoffMs`; 0 when none. See pull(). */
  private async stableSeq(cutoffMs: number): Promise<bigint> {
    const tx = this.tenantPrisma.client;
    const cutoff = new Date(cutoffMs);
    const where = { updatedAt: { lte: cutoff } };
    const args = { orderBy: { changeSeq: 'desc' as const }, select: { changeSeq: true } };
    const found = await Promise.all([
      tx.product.findFirst({ where, ...args }),
      tx.productPackaging.findFirst({ where, ...args }),
      tx.priceListItem.findFirst({ where, ...args }),
      tx.customer.findFirst({ where, ...args }),
      tx.outlet.findFirst({ where, ...args }),
      tx.stockLevel.findFirst({ where, ...args }),
      tx.productCategory.findFirst({ where, ...args }),
      tx.syncTombstone.findFirst({ where: { deletedAt: { lte: cutoff } }, ...args }),
    ]);
    return found.reduce((max, r) => (r && r.changeSeq > max ? r.changeSeq : max), 0n);
  }

  /**
   * 10.3: processes up to `maxBatch` (SYNC_PUSH_MAX_BATCH, default 20) queued
   * offline documents (order/visit/payment), each independently, returning a
   * per-document outcome (ACCEPTED | DUPLICATE | REJECTED | CONFLICT | RETRY)
   * so the client's queue can resolve, retry, or surface each one on its own
   * — one document's failure never blocks or rolls back the others.
   */
  async push(documents: SyncPushDocumentDto[], user: AuthenticatedUser): Promise<SyncPushResponse> {
    const max = this.maxBatch;
    if (documents.length > max) throw new SyncBatchTooLargeException(max, documents.length);

    await this.lockBatchCustomers(documents);
    const results: SyncPushResultItem[] = [];
    for (const doc of documents) {
      results.push(await this.pushOne(doc, user));
    }
    return { results };
  }

  /**
   * The whole batch shares one request transaction, and PaymentsService.create()
   * takes a Customer FOR UPDATE per document that is held to commit. Two
   * batches touching the same customers in opposite order (A→B vs B→A) would
   * deadlock (40P01) and fail both batches. Locking every customer the batch
   * references up front, in one global order (id asc), makes the per-document
   * locks re-entrant no-ops and the lock graph acyclic. Plain lockForUpdate
   * (no deletedAt check): a missing/deleted customer must not fail the batch —
   * each document still gets its own CustomerNotFound via lockActiveOrThrow.
   * Payloads are unvalidated here, so only well-formed UUIDs are considered
   * (a bad ::uuid cast would abort the whole transaction).
   */
  private async lockBatchCustomers(documents: SyncPushDocumentDto[]): Promise<void> {
    const ids = new Set<string>();
    for (const doc of documents) {
      if (doc.type !== SyncDocType.PAYMENT && doc.type !== SyncDocType.ORDER) continue;
      const customerId = (doc.payload as Record<string, unknown> | undefined)?.customerId;
      if (typeof customerId === 'string' && UUID_RE.test(customerId)) ids.add(customerId.toLowerCase());
    }
    const tx = this.tenantPrisma.client;
    for (const id of [...ids].sort()) {
      await this.customers.lockForUpdate(tx, id);
    }
  }

  private async pushOne(doc: SyncPushDocumentDto, user: AuthenticatedUser): Promise<SyncPushResultItem> {
    const tx = this.tenantPrisma.client;

    try {
      // One SAVEPOINT per document, so "each independently" (see push()'s
      // doc) actually holds: the whole batch shares the single request
      // transaction opened by TenantContextInterceptor. Without it, a
      // rejected document keeps whatever it wrote before failing — e.g.
      // PaymentsService.create() inserts the Payment row *before* allocating
      // it, so an AllocationExceedsInvoiceException would still commit an
      // orphan payment (and burn that clientId, which every later retry then
      // resolves to) alongside the rest of the batch. A document that fails
      // on a DB error would additionally leave the transaction aborted
      // (25P02) and take every later document in the batch down with it.
      // CONFLICT (PRICE_CHANGED) is thrown before any write or SO number is
      // consumed, and the rollback discards anything else regardless.
      return await withSavepoint(tx, 'sync_push_doc', async () => {
        switch (doc.type) {
          case SyncDocType.ORDER: {
            // createWithOutcome() reports whether *this* call inserted the
            // order, so DUPLICATE is exact even when a concurrent push of the
            // same clientId wins the unique-index race (10.4).
            const dto = await validatePayload(CreateOrderDto, { ...doc.payload, clientId: doc.clientId });
            const { order, created } = await this.sales.createWithOutcome(dto, user);
            return { clientId: doc.clientId, id: order.id, status: created ? 'ACCEPTED' : 'DUPLICATE' };
          }
          case SyncDocType.VISIT: {
            const alreadyExisted = (await tx.visit.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: doc.clientId } } })) !== null;
            const dto = await validatePayload(CreateVisitDto, { ...doc.payload, clientId: doc.clientId });
            const visit = await this.visits.create(dto, user);
            return {
              clientId: doc.clientId,
              id: visit.id,
              status: alreadyExisted ? 'DUPLICATE' : 'ACCEPTED',
              gpsStatus: visit.gpsStatus,
              distanceM: visit.distanceM?.toString() ?? null,
            };
          }
          case SyncDocType.PAYMENT: {
            const alreadyExisted = (await tx.payment.findUnique({ where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: doc.clientId } } })) !== null;
            const dto = await validatePayload(CreatePaymentDto, { ...doc.payload, clientId: doc.clientId });
            const payment = await this.payments.create(dto, user);
            return { clientId: doc.clientId, id: payment.id, status: alreadyExisted ? 'DUPLICATE' : 'ACCEPTED' };
          }
        }
        // Unreachable — `type` is already constrained to SyncDocType by
        // @IsEnum on the DTO — but satisfies the compiler's control-flow
        // analysis for the declared return type.
        throw new Error(`Unknown sync document type: ${doc.type as string}`);
      });
    } catch (error) {
      return this.toFailureResult(doc, error);
    }
  }

  /**
   * Maps a failed document to its result status. Runs after the document's
   * savepoint was rolled back, so the shared transaction is usable again:
   * - P2002 (clientId unique race lost to a concurrent push) → DUPLICATE with
   *   the winner's id; if no such doc exists the violation was something
   *   else → RETRY.
   * - AppException PRICE_CHANGED → CONFLICT (user must re-confirm).
   * - other 4xx HttpException (validation, blocked customer, permission) →
   *   REJECTED with its stable code + trilingual message.
   * - numeric overflow (22001/22003) → REJECTED: deterministic, retrying
   *   would never succeed.
   * - serialization/deadlock/lock-timeout (40001/40P01/55P03), 5xx and any
   *   unexpected/infra error → RETRY. Safest default: the client keeps the
   *   document PENDING instead of dropping data on an error we can't classify.
   */
  private async toFailureResult(doc: SyncPushDocumentDto, error: unknown): Promise<SyncPushResultItem> {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await this.findExistingByClientId(doc).catch(() => null);
      if (existing) return { ...existing, clientId: doc.clientId, status: 'DUPLICATE' };
      return retryResult(doc, error);
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return retryResult(doc, error);
      const detail = toErrorDetail(error);
      return { clientId: doc.clientId, status: detail.code === PRICE_CHANGED ? 'CONFLICT' : 'REJECTED', error: detail };
    }

    if (DETERMINISTIC_SQLSTATES.has(sqlStateOf(error) ?? '')) {
      return {
        clientId: doc.clientId,
        status: 'REJECTED',
        error: { code: 'NUMERIC_OUT_OF_RANGE', message: NUMERIC_OUT_OF_RANGE_MESSAGE.uz, messages: NUMERIC_OUT_OF_RANGE_MESSAGE },
      };
    }

    return retryResult(doc, error);
  }

  private async findExistingByClientId(doc: SyncPushDocumentDto): Promise<Omit<SyncPushResultItem, 'clientId' | 'status'> | null> {
    const tx = this.tenantPrisma.client;
    const where = { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: doc.clientId } };
    switch (doc.type) {
      case SyncDocType.ORDER: {
        const order = await tx.salesOrder.findUnique({ where, select: { id: true } });
        return order ? { id: order.id } : null;
      }
      case SyncDocType.VISIT: {
        const visit = await tx.visit.findUnique({ where, select: { id: true, gpsStatus: true, distanceM: true } });
        return visit ? { id: visit.id, gpsStatus: visit.gpsStatus, distanceM: visit.distanceM?.toString() ?? null } : null;
      }
      case SyncDocType.PAYMENT: {
        const payment = await tx.payment.findUnique({ where, select: { id: true } });
        return payment ? { id: payment.id } : null;
      }
    }
    return null;
  }
}

const logger = new Logger('SyncService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PRICE_CHANGED = 'PRICE_CHANGED';

/** Postgres errors that will fail identically on every retry (22001 value too long, 22003 numeric out of range). */
const DETERMINISTIC_SQLSTATES = new Set(['22001', '22003']);
/** Prisma's own codes for the same two conditions. */
const DETERMINISTIC_PRISMA_CODES: Record<string, string> = { P2000: '22001', P2020: '22003' };

const NUMERIC_OUT_OF_RANGE_MESSAGE: SyncLocalizedMessage = {
  uz: "Raqamli qiymat ruxsat etilgan chegaradan tashqarida",
  ru: 'Числовое значение вне допустимого диапазона',
  en: 'Numeric value out of range',
};

const RETRY_MESSAGE: SyncLocalizedMessage = {
  uz: "Vaqtinchalik server xatoligi — hujjat keyinroq qayta yuboriladi",
  ru: 'Временная ошибка сервера — документ будет отправлен повторно позже',
  en: 'Temporary server error — the document will be retried later',
};

/** Best-effort SQLSTATE of a Prisma/pg error (raw-query P2010 carries it in meta.code). */
function sqlStateOf(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const metaCode = (error.meta as { code?: unknown } | undefined)?.code;
    if (typeof metaCode === 'string' && /^[0-9A-Z]{5}$/.test(metaCode)) return metaCode;
    return DETERMINISTIC_PRISMA_CODES[error.code];
  }
  return undefined;
}

function retryResult(doc: SyncPushDocumentDto, error: unknown): SyncPushResultItem {
  // SEC-045: the raw error (table/column names) is logged, never returned.
  logger.warn(`sync push ${doc.type} ${doc.clientId} → RETRY: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return { clientId: doc.clientId, status: 'RETRY', error: { code: 'SYNC_RETRY', message: RETRY_MESSAGE.uz, messages: RETRY_MESSAGE } };
}

// SEC-045: only HttpExceptions carry client-safe copy (matches
// AllExceptionsFilter's policy, which this per-document try/catch bypasses).
function toErrorDetail(error: HttpException): NonNullable<SyncPushResultItem['error']> {
  const body = error.getResponse();
  if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
    const { code, message, details } = body as { code: string; message: SyncLocalizedMessage | string; details?: unknown };
    if (typeof message === 'string') return { code, message, ...(details !== undefined && { details }) };
    return { code, message: message.uz, messages: message, ...(details !== undefined && { details }) };
  }
  // Plain Nest HttpException (e.g. ForbiddenException) — same generic
  // HTTP_<status> code + trilingual copy AllExceptionsFilter would send.
  const status = error.getStatus();
  const messages = GENERIC_MESSAGES[status] ?? GENERIC_MESSAGES[HttpStatus.BAD_REQUEST]!;
  return { code: `HTTP_${status}`, message: messages.uz, messages };
}
