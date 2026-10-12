import { Injectable } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus, withSavepoint, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { DocumentNumberingService } from '../../common/document-numbering/document-numbering.service';
import { paginate, resolveSort } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { endOfDay, startOfDay } from '../analytics/report-utils';
import { ProductNotFoundException } from '../catalog/catalog-exceptions';
import { WarehouseNotFoundException } from '../stock/stock-exceptions';
import { StockService } from '../stock/stock.service';
import type { CreateGoodsReceiptDto, ListGoodsReceiptsQueryDto } from './dto/goods-receipt.dto';
import type { CreatePurchaseOrderDto, ListPurchaseOrdersQueryDto } from './dto/purchase-order.dto';
import type { CreateSupplierDto, ListSuppliersQueryDto, UpdateSupplierDto } from './dto/supplier.dto';
import {
  InvalidPurchaseOrderTransitionException,
  InvalidReceiptLineException,
  OverReceiptException,
  PurchaseOrderHasReceiptsException,
  PurchaseOrderNotFoundException,
  PurchaseOrderNotReceivableException,
  ReceiptSupplierMismatchException,
  ReceiptWarehouseMismatchException,
  ReceiptWarehouseRequiredException,
  SupplierInactiveException,
  SupplierNotFoundException,
} from './purchases-exceptions';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/**
 * 6.6: the single rounding strategy for purchase money — each line is
 * qty × unitPrice × (1 + vatRate/100), rounded once to 2 dp HALF_UP; the
 * order total is the sum of the already-rounded line totals (so Σ lines ==
 * totalAmount exactly, never off by a tiyin).
 */
export function computePurchaseLineTotal(qty: Prisma.Decimal.Value, unitPrice: Prisma.Decimal.Value, vatRate: Prisma.Decimal.Value): Decimal {
  return new Decimal(qty)
    .times(unitPrice)
    .times(new Decimal(1).plus(new Decimal(vatRate).dividedBy(100)))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

const PO_LIST_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  warehouse: { select: { id: true, name: true } },
} satisfies Prisma.PurchaseOrderInclude;

const PO_DETAIL_INCLUDE = {
  ...PO_LIST_INCLUDE,
  lines: { orderBy: { createdAt: 'asc' } },
  goodsReceipts: { include: { lines: true }, orderBy: { receivedAt: 'asc' } },
} satisfies Prisma.PurchaseOrderInclude;

const RECEIVABLE_STATUSES: PurchaseOrderStatus[] = [PurchaseOrderStatus.ORDERED, PurchaseOrderStatus.PARTIALLY_RECEIVED];

