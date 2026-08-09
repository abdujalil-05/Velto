import { Injectable } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { DocumentNumberingService } from '../../../common/document-numbering/document-numbering.service';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { ProductNotFoundException } from '../../catalog/catalog-exceptions';
import { StockService } from '../../stock/stock.service';
import { WarehouseNotFoundException } from '../../stock/stock-exceptions';
import {
  EmptyPurchaseOrderException,
  EmptyReceiptException,
  InvalidPurchaseOrderTransitionException,
  OverReceiptException,
  PurchaseOrderLineNotFoundException,
  PurchaseOrderNotFoundException,
} from '../purchases-exceptions';
import { SuppliersService } from '../suppliers/suppliers.service';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import type { ListPurchaseOrdersQueryDto } from './dto/list-purchase-orders.query';
import type { ReceivePurchaseOrderDto } from './dto/receive-purchase-order.dto';

const PO_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  warehouse: { select: { id: true, name: true } },
  lines: { include: { product: { select: { id: true, sku: true, name: true, baseUnit: true } } } },
} satisfies Prisma.PurchaseOrderInclude;

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly suppliers: SuppliersService,
    private readonly stock: StockService,
    private readonly docNumbering: DocumentNumberingService,
  ) {}

  async list(query: ListPurchaseOrdersQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.PurchaseOrderWhereInput = {
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await Promise.all([
      tx.purchaseOrder.findMany({
        where,
        include: PO_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.purchaseOrder.count({ where }),
    ]);

    return paginate(data, total, query.page, query.pageSize);
  }

  async getById(id: string) {
    return this.getRaw(this.tenantPrisma.client, id);
  }

  async create(dto: CreatePurchaseOrderDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    if (dto.lines.length === 0) throw new EmptyPurchaseOrderException();

    await this.suppliers.findActiveOrThrow(tx, dto.supplierId);
    await this.assertWarehouseExists(tx, dto.warehouseId);

    // One batched lookup instead of one query per line; the validation loop
    // below still runs in `dto.lines` order and throws the same exception.
    const productIds = [...new Set(dto.lines.map((l) => l.productId))];
    const productRows = await tx.product.findMany({
      where: { id: { in: productIds }, deletedAt: null },
      select: { id: true },
    });
    const productById = new Map(productRows.map((p) => [p.id, p]));

    const lines: { productId: string; qty: number; unitPrice: number }[] = [];
    for (const lineDto of dto.lines) {
      const product = productById.get(lineDto.productId);
      if (!product) throw new ProductNotFoundException();
      lines.push({ productId: product.id, qty: lineDto.qty, unitPrice: lineDto.unitPrice });
    }

    const number = await this.docNumbering.next(tx, user.companyId, 'PO');
    const po = await tx.purchaseOrder.create({
      data: {
        companyId: user.companyId,
        number,
        supplierId: dto.supplierId,
        warehouseId: dto.warehouseId,
        createdById: user.id,
        note: dto.note,
        status: PurchaseOrderStatus.DRAFT,
        lines: { create: lines },
      },
      include: PO_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'purchaseOrder.create',
      entity: 'PurchaseOrder',
      entityId: po.id,
      newValue: toAuditJson(po),
    });

    return po;
  }

  /** DRAFT → ORDERED — sends the order to the supplier; no stock effect yet. */
  async submit(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const po = await this.getRaw(tx, id);
    if (po.status !== PurchaseOrderStatus.DRAFT) {
      throw new InvalidPurchaseOrderTransitionException(po.status, PurchaseOrderStatus.ORDERED);
    }

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.ORDERED },
      include: PO_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'purchaseOrder.submit',
      entity: 'PurchaseOrder',
      entityId: id,
      oldValue: toAuditJson({ status: po.status }),
      newValue: toAuditJson({ status: PurchaseOrderStatus.ORDERED }),
    });

    return updated;
  }

  /**
   * F-M09 / 5.3 "qabul (soddalashtirilgan)": ORDERED/PARTIALLY_RECEIVED →
   * PARTIALLY_RECEIVED, or RECEIVED once every line is fully received. Each
   * line's received qty is capped to what's still outstanding
   * (qty - qtyReceived so far, across however many receiving events it
   * takes). Stock lands via StockService.receiveForRef, tagged to this PO
   * (11.2: only via service interfaces) rather than writing StockLevel here.
   */
  async receive(id: string, dto: ReceivePurchaseOrderDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const po = await this.getRaw(tx, id);

    if (po.status !== PurchaseOrderStatus.ORDERED && po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED) {
      throw new InvalidPurchaseOrderTransitionException(po.status, PurchaseOrderStatus.RECEIVED);
    }
    if (dto.lines.length === 0) throw new EmptyReceiptException();

    const linesById = new Map(po.lines.map((l) => [l.id, l]));
    // Tracks qtyReceived across iterations of *this* request — po.lines is a
    // snapshot fetched once above, so without this, two dto.lines entries
    // for the same purchaseOrderLineId would both compute "remaining" from
    // the same pre-request value and let the over-receipt guard double-pass.
    const receivedSoFar = new Map(po.lines.map((l) => [l.id, l.qtyReceived]));

    for (const receiveLine of dto.lines) {
      const line = linesById.get(receiveLine.purchaseOrderLineId);
      if (!line) throw new PurchaseOrderLineNotFoundException();

      const alreadyReceived = receivedSoFar.get(line.id)!;
      const remaining = line.qty.minus(alreadyReceived);
      const qty = new Prisma.Decimal(receiveLine.qty);
      if (qty.greaterThan(remaining)) {
        throw new OverReceiptException(remaining.toString(), qty.toString());
      }

      await this.stock.receiveForRef(tx, {
        companyId: user.companyId,
        productId: line.productId,
        warehouseId: po.warehouseId,
        qty,
        refType: 'PurchaseOrder',
        refId: po.id,
      });

      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { qtyReceived: { increment: qty } },
      });
      receivedSoFar.set(line.id, alreadyReceived.plus(qty));
    }

    const refreshedLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: id } });
    const fullyReceived = refreshedLines.every((l) => l.qtyReceived.greaterThanOrEqualTo(l.qty));
    const newStatus = fullyReceived ? PurchaseOrderStatus.RECEIVED : PurchaseOrderStatus.PARTIALLY_RECEIVED;

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: newStatus },
      include: PO_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'purchaseOrder.receive',
      entity: 'PurchaseOrder',
      entityId: id,
      oldValue: toAuditJson({ status: po.status }),
      newValue: toAuditJson({ status: newStatus, receivedLines: dto.lines }),
    });

    return updated;
  }

  /** Only before anything has been received — DRAFT/ORDERED → CANCELLED. */
  async cancel(id: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const po = await this.getRaw(tx, id);

    if (po.status !== PurchaseOrderStatus.DRAFT && po.status !== PurchaseOrderStatus.ORDERED) {
      throw new InvalidPurchaseOrderTransitionException(po.status, PurchaseOrderStatus.CANCELLED);
    }

    const updated = await tx.purchaseOrder.update({
      where: { id },
      data: { status: PurchaseOrderStatus.CANCELLED },
      include: PO_INCLUDE,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'purchaseOrder.cancel',
      entity: 'PurchaseOrder',
      entityId: id,
      oldValue: toAuditJson({ status: po.status }),
      newValue: toAuditJson({ status: PurchaseOrderStatus.CANCELLED }),
    });

    return updated;
  }

  private async getRaw(tx: TenantClient, id: string) {
    const po = await tx.purchaseOrder.findFirst({ where: { id }, include: PO_INCLUDE });
    if (!po) throw new PurchaseOrderNotFoundException();
    return po;
  }

  private async assertWarehouseExists(tx: TenantClient, warehouseId: string) {
    const warehouse = await tx.warehouse.findFirst({ where: { id: warehouseId, isActive: true } });
    if (!warehouse) throw new WarehouseNotFoundException();
  }
}
