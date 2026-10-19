import { HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { assertClientIdReplayAllowed } from '../../common/idempotency/client-id-replay';
import { ClientIdConflictException } from '../../common/errors/client-id-conflict.exception';
import { ConfigService } from '@nestjs/config';
import { Prisma, SyncEntity, type TenantClient } from '@velto/database';
import { AuditLogService } from '../../common/audit/audit-log.service';
import { PermissionDeniedException } from '../../common/auth/auth-exceptions';
import { loadAuthenticatedUser } from '../../common/auth/load-authenticated-user';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { GENERIC_MESSAGES } from '../../common/filters/http-exception.filter';
import { TenantContext } from '../../common/tenant/tenant-context';
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

/** @RequirePermission of POST /sync/push; re-checked per document (§8.4). */
export const SYNC_PUSH_PERMISSION = 'field.create';

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
    private readonly auditLog: AuditLogService = new AuditLogService(),
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
   *
   * F7 (route is @TenantTx({ scope: 'handler' })): no request-wide tx. EACH
   * document runs in its OWN short tenantPrisma.run() tx (5 s default, not
   * raised), so its Customer / StockLevel / DocumentCounter locks are released
   * at its own COMMIT and a concurrent POST /orders waits for at most one
   * document, never the whole batch. One document = one customer + one
   * counter, so the in-tx lock order of DocumentNumberingService (advisory ->
   * header -> Customer -> StockLevel -> DocumentCounter -> INSERT) holds per
   * document and no batch-level customer pre-lock / savepoint is needed.
   * Processing order = counter docType asc (VISIT: none, then PAY, then SO),
   * stable within a type; results are returned in input order. Documents of
   * one batch never read each other's rows (an order is SUBMITTED with no
   * invoice, an agent payment is PENDING_HANDOVER without allocation).
   */
  async push(documents: SyncPushDocumentDto[], user: AuthenticatedUser): Promise<SyncPushResponse> {
    const max = this.maxBatch;
    if (documents.length > max) throw new SyncBatchTooLargeException(max, documents.length);

    const results: SyncPushResultItem[] = new Array(documents.length);
    const order = documents.map((doc, i) => ({ doc, i })).sort((a, b) => PROCESS_RANK[a.doc.type] - PROCESS_RANK[b.doc.type] || a.i - b.i);
    let revoked: Revocation | undefined;
    for (const { doc, i } of order) {
      if (revoked) {
        // Access lost mid-batch: same outcome for the rest, no further tx / audit spam.
        results[i] = revocationResult(doc, revoked);
        continue;
      }
      const outcome = await this.pushOne(doc, user);
      results[i] = outcome.item;
      revoked = outcome.revoked;
    }
    return { results };
  }

  /**
   * One document = one tenant tx. §8.4: the user's isActive / roles /
   * permissions are re-read by PK at the start of every document's tx, so a
   * deactivation or role removal committed mid-batch applies to the next
   * document: no permission -> REJECTED PERMISSION_DENIED + audit (what the
   * request-level 403 gives); user or company deactivated (same rule as
   * TenantContextInterceptor's 401) -> REJECTED HTTP_401. Audit rows written by the
   * services commit with the document. The result is captured inside the tx;
   * an afterCommit callback failing after COMMIT is only logged and never
   * turns a committed document into RETRY.
   */
  private async pushOne(doc: SyncPushDocumentDto, user: AuthenticatedUser): Promise<{ item: SyncPushResultItem; revoked?: Revocation }> {
    let item: SyncPushResultItem | undefined;
    let revoked: Revocation | undefined;
    let committed = false;
    try {
      await this.tenantPrisma.run(user.companyId, async (tx) => {
        // Callbacks run only after COMMIT and all run even if another throws.
        TenantContext.afterCommit(() => {
          committed = true;
        });
        const actor = await loadAuthenticatedUser(tx, user.id, user.companyId);
        if (!actor) {
          revoked = 'INACTIVE';
          item = revocationResult(doc, revoked);
          return;
        }
        if (!actor.permissions.includes(SYNC_PUSH_PERMISSION)) {
          await this.auditLog.log(tx, {
            companyId: user.companyId,
            userId: actor.id,
            action: 'auth.permission_denied',
            entity: 'User',
            entityId: actor.id,
            newValue: { permission: SYNC_PUSH_PERMISSION, method: 'POST', path: '/sync/push', clientId: doc.clientId },
          });
          revoked = 'DENIED';
          item = revocationResult(doc, revoked);
          return;
        }
        item = await this.applyDocument(tx, doc, actor);
      });
      return { item: item!, revoked };
    } catch (error) {
      if (committed && item) {
        logger.error(`sync push ${doc.type} ${doc.clientId}: committed, afterCommit side effect failed (${error instanceof Error ? error.name : 'error'})`);
        return { item, revoked };
      }
      return { item: await this.toFailureResult(doc, error, user) };
    }
  }

  private async applyDocument(tx: TenantClient, doc: SyncPushDocumentDto, user: AuthenticatedUser): Promise<SyncPushResultItem> {
    const byClientId = { companyId_clientId: { companyId: user.companyId, clientId: doc.clientId } };
    switch (doc.type) {
      case SyncDocType.ORDER: {
        // createWithOutcome() reports whether *this* call inserted the
        // order, so DUPLICATE is exact even when a concurrent push of the
        // same clientId wins the unique-index race (10.4). CONFLICT
        // (PRICE_CHANGED) is thrown before any write or SO number is used.
        const dto = await validatePayload(CreateOrderDto, { ...doc.payload, clientId: doc.clientId });
        const { order, created } = await this.sales.createWithOutcome(dto, user);
        return { clientId: doc.clientId, id: order.id, status: created ? 'ACCEPTED' : 'DUPLICATE' };
      }
      case SyncDocType.VISIT: {
        const alreadyExisted = (await tx.visit.findUnique({ where: byClientId, select: { id: true } })) !== null;
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
        const alreadyExisted = (await tx.payment.findUnique({ where: byClientId, select: { id: true } })) !== null;
        const dto = await validatePayload(CreatePaymentDto, { ...doc.payload, clientId: doc.clientId });
        const payment = await this.payments.create(dto, user);
        // ADR-029: any agent payment (CASH/CARD/TRANSFER) is ACKed as PENDING_HANDOVER ("yo'lda"), not settled.
        return { clientId: doc.clientId, id: payment.id, status: alreadyExisted ? 'DUPLICATE' : 'ACCEPTED', paymentStatus: payment.status };
      }
    }
    // Unreachable — `type` is already constrained to SyncDocType by @IsEnum
    // on the DTO — but satisfies the compiler's control-flow analysis.
    throw new Error(`Unknown sync document type: ${doc.type as string}`);
  }

  /**
   * Maps a failed document to its result status. Runs after the document's
   * own tx was rolled back; any DB lookup here opens a NEW short tx:
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
  private async toFailureResult(doc: SyncPushDocumentDto, error: unknown, user: AuthenticatedUser): Promise<SyncPushResultItem> {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await this.tenantPrisma
        .run(user.companyId, () => this.findExistingByClientId(doc, user))
        .catch((e: unknown) => (e instanceof ClientIdConflictException ? e : null));
      if (existing instanceof ClientIdConflictException) return { clientId: doc.clientId, status: 'REJECTED', error: toErrorDetail(existing) };
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

  private async findExistingByClientId(doc: SyncPushDocumentDto, user: AuthenticatedUser): Promise<Omit<SyncPushResultItem, 'clientId' | 'status'> | null> {
    const tx = this.tenantPrisma.client;
    const where = { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId: doc.clientId } };
    switch (doc.type) {
      case SyncDocType.ORDER: {
        const order = await tx.salesOrder.findUnique({ where, select: { id: true, agentId: true } });
        if (order) assertClientIdReplayAllowed(order.agentId, user);
        return order ? { id: order.id } : null;
      }
      case SyncDocType.VISIT: {
        const visit = await tx.visit.findUnique({ where, select: { id: true, agentId: true, gpsStatus: true, distanceM: true } });
        if (visit) assertClientIdReplayAllowed(visit.agentId, user);
        return visit ? { id: visit.id, gpsStatus: visit.gpsStatus, distanceM: visit.distanceM?.toString() ?? null } : null;
      }
      case SyncDocType.PAYMENT: {
        const payment = await tx.payment.findUnique({ where, select: { id: true, collectedBy: true } });
        if (payment) assertClientIdReplayAllowed(payment.collectedBy, user);
        return payment ? { id: payment.id } : null;
      }
    }
    return null;
  }
}

const logger = new Logger('SyncService');

const PRICE_CHANGED = 'PRICE_CHANGED';

/** push() processing order = DocumentCounter docType asc (none < PAY < SO); see DocumentNumberingService. */
const PROCESS_RANK: Record<SyncDocType, number> = { [SyncDocType.VISIT]: 0, [SyncDocType.PAYMENT]: 1, [SyncDocType.ORDER]: 2 };

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

/** Access lost mid-batch (§8.4): DENIED = role/permission removed, INACTIVE = user or company deactivated. */
type Revocation = 'DENIED' | 'INACTIVE';

function revocationResult(doc: SyncPushDocumentDto, revoked: Revocation): SyncPushResultItem {
  if (revoked === 'DENIED') return { clientId: doc.clientId, status: 'REJECTED', error: toErrorDetail(new PermissionDeniedException(SYNC_PUSH_PERMISSION)) };
  // User or company deactivated: the interceptor's 401 contract, per document.
  return { clientId: doc.clientId, status: 'REJECTED', error: toErrorDetail(new UnauthorizedException()) };
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
