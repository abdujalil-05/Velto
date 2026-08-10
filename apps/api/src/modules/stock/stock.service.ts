import { Injectable } from '@nestjs/common';
import { Prisma, StockMovementType, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { paginate, resolveSort } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  InsufficientStockException,
  InvalidStockQtyException,
  StockProductNotFoundException,
  WarehouseNotFoundException,
} from './stock-exceptions';
import type { AdjustStockDto } from './dto/adjust-stock.dto';
import type { ListStockQueryDto } from './dto/list-stock.query';
import type { ReceiveStockDto } from './dto/receive-stock.dto';

export interface StockMoveParams {
  companyId: string;
  productId: string;
  warehouseId: string;
  qty: Prisma.Decimal.Value;
  refType: string;
  refId: string;
}

@Injectable()
export class StockService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(query: ListStockQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.StockLevelWhereInput = {
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
    };

    const orderBy = resolveSort<Prisma.StockLevelOrderByWithRelationInput[]>(
      query,
      {
        product: (dir) => [{ product: { name: dir } }],
        warehouse: (dir) => [{ warehouse: { name: dir } }],
        onHand: (dir) => [{ onHand: dir }],
        reserved: (dir) => [{ reserved: dir }],
      },
      [{ warehouseId: 'asc' }, { product: { name: 'asc' } }],
    );

    const [data, total] = await Promise.all([
      tx.stockLevel.findMany({
        where,
        include: { product: { select: { id: true, sku: true, name: true, baseUnit: true } }, warehouse: { select: { id: true, name: true } } },
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.stockLevel.count({ where }),
    ]);

    return paginate(
      data.map((row) => ({ ...row, available: row.onHand.minus(row.reserved) })),
      total,
      query.page,
      query.pageSize,
    );
  }

  async receive(dto: ReceiveStockDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    await this.assertProductAndWarehouseExist(tx, dto.productId, dto.warehouseId);
    await this.ensureStockLevelRow(tx, dto.productId, dto.warehouseId);

    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId: dto.productId, warehouseId: dto.warehouseId } },
      data: { onHand: { increment: dto.qty } },
    });

    const movement = await tx.stockMovement.create({
      data: {
        companyId: user.companyId,
        productId: dto.productId,
        warehouseId: dto.warehouseId,
        type: StockMovementType.RECEIVE,
        qty: dto.qty,
        refType: 'Manual',
        note: dto.note,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'stock.receive',
      entity: 'StockMovement',
      entityId: movement.id,
      newValue: toAuditJson(movement),
    });

    return this.getLevel(tx, dto.productId, dto.warehouseId);
  }

  async adjust(dto: AdjustStockDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    await this.assertProductAndWarehouseExist(tx, dto.productId, dto.warehouseId);
    await this.ensureStockLevelRow(tx, dto.productId, dto.warehouseId);

    const locked = await this.lockStockLevel(tx, dto.productId, dto.warehouseId);
    const resultingOnHand = locked.onHand.plus(dto.qty);
    if (resultingOnHand.isNegative()) {
      throw new InvalidStockQtyException(
        `Adjustment would take on-hand stock negative (current: ${locked.onHand.toString()}, adjustment: ${dto.qty})`,
      );
    }
    // onHand must never drop below what's already reserved for pending
    // orders — otherwise issue() (below) would have to either go negative
    // itself or silently under-deliver a confirmed order.
    if (resultingOnHand.lessThan(locked.reserved)) {
      throw new InvalidStockQtyException(
        `Adjustment would take on-hand stock (${resultingOnHand.toString()}) below what's already reserved (${locked.reserved.toString()}) for pending orders`,
      );
    }

    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId: dto.productId, warehouseId: dto.warehouseId } },
      data: { onHand: { increment: dto.qty } },
    });

    const movement = await tx.stockMovement.create({
      data: {
        companyId: user.companyId,
        productId: dto.productId,
        warehouseId: dto.warehouseId,
        type: StockMovementType.ADJUST,
        qty: dto.qty,
        refType: 'Manual',
        note: dto.reason,
      },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'stock.adjust',
      entity: 'StockMovement',
      entityId: movement.id,
      newValue: toAuditJson(movement),
    });

    return this.getLevel(tx, dto.productId, dto.warehouseId);
  }

  /**
   * Same on-hand increment as receive(), but tagged with a reference
   * document (e.g. an inbound receipt) instead of 'Manual' — for other modules
   * to call (11.2: "Modullar bir-biriga faqat servis interfeysi orqali
   * murojaat qiladi"), mirroring reserve/release/issue below.
   */
  async receiveForRef(tx: TenantClient, params: StockMoveParams): Promise<void> {
    await this.ensureStockLevelRow(tx, params.productId, params.warehouseId);
    const qty = new Prisma.Decimal(params.qty);

    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId: params.productId, warehouseId: params.warehouseId } },
      data: { onHand: { increment: qty } },
    });

    await tx.stockMovement.create({
      data: {
        companyId: params.companyId,
        productId: params.productId,
        warehouseId: params.warehouseId,
        type: StockMovementType.RECEIVE,
        qty,
        refType: params.refType,
        refId: params.refId,
      },
    });
  }

  /**
   * F-M03 / 8.3: reserves stock for a confirmed sales order. Row-locked via
   * `SELECT ... FOR UPDATE` so two concurrent reservations against the last
   * unit serialize instead of both succeeding — the loser gets
   * InsufficientStockException instead of oversold stock.
   */
  async reserve(tx: TenantClient, params: StockMoveParams): Promise<void> {
    await this.ensureStockLevelRow(tx, params.productId, params.warehouseId);
    const locked = await this.lockStockLevel(tx, params.productId, params.warehouseId);
    const qty = new Prisma.Decimal(params.qty);
    const available = locked.onHand.minus(locked.reserved);

    if (available.lessThan(qty)) {
      throw new InsufficientStockException(available.toString(), qty.toString());
    }

    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId: params.productId, warehouseId: params.warehouseId } },
      data: { reserved: { increment: qty } },
    });

    await tx.stockMovement.create({
      data: {
        companyId: params.companyId,
        productId: params.productId,
        warehouseId: params.warehouseId,
        type: StockMovementType.RESERVE,
        qty,
        refType: params.refType,
        refId: params.refId,
      },
    });
  }

  /** Cancels a reservation without consuming stock (e.g. order cancelled before delivery). */
  async release(tx: TenantClient, params: StockMoveParams): Promise<void> {
    const locked = await this.lockStockLevel(tx, params.productId, params.warehouseId);
    const qty = new Prisma.Decimal(params.qty);

    if (locked.reserved.lessThan(qty)) {
      throw new InvalidStockQtyException(
        `Cannot release ${qty.toString()} — only ${locked.reserved.toString()} is reserved`,
      );
    }

    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId: params.productId, warehouseId: params.warehouseId } },
      data: { reserved: { decrement: qty } },
    });

    await tx.stockMovement.create({
      data: {
        companyId: params.companyId,
        productId: params.productId,
        warehouseId: params.warehouseId,
        type: StockMovementType.RELEASE,
        qty,
        refType: params.refType,
        refId: params.refId,
      },
    });
  }

  /** Consumes a reservation as goods physically leave the warehouse (delivery). */
  async issue(tx: TenantClient, params: StockMoveParams): Promise<void> {
    const locked = await this.lockStockLevel(tx, params.productId, params.warehouseId);
    const qty = new Prisma.Decimal(params.qty);

    if (locked.reserved.lessThan(qty)) {
      throw new InvalidStockQtyException(
        `Cannot issue ${qty.toString()} — only ${locked.reserved.toString()} is reserved`,
      );
    }
    // onHand is physically what's in the warehouse — it can never go
    // negative, even if a prior adjust()/receive() left reserved > onHand
    // (adjust() now blocks that itself, but this stays as the hard floor).
    if (locked.onHand.lessThan(qty)) {
      throw new InvalidStockQtyException(`Cannot issue ${qty.toString()} — only ${locked.onHand.toString()} is on hand`);
    }

    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId: params.productId, warehouseId: params.warehouseId } },
      data: { onHand: { decrement: qty }, reserved: { decrement: qty } },
    });

    await tx.stockMovement.create({
      data: {
        companyId: params.companyId,
        productId: params.productId,
        warehouseId: params.warehouseId,
        type: StockMovementType.ISSUE,
        qty,
        refType: params.refType,
        refId: params.refId,
      },
    });
  }

  private async getLevel(tx: TenantClient, productId: string, warehouseId: string) {
    const level = await tx.stockLevel.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } });
    return level ? { ...level, available: level.onHand.minus(level.reserved) } : null;
  }

  private async ensureStockLevelRow(tx: TenantClient, productId: string, warehouseId: string) {
    await tx.stockLevel.upsert({
      where: { productId_warehouseId: { productId, warehouseId } },
      update: {},
      create: { productId, warehouseId, onHand: 0, reserved: 0 },
    });
  }

  private async lockStockLevel(tx: TenantClient, productId: string, warehouseId: string) {
    const rows = await tx.$queryRaw<{ onHand: Prisma.Decimal; reserved: Prisma.Decimal }[]>(Prisma.sql`
      SELECT "onHand", "reserved" FROM "StockLevel"
      WHERE "productId" = ${productId}::uuid AND "warehouseId" = ${warehouseId}::uuid
      FOR UPDATE
    `);
    const row = rows[0];
    if (!row) throw new StockProductNotFoundException();
    return row;
  }

  private async assertProductAndWarehouseExist(tx: TenantClient, productId: string, warehouseId: string) {
    const [product, warehouse] = await Promise.all([
      tx.product.findFirst({ where: { id: productId, deletedAt: null } }),
      tx.warehouse.findFirst({ where: { id: warehouseId, isActive: true } }),
    ]);
    if (!product) throw new StockProductNotFoundException();
    if (!warehouse) throw new WarehouseNotFoundException();
  }
}
