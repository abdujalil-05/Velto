import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  InvoiceKind,
  InvoiceStatus,
  OpeningBalanceKind,
  OpeningBalanceStatus,
  PaymentSource,
  PaymentStatus,
  Prisma,
  type OpeningBalanceBatch,
  type TenantClient,
} from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { AppException } from '../../common/errors/app-exception';
import { lockExport1cExclusive } from '../../common/locks/export1c-lock';
import { paginate } from '../../common/pagination/pagination.dto';
import { StorageService } from '../../common/storage/storage.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { companyDayOf, companyTimeZone, localDateString } from '../analytics/report-utils';
import { CustomersService } from '../customers/customers.service';
import { InvalidImportFileException } from '../import/import-exceptions';
import { readWorkbookRows, type SpreadsheetFormat, type WorkbookRow } from '../import/parsers/read-workbook';
import { StockService } from '../stock/stock.service';
import type { ListOpeningBatchesQueryDto } from './dto/list-opening-batches.query';
import type { PostOpeningBatchDto } from './dto/post-opening-batch.dto';
import {
  OpeningAsOfInFutureException,
  OpeningBatchNotFoundException,
  OpeningBatchNotPostedException,
  OpeningBatchNotPreviewedException,
  OpeningBatchTouchedException,
  OpeningConflictException,
  OpeningDocDateAfterAsOfException,
  OpeningEmptyFileException,
  OpeningPreviewHasErrorsException,
  OpeningSignOffRequiredException,
  OpeningStockAlreadyExistsException,
  OpeningTotalsMismatchException,
  OpeningVoidReasonRequiredException,
} from './opening-balances-exceptions';
import {
  OPENING_IMPORT_TYPE,
  OPENING_MAX_ROWS,
  OPENING_REF_TYPE,
  type OpeningCustomerRow,
  type OpeningReport,
  type OpeningStockRow,
  type OpeningWarning,
} from './opening-balances.constants';
import { UUID_RE, pairKey, readCustomerCells, readStockCells, validateCustomerRows, validateStockRows } from './opening-row-parsers';

const MIME: Record<SpreadsheetFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

export interface OpeningUpload {
  buffer: Buffer;
  format: SpreadsheetFormat;
  fileName: string;
}

type AnyRow = OpeningCustomerRow | OpeningStockRow;

const sortedUnique = (ids: string[]) => [...new Set(ids)].sort();
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const zero = () => new Prisma.Decimal(0);

/**
 * F6 opening balances (TZ §6.7 Mode A, §6.7.1 openingQty; ADR-026 create-only,
 * ADR-041..043). preview writes only a PREVIEWED batch + its ImportJob (file +
 * validated rows), never ledger rows — so an abandoned preview blocks nothing.
 * post/void run in ONE transaction each; lock order:
 *   batch FOR UPDATE -> advisory export1c (exclusive) -> [payments id asc] ->
 *   customers id asc -> invoices id asc  |  StockLevel (productId, warehouseId) asc.
 */
