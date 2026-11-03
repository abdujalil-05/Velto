import { Injectable } from '@nestjs/common';
import { Prisma, StockMovementType, type StockMovement, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../common/auth/auth.types';
import { paginate, resolveSort } from '../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  InsufficientStockException,
  InvalidStockQtyException,
  StockMovementAlreadyReversedException,
  StockMovementNotFoundException,
  StockMovementNotReversibleException,
  StockProductNotFoundException,
  StockReversalInsufficientException,
  StockReversalReasonRequiredException,
  WarehouseNotFoundException,
} from './stock-exceptions';
import type { AdjustStockDto } from './dto/adjust-stock.dto';
import type { ListMovementsQueryDto } from './dto/list-movements.query';
import type { ListStockQueryDto } from './dto/list-stock.query';
import { OwnerAlertsService } from '../notifications/owner-alerts';
import { endOfDay, startOfDay } from '../analytics/report-utils';
import type { ReceiveStockDto } from './dto/receive-stock.dto';

export interface StockMoveParams {
  companyId: string;
  productId: string;
  warehouseId: string;
  qty: Prisma.Decimal.Value;
  refType: string;
  refId: string;
}

/** F2.1 / §6.4: only manual RECEIVE/ADJUST that are not themselves reversals can be reversed. */
export function isReversibleMovementKind(m: { type: StockMovementType; refType: string | null; reversesMovementId: string | null }): boolean {
  return (
    (m.type === StockMovementType.RECEIVE || m.type === StockMovementType.ADJUST) && m.refType === 'Manual' && m.reversesMovementId === null
  );
}

