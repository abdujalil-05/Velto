import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { CreatePaymentDto } from '../finance/dto/create-payment.dto';
import { PaymentsService } from '../finance/payments/payments.service';
import { CreateVisitDto } from '../field/visits/dto/create-visit.dto';
import { VisitsService } from '../field/visits/visits.service';
import { CreateOrderDto } from '../sales/dto/create-order.dto';
import { SalesService } from '../sales/sales.service';
import { SyncDocType, type SyncPushDocumentDto } from './dto/sync-push.dto';
import { validatePayload } from './validate-payload';

export type SyncDocStatus = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';

export interface SyncPushResultItem {
  clientId: string;
  status: SyncDocStatus;
  id?: string;
  error?: { code: string; message: string };
}

@Injectable()
export class SyncService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly sales: SalesService,
    private readonly payments: PaymentsService,
    private readonly visits: VisitsService,
  ) {}

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
   * 10.3: processes up to 20 queued offline documents (order/visit/payment),
   * each independently, returning a per-document outcome so the client's
   * queue can resolve, retry, or surface each one on its own — one
   * document's failure never blocks or rolls back the others in the batch.
   */
  async push(documents: SyncPushDocumentDto[], user: AuthenticatedUser): Promise<{ results: SyncPushResultItem[] }> {
    const results: SyncPushResultItem[] = [];
    for (const doc of documents) {
      results.push(await this.pushOne(doc, user));
    }
    return { results };
  }

  private async pushOne(doc: SyncPushDocumentDto, user: AuthenticatedUser): Promise<SyncPushResultItem> {
    const tx = this.tenantPrisma.client;

    try {
      switch (doc.type) {
        case SyncDocType.ORDER: {
          // Checked *before* create() runs, purely to report DUPLICATE vs
          // ACCEPTED accurately — create() is idempotent regardless (10.4:
          // "Bir hujjat ikki marta yuborilgan → clientId bo'yicha rad
          // etiladi, 200 qaytariladi, xato emas"), so a rare race here just
          // means an occasional DUPLICATE is reported as ACCEPTED instead —
          // never a correctness issue.
          const alreadyExisted = (await tx.salesOrder.findUnique({ where: { clientId: doc.clientId } })) !== null;
          const dto = await validatePayload(CreateOrderDto, { ...doc.payload, clientId: doc.clientId });
          const order = await this.sales.create(dto, user);
          return { clientId: doc.clientId, id: order.id, status: alreadyExisted ? 'DUPLICATE' : 'ACCEPTED' };
        }
        case SyncDocType.VISIT: {
          const alreadyExisted = (await tx.visit.findUnique({ where: { clientId: doc.clientId } })) !== null;
          const dto = await validatePayload(CreateVisitDto, { ...doc.payload, clientId: doc.clientId });
          const visit = await this.visits.create(dto, user);
          return { clientId: doc.clientId, id: visit.id, status: alreadyExisted ? 'DUPLICATE' : 'ACCEPTED' };
        }
        case SyncDocType.PAYMENT: {
          const alreadyExisted = (await tx.payment.findUnique({ where: { clientId: doc.clientId } })) !== null;
          const dto = await validatePayload(CreatePaymentDto, { ...doc.payload, clientId: doc.clientId });
          const payment = await this.payments.create(dto, user);
          return { clientId: doc.clientId, id: payment.id, status: alreadyExisted ? 'DUPLICATE' : 'ACCEPTED' };
        }
      }
      // Unreachable — `type` is already constrained to SyncDocType by
      // @IsEnum on the DTO — but satisfies the compiler's control-flow
      // analysis for the declared return type.
      throw new Error(`Unknown sync document type: ${doc.type as string}`);
    } catch (error) {
      return { clientId: doc.clientId, status: 'REJECTED', error: toErrorDetail(error) };
    }
  }
}

const logger = new Logger('SyncService');

// SEC-045: never leak an unexpected error's raw message (e.g. Prisma column/
// table names) to the client — only HttpExceptions carry client-safe copy.
// Matches AllExceptionsFilter's policy, which this per-document try/catch in
// pushOne() otherwise bypasses since it never reaches the global filter.
function toErrorDetail(error: unknown): { code: string; message: string } {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
      const { code, message } = body as { code: string; message: { uz: string } | string };
      return { code, message: typeof message === 'string' ? message : message.uz };
    }
  }
  logger.error(error instanceof Error ? error.stack : error);
  return { code: 'SYNC_UNKNOWN_ERROR', message: 'Server xatoligi' };
}
