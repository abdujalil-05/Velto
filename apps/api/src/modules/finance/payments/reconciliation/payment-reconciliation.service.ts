import { Injectable } from '@nestjs/common';
import { Prisma, PaymentReconciliationOutcome, withSavepoint, type TenantClient } from '@velto/database';
import { AuditLogService, toAuditJson } from '../../../../common/audit/audit-log.service';
import type { AuthenticatedUser } from '../../../../common/auth/auth.types';
import { paginate } from '../../../../common/pagination/pagination.dto';
import { TenantPrismaService } from '../../../../common/tenant/tenant-prisma.service';
import { getTraceId } from '../../../../common/trace/trace-context';
import type {
  ConfirmPaymentReconciliationDto,
  ListPaymentReconciliationsQueryDto,
  PaymentReconciliationStatusDto,
} from '../../dto/payment-reconciliation.dto';
import {
  PaymentReconciliationContradictionException,
  PaymentReconciliationEvidenceRequiredException,
  PaymentReconciliationNoRejectedIntentException,
  PaymentReconciliationPaymentNotFoundException,
} from '../../finance-exceptions';

/** Only these 409s (rejection-audit.ts, entityId = existing Payment) open a reconcilable intent. */
export const RECONCILABLE_REJECTION_CODES = ['PAYMENT_IDEMPOTENCY_CONFLICT', 'PAYMENT_IDEMPOTENCY_UNVERIFIABLE'] as const;
const REJECTION_ACTION = 'payment.create_rejected';

const rejectionWhere = (paymentIds: string[]): Prisma.AuditLogWhereInput => ({
  action: REJECTION_ACTION,
  entity: 'Payment',
  entityId: { in: paymentIds },
  OR: RECONCILABLE_REJECTION_CODES.map((code) => ({ newValue: { path: ['reason'], equals: code } })),
});