@Injectable()
export class OpeningBalancesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly storage: StorageService,
    private readonly auditLog: AuditLogService,
    private readonly customers: CustomersService,
    private readonly stock: StockService,
    private readonly numbering: DocumentNumberingService,
  ) {}

  // -------------------------------------------------------------------------
  // preview
  // -------------------------------------------------------------------------

  async preview(kind: OpeningBalanceKind, upload: OpeningUpload, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    let rows: WorkbookRow[];
    try {
      rows = await readWorkbookRows(upload.buffer, { format: upload.format, maxDataRows: OPENING_MAX_ROWS });
    } catch (err) {
      if (err instanceof AppException) throw err;
      throw new InvalidImportFileException('could not parse file');
    }
    if (rows.length === 0) throw new OpeningEmptyFileException();

    const today = localDateString(new Date(), await companyTimeZone(tx));
    const { validRows, errors } =
      kind === OpeningBalanceKind.CUSTOMER_BALANCE ? await this.validateCustomers(tx, rows, today) : await this.validateStock(tx, rows);

    const fileHash = createHash('sha256').update(upload.buffer).digest('hex');
    const warnings = await this.duplicateFileWarnings(tx, kind, fileHash);
    const totals = totalsOf(kind, validRows);

    const fileUrl = await this.storage.upload({
      buffer: upload.buffer,
      mimeType: MIME[upload.format],
      extension: upload.format,
      keyPrefix: `opening/${OPENING_IMPORT_TYPE[kind]}/${user.companyId}`,
    });
    const report: OpeningReport<AnyRow> = { totalRows: rows.length, validCount: validRows.length, invalidCount: errors.length, errors, warnings, rows: validRows };
    const job = await tx.importJob.create({
      data: {
        companyId: user.companyId,
        type: OPENING_IMPORT_TYPE[kind],
        status: 'DONE', // validation finished; never confirmable through /import (type-scoped there)
        fileUrl,
        createdBy: user.id,
        progress: 100,
        errorLog: report as unknown as Prisma.InputJsonValue,
      },
    });
    const batch = await tx.openingBalanceBatch.create({
      data: {
        companyId: user.companyId,
        kind,
        // Placeholders until post() sets the operator's asOfDate/source.
        asOfDate: dbDate(today),
        source: upload.fileName.trim().slice(0, 200) || 'upload',
        fileHash,
        importJobId: job.id,
        rowCount: validRows.length,
        ...totals,
        createdBy: user.id,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'opening.preview',
      entity: 'OpeningBalanceBatch',
      entityId: batch.id,
      newValue: toAuditJson({ kind, fileHash, rowCount: batch.rowCount, invalidCount: errors.length, ...stringTotals(batch) }),
    });

    return { batch, totalRows: report.totalRows, validCount: report.validCount, invalidCount: report.invalidCount, errors, warnings };
  }

  private async validateCustomers(tx: TenantClient, rows: WorkbookRow[], today: string) {
    const raw = readCustomerCells(rows);
    const codes = [...new Set(raw.map((r) => r.customerCode).filter((c): c is string => !!c))];
    const ids = [...new Set(raw.map((r) => r.customerId?.toLowerCase()).filter((c): c is string => !!c && UUID_RE.test(c)))];
    const found = await tx.customer.findMany({
      where: { deletedAt: null, OR: [{ code: { in: codes } }, { id: { in: ids } }] },
      select: { id: true, code: true },
    });
    const withLedger = await customersWithLedger(tx, found.map((c) => c.id));
    return validateCustomerRows(raw, {
      idByCode: new Map(found.map((c) => [c.code, c.id])),
      codeById: new Map(found.map((c) => [c.id, c.code])),
      withLedger,
      today,
    });
  }

  private async validateStock(tx: TenantClient, rows: WorkbookRow[]) {
    const raw = readStockCells(rows);
    const skus = [...new Set(raw.map((r) => r.sku).filter((s): s is string => !!s))];
    const [products, warehouses] = await Promise.all([
      tx.product.findMany({ where: { deletedAt: null, sku: { in: skus } }, select: { id: true, sku: true } }),
      tx.warehouse.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    ]);
    const warehouseIdsByName = new Map<string, string[]>();
    for (const w of warehouses) warehouseIdsByName.set(w.name, [...(warehouseIdsByName.get(w.name) ?? []), w.id]);
    return validateStockRows(raw, {
      productIdBySku: new Map(products.map((p) => [p.sku, p.id])),
      warehouseNameById: new Map(warehouses.map((w) => [w.id, w.name])),
      warehouseIdsByName,
      pairsWithMovements: await pairsWithMovements(tx, products.map((p) => p.id)),
    });
  }

  /** Same file (sha256) already behind a live batch of this kind — a warning, not an error. */
  private async duplicateFileWarnings(tx: TenantClient, kind: OpeningBalanceKind, fileHash: string): Promise<OpeningWarning[]> {
    const same = await tx.openingBalanceBatch.findMany({
      where: { kind, fileHash, status: { not: OpeningBalanceStatus.VOIDED } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (same.length === 0) return [];
    return [
      {
        code: 'OPENING_FILE_ALREADY_UPLOADED',
        message: {
          uz: "Bu fayl avval ham yuklangan (ko'rib chiqilgan yoki o'tkazilgan paket bor)",
          ru: 'Этот файл уже загружался (есть проверенный или проведённый пакет)',
          en: 'This file was uploaded before (a previewed or posted batch exists)',
        },
        batchIds: same.map((b) => b.id),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  async list(query: ListOpeningBatchesQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.OpeningBalanceBatchWhereInput = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [data, total] = await Promise.all([
      tx.openingBalanceBatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.openingBalanceBatch.count({ where }),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  async getById(id: string) {
    const tx = this.tenantPrisma.client;
    const batch = await tx.openingBalanceBatch.findFirst({ where: { id } });
    if (!batch) throw new OpeningBatchNotFoundException();
    const report = await this.loadReport(tx, batch);
    return {
      batch,
      totalRows: report?.totalRows ?? 0,
      validCount: report?.validCount ?? 0,
      invalidCount: report?.invalidCount ?? 0,
      errors: report?.errors ?? [],
      warnings: report?.warnings ?? [],
    };
  }

  // -------------------------------------------------------------------------
  // post
  // -------------------------------------------------------------------------

  async post(id: string, dto: PostOpeningBatchDto, user: AuthenticatedUser) {
    if (dto.signOff !== true) throw new OpeningSignOffRequiredException();
    const tx = this.tenantPrisma.client;

    const batch = await lockBatch(tx, id);
    if (batch.status !== OpeningBalanceStatus.PREVIEWED) throw new OpeningBatchNotPreviewedException(batch.status);
    await lockExport1cExclusive();

    const timeZone = await companyTimeZone(tx);
    if (dto.asOfDate > localDateString(new Date(), timeZone)) throw new OpeningAsOfInFutureException();

    const report = await this.loadReport(tx, batch);
    if (!report) throw new OpeningPreviewHasErrorsException(0);
    if (report.invalidCount > 0) throw new OpeningPreviewHasErrorsException(report.invalidCount);

    const expected = stringTotals(batch);
    const provided = { debtTotal: dto.controlDebt, creditTotal: dto.controlCredit, qtyTotal: dto.controlQty };
    const totalsMatch =
      batch.debtTotal.equals(dto.controlDebt) && batch.creditTotal.equals(dto.controlCredit) && batch.qtyTotal.equals(dto.controlQty);
    if (!totalsMatch) throw new OpeningTotalsMismatchException(expected, provided);

    try {
      if (batch.kind === OpeningBalanceKind.CUSTOMER_BALANCE) {
        await this.postCustomers(tx, batch, report.rows as OpeningCustomerRow[], dto.asOfDate, timeZone, user);
      } else {
        await this.postStock(tx, batch, report.rows as OpeningStockRow[], dto.asOfDate, user);
      }
    } catch (err) {
      // DB backstop (stockmovement_opening_unique_guard) for a pair a concurrent batch just took.
      if (err instanceof Error && err.message.includes('opening stock already exists')) throw new OpeningStockAlreadyExistsException();
      throw err;
    }

    const posted = await tx.openingBalanceBatch.update({
      where: { id },
      data: { status: OpeningBalanceStatus.POSTED, asOfDate: dbDate(dto.asOfDate), source: dto.source.trim(), postedBy: user.id, postedAt: new Date() },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'opening.post',
      entity: 'OpeningBalanceBatch',
      entityId: id,
      oldValue: toAuditJson({ status: batch.status }),
      newValue: toAuditJson({
        status: posted.status,
        kind: posted.kind,
        fileHash: posted.fileHash,
        asOfDate: dto.asOfDate,
        source: posted.source,
        rowCount: posted.rowCount,
        ...stringTotals(posted),
        signOff: true,
      }),
    });
    return posted;
  }

  private async postCustomers(tx: TenantClient, batch: OpeningBalanceBatch, rows: OpeningCustomerRow[], asOfDate: string, timeZone: string, user: AuthenticatedUser) {
    const late = rows.filter((r) => r.docDate !== null && r.docDate > asOfDate).map((r) => r.rowNumber);
    if (late.length > 0) throw new OpeningDocDateAfterAsOfException(late);

    // Create-only re-check under the customer locks (a payment/delivery takes the same lock).
    const customerIds = sortedUnique(rows.map((r) => r.customerId));
    const live = new Set(
      (
        await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT id::text AS id FROM "Customer"
          WHERE id = ANY(${customerIds}::uuid[]) AND "deletedAt" IS NULL
          ORDER BY id
          FOR UPDATE
        `)
      ).map((c) => c.id),
    );
    const withLedger = await customersWithLedger(tx, customerIds);
    const conflicts = rows.filter((r) => !live.has(r.customerId) || withLedger.has(r.customerId)).map((r) => r.rowNumber);
    if (conflicts.length > 0) throw new OpeningConflictException(conflicts);

    const invoices: Prisma.InvoiceCreateManyInput[] = [];
    const payments: Prisma.PaymentCreateManyInput[] = [];
    for (const r of rows) {
      const number = await this.numbering.next(tx, user.companyId, 'OB');
      if (r.side === 'DEBT') {
        invoices.push({
          companyId: user.companyId,
          number,
          customerId: r.customerId,
          total: r.amount,
          status: InvoiceStatus.OPEN,
          kind: InvoiceKind.OPENING,
          openingBatchId: batch.id,
          externalDocRef: r.docRef,
          // Aging counts from the 1C document date (fallback: as-of date).
          createdAt: companyDayOf(r.docDate ?? asOfDate, timeZone).start,
        });
      } else {
        // Advance: POSTED, no method/collector/allocations — the ledger formula
        // treats it as advance; never auto-applied (ADR-015..018).
        payments.push({
          companyId: user.companyId,
          number,
          customerId: r.customerId,
          amount: r.amount,
          method: null,
          status: PaymentStatus.POSTED,
          source: PaymentSource.OPENING,
          openingBatchId: batch.id,
          createdAt: companyDayOf(asOfDate, timeZone).start,
        });
      }
    }
    if (invoices.length > 0) await tx.invoice.createMany({ data: invoices });
    if (payments.length > 0) await tx.payment.createMany({ data: payments });

    await this.refreshCachedBalances(tx, customerIds);
  }

  private async postStock(tx: TenantClient, batch: OpeningBalanceBatch, rows: OpeningStockRow[], asOfDate: string, user: AuthenticatedUser) {
    const sorted = [...rows].sort((a, b) => pairKey(a.productId, a.warehouseId).localeCompare(pairKey(b.productId, b.warehouseId)));
    const productIds = sortedUnique(sorted.map((r) => r.productId));
    const [liveProducts, liveWarehouses] = await Promise.all([
      tx.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true } }),
      tx.warehouse.findMany({ where: { id: { in: sortedUnique(sorted.map((r) => r.warehouseId)) }, isActive: true }, select: { id: true } }),
    ]);
    const productOk = new Set(liveProducts.map((p) => p.id));
    const warehouseOk = new Set(liveWarehouses.map((w) => w.id));

    // Create-only re-check under the StockLevel locks (every stock writer takes them).
    const levels = await this.stock.lockLevelsForUpdate(tx, sorted);
    const nonEmpty = new Set(levels.filter((l) => !l.onHand.isZero() || !l.reserved.isZero()).map((l) => pairKey(l.productId, l.warehouseId)));
    const moved = await pairsWithMovements(tx, productIds);
    const conflicts = sorted
      .filter((r) => {
        const key = pairKey(r.productId, r.warehouseId);
        return !productOk.has(r.productId) || !warehouseOk.has(r.warehouseId) || nonEmpty.has(key) || moved.has(key);
      })
      .map((r) => r.rowNumber);
    if (conflicts.length > 0) throw new OpeningConflictException(conflicts.sort((a, b) => a - b));

    for (const r of sorted) {
      await this.stock.adjustForRef(tx, {
        companyId: user.companyId,
        productId: r.productId,
        warehouseId: r.warehouseId,
        qty: r.qty,
        refType: OPENING_REF_TYPE,
        refId: batch.id,
        note: `Opening balance ${asOfDate}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // void
  // -------------------------------------------------------------------------

  async void(id: string, reason: string, user: AuthenticatedUser) {
    const trimmed = reason?.trim() ?? '';
    if (trimmed.length < 3 || trimmed.length > 500) throw new OpeningVoidReasonRequiredException();
    const tx = this.tenantPrisma.client;

    const batch = await lockBatch(tx, id);
    if (batch.status !== OpeningBalanceStatus.POSTED) throw new OpeningBatchNotPostedException(batch.status);
    await lockExport1cExclusive();

    if (batch.kind === OpeningBalanceKind.CUSTOMER_BALANCE) await this.voidCustomers(tx, batch, trimmed, user);
    else await this.voidStock(tx, batch, trimmed, user);

    const voided = await tx.openingBalanceBatch.update({
      where: { id },
      data: { status: OpeningBalanceStatus.VOIDED, voidedBy: user.id, voidedAt: new Date(), voidReason: trimmed },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'opening.void',
      entity: 'OpeningBalanceBatch',
      entityId: id,
      oldValue: toAuditJson({ status: batch.status }),
      newValue: toAuditJson({ status: voided.status, kind: voided.kind, fileHash: voided.fileHash, reason: trimmed, ...stringTotals(voided) }),
    });
    return voided;
  }

  /** "Untouched" = no allocation on any OPENING invoice/payment of the batch, payments still POSTED, invoices still OPEN. */
  private async voidCustomers(tx: TenantClient, batch: OpeningBalanceBatch, reason: string, user: AuthenticatedUser) {
    const payments = await tx.$queryRaw<{ id: string; customerId: string; status: PaymentStatus }[]>(Prisma.sql`
      SELECT id::text AS id, "customerId"::text AS "customerId", status FROM "Payment"
      WHERE "openingBatchId" = ${batch.id}::uuid ORDER BY id FOR UPDATE
    `);
    const invoiceRefs = await tx.invoice.findMany({ where: { openingBatchId: batch.id }, select: { customerId: true } });
    const customerIds = sortedUnique([...payments.map((p) => p.customerId), ...invoiceRefs.map((i) => i.customerId)]);
    await tx.$queryRaw(Prisma.sql`SELECT id FROM "Customer" WHERE id = ANY(${customerIds}::uuid[]) ORDER BY id FOR UPDATE`);
    const invoices = await tx.$queryRaw<{ id: string; status: InvoiceStatus }[]>(Prisma.sql`
      SELECT id::text AS id, status FROM "Invoice" WHERE "openingBatchId" = ${batch.id}::uuid ORDER BY id FOR UPDATE
    `);

    const invoiceIds = invoices.map((i) => i.id);
    const paymentIds = payments.map((p) => p.id);
    const [invoiceAllocations, paymentAllocations] = await Promise.all([
      invoiceIds.length ? tx.paymentAllocation.count({ where: { invoiceId: { in: invoiceIds } } }) : 0,
      paymentIds.length ? tx.paymentAllocation.count({ where: { paymentId: { in: paymentIds } } }) : 0,
    ]);
    if (invoiceAllocations > 0 || invoices.some((i) => i.status !== InvoiceStatus.OPEN)) throw new OpeningBatchTouchedException('INVOICE_ALLOCATED');
    if (paymentAllocations > 0 || payments.some((p) => p.status !== PaymentStatus.POSTED)) throw new OpeningBatchTouchedException('PAYMENT_USED');

    if (invoiceIds.length > 0) await tx.invoice.updateMany({ where: { id: { in: invoiceIds } }, data: { status: InvoiceStatus.CANCELLED } });
    if (paymentIds.length > 0) {
      await tx.paymentReversal.createMany({ data: paymentIds.map((pid) => ({ companyId: user.companyId, reversesPaymentId: pid, reason, actorId: user.id })) });
      await tx.payment.updateMany({ where: { id: { in: paymentIds } }, data: { status: PaymentStatus.REVERSED } });
    }
    await this.refreshCachedBalances(tx, customerIds);
  }

  /** "Untouched" = no other movement on any (product, warehouse) pair of the batch since it was posted. */
  private async voidStock(tx: TenantClient, batch: OpeningBalanceBatch, reason: string, user: AuthenticatedUser) {
    const movements = await tx.stockMovement.findMany({
      where: { refType: OPENING_REF_TYPE, refId: batch.id, reversesMovementId: null },
      orderBy: [{ productId: 'asc' }, { warehouseId: 'asc' }],
    });
    await this.stock.lockLevelsForUpdate(tx, movements);
    const moved = await pairsWithMovements(tx, sortedUnique(movements.map((m) => m.productId)), batch.id);
    if (movements.some((m) => moved.has(pairKey(m.productId, m.warehouseId)))) throw new OpeningBatchTouchedException('STOCK_MOVED');

    for (const m of movements) await this.stock.reverseForRef(tx, m, reason, user.companyId);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  /** §6.5: cachedBalance from the one ledger formula, same tx, customers already locked (id asc). */
  private async refreshCachedBalances(tx: TenantClient, customerIds: string[]) {
    for (const id of customerIds) {
      const balance = await this.customers.getBalance(tx, id);
      await tx.customer.update({ where: { id }, data: { cachedBalance: balance } });
    }
  }

  private async loadReport(tx: TenantClient, batch: OpeningBalanceBatch): Promise<OpeningReport<AnyRow> | null> {
    if (!batch.importJobId) return null;
    const job = await tx.importJob.findFirst({ where: { id: batch.importJobId }, select: { errorLog: true } });
    return (job?.errorLog as unknown as OpeningReport<AnyRow> | null) ?? null;
  }
}

async function lockBatch(tx: TenantClient, id: string): Promise<OpeningBalanceBatch> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "OpeningBalanceBatch" WHERE id = ${id}::uuid FOR UPDATE`);
  const batch = await tx.openingBalanceBatch.findFirst({ where: { id } });
  if (!batch) throw new OpeningBatchNotFoundException();
  return batch;
}

/** Customers with any invoice/payment outside a VOIDED opening batch (ADR-026 create-only). */
async function customersWithLedger(tx: TenantClient, customerIds: string[]): Promise<Set<string>> {
  if (customerIds.length === 0) return new Set();
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT i."customerId"::text AS id FROM "Invoice" i
    LEFT JOIN "OpeningBalanceBatch" b ON b.id = i."openingBatchId"
    WHERE i."customerId" = ANY(${customerIds}::uuid[]) AND b.status IS DISTINCT FROM 'VOIDED'
    UNION
    SELECT p."customerId"::text FROM "Payment" p
    LEFT JOIN "OpeningBalanceBatch" b ON b.id = p."openingBatchId"
    WHERE p."customerId" = ANY(${customerIds}::uuid[]) AND b.status IS DISTINCT FROM 'VOIDED'
  `);
  return new Set(rows.map((r) => r.id));
}

/**
 * (product, warehouse) pairs with any movement other than those of a VOIDED
 * opening batch (and, for void, other than `exceptBatchId`'s own rows).
 */
async function pairsWithMovements(tx: TenantClient, productIds: string[], exceptBatchId?: string): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const rows = await tx.$queryRaw<{ productId: string; warehouseId: string }[]>(Prisma.sql`
    SELECT DISTINCT sm."productId"::text AS "productId", sm."warehouseId"::text AS "warehouseId"
    FROM "StockMovement" sm
    LEFT JOIN "OpeningBalanceBatch" b ON sm."refType" = ${OPENING_REF_TYPE} AND b.id = sm."refId"
    WHERE sm."productId" = ANY(${productIds}::uuid[])
      AND NOT (sm."refType" IS NOT DISTINCT FROM ${OPENING_REF_TYPE} AND b.status IS NOT DISTINCT FROM 'VOIDED')
      AND NOT (sm."refType" IS NOT DISTINCT FROM ${OPENING_REF_TYPE} AND sm."refId" IS NOT DISTINCT FROM ${exceptBatchId ?? null}::uuid)
  `);
  return new Set(rows.map((r) => pairKey(r.productId, r.warehouseId)));
}

function totalsOf(kind: OpeningBalanceKind, rows: AnyRow[]) {
  let debtTotal = zero();
  let creditTotal = zero();
  let qtyTotal = zero();
  if (kind === OpeningBalanceKind.CUSTOMER_BALANCE) {
    for (const r of rows as OpeningCustomerRow[]) {
      if (r.side === 'DEBT') debtTotal = debtTotal.plus(r.amount);
      else creditTotal = creditTotal.plus(r.amount);
    }
  } else {
    for (const r of rows as OpeningStockRow[]) qtyTotal = qtyTotal.plus(r.qty);
  }
  return { debtTotal, creditTotal, qtyTotal };
}

function stringTotals(b: { debtTotal: Prisma.Decimal; creditTotal: Prisma.Decimal; qtyTotal: Prisma.Decimal }) {
  return { debtTotal: b.debtTotal.toFixed(2), creditTotal: b.creditTotal.toFixed(2), qtyTotal: b.qtyTotal.toFixed(3) };
}

