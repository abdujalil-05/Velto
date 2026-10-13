import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, withSavepoint } from '@velto/database';
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

  /**
   * 10.1/10.2: reference + state data for the offline client's local Dexie
   * store — one flat array per Dexie table (`products`, `packagings`,
   * `prices`, `customers`, `outlets`, `stock`, `balances`, `categories`),
   * matching VELTO-TZ.md 10.2's `db.version(1).stores({...})` shape plus a
   * `categories` table the Mini App's Order screen needs for its category
   * filter (9.4 Ekran 4) that 10.2's table doesn't literally list, plus a
   * top-level `defaultPriceListId` (see below). Each is delta-filtered by
   * `updatedAt > since`; `cursor` is captured *before* any
   * query runs and returned for the next pull's `since` — so a row written
   * mid-request is never missed, only (rarely, harmlessly) re-sent once more
   * next time. `balances` is derived from the same `customers` query rather
   * than a second round trip, since Customer.cachedBalance already carries
   * the up-to-date figure (6.7).
   *
   * `routes`/`routeStops` are the one exception: a full snapshot every pull,
   * not a delta. RoutesService.update() *hard*-deletes replaced RouteStop
   * rows (no tombstone survives to signal removal to a delta consumer), and
   * 10.1 explicitly allows "to'liq yuklab olish" (full download) for
   * reference data — cheap here since it's a handful of routes/stops per
   * agent, not thousands of rows.
   */
  async pull(sinceParam: string | undefined, agentIdParam: string | undefined, user: AuthenticatedUser) {
    const cursor = new Date();
    const since = sinceParam ? new Date(sinceParam) : new Date(0);
    const tx = this.tenantPrisma.client;

    const agentId = user.roles.includes('SALES_AGENT') ? user.id : agentIdParam;

    // Product/Customer/Outlet are soft-deleted (deletedAt), matching the
    // deletedAt: null guard every other query onto these models in the app
    // applies — without it, a soft-deleted row's later updatedAt bump (e.g.
    // the delete itself) would sync it to the offline client as if still
    // live, with nothing telling the client to remove it locally.
    // ProductPackaging/PriceListItem/StockLevel have no deletedAt column.
    const [products, packagings, prices, customers, outlets, stock, categories, routes] = await Promise.all([
      tx.product.findMany({ where: { updatedAt: { gt: since }, deletedAt: null } }),
      tx.productPackaging.findMany({ where: { updatedAt: { gt: since } } }),
      tx.priceListItem.findMany({ where: { updatedAt: { gt: since } } }),
      tx.customer.findMany({ where: { updatedAt: { gt: since }, deletedAt: null } }),
      tx.outlet.findMany({ where: { updatedAt: { gt: since }, deletedAt: null } }),
      tx.stockLevel.findMany({ where: { updatedAt: { gt: since } } }),
      // Needed for the Mini App's Order screen category filter (9.4 Ekran 4) —
      // no deletedAt column on this model, matching ProductPackaging/PriceListItem/StockLevel above.
      tx.productCategory.findMany({ where: { updatedAt: { gt: since } } }),
      agentId ? tx.route.findMany({ where: { agentId } }) : Promise.resolve([]),
    ]);

    const routeStops = routes.length
      ? await tx.routeStop.findMany({
          where: { routeId: { in: routes.map((r) => r.id) } },
          orderBy: { sortOrder: 'asc' },
        })
      : [];

    const balances = customers.map((c) => ({ customerId: c.id, balance: c.cachedBalance, updatedAt: c.updatedAt }));

    // 8.1: order pricing falls back to this whenever a customer has no
    // priceListId of its own — SalesService.create()'s own
    // defaultPriceListId() private helper does the identical lookup. Sent
    // once per pull (not delta-filtered — it's a single id, not a
    // collection) so the offline Order screen's client-side price preview
    // resolves the same price list the server will actually bill against.
    const defaultPriceList = await tx.priceList.findFirst({ where: { isDefault: true } });

    return {
      cursor: cursor.toISOString(),
      products,
      packagings,
      prices,
      customers,
      outlets,
      stock,
      categories,
      balances,
      routes,
      routeStops,
      defaultPriceListId: defaultPriceList?.id ?? null,
    };
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