const SNAPSHOT_SELECT = {
  id: true,
  number: true,
  clientId: true,
  customerId: true,
  amount: true,
  method: true,
  status: true,
  source: true,
  collectedBy: true,
  createdAt: true,
  handoverAt: true,
  handoverActorId: true,
  handoverRejectReason: true,
  allocations: { select: { id: true, invoiceId: true, amount: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
  reversal: { select: { id: true, reason: true, actorId: true, createdAt: true } },
  handoverCashSession: { select: { id: true, userId: true, openedAt: true, closedAt: true } },
} satisfies Prisma.PaymentSelect;

export type ReconciliationAgentStatus = 'OPEN' | PaymentReconciliationOutcome | 'UNKNOWN';

/**
 * PO 2026-11-02: durable, append-only decision for an offline payment intent
 * rejected with 409 PAYMENT_IDEMPOTENCY_CONFLICT/UNVERIFIABLE. Writes ONLY
 * PaymentIntentResolution + AuditLog; Payment, allocations, ledger, FIFO,
 * cachedBalance and cash sessions are read for the snapshot, never written.
 */
@Injectable()
export class PaymentReconciliationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async confirm(dto: ConfirmPaymentReconciliationDto, user: AuthenticatedUser) {
    if (dto.outcome === PaymentReconciliationOutcome.NOT_POSTED_CONFIRMED && !dto.evidenceRef) {
      throw new PaymentReconciliationEvidenceRequiredException();
    }
    const tx = this.tenantPrisma.client;
    // Serialises decisions per (company, clientId) without row-locking the
    // Payment itself, so handover/allocate/reverse flows are never blocked.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('velto.payment_reconcile'), hashtext(${user.companyId} || ':' || ${dto.clientId}))`,
    );

    const payment = await tx.payment.findUnique({
      where: { companyId_clientId: { companyId: user.companyId, clientId: dto.clientId } },
      select: { id: true },
    });
    if (!payment) throw new PaymentReconciliationPaymentNotFoundException(dto.clientId);

    const rejection = await tx.auditLog.findFirst({
      where: rejectionWhere([payment.id]),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, userId: true },
    });
    // Never infer NOT_POSTED (or anything) from the absence of a rejected replay.
    if (!rejection) throw new PaymentReconciliationNoRejectedIntentException(dto.clientId);

    const existing = await this.findResolution(tx, user.companyId, dto.clientId);
    if (existing) return this.replayOrContradict(tx, existing, dto);

    const originalUserId = rejection.userId;
    if (!originalUserId) throw new PaymentReconciliationNoRejectedIntentException(dto.clientId);
    const traceId = getTraceId() ?? null;

    let resolution;
    try {
      resolution = await withSavepoint(tx, 'payment_reconcile', () =>
        tx.paymentIntentResolution.create({
          data: {
            companyId: user.companyId,
            clientId: dto.clientId,
            paymentId: payment.id,
            outcome: dto.outcome,
            reason: dto.reason,
            evidenceRef: dto.evidenceRef ?? null,
            actorId: user.id,
            originalUserId,
            rejectionAuditId: rejection.id,
            traceId,
          },
        }),
      );
    } catch (err) {
      // Unique (companyId, clientId) race past the lock: same rules as a pre-existing row.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      const raced = await this.findResolution(tx, user.companyId, dto.clientId);
      if (!raced) throw err;
      return this.replayOrContradict(tx, raced, dto);
    }

    await this.auditLog.log(tx, {
      companyId: user.companyId,
      userId: user.id,
      action: 'payment.reconcile',
      entity: 'Payment',
      entityId: payment.id,
      newValue: toAuditJson({
        resolutionId: resolution.id,
        clientId: dto.clientId,
        outcome: dto.outcome,
        reason: dto.reason,
        evidenceRef: dto.evidenceRef ?? null,
        rejectionAuditId: rejection.id,
        originalUserId,
        traceId,
      }),
    });
    return { replayed: false, resolution, snapshot: await this.snapshot(tx, payment.id) };
  }

  async list(query: ListPaymentReconciliationsQueryDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    // SEC-023: a SALES_AGENT only sees intents they collected or whose rejected replay they sent (same rule as status()).
    const agentId = user.roles.includes('SALES_AGENT') ? user.id : null;
    const skip = (query.page - 1) * query.pageSize;
    if (query.status === 'RESOLVED') {
      const resolvedScope: Prisma.PaymentIntentResolutionWhereInput = agentId
        ? { OR: [{ originalUserId: agentId }, { payment: { collectedBy: agentId } }] }
        : {};
      const [data, total] = await Promise.all([
        tx.paymentIntentResolution.findMany({
          where: resolvedScope,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: query.pageSize,
          include: { payment: { select: { id: true, number: true, amount: true, status: true, customerId: true, collectedBy: true } } },
        }),
        tx.paymentIntentResolution.count({ where: resolvedScope }),
      ]);
      return paginate(data, total, query.page, query.pageSize);
    }
    // OPEN = payments with a reconcilable rejected replay and no decision yet (RLS scopes every table).
    const openCte = Prisma.sql`
      WITH rej AS (
        SELECT a."entityId" AS pid, count(*)::int AS cnt, max(a."createdAt") AS last_at,
               COALESCE(bool_or(a."userId" = ${agentId}::uuid), false) AS mine
        FROM "AuditLog" a
        WHERE a.action = ${REJECTION_ACTION} AND a.entity = 'Payment'
          AND a."newValue"->>'reason' IN (${Prisma.join([...RECONCILABLE_REJECTION_CODES])})
        GROUP BY a."entityId"
      ), open_intents AS (
        SELECT p.id AS "paymentId", p."clientId", p.number, p.amount::text AS amount, p.status::text AS status,
               p."customerId", p."collectedBy", rej.cnt AS "rejectionCount", rej.last_at AS "lastRejectedAt"
        FROM rej
        JOIN "Payment" p ON p.id = rej.pid
        LEFT JOIN "PaymentIntentResolution" r ON r."companyId" = p."companyId" AND r."clientId" = p."clientId"
        WHERE p."clientId" IS NOT NULL AND r.id IS NULL
          AND (${agentId}::uuid IS NULL OR p."collectedBy" = ${agentId}::uuid OR rej.mine)
      )`;
    const [data, totalRows] = await Promise.all([
      tx.$queryRaw<OpenReconciliationRow[]>(
        Prisma.sql`${openCte} SELECT * FROM open_intents ORDER BY "lastRejectedAt" DESC, "paymentId" LIMIT ${query.pageSize} OFFSET ${skip}`,
      ),
      tx.$queryRaw<{ total: number }[]>(Prisma.sql`${openCte} SELECT count(*)::int AS total FROM open_intents`),
    ]);
    return paginate(data, totalRows[0]?.total ?? 0, query.page, query.pageSize);
  }

  /**
   * Agent-facing (contract fixed for the Mini App). A clientId is visible only
   * when a reconcilable rejection was requested by this user or the payment was
   * collected by them; anything else (other user, other tenant, unknown, no
   * rejection) is UNKNOWN — indistinguishable, no existence leak.
   */
  async status(dto: PaymentReconciliationStatusDto, user: AuthenticatedUser) {
    const tx = this.tenantPrisma.client;
    const clientIds = [...new Set(dto.clientIds)];
    const payments = await tx.payment.findMany({
      where: { companyId: user.companyId, clientId: { in: clientIds } },
      select: { id: true, clientId: true, collectedBy: true },
    });
    const ids = payments.map((p) => p.id);
    const [rejections, resolutions] = ids.length
      ? await Promise.all([
          tx.auditLog.findMany({ where: rejectionWhere(ids), select: { entityId: true, userId: true } }),
          tx.paymentIntentResolution.findMany({
            where: { companyId: user.companyId, clientId: { in: clientIds } },
            select: { clientId: true, outcome: true, createdAt: true },
          }),
        ])
      : [[], []];
    const byClient = new Map(payments.map((p) => [p.clientId!, p]));
    const resolutionByClient = new Map(resolutions.map((r) => [r.clientId, r]));

    const items = clientIds.map((clientId): { clientId: string; status: ReconciliationAgentStatus; resolvedAt?: Date } => {
      const payment = byClient.get(clientId);
      if (!payment) return { clientId, status: 'UNKNOWN' };
      const own = rejections.filter((r) => r.entityId === payment.id);
      const visible = own.length > 0 && (payment.collectedBy === user.id || own.some((r) => r.userId === user.id));
      if (!visible) return { clientId, status: 'UNKNOWN' };
      const resolution = resolutionByClient.get(clientId);
      return resolution ? { clientId, status: resolution.outcome, resolvedAt: resolution.createdAt } : { clientId, status: 'OPEN' };
    });
    return { items };
  }

  private findResolution(tx: TenantClient, companyId: string, clientId: string) {
    return tx.paymentIntentResolution.findUnique({ where: { companyId_clientId: { companyId, clientId } } });
  }

  /** Same outcome -> idempotent replay (no second row, no second audit); different outcome -> 409. */
  private async replayOrContradict(
    tx: TenantClient,
    existing: NonNullable<Awaited<ReturnType<PaymentReconciliationService['findResolution']>>>,
    dto: ConfirmPaymentReconciliationDto,
  ) {
    if (existing.outcome !== dto.outcome) throw new PaymentReconciliationContradictionException(dto.clientId, existing.outcome);
    return { replayed: true, resolution: existing, snapshot: await this.snapshot(tx, existing.paymentId) };
  }

  private snapshot(tx: TenantClient, paymentId: string) {
    return tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: SNAPSHOT_SELECT });
  }
}

interface OpenReconciliationRow {
  paymentId: string;
  clientId: string;
  number: string;
  amount: string;
  status: string;
  customerId: string;
  collectedBy: string | null;
  rejectionCount: number;
  lastRejectedAt: Date;
}
