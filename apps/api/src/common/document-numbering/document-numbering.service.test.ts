import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, systemPrisma } from '@velto/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { DocumentNumberingService } from './document-numbering.service';

describe('DocumentNumberingService (integration)', () => {
  let companyId: string;
  const tenantPrisma = new TenantPrismaService();
  const numbering = new DocumentNumberingService();

  beforeAll(async () => {
    const tenant = await systemPrisma.tenant.create({ data: { slug: `test-docnum-${Date.now()}`, name: 'DocNum' } });
    companyId = (await systemPrisma.company.create({ data: { tenantId: tenant.id, name: 'DocNum Co' } })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await systemPrisma.$disconnect();
  });

  it('OB is an independent OB-{YYYY}-{6} sequence that does not disturb INV/SO', async () => {
    const year = new Date().getFullYear();
    const next = (t: 'OB' | 'INV' | 'SO') => tenantPrisma.run(companyId, (tx) => numbering.next(tx, companyId, t));
    expect(await next('INV')).toBe(`INV-${year}-000001`);
    expect(await next('OB')).toBe(`OB-${year}-000001`);
    expect(await next('OB')).toBe(`OB-${year}-000002`);
    expect(await next('INV')).toBe(`INV-${year}-000002`);
    expect(await next('SO')).toBe(`SO-${year}-000001`);
  });

  it('race: parallel nextBlock() and next() on one counter never overlap; blocks are contiguous; rolled-back block leaves no gap', async () => {
    const year = new Date().getFullYear();
    const results = await Promise.all([
      tenantPrisma.run(companyId, (tx) => numbering.nextBlock(tx, companyId, 'PO', 50)),
      tenantPrisma.run(companyId, (tx) => numbering.nextBlock(tx, companyId, 'PO', 30)),
      ...Array.from({ length: 6 }, () => tenantPrisma.run(companyId, async (tx) => [await numbering.next(tx, companyId, 'PO')])),
    ]);
    const nums = results.flat().map((n) => Number(n.split('-')[2]));
    expect(new Set(nums).size).toBe(86);
    expect(Math.min(...nums)).toBe(1);
    expect(Math.max(...nums)).toBe(86);
    for (const block of results.slice(0, 2)) {
      const b = block.map((n) => Number(n.split('-')[2]));
      expect(b[b.length - 1]! - b[0]! + 1).toBe(b.length);
    }
    await expect(
      tenantPrisma.run(companyId, async (tx) => {
        await numbering.nextBlock(tx, companyId, 'PO', 10);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await tenantPrisma.run(companyId, (tx) => numbering.next(tx, companyId, 'PO'))).toBe(`PO-${year}-000087`);
  });
});
