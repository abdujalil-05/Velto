import { Injectable } from '@nestjs/common';
import { PaymentMethod, Prisma, type CashSession, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../common/audit/audit-log.service';
import { PermissionDeniedException } from '../../../common/auth/auth-exceptions';
import type { AuthenticatedUser } from '../../../common/auth/auth.types';
import { paginate } from '../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import type { CloseCashSessionDto } from '../dto/close-cash-session.dto';
import type { ListCashSessionsQueryDto } from '../dto/list-cash-sessions.query';
import type { OpenCashSessionDto } from '../dto/open-cash-session.dto';
import { CashSessionAlreadyOpenException, NoOpenCashSessionException } from '../finance-exceptions';

const USER_SELECT = { select: { id: true, firstName: true, lastName: true } } as const;

@Injectable()
export class CashSessionsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(query: ListCashSessionsQueryDto) {
    const tx = this.tenantPrisma.client;
    const where: Prisma.CashSessionWhereInput = query.userId ? { userId: query.userId } : {};

    const [data, total] = await Promise.all([
      tx.cashSession.findMany({
        where,
        include: { user: USER_SELECT },
        orderBy: { openedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      tx.cashSession.count({ where }),
    ]);

    return paginate(
      await Promise.all(data.map((session) => this.withSummary(tx, session))),
      total,
      query.page,
      query.pageSize,
    );
  }

  /** 9.2 "/cash": the caller's own current shift, if any. */
  async current(user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const session = await tx.cashSession.findFirst({ where: { userId: user.id, closedAt: null } });
    if (!session) throw new NoOpenCashSessionException();
    return this.withSummary(tx, session);
  }

  /** 9.2 "Smena ochish" — one open shift per user at a time. */
  async open(dto: OpenCashSessionDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const existing = await tx.cashSession.findFirst({ where: { userId: user.id, closedAt: null } });
    if (existing) throw new CashSessionAlreadyOpenException();

    let session;
    try {
      session = await tx.cashSession.create({
        data: { companyId: user.companyId, userId: user.id, openAmount: dto.openAmount },
      });
    } catch (err) {
      // The findFirst above is only a fast path — CashSession_userId_open_key
      // (a partial unique index, WHERE "closedAt" IS NULL) is the real guard
      // against two concurrent opens both racing past that pre-check.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new CashSessionAlreadyOpenException();
      }
      throw err;
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'cash.open',
      entity: 'CashSession',
      entityId: session.id,
      newValue: toAuditJson(session),
    });

    return this.withSummary(tx, session);
  }

  /**
   * 9.2 "yopish" — normally only the shift's own owner can close it (cash
   * reconciliation is a personal-accountability action, not a role-wide
   * one). OWNER can override — without this, an abandoned/forgotten session
   * (e.g. a terminated cashier's last shift) could never be closed by
   * anyone, since its own owner is gone.
   */
  async close(id: string, dto: CloseCashSessionDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // Row lock: without this, two concurrent close() calls for the same
    // session (double-submit / slow-network double-click) both read
    // closedAt === null before either writes, so both pass the guard below
    // and both update — a lost-update race on closeAmount plus a duplicate
    // audit-log entry for one close action. FOR UPDATE makes the second
    // request wait for the first to commit, so it then correctly sees
    // closedAt already set. Still subject to RLS (same connection/role as
    // every other query on this tx).
    await tx.$queryRaw`SELECT id FROM "CashSession" WHERE id = ${id}::uuid FOR UPDATE`;
    const session = await tx.cashSession.findFirst({ where: { id } });
    if (!session || session.closedAt) throw new NoOpenCashSessionException();
    if (session.userId !== user.id && !user.roles.includes('OWNER')) {
      throw new PermissionDeniedException('cash.close');
    }

    const updated = await tx.cashSession.update({
      where: { id },
      data: { closedAt: new Date(), closeAmount: dto.closeAmount },
    });

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'cash.close',
      entity: 'CashSession',
      entityId: id,
      oldValue: toAuditJson(session),
      newValue: toAuditJson(updated),
    });

    return this.withSummary(tx, updated);
  }

  /** "kunlik summalar" (9.2) — cash collected by this user during the shift's window. */
  private async withSummary(tx: TenantClient, session: CashSession) {
    const agg = await tx.payment.aggregate({
      where: {
        collectedBy: session.userId,
        method: PaymentMethod.CASH,
        createdAt: { gte: session.openedAt, ...(session.closedAt ? { lte: session.closedAt } : {}) },
      },
      _sum: { amount: true },
    });
    return { ...session, totalCollected: agg._sum.amount ?? new Prisma.Decimal(0) };
  }
}
