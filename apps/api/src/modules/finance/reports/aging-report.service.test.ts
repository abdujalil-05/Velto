import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { prisma, systemPrisma } from '@velto/database';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';
import { AgingReportQueryDto } from '../dto/aging-report.query';
import { AGING_EXCEL_HEADER_ROW, buildAgingReportExcel } from './aging-report-excel';
import { AgingReportService, type AgingBuckets, type AgingRow } from './aging-report.service';

// TZ §6.5 aging (muddati kelmagan / 1–7 / 8–30 / 31–60 / 60+), §16.1 P0 "aging correct for as-of date".
describe('AgingReportService (integration, real Postgres + RLS)', () => {
  const AS_OF = '2026-06-30';
  const tenantPrisma = new TenantPrismaService();
  const service = new AgingReportService(tenantPrisma);
  let companyId: string;
  let userId: string;
  let seq = 0;

  /** Instant at HH:MM Asia/Tashkent (UTC+5, no DST) on `daysBefore` days before AS_OF. */
  function tashkentAt(daysBefore: number, hh = 12, mm = 0): Date {
    const base = Date.parse(`${AS_OF}T00:00:00Z`) - daysBefore * 86_400_000;
    return new Date(base + (hh - 5) * 3_600_000 + mm * 60_000);
  }

  async function customerWithInvoice(name: string, total: string, createdAt: Date, paymentTermDays = 0) {
    return tenantPrisma.run(companyId, async (tx) => {
      const c = await tx.customer.create({ data: { companyId, code: `AG-${Date.now()}-${++seq}`, name, paymentTermDays } });
      const inv = await tx.invoice.create({
        data: { companyId, number: `INV-T-${Date.now()}-${++seq}`, customerId: c.id, total, createdAt },
      });
      return { customerId: c.id, invoiceId: inv.id };
    });
  }

  async function allRows(asOf: string): Promise<AgingRow[]> {
    return tenantPrisma.run(companyId, async () => (await service.getAllRows(asOf)).rows);
  }

  function nonZeroBuckets(row: AgingRow | undefined): Partial<Record<keyof AgingBuckets, string>> {
    const out: Partial<Record<keyof AgingBuckets, string>> = {};
    for (const [k, v] of Object.entries(row?.buckets ?? {})) if (!v.isZero()) out[k as keyof AgingBuckets] = v.toFixed(2);
    return out;
  }

  const cases: Array<[number, keyof AgingBuckets]> = [
    [0, 'current'],
    [1, 'd1to7'],
    [7, 'd1to7'],
    [8, 'd8to30'],
    [30, 'd8to30'],
    [31, 'd31to60'],
    [60, 'd31to60'],
    [61, 'd60plus'],
  ];
  const ids = new Map<number, string>();

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-aging-${Date.now()}`, name: 'Aging Tenant' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'Aging Co' } })).id;
    userId = (
      await systemPrisma.user.create({
        data: { companyId, firstName: 'Ag', lastName: 'User', phone: `+9989022${Math.floor(Math.random() * 90000) + 10000}` },
      })
    ).id;
    for (const [days] of cases) {
      ids.set(days, (await customerWithInvoice(`Day ${days}`, `${1000 + days}.00`, tashkentAt(days))).customerId);
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it.each(cases)('invoice %i days past due lands in %s at the fixed asOf', async (days, bucket) => {
    const row = (await allRows(AS_OF)).find((r) => r.customerId === ids.get(days));
    expect(nonZeroBuckets(row)).toEqual({ [bucket]: `${1000 + days}.00` });
    expect(row!.total.toFixed(2)).toBe(`${1000 + days}.00`);
  });

  it('uses the Asia/Tashkent calendar day, not UTC (00:30 Tashkent = previous UTC day)', async () => {
    const early = await customerWithInvoice('Tz early', '500.00', tashkentAt(0, 0, 30));
    const late = await customerWithInvoice('Tz late', '600.00', tashkentAt(1, 23, 30));
    const rows = await allRows(AS_OF);
    expect(nonZeroBuckets(rows.find((r) => r.customerId === early.customerId))).toEqual({ current: '500.00' });
    expect(nonZeroBuckets(rows.find((r) => r.customerId === late.customerId))).toEqual({ d1to7: '600.00' });
  });

  it('due date = createdAt + paymentTermDays; invoices issued after asOf are excluded', async () => {
    const termed = await customerWithInvoice('Termed', '700.00', tashkentAt(15), 7); // 8 days past due
    const future = await customerWithInvoice('Future', '800.00', tashkentAt(-1));
    const rows = await allRows(AS_OF);
    expect(nonZeroBuckets(rows.find((r) => r.customerId === termed.customerId))).toEqual({ d8to30: '700.00' });
    expect(rows.find((r) => r.customerId === future.customerId)).toBeUndefined();
    // Same data, later asOf: the term-shifted invoice ages into the next bucket deterministically.
    const later = await allRows('2026-07-23');
    expect(nonZeroBuckets(later.find((r) => r.customerId === termed.customerId))).toEqual({ d31to60: '700.00' });
  });

  it('counts only allocations valid on asOf (later allocations and pre-asOf reversals ignored)', async () => {
    const { customerId, invoiceId } = await customerWithInvoice('Paid', '1000.00', tashkentAt(10));
    await tenantPrisma.run(companyId, async (tx) => {
      const mk = async (amount: string, at: Date) => {
        const p = await tx.payment.create({
          data: { companyId, number: `PAY-T-${Date.now()}-${++seq}`, customerId, amount, method: 'CASH', createdAt: at },
        });
        await tx.paymentAllocation.create({ data: { paymentId: p.id, invoiceId, amount, createdAt: at } });
        return p.id;
      };
      await mk('300.00', tashkentAt(5)); // valid
      await mk('200.00', tashkentAt(-2)); // after asOf
      const reversed = await mk('100.00', tashkentAt(4));
      await tx.paymentReversal.create({
        data: { companyId, reversesPaymentId: reversed, reason: 'test', actorId: userId, createdAt: tashkentAt(2) },
      });
      await tx.payment.update({ where: { id: reversed }, data: { status: 'REVERSED' } });
    });
    const at = (asOf: string) => allRows(asOf).then((rs) => rs.find((r) => r.customerId === customerId));
    expect(nonZeroBuckets(await at(AS_OF))).toEqual({ d8to30: '700.00' });
    // Before the reversal day the reversed payment was still valid.
    expect(nonZeroBuckets(await at('2026-06-27'))).toEqual({ d1to7: '600.00' });
  });

  it('export and screen agree for the same asOf (rows, order, buckets, totals)', async () => {
    const screen = await tenantPrisma.run(companyId, () => service.getAging({ page: 1, pageSize: 100, asOf: AS_OF }));
    expect(screen.asOf).toBe(AS_OF);
    const { asOf, rows } = await tenantPrisma.run(companyId, () => service.getAllRows(AS_OF));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildAgingReportExcel(rows, asOf)) as never);
    const sheet = wb.getWorksheet('Qarzdorlik')!;
    expect(sheet.getRow(1).getCell(2).value).toBe(AS_OF);
    expect(sheet.getRow(AGING_EXCEL_HEADER_ROW).values).toEqual([
      undefined, 'Mijoz', 'Muddati kelmagan', '1-7 kun', '8-30 kun', '31-60 kun', '60+ kun', 'Jami',
    ]);
    const excel: unknown[][] = [];
    sheet.eachRow((r, n) => {
      if (n > AGING_EXCEL_HEADER_ROW) excel.push((r.values as unknown[]).slice(1));
    });
    expect(excel).toEqual(
      screen.data.map((r) => [
        r.customerName,
        ...(['current', 'd1to7', 'd8to30', 'd31to60', 'd60plus'] as const).map((k) => r.buckets[k].toNumber()),
        r.total.toNumber(),
      ]),
    );
  });

  it('DTO accepts a valid YYYY-MM-DD asOf and rejects malformed/impossible dates', async () => {
    const errs = async (asOf: unknown) =>
      (await validate(plainToInstance(AgingReportQueryDto, { asOf }))).map((e) => e.property);
    expect(await errs('2026-06-30')).toEqual([]);
    expect(await errs(undefined)).toEqual([]);
    for (const bad of ['2026-02-30', '30.06.2026', '2026-06-30T00:00:00Z', 'x']) expect(await errs(bad)).toEqual(['asOf']);
  });
});
