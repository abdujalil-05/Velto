import { Prisma } from '@velto/database';
import type { UnsupportedReason, UnsupportedViolation } from './export-1c-exceptions';

/**
 * ADR-059 strict reject. mappingVersion 2 (XML/CSV) carries per line only: sku/externalCode, qty (BASE unit),
 * unitPrice (per base unit), lineTotal; header: total. A reader reconstructs lineTotal = qty × unitPrice, so a
 * line is representable only when that holds exactly and nothing hidden (discount, VAT, packaging) exists.
 * Values are compared against the authoritative snapshots (InvoiceLine; discount/packaging from SalesOrderLine).
 */
export interface CheckLine {
  productId: string;
  sku: string;
  qty: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  vatRate: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

export interface CheckInvoice {
  id: string;
  number: string;
  orderId: string | null;
  total: Prisma.Decimal;
  lines: CheckLine[];
}

export interface CheckOrderLine {
  orderId: string;
  productId: string;
  unitPrice: Prisma.Decimal;
  vatRate: Prisma.Decimal;
  discountPct: Prisma.Decimal;
  /** ProductPackaging.qtyInBaseUnit of the ordered packaging (1 = base unit). */
  packQtyInBase: Prisma.Decimal;
}

const D = Prisma.Decimal;

export function checkInvoiceRepresentable(invoice: CheckInvoice, orderLines: CheckOrderLine[]): UnsupportedViolation[] {
  const out: UnsupportedViolation[] = [];
  for (const line of invoice.lines) {
    const reasons: UnsupportedReason[] = [];
    // Order lines that this invoice line was copied from (same keys deliver() copies); none for order-less invoices.
    const src = orderLines.filter((o) => o.orderId === invoice.orderId && o.productId === line.productId && o.unitPrice.equals(line.unitPrice) && o.vatRate.equals(line.vatRate));
    if (src.some((o) => !o.discountPct.isZero())) reasons.push('DISCOUNT');
    if (!line.vatRate.isZero()) reasons.push('VAT');
    if (!line.qty.times(line.unitPrice).toDecimalPlaces(2, D.ROUND_HALF_UP).equals(line.lineTotal)) reasons.push('QTY_X_PRICE_MISMATCH');
    if (src.some((o) => !o.packQtyInBase.equals(1))) reasons.push('UNIT');
    if (reasons.length > 0) out.push({ invoiceId: invoice.id, invoiceNumber: invoice.number, sku: line.sku, reasons });
  }
  const sum = invoice.lines.reduce((s, l) => s.plus(l.lineTotal), new D(0));
  if (!sum.equals(invoice.total)) out.push({ invoiceId: invoice.id, invoiceNumber: invoice.number, sku: null, reasons: ['TOTAL_MISMATCH'] });
  return out;
}
