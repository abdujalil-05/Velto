import { Injectable } from '@nestjs/common';
import type { Prisma, TenantClient } from '@velto/database';
import type { LocalizedMessage } from '../../common/errors/app-exception';
import { NotificationsService } from './notifications.service';

const TZ = 'Asia/Tashkent';
const REASON_MAX = 200;

/** Notification types that go to OWNERs only; delivery re-checks the OWNER role at send time. */
export const OWNER_ALERT_TYPES: ReadonlySet<string> = new Set(['payment.reversed', 'stock.adjusted', 'stock.reversed']);

export interface OwnerAlertActor {
  firstName: string;
  lastName: string;
}

export interface PaymentReversedAlert {
  companyId: string;
  reversalId: string;
  paymentId: string;
  paymentNumber: string;
  amount: Prisma.Decimal;
  actor: OwnerAlertActor;
  reason: string;
  at: Date;
}

export interface StockAlert {
  companyId: string;
  /** The movement created by the operation (adjust movement / reversal movement). */
  movementId: string;
  productId: string;
  warehouseId: string;
  qty: Prisma.Decimal;
  actor: OwnerAlertActor;
  reason: string;
  at: Date;
}

/** "2026-10-31 14:05" in Asia/Tashkent, independent of the server TZ. */
export function formatTashkent(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}`;
}

const actorName = (a: OwnerAlertActor) => `${a.firstName} ${a.lastName}`.trim();
const clip = (s: string) => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX)}…` : s);
const signed = (q: Prisma.Decimal) => (q.isNegative() ? q.toString() : `+${q.toString()}`);

/**
 * ADR-060a: critical-operation alerts to the company's OWNERs. Recipients are resolved inside the caller's tx
 * (active users who currently hold the OWNER role in this company); one deduplicated Notification per OWNER is
 * inserted in that same tx, so the alert commits/rolls back with the operation. Telegram delivery is async.
 * Content: no phone numbers or credentials.
 */
@Injectable()
export class OwnerAlertsService {
  constructor(private readonly notifications: NotificationsService) {}

  async ownerIds(tx: TenantClient, companyId: string): Promise<string[]> {
    const owners = await tx.user.findMany({
      where: { companyId, isActive: true, roles: { some: { role: { code: 'OWNER', companyId } } } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return owners.map((o) => o.id);
  }

  async paymentReversed(tx: TenantClient, a: PaymentReversedAlert): Promise<void> {
    if (a.amount.isZero()) return;
    const amount = `${a.amount.toFixed(2)} UZS`;
    const when = formatTashkent(a.at);
    const reason = clip(a.reason);
    const who = actorName(a.actor);
    const title: LocalizedMessage = { uz: "To'lov bekor qilindi", ru: 'Платёж отменён', en: 'Payment reversed' };
    const message: LocalizedMessage = {
      uz: `Summa: ${amount}\nTo'lov: ${a.paymentNumber}\nKim: ${who}\nSabab: ${reason}\nVaqt: ${when}\nHolat: REVERSED`,
      ru: `Сумма: ${amount}\nПлатёж: ${a.paymentNumber}\nКто: ${who}\nПричина: ${reason}\nВремя: ${when}\nСтатус: REVERSED`,
      en: `Amount: ${amount}\nPayment: ${a.paymentNumber}\nBy: ${who}\nReason: ${reason}\nTime: ${when}\nStatus: REVERSED`,
    };
    await this.send(tx, a.companyId, { type: 'payment.reversed', title, message, entityType: 'Payment', entityId: a.paymentId, dedupKey: `payment.reverse:${a.reversalId}` });
  }

  stockAdjusted(tx: TenantClient, a: StockAlert): Promise<void> {
    return this.stock(tx, a, 'stock.adjusted', 'stock.adjust', { uz: 'Ombor qoldig\'i tuzatildi', ru: 'Корректировка остатка', en: 'Stock adjusted' });
  }

  stockReversed(tx: TenantClient, a: StockAlert): Promise<void> {
    return this.stock(tx, a, 'stock.reversed', 'stock.reverse', { uz: 'Ombor harakati bekor qilindi', ru: 'Складское движение отменено', en: 'Stock movement reversed' });
  }

  private async stock(tx: TenantClient, a: StockAlert, type: string, dedupPrefix: string, title: LocalizedMessage): Promise<void> {
    if (a.qty.isZero()) return;
    const [product, warehouse] = await Promise.all([
      tx.product.findUnique({ where: { id: a.productId }, select: { name: true, sku: true, baseUnit: true } }),
      tx.warehouse.findUnique({ where: { id: a.warehouseId }, select: { name: true } }),
    ]);
    const item = `${product?.name ?? '?'} (${product?.sku ?? '?'})`;
    const delta = `${signed(a.qty)} ${product?.baseUnit ?? ''}`.trim();
    const wh = warehouse?.name ?? '?';
    const when = formatTashkent(a.at);
    const reason = clip(a.reason);
    const who = actorName(a.actor);
    const message: LocalizedMessage = {
      uz: `Mahsulot: ${item}\nOmbor: ${wh}\nO'zgarish: ${delta}\nKim: ${who}\nSabab: ${reason}\nVaqt: ${when}`,
      ru: `Товар: ${item}\nСклад: ${wh}\nИзменение: ${delta}\nКто: ${who}\nПричина: ${reason}\nВремя: ${when}`,
      en: `Product: ${item}\nWarehouse: ${wh}\nChange: ${delta}\nBy: ${who}\nReason: ${reason}\nTime: ${when}`,
    };
    await this.send(tx, a.companyId, { type, title, message, entityType: 'StockMovement', entityId: a.movementId, dedupKey: `${dedupPrefix}:${a.movementId}` });
  }

  private async send(tx: TenantClient, companyId: string, input: { type: string; title: LocalizedMessage; message: LocalizedMessage; entityType: string; entityId: string; dedupKey: string }): Promise<void> {
    await this.notifications.notifyMany(tx, await this.ownerIds(tx, companyId), input);
  }
}