@Injectable()
export class PurchasesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly stock: StockService,
    private readonly docNumbering: DocumentNumberingService,
  ) {}

  // ---------------------------------------------------------------- Suppliers

  async listSuppliers(query: ListSuppliersQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.SupplierWhereInput = {
      deletedAt: null,
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
    };
    const orderBy = resolveSort<Prisma.SupplierOrderByWithRelationInput>(
      query,
      { name: (dir) => ({ name: dir }), createdAt: (dir) => ({ createdAt: dir }) },
      { name: 'asc' },
    );
    const [data, total] = await Promise.all([
      tx.supplier.findMany({ where, orderBy, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      tx.supplier.count({ where }),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  async getSupplier(id: string) {
    const supplier = await this.tenantPrisma.client.supplier.findFirst({ where: { id, deletedAt: null } });
    if (!supplier) throw new SupplierNotFoundException();
    return supplier;
  }

  async createSupplier(dto: CreateSupplierDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const supplier = await tx.supplier.create({ data: { companyId: user.companyId, ...dto } });
    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplier.create',
      entity: 'Supplier',
      entityId: supplier.id,
      newValue: toAuditJson(supplier),
    });
    return supplier;
  }

  async updateSupplier(id: string, dto: UpdateSupplierDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await this.getSupplier(id);
    const updated = await tx.supplier.update({ where: { id }, data: dto });
    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplier.update',
      entity: 'Supplier',
      entityId: id,
      oldValue: toAuditJson(before),
      newValue: toAuditJson(updated),
    });
    return updated;
  }

  /** Soft deactivation only — suppliers are referenced by posted POs/receipts and are never hard-deleted. */
  async deactivateSupplier(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const before = await this.getSupplier(id);
    if (!before.isActive) return before;
    const updated = await tx.supplier.update({ where: { id }, data: { isActive: false } });
    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'supplier.deactivate',
      entity: 'Supplier',
      entityId: id,
      oldValue: toAuditJson({ isActive: true }),
      newValue: toAuditJson({ isActive: false }),
    });
    return updated;
  }

  // ----------------------------------------------------------- Purchase orders

  async listPurchaseOrders(query: ListPurchaseOrdersQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: startOfDay(new Date(query.from)) } : {}),
              ...(query.to ? { lte: endOfDay(new Date(query.to)) } : {}),
            },
          }
        : {}),
    };
    const orderBy = resolveSort<Prisma.PurchaseOrderOrderByWithRelationInput>(
      query,
      {
        number: (dir) => ({ number: dir }),
        createdAt: (dir) => ({ createdAt: dir }),
        totalAmount: (dir) => ({ totalAmount: dir }),
      },
      { createdAt: 'desc' },
    );
    const [data, total] = await Promise.all([
      tx.purchaseOrder.findMany({
        where,
        include: PO_LIST_INCLUDE,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.purchaseOrder.count({ where }),
    ]);
    return paginate(data, total, query.page, query.pageSize);
  }

  /** Light list: header + warehouse/supplier/PO summary + lineCount/totalQty; no lines. */
  async listGoodsReceipts(query: ListGoodsReceiptsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.GoodsReceiptWhereInput = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.purchaseOrderId ? { purchaseOrderId: query.purchaseOrderId } : {}),
      ...(query.from || query.to
        ? {
            receivedAt: {
              ...(query.from ? { gte: startOfDay(new Date(query.from)) } : {}),
              ...(query.to ? { lte: endOfDay(new Date(query.to)) } : {}),
            },
          }
        : {}),
    };
    const orderBy = resolveSort<Prisma.GoodsReceiptOrderByWithRelationInput>(
      query,
      { receivedAt: (dir) => ({ receivedAt: dir }) },
      { receivedAt: 'desc' },
    );
    const [rows, total] = await Promise.all([
      tx.goodsReceipt.findMany({
        where,
        select: {
          id: true,
          receivedAt: true,
          note: true,
          warehouse: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          purchaseOrder: { select: { id: true, number: true } },
          receivedBy: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: [orderBy as Prisma.GoodsReceiptOrderByWithRelationInput, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.goodsReceipt.count({ where }),
    ]);
    const sums = rows.length
      ? await tx.goodsReceiptLine.groupBy({
          by: ['goodsReceiptId'],
          where: { goodsReceiptId: { in: rows.map((r) => r.id) } },
          _count: { _all: true },
          _sum: { qty: true },
        })
      : [];
    const byId = new Map(sums.map((s) => [s.goodsReceiptId, s]));
    const data = rows.map((r) => {
      const s = byId.get(r.id);
      return {
        ...r,
        lineCount: s?._count._all ?? 0,
        totalQty: (s?._sum.qty ?? new Decimal(0)).toFixed(3),
      };
    });
    return paginate(data, total, query.page, query.pageSize);
  }

  async getPurchaseOrder(id: string) {
    const po = await this.tenantPrisma.client.purchaseOrder.findUnique({ where: { id }, include: PO_DETAIL_INCLUDE });
    if (!po) throw new PurchaseOrderNotFoundException();
    return po;
  }

  /**
   * Server computes every lineTotal and the totalAmount (client never sends
   * them); productName/SKU/unit/vatRate are snapshotted from Product.
   * Supplier/warehouse/products are looked up through the RLS-scoped client,
   * so another tenant's ids simply aren't found.
   */
  async createPurchaseOrder(dto: CreatePurchaseOrderDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, deletedAt: null } });
    if (!supplier) throw new SupplierNotFoundException();
    if (!supplier.isActive) throw new SupplierInactiveException();
    await this.assertActiveWarehouse(tx, dto.warehouseId);

    const productIds = [...new Set(dto.lines.map((l) => l.productId))];
    const products = await tx.product.findMany({ where: { id: { in: productIds }, deletedAt: null } });
    const productById = new Map(products.map((p) => [p.id, p]));

    let totalAmount = new Decimal(0);
    const lines = dto.lines.map((lineDto) => {
      const product = productById.get(lineDto.productId);
      if (!product) throw new ProductNotFoundException();
      const qty = new Decimal(lineDto.qty);
      const unitPrice = new Decimal(lineDto.unitPrice);
      const lineTotal = computePurchaseLineTotal(qty, unitPrice, product.vatRate);
      totalAmount = totalAmount.plus(lineTotal);
      return {
        companyId: user.companyId,
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        unit: product.baseUnit,
        qty,
        unitPrice,
        vatRate: product.vatRate,
        lineTotal,
      };
    });

    const status = dto.status === PurchaseOrderStatus.ORDERED ? PurchaseOrderStatus.ORDERED : PurchaseOrderStatus.DRAFT;
    const number = await this.docNumbering.next(tx, user.companyId, 'PO');
    const po = await tx.purchaseOrder.create({
      data: {
        companyId: user.companyId,
        number,
        supplierId: supplier.id,
        warehouseId: dto.warehouseId,
        status,
        expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : null,
        totalAmount,
        note: dto.note,
        createdById: user.id,
        orderedAt: status === PurchaseOrderStatus.ORDERED ? new Date() : null,
        lines: { create: lines },
      },
      include: PO_DETAIL_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'purchase_order.create',
      entity: 'PurchaseOrder',
      entityId: po.id,
      newValue: toAuditJson(po),
    });
    return po;
  }

  /** DRAFT → ORDERED. */
  async markOrdered(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const po = await this.lockPurchaseOrder(tx, id);
    if (po.status !== PurchaseOrderStatus.DRAFT) {
      throw new InvalidPurchaseOrderTransitionException(po.status, PurchaseOrderStatus.ORDERED);
    }
    await tx.purchaseOrder.update({ where: { id }, data: { status: PurchaseOrderStatus.ORDERED, orderedAt: new Date() } });
    await this.auditTransition(tx, user, id, po.status, PurchaseOrderStatus.ORDERED);
    return this.getPurchaseOrder(id);
  }

  /** DRAFT/ORDERED → CANCELLED; refused once any quantity has been received. */
  async cancelPurchaseOrder(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // Header lock serializes against a concurrent receipt (which takes the same lock first).
    const po = await this.lockPurchaseOrder(tx, id);
    if (po.status === PurchaseOrderStatus.PARTIALLY_RECEIVED || po.status === PurchaseOrderStatus.RECEIVED) {
      throw new PurchaseOrderHasReceiptsException();
    }
    if (po.status !== PurchaseOrderStatus.DRAFT && po.status !== PurchaseOrderStatus.ORDERED) {
      throw new InvalidPurchaseOrderTransitionException(po.status, PurchaseOrderStatus.CANCELLED);
    }
    const received = await tx.purchaseOrderLine.count({ where: { purchaseOrderId: id, qtyReceived: { gt: 0 } } });
    if (received > 0) throw new PurchaseOrderHasReceiptsException();

    await tx.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.CANCELLED, cancelledAt: new Date() },
    });
    await this.auditTransition(tx, user, id, po.status, PurchaseOrderStatus.CANCELLED);
    return this.getPurchaseOrder(id);
  }

  // ------------------------------------------------------------ Goods receipt

  /**
   * One transaction: lock PO header + lines (FOR UPDATE), validate remaining
   * qty, post the receipt, write exactly one RECEIVE StockMovement per receipt
   * line via StockService.receiveForRef (which also increments StockLevel),
   * bump qtyReceived and move the PO status. Receipts are never updated or
   * deleted — corrections are stock ADJUST.
   *
   * Idempotent on (companyId, clientId), same convention as SalesService.create:
   * a replay returns the stored receipt untouched (even if the replayed body
   * differs) and posts no second RECEIVE movement / qtyReceived increment.
   */
  async createGoodsReceipt(dto: CreateGoodsReceiptDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;

    // Fast path for sequential replays.
    const replay = await this.findReceiptByClientId(tx, dto.clientId);
    if (replay) return replay;

    type PreparedLine = {
      purchaseOrderLineId: string | null;
      productId: string;
      productName: string;
      productSku: string;
      unit: string;
      qty: Decimal;
      unitCost: Decimal | null;
    };
    const prepared: PreparedLine[] = [];
    const requestedByPoLine = new Map<string, Decimal>();
    let warehouseId: string;
    let supplierId: string | null;
    let po: { id: string; status: PurchaseOrderStatus } | null = null;

    if (dto.purchaseOrderId) {
      const locked = await this.lockPurchaseOrder(tx, dto.purchaseOrderId);
      // Re-check under the PO lock: a concurrent duplicate that held the lock
      // has committed by now, and must win over the status/remaining checks.
      const replayed = await this.findReceiptByClientId(tx, dto.clientId);
      if (replayed) return replayed;
      po = locked;
      if (!RECEIVABLE_STATUSES.includes(locked.status)) throw new PurchaseOrderNotReceivableException(locked.status);
      if (dto.warehouseId && dto.warehouseId !== locked.warehouseId) throw new ReceiptWarehouseMismatchException();
      if (dto.supplierId && dto.supplierId !== locked.supplierId) throw new ReceiptSupplierMismatchException();
      warehouseId = locked.warehouseId;
      supplierId = locked.supplierId;

      // Lock every line of the PO in a stable order (deadlock-free), then read
      // the current committed qtyReceived under that lock.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "PurchaseOrderLine"
        WHERE "purchaseOrderId" = ${locked.id}::uuid
        ORDER BY "id"
        FOR UPDATE
      `);
      const poLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: locked.id } });
      const poLineById = new Map(poLines.map((l) => [l.id, l]));

      for (const lineDto of dto.lines) {
        if (!lineDto.purchaseOrderLineId) throw new InvalidReceiptLineException('purchaseOrderLineId is required');
        const poLine = poLineById.get(lineDto.purchaseOrderLineId);
        if (!poLine) throw new InvalidReceiptLineException('purchaseOrderLineId is not on this purchase order');
        if (lineDto.productId && lineDto.productId !== poLine.productId) {
          throw new InvalidReceiptLineException('productId does not match the purchase order line');
        }
        const qty = new Decimal(lineDto.qty);
        requestedByPoLine.set(poLine.id, (requestedByPoLine.get(poLine.id) ?? new Decimal(0)).plus(qty));
        prepared.push({
          purchaseOrderLineId: poLine.id,
          productId: poLine.productId,
          productName: poLine.productName,
          productSku: poLine.productSku,
          unit: poLine.unit,
          qty,
          unitCost: poLine.unitPrice,
        });
      }

      for (const [lineId, requested] of requestedByPoLine) {
        const poLine = poLineById.get(lineId)!;
        const remaining = poLine.qty.minus(poLine.qtyReceived);
        if (requested.greaterThan(remaining)) {
          throw new OverReceiptException(lineId, remaining.toString(), requested.toString());
        }
      }
    } else {
      if (!dto.warehouseId) throw new ReceiptWarehouseRequiredException();
      warehouseId = dto.warehouseId;
      supplierId = dto.supplierId ?? null;
      if (supplierId) {
        const supplier = await tx.supplier.findFirst({ where: { id: supplierId, deletedAt: null } });
        if (!supplier) throw new SupplierNotFoundException();
        if (!supplier.isActive) throw new SupplierInactiveException();
      }

      const productIds = [...new Set(dto.lines.map((l) => l.productId).filter((v): v is string => !!v))];
      const products = await tx.product.findMany({ where: { id: { in: productIds }, deletedAt: null } });
      const productById = new Map(products.map((p) => [p.id, p]));
      for (const lineDto of dto.lines) {
        if (lineDto.purchaseOrderLineId) {
          throw new InvalidReceiptLineException('purchaseOrderLineId given without purchaseOrderId');
        }
        if (!lineDto.productId) throw new InvalidReceiptLineException('productId is required');
        const product = productById.get(lineDto.productId);
        if (!product) throw new ProductNotFoundException();
        prepared.push({
          purchaseOrderLineId: null,
          productId: product.id,
          productName: product.name,
          productSku: product.sku,
          unit: product.baseUnit,
          qty: new Decimal(lineDto.qty),
          unitCost: lineDto.unitCost !== undefined ? new Decimal(lineDto.unitCost) : null,
        });
      }
    }
    await this.assertActiveWarehouse(tx, warehouseId);

    let receipt;
    try {
      // SAVEPOINT so a unique violation (parallel duplicate clientId) doesn't
      // abort the request transaction before we can read the winner's row.
      receipt = await withSavepoint(tx, 'goods_receipt_create', () =>
        tx.goodsReceipt.create({
          data: {
            companyId: user.companyId,
            clientId: dto.clientId,
            warehouseId,
            purchaseOrderId: po?.id ?? null,
            supplierId,
            receivedById: user.id,
            note: dto.note,
            lines: { create: prepared.map((l) => ({ companyId: user.companyId, ...l })) },
          },
          include: { lines: true },
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.findReceiptByClientId(tx, dto.clientId);
        if (existing) return existing;
      }
      throw err;
    }

    // One RECEIVE movement per receipt line; StockLevel rows touched in
    // productId order so concurrent receipts can't deadlock on each other.
    const byProduct = [...receipt.lines].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
    for (const line of byProduct) {
      await this.stock.receiveForRef(tx, {
        companyId: user.companyId,
        productId: line.productId,
        warehouseId,
        qty: line.qty,
        refType: 'GoodsReceipt',
        refId: receipt.id,
      });
    }

    if (po) {
      for (const [lineId, requested] of [...requestedByPoLine].sort(([a], [b]) => (a < b ? -1 : 1))) {
        await tx.purchaseOrderLine.update({ where: { id: lineId }, data: { qtyReceived: { increment: requested } } });
      }
      const after = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: po.id },
        select: { qty: true, qtyReceived: true },
      });
      const fully = after.every((l) => l.qtyReceived.greaterThanOrEqualTo(l.qty));
      const nextStatus = fully ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIALLY_RECEIVED;
      if (nextStatus !== po.status) {
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: nextStatus } });
        await this.auditTransition(tx, user, po.id, po.status, nextStatus);
      }
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'goods_receipt.create',
      entity: 'GoodsReceipt',
      entityId: receipt.id,
      newValue: toAuditJson(receipt),
    });
    return receipt;
  }

  // ------------------------------------------------------------------ helpers

  private findReceiptByClientId(tx: TenantClient, clientId: string) {
    return tx.goodsReceipt.findUnique({
      where: { companyId_clientId: { companyId: this.tenantPrisma.companyId, clientId } },
      include: { lines: true },
    });
  }

  /** SELECT … FOR UPDATE on the PO header (RLS-scoped — another tenant's id is "not found"). */
  private async lockPurchaseOrder(tx: TenantClient, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${id}::uuid FOR UPDATE
    `);
    if (rows.length === 0) throw new PurchaseOrderNotFoundException();
    const po = await tx.purchaseOrder.findUnique({
      where: { id },
      select: { id: true, status: true, warehouseId: true, supplierId: true },
    });
    if (!po) throw new PurchaseOrderNotFoundException();
    return po;
  }

  private async assertActiveWarehouse(tx: TenantClient, warehouseId: string) {
    const warehouse = await tx.warehouse.findFirst({ where: { id: warehouseId, isActive: true } });
    if (!warehouse) throw new WarehouseNotFoundException();
  }

  private async auditTransition(
    tx: TenantClient,
    user: AuthenticatedUser,
    id: string,
    from: PurchaseOrderStatus,
    to: PurchaseOrderStatus,
  ) {
    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'purchase_order.status',
      entity: 'PurchaseOrder',
      entityId: id,
      oldValue: toAuditJson({ status: from }),
      newValue: toAuditJson({ status: to }),
    });
  }
}