@Injectable()
export class StockService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
    private readonly ownerAlerts: OwnerAlertsService,
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

  async listMovements(query: ListMovementsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.StockMovementWhereInput = {
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: startOfDay(new Date(query.from)) } : {}),
              ...(query.to ? { lte: endOfDay(new Date(query.to)) } : {}),
            },
          }
        : {}),
    };
    const orderBy = resolveSort<Prisma.StockMovementOrderByWithRelationInput[]>(
      query,
      { createdAt: (dir) => [{ createdAt: dir }, { id: dir }], qty: (dir) => [{ qty: dir }, { id: 'desc' }] },
      [{ createdAt: 'desc' }, { id: 'desc' }],
    );

    const [rows, total] = await Promise.all([
      tx.stockMovement.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { reversedBy: { select: { id: true } } },
      }),
      tx.stockMovement.count({ where }),
    ]);

    return paginate(
      rows.map((m) => ({
        id: m.id,
        type: m.type,
        qty: m.qty.toString(),
        productId: m.productId,
        warehouseId: m.warehouseId,
        createdAt: m.createdAt,
        reason: m.reason,
        reversesMovementId: m.reversesMovementId,
        reversedBy: m.reversedBy?.id ?? null,
        reversible: isReversibleMovementKind(m) && m.reversedBy === null,
      })),
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

    const movement = await this.applyAdjust(tx, {
      companyId: user.companyId,
      productId: dto.productId,
      warehouseId: dto.warehouseId,
      qty: dto.qty,
      refType: 'Manual',
      note: dto.reason,
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'stock.adjust',
      entity: 'StockMovement',
      entityId: movement.id,
      newValue: toAuditJson(movement),
    });
    // ADR-060a: OWNER alert in this same tx — if it fails the whole adjustment rolls back.
    await this.ownerAlerts.stockAdjusted(tx, { companyId: user.companyId, movementId: movement.id, productId: movement.productId, warehouseId: movement.warehouseId, qty: movement.qty, at: movement.createdAt });

    return this.getLevel(tx, dto.productId, dto.warehouseId);
  }

  /**
   * F6 opening stock: the same ADJUST path as adjust() (StockLevel row lock,
   * onHand/reserved floor, append-only movement), tagged with a reference
   * document instead of 'Manual'. Callers lock pairs in (productId,
   * warehouseId) order first (lockLevelsForUpdate) and write the audit row.
   */
  async adjustForRef(tx: TenantClient, params: StockMoveParams & { note?: string }) {
    return this.applyAdjust(tx, params);
  }

  /**
   * Ensures StockLevel rows exist for `pairs` and locks them FOR UPDATE in
   * (productId, warehouseId) order — the one lock order every bulk stock
   * writer uses, so two bulk writers cannot deadlock.
   */
  async lockLevelsForUpdate(
    tx: TenantClient,
    pairs: { productId: string; warehouseId: string }[],
  ): Promise<{ productId: string; warehouseId: string; onHand: Prisma.Decimal; reserved: Prisma.Decimal }[]> {
    if (pairs.length === 0) return [];
    const productIds = pairs.map((p) => p.productId);
    const warehouseIds = pairs.map((p) => p.warehouseId);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockLevel" ("productId", "warehouseId", "onHand", "reserved", "updatedAt")
      SELECT t.p, t.w, 0, 0, CURRENT_TIMESTAMP
      FROM unnest(${productIds}::uuid[], ${warehouseIds}::uuid[]) AS t(p, w)
      ORDER BY t.p, t.w
      ON CONFLICT ("productId", "warehouseId") DO NOTHING
    `);
    return tx.$queryRaw(Prisma.sql`
      SELECT sl."productId"::text AS "productId", sl."warehouseId"::text AS "warehouseId", sl."onHand", sl."reserved"
      FROM "StockLevel" sl
      JOIN unnest(${productIds}::uuid[], ${warehouseIds}::uuid[]) AS t(p, w) ON sl."productId" = t.p AND sl."warehouseId" = t.w
      ORDER BY sl."productId", sl."warehouseId"
      FOR UPDATE OF sl
    `);
  }

  private async applyAdjust(tx: TenantClient, params: Omit<StockMoveParams, 'refId'> & { refId?: string; note?: string }) {
    await this.ensureStockLevelRow(tx, params.productId, params.warehouseId);
    const qty = new Prisma.Decimal(params.qty);

    const locked = await this.lockStockLevel(tx, params.productId, params.warehouseId);
    const resultingOnHand = locked.onHand.plus(qty);
    if (resultingOnHand.isNegative()) {
      throw new InvalidStockQtyException(
        `Adjustment would take on-hand stock negative (current: ${locked.onHand.toString()}, adjustment: ${qty.toString()})`,
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
      where: { productId_warehouseId: { productId: params.productId, warehouseId: params.warehouseId } },
      data: { onHand: { increment: qty } },
    });

    return tx.stockMovement.create({
      data: {
        companyId: params.companyId,
        productId: params.productId,
        warehouseId: params.warehouseId,
        type: StockMovementType.ADJUST,
        qty,
        refType: params.refType,
        refId: params.refId,
        note: params.note,
      },
    });
  }

  /**
   * F2.1 / §6.4: compensates a manual RECEIVE/ADJUST with a new movement of
   * the same type and opposite sign (reversesMovementId + reason); the
   * original row is never touched (DB trigger). Document-linked receipts
   * (refType != 'Manual', e.g. GoodsReceipt) are refused — reversing them here
   * would desync the source document. StockLevel is locked before the
   * already-reversed check so two concurrent reversals serialize.
   */
  async reverseMovement(movementId: string, reason: string, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const trimmedReason = reason?.trim() ?? '';
    if (trimmedReason.length < 3) throw new StockReversalReasonRequiredException();

    const original = await tx.stockMovement.findUnique({ where: { id: movementId } });
    if (!original) throw new StockMovementNotFoundException();
    if (!isReversibleMovementKind(original)) throw new StockMovementNotReversibleException(original.type, original.refType);

    const reversal = await this.compensate(tx, original, trimmedReason, user.companyId);

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'stock.reverse',
      entity: 'StockMovement',
      entityId: reversal.id,
      oldValue: toAuditJson(original),
      newValue: toAuditJson(reversal),
    });
    // ADR-060a: compensate() changed onHand by reversal.qty; alert in the same tx.
    await this.ownerAlerts.stockReversed(tx, { companyId: user.companyId, movementId: reversal.id, productId: reversal.productId, warehouseId: reversal.warehouseId, qty: reversal.qty, at: reversal.createdAt });

    return { movement: reversal, level: await this.getLevel(tx, original.productId, original.warehouseId) };
  }

  /**
   * F6: compensates a reference-document movement (opening stock void). The
   * caller decides eligibility (the reference document's own rules), holds
   * the StockLevel lock order and writes the audit row.
   */
  async reverseForRef(tx: TenantClient, original: StockMovement, reason: string, companyId: string) {
    return this.compensate(tx, original, reason, companyId);
  }

  /**
   * Same-type, opposite-sign movement pointing at `original` (reversesMovementId
   * + reason, same refType/refId); the original row is never touched. StockLevel
   * is locked before the already-reversed check so two reversals serialize.
   */
  private async compensate(tx: TenantClient, original: StockMovement, reason: string, companyId: string) {
    const locked = await this.lockStockLevel(tx, original.productId, original.warehouseId);
    const existing = await tx.stockMovement.findUnique({ where: { reversesMovementId: original.id }, select: { id: true } });
    if (existing) throw new StockMovementAlreadyReversedException();

    const delta = original.qty.negated();
    const resultingOnHand = locked.onHand.plus(delta);
    if (resultingOnHand.isNegative() || resultingOnHand.lessThan(locked.reserved)) {
      throw new StockReversalInsufficientException(locked.onHand.toString(), locked.reserved.toString(), delta.toString());
    }

    await tx.stockLevel.update({
      where: { productId_warehouseId: { productId: original.productId, warehouseId: original.warehouseId } },
      data: { onHand: { increment: delta } },
    });

    return tx.stockMovement.create({
      data: {
        companyId,
        productId: original.productId,
        warehouseId: original.warehouseId,
        type: original.type,
        qty: delta,
        refType: original.refType,
        refId: original.refId,
        reversesMovementId: original.id,
        reason,
      },
    });
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
    // Raw INSERT ... ON CONFLICT DO NOTHING instead of Prisma upsert: two
    // concurrent first receipts for the same (product, warehouse) would both
    // miss in upsert's SELECT and the loser would hit P2002. Here the loser
    // just waits on the winner's row and no-ops; callers then lock/update it.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "StockLevel" ("productId", "warehouseId", "onHand", "reserved", "updatedAt")
      VALUES (${productId}::uuid, ${warehouseId}::uuid, 0, 0, CURRENT_TIMESTAMP)
      ON CONFLICT ("productId", "warehouseId") DO NOTHING
    `);
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
