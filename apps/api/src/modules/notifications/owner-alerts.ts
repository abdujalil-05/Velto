import { Injectable } from '@nestjs/common';
import type { Prisma, TenantClient } from '@velto/database';
import type { LocalizedMessage } from '../../common/errors/app-exception';
import { NotificationsService } from './notifications.service';
import { safeValue } from './telegram-text';

const TZ = 'Asia/Tashkent';

/** Notification types that go to OWNERs only; delivery re-checks the OWNER role at send time. */
export const OWNER_ALERT_TYPES: ReadonlySet<string> = new Set(['payment.reversed', 'stock.adjusted', 'stock.reversed']);

export interface PaymentReversedAlert {
  companyId: string;
  reversalId: string;
  paymentId: string;
  paymentNumber: string;
  amount: Prisma.Decimal;
  at: Date;
}

export interface StockAlert {
  companyId: string;
  /** The movement created by the operation (adjust movement / reversal movement). */
  movementId: string;
  productId: string;
  warehouseId: string;
  qty: Prisma.Decimal;
  at: Date;
}

/** "2026-10-31 14:05" in Asia/Tashkent, independent of the server TZ. */
export function formatTashkent(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}`;
}

const DETAILS_LINE: LocalizedMessage = { uz: "Sabab va tafsilotlar Velto'da", ru: 'Причина и подробности доступны в Velto', en: 'Reason and details are available in Velto' };
const signed = (q: Prisma.Decimal) => (q.isNegative() ? q.toString() : `+${q.toString()}`);

/**
 * ADR-060a: critical-operation alerts to the company's OWNERs. Recipients are resolved inside the caller's tx
 * (active users who currently hold the OWNER role in this company); one deduplicated Notification per OWNER is
 * inserted in that same tx, so the alert commits/rolls back with the operation. Telegram delivery is async.
 * Content (ADR-060 privacy): allowlisted fields only. No free-text reason, no actor name, no phone numbers or
 * credentials; catalog values are sanitized and clipped. A fixed line points the OWNER to Velto for details.
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
    const number = safeValue(a.paymentNumber);
    const title: LocalizedMessage = { uz: "To'lov bekor qilindi", ru: 'Платёж отменён', en: 'Payment reversed' };
    const message: LocalizedMessage = {
      uz: `Summa: ${amount}\nTo'lov: ${number}\nVaqt: ${when}\nHolat: REVERSED\n${DETAILS_LINE.uz}`,
      ru: `Сумма: ${amount}\nПлатёж: ${number}\nВремя: ${when}\nСтатус: REVERSED\n${DETAILS_LINE.ru}`,
      en: `Amount: ${amount}\nPayment: ${number}\nTime: ${when}\nStatus: REVERSED\n${DETAILS_LINE.en}`,
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
    const item = `${safeValue(product?.name) || '?'} (${safeValue(product?.sku, 40) || '?'})`;
    const delta = `${signed(a.qty)} ${safeValue(product?.baseUnit, 20)}`.trim();
    const wh = safeValue(warehouse?.name) || '?';
    const when = formatTashkent(a.at);
    const message: LocalizedMessage = {
      uz: `Mahsulot: ${item}\nOmbor: ${wh}\nO'zgarish: ${delta}\nVaqt: ${when}\n${DETAILS_LINE.uz}`,
      ru: `Товар: ${item}\nСклад: ${wh}\nИзменение: ${delta}\nВремя: ${when}\n${DETAILS_LINE.ru}`,
      en: `Product: ${item}\nWarehouse: ${wh}\nChange: ${delta}\nTime: ${when}\n${DETAILS_LINE.en}`,
    };
    await this.send(tx, a.companyId, { type, title, message, entityType: 'StockMovement', entityId: a.movementId, dedupKey: `${dedupPrefix}:${a.movementId}` });
  }

  private async send(tx: TenantClient, companyId: string, input: { type: string; title: LocalizedMessage; message: LocalizedMessage; entityType: string; entityId: string; dedupKey: string }): Promise<void> {
    await this.notifications.notifyMany(tx, await this.ownerIds(tx, companyId), input);
  }
}
